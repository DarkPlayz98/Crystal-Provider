// ============================================================================
// Crystal AI — Cloudflare Worker Backend
// Hardened version: secrets out of source, auth on every admin route,
// per-key rate limiting, input clamping, and a real system prompt.
// ============================================================================

// ---- Tunables -------------------------------------------------------------
const MAX_TOKENS_CEILING = 4096;
const MAX_TOKENS_FLOOR = 1;
const MAX_PROMPT_CHARS = 8000;          // ~2000 tokens of input, adjust to taste
const RATE_LIMIT_WINDOW_SECONDS = 60;
const RATE_LIMIT_MAX_REQUESTS = 20;     // per key, per window
const LOG_RETENTION_COUNT = 20;
const DEFAULT_MODEL = "@cf/meta/llama-3.1-8b-instruct-fp8-fast";

// Allowed models — prevents a client from pointing you at an expensive
// or inappropriate model via the `model` field.
const ALLOWED_MODELS = new Set([
  "@cf/meta/llama-3.1-8b-instruct-fp8-fast",
  "@cf/meta/llama-3.1-70b-instruct",
  "@cf/mistral/mistral-7b-instruct-v0.2",
]);

// The actual brain. Give it identity, boundaries, and behavior — not just
// a one-liner. This is what makes responses feel like "Crystal AI" instead
// of a bare model.
const SYSTEM_PROMPT = `You are Crystal AI, a helpful assistant built into the Crystal AI mobile app.

Identity and tone:
- You are direct, warm, and concise by default. Match the length of your reply to the complexity of the question — don't pad short questions with long answers.
- You do not claim to be human, and you do not claim capabilities you don't have (no real-time browsing, no file system access, no persistent memory across sessions unless the app explicitly tells you otherwise).
- If you don't know something or aren't sure, say so plainly instead of guessing with confidence.

Boundaries:
- You don't produce content that helps with malware, weapons, or harming people.
- You don't pretend to be a different AI product or impersonate a real person.
- If a request is ambiguous, make a reasonable assumption and answer, rather than deflecting with clarifying questions for simple things.

Formatting:
- Prefer plain, natural prose for conversational replies. Use lists only when the content is genuinely list-shaped.
- Keep code blocks minimal and runnable; don't over-comment trivial code.

You are running on Cloudflare Workers AI via the Crystal AI backend. Stay in character as Crystal AI throughout the conversation.`;

// ---- CORS helpers -----------------------------------------------------
// Public chat endpoint stays permissive (it's meant to be hit from the app).
// Admin endpoints get a locked-down CORS policy — set ADMIN_ALLOWED_ORIGIN
// as a Worker var/secret to your actual admin dashboard origin.
function publicCorsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Crystal-Key",
  };
}

function adminCorsHeaders(env) {
  const origin = env.ADMIN_ALLOWED_ORIGIN || "null"; // "null" blocks all browser origins by default
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Admin-Secret",
    "Vary": "Origin",
  };
}

function json(body, status, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}

// ---- Crypto helpers ---------------------------------------------------
async function sha256Hex(input) {
  const encoder = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoder.encode(input));
  return Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Constant-time string compare so admin-secret checking isn't vulnerable
// to a timing side-channel. Short-circuiting `!==` on secrets is a smell
// even if the practical risk here is low — worth doing right.
function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const enc = new TextEncoder();
  const bufA = enc.encode(a);
  const bufB = enc.encode(b);
  if (bufA.length !== bufB.length) return false;
  let result = 0;
  for (let i = 0; i < bufA.length; i++) result |= bufA[i] ^ bufB[i];
  return result === 0;
}

function newRequestId() {
  const arr = new Uint8Array(8);
  crypto.getRandomValues(arr);
  return Array.from(arr).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---- Admin auth ---------------------------------------------------------
// Pulls the secret from env (Worker secret binding), never from source.
// `wrangler secret put ADMIN_SECRET` to set it.
function checkAdminAuth(request, env) {
  const provided = request.headers.get("X-Admin-Secret") || "";
  const expected = env.ADMIN_SECRET || "";
  if (!expected) return false; // fail closed if the secret was never configured
  return timingSafeEqual(provided, expected);
}

// ---- Rate limiting --------------------------------------------------------
// Simple fixed-window counter in KV, keyed per API key hash.
// Not perfectly precise (fixed window vs sliding), but cheap, dependency-free,
// and good enough to stop abuse/runaway costs.
async function checkRateLimit(env, keyHash) {
  const windowId = Math.floor(Date.now() / 1000 / RATE_LIMIT_WINDOW_SECONDS);
  const rlKey = `RL_${keyHash}_${windowId}`;

  const currentRaw = await env.CRYSTAL_KEYS.get(rlKey);
  const current = currentRaw ? parseInt(currentRaw, 10) : 0;

  if (current >= RATE_LIMIT_MAX_REQUESTS) {
    return { allowed: false, remaining: 0 };
  }

  await env.CRYSTAL_KEYS.put(rlKey, String(current + 1), {
    expirationTtl: RATE_LIMIT_WINDOW_SECONDS * 2, // generous TTL, window math handles correctness
  });

  return { allowed: true, remaining: RATE_LIMIT_MAX_REQUESTS - (current + 1) };
}

// ---- Input clamping ---------------------------------------------------
function clampMaxTokens(value) {
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) return 2048;
  return Math.min(Math.max(n, MAX_TOKENS_FLOOR), MAX_TOKENS_CEILING);
}

function clampTemperature(value) {
  const n = parseFloat(value);
  if (Number.isNaN(n)) return 0.7;
  return Math.min(Math.max(n, 0), 2);
}

function clampPrompt(value) {
  if (typeof value !== "string") return "Hello!";
  if (value.length === 0) return "Hello!";
  return value.slice(0, MAX_PROMPT_CHARS);
}

function resolveModel(value) {
  if (typeof value === "string" && ALLOWED_MODELS.has(value)) return value;
  return DEFAULT_MODEL;
}

// ============================================================================
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const startTime = Date.now();
    const requestId = newRequestId();

    // 1. CORS preflight
    if (request.method === "OPTIONS") {
      const isAdminRoute = url.pathname === "/v1/create-key" ||
        url.pathname === "/v1/requests" ||
        url.pathname === "/v1/revoke-key";
      return new Response(null, {
        headers: isAdminRoute ? adminCorsHeaders(env) : publicCorsHeaders(),
      });
    }

    // 2. Admin: create API key
    if (url.pathname === "/v1/create-key") {
      const cors = adminCorsHeaders(env);
      if (!checkAdminAuth(request, env)) {
        return json({ error: "Unauthorized", request_id: requestId }, 401, cors);
      }

      const array = new Uint8Array(16);
      crypto.getRandomValues(array);
      const rawApiKey = `cry_live_${Array.from(array).map((b) => b.toString(16).padStart(2, "0")).join("")}`;
      const keyHash = await sha256Hex(rawApiKey);

      // Optional label from admin so keys aren't all "App_User"
      let label = "App_User";
      if (request.method === "POST") {
        try {
          const body = await request.json();
          if (typeof body.label === "string" && body.label.length <= 100) {
            label = body.label;
          }
        } catch (e) {
          // no body / bad JSON — fine, use default label
        }
      }

      await env.CRYSTAL_KEYS.put(
        keyHash,
        JSON.stringify({ user: label, active: true, created_at: new Date().toISOString() })
      );

      return json({ status: "success", api_key: rawApiKey, request_id: requestId }, 200, cors);
    }

    // 3. Admin: revoke an API key
    if (url.pathname === "/v1/revoke-key") {
      const cors = adminCorsHeaders(env);
      if (!checkAdminAuth(request, env)) {
        return json({ error: "Unauthorized", request_id: requestId }, 401, cors);
      }
      if (request.method !== "POST") {
        return json({ error: "Use POST with { \"api_key\": \"cry_live_...\" }", request_id: requestId }, 405, cors);
      }

      let targetKey;
      try {
        const body = await request.json();
        targetKey = body.api_key;
      } catch (e) {
        return json({ error: "Invalid JSON body", request_id: requestId }, 400, cors);
      }

      if (typeof targetKey !== "string" || !targetKey.startsWith("cry_live_")) {
        return json({ error: "Invalid api_key format", request_id: requestId }, 400, cors);
      }

      const keyHash = await sha256Hex(targetKey);
      const existing = await env.CRYSTAL_KEYS.get(keyHash, { type: "json" });
      if (!existing) {
        return json({ error: "Key not found", request_id: requestId }, 404, cors);
      }

      existing.active = false;
      existing.revoked_at = new Date().toISOString();
      await env.CRYSTAL_KEYS.put(keyHash, JSON.stringify(existing));

      return json({ status: "success", revoked: true, request_id: requestId }, 200, cors);
    }

    // 4. Admin: fetch recent request logs — NOW ACTUALLY AUTHENTICATED
    if (url.pathname === "/v1/requests") {
      const cors = adminCorsHeaders(env);
      if (!checkAdminAuth(request, env)) {
        return json({ error: "Unauthorized", request_id: requestId }, 401, cors);
      }

      const logsRaw = await env.CRYSTAL_KEYS.get("GLOBAL_REQUEST_LOGS");
      const logs = logsRaw ? JSON.parse(logsRaw) : [];
      return json({ status: "success", requests: logs, request_id: requestId }, 200, cors);
    }

    // 5. Validate API key for AI requests
    const cors = publicCorsHeaders();
    const apiKey = (request.headers.get("X-Crystal-Key") || "").trim();
    if (!apiKey.startsWith("cry_live_")) {
      return json({ error: "Invalid key format. Use X-Crystal-Key header.", request_id: requestId }, 401, cors);
    }

    let keyHash;
    try {
      keyHash = await sha256Hex(apiKey);
      const keyData = await env.CRYSTAL_KEYS.get(keyHash, { type: "json" });
      if (!keyData || !keyData.active) throw new Error("inactive_or_missing");
    } catch (e) {
      return json({ error: "Invalid or revoked API key.", request_id: requestId }, 403, cors);
    }

    // 6. Rate limit per key
    const rl = await checkRateLimit(env, keyHash);
    if (!rl.allowed) {
      return json(
        {
          error: "Rate limit exceeded. Try again shortly.",
          retry_after_seconds: RATE_LIMIT_WINDOW_SECONDS,
          request_id: requestId,
        },
        429,
        { ...cors, "Retry-After": String(RATE_LIMIT_WINDOW_SECONDS) }
      );
    }

    // 7. Parse + clamp request payload
    let userPrompt = "Hello!";
    let maxTokens = 2048;
    let temperature = 0.7;
    let model = DEFAULT_MODEL;

    if (request.method === "POST") {
      try {
        const body = await request.json();
        userPrompt = clampPrompt(body.prompt);
        if (body.max_tokens !== undefined) maxTokens = clampMaxTokens(body.max_tokens);
        if (body.temperature !== undefined) temperature = clampTemperature(body.temperature);
        model = resolveModel(body.model);
      } catch (e) {
        return json({ error: "Invalid JSON body", request_id: requestId }, 400, cors);
      }
    }

    // 8. Execute AI model
    try {
      const aiResponse = await env.AI.run(model, {
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        max_tokens: maxTokens,
        temperature: temperature,
      });

      const duration = Date.now() - startTime;
      const cfRay = request.headers.get("cf-ray") || "N/A";
      const datacenterColo = request.cf?.colo || "UNKNOWN";
      const clientCountry = request.cf?.country || request.headers.get("cf-ipcountry") || "XX";
      // Store a truncated/hashed IP rather than raw IP for logs, since /v1/requests
      // is now gated but there's no reason to keep full IPs longer than needed.
      const clientIp = request.headers.get("cf-connecting-ip") || "127.0.0.1";
      const ipHashShort = (await sha256Hex(clientIp)).slice(0, 12);

      const logItem = {
        request_id: requestId,
        timestamp: new Date().toISOString(),
        model,
        prompt_preview: userPrompt.slice(0, 200),
        response_preview: (aiResponse.response || "").slice(0, 200),
        ip_hash: ipHashShort,
        country: clientCountry,
        colo: datacenterColo,
        cfRay,
        latency_ms: duration,
        status: "200 OK",
      };

      try {
        const existingRaw = await env.CRYSTAL_KEYS.get("GLOBAL_REQUEST_LOGS");
        let existing = existingRaw ? JSON.parse(existingRaw) : [];
        existing.unshift(logItem);
        if (existing.length > LOG_RETENTION_COUNT) existing = existing.slice(0, LOG_RETENTION_COUNT);
        await env.CRYSTAL_KEYS.put("GLOBAL_REQUEST_LOGS", JSON.stringify(existing));
      } catch (err) {
        // logging failure should never break the actual response
      }

      return json(
        {
          status: "success",
          model_used: model,
          request_id: requestId,
          rate_limit_remaining: rl.remaining,
          verification: {
            authentic_cf_ray: cfRay,
            datacenter_colo: datacenterColo,
            client_country: clientCountry,
            gpu_execution_latency_ms: duration,
          },
          result: aiResponse.response,
        },
        200,
        cors
      );
    } catch (error) {
      return json(
        {
          error: "Cloudflare AI Engine Failed",
          details: error.message,
          request_id: requestId,
        },
        500,
        cors
      );
    }
  },
};
