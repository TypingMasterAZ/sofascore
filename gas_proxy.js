// ================================================
// RABONA MEDIA - Google Apps Script SofaScore Proxy V2
// Bu skripti Google Apps Script-ə yapışdır və Deploy et
// YENI: Mobil API dəstəyi + Rotating headers
// ================================================

const SOFA_BASE = "https://api.sofascore.com/api/v1";
const SOFA_MOBILE = "https://api.sofascore.com/mobile/v4";

function doGet(e) {
  try {
    const path = e.parameter.path || "/sport/football/events/live";
    const useMobile = e.parameter.mobile === "1";
    
    // Determine base URL
    const baseUrl = useMobile ? SOFA_MOBILE : SOFA_BASE;
    const url = baseUrl + path;

    // Rotating User-Agents for anti-detection
    const agents = [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:137.0) Gecko/20100101 Firefox/137.0",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Mobile/15E148 Safari/604.1",
      "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Mobile Safari/537.36"
    ];
    const ua = agents[Math.floor(Math.random() * agents.length)];

    const options = {
      method: "GET",
      headers: {
        "User-Agent": ua,
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9,az;q=0.8",
        "Accept-Encoding": "gzip, deflate, br",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache"
      },
      muteHttpExceptions: true,
      followRedirects: true
    };

    // For standard API, add Referer/Origin
    if (!useMobile) {
      options.headers["Referer"] = "https://www.sofascore.com/";
      options.headers["Origin"] = "https://www.sofascore.com";
    }

    const response = UrlFetchApp.fetch(url, options);
    const code = response.getResponseCode();
    const text = response.getContentText();

    // If the standard API returns 403, automatically try mobile API
    if (code === 403 && !useMobile) {
      const mobileUrl = SOFA_MOBILE + path;
      options.headers["User-Agent"] = agents[4]; // Mobile UA
      delete options.headers["Referer"];
      delete options.headers["Origin"];
      
      const mobileResponse = UrlFetchApp.fetch(mobileUrl, options);
      const mobileCode = mobileResponse.getResponseCode();
      const mobileText = mobileResponse.getContentText();
      
      return ContentService
        .createTextOutput(mobileText)
        .setMimeType(ContentService.MimeType.JSON);
    }

    return ContentService
      .createTextOutput(text)
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ error: true, message: err.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
