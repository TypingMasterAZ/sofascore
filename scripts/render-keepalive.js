const https = require("https");

const targetUrl = process.env.KEEPALIVE_URL;

if (!targetUrl) {
  console.error("KEEPALIVE_URL is required");
  process.exit(1);
}

function requestUrl(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let body = "";
      res.on("data", chunk => { body += chunk; });
      res.on("end", () => {
        console.log(`[KeepAlive Cron] ${res.statusCode} ${url}`);
        console.log(body);
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve();
        } else {
          reject(new Error(`Unexpected status ${res.statusCode}`));
        }
      });
    }).on("error", reject);
  });
}

async function main() {
  const baseUrl = targetUrl.replace(/\/$/, "");
  const endpoints = [
    `${baseUrl}/api/keepalive?t=${Date.now()}`
  ];

  for (const url of endpoints) {
    await requestUrl(url);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[KeepAlive Cron] Request failed:", err.message);
    process.exit(1);
  });
