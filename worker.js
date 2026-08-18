export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const startTime = Date.now();

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // 1. Admin Endpoint: Key Generator
    if (url.pathname === "/v1/create-key") {
      const adminSecret = request.headers.get("X-Admin-Secret");
      if (adminSecret !== "crystal_admin_2026") {
        return new Response(JSON.stringify({ error: "Unauthorized Admin" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
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

    // 2. Admin Endpoint: Activity Logs
    if (url.pathname === "/v1/requests") {
      const logsRaw = await env.CRYSTAL_KEYS.get("GLOBAL_REQUEST_LOGS");
      const logs = logsRaw ? JSON.parse(logsRaw) : [];
      return new Response(JSON.stringify({ status: "success", requests: logs }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // 3. Authenticate Crystal API Key
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

    // 4. Parse Request
    let userPrompt = "Write an analytical essay on artificial intelligence.";
    let imageBase64 = null;
    let webSearchEnabled = false;
    let maxTokens = 4096;
    let temperature = 0.7;
    let model = "@cf/meta/llama-4-scout-17b-16e-instruct";

    if (request.method === "POST") {
      try {
        const body = await request.json();
        if (body.prompt) userPrompt = body.prompt;
        if (body.image) imageBase64 = body.image;
        if (body.web_search !== undefined) webSearchEnabled = body.web_search;
        if (body.max_tokens) maxTokens = parseInt(body.max_tokens);
        if (body.temperature !== undefined) temperature = parseFloat(body.temperature);
        if (body.model) model = body.model;
      } catch (e) {}
    }

    const cfImageModels = [
      "@cf/black-forest-labs/flux-1-schnell",
      "@cf/stabilityai/stable-diffusion-xl-base-1.0",
      "@cf/bytedance/stable-diffusion-xl-lightning",
      "@cf/lykon/dreamshaper-8-lcm"
    ];

    const isDalle3 = model === "dall-e-3";
    const isImageModel = isDalle3 || cfImageModels.includes(model);

    // 5. Execution Pipeline
    try {
      let finalResult = "";

      if (isDalle3) {
        // Free DALL-E 3 Proxy Gateway Pipeline
        const encodedPrompt = encodeURIComponent(userPrompt);
        const seed = Math.floor(Math.random() * 999999);
        finalResult = `https://image.pollinations.ai/prompt/${encodedPrompt}?model=dalle-3&seed=${seed}&nologo=true`;

      } else if (isImageModel) {
        // Free Cloudflare Edge Image Generation
        const imageStream = await env.AI.run(model, { prompt: userPrompt });
        const arrayBuffer = await new Response(imageStream).arrayBuffer();
        let binary = "";
        const bytes = new Uint8Array(arrayBuffer);
        for (let i = 0; i < bytes.byteLength; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        finalResult = `data:image/png;base64,${btoa(binary)}`;

      } else {
        // Text, Vision & Web Search Models Execution
        let userContent = userPrompt;

        // Perform Edge Web Search integration if enabled or agentic model requested
        if (webSearchEnabled || model.includes("kimi") || model.includes("glm")) {
          try {
            const searchRes = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(userPrompt)}`);
            const htmlText = await searchRes.text();
            const snippets = htmlText.match(/<a class="result__snippet[^>]*>(.*?)<\/a>/g) || [];
            const parsedContext = snippets.slice(0, 3).map(s => s.replace(/<[^>]+>/g, '')).join("\n---\n");
            
            if (parsedContext) {
              userContent = `[Web Search Context Source Data]:\n${parsedContext}\n\n[User Goal]: ${userPrompt}`;
            }
          } catch(err) {}
        }

        // Multimodal Vision Array construction
        let messagesPayload = [];
        if (imageBase64) {
          messagesPayload = [
            {
              role: "user",
              content: [
                { type: "text", text: userContent },
                { type: "image_url", image_url: { url: imageBase64 } }
              ]
            }
          ];
        } else {
          messagesPayload = [
            { role: "system", content: "You are Crystal AI, an advanced research, essay writing, and analytical assistant." },
            { role: "user", content: userContent }
          ];
        }

        const aiResponse = await env.AI.run(model, {
          messages: messagesPayload,
          max_tokens: maxTokens,
          temperature: temperature
        });

        finalResult = aiResponse.response || aiResponse.choices?.[0]?.message?.content || "";
      }

      const duration = Date.now() - startTime;
      const cfRay = request.headers.get("cf-ray") || "N/A";
      const datacenterColo = request.cf?.colo || "UNKNOWN";
      const clientCountry = request.cf?.country || request.headers.get("cf-ipcountry") || "XX";

      // Log activity item to KV store
      const logItem = {
        timestamp: new Date().toLocaleTimeString(),
        model: model,
        type: isImageModel ? "image" : "text",
        prompt: userPrompt,
        country: clientCountry,
        colo: datacenterColo,
        cfRay: cfRay,
        latency: `${duration}ms`
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
          gpu_execution_latency: `${duration}ms`
        },
        result: finalResult
      }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });

    } catch (error) {
      return new Response(JSON.stringify({ error: "AI Engine Failed", details: error.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
  }
};
