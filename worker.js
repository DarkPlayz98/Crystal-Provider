export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const startTime = Date.now();

    // 1. CORS Headers Setup
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // 2. Admin Endpoint: Generate Keys
    if (url.pathname === "/v1/create-key") {
      const adminSecret = request.headers.get("X-Admin-Secret");
      if (adminSecret !== "crystal_admin_2026") {
        return new Response(JSON.stringify({ error: "Unauthorized: Invalid Admin Secret" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const array = new Uint8Array(16);
      crypto.getRandomValues(array);
      const rawApiKey = `cry_live_${Array.from(array).map(b => b.toString(16).padStart(2, "0")).join("")}`;
      
      const encoder = new TextEncoder();
      const hashBuffer = await crypto.subtle.digest("SHA-256", encoder.encode(rawApiKey));
      const keyHash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");

      await env.CRYSTAL_KEYS.put(keyHash, JSON.stringify({ user: "App_User", active: true, created_at: new Date().toISOString() }));

      return new Response(JSON.stringify({ status: "success", api_key: rawApiKey }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // 3. Admin Endpoint: Fetch Request Logs
    if (url.pathname === "/v1/requests") {
      const logsRaw = await env.CRYSTAL_KEYS.get("GLOBAL_REQUEST_LOGS");
      const logs = logsRaw ? JSON.parse(logsRaw) : [];
      return new Response(JSON.stringify({ status: "success", requests: logs }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // 4. Validate Crystal API Key
    const apiKey = (request.headers.get("X-Crystal-Key") || "").trim();
    if (!apiKey.startsWith("cry_live_")) {
      return new Response(JSON.stringify({ error: "Invalid key format." }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    try {
      const encoder = new TextEncoder();
      const hashBuffer = await crypto.subtle.digest("SHA-256", encoder.encode(apiKey));
      const keyHash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");
      const keyData = await env.CRYSTAL_KEYS.get(keyHash, { type: "json" });
      if (!keyData || !keyData.active) throw new Error();
    } catch (e) {
      return new Response(JSON.stringify({ error: "Invalid or revoked API key." }), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // 5. Parse Request Payload
    let userPrompt = "A fantasy landscape";
    let maxTokens = 2048;
    let temperature = 0.7;
    let model = "@cf/black-forest-labs/flux-1-schnell";
    let openaiKey = "";

    if (request.method === "POST") {
      try {
        const body = await request.json();
        if (body.prompt) userPrompt = body.prompt;
        if (body.max_tokens) maxTokens = parseInt(body.max_tokens);
        if (body.temperature !== undefined) temperature = parseFloat(body.temperature);
        if (body.model) model = body.model;
        if (body.openai_key) openaiKey = body.openai_key;
      } catch (e) {}
    }

    const cfImageModels = [
      "@cf/black-forest-labs/flux-1-schnell",
      "@cf/stabilityai/stable-diffusion-xl-base-1.0",
      "@cf/bytedance/stable-diffusion-xl-lightning",
      "@cf/lykon/dreamshaper-8-lcm",
      "@cf/segmind/portrait-plus"
    ];

    const isDalle3 = model === "dall-e-3";
    const isImageModel = isDalle3 || cfImageModels.includes(model);

    // 6. Model Execution Logic
    try {
      let finalResult = "";

      if (isDalle3) {
        // Run OpenAI DALL-E 3
        const activeOpenAIKey = openaiKey || env.OPENAI_API_KEY;
        if (!activeOpenAIKey) {
          return new Response(JSON.stringify({ error: "Missing OpenAI API Key for DALL-E 3 execution." }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }

        const dalleRes = await fetch("https://api.openai.com/v1/images/generations", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${activeOpenAIKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model: "dall-e-3",
            prompt: userPrompt,
            n: 1,
            size: "1024x1024",
            response_format: "url"
          })
        });

        const dalleData = await dalleRes.json();
        if (dalleData.error) throw new Error(dalleData.error.message);
        finalResult = dalleData.data[0].url;

      } else if (isImageModel) {
        // Run Cloudflare Workers AI Image Model
        const imageStream = await env.AI.run(model, { prompt: userPrompt });
        const arrayBuffer = await new Response(imageStream).arrayBuffer();
        
        let binary = "";
        const bytes = new Uint8Array(arrayBuffer);
        for (let i = 0; i < bytes.byteLength; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        finalResult = `data:image/png;base64,${btoa(binary)}`;

      } else {
        // Run Text Model
        const aiResponse = await env.AI.run(model, {
          messages: [
            { role: "system", content: "You are CrystalAI, an intelligent assistant." },
            { role: "user", content: userPrompt }
          ],
          max_tokens: maxTokens,
          temperature: temperature
        });
        finalResult = aiResponse.response || "";
      }

      const duration = Date.now() - startTime;
      const cfRay = request.headers.get("cf-ray") || "N/A";
      const datacenterColo = request.cf?.colo || "UNKNOWN";
      const clientCountry = request.cf?.country || request.headers.get("cf-ipcountry") || "XX";
      const clientIp = request.headers.get("cf-connecting-ip") || "127.0.0.1";

      const logItem = {
        timestamp: new Date().toLocaleTimeString(),
        model: model,
        type: isImageModel ? "image" : "text",
        prompt: userPrompt,
        response: isImageModel ? "[Generated Image]" : finalResult,
        ip: clientIp,
        country: clientCountry,
        colo: datacenterColo,
        cfRay: cfRay,
        latency: `${duration}ms`,
        status: "200 OK"
      };

      try {
        const existingRaw = await env.CRYSTAL_KEYS.get("GLOBAL_REQUEST_LOGS");
        let existing = existingRaw ? JSON.parse(existingRaw) : [];
        existing.unshift(logItem);
        if (existing.length > 20) existing = existing.slice(0, 20);
        await env.CRYSTAL_KEYS.put("GLOBAL_REQUEST_LOGS", JSON.stringify(existing));
      } catch (err) {}

      return new Response(JSON.stringify({
        status: "success",
        type: isImageModel ? "image" : "text",
        model_used: model,
        verification: {
          authentic_cf_ray: cfRay,
          datacenter_colo: datacenterColo,
          client_country: clientCountry,
          gpu_execution_latency: `${duration}ms`
        },
        result: finalResult
      }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });

    } catch (error) {
      return new Response(JSON.stringify({ error: "AI Engine Execution Failed", details: error.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
  }
};
