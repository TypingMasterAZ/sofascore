// ================================================
// RABONA MEDIA - Google Apps Script SofaScore Proxy V3
// Google Apps Script-ə yapışdır və Web App kimi deploy et
// Məqsəd: əvvəlcə GAS üstündən SofaScore almaq, sonra sayta JSON qaytarmaq
// ================================================

const SOFA_BASES = [
  "https://api.sofascore.com/api/v1",
  "https://www.sofascore.com/api/v1"
];

const HOME_PAGES = [
  "https://www.sofascore.com/",
  "https://www.sofascore.com/football/livescore"
];

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:137.0) Gecko/20100101 Firefox/137.0",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Mobile Safari/537.36"
];

function pickUA(index) {
  return USER_AGENTS[index % USER_AGENTS.length];
}

function normalizeTextBody(text) {
  const body = String(text || "").trim();
  if (!body) return { ok: false, reason: "empty-body" };

  if (body.startsWith("<!doctype") || body.startsWith("<html")) {
    return { ok: false, reason: "html-response", body: body.slice(0, 200) };
  }

  try {
    const json = JSON.parse(body);
    if (json && json.error) {
      return { ok: false, reason: "api-error", error: json.error, body: json };
    }
    return { ok: true, json };
  } catch (err) {
    return { ok: false, reason: "invalid-json", body: body.slice(0, 200) };
  }
}

function preflightCookies() {
  const cookies = [];

  HOME_PAGES.forEach((homeUrl, idx) => {
    try {
      const response = UrlFetchApp.fetch(homeUrl, {
        method: "get",
        muteHttpExceptions: true,
        followRedirects: true,
        headers: {
          "User-Agent": pickUA(idx),
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9,az;q=0.8",
          "Cache-Control": "no-cache",
          "Pragma": "no-cache"
        }
      });

      const headers = response.getAllHeaders();
      const setCookie = headers["Set-Cookie"] || headers["set-cookie"];
      if (setCookie) {
        if (Array.isArray(setCookie)) {
          cookies.push.apply(cookies, setCookie);
        } else {
          cookies.push(setCookie);
        }
      }
    } catch (err) {}
  });

  return cookies
    .map(cookie => String(cookie).split(";")[0].trim())
    .filter(Boolean)
    .join("; ");
}

function buildHeaders(ua, cookieHeader, referer) {
  const headers = {
    "User-Agent": ua,
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9,az;q=0.8",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
    "Referer": referer || "https://www.sofascore.com/football/livescore",
    "Origin": "https://www.sofascore.com",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-site"
  };

  if (cookieHeader) {
    headers["Cookie"] = cookieHeader;
  }

  return headers;
}

function fetchAttempt(baseUrl, path, queryString, headers) {
  const url = baseUrl + path + (queryString ? ("?" + queryString) : "");
  const response = UrlFetchApp.fetch(url, {
    method: "get",
    muteHttpExceptions: true,
    followRedirects: true,
    headers
  });

  const code = response.getResponseCode();
  const text = response.getContentText();
  const parsed = normalizeTextBody(text);

  if (code >= 200 && code < 300 && parsed.ok) {
    return {
      success: true,
      code,
      url,
      json: parsed.json
    };
  }

  return {
    success: false,
    code,
    url,
    parsed
  };
}

function doGet(e) {
  const startedAt = new Date().toISOString();
  try {
    const path = (e.parameter.path || "/sport/football/events/live").trim();

    const query = Object.keys(e.parameter || {})
      .filter(key => !["path", "mobile", "debug"].includes(key))
      .map(key => encodeURIComponent(key) + "=" + encodeURIComponent(e.parameter[key]))
      .join("&");

    const cookieHeader = preflightCookies();
    const attempts = [];

    for (let i = 0; i < SOFA_BASES.length; i++) {
      const baseUrl = SOFA_BASES[i];

      for (let uaIndex = 0; uaIndex < USER_AGENTS.length; uaIndex++) {
        const headers = buildHeaders(pickUA(uaIndex + i), cookieHeader, "https://www.sofascore.com/football/livescore");
        const result = fetchAttempt(baseUrl, path, query, headers);

        attempts.push({
          url: result.url,
          code: result.code,
          success: result.success,
          reason: result.parsed?.reason || null
        });

        if (result.success) {
          return ContentService
            .createTextOutput(JSON.stringify(result.json))
            .setMimeType(ContentService.MimeType.JSON);
        }

        Utilities.sleep(250);
      }
    }

    const failPayload = {
      error: {
        code: 403,
        reason: "Forbidden"
      },
      proxyDebug: {
        startedAt,
        path,
        attempts: attempts.slice(0, 20)
      }
    };

    return ContentService
      .createTextOutput(JSON.stringify(failPayload))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({
        error: true,
        message: err.toString(),
        startedAt
      }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
