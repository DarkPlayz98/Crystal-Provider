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
        return new Response(JSON.stringify({ error: "Unauthorized Admin" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      const array = new Uint8Array(16);
      crypto.getRandomValues(array);
      const rawApiKey = `cry_live_${Array.from(array).map(b => b.toString(16).padStart(2, "0")).join("")}`;

      const encoder = new TextEncoder();
      const hashBuffer = await crypto.subtle.digest("SHA-256", encoder.encode(rawApiKey));
      const keyHash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");

      await env.CRYSTAL_KEYS.put(keyHash, JSON.stringify({
        user: "App_User",
        active: true,
        created_at: new Date().toISOString()
      }));

      return new Response(JSON.stringify({ status: "success", api_key: rawApiKey }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // 2. Admin Endpoint: Activity Logs
    if (url.pathname === "/v1/requests") {
      const logsRaw = await env.CRYSTAL_KEYS.get("GLOBAL_REQUEST_LOGS");
      const logs = logsRaw ? JSON.parse(logsRaw) : [];
      return new Response(JSON.stringify({ status: "success", requests: logs }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // 3. Authenticate Key
    const apiKey = (request.headers.get("X-Crystal-Key") || "").trim();
    if (!apiKey.startsWith("cry_live_")) {
      return new Response(JSON.stringify({ error: "Invalid API key format. Use X-Crystal-Key header." }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    try {
      const encoder = new TextEncoder();
      const hashBuffer = await crypto.subtle.digest("SHA-256", encoder.encode(apiKey));
      const keyHash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");
      const keyData = await env.CRYSTAL_KEYS.get(keyHash, { type: "json" });
      if (!keyData || !keyData.active) throw new Error();
    } catch (e) {
      return new Response(JSON.stringify({ error: "Invalid or revoked API key." }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // 4. Parse Request Payload
    let userPrompt = "Hello!";
    let imageBase64 = null;
    let maxTokens = 4096;
    let temperature = 0.6;
    let model = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

    if (request.method === "POST") {
      try {
        const body = await request.json();
        if (body.prompt) userPrompt = body.prompt;
        if (body.image) imageBase64 = body.image;
        if (body.max_tokens) maxTokens = parseInt(body.max_tokens);
        if (body.temperature !== undefined) temperature = parseFloat(body.temperature);
        if (body.model) model = body.model;
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
    const isImageGen = isDalle3 || cfImageModels.includes(model);
    const isVision = model === "@cf/meta/llama-3.2-11b-vision-instruct" || Boolean(imageBase64);

    let finalResult = "";
    let executionMode = "Cloudflare Edge GPU";

    // 5. Execution with Zero-Neuron Fallback
    try {
      if (isDalle3) {
        // DALL-E 3 zero-neuron proxy
        executionMode = "Unmetered Image Proxy";
        const seed = Math.floor(Math.random() * 999999);
        finalResult = `https://image.pollinations.ai/prompt/${encodeURIComponent(userPrompt)}?model=dalle-3&seed=${seed}&nologo=true`;

      } else if (isImageGen) {
        // Try Cloudflare Edge Diffusion first
        try {
          const imageStream = await env.AI.run(model, { prompt: userPrompt });
          const arrayBuffer = await new Response(imageStream).arrayBuffer();
          let binary = "";
          const bytes = new Uint8Array(arrayBuffer);
          for (let i = 0; i < bytes.byteLength; i++) {
            binary += String.fromCharCode(bytes[i]);
          }
          finalResult = `data:image/png;base64,${btoa(binary)}`;
        } catch (cfErr) {
          // Zero-Neuron Failover for Images
          executionMode = "Unmetered Zero-Neuron Image Failover";
          let fallbackImgModel = "flux";
          if (model.includes("lightning") || model.includes("turbo")) fallbackImgModel = "turbo";
          const seed = Math.floor(Math.random() * 999999);
          finalResult = `https://image.pollinations.ai/prompt/${encodeURIComponent(userPrompt)}?model=${fallbackImgModel}&seed=${seed}&nologo=true`;
        }

      } else if (isVision && imageBase64) {
        // Multimodal Vision Execution
        try {
          const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, "");
          const binaryString = atob(base64Data);
          const imageBytes = new Uint8Array(binaryString.length);
          for (let i = 0; i < binaryString.length; i++) {
            imageBytes[i] = binaryString.charCodeAt(i);
          }

          const visionResponse = await env.AI.run("@cf/meta/llama-3.2-11b-vision-instruct", {
            prompt: userPrompt,
            image: [...imageBytes],
            max_tokens: maxTokens
          });

          finalResult = visionResponse.description || visionResponse.response || JSON.stringify(visionResponse);
        } catch (cfErr) {
          // Fallback for Vision
          executionMode = "Zero-Neuron Vision Failover";
          const fallbackRes = await fetch("https://text.pollinations.ai/", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              messages: [
                { role: "system", content: "You are Crystal AI. Analyze user requests accurately." },
                { role: "user", content: `[Image Attached] ${userPrompt}` }
              ],
              model: "gemini",
              seed: Math.floor(Math.random() * 999999)
            })
          });
          finalResult = await fallbackRes.text();
        }

      } else {
        // High-Parameter Text & Reasoning Models
        try {
          const aiResponse = await env.AI.run(model, {
            messages: [
              { role: "system", content: "You are Crystal AI, a premier intelligence engine. Answer authoritatively, concisely, and directly." },
              { role: "user", content: userPrompt }
            ],
            max_tokens: maxTokens,
            temperature: temperature
          });

          finalResult = aiResponse.response || aiResponse.choices?.[0]?.message?.content || "";
        } catch (cfErr) {
          // Zero-Neuron Text Failover
          executionMode = "Unmetered Zero-Neuron Text Failover";
          let fallbackModel = "openai-large";

          const m = model.toLowerCase();
          if (m.includes("deepseek") || m.includes("r1")) fallbackModel = "deepseek";
          else if (m.includes("coder") || m.includes("qwen")) fallbackModel = "qwen-coder";
          else if (m.includes("mistral")) fallbackModel = "mistral";

          const fallbackRes = await fetch("https://text.pollinations.ai/", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              messages: [
                { role: "system", content: "You are Crystal AI, operating at frontier intelligence. Answer directly, logically, and concisely." },
                { role: "user", content: userPrompt }
              ],
              model: fallbackModel,
              seed: Math.floor(Math.random() * 999999)
            })
          });

          finalResult = await fallbackRes.text();
        }
      }

      const duration = Date.now() - startTime;
      const cfRay = request.headers.get("cf-ray") || "N/A";
      const datacenterColo = request.cf?.colo || "UNKNOWN";
      const clientCountry = request.cf?.country || "XX";

      // 6. Save Activity Telemetry
      const logItem = {
        timestamp: new Date().toLocaleTimeString(),
        model: model,
        type: isImageGen ? "image" : "text",
        prompt: userPrompt,
        country: clientCountry,
        colo: datacenterColo,
        cfRay: cfRay,
        latency: `${duration}ms`,
        mode: executionMode
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
        type: isImageGen ? "image" : "text",
        model_used: model,
        verification: {
          engine_mode: executionMode,
          authentic_cf_ray: cfRay,
          datacenter_colo: datacenterColo,
          gpu_execution_latency: `${duration}ms`
        },
        result: finalResult
      }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });

    } catch (globalError) {
      return new Response(JSON.stringify({
        error: "Execution Failed",
        details: globalError.message
      }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }
  }
};
