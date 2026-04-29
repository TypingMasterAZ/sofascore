export default {
  async fetch(request) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);
    const path = url.searchParams.get("path") || "/sport/football/events/live";

    const passthroughParams = new URLSearchParams(url.search);
    passthroughParams.delete("path");

    const bases = [
      "https://api.sofascore.com/api/v1",
      "https://www.sofascore.com/api/v1"
    ];

    const browserHeaders = {
      "Accept": "application/json, text/plain, */*",
      "Accept-Language": "en-US,en;q=0.9,az;q=0.8",
      "Cache-Control": "no-cache",
      "Pragma": "no-cache",
      "Referer": "https://www.sofascore.com/football/livescore",
      "Origin": "https://www.sofascore.com",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36"
    };

    let lastError = null;

    for (const base of bases) {
      const upstream = new URL(`${base}${path}`);
      passthroughParams.forEach((value, key) => upstream.searchParams.set(key, value));

      try {
        const upstreamRes = await fetch(upstream.toString(), {
          method: "GET",
          headers: browserHeaders,
          redirect: "follow",
          cf: {
            cacheTtl: 0,
            cacheEverything: false
          }
        });

        const text = await upstreamRes.text();
        let json = null;

        try {
          json = JSON.parse(text);
        } catch (_) {}

        if (upstreamRes.ok && json && !json.error) {
          return new Response(JSON.stringify(json), {
            status: 200,
            headers: {
              ...corsHeaders,
              "Content-Type": "application/json; charset=utf-8",
              "Cache-Control": "no-store"
            }
          });
        }

        lastError = {
          status: upstreamRes.status,
          body: json || text
        };
      } catch (error) {
        lastError = {
          status: 500,
          body: { error: true, message: error.message }
        };
      }
    }

    return new Response(JSON.stringify(lastError?.body || { error: true, message: "Proxy failed" }), {
      status: lastError?.status || 500,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store"
      }
    });
  }
};
