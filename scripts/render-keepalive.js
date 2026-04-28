const https = require("https");

const targetUrl = process.env.KEEPALIVE_URL;

if (!targetUrl) {
  console.error("KEEPALIVE_URL is required");
  process.exit(1);
}

const pingUrl = `${targetUrl.replace(/\/$/, "")}/api/ping?t=${Date.now()}`;

https.get(pingUrl, (res) => {
  let body = "";
  res.on("data", chunk => { body += chunk; });
  res.on("end", () => {
    console.log(`[KeepAlive Cron] ${res.statusCode} ${pingUrl}`);
    console.log(body);
    process.exit(res.statusCode >= 200 && res.statusCode < 300 ? 0 : 1);
  });
}).on("error", (err) => {
  console.error("[KeepAlive Cron] Request failed:", err.message);
  process.exit(1);
});
