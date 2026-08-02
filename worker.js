export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "*"
        }
      });
    }

    // 1. ADMIN KEY GENERATOR
    if (url.pathname === "/v1/create-key") {
      const adminSecret = request.headers.get("X-Admin-Secret");
      if (adminSecret !== "crystal_admin_2026") {
        return new Response(JSON.stringify({ error: "Unauthorized." }), { 
          status: 401, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } 
        });
      }

      const array = new Uint8Array(16);
      crypto.getRandomValues(array);
      const rawApiKey = `cry_live_${Array.from(array).map(b => b.toString(16).padStart(2, "0")).join("")}`;

      const encoder = new TextEncoder();
      const hashBuffer = await crypto.subtle.digest("SHA-256", encoder.encode(rawApiKey));
      const keyHash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");

      await env.CRYSTAL_KEYS.put(keyHash, JSON.stringify({ user: "App_User", active: true }));

      return new Response(JSON.stringify({
        status: "success",
        message: "Key created and saved to KV!",
        api_key: rawApiKey
      }), { status: 200, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
    }

    // 2. MAIN AI ROUTE
    const apiKey = (request.headers.get("X-Crystal-Key") || "").trim();
    if (!apiKey.startsWith("cry_live_")) {
      return new Response(JSON.stringify({ error: "Invalid key format." }), { 
        status: 401, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } 
      });
    }

    let developerName = "Developer";
    try {
      const encoder = new TextEncoder();
      const hashBuffer = await crypto.subtle.digest("SHA-256", encoder.encode(apiKey));
      const keyHash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");
      const keyData = await env.CRYSTAL_KEYS.get(keyHash, { type: "json" });
      if (!keyData || !keyData.active) throw new Error();
      developerName = keyData.user;
    } catch (e) {
      return new Response(JSON.stringify({ error: "Invalid or revoked API key." }), { 
        status: 403, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } 
      });
    }

    // Default parameters (max_tokens set to 2048 to prevent responses getting cut off)
    let userPrompt = "Hello!";
    let maxTokens = 2048; 
    let temperature = 0.7;
    let model = "@cf/meta/llama-3.1-8b-instruct-fp8-fast";

    if (request.method === "POST") {
      try {
        const body = await request.json();
        if (body.prompt) userPrompt = body.prompt;
        if (body.max_tokens) maxTokens = parseInt(body.max_tokens);
        if (body.temperature !== undefined) temperature = parseFloat(body.temperature);
        if (body.model) model = body.model;
      } catch (e) {}
    }

    try {
      const aiResponse = await env.AI.run(model, {
        messages: [
          { role: "system", content: "You are CrystalAI, a fast and free assistant for developers." },
          { role: "user", content: userPrompt }
        ],
        max_tokens: maxTokens,
        temperature: temperature
      });

      return new Response(JSON.stringify({
        status: "success",
        developer: developerName,
        result: aiResponse.response,
        config: { max_tokens: maxTokens, temperature: temperature, model: model }
      }), { status: 200, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
      
    } catch (error) {
      return new Response(JSON.stringify({ error: "Cloudflare AI Engine Failed", details: error.message }), { 
        status: 500, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } 
      });
    }
  }
};
