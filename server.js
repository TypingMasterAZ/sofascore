const express = require("express");
// Version: 2.0.0 - Keep-Alive Fix + Render Sleep Prevention
console.log("-----------------------------------------");
console.log(`[STARTUP] Server booting at ${new Date().toISOString()}`);
console.log("-----------------------------------------");
require('dotenv').config();
const path = require("path");
const axios = require("axios");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const app = express();
const fs = require("fs");
const nodemailer = require("nodemailer");
const admin = require("firebase-admin");
const webpush = require("web-push");

// Firebase Admin SDK-nÄ±n yaradÄ±lmasÄ±
let serviceAccount;
let firebaseInitialized = false;

if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    let serviceAccountRaw = process.env.FIREBASE_SERVICE_ACCOUNT;
    serviceAccount = JSON.parse(serviceAccountRaw);
    if (serviceAccount.private_key && serviceAccount.private_key.includes('\\n')) {
        serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
    }
    firebaseInitialized = true;
    console.log("Firebase Admin SDK initialized from Environment Variable.");
  } catch (e) {
    console.error("FIREBASE_SERVICE_ACCOUNT env parse error:", e.message);
  }
}

// Render Secret File dÉ™stÉ™yi
const RENDER_SECRET_PATH = "/etc/secrets/FIREBASE_SERVICE_ACCOUNT";
if (!firebaseInitialized && fs.existsSync(RENDER_SECRET_PATH)) {
    try {
        const fileContent = fs.readFileSync(RENDER_SECRET_PATH, "utf8");
        serviceAccount = JSON.parse(fileContent);
        if (serviceAccount.private_key && serviceAccount.private_key.includes('\\n')) {
            serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
        }
        firebaseInitialized = true;
        console.log("Firebase Admin SDK initialized from Render Secret File.");
    } catch (e) {
        console.error("Render Secret File parse error:", e.message);
    }
}

if (!firebaseInitialized && fs.existsSync("./serviceAccountKey.json")) {
  try {
    serviceAccount = require("./serviceAccountKey.json");
    firebaseInitialized = true;
    console.log("Firebase Admin SDK initialized from serviceAccountKey.json file.");
  } catch (e) {
    console.error("Error loading serviceAccountKey.json file.");
  }
}

let db = null; // Firestore instance

if (firebaseInitialized) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  try {
    db = admin.firestore();
    db.settings({ ignoreUndefinedProperties: true });
    console.log("[Firestore] Connected successfully.");
  } catch (e) {
    console.error("[Firestore] Connection error:", e.message);
  }
} else {
  console.warn("[WARNING] Firebase Admin SDK not initialized. Push notifications will not work.");
}

const DEFAULT_VAPID_KEYS = {
  publicKey: "BHWOOLhZ6kHIPynDRpEilL9L7SMfwz0p9fWu0NLeZSIQCx2ffdlNwgLILQiA-d22Fy_SLPP-kTMa5AFo0YinhWM",
  privateKey: "XgT1SE-DUDLvp_IQsr60Qd_15fIau4OhXiu8zaGAAc8"
};
const VAPID_PUBLIC_KEY = process.env.WEB_PUSH_PUBLIC_KEY || DEFAULT_VAPID_KEYS.publicKey;
const VAPID_PRIVATE_KEY = process.env.WEB_PUSH_PRIVATE_KEY || DEFAULT_VAPID_KEYS.privateKey;
const VAPID_SUBJECT = process.env.WEB_PUSH_SUBJECT || "mailto:support@rabonamedia.app";

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

// â”€â”€â”€ FIRESTORE USER HELPERS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function getUsers() {
    if (db) {
        try {
            const snapshot = await db.collection('users').get();
            return snapshot.docs.map(d => d.data());
        } catch (e) { console.error("[Firestore] getUsers error:", e.message); }
    }
    if (fs.existsSync("./users.json")) {
        try { return JSON.parse(fs.readFileSync("./users.json", "utf-8")); } catch(e) {}
    }
    return [];
}

async function saveUser(userData) {
    const key = (userData.email || userData.username || String(userData.id || Date.now())).replace(/[^a-zA-Z0-9_\-]/g, '_');
    if (db) {
        try { await db.collection('users').doc(key).set(userData, { merge: true }); return; }
        catch (e) { console.error("[Firestore] saveUser error:", e.message); }
    }
    let users = [];
    if (fs.existsSync("./users.json")) {
        try { users = JSON.parse(fs.readFileSync("./users.json", "utf-8")); } catch(e) {}
    }
    const idx = users.findIndex(u => u.email === userData.email || u.username === userData.username);
    if (idx !== -1) users[idx] = { ...users[idx], ...userData };
    else users.push(userData);
    fs.writeFileSync("./users.json", JSON.stringify(users, null, 2));
}

async function getUserByEmail(email) {
    if (db) {
        try {
            const snap = await db.collection('users').where('email', '==', email).limit(1).get();
            if (!snap.empty) return snap.docs[0].data();
        } catch (e) { console.error("[Firestore] getUserByEmail error:", e.message); }
    }
    const users = await getUsers();
    return users.find(u => u.email === email) || null;
}
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// Nodemailer TÉ™nzimlÉ™mÉ™lÉ™ri (OTP gÃ¶ndÉ™rmÉ™k Ã¼Ã§Ã¼n)
// DÄ°QQÆT: Buraya Ã¶z email vÉ™ tÉ™tbiq ÅŸifrÉ™nizi (App Password) yazmalÄ±sÄ±nÄ±z
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER || 'typingmaster.az@gmail.com', // Sizin email
        pass: process.env.EMAIL_PASS || 'hlwg iaey ryxn klsq'    // Sizin "App Password" ÅŸifrÉ™niz
    }
});

app.use(cors({
    origin: '*', // HÉ™lÉ™lik hÉ™r yerÉ™ icazÉ™ veririk, Render linki bÉ™lli olandan sonra bunu GitHub linkinlÉ™ É™vÉ™z edÉ™ bilÉ™rik
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: "3mb" }));
app.use(express.static(path.join(__dirname)));
let detectedHostUrl = null;
app.use((req, res, next) => {
    if (!detectedHostUrl && req.headers.host) {
        detectedHostUrl = req.protocol + '://' + req.headers.host;
        console.log(`[Self-Ping] Host detected: ${detectedHostUrl}`);
    }
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
});

const SOFA_API = process.env.SOFA_API_BASE || "https://api.sofascore.com/api/v1";
const SOFA_WEB_API = "https://www.sofascore.com/api/v1";
const SOFA_APIS = [...new Set([SOFA_API, SOFA_WEB_API])];
const RAPIDAPI_HOST = "sofascore.p.rapidapi.com";
const GAS_PROXIES = [
    process.env.SOFA_PROXY_URL,
    process.env.GAS_PROXY_URL,
    process.env.SOFA_PROXY_URL_2,
    process.env.GAS_PROXY_URL_2,
    "https://script.google.com/macros/s/AKfycbwFuXK4oHJIAjMoCxPEMeh5hH5jn10PGYEEo048pnmQLFNQoI-M0Fqr5-NZ1wyITYJQrQ/exec",
    "https://script.google.com/macros/s/AKfycbxsHV0KhThLoQkzK5anpcQzb6-MdDed2bSIRWltFl46eHWVFQ-BJ4hNJgonVlgcX42_Ig/exec"
].filter(Boolean);

let currentProxyIndex = 0;
function getNextProxy() {
    if (GAS_PROXIES.length === 0) return null;
    const proxy = GAS_PROXIES[currentProxyIndex];
    currentProxyIndex = (currentProxyIndex + 1) % GAS_PROXIES.length;
    return proxy;
}
const HEADERS = {
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9,az;q=0.8",
    "Referer": "https://www.sofascore.com/football/livescore",
    "Origin": "https://www.sofascore.com",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache"
};

const USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36"
];

function getRandomUA() {
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

async function legacyFetchFromSofa(path, params = {}) {
    let lastError = null;

    // Strategy 1: Try all GAS Proxies
    for (let i = 0; i < GAS_PROXIES.length; i++) {
        const proxyUrl = getNextProxy();
        try {
            console.log(`[PROXY TRY] ${proxyUrl.substring(0, 50)}... for ${path}`);
            const queryParams = new URLSearchParams(params);
            queryParams.append('path', path);
            
            const res = await axios.get(proxyUrl, { 
                params: queryParams,
                timeout: 15000 
            });

            let data = res.data;
            if (data && typeof data === 'string') {
                if (data.trim().startsWith('<!doctype') || data.trim().startsWith('<html')) {
                    console.warn(`[PROXY BLOCKED] HTML response from proxy`);
                    continue;
                }
                try { data = JSON.parse(data); } catch (e) {}
            }

            if (data && data.error && (data.error.code === 403 || data.error.code === 404)) {
                console.warn(`[PROXY API ERROR] ${data.error.code} for ${path}`);
                continue;
            }

            if (data) {
                console.log(`[PROXY SUCCESS] ${path}`);
                return { data };
            }
        } catch (e) {
            console.error(`[PROXY FAILED] ${path}: ${e.message}`);
            lastError = e;
        }
    }

    // Strategy 2: Direct Sofascore API (with retries)
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            console.log(`[DIRECT TRY] ${path} (attempt ${attempt + 1})`);
            const headers = { ...HEADERS, "User-Agent": getRandomUA() };
            const res = await axios.get(`${SOFA_API}${path}`, { 
                headers: headers,
                params: params,
                timeout: 10000
            });

            let data = res.data;
            if (data && typeof data === 'string') {
                if (data.trim().startsWith('<!doctype') || data.trim().startsWith('<html')) {
                    throw new Error("HTML response (Blocked)");
                }
                try { data = JSON.parse(data); } catch (e) {}
            }

            console.log(`[DIRECT SUCCESS] ${path}`);
            return { data };
        } catch (e) {
            console.error(`[DIRECT FAILED] ${path}: ${e.message}`);
            lastError = e;
            if (attempt < 2) {
                await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
            }
        }
    }

    throw new Error(`BÃ¼tÃ¼n baÄŸlantÄ± cÉ™hdlÉ™ri uÄŸursuz oldu: ${lastError ? lastError.message : 'Unknown'}`);
}

const SOFA_DIRECT_TIMEOUT = 12000;
const SOFA_PROXY_TIMEOUT = 4000;
const inFlightSofaFetches = new Map();
let sofaRequestQueue = Promise.resolve();
let lastSofaRequestAt = 0;

function stableParamsKey(params = {}) {
    return JSON.stringify(Object.keys(params).sort().reduce((acc, key) => {
        acc[key] = params[key];
        return acc;
    }, {}));
}

function normalizeSofaData(data) {
    if (data && typeof data === 'string') {
        const text = data.trim();
        if (text.startsWith('<!doctype') || text.startsWith('<html')) {
            throw new Error("HTML response received instead of JSON");
        }
        try {
            data = JSON.parse(text);
        } catch (e) {
            throw new Error("Invalid JSON response");
        }
    }

    if (data && data.error) {
        const err = data.error;
        const code = err.code || err.status || "unknown";
        const reason = err.reason || err.message || "API error";
        throw new Error(`API Error: ${code} - ${reason}`);
    }

    return data;
}

function normalizeIncidentsData(data) {
    if (!data) return null;
    if (Array.isArray(data)) return { incidents: data };
    if (Array.isArray(data.incidents)) return data;
    if (data.data) return normalizeIncidentsData(data.data);
    return data;
}

async function fetchRapidApiIncidents(matchId) {
    const rapidApiKey = process.env.RAPIDAPI_KEY;
    if (!rapidApiKey) return null;

    const response = await axios.get(`https://${RAPIDAPI_HOST}/matches/get-incidents`, {
        headers: {
            "x-rapidapi-key": rapidApiKey,
            "x-rapidapi-host": RAPIDAPI_HOST
        },
        params: { matchId },
        timeout: 12000
    });

    return normalizeIncidentsData(response.data);
}

function shouldRetrySofa(error) {
    const status = error.response?.status;
    return !status || status >= 500;
}

async function runSofaRequest(fn) {
    const run = sofaRequestQueue.catch(() => {}).then(async () => {
        const waitMs = Math.max(0, 800 - (Date.now() - lastSofaRequestAt));
        if (waitMs > 0) {
            await new Promise(resolve => setTimeout(resolve, waitMs));
        }
        try {
            return await fn();
        } finally {
            lastSofaRequestAt = Date.now();
        }
    });
    sofaRequestQueue = run.catch(() => {});
    return run;
}

async function fetchFromSofa(path, params = {}) {
    const key = `${path}:${stableParamsKey(params)}`;
    if (inFlightSofaFetches.has(key)) {
        return inFlightSofaFetches.get(key);
    }

    const fetchPromise = fetchFromSofaUncached(path, params).finally(() => {
        inFlightSofaFetches.delete(key);
    });
    inFlightSofaFetches.set(key, fetchPromise);
    return fetchPromise;
}

async function fetchFromSofaUncached(path, params = {}) {
    let lastError = null;

    for (let i = 0; i < GAS_PROXIES.length; i++) {
        const proxyUrl = getNextProxy();
        try {
            console.log(`[PROXY TRY] ${proxyUrl.substring(0, 50)}... for ${path}`);
            const queryParams = new URLSearchParams(params);
            queryParams.set('path', path);

            const res = await runSofaRequest(() => axios.get(proxyUrl, {
                params: queryParams,
                timeout: SOFA_PROXY_TIMEOUT
            }));

            const data = normalizeSofaData(res.data);
            if (data) {
                console.log(`[PROXY SUCCESS] ${path}`);
                return { data };
            }
        } catch (e) {
            lastError = e;
            console.error(`[PROXY FAILED] ${path}: ${e.message}`);
        }
    }

    for (const baseUrl of SOFA_APIS) {
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                const host = new URL(baseUrl).hostname;
                console.log(`[DIRECT TRY] ${host}${path} (attempt ${attempt + 1})`);
                const headers = { ...HEADERS, "User-Agent": getRandomUA() };
                const res = await runSofaRequest(() => axios.get(`${baseUrl}${path}`, {
                    headers,
                    params,
                    timeout: SOFA_DIRECT_TIMEOUT
                }));

                const data = normalizeSofaData(res.data);
                if (data) {
                    console.log(`[DIRECT SUCCESS] ${host}${path}`);
                    return { data };
                }
            } catch (e) {
                lastError = e;
                const host = (() => { try { return new URL(baseUrl).hostname; } catch (_) { return baseUrl; } })();
                console.error(`[DIRECT FAILED] ${host}${path}: ${e.message}`);
                if (attempt === 0 && shouldRetrySofa(e)) {
                    await new Promise(r => setTimeout(r, 800));
                    continue;
                }
                break;
            }
        }
    }

    throw new Error(`Butun baglanti cehdleri ugursuz oldu: ${lastError ? lastError.message : 'Unknown'}`);
}

async function fetchFromSofaFastRace(path, params = {}, timeout = 6500) {
    const attempts = [];

    for (const proxyUrl of GAS_PROXIES.slice(0, 4)) {
        attempts.push((async () => {
            const queryParams = new URLSearchParams(params);
            queryParams.set("path", path);
            const res = await axios.get(proxyUrl, { params: queryParams, timeout });
            return normalizeSofaData(res.data);
        })());
    }

    for (const baseUrl of SOFA_APIS) {
        attempts.push((async () => {
            const headers = { ...HEADERS, "User-Agent": getRandomUA() };
            const res = await axios.get(`${baseUrl}${path}`, { headers, params, timeout });
            return normalizeSofaData(res.data);
        })());
    }

    if (attempts.length === 0) {
        const result = await fetchFromSofa(path, params);
        return result.data;
    }

    try {
        return await Promise.any(attempts);
    } catch (error) {
        const reasons = error.errors?.map(e => e.message).join(" | ") || error.message;
        throw new Error(`Fast Sofa fetch failed for ${path}: ${reasons}`);
    }
}

function pickActiveSeason(seasons = []) {
    if (!Array.isArray(seasons) || seasons.length === 0) return null;
    const currentYear = new Date().getFullYear();
    return seasons.find(s => s.isCurrent || s.current || s.year === currentYear) ||
        seasons.find(s => String(s.year || s.name || "").includes(String(currentYear))) ||
        seasons[0];
}

function getEspnStat(entry, names, fallback = 0) {
    const list = Array.isArray(entry?.stats) ? entry.stats : [];
    const stat = list.find(item => names.includes(item.name) || names.includes(item.type) || names.includes(item.abbreviation));
    if (!stat) return fallback;
    const numeric = Number(stat.value ?? stat.displayValue);
    return Number.isFinite(numeric) ? numeric : (stat.displayValue ?? fallback);
}

function normalizeEspnStandings(data, tourId, slug) {
    const standings = data?.children?.[0]?.standings || data?.standings;
    const entries = standings?.entries || [];
    if (!entries.length) throw new Error(`ESPN standings empty for ${slug}`);

    const rows = entries.map((entry, index) => {
        const team = entry.team || {};
        return {
            position: Number(getEspnStat(entry, ["rank"], index + 1)) || index + 1,
            team: {
                id: `espn-${team.id || index}`,
                name: team.displayName || team.name || team.shortDisplayName || "Team",
                shortName: team.shortDisplayName || team.abbreviation || team.displayName || "Team",
                logoUrl: team.logos?.[0]?.href || null,
                source: "espn"
            },
            matches: getEspnStat(entry, ["gamesPlayed", "gamesplayed", "GP"], 0),
            wins: getEspnStat(entry, ["wins", "W"], 0),
            draws: getEspnStat(entry, ["ties", "draws", "T", "D"], 0),
            losses: getEspnStat(entry, ["losses", "L"], 0),
            scoresFor: getEspnStat(entry, ["pointsFor", "goalsFor", "F"], 0),
            scoresAgainst: getEspnStat(entry, ["pointsAgainst", "goalsAgainst", "A"], 0),
            points: getEspnStat(entry, ["points", "P"], 0)
        };
    });

    return {
        standings: [{
            id: `espn-${slug}`,
            name: standings?.name || "overall",
            rows
        }],
        source: "espn",
        tournamentId: tourId,
        updatedAt: new Date().toISOString()
    };
}

async function fetchEspnStandings(tourId) {
    const slug = ESPN_STANDINGS_LEAGUES[tourId];
    if (!slug) return null;

    const currentSeason = new Date().getFullYear() - (new Date().getMonth() < 6 ? 1 : 0);
    const url = `https://site.web.api.espn.com/apis/v2/sports/soccer/${slug}/standings`;
    const response = await axios.get(url, {
        params: {
            region: "us",
            lang: "en",
            contentorigin: "espn",
            season: currentSeason,
            sort: "rank:asc"
        },
        timeout: 4500,
        headers: {
            "Accept": "application/json",
            "User-Agent": getRandomUA()
        }
    });

    return normalizeEspnStandings(response.data, tourId, slug);
}

// Diagnostic Endpoint Enhanced
app.get("/api/debug/proxy", async (req, res) => {
    const diagnostic = {
        timestamp: new Date().toISOString(),
        proxy_configured: GAS_PROXIES.length > 0,
        proxy_count: GAS_PROXIES.length,
        sofa_api: SOFA_APIS,
        node_version: process.version,
        env_keys: Object.keys(process.env).filter(key => key.includes("GAS") || key.includes("URL") || key.includes("API")),
        test_fetch: null
    };

    if (GAS_PROXIES.length > 0) {
        try {
            console.log("[DEBUG] Testing proxy connectivity...");
            const start = Date.now();
            const test = await axios.get(GAS_PROXIES[0], { 
                params: { path: "/sport/football/events/live" },
                timeout: 5000
            });
            const duration = Date.now() - start;

            const normalized = normalizeSofaData(test.data);
            const hasEvents = Array.isArray(normalized?.events);
            
            diagnostic.test_fetch = {
                status: hasEvents ? "SUCCESS" : "FAILED",
                duration_ms: duration,
                data_type: typeof test.data,
                data_preview: hasEvents
                    ? `events=${normalized.events.length}`
                    : (typeof test.data === 'object'
                        ? JSON.stringify(test.data).substring(0, 120)
                        : (typeof test.data === 'string' ? test.data.substring(0, 120) : "Unknown"))
            };
        } catch (err) {
            diagnostic.test_fetch = {
                status: "FAILED",
                error: err.message,
                response_status: err.response?.status,
                response_data: typeof err.response?.data === 'string' ? err.response.data.substring(0, 100) : "Binary/Object"
            };
        }
    }

    diagnostic.firebase = {
        initialized: firebaseInitialized,
        admin_ready: !!admin.apps.length,
        has_env_key: !!process.env.FIREBASE_SERVICE_ACCOUNT
    };

    diagnostic.notifications = {
        registration_count: Object.keys(fcmRegistrations).length,
        last_scores_size: Object.keys(lastScores).length
    };

    res.json(diagnostic);
});

// Caching System
const cache = {};
const CACHE_TIMES = {
    LIVE: 3 * 1000,        // 3 saniyə
    SCHEDULED: 5 * 60 * 1000, // 5 dÉ™qiqÉ™
    STATIC: 60 * 60 * 1000    // 1 saat
};

const IMAGE_CACHE_DIR = path.join(__dirname, ".image-cache");
const imageMemoryCache = new Map();
const imageInFlight = new Map();

function getImageCacheKey(imagePath) {
    return Buffer.from(imagePath).toString("base64").replace(/[+/=]/g, "_");
}

function getImageCachePaths(imagePath) {
    const key = getImageCacheKey(imagePath);
    return {
        filePath: path.join(IMAGE_CACHE_DIR, `${key}.bin`),
        metaPath: path.join(IMAGE_CACHE_DIR, `${key}.json`)
    };
}

function readCachedImage(imagePath) {
    const memoryHit = imageMemoryCache.get(imagePath);
    if (memoryHit) return memoryHit;

    try {
        const { filePath, metaPath } = getImageCachePaths(imagePath);
        if (!fs.existsSync(filePath)) return null;
        const body = fs.readFileSync(filePath);
        let contentType = "image/png";
        if (fs.existsSync(metaPath)) {
            const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
            contentType = meta.contentType || contentType;
        }
        const cached = { body, contentType, cached: true };
        imageMemoryCache.set(imagePath, cached);
        return cached;
    } catch (error) {
        console.warn(`[IMAGE CACHE READ] ${imagePath}: ${error.message}`);
        return null;
    }
}

function saveCachedImage(imagePath, payload) {
    try {
        fs.mkdirSync(IMAGE_CACHE_DIR, { recursive: true });
        const { filePath, metaPath } = getImageCachePaths(imagePath);
        fs.writeFileSync(filePath, payload.body);
        fs.writeFileSync(metaPath, JSON.stringify({
            contentType: payload.contentType,
            savedAt: new Date().toISOString()
        }));
        imageMemoryCache.set(imagePath, { ...payload, cached: true });
    } catch (error) {
        console.warn(`[IMAGE CACHE WRITE] ${imagePath}: ${error.message}`);
        imageMemoryCache.set(imagePath, { ...payload, cached: true });
    }
}

async function fetchSofaImageCached(imagePath) {
    const cached = readCachedImage(imagePath);
    if (cached) return cached;

    if (imageInFlight.has(imagePath)) {
        return imageInFlight.get(imagePath);
    }

    const request = (async () => {
        let response = null;
        let lastImageError = null;
        for (const baseUrl of SOFA_APIS) {
            try {
                response = await axios.get(`${baseUrl}${imagePath}`, {
                    responseType: "arraybuffer",
                    timeout: 5000,
                    headers: {
                        ...HEADERS,
                        Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
                        Referer: "https://www.sofascore.com/",
                        "User-Agent": getRandomUA()
                    }
                });
                break;
            } catch (error) {
                lastImageError = error;
            }
        }

        if (!response) throw lastImageError || new Error("Image fetch failed");

        const payload = {
            body: Buffer.from(response.data),
            contentType: response.headers["content-type"] || "image/png"
        };
        saveCachedImage(imagePath, payload);
        return { ...payload, cached: false };
    })().finally(() => {
        imageInFlight.delete(imagePath);
    });

    imageInFlight.set(imagePath, request);
    return request;
}

let lastScores = {};
let liveGoalIncidentState = {};
let goalNotificationState = {};
let globalLiveEvents = null;
let lastLiveFetchTime = 0;
let lastLiveFetchAttemptTime = 0;
let liveFetchPromise = null;
let liveSnapshotLoadPromise = null;
const LIVE_SNAPSHOT_FILE = "./live_snapshot.json";
const LIVE_SNAPSHOT_MAX_AGE = 12 * 1000;
const MACKOLIK_LIVE_URL = "https://www.mackolik.com/perform/p0/ajax/components/competition/livescores/json";
const MACKOLIK_LIVE_PAGE_URL = "https://www.mackolik.com/canli-sonuclar";
const MACKOLIK_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Referer": "https://www.mackolik.com/canli-sonuclar",
    "X-Requested-With": "XMLHttpRequest"
};

function getMackolikTeamLogo(teamId) {
    const id = teamId ? String(teamId) : "";
    if (!id || id.length < 5 || id === "1" || id === "2") return null;
    return `https://file.mackolikfeeds.com/teams/${id}`;
}

function getMackolikCountryLogo(countryId) {
    return countryId ? `https://file.mackolikfeeds.com/areas/${countryId}` : null;
}

function decodeMackolikSettings(raw) {
    return String(raw || "")
        .replace(/&quot;/g, '"')
        .replace(/&#039;/g, "'")
        .replace(/&amp;/g, '&');
}

function extractMackolikSettingsObjects(html) {
    const results = [];
    const regex = /data-settings="([\s\S]*?)"/gi;
    let match;
    while ((match = regex.exec(String(html || ""))) !== null) {
        try {
            const decoded = decodeMackolikSettings(match[1]);
            results.push(JSON.parse(decoded));
        } catch (_) {}
    }
    return results;
}

async function fetchMackolikLiveConfig() {
    try {
        const response = await axios.get(MACKOLIK_LIVE_PAGE_URL, {
            headers: {
                "User-Agent": MACKOLIK_HEADERS["User-Agent"],
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
            },
            timeout: 15000
        });

        const html = String(response.data || "");
        const settingsMatch = html.match(/data-module="livescore"[\s\S]*?data-settings="([\s\S]*?)"/i);
        if (!settingsMatch) {
            throw new Error("Mackolik live config not found");
        }

        const decoded = decodeMackolikSettings(settingsMatch[1]);
        const settings = JSON.parse(decoded);
        const params = settings?.asyncRequestParams || {};

        return {
            matchDate: params.matchDate,
            sports: ["Soccer"],
            urlJson: settings?.urlJson || MACKOLIK_LIVE_URL
        };
    } catch (error) {
        console.warn("[MACKOLIK CONFIG] Falling back to default live config:", error.message);
        return {
            matchDate: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10),
            sports: ["Soccer"],
            urlJson: MACKOLIK_LIVE_URL
        };
    }
}

function getMackolikInitialSeconds(periodId) {
    switch (Number(periodId)) {
        case 2: return 45 * 60;
        case 3: return 90 * 60;
        case 4: return 105 * 60;
        default: return 0;
    }
}

function getMackolikMinuteText(match) {
    if (!match?.periodStart) return null;
    const elapsedSeconds = Math.max(0, Math.floor((Date.now() - Number(match.periodStart)) / 1000));
    const minute = Math.floor((elapsedSeconds + getMackolikInitialSeconds(match.periodId)) / 60) + 1;
    if (!Number.isFinite(minute) || minute <= 0) return null;
    return `${minute}'`;
}

function mapMackolikStatus(match) {
    const state = match?.state;
    const substate = (match?.substate || "").toLowerCase();
    const box = (match?.statusBoxContent || "").toUpperCase();

    if (state === "live") {
        if (substate === "halftime" || box === "İY" || box === "IY") {
            return { type: "inprogress", description: "HT" };
        }
        return {
            type: "inprogress",
            description: getMackolikMinuteText(match) || (box || "LIVE")
        };
    }

    if (state === "post") {
        if (substate === "penalties") return { type: "finished", description: "PEN" };
        if (substate === "afterextratime") return { type: "finished", description: "AET" };
        return { type: "finished", description: "FT" };
    }

    if (substate === "postponed") {
        return { type: "notstarted", description: "POSTPONED" };
    }

    return { type: "notstarted", description: box || "" };
}

function normalizeMackolikMatch(match, competitions, options = {}) {
    const { liveOnly = false } = options;
    const competition = competitions[match?.competitionId] || {};
    if (competition?.sport !== "S") return null;
    if (liveOnly && match?.state !== "live") return null;

    const category = competition.country || {};
    const status = mapMackolikStatus(match);
    const homeScore = Number(match?.score?.home ?? 0);
    const awayScore = Number(match?.score?.away ?? 0);
    const homeTeamId = match?.homeTeam?.id || `mk_home_${match.id}`;
    const awayTeamId = match?.awayTeam?.id || `mk_away_${match.id}`;
    const tournamentLogoUrl = getMackolikCountryLogo(category.id);

    return {
        id: match.id,
        slug: match.matchSlug || `${match.homeTeam?.slug || "home"}-vs-${match.awayTeam?.slug || "away"}`,
        customId: match.iddaaCode ? String(match.iddaaCode) : match.id,
        startTimestamp: match.mstUtc ? Math.floor(Number(match.mstUtc) / 1000) : undefined,
        status,
        time: match.periodStart ? {
            currentPeriodStartTimestamp: Math.floor(Number(match.periodStart) / 1000),
            initial: getMackolikInitialSeconds(match.periodId)
        } : undefined,
        homeTeam: {
            id: homeTeamId,
            name: match?.homeTeam?.name || "Home",
            shortName: match?.homeTeam?.name || "Home",
            slug: match?.homeTeam?.slug || "",
            logoUrl: getMackolikTeamLogo(homeTeamId)
        },
        awayTeam: {
            id: awayTeamId,
            name: match?.awayTeam?.name || "Away",
            shortName: match?.awayTeam?.name || "Away",
            slug: match?.awayTeam?.slug || "",
            logoUrl: getMackolikTeamLogo(awayTeamId)
        },
        homeScore: {
            current: Number.isFinite(homeScore) ? homeScore : 0
        },
        awayScore: {
            current: Number.isFinite(awayScore) ? awayScore : 0
        },
        tournament: {
            id: competition.id || match.competitionId,
        name: competition.name || "Liqa",
            slug: competition.competitionSlug || "",
            logoUrl: tournamentLogoUrl,
            category: {
                id: category.id || `mk_cat_${competition.id || match.competitionId}`,
                name: category.name || "Digər",
                slug: competition.countrySlug || "",
                logoUrl: tournamentLogoUrl
            },
            uniqueTournament: {
                id: competition.id || match.competitionId,
                    name: competition.name || "Liqa",
                slug: competition.competitionSlug || "",
                logoUrl: tournamentLogoUrl
            }
        },
        season: competition.seasonId ? { id: competition.seasonId } : null,
        source: "mackolik"
    };
}

function normalizeMackolikMatchesData(payload, options = {}) {
    const { liveOnly = false } = options;
    const data = payload?.data || {};
    const competitions = data.competitions || {};
    const events = Object.values(data.matches || {})
        .map(match => normalizeMackolikMatch(match, competitions, { liveOnly }))
        .filter(Boolean);

    return {
        events,
        source: "mackolik",
        generatedAt: new Date().toISOString()
    };
}

async function fetchLiveFromMackolik() {
    const config = await fetchMackolikLiveConfig();
    const response = await axios.get(config.urlJson, {
        params: {
            sports: config.sports,
            matchDate: config.matchDate
        },
        headers: MACKOLIK_HEADERS,
        timeout: 20000
    });

    if (response.data?.status !== "success") {
        throw new Error(`Mackolik live request failed: ${response.data?.status || "unknown"}`);
    }

    const normalized = normalizeMackolikMatchesData(response.data, { liveOnly: true });
    normalized.matchDate = config.matchDate;
    return normalized;
}

async function fetchMackolikMatchesByDate(matchDate) {
    const response = await axios.get(MACKOLIK_LIVE_URL, {
        params: {
            sports: ["Soccer"],
            matchDate
        },
        headers: MACKOLIK_HEADERS,
        timeout: 20000
    });

    if (response.data?.status !== "success") {
        throw new Error(`Mackolik date request failed: ${response.data?.status || "unknown"}`);
    }

    const normalized = normalizeMackolikMatchesData(response.data, { liveOnly: false });
    normalized.matchDate = matchDate;
    return normalized;
}

function mapMackolikIncident(item) {
    if (!item?.type) return null;
    const rawTime = String(item.timeMin || "");
    const timeMatch = rawTime.match(/(\d+)/);
    const addedMatch = rawTime.match(/\+\s*(\d+)/);
    const base = {
        time: timeMatch ? Number(timeMatch[1]) : 0,
        addedTime: addedMatch ? Number(addedMatch[1]) : undefined,
        isHome: item.position === "home"
    };

    if (item.type === "goal") {
        return {
            ...base,
            incidentType: "goal",
            incidentClass: item.subType === "penalty" ? "penalty" : (item.subType === "owngoal" ? "ownGoal" : "regular"),
            playerName: item.playerName || "",
            player: item.playerName ? { name: item.playerName } : undefined,
            assist1: item.assistPlayerName ? { name: item.assistPlayerName } : undefined,
            homeScore: item.score?.split("-")?.[0],
            awayScore: item.score?.split("-")?.[1]
        };
    }

    if (item.type === "card") {
        return {
            ...base,
            incidentType: "card",
            incidentClass: item.subType === "yc" ? "yellow" : "red",
            playerName: item.playerName || "",
            player: item.playerName ? { name: item.playerName } : undefined
        };
    }

    if (item.type === "substitute") {
        return {
            ...base,
            incidentType: "substitution",
            playerIn: item.playerName ? { name: item.playerName } : undefined,
            playerOut: item.playerOutName ? { name: item.playerOutName } : undefined
        };
    }

    return null;
}

function formatMackolikStatName(key) {
    const map = {
        possesionPercentage: "Topa sahibolma %",
        possessionPercentage: "Topa sahibolma %",
        shotsOnTarget: "Qapıya zərbə",
        shotsOffTarget: "Çərçivədən kənar",
        totalPasses: "Ötürmə",
        corners: "Künc zərbələri",
        fouls: "Qayda pozuntuları",
        yellowCards: "Sarı kart",
        redCards: "Qırmızı kart"
    };
    return map[key] || key.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase()).trim();
}

async function fetchMackolikMatchDetails(matchId, slug = "") {
    const safeSlug = slug || "mac";
    const url = `https://www.mackolik.com/mac/${safeSlug}/${matchId}`;
    const response = await axios.get(url, {
        headers: {
            "User-Agent": MACKOLIK_HEADERS["User-Agent"],
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
        },
        timeout: 20000
    });

    const settingsObjects = extractMackolikSettingsObjects(response.data);
    const keyEventsSettings = settingsObjects.find(obj => obj?.url?.includes("/ajax/football/key-events"));
    const gameStatsSettings = settingsObjects.find(obj => obj?.url?.includes("/ajax/soccer/match/gameStats"));

    let keyEvents = Array.isArray(keyEventsSettings?.keyEvents) ? keyEventsSettings.keyEvents : [];
    if (!keyEvents.length && keyEventsSettings?.url && keyEventsSettings?.asyncRequestParams) {
        const keyEventsResponse = await axios.get(keyEventsSettings.url, {
            params: keyEventsSettings.asyncRequestParams,
            headers: MACKOLIK_HEADERS,
            timeout: 15000
        }).catch(() => null);
        keyEvents = Array.isArray(keyEventsResponse?.data?.keyEvents) ? keyEventsResponse.data.keyEvents : [];
    }

    const incidents = keyEvents.map(mapMackolikIncident).filter(Boolean);

    const homeStats = gameStatsSettings?.home || {};
    const awayStats = gameStatsSettings?.away || {};
    const statKeys = [...new Set([...Object.keys(homeStats), ...Object.keys(awayStats)])];
    const statisticsItems = statKeys.map(key => ({
        name: formatMackolikStatName(key),
        homeValue: String(homeStats[key] ?? 0),
        awayValue: String(awayStats[key] ?? 0)
    }));

    return {
        incidents: { incidents },
        stats: statisticsItems.length ? {
            statistics: [{
                period: "ALL",
                groups: [{
                    groupName: "Ümumi",
                    statisticsItems
                }]
            }]
        } : { statistics: [] }
    };
}

function loadLiveSnapshot() {
    try {
        if (!fs.existsSync(LIVE_SNAPSHOT_FILE)) return;
        const snapshot = JSON.parse(fs.readFileSync(LIVE_SNAPSHOT_FILE, "utf-8"));
        if (snapshot?.data?.events && Array.isArray(snapshot.data.events)) {
            if (snapshot.data.source && snapshot.data.source !== "mackolik") {
                console.log(`[LIVE SNAPSHOT] Ignoring unsupported snapshot source: ${snapshot.data.source}`);
                return;
            }
            globalLiveEvents = snapshot.data;
            lastLiveFetchTime = snapshot.timestamp || 0;
            console.log(`[LIVE SNAPSHOT] Loaded ${snapshot.data.events.length} events from disk cache.`);
        }
    } catch (e) {
        console.warn("[LIVE SNAPSHOT] Load failed:", e.message);
    }
}

async function loadLiveSnapshotFromFirestore() {
    if (!db) return false;
    try {
        const snap = await db.collection('app_state').doc('live_snapshot').get();
        const data = snap.data();
        if (data?.payload?.events && Array.isArray(data.payload.events)) {
            if (data.payload.source && data.payload.source !== "mackolik") {
                console.log(`[LIVE SNAPSHOT] Ignoring unsupported Firestore snapshot source: ${data.payload.source}`);
                return false;
            }
            globalLiveEvents = data.payload;
            lastLiveFetchTime = data.timestamp || 0;
            console.log(`[LIVE SNAPSHOT] Loaded ${data.payload.events.length} events from Firestore cache.`);
            return true;
        }
    } catch (e) {
        console.warn("[LIVE SNAPSHOT] Firestore load failed:", e.message);
    }
    return false;
}

async function ensureLiveSnapshotLoaded() {
    if (globalLiveEvents?.events?.length) return true;
    if (!liveSnapshotLoadPromise) {
        liveSnapshotLoadPromise = (async () => {
            loadLiveSnapshot();
            if (globalLiveEvents?.events?.length) return true;
            return loadLiveSnapshotFromFirestore();
        })().finally(() => {
            liveSnapshotLoadPromise = null;
        });
    }
    return liveSnapshotLoadPromise;
}

function saveLiveSnapshot() {
    try {
        if (!globalLiveEvents?.events) return;
        fs.writeFileSync(LIVE_SNAPSHOT_FILE, JSON.stringify({
            data: globalLiveEvents,
            timestamp: lastLiveFetchTime
        }));
    } catch (e) {
        console.warn("[LIVE SNAPSHOT] Save failed:", e.message);
    }
    if (db && globalLiveEvents?.events) {
        db.collection('app_state').doc('live_snapshot').set({
            payload: globalLiveEvents,
            timestamp: lastLiveFetchTime,
            updatedAt: Date.now()
        }).catch(e => {
            console.warn("[LIVE SNAPSHOT] Firestore save failed:", e.message);
        });
    }
}

loadLiveSnapshot();

const FALLBACK_TOP_LEAGUES = [
    { id: 7, name: "UEFA Champions League", category: { id: 1465, name: "Europe" } },
    { id: 679, name: "UEFA Europa League", category: { id: 1465, name: "Europe" } },
    { id: 14643, name: "UEFA Conference League", category: { id: 1465, name: "Europe" } },
    { id: 17, name: "Premier League", category: { id: 1, name: "England" } },
    { id: 8, name: "LaLiga", category: { id: 32, name: "Spain" } },
    { id: 23, name: "Serie A", category: { id: 31, name: "Italy" } },
    { id: 35, name: "Bundesliga", category: { id: 30, name: "Germany" } },
    { id: 34, name: "Ligue 1", category: { id: 7, name: "France" } },
    { id: 52, name: "Super Lig", category: { id: 46, name: "Turkey" } },
    { id: 709, name: "Azərbaycan Premyer Liqası", category: { id: 297, name: "Azerbaijan" }, season: { id: 78700 } }
];

const KNOWN_CURRENT_SEASONS = {
    17: 76986,  // Premier League 25/26
    8: 77559,   // LaLiga 25/26
    23: 76457,  // Serie A 25/26
    35: 77333,  // Bundesliga 25/26
    34: 77356,  // Ligue 1 25/26
    52: 77805,  // Super Lig 25/26
    709: 78700, // Azərbaycan Premyer Liqası 25/26
    679: 76984  // UEFA Europa League 25/26
};

const ESPN_STANDINGS_LEAGUES = {
    7: "uefa.champions",
    679: "uefa.europa",
    14643: "uefa.europa.conf",
    17: "eng.1",
    8: "esp.1",
    23: "ita.1",
    35: "ger.1",
    34: "fra.1",
    52: "tur.1"
};

const STANDINGS_SNAPSHOT_FILE = path.join(__dirname, "standings_snapshot.json");
const FOOTBALL_STANDINGS_SNAPSHOT_FILE = path.join(__dirname, "football_standings_snapshot.json");
let standingsWarmIndex = 0;

function loadStandingsSnapshot() {
    try {
        if (!fs.existsSync(STANDINGS_SNAPSHOT_FILE)) return;
        const parsed = JSON.parse(fs.readFileSync(STANDINGS_SNAPSHOT_FILE, "utf8"));
        const items = parsed.items || {};
        Object.entries(items).forEach(([key, value]) => {
            if (value?.data) cache[key] = { data: value.data, timestamp: value.timestamp || Date.now() };
        });
        console.log(`[STANDINGS SNAPSHOT] Loaded ${Object.keys(items).length} cached standings.`);
    } catch (e) {
        console.warn("[STANDINGS SNAPSHOT] Load failed:", e.message);
    }
}

function saveStandingSnapshot(key, data) {
    try {
        let parsed = { items: {} };
        if (fs.existsSync(STANDINGS_SNAPSHOT_FILE)) {
            try { parsed = JSON.parse(fs.readFileSync(STANDINGS_SNAPSHOT_FILE, "utf8")); } catch (_) {}
        }
        parsed.items = parsed.items || {};
        parsed.items[key] = { data, timestamp: Date.now() };
        fs.writeFileSync(STANDINGS_SNAPSHOT_FILE, JSON.stringify(parsed));
    } catch (e) {
        console.warn("[STANDINGS SNAPSHOT] Save failed:", e.message);
    }
}

loadStandingsSnapshot();

function loadFallbackStandings() {
    try {
        if (fs.existsSync(FOOTBALL_STANDINGS_SNAPSHOT_FILE)) {
            const parsed = JSON.parse(fs.readFileSync(FOOTBALL_STANDINGS_SNAPSHOT_FILE, "utf8"));
            if (parsed.items && typeof parsed.items === "object") {
                console.log(`[STANDINGS FALLBACK] Loaded ${Object.keys(parsed.items).length} league standings.`);
                return parsed.items;
            }
        }
    } catch (error) {
        console.warn("[STANDINGS FALLBACK] Load failed:", error.message);
    }
    return {};
}

const FALLBACK_STANDINGS = loadFallbackStandings();

function getFallbackStanding(tourId, seasonId) {
    const item = FALLBACK_STANDINGS[String(tourId)];
    const data = item?.data || null;
    if (!data?.standings?.length) return null;
    if (seasonId && data.seasonId && String(data.seasonId) !== String(seasonId)) return null;
    return data;
}

const FOOTBALL_CATEGORIES_SNAPSHOT_FILE = path.join(__dirname, "football_categories_snapshot.json");
const FOOTBALL_CATEGORY_TOURNAMENTS_SNAPSHOT_FILE = path.join(__dirname, "football_category_tournaments_snapshot.json");

function loadFallbackCategories() {
    try {
        if (fs.existsSync(FOOTBALL_CATEGORIES_SNAPSHOT_FILE)) {
            const parsed = JSON.parse(fs.readFileSync(FOOTBALL_CATEGORIES_SNAPSHOT_FILE, "utf8"));
            if (Array.isArray(parsed.categories) && parsed.categories.length) {
                return parsed.categories;
            }
        }
    } catch (error) {
        console.warn("[Categories Snapshot] Load failed:", error.message);
    }

    return [
        { id: 1, name: "England", slug: "england", flag: "england", alpha2: "EN", priority: 10 },
        { id: 32, name: "Spain", slug: "spain", flag: "spain", alpha2: "ES", priority: 10 },
        { id: 31, name: "Italy", slug: "italy", flag: "italy", alpha2: "IT", priority: 10 },
        { id: 30, name: "Germany", slug: "germany", flag: "germany", alpha2: "DE", priority: 10 },
        { id: 7, name: "France", slug: "france", flag: "france", alpha2: "FR", priority: 10 },
        { id: 46, name: "Turkey", slug: "turkey", flag: "turkey", alpha2: "TR", priority: 10 },
        { id: 1465, name: "Europe", slug: "europe", flag: "europe", alpha2: "EU", priority: 10 },
        { id: 297, name: "Azerbaijan", slug: "azerbaijan", flag: "azerbaijan", alpha2: "AZ", priority: 10 }
    ];
}

const FALLBACK_CATEGORIES = loadFallbackCategories();

function loadFallbackCategoryTournaments() {
    try {
        if (fs.existsSync(FOOTBALL_CATEGORY_TOURNAMENTS_SNAPSHOT_FILE)) {
            const parsed = JSON.parse(fs.readFileSync(FOOTBALL_CATEGORY_TOURNAMENTS_SNAPSHOT_FILE, "utf8"));
            if (parsed.items && typeof parsed.items === "object") {
                return parsed.items;
            }
        }
    } catch (error) {
        console.warn("[Category Tournaments Snapshot] Load failed:", error.message);
    }
    return {};
}

const FALLBACK_CATEGORY_TOURNAMENTS = loadFallbackCategoryTournaments();

function getFallbackCategoryTournaments(categoryId) {
    const item = FALLBACK_CATEGORY_TOURNAMENTS[String(categoryId)];
    return item?.data || null;
}

let imageWarmIndex = 0;

function collectStaticLeagueImagePaths() {
    const paths = [];
    FALLBACK_TOP_LEAGUES.forEach(league => {
        paths.push(`/unique-tournament/${league.id}/image`);
        if (league.category?.id) paths.push(`/category/${league.category.id}/image`);
    });
    FALLBACK_CATEGORIES.forEach(category => paths.push(`/category/${category.id}/image`));
    return [...new Set(paths)];
}

function collectTopLeagueImagePaths(data) {
    const tournaments = data?.uniqueTournaments || data?.data || [];
    return tournaments
        .filter(item => item?.id)
        .flatMap(item => [
            `/unique-tournament/${item.id}/image`,
            item.category?.id ? `/category/${item.category.id}/image` : null
        ])
        .filter(Boolean);
}

function collectCategoryImagePaths(data) {
    return (data?.categories || [])
        .filter(item => item?.id)
        .map(item => `/category/${item.id}/image`);
}

function collectTournamentImagePaths(data) {
    const tournaments = [];
    if (Array.isArray(data?.uniqueTournaments)) tournaments.push(...data.uniqueTournaments);
    if (Array.isArray(data?.groups)) {
        data.groups.forEach(group => {
            if (Array.isArray(group.uniqueTournaments)) tournaments.push(...group.uniqueTournaments);
        });
    }
    return tournaments
        .filter(item => item?.id)
        .flatMap(item => [
            `/unique-tournament/${item.id}/image`,
            item.category?.id ? `/category/${item.category.id}/image` : null
        ])
        .filter(Boolean);
}

function collectStandingTeamImagePaths(data) {
    const rows = data?.standings?.flatMap(standing => standing.rows || []) || [];
    return rows
        .map(row => row?.team?.id ? `/team/${row.team.id}/image` : null)
        .filter(Boolean);
}

function warmStandingTeamImages(data, limit = 32) {
    return warmImagePaths(collectStandingTeamImagePaths(data), limit);
}

async function warmImagePaths(paths, limit = 12) {
    const unique = [...new Set(paths)].filter(Boolean).slice(0, limit);
    if (!unique.length) return;
    await Promise.allSettled(unique.map(imagePath => fetchSofaImageCached(imagePath)));
}

async function warmLeagueImages(limit = 10) {
    const paths = collectStaticLeagueImagePaths();
    if (!paths.length) return;
    const batch = [];
    for (let i = 0; i < Math.min(limit, paths.length); i++) {
        batch.push(paths[(imageWarmIndex + i) % paths.length]);
    }
    imageWarmIndex = (imageWarmIndex + batch.length) % paths.length;
    await warmImagePaths(batch, batch.length);
}

async function getCachedData(key, fetchFn, ttl, options = {}) {
    const now = Date.now();
    if (cache[key] && (now - cache[key].timestamp < ttl)) {
        console.log(`[CACHE HIT] Key: ${key}`);
        return cache[key].data;
    }
    
    console.log(`[CACHE MISS] Key: ${key}. Fetching fresh data...`);
    // Random jitter (100ms - 500ms) to avoid robotic patterns
    if (!options.skipJitter) {
        await new Promise(resolve => setTimeout(resolve, Math.random() * 400 + 100));
    }
    
    try {
        const data = await fetchFn();
        cache[key] = { data, timestamp: Date.now() };
        return data;
    } catch (error) {
        if (cache[key]) {
            console.warn(`[CACHE STALE] Key: ${key}. Returning stale data after fetch error: ${error.message}`);
            return cache[key].data;
        }
        throw error;
    }
}

async function getLiveEventsData(forceFresh = false, preferImmediateCache = false) {
    const now = Date.now();
    const hasUsableCache = globalLiveEvents && Array.isArray(globalLiveEvents.events);
    if (preferImmediateCache && hasUsableCache && (now - lastLiveFetchTime <= LIVE_SNAPSHOT_MAX_AGE)) {
        if (!liveFetchPromise) {
            getLiveEventsData(true).catch(() => {});
        }
        return {
            ...globalLiveEvents,
            stale: true,
            staleSince: lastLiveFetchTime ? new Date(lastLiveFetchTime).toISOString() : null
        };
    }

    if (!forceFresh && hasUsableCache && (now - lastLiveFetchTime < CACHE_TIMES.LIVE)) {
        return globalLiveEvents;
    }

    if (!forceFresh && hasUsableCache && (now - lastLiveFetchAttemptTime < CACHE_TIMES.LIVE)) {
        return {
            ...globalLiveEvents,
            stale: true,
            staleSince: new Date(lastLiveFetchTime).toISOString()
        };
    }

    if (!liveFetchPromise) {
        lastLiveFetchAttemptTime = now;
        liveFetchPromise = (async () => {
            const data = await fetchLiveFromMackolik();
            if (!data || !Array.isArray(data.events)) {
                throw new Error("Live response missing events array");
            }
            globalLiveEvents = data;
            lastLiveFetchTime = Date.now();
            saveLiveSnapshot();
            return globalLiveEvents;
        })().finally(() => {
            liveFetchPromise = null;
        });
    }

    try {
        return await liveFetchPromise;
    } catch (error) {
        if (hasUsableCache) {
            console.warn(`[LIVE STALE] Returning cached live events after fetch error: ${error.message}`);
            return {
                ...globalLiveEvents,
                stale: true,
                staleSince: new Date(lastLiveFetchTime).toISOString()
            };
        }
        throw error;
    }
}

function extractGoalIncidents(data) {
    const incidents = normalizeIncidentsData(data)?.incidents || [];
    return incidents.filter(incident => incident?.incidentType === "goal");
}

function buildGoalIncidentKey(incident) {
    const scorer =
        incident?.player?.id ||
        incident?.playerName ||
        incident?.player?.name ||
        incident?.playerIn?.id ||
        incident?.playerIn?.name ||
        "unknown";
    return [
        incident?.time ?? "na",
        incident?.addedTime ?? "0",
        incident?.isHome ? "home" : "away",
        incident?.incidentClass || "regular",
        scorer
    ].join(":");
}

function markGoalNotification(matchId, marker) {
    const matchKey = matchId?.toString();
    if (!matchKey || !marker) return;
    if (!goalNotificationState[matchKey]) goalNotificationState[matchKey] = {};
    goalNotificationState[matchKey][marker] = Date.now();
}

function hasRecentGoalNotification(matchId, marker, maxAgeMs = 3 * 60 * 1000) {
    const matchKey = matchId?.toString();
    const ts = goalNotificationState[matchKey]?.[marker];
    if (!ts) return false;
    return (Date.now() - ts) <= maxAgeMs;
}

function pruneGoalNotificationState(maxAgeMs = 6 * 60 * 60 * 1000) {
    const now = Date.now();
    Object.keys(goalNotificationState).forEach(matchId => {
        Object.keys(goalNotificationState[matchId] || {}).forEach(marker => {
            if (now - goalNotificationState[matchId][marker] > maxAgeMs) {
                delete goalNotificationState[matchId][marker];
            }
        });
        if (Object.keys(goalNotificationState[matchId] || {}).length === 0) {
            delete goalNotificationState[matchId];
        }
    });
}

async function getMatchIncidentsData(matchId) {
    return getCachedData(`incidents_${matchId}`, async () => {
        try {
            const result = await fetchFromSofa(`/event/${matchId}/incidents`);
            return normalizeIncidentsData(result.data);
        } catch (error) {
            console.warn(`[INCIDENTS FALLBACK] Native incidents failed for ${matchId}: ${error.message}`);
            const fallback = await fetchRapidApiIncidents(matchId);
            if (fallback) return fallback;
            throw error;
        }
    }, 6000);
}

// API vasitÉ™Ã§isi (Komanda mÉ™lumatlarÄ± vÉ™ heyÉ™t Ã¼Ã§Ã¼n)
app.get("/api/team/:id", async (req, res) => {
    try {
        const teamId = req.params.id;
        const [infoResult, playersResult] = await Promise.allSettled([
            fetchFromSofa(`/team/${teamId}`),
            fetchFromSofa(`/team/${teamId}/players`)
        ]);

        if (infoResult.status !== "fulfilled") {
            throw infoResult.reason;
        }

        res.json({
            info: infoResult.value.data,
            players: playersResult.status === "fulfilled" ? playersResult.value.data : { players: [] }
        });
    } catch (error) {
        console.error(`[API ERROR] Team ${req.params.id}: ${error.message}${error.response ? ' | Status: ' + error.response.status : ''}`);
        res.status(500).json({ error: true, message: error.message, details: error.response?.data?.substring?.(0, 100) });
    }
});

// Yeni API: CanlÄ± MatÃ§lar
app.get("/api/matches/live", async (req, res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');

    try {
        await ensureLiveSnapshotLoaded();
        const allowImmediateCache = req.query.fast === "1" || !!globalLiveEvents?.events?.length;
        const data = await getLiveEventsData(false, allowImmediateCache);
        res.json(data);
    } catch (error) {
        console.error(`[API ERROR] Live matches: ${error.message}${error.response ? ' | Status: ' + error.response.status : ''}`);
        res.status(500).json({ error: true, message: error.message, details: error.response?.data?.substring?.(0, 100) });
    }
});

// Yeni API: MatÃ§lar (Skedullu)
app.get("/api/matches/:date", async (req, res) => {
    const { date } = req.params;
    try {
        const today = new Date().toISOString().split('T')[0];
        const ttl = (date === today) ? 10 * 1000 : CACHE_TIMES.SCHEDULED; // 10s cache for today
        const data = await getCachedData(`matches_${date}`, async () => {
            return await fetchMackolikMatchesByDate(date);
        }, ttl);
        res.json(data);
    } catch (error) {
        console.error(`[API ERROR] Scheduled matches for date ${date}: ${error.message}${error.response ? ' | Status: ' + error.response.status : ''}`);
        res.status(500).json({ error: true, message: error.message, details: error.response?.data?.substring?.(0, 100) });
    }
});

// Yeni API: MatÃ§ HadisÉ™lÉ™ri (Qollar, Kartlar)
app.get("/api/match/:id/incidents", async (req, res) => {
    const id = req.params.id;
    try {
        if (req.query.source === "mackolik") {
            const data = await getCachedData(`mackolik_incidents_${id}_${req.query.slug || ""}`, async () => {
                const details = await fetchMackolikMatchDetails(id, req.query.slug || "");
                return details.incidents;
            }, 12000);
            return res.json(data);
        }
        const data = await getMatchIncidentsData(id);
        res.json(data);
    } catch (error) {
        console.error(`[API ERROR] Match incidents ${id}: ${error.message}`);
        const cached = cache[`incidents_${id}`];
        if (cached) return res.json(cached.data);
        res.status(500).json({ error: true, message: error.message });
    }
});

// Yeni API: MatÃ§ StatistikasÄ±
app.get("/api/match/:id/statistics", async (req, res) => {
    const id = req.params.id;
    try {
        const data = await getCachedData(`stats_${id}`, async () => {
            const result = await fetchFromSofa(`/event/${id}/statistics`);
            return result.data;
        }, 30000); // 30s cache
        res.json(data);
    } catch (error) {
        console.error(`[API ERROR] Match statistics ${id}: ${error.message}`);
        const cached = cache[`stats_${id}`];
        if (cached) return res.json(cached.data);
        res.status(500).json({ error: true, message: error.message });
    }
});

// Yeni API: H2H (Head to Head) MatÃ§lar - Native Sofascore API
app.get("/api/match/:id/h2h", async (req, res) => {
    const id = req.params.id;
    try {
        const result = await fetchFromSofa(`/event/${id}/h2h-events`);
        res.json(result.data);
    } catch (error) {
        console.error(`[API ERROR] Match H2H ${id}: ${error.message}`);
        res.status(500).json({ error: true, message: error.message });
    }
});

// MatÃ§ detallarÄ±nÄ± vahid endpoint-dÉ™ birlÉ™ÅŸdiririk (bloklanmamaq Ã¼Ã§Ã¼n)
app.get("/api/match/:id/details", async (req, res) => {
    const id = req.params.id;
    try {
        if (req.query.source === "mackolik") {
            const data = await getCachedData(`mackolik_details_${id}_${req.query.slug || ""}_${req.query.stats === "0" ? "nostats" : "all"}`, async () => {
                return await fetchMackolikMatchDetails(id, req.query.slug || "");
            }, 12000);
            return res.json(req.query.stats === "0" ? { incidents: data.incidents, stats: null } : data);
        }

        const statsDisabled = req.query.stats === "0";
        const optionalCachedFetch = (key, path, ttl) => getCachedData(key, async () => {
            try {
                const result = await fetchFromSofa(path);
                return key.startsWith("incidents_") ? normalizeIncidentsData(result.data) : result.data;
            } catch (error) {
                if (error.response?.status === 404 || error.message.includes("404")) {
                    return null;
                }
                if (key.startsWith("incidents_")) {
                    console.warn(`[INCIDENTS FALLBACK] Native details incidents failed for ${id}: ${error.message}`);
                    const fallback = await fetchRapidApiIncidents(id);
                    if (fallback) return fallback;
                }
                throw error;
            }
        }, ttl).catch(() => null);

        const incidentsPromise = optionalCachedFetch(`incidents_${id}`, `/event/${id}/incidents`, 12000);
        const statsPromise = statsDisabled
            ? Promise.resolve(null)
            : optionalCachedFetch(`stats_${id}`, `/event/${id}/statistics`, 30000);

        const [incidents, stats] = await Promise.all([incidentsPromise, statsPromise]);

        res.json({
            incidents,
            stats
        });
    } catch (error) {
        console.error(`[API ERROR] Match details main ${id}: ${error.message}`);
        res.status(500).json({ error: true });
    }
});



// Yeni API: CanlÄ± Liqa CÉ™dvÉ™li Ã¼Ã§Ã¼n Proxy
app.get("/api/standings-fast/:tourId", async (req, res) => {
    const startedAt = Date.now();
    try {
        const { tourId } = req.params;
        let seasonId = req.query.seasonId;
        let season = null;
        const fallbackStanding = getFallbackStanding(tourId, seasonId);

        const cachedForTour = Object.entries(cache).find(([key, value]) =>
            key.startsWith(`standings_${tourId}_`) &&
            value?.data?.standings?.length
        );
        if (!seasonId && cachedForTour) {
            const cachedSeasonId = cachedForTour[0].split("_").pop();
            warmStandingTeamImages(cachedForTour[1].data, 36).catch(e => {
                console.warn(`[Image Warmup] Cached standings teams ${tourId} failed:`, e.message);
            });
            return res.json({
                ...cachedForTour[1].data,
                seasonId: cachedSeasonId,
                cached: true,
                fast: true,
                durationMs: Date.now() - startedAt
            });
        }

        if (fallbackStanding) {
            res.json({
                ...fallbackStanding,
                seasonId: fallbackStanding.seasonId || seasonId || "snapshot",
                cached: true,
                snapshot: true,
                fast: true,
                durationMs: Date.now() - startedAt
            });

            warmStandingTeamImages(fallbackStanding, 36).catch(e => {
                console.warn(`[Image Warmup] Snapshot standings teams ${tourId} failed:`, e.message);
            });

            const refreshSeasonId = fallbackStanding.seasonId || seasonId || KNOWN_CURRENT_SEASONS[tourId];
            if (refreshSeasonId) {
                getCachedData(`standings_${tourId}_${refreshSeasonId}`, async () => {
                    return await fetchFromSofaFastRace(`/unique-tournament/${tourId}/season/${refreshSeasonId}/standings/total`, {}, 7000);
                }, CACHE_TIMES.STATIC, { skipJitter: true })
                    .then(data => {
                        if (data?.standings?.length) saveStandingSnapshot(`standings_${tourId}_${refreshSeasonId}`, data);
                    })
                    .catch(e => console.warn(`[STANDINGS SNAPSHOT REFRESH] ${tourId}: ${e.message}`));
            }
            return;
        }

        if (!seasonId) {
            seasonId = KNOWN_CURRENT_SEASONS[tourId];
        }

        if (ESPN_STANDINGS_LEAGUES[tourId]) {
            const espnCacheKey = `standings_${tourId}_espn`;
            try {
                const espnData = await getCachedData(espnCacheKey, async () => {
                    return await fetchEspnStandings(tourId);
                }, 30 * 60 * 1000);

                if (espnData?.standings?.length) {
                    saveStandingSnapshot(espnCacheKey, espnData);
                    warmStandingTeamImages(espnData, 36).catch(e => {
                        console.warn(`[Image Warmup] ESPN standings teams ${tourId} failed:`, e.message);
                    });
                    return res.json({
                        ...espnData,
                        seasonId: seasonId || "espn",
                        fast: true,
                        source: "espn",
                        durationMs: Date.now() - startedAt
                    });
                }
            } catch (espnError) {
                console.warn(`[ESPN STANDINGS FALLBACK] ${tourId}: ${espnError.message}`);
            }
        }

        if (!seasonId) {
            const seasonCacheKey = `fast_seasons_${tourId}`;
            const seasonsData = await getCachedData(seasonCacheKey, async () => {
                return await fetchFromSofaFastRace(`/unique-tournament/${tourId}/seasons`, {}, 5000);
            }, CACHE_TIMES.STATIC);

            season = pickActiveSeason(seasonsData?.seasons || []);
            seasonId = season?.id;
        }

        if (!seasonId) {
            return res.status(404).json({
                error: true,
                message: "Season not found",
                durationMs: Date.now() - startedAt
            });
        }

        const standingsCacheKey = `standings_${tourId}_${seasonId}`;
        const data = await getCachedData(standingsCacheKey, async () => {
            return await fetchFromSofaFastRace(`/unique-tournament/${tourId}/season/${seasonId}/standings/total`, {}, 7000);
        }, CACHE_TIMES.STATIC);

        if (data?.standings?.length) {
            saveStandingSnapshot(standingsCacheKey, data);
            warmStandingTeamImages(data, 36).catch(e => {
                console.warn(`[Image Warmup] Standings teams ${tourId} failed:`, e.message);
            });
        }

        res.json({
            ...data,
            seasonId,
            season,
            fast: true,
            durationMs: Date.now() - startedAt
        });
    } catch (error) {
        console.error(`[API ERROR] Fast standings tour=${req.params.tourId}: ${error.message}`);
        const fallbackStanding = getFallbackStanding(req.params.tourId, req.query.seasonId);
        if (fallbackStanding) {
            warmStandingTeamImages(fallbackStanding, 36).catch(e => {
                console.warn(`[Image Warmup] Error fallback standings teams ${req.params.tourId} failed:`, e.message);
            });
            return res.json({
                ...fallbackStanding,
                seasonId: fallbackStanding.seasonId || req.query.seasonId || "snapshot",
                cached: true,
                snapshot: true,
                fast: true,
                durationMs: Date.now() - startedAt
            });
        }
        res.status(500).json({ error: true, message: error.message, durationMs: Date.now() - startedAt });
    }
});

app.get("/api/standings/:tourId/:seasonId", async (req, res) => {
    try {
        const { tourId, seasonId } = req.params;
        const data = await getCachedData(`standings_${tourId}_${seasonId}`, async () => {
            const result = await fetchFromSofa(`/unique-tournament/${tourId}/season/${seasonId}/standings/total`);
            return result.data;
        }, CACHE_TIMES.STATIC);
        warmStandingTeamImages(data, 36).catch(e => {
            console.warn(`[Image Warmup] Direct standings teams ${tourId} failed:`, e.message);
        });
        res.json(data);
    } catch (error) {
        console.error(`[API ERROR] Standings tour=${req.params.tourId} season=${req.params.seasonId}: ${error.message}${error.response ? ' | Status: ' + error.response.status : ''}`);
        const fallbackStanding = getFallbackStanding(req.params.tourId, req.params.seasonId);
        if (fallbackStanding) {
            warmStandingTeamImages(fallbackStanding, 36).catch(e => {
                console.warn(`[Image Warmup] Direct fallback standings teams ${req.params.tourId} failed:`, e.message);
            });
            return res.json({
                ...fallbackStanding,
                seasonId: fallbackStanding.seasonId || req.params.seasonId,
                cached: true,
                snapshot: true
            });
        }
        res.status(500).json({ error: true, message: error.message });
    }
});

// Yeni API: Populyar Liqalar siyahÄ±sÄ±
app.get("/api/top-leagues", async (req, res) => {
    try {
        const data = await getCachedData("top_leagues", async () => {
            const result = await fetchFromSofa("/config/top-unique-tournaments/AZ/football");
            return result.data;
        }, CACHE_TIMES.STATIC);
        res.json(data);
        warmImagePaths(collectTopLeagueImagePaths(data), 24).catch(e => {
            console.warn("[Image Warmup] Top leagues failed:", e.message);
        });
    } catch (error) {
        console.error(`[API ERROR] Top Leagues: ${error.message}`);
        const fallback = { uniqueTournaments: FALLBACK_TOP_LEAGUES, fallback: true };
        cache.top_leagues = { data: fallback, timestamp: Date.now() };
        res.json(fallback);
        warmImagePaths(collectTopLeagueImagePaths(fallback), 24).catch(e => {
            console.warn("[Image Warmup] Fallback top leagues failed:", e.message);
        });
    }
});

// Yeni API: BÃ¼tÃ¼n Kategoriyalar (Ã–lkÉ™lÉ™r)
app.get("/api/categories", async (req, res) => {
    try {
        const data = await getCachedData("categories", async () => {
            const result = await fetchFromSofa("/sport/football/categories");
            return result.data;
        }, CACHE_TIMES.STATIC);
        const categories = Array.isArray(data?.categories) && data.categories.length
            ? data.categories
            : FALLBACK_CATEGORIES;
        const payload = { ...data, categories };
        res.json(payload);
        warmImagePaths(collectCategoryImagePaths(payload), 30).catch(e => {
            console.warn("[Image Warmup] Categories failed:", e.message);
        });
    } catch (error) {
        console.error(`[API ERROR] Categories: ${error.message}`);
        const fallback = { categories: FALLBACK_CATEGORIES, fallback: true };
        cache.categories = { data: fallback, timestamp: Date.now() };
        res.json(fallback);
        warmImagePaths(collectCategoryImagePaths(fallback), 30).catch(e => {
            console.warn("[Image Warmup] Fallback categories failed:", e.message);
        });
    }
});

app.get("/api/sofa-image", async (req, res) => {
    try {
        const imagePath = String(req.query.path || "");
        const allowedImagePath = /^\/(?:unique-tournament|tournament|category|team)\/[\w-]+\/image$/;
        if (!allowedImagePath.test(imagePath)) {
            return res.status(400).type("image/svg+xml").send('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" rx="12" fill="#111827"/></svg>');
        }

        const image = await fetchSofaImageCached(imagePath);
        res.set("Content-Type", image.contentType || "image/png");
        res.set("Cache-Control", "public, max-age=604800, immutable");
        res.set("X-Image-Cache", image.cached ? "HIT" : "MISS");
        res.send(image.body);
    } catch (error) {
        console.error(`[IMAGE ERROR] ${req.query.path}: ${error.message}`);
        if (req.query.strict === "1") {
            return res.status(404).type("image/svg+xml").send('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" rx="12" fill="#111827"/></svg>');
        }
        res.status(200).type("image/svg+xml").send('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" rx="12" fill="#111827"/><circle cx="24" cy="24" r="11" fill="#334155"/></svg>');
    }
});

// Yeni API: Kateqoriya Ã¼zrÉ™ Liqalar
app.get("/api/category/:id/tournaments", async (req, res) => {
    const categoryId = String(req.params.id);
    const fallbackData = getFallbackCategoryTournaments(categoryId);
    const cacheKey = `category_tournaments_${categoryId}`;
    const fetchFresh = async () => await fetchFromSofaFastRace(`/category/${categoryId}/unique-tournaments`, {}, 5500);

    if (req.query.fast === "1" && fallbackData) {
        res.json({ ...fallbackData, fallback: true, snapshot: true });
        getCachedData(cacheKey, fetchFresh, CACHE_TIMES.STATIC, { skipJitter: true })
            .then(data => warmImagePaths(collectTournamentImagePaths(data), 36))
            .catch(e => console.warn(`[Category Snapshot Refresh] ${categoryId} failed:`, e.message));
        return;
    }

    try {
        const data = await getCachedData(cacheKey, async () => {
            try {
                return await fetchFresh();
            } catch (error) {
                if (fallbackData) {
                    console.warn(`[Category Fallback] ${categoryId}: ${error.message}`);
                    return { ...fallbackData, fallback: true, snapshot: true };
                }
                throw error;
            }
        }, CACHE_TIMES.STATIC, { skipJitter: true });
        res.json(data);
        warmImagePaths(collectTournamentImagePaths(data), 36).catch(e => {
            console.warn(`[Image Warmup] Category ${categoryId} leagues failed:`, e.message);
        });
    } catch (error) {
        if (fallbackData) {
            return res.json({ ...fallbackData, fallback: true, snapshot: true });
        }
        res.status(500).json({ error: true });
    }
});

// Yeni API: Turnir MÉ™lumatÄ± (Single League Info)
app.get("/api/tournament/:id", async (req, res) => {
    try {
        const type = req.query.isUnique === 'false' ? 'tournament' : 'unique-tournament';
        const data = await getCachedData(`tournament_${type}_${req.params.id}`, async () => {
            const result = await fetchFromSofa(`/${type}/${req.params.id}`);
            return result.data;
        }, CACHE_TIMES.STATIC);
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: true });
    }
});

// Yeni API: Turnir MÃ¶vsÃ¼mlÉ™ri (Seasons)
app.get("/api/tournament/:id/seasons", async (req, res) => {
    try {
        const type = req.query.isUnique === 'false' ? 'tournament' : 'unique-tournament';
        const data = await getCachedData(`seasons_${type}_${req.params.id}`, async () => {
            const result = await fetchFromSofa(`/${type}/${req.params.id}/seasons`);
            return result.data;
        }, CACHE_TIMES.STATIC);
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: true });
    }
});

// Yeni API: Qlobal AxtarÄ±ÅŸ
app.get("/api/search", async (req, res) => {
    try {
        const { q } = req.query;
        if (!q) return res.json({ results: [] });
        const result = await fetchFromSofa("/search/all", { q });
        res.json(result.data);
    } catch (error) {
        res.status(500).json({ error: true });
    }
});

// Yeni API: BombardirlÉ™r (Top Players)
app.get("/api/tournament/:id/season/:sid/top-players", async (req, res) => {
    try {
        const { id, sid } = req.params;
        const data = await getCachedData(`topplayers_${id}_${sid}`, async () => {
            const result = await fetchFromSofa(`/unique-tournament/${id}/season/${sid}/top-players/overall`);
            return result.data;
        }, CACHE_TIMES.STATIC);
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: true });
    }
});
// Yeni API: ÅifrÉ™ SÄ±fÄ±rlama Kodu GÃ¶ndÉ™r (OTP)
app.post("/api/auth/send-otp", async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, message: "Email lazÄ±mdÄ±r." });
    console.log(`[AUTH] Sending OTP to: ${email}`);

    const otp = Math.floor(1000 + Math.random() * 9000).toString();
    const expiry = Date.now() + 3 * 60 * 1000; // 3 dÉ™qiqÉ™ valid

    try {
        let user = await getUserByEmail(email) || { email: email, resendCount: 0 };

        // GÃ¼ndÉ™lik Limit YoxlanÄ±ÅŸÄ± (5 dÉ™fÉ™)
        const today = new Date().toISOString().split('T')[0];
        
        if (user.lastResendDate === today) {
            if (user.resendCount >= 5) {
                return res.status(429).json({ success: false, message: "GÃ¼ndÉ™lik limitiniz (5 dÉ™fÉ™) dolub. Sabah yenidÉ™n cÉ™hd edin." });
            }
            user.resendCount++;
        } else {
            user.lastResendDate = today;
            user.resendCount = 1;
        }

        user.otp = otp;
        user.otpExpiry = expiry;
        await saveUser(user);

        const mailOptions = {
            from: '"Rabona Media" <typingmaster.az@gmail.com>',
            to: email,
            subject: 'ÅifrÉ™ SÄ±fÄ±rlama Kodunuz - Rabona Media',
            html: `
                <div style="font-family: Arial, sans-serif; padding: 20px; color: #333;">
                    <h2 style="color: #3b82f6;">Rabona Media LIVE</h2>
                    <p>Salam,</p>
                    <p>ÅifrÉ™nizi sÄ±fÄ±rlamaq Ã¼Ã§Ã¼n tÉ™lÉ™b gÃ¶ndÉ™rdiniz. Sizin birdÉ™fÉ™lik tÉ™sdiq kodunuz (OTP):</p>
                    <div style="font-size: 32px; font-weight: bold; color: #ef4444; padding: 15px 30px; background: #f1f5f9; border-radius: 8px; display: inline-block; margin: 10px 0; letter-spacing: 5px;">
                        ${otp}
                    </div>
                    <p>Bu kod <b>3 dÉ™qiqÉ™</b> É™rzindÉ™ etibarlÄ±dÄ±r.</p>
                    <p>ÆgÉ™r bunu siz etmÉ™misinizsÉ™, zÉ™hmÉ™t olmasa bu emaili nÉ™zÉ™rÉ™ almayÄ±n.</p>
                    <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;">
                    <p style="font-size: 12px; color: #94a3b8;">Bu avtomatik gÃ¶ndÉ™rilÉ™n bir mesajdÄ±r, cavab yazmayÄ±n.</p>
                </div>
            `
        };

        await transporter.sendMail(mailOptions);
        res.json({ success: true, message: "OTP kod email Ã¼nvanÄ±nÄ±za gÃ¶ndÉ™rildi." });

    } catch (error) {
        console.error("OTP Error:", error);
        res.status(500).json({ success: false, message: "Email gÃ¶ndÉ™rilÉ™rkÉ™n xÉ™ta baÅŸ verdi." });
    }
});

// Yeni API: OTP Kodu Yoxla (SadÉ™cÉ™ DoÄŸrulama)
app.post("/api/auth/check-otp", async (req, res) => {
    const { email, otp } = req.body;
    try {
        const userData = await getUserByEmail(email);
        const user = (userData && userData.otp === otp) ? userData : null;
        console.log(`[AUTH] Checking OTP for ${email}: ${otp ? 'Provided' : 'Missing'}`);
        
        if (!user) {
            console.log(`[AUTH] OTP mismatch for ${email}`);
            return res.status(400).json({ success: false, message: "Kod yanlÄ±ÅŸdÄ±r." });
        }
        if (Date.now() > user.otpExpiry) {
            console.log(`[AUTH] OTP expired for ${email}`);
            return res.status(400).json({ success: false, message: "Kodun vaxtÄ± bitib." });
        }

        res.json({ success: true, message: "Kod tÉ™sdiqlÉ™ndi. Yeni ÅŸifrÉ™ni daxil edin." });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

// Yeni API: ÅifrÉ™ni Final Olaraq DÉ™yiÅŸ
app.post("/api/auth/verify-otp", async (req, res) => {
    const { email, otp, newPassword } = req.body;
    
    try {
        const user = await getUserByEmail(email);
        
        if (!user || user.otp !== otp) {
            return res.status(400).json({ success: false, message: "Kod yanlÄ±ÅŸdÄ±r." });
        }
        
        if (Date.now() > user.otpExpiry) {
            return res.status(400).json({ success: false, message: "Kodun vaxtÄ± bitib." });
        }

        // ===== FIREBASE ÅÄ°FRÆ DEYÄ°ÅÄ°KLÄ°YÄ° ======
        if (firebaseInitialized) {
            try {
                const firebaseUser = await admin.auth().getUserByEmail(email);
                await admin.auth().updateUser(firebaseUser.uid, {
                    password: newPassword
                });
                console.log(`[AUTH] Firebase password successfully updated for UID: ${firebaseUser.uid}`);
            } catch (fbError) {
                console.error("[AUTH] Firebase update password error:", fbError);
                return res.status(500).json({ success: false, message: "Firebase hesabÄ±nÄ±zla É™laqÉ™ yaradÄ±la bilmÉ™di. ÅifrÉ™ yenilÉ™nmÉ™di." });
            }
        } else {
            console.warn("[AUTH] Firebase not initialized, skipping Firebase Auth password update.");
        }

        // OTP-ni tÉ™mizlÉ™ vÉ™ ÅŸifrÉ™ni hash-lÉ™yÉ™rÉ™k saxla
        const salt = await bcrypt.genSalt(10);
        user.password = await bcrypt.hash(newPassword, salt);
        delete user.otp;
        delete user.otpExpiry;
        await saveUser(user);
        res.json({ success: true, message: "ÅifrÉ™ uÄŸurla dÉ™yiÅŸdirildi." });

    } catch (e) {
        res.status(500).json({ success: false });
    }
});

// Yeni API: Profil MÉ™lumatlarÄ±nÄ± YenilÉ™
app.post("/api/auth/update-profile", async (req, res) => {
    const { email, displayName, status, profilePic } = req.body;
    
    if (!email) return res.status(400).json({ success: false, message: "Email lazÄ±mdÄ±r." });

    try {
        let user = await getUserByEmail(email) || { email: email, username: displayName || email.split('@')[0], status: status || "ProScore istifadÉ™Ã§isi" };
        if (displayName) user.username = displayName;
        if (status !== undefined) user.status = status;
        if (profilePic !== undefined) user.profilePic = profilePic;
        user.updatedAt = new Date().toISOString();
        await saveUser(user);
        res.json({ success: true, message: "Profil uÄŸurla yenilÉ™ndi." });
    } catch (e) {
        console.error("Update profile error:", e);
        res.status(500).json({ success: false, message: "Server xÉ™tasÄ± baÅŸ verdi." });
    }
});

// Yeni API: Profil MÉ™lumatlarÄ±nÄ± GÉ™tir
app.get("/api/auth/profile/:email", async (req, res) => {
    const { email } = req.params;
    try {
        const user = await getUserByEmail(email);
        if (!user) return res.status(404).json({ success: false, message: "Ä°stifadÉ™Ã§i tapÄ±lmadÄ±." });

        res.json({
            success: true,
            data: {
                displayName: user.username,
                status: user.status || "ProScore istifadÉ™Ã§isi",
                profilePic: user.profilePic || "",
                updatedAt: user.updatedAt || null
            }
        });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

// FCM Device & Favorites Tracking
const REG_FILE = "./registrations.json";
let fcmRegistrations = {}; // { token: { favorites: [] } }
const WEB_PUSH_FILE = "./webpush_registrations.json";
let webPushRegistrations = {}; // { deviceId: { subscription, favorites, leagues } }

// Persistent History for sync
const NOTIF_HISTORY_FILE = "./notif_history.json";
let serverNotifHistory = [];
function loadNotifHistory() {
    try {
        if (fs.existsSync(NOTIF_HISTORY_FILE)) {
            serverNotifHistory = JSON.parse(fs.readFileSync(NOTIF_HISTORY_FILE, "utf-8"));
        }
    } catch (e) { console.error("[FCM] Error loading history:", e.message); }
}
function saveNotifHistory() {
    try {
        fs.writeFileSync(NOTIF_HISTORY_FILE, JSON.stringify(serverNotifHistory.slice(0, 50), null, 2));
    } catch (e) { console.error("[FCM] Error saving history:", e.message); }
}
loadNotifHistory();

async function loadRegistrations() {
    // Try Firestore first
    if (db) {
        try {
            const snap = await db.collection('fcm_registrations').doc('tokens').get();
            if (snap.exists) {
                fcmRegistrations = snap.data() || {};
                console.log(`[FCM] Loaded ${Object.keys(fcmRegistrations).length} registrations from Firestore.`);
                return;
            }
        } catch (e) { console.error("[FCM] Firestore load error:", e.message); }
    }
    // Fallback: local file
    try {
        if (fs.existsSync(REG_FILE)) {
            fcmRegistrations = JSON.parse(fs.readFileSync(REG_FILE, "utf-8"));
            console.log(`[FCM] Loaded ${Object.keys(fcmRegistrations).length} registrations from file.`);
        }
    } catch (e) { console.error("[FCM] File load error:", e.message); }
}
loadRegistrations();

async function loadWebPushRegistrations() {
    if (db) {
        try {
            const snap = await db.collection('webpush_registrations').doc('devices').get();
            if (snap.exists) {
                webPushRegistrations = snap.data() || {};
                console.log(`[WebPush] Loaded ${Object.keys(webPushRegistrations).length} registrations from Firestore.`);
                return;
            }
        } catch (e) { console.error("[WebPush] Firestore load error:", e.message); }
    }
    try {
        if (fs.existsSync(WEB_PUSH_FILE)) {
            webPushRegistrations = JSON.parse(fs.readFileSync(WEB_PUSH_FILE, "utf-8"));
            console.log(`[WebPush] Loaded ${Object.keys(webPushRegistrations).length} registrations from file.`);
        }
    } catch (e) { console.error("[WebPush] File load error:", e.message); }
}
loadWebPushRegistrations();

function saveRegistrations() {
    // Save to Firestore (non-blocking)
    if (db) {
        db.collection('fcm_registrations').doc('tokens').set(fcmRegistrations)
            .catch(e => console.error("[FCM] Firestore save error:", e.message));
    }
    // Also keep local fallback
    try {
        fs.writeFileSync(REG_FILE, JSON.stringify(fcmRegistrations, null, 2));
    } catch (e) { console.error("[FCM] File save error:", e.message); }
}

function saveWebPushRegistrations() {
    if (db) {
        db.collection('webpush_registrations').doc('devices').set(webPushRegistrations)
            .catch(e => console.error("[WebPush] Firestore save error:", e.message));
    }
    try {
        fs.writeFileSync(WEB_PUSH_FILE, JSON.stringify(webPushRegistrations, null, 2));
    } catch (e) { console.error("[WebPush] File save error:", e.message); }
}

function normalizeIdList(list) {
    return Array.isArray(list)
        ? [...new Set(list.map(item => item?.toString()).filter(Boolean))]
        : [];
}

function getFavoritePayloadFromReg(reg) {
    return {
        favorites: normalizeIdList(reg?.favorites),
        leagues: normalizeIdList(reg?.leagues)
    };
}

function collectFavoriteRecipients(matchId, leagueId) {
    const matchKey = matchId?.toString();
    const leagueKey = leagueId?.toString();
    const recipients = [];

    Object.entries(fcmRegistrations).forEach(([token, reg]) => {
        const { favorites, leagues } = getFavoritePayloadFromReg(reg);
        if (favorites.includes(matchKey) || leagues.includes(leagueKey)) {
            recipients.push({ channel: "fcm", id: token, reg });
        }
    });

    Object.entries(webPushRegistrations).forEach(([deviceId, reg]) => {
        const { favorites, leagues } = getFavoritePayloadFromReg(reg);
        if (favorites.includes(matchKey) || leagues.includes(leagueKey)) {
            recipients.push({ channel: "webpush", id: deviceId, reg });
        }
    });

    return recipients;
}

function removeInvalidWebPushRegistration(deviceId) {
    if (webPushRegistrations[deviceId]) {
        delete webPushRegistrations[deviceId];
        saveWebPushRegistrations();
    }
}

async function sendWebPushMessage(deviceId, payload) {
    const reg = webPushRegistrations[deviceId];
    if (!reg?.subscription?.endpoint) return false;

    try {
        await webpush.sendNotification(reg.subscription, JSON.stringify(payload), {
            TTL: payload.ttl || 4 * 60 * 60,
            urgency: payload.urgency || "high"
        });
        return true;
    } catch (err) {
        console.error(`[WebPush] Send error for ${deviceId}:`, err.statusCode || err.message);
        if (err.statusCode === 404 || err.statusCode === 410) {
            removeInvalidWebPushRegistration(deviceId);
        }
        return false;
    }
}

function createPushPayload({ title, body, matchId, type, tag, requireInteraction = false }) {
    return {
        title,
        body,
        icon: "https://imglink.cc/cdn/hC_7Jg-pCe.png",
        badge: "https://imglink.cc/cdn/hC_7Jg-pCe.png",
        tag,
        vibrate: [300, 100, 300],
        requireInteraction,
        data: {
            matchId: matchId?.toString() || "",
            type: type || "general",
            url: "/"
        }
    };
}

app.post("/api/fcm/register", (req, res) => {
    const { token, favorites, leagues } = req.body;
    if (token) {
        fcmRegistrations[token] = { 
            favorites: normalizeIdList(favorites), 
            leagues: normalizeIdList(leagues),
            lastUpdated: Date.now() 
        };
        saveRegistrations();
        console.log(`[FCM] Token updated. Matches: ${(favorites||[]).length}, Leagues: ${(leagues||[]).length}`);
        res.json({ success: true });
    } else {
        res.status(400).json({ success: false, message: "Token is required" });
    }
});

app.get("/api/push/public-key", (req, res) => {
    res.json({ success: true, publicKey: VAPID_PUBLIC_KEY });
});

app.post("/api/push/subscribe", (req, res) => {
    const { deviceId, subscription, favorites, leagues, platform, userAgent } = req.body || {};
    if (!deviceId || !subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
        return res.status(400).json({ success: false, message: "deviceId and valid subscription are required" });
    }

    webPushRegistrations[deviceId] = {
        subscription,
        favorites: normalizeIdList(favorites),
        leagues: normalizeIdList(leagues),
        platform: platform || "webpush",
        userAgent: userAgent || "",
        lastUpdated: Date.now()
    };
    saveWebPushRegistrations();
    console.log(`[WebPush] Device updated. Device: ${deviceId}, Matches: ${(favorites || []).length}, Leagues: ${(leagues || []).length}`);
    res.json({ success: true });
});

app.post("/api/push/unsubscribe", (req, res) => {
    const { deviceId } = req.body || {};
    if (!deviceId) {
        return res.status(400).json({ success: false, message: "deviceId is required" });
    }
    delete webPushRegistrations[deviceId];
    saveWebPushRegistrations();
    res.json({ success: true });
});

// Reminder Persistence
const REMINDERS_FILE = "./reminders_sent.json";
let remindersSent = {}; // { token: { matchIdSyncKey: { soon: bool, started: bool } } }

function loadReminders() {
    try {
        if (fs.existsSync(REMINDERS_FILE)) {
            remindersSent = JSON.parse(fs.readFileSync(REMINDERS_FILE, "utf-8"));
            // Clean up old reminders (older than 24h)
            const now = Date.now();
            let changed = false;
            for (const token in remindersSent) {
                for (const syncKey in remindersSent[token]) {
                    if (now - remindersSent[token][syncKey].timestamp > 24 * 60 * 60 * 1000) {
                        delete remindersSent[token][syncKey];
                        changed = true;
                    }
                }
                if (Object.keys(remindersSent[token]).length === 0) delete remindersSent[token];
            }
            if (changed) saveReminders();
        }
    } catch (e) { console.error("[Reminder] Load error:", e.message); }
}

function saveReminders() {
    try {
        fs.writeFileSync(REMINDERS_FILE, JSON.stringify(remindersSent, null, 2));
    } catch (e) { console.error("[Reminder] Save error:", e.message); }
}
loadReminders();

app.get("/api/fcm/recent-notifications", (req, res) => {
    res.json({ success: true, history: serverNotifHistory });
});

app.post("/api/fcm/test-push", async (req, res) => {
    const { token } = req.body;
    if (!token) return res.status(400).json({ success: false, message: "Token required" });
    
    if (!firebaseInitialized) return res.status(500).json({ success: false, message: "Firebase not initialized" });

    const message = {
        notification: {
            title: "Rabona Media",
            body: "Təbriklər! Arxa plan bildirişləri artıq aktivdir."
        },
        data: { type: 'test' },
        android: {
            priority: 'high',
            notification: {
                sound: 'default',
                channelId: 'goal_notifications',
                notificationPriority: 'PRIORITY_MAX'
            }
        },
        webpush: {
            headers: { Urgency: 'high' },
            notification: {
                vibrate: [500, 100, 500],
                icon: 'https://imglink.cc/cdn/hC_7Jg-pCe.png',
                tag: 'test-push',
                renotify: true
            },
            fcm_options: { link: '/' }
        },
        token: token
    };

    try {
        console.log(`[FCM] Sending test push to token: ${token.substring(0, 10)}...`);
        const resp = await admin.messaging().send(message);
        console.log(`[FCM] Test push sent successfully. ID: ${resp}`);
        res.json({ success: true, messageId: resp });
    } catch (e) {
        console.error("[FCM] Test push error:", e);
        res.status(500).json({ success: false, message: e.message });
    }
});

app.post("/api/push/test", async (req, res) => {
    const { deviceId } = req.body || {};
    if (!deviceId) {
        return res.status(400).json({ success: false, message: "deviceId required" });
    }
    if (!webPushRegistrations[deviceId]) {
        return res.status(404).json({ success: false, message: "Device not found" });
    }

    try {
        const payload = createPushPayload({
            title: "Rabona Media",
            body: "Test bildirişi uğurla göndərildi. Arxa plan bildirişləri hazırdır.",
            type: "test",
            tag: `test-${deviceId}`,
            requireInteraction: true
        });
        await sendWebPushMessage(deviceId, payload);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.get("/api/push/status", (req, res) => {
    res.json({
        success: true,
        firebaseInitialized,
        fcmRegistrations: Object.keys(fcmRegistrations).length,
        webPushRegistrations: Object.keys(webPushRegistrations).length,
        lastLiveFetchTime: lastLiveFetchTime ? new Date(lastLiveFetchTime).toISOString() : null
    });
});

app.post("/api/push/broadcast-test", async (req, res) => {
    const title = "Rabona Media Test";
    const body = "Bu test bildirişidir. Sayt açıq olmasa da telefona çatmalıdır.";

    const fcmTokens = Object.keys(fcmRegistrations);
    const webPushDevices = Object.keys(webPushRegistrations);

    let sentFcm = 0;
    let sentWebPush = 0;

    if (firebaseInitialized) {
        for (const token of fcmTokens) {
            try {
                await admin.messaging().send({
                    notification: { title, body },
                    data: { type: "test_broadcast" },
                    token,
                    android: {
                        priority: "high",
                        notification: {
                            sound: "default",
                            channelId: "goal_notifications",
                            notificationPriority: "PRIORITY_MAX"
                        }
                    },
                    apns: { payload: { aps: { sound: "default", badge: 1, contentAvailable: true } } },
                    webpush: {
                        headers: { Urgency: "high" },
                        notification: {
                            icon: "https://imglink.cc/cdn/hC_7Jg-pCe.png",
                            badge: "https://imglink.cc/cdn/hC_7Jg-pCe.png",
                            requireInteraction: true,
                            tag: "broadcast-test"
                        },
                        fcm_options: { link: "/" }
                    }
                });
                sentFcm++;
            } catch (err) {
                if (err.code === "messaging/registration-token-not-registered") {
                    delete fcmRegistrations[token];
                }
            }
        }
        saveRegistrations();
    }

    for (const deviceId of webPushDevices) {
        const ok = await sendWebPushMessage(deviceId, createPushPayload({
            title,
            body,
            type: "test_broadcast",
            tag: `broadcast-${deviceId}`,
            requireInteraction: true
        }));
        if (ok) sentWebPush++;
    }

    res.json({
        success: true,
        sentFcm,
        sentWebPush,
        totalTargets: fcmTokens.length + webPushDevices.length
    });
});

// YENI YOXLANIS UCUN (KÆNAR VASÄ°TÆ)
// Bu linkÉ™ kompÃ¼terdÉ™n girdiyinizdÉ™ BÃœTÃœN qeydiyyatdan keÃ§miÅŸ cihazlara (o cÃ¼mlÉ™dÉ™n baÄŸlÄ± olan iPhone-a) bildiriÅŸ gÃ¶ndÉ™rÉ™cÉ™k
app.get("/api/fcm/broadcast-test", async (req, res) => {
    if (!firebaseInitialized) return res.status(500).send("Firebase qoşulmayıb");
    
    const tokens = Object.keys(fcmRegistrations);
    if (tokens.length === 0) return res.send("Heç bir cihaz qeydiyyatda deyil.");

    const message = {
        notification: {
            title: "Xüsusi Test Bildirişi",
            body: "Əgər tətbiq tam bağlıdırsa və bu bildiriş gəlirsə, hər şey əla işləyir!"
        },
        data: { type: 'test' },
        android: {
            priority: 'high',
            notification: { sound: 'default', channelId: 'goal_notifications' }
        },
        webpush: {
            headers: { Urgency: 'high' },
            notification: {
                vibrate: [500, 100, 500],
                icon: 'https://imglink.cc/cdn/hC_7Jg-pCe.png',
                tag: 'broadcast-test',
                renotify: true
            },
            fcm_options: { link: '/' }
        }
    };

    try {
        let sentCount = 0;
        for (const token of tokens) {
            try {
                await admin.messaging().send({ ...message, token });
                sentCount++;
            } catch (err) {
                if (err.code === 'messaging/registration-token-not-registered') delete fcmRegistrations[token];
            }
        }
        res.send(`<h1>Uğurlu!</h1><p>${sentCount} cihaza bildiriş göndərildi.</p><p>İndi iPhone-unuzu yoxlayın.</p>`);
    } catch (e) {
        res.status(500).send("Xəta baş verdi: " + e.message);
    }
});

// Background Worker for Live Matches Push Notifications
setInterval(async () => {
    try {
        const liveData = await getLiveEventsData(true);
        if (!liveData || !Array.isArray(liveData.events)) return;

        if (Object.keys(fcmRegistrations).length === 0 && Object.keys(webPushRegistrations).length === 0) return;
        
        const events = liveData.events;
        
        events.forEach(ev => {
            const matchId = ev.id.toString();
            const hs = ev.homeScore?.current || 0;
            const as = ev.awayScore?.current || 0;
            const leagueId = (ev.tournament.uniqueTournament?.id || ev.tournament.id).toString();
            const prev = lastScores[matchId];
            
            if (prev) {
                if (hs > prev.homeScore || as > prev.awayScore) {
                    const scoreMarker = `score-${hs}-${as}`;
                    if (hasRecentGoalNotification(matchId, scoreMarker, 90 * 1000)) {
                        lastScores[matchId] = { homeScore: hs, awayScore: as };
                        return;
                    }
                    const title = `Rabona Media`;
                    const body = `${ev.homeTeam.name} ${hs} - ${as} ${ev.awayTeam.name}. Qol vuruldu.`;
                    
                    console.log(`[GOAL] ${ev.homeTeam.name} - ${ev.awayTeam.name} GOOOL!`);

                    // Add to server history
                    const notifObj = {
                        id: Date.now(),
                        type: 'goal',
                        title,
                        body,
                        matchId: ev.id,
                        leagueId: leagueId,
                        time: new Date().toLocaleTimeString('az-AZ', { hour: '2-digit', minute: '2-digit' })
                    };
                    serverNotifHistory.unshift(notifObj);
                    if (serverNotifHistory.length > 50) serverNotifHistory.pop();
                    saveNotifHistory();

                    const recipients = collectFavoriteRecipients(matchId, leagueId);
                    const fcmRecipients = recipients.filter(r => r.channel === "fcm");
                    const webPushRecipients = recipients.filter(r => r.channel === "webpush");

                    if (fcmRecipients.length > 0 && firebaseInitialized) {
                        const message = {
                            notification: { title, body },
                            data: { matchId: matchId, type: 'goal' },
                            android: { 
                                priority: 'high',
                                notification: { sound: 'default', channelId: 'goal_notifications' } 
                            },
                            webpush: { 
                                headers: { Urgency: 'high' },
                                notification: { 
                                    vibrate: [500, 110, 500], 
                                    icon: 'https://imglink.cc/cdn/hC_7Jg-pCe.png',
                                    badge: 'https://imglink.cc/cdn/hC_7Jg-pCe.png',
                                    tag: `goal-${matchId}`,
                                    renotify: true
                                },
                                fcm_options: { link: '/' }
                            }
                        };
                        
                        fcmRecipients.forEach(({ id: token }) => {
                            admin.messaging().send({ ...message, token })
                                .catch(err => {
                                    if (err.code === 'messaging/registration-token-not-registered') delete fcmRegistrations[token];
                                });
                        });
                    }

                    if (webPushRecipients.length > 0) {
                        const payload = createPushPayload({
                            title,
                            body,
                            matchId,
                            type: "goal",
                            tag: `goal-${matchId}`,
                            requireInteraction: true
                        });
                        webPushRecipients.forEach(({ id: deviceId }) => {
                            sendWebPushMessage(deviceId, payload);
                        });
                    }

                    markGoalNotification(matchId, scoreMarker);
                }
            }
            lastScores[matchId] = { homeScore: hs, awayScore: as };
        });
    } catch (e) {
        console.error("[Background Tracker] Error:", e.message);
    }
}, 5000);

setInterval(async () => {
    try {
        const favoriteMatchIds = new Set();

        Object.values(fcmRegistrations).forEach(reg => {
            normalizeIdList(reg?.favorites).forEach(id => favoriteMatchIds.add(id.toString()));
        });
        Object.values(webPushRegistrations).forEach(reg => {
            normalizeIdList(reg?.favorites).forEach(id => favoriteMatchIds.add(id.toString()));
        });

        if (favoriteMatchIds.size === 0) return;

        const liveData = await getLiveEventsData(true);
        if (!liveData?.events?.length) return;

        const favoriteLiveMatches = liveData.events.filter(ev =>
            favoriteMatchIds.has(ev.id?.toString()) &&
            (ev.status?.type === "inprogress" || ["HT", "HALFTIME", "EXTRA TIME", "ET"].includes((ev.status?.description || "").toUpperCase()))
        );

        for (const ev of favoriteLiveMatches) {
            const matchId = ev.id.toString();
            const leagueId = (ev.tournament?.uniqueTournament?.id || ev.tournament?.id || "").toString();

            let incidentsData = null;
            try {
                incidentsData = await getMatchIncidentsData(matchId);
            } catch (e) {
                console.warn(`[Goal Incidents] ${matchId} incidents unavailable: ${e.message}`);
                continue;
            }

            const goalIncidents = extractGoalIncidents(incidentsData);
            const goalKeys = goalIncidents.map(buildGoalIncidentKey);

            if (!liveGoalIncidentState[matchId]) {
                liveGoalIncidentState[matchId] = new Set(goalKeys);
                continue;
            }

            const knownKeys = liveGoalIncidentState[matchId];
            const newGoalIncidents = goalIncidents.filter(incident => !knownKeys.has(buildGoalIncidentKey(incident)));

            goalKeys.forEach(key => knownKeys.add(key));
            if (newGoalIncidents.length === 0) continue;

            const recipients = collectFavoriteRecipients(matchId, leagueId);
            if (recipients.length === 0) continue;

            for (const incident of newGoalIncidents) {
                const incidentKey = buildGoalIncidentKey(incident);
                if (hasRecentGoalNotification(matchId, incidentKey)) continue;

                const scorerName =
                    incident.playerName ||
                    incident.player?.name ||
                    incident.player?.shortName ||
                    incident.playerIn?.name ||
                    "Oyunçu";
                const minuteText = incident.time ? `${incident.time}'` : "Canlı";
                const goalLabel =
                    incident.incidentClass === "ownGoal" ? "Avtoqol" :
                    incident.incidentClass === "penalty" ? "Penaltidən qol" :
                    "Qol";
                const title = "Rabona Media";
                const body = `${minuteText} ${goalLabel}: ${scorerName}. ${ev.homeTeam.name} ${ev.homeScore?.current || 0} - ${ev.awayScore?.current || 0} ${ev.awayTeam.name}`;

                const fcmRecipients = recipients.filter(r => r.channel === "fcm");
                const webPushRecipients = recipients.filter(r => r.channel === "webpush");

                if (fcmRecipients.length > 0 && firebaseInitialized) {
                    const message = {
                        notification: { title, body },
                        data: { matchId, type: "goal" },
                        android: {
                            priority: "high",
                            notification: { sound: "default", channelId: "goal_notifications" }
                        },
                        apns: { payload: { aps: { sound: "default", badge: 1, contentAvailable: true } } },
                        webpush: {
                            headers: { Urgency: "high" },
                            notification: {
                                vibrate: [500, 110, 500],
                                icon: "https://imglink.cc/cdn/hC_7Jg-pCe.png",
                                badge: "https://imglink.cc/cdn/hC_7Jg-pCe.png",
                                tag: `goal-${matchId}-${incident.time || "live"}`,
                                renotify: true
                            },
                            fcm_options: { link: "/" }
                        }
                    };

                    fcmRecipients.forEach(({ id: token }) => {
                        admin.messaging().send({ ...message, token }).catch(err => {
                            if (err.code === "messaging/registration-token-not-registered") {
                                delete fcmRegistrations[token];
                            }
                        });
                    });
                }

                if (webPushRecipients.length > 0) {
                    const payload = createPushPayload({
                        title,
                        body,
                        matchId,
                        type: "goal",
                        tag: `goal-${matchId}-${incident.time || "live"}`,
                        requireInteraction: true
                    });
                    webPushRecipients.forEach(({ id: deviceId }) => {
                        sendWebPushMessage(deviceId, payload);
                    });
                }

                markGoalNotification(matchId, incidentKey);
            }
        }

        pruneGoalNotificationState();
    } catch (e) {
        console.error("[Goal Incident Worker] Error:", e.message);
    }
}, 12000);

async function sendReminderToRecipient(recipient, payload) {
    if (recipient.channel === "fcm") {
        if (!firebaseInitialized) return false;
        try {
            await admin.messaging().send({
                notification: { title: payload.title, body: payload.body },
                data: { matchId: payload.matchId.toString(), type: payload.type },
                token: recipient.id,
                android: {
                    priority: "high",
                    notification: {
                        sound: "default",
                        channelId: "goal_notifications",
                        notificationPriority: "PRIORITY_MAX"
                    }
                },
                apns: { payload: { aps: { sound: "default", badge: 1, contentAvailable: true } } },
                webpush: {
                    headers: { Urgency: "high" },
                    notification: {
                        icon: "https://imglink.cc/cdn/hC_7Jg-pCe.png",
                        badge: "https://imglink.cc/cdn/hC_7Jg-pCe.png",
                        requireInteraction: true,
                        tag: payload.tag
                    },
                    fcm_options: { link: "/" }
                }
            });
            return true;
        } catch (err) {
            if (err.code === "messaging/registration-token-not-registered") {
                delete fcmRegistrations[recipient.id];
                saveRegistrations();
            }
            console.error("[Reminder][FCM] Send error:", err.message);
            return false;
        }
    }

    return sendWebPushMessage(recipient.id, createPushPayload({
        title: payload.title,
        body: payload.body,
        matchId: payload.matchId,
        type: payload.type,
        tag: payload.tag,
        requireInteraction: true
    }));
}

// --- Reminder Worker for Upcoming Favorited Matches ---
setInterval(async () => {
    if (Object.keys(fcmRegistrations).length === 0 && Object.keys(webPushRegistrations).length === 0) return;

    try {
        const todayStr = new Date().toISOString().split('T')[0];
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        const tomorrowStr = tomorrow.toISOString().split('T')[0];

        const [resToday, resTomorrow] = await Promise.all([
            fetchFromSofa(`/sport/football/scheduled-events/${todayStr}`).catch(() => null),
            fetchFromSofa(`/sport/football/scheduled-events/${tomorrowStr}`).catch(() => null)
        ]);

        const allUpcomingEvents = [
            ...(resToday?.data?.events || []),
            ...(resTomorrow?.data?.events || [])
        ];

        if (allUpcomingEvents.length === 0) return;

        const nowSec = Math.floor(Date.now() / 1000);
        const recipients = [
            ...Object.entries(fcmRegistrations).map(([id, reg]) => ({ channel: "fcm", id, reg })),
            ...Object.entries(webPushRegistrations).map(([id, reg]) => ({ channel: "webpush", id, reg }))
        ];

        for (const recipient of recipients) {
            const favorites = normalizeIdList(recipient.reg?.favorites);
            if (favorites.length === 0) continue;

            for (const favId of favorites) {
                const match = allUpcomingEvents.find(ev => ev.id.toString() === favId.toString());
                if (!match?.startTimestamp) continue;

                const timeUntilStart = match.startTimestamp - nowSec;
                const reminderKey = `${recipient.channel}:${recipient.id}`;

                if (!remindersSent[reminderKey]) remindersSent[reminderKey] = {};
                if (!remindersSent[reminderKey][favId]) remindersSent[reminderKey][favId] = { timestamp: Date.now() };

                const state = remindersSent[reminderKey][favId];

                if (timeUntilStart > 0 && timeUntilStart <= 40 * 60 && timeUntilStart >= 20 * 60 && !state.soon) {
                    const sent = await sendReminderToRecipient(recipient, {
                        title: `Xatırlatma: ${match.homeTeam.name} - ${match.awayTeam.name}`,
                        body: "Oyunun başlamasına təxminən 30 dəqiqə qaldı.",
                        matchId: favId,
                        type: "reminder_soon",
                        tag: `soon-${favId}`
                    });
                    if (sent) {
                        state.soon = true;
                        state.timestamp = Date.now();
                        saveReminders();
                    }
                }

                const isStarted = match.status?.type === "inprogress" || (timeUntilStart <= 0 && timeUntilStart >= -600);
                if (isStarted && !state.started) {
                    const sent = await sendReminderToRecipient(recipient, {
                        title: "Oyun başladı",
                        body: `${match.homeTeam.name} - ${match.awayTeam.name} oyunu başladı.`,
                        matchId: favId,
                        type: "reminder_started",
                        tag: `started-${favId}`
                    });
                    if (sent) {
                        state.started = true;
                        state.timestamp = Date.now();
                        saveReminders();
                    }
                }
            }
        }
    } catch (e) {
        console.error("[Reminder Worker] Error:", e.name, e.message);
    }
}, 60 * 1000);

async function warmRuntimeCaches() {
    try {
        warmLeagueImages(14).catch(e => {
            console.warn("[Warmup] League image prefetch failed:", e.message);
        });
        await getLiveEventsData(true);
        const todayStr = new Date().toISOString().split('T')[0];
        await getCachedData(`matches_${todayStr}`, async () => {
            const result = await fetchFromSofa(`/sport/football/scheduled-events/${todayStr}`);
            return result.data;
        }, 10 * 1000);
        warmOneLeagueStanding().catch(e => {
            console.warn("[Warmup] Standing prefetch failed:", e.message);
        });
    } catch (e) {
        console.warn("[Warmup] Cache prefetch failed:", e.message);
    }
}

async function warmOneLeagueStanding() {
    if (!FALLBACK_TOP_LEAGUES.length) return;
    const warmableLeagues = FALLBACK_TOP_LEAGUES.filter(league => ESPN_STANDINGS_LEAGUES[league.id] || KNOWN_CURRENT_SEASONS[league.id]);
    if (!warmableLeagues.length) return;

    const league = warmableLeagues[standingsWarmIndex % warmableLeagues.length];
    standingsWarmIndex++;

    const existing = Object.keys(cache).some(key =>
        key.startsWith(`standings_${league.id}_`) &&
        cache[key]?.data?.standings?.length &&
        Date.now() - cache[key].timestamp < CACHE_TIMES.STATIC
    );
    if (existing) return;

    console.log(`[Warmup] Prefetch standings for ${league.name} (${league.id})`);
    const seasonId = KNOWN_CURRENT_SEASONS[league.id];
    if (ESPN_STANDINGS_LEAGUES[league.id]) {
        const espnKey = `standings_${league.id}_espn`;
        const data = await getCachedData(espnKey, async () => {
            return await fetchEspnStandings(league.id);
        }, 30 * 60 * 1000);
        if (data?.standings?.length) saveStandingSnapshot(espnKey, data);
        return;
    }

    if (!seasonId) return;

    const standingsKey = `standings_${league.id}_${seasonId}`;
    const data = await getCachedData(standingsKey, async () => {
        return await fetchFromSofaFastRace(`/unique-tournament/${league.id}/season/${seasonId}/standings/total`, {}, 7000);
    }, CACHE_TIMES.STATIC);
    if (data?.standings?.length) saveStandingSnapshot(standingsKey, data);
}

app.get("/api/keepalive", async (req, res) => {
    res.json({
        status: "alive",
        warmed: false,
        warmingInBackground: true,
        liveEvents: globalLiveEvents?.events?.length || 0,
        liveTimestamp: lastLiveFetchTime ? new Date(lastLiveFetchTime).toISOString() : null,
        timestamp: new Date().toISOString()
    });

    warmRuntimeCaches().catch(e => {
        console.warn("[Keep-Alive] Background warmup failed:", e.message);
    });
});

app.get("/api/ping", (req, res) => {
    res.json({ status: "alive", version: "v7", timestamp: new Date().toISOString() });
});

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server ${PORT} portunda aktivdir.`);
    warmLeagueImages(30).catch(e => {
        console.warn("[Warmup] Initial league image prefetch failed:", e.message);
    });
    warmRuntimeCaches();
    setInterval(warmRuntimeCaches, 8 * 1000);
    setInterval(() => warmLeagueImages(16).catch(e => {
        console.warn("[Warmup] League image interval failed:", e.message);
    }), 30 * 1000);

    // â”€â”€â”€ RENDER KEEP-ALIVE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // Render free plan serveri 15 dÉ™qiqÉ™lik hÉ™rÉ™kÉ™tsizlikdÉ™n sonra yuxuya gÃ¶ndÉ™rir.
    // Bu interval hÉ™r 10 dÉ™qiqÉ™dÉ™ bir Ã¶zÃ¼nÉ™ sorÄŸu vurur - serveri daima ayaq Ã¼stÃ¼ndÉ™ saxlayÄ±r.
    // RENDER_EXTERNAL_URL mÃ¼hit dÉ™yiÅŸÉ™ni Render tÉ™rÉ™findÉ™n avtomatik tÉ™yin edilir.
    const getSelfUrl = () => {
        if (process.env.RENDER_EXTERNAL_URL) return process.env.RENDER_EXTERNAL_URL;
        if (process.env.RENDER_SERVICE_NAME) return `https://${process.env.RENDER_SERVICE_NAME}.onrender.com`;
        return detectedHostUrl;
    };

    setInterval(async () => {
        const targetUrl = getSelfUrl();
        if (!targetUrl || !targetUrl.startsWith('http')) return;

        try { await axios.get(`${targetUrl}/api/ping?t=${Date.now()}`, { timeout: 10000 }); } catch(e) {}

        try {
            const fallbackUrls = [
                `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(targetUrl + '/api/ping?proxy=1&t=' + Date.now())}`,
                `https://crossorigin.me/${targetUrl}/api/ping?proxy=2&t=${Date.now()}`,
                `https://yacdn.org/proxy/${targetUrl}/api/ping?proxy=3&t=${Date.now()}`
            ];
            const proxyUrl = fallbackUrls[Math.floor(Math.random() * fallbackUrls.length)];
            await axios.get(proxyUrl, { timeout: 15000 });
            console.log(`[Keep-Alive] External proxy ping OK via ${proxyUrl.split('/')[2]} to prevent Render sleep`);
        } catch(e) {}
    }, 3 * 60 * 1000); // 3 minutes strictly prevents Render sleep
    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
});


