/**
 * render-keepalive.js
 * 
 * Bu script Render cron job kimi her deqiqe isleyir.
 * Server-e muxtelif endpointler vasitesile ping vurur ki:
 *   1) Server HECH VAXT yuxuya getmesin (Render free plan 15 deq sonra yatdirir)
 *   2) Canli melumatlar daima yeni qalsin
 *   3) Cache-ler isiq qalsin - istifadeci girende derhal cavab verilsin
 */

const http = require("http");
const https = require("https");

const targetUrl = process.env.KEEPALIVE_URL || process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL;
const pingSource = process.env.KEEPALIVE_SOURCE || "render-cron";

if (!targetUrl) {
  console.error("[KeepAlive] KEEPALIVE_URL, RENDER_EXTERNAL_URL or PUBLIC_URL is required");
  process.exit(1);
}

function requestUrl(url, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("http://") ? http : https;
    const req = client.get(url, { timeout: timeoutMs }, (res) => {
      let body = "";
      res.on("data", chunk => { body += chunk; });
      res.on("end", () => {
        let parsed = null;
        try { parsed = JSON.parse(body); } catch (_) {}

        if (parsed?.liveEvents !== undefined) {
          console.log(`[KeepAlive] ${res.statusCode} ${url.split("?")[0].split("/").pop()} → liveEvents:${parsed.liveEvents} uptime:${parsed.uptimeSec}s`);
        } else {
          console.log(`[KeepAlive] ${res.statusCode} ${url.split("?")[0]}`);
        }

        if (res.statusCode >= 200 && res.statusCode < 400) {
          resolve({ status: res.statusCode, data: parsed });
        } else {
          reject(new Error(`HTTP ${res.statusCode}`));
        }
      });
    });
    req.on("timeout", () => {
      req.destroy(new Error("Timeout"));
    });
    req.on("error", reject);
  });
}

async function main() {
  const base = targetUrl.replace(/\/$/, "");
  const t = Date.now();

  console.log(`[KeepAlive] Pinging ${base} at ${new Date(t).toISOString()}`);

  // Her deqiqe bu endpointlere vur:
  // /api/ping      → ən yüngül, serveri ayaq üstündə saxlayır
  // /api/health    → sistem vəziyyətini yoxlayır
  // /api/keepalive → arxa fon warmup-u tetikleyir (cache-leri isiq saxlayir)
  // /api/warmup    → canli oyun melumatlarini yenileyir
  const endpoints = [
    { url: `${base}/api/ping?source=${pingSource}&t=${t}`,            timeout: 12000 },
    { url: `${base}/api/health?source=${pingSource}&t=${t}`,           timeout: 15000 },
    { url: `${base}/api/keepalive?light=0&source=${pingSource}&t=${t}`, timeout: 20000 },
    { url: `${base}/api/keepalive-v2?source=${pingSource}&t=${t}`,     timeout: 20000 },
    { url: `${base}/api/warmup?force=0&source=${pingSource}&t=${t}`,   timeout: 20000 },
  ];

  const results = await Promise.allSettled(
    endpoints.map(({ url, timeout }) => requestUrl(url, timeout))
  );

  const succeeded = results.filter(r => r.status === "fulfilled").length;
  const failed    = results.filter(r => r.status === "rejected");

  if (succeeded === 0) {
    console.error(`[KeepAlive] ALL ${endpoints.length} endpoints FAILED. Server may be down!`);
    failed.forEach(f => console.error(`  → ${f.reason?.message || f.reason}`));
    process.exit(1);
  }

  if (failed.length > 0) {
    console.warn(`[KeepAlive] ${failed.length}/${endpoints.length} endpoints failed (server still alive).`);
    failed.forEach(f => console.warn(`  → ${f.reason?.message || f.reason}`));
  } else {
    console.log(`[KeepAlive] ✓ All ${endpoints.length} endpoints OK — server is alive and refreshing.`);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("[KeepAlive] Fatal error:", err.message);
  process.exit(1);
});
