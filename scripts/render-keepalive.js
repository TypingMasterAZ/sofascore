const http = require("http");
const https = require("https");

const targetUrl = process.env.KEEPALIVE_URL || process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL;

if (!targetUrl) {
  console.error("KEEPALIVE_URL, RENDER_EXTERNAL_URL or PUBLIC_URL is required");
  process.exit(1);
}

function requestUrl(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("http://") ? http : https;
    const req = client.get(url, { timeout: 20000 }, (res) => {
      let body = "";
      res.on("data", chunk => { body += chunk; });
      res.on("end", () => {
        console.log(`[KeepAlive Cron] ${res.statusCode} ${url}`);
        if (body) console.log(body.slice(0, 1000));
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve();
        } else {
          reject(new Error(`Unexpected status ${res.statusCode}`));
        }
      });
    });
    req.on("timeout", () => {
      req.destroy(new Error("Request timed out"));
    });
    req.on("error", reject);
  });
}

async function main() {
  const baseUrl = targetUrl.replace(/\/$/, "");
  const stamp = Date.now();
  const endpoints = [
    `${baseUrl}/api/keepalive?force=1&t=${stamp}`,
    `${baseUrl}/api/matches/live?fast=1&t=${stamp}`,
    `${baseUrl}/api/top-leagues?t=${stamp}`,
    `${baseUrl}/api/categories?t=${stamp}`,
    `${baseUrl}/api/health?t=${stamp}`
  ];

  const results = await Promise.allSettled(endpoints.map(requestUrl));
  const failed = results.filter(item => item.status === "rejected");
  if (failed.length === results.length) {
    throw failed[0].reason;
  }
  if (failed.length) {
    console.warn(`[KeepAlive Cron] ${failed.length} endpoint(s) failed, but server responded.`);
    failed.forEach(item => console.warn(`[KeepAlive Cron] ${item.reason.message}`));
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[KeepAlive Cron] Request failed:", err.message);
    process.exit(1);
  });
