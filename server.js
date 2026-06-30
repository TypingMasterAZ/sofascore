const express = require("express");
// ─── OneSignal: qol bildirisi funksiyasi ─────────────────────────────────────
async function sendGoalNotification() {
    try {
        await axios.post('https://onesignal.com/api/v1/notifications', {
            app_id: "9f13e700-01e4-4259-9747-c9140e93d657",
            included_segments: ["All"],
            contents: { en: "GOOOL! RabonaMedia-da hesab deyisdi!" },
            headings: { en: "QOL! \u26bd" }
        }, {
            headers: {
                "Authorization": "Basic os_v2_app_t4j6oaab4rbftf2hzeka5e6wk4tmvph2ctmulunlpfzz443esiz3nulrekzb7qfawwpxacelfwzwhp6bbfwcyzzwkhrioqu75qipotq",
                "Content-Type": "application/json"
            }
        });
        console.log("[OneSignal] sendGoalNotification: Bildirish gonderildi!");
    } catch (error) {
        console.error("[OneSignal] sendGoalNotification xetasi:", error.response ? JSON.stringify(error.response.data) : error.message);
    }
}
// ─────────────────────────────────────────────────────────────────────────────
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
// -------------------------------------------------------------------
// Realâ€‘time cache and SSE infrastructure
// -------------------------------------------------------------------
let matchCache = {};
let matchDetailsCache = {};
let sseListeners = [];

// Helper to notify SSE listeners about an updated match
function notifySseListeners(updatedMatch) {
  const matchId = String(updatedMatch.id);
  const fullPayload = {
      ...updatedMatch,
      details: matchDetailsCache[matchId] || null
  };
  sseListeners
    .filter(l => String(l.id) === matchId)
    .forEach(l => l.fn(fullPayload));
}

async function fetchMatchDetailsFromServer(id) {
    try {
        const cachedMatch = matchCache[String(id)];
        if (String(cachedMatch?.source || "").toLowerCase().includes("mackolik")) {
            return await fetchMackolikMatchDetails(id, cachedMatch?.slug || "", { fast: true });
        }
        if (String(cachedMatch?.source || "").toLowerCase() === "flashscore") {
            return {
                incidents: buildSyntheticIncidentsFromScore(cachedMatch),
                stats: { statistics: [] }
            };
        }

        const [incidents, stats] = await Promise.all([
            Promise.any([
                fetchFromSofaApiDirect(`/event/${id}/incidents`, {}, 2200),
                fetchFromSofaNativeFast(`/event/${id}/incidents`, {}, 2600),
                fetchFromSofaFastRace(`/event/${id}/incidents`, {}, 4200)
            ]).catch(() => ({ incidents: [] })),
            Promise.any([
                fetchFromSofaApiDirect(`/event/${id}/statistics`, {}, 1400),
                fetchFromSofaNativeFast(`/event/${id}/statistics`, {}, 1800),
                fetchFromSofaFastRace(`/event/${id}/statistics`, {}, 2800)
            ]).catch(() => ({ statistics: [] }))
        ]);
        return {
            incidents: normalizeIncidentsData(incidents) || { incidents: [] },
            stats: normalizeStatisticsData(stats)
        };
    } catch (e) {
        console.error(`[DETAILS-FETCH] Error for ${id}:`, e.message);
        return null;
    }
}

function hasUsefulIncidentData(data) {
    const payload = normalizeIncidentsData(data);
    return Array.isArray(payload?.incidents) &&
        payload.incidents.some(incident => {
            const type = String(incident?.incidentType || incident?.type || "").toLowerCase();
            const cls = String(incident?.incidentClass || incident?.class || incident?.subType || "").toLowerCase();
            const reason = String(incident?.reason || incident?.text || incident?.description || "").toLowerCase();
            return ["goal", "card", "substitution"].includes(incident?.incidentType) ||
                type.includes("penalty") ||
                cls.includes("penalty") ||
                reason.includes("penalty");
        });
}

function matchHasAnyGoalScore(match) {
    const home = Number(match?.homeScore?.current ?? match?.homeScore?.display ?? match?.homeScore ?? 0);
    const away = Number(match?.awayScore?.current ?? match?.awayScore?.display ?? match?.awayScore ?? 0);
    return (Number.isFinite(home) ? home : 0) + (Number.isFinite(away) ? away : 0) > 0;
}

let matchDetailsDiskSaveTimer = null;

function pruneMatchDetailsCacheForDisk() {
    const now = Date.now();
    Object.keys(matchDetailsCache).forEach(matchId => {
        const entry = matchDetailsCache[matchId];
        if (!entry?.updatedAt || now - entry.updatedAt > MATCH_DETAILS_DISK_MAX_AGE) {
            delete matchDetailsCache[matchId];
        }
    });
    const entries = Object.entries(matchDetailsCache)
        .sort((a, b) => (b[1]?.updatedAt || 0) - (a[1]?.updatedAt || 0));
    entries.slice(MATCH_DETAILS_DISK_MAX_ITEMS).forEach(([matchId]) => {
        delete matchDetailsCache[matchId];
    });
}

function saveMatchDetailsCacheToDiskSoon() {
    if (matchDetailsDiskSaveTimer) return;
    matchDetailsDiskSaveTimer = setTimeout(() => {
        matchDetailsDiskSaveTimer = null;
        try {
            pruneMatchDetailsCacheForDisk();
            fs.writeFileSync(MATCH_DETAILS_CACHE_FILE, JSON.stringify(matchDetailsCache, null, 2));
        } catch (error) {
            console.warn("[DETAILS-CACHE] Disk save failed:", error.message);
        }
    }, 900);
}

function loadMatchDetailsCacheFromDisk() {
    try {
        if (!fs.existsSync(MATCH_DETAILS_CACHE_FILE)) return;
        const parsed = JSON.parse(fs.readFileSync(MATCH_DETAILS_CACHE_FILE, "utf8"));
        if (!parsed || typeof parsed !== "object") return;
        const now = Date.now();
        let loaded = 0;
        Object.entries(parsed).forEach(([matchId, entry]) => {
            if (!entry?.updatedAt || now - entry.updatedAt > MATCH_DETAILS_DISK_MAX_AGE) return;
            const incidents = normalizeIncidentsData(entry.incidents) || { incidents: [] };
            const stats = normalizeStatisticsData(entry.stats || { statistics: [] });
            if (!hasUsefulIncidentData(incidents) && !hasUsefulStatsData(stats)) return;
            matchDetailsCache[matchId] = {
                incidents,
                stats,
                updatedAt: entry.updatedAt,
                source: entry.source || "disk"
            };
            cache[`incidents_${matchId}`] = { data: incidents, timestamp: entry.updatedAt };
            cache[`stats_${matchId}`] = { data: stats, timestamp: entry.updatedAt };
            loaded++;
        });
        console.log(`[DETAILS-CACHE] Loaded ${loaded} match details from disk.`);
    } catch (error) {
        console.warn("[DETAILS-CACHE] Disk load failed:", error.message);
    }
}

function buildSyntheticIncidentsFromScore(match) {
    if (!matchHasAnyGoalScore(match)) return { incidents: [] };
    const homeGoals = Number(match?.homeScore?.current ?? match?.homeScore?.display ?? 0) || 0;
    const awayGoals = Number(match?.awayScore?.current ?? match?.awayScore?.display ?? 0) || 0;
    const minute = String(match?.status?.description || "").match(/\d+/)?.[0];
    const incidents = [];
    if (homeGoals > 0) {
        incidents.push({
            id: `${match.id}-home-score-summary`,
            incidentType: "goal",
            incidentClass: "regular",
            time: minute ? Number(minute) : undefined,
            isHome: true,
            playerName: match.homeTeam?.name || "Home",
            text: homeGoals === 1 ? "1 goal recorded" : `${homeGoals} goals recorded`,
            synthetic: true
        });
    }
    if (awayGoals > 0) {
        incidents.push({
            id: `${match.id}-away-score-summary`,
            incidentType: "goal",
            incidentClass: "regular",
            time: minute ? Number(minute) : undefined,
            isHome: false,
            playerName: match.awayTeam?.name || "Away",
            text: awayGoals === 1 ? "1 goal recorded" : `${awayGoals} goals recorded`,
            synthetic: true
        });
    }
    return { incidents, synthetic: true, source: "score-summary" };
}

function storeMatchDetailsCache(id, details = {}, source = "server") {
    const matchId = String(id || "");
    if (!matchId) return null;

    const existing = matchDetailsCache[matchId] || {};
    const nextIncidents = normalizeIncidentsData(details.incidents) || { incidents: [] };
    const nextStats = normalizeStatisticsData(details.stats);
    const incidents = hasUsefulIncidentData(nextIncidents)
        ? nextIncidents
        : (hasUsefulIncidentData(existing.incidents) ? existing.incidents : nextIncidents);
    const stats = hasUsefulStatsData(nextStats)
        ? nextStats
        : (hasUsefulStatsData(existing.stats) ? existing.stats : nextStats);

    const updatedAt = Date.now();
    const stored = {
        incidents,
        stats,
        updatedAt,
        source
    };

    matchDetailsCache[matchId] = stored;
    if (hasUsefulIncidentData(incidents)) cache[`incidents_${matchId}`] = { data: incidents, timestamp: updatedAt };
    if (hasUsefulStatsData(stats)) cache[`stats_${matchId}`] = { data: stats, timestamp: updatedAt };
    if (hasUsefulIncidentData(incidents) || hasUsefulStatsData(stats)) {
        saveMatchDetailsCacheToDiskSoon();
    }

    const match = matchCache[matchId];
    if (match) {
        notifySseListeners({ ...match, details: stored });
    }
    return stored;
}

async function refreshMatchDetails(id) {
    const details = await fetchMatchDetailsFromServer(id);
    if (details) {
        storeMatchDetailsCache(id, details, "server-warm");
        console.log(`[DETAILS-CACHE] Updated for match ${id}`);
    }
}

const fs = require("fs");
const nodemailer = require("nodemailer");
const admin = require("firebase-admin");
const webpush = require("web-push");

process.on("unhandledRejection", (reason) => {
    const message = reason?.stack || reason?.message || String(reason);
    console.error("[PROCESS] Unhandled rejection kept server alive:", message);
});

process.on("uncaughtException", (error) => {
    console.error("[PROCESS] Uncaught exception kept server alive:", error?.stack || error?.message || error);
});

const KEEPALIVE_ENABLED = process.env.KEEPALIVE_ENABLED !== "false";
const ALWAYS_ON_ENABLED = process.env.ALWAYS_ON_ENABLED !== "false";
const RUNTIME_WARMUP_INTERVAL_MS = Math.max(10000, Number(process.env.RUNTIME_WARMUP_INTERVAL_MS) || 15000);
const SELF_PING_INTERVAL_MS = Math.max(25000, Number(process.env.SELF_PING_INTERVAL_MS) || 30000);
const CATEGORY_WARMUP_INTERVAL_MS = Math.max(60000, Number(process.env.CATEGORY_WARMUP_INTERVAL_MS) || 2 * 60 * 1000);
const BACKGROUND_REFRESH_INTERVAL_MS = Math.max(3000, Number(process.env.BACKGROUND_REFRESH_INTERVAL_MS) || 5000);

// Firebase Admin SDK-nÃ„Â±n yaradÃ„Â±lmasÃ„Â±
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

// Render Secret File dÃ‰â„¢stÃ‰â„¢yi
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
  console.warn("[WARNING] Firebase Admin SDK not initialized. FCM push disabled; Web Push remains available.");
}

const DEFAULT_VAPID_KEYS = {
  publicKey: "BHWOOLhZ6kHIPynDRpEilL9L7SMfwz0p9fWu0NLeZSIQCx2ffdlNwgLILQiA-d22Fy_SLPP-kTMa5AFo0YinhWM",
  privateKey: "XgT1SE-DUDLvp_IQsr60Qd_15fIau4OhXiu8zaGAAc8"
};
const ENV_VAPID_PUBLIC_KEY = String(process.env.WEB_PUSH_PUBLIC_KEY || "").trim();
const ENV_VAPID_PRIVATE_KEY = String(process.env.WEB_PUSH_PRIVATE_KEY || "").trim();
const HAS_COMPLETE_ENV_VAPID_PAIR = !!ENV_VAPID_PUBLIC_KEY && !!ENV_VAPID_PRIVATE_KEY;
if (!!ENV_VAPID_PUBLIC_KEY !== !!ENV_VAPID_PRIVATE_KEY) {
  console.warn("[WebPush] WEB_PUSH_PUBLIC_KEY and WEB_PUSH_PRIVATE_KEY must be set together. Falling back to bundled pair.");
}
const VAPID_PUBLIC_KEY = HAS_COMPLETE_ENV_VAPID_PAIR ? ENV_VAPID_PUBLIC_KEY : DEFAULT_VAPID_KEYS.publicKey;
const VAPID_PRIVATE_KEY = HAS_COMPLETE_ENV_VAPID_PAIR ? ENV_VAPID_PRIVATE_KEY : DEFAULT_VAPID_KEYS.privateKey;
const VAPID_KEY_SOURCE = HAS_COMPLETE_ENV_VAPID_PAIR ? "env-pair" : "bundled-pair";
const VAPID_SUBJECT = process.env.WEB_PUSH_SUBJECT || "mailto:support@rabonamedia.app";

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ FIRESTORE USER HELPERS Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
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

function getUserDocKey(userData) {
    return (userData.uid || userData.email || userData.username || String(userData.id || Date.now())).replace(/[^a-zA-Z0-9_\-]/g, '_');
}

const PROFILE_FILE = "./profiles.json";

function getProfileKeys({ email, uid }) {
    const normalizedEmail = String(email || "").trim().toLowerCase();
    const keys = [];
    if (uid) keys.push(`uid_${String(uid).replace(/[^a-zA-Z0-9_\-]/g, '_')}`);
    if (normalizedEmail) keys.push(`email_${normalizedEmail.replace(/[^a-zA-Z0-9_\-]/g, '_')}`);
    return keys;
}

async function saveProfileRecord(profile) {
    const normalizedEmail = String(profile.email || "").trim().toLowerCase();
    const cleanProfile = {
        uid: profile.uid || "",
        email: normalizedEmail,
        displayName: String(profile.displayName || "").trim(),
        status: profile.status || "Rabona Media istifadÉ™Ã§isi",
        profilePic: profile.profilePic || "",
        updatedAt: profile.updatedAt || new Date().toISOString()
    };
    const keys = getProfileKeys(cleanProfile);
    if (db) {
        try {
            await Promise.all(keys.map(key => db.collection('profiles').doc(key).set(cleanProfile, { merge: true })));
            return cleanProfile;
        } catch (e) {
            console.error("[Firestore] saveProfileRecord error:", e.message);
        }
    }
    let profiles = {};
    if (fs.existsSync(PROFILE_FILE)) {
        try { profiles = JSON.parse(fs.readFileSync(PROFILE_FILE, "utf-8")); } catch(e) {}
    }
    keys.forEach(key => { profiles[key] = { ...(profiles[key] || {}), ...cleanProfile }; });
    fs.writeFileSync(PROFILE_FILE, JSON.stringify(profiles, null, 2));
    return cleanProfile;
}

async function getProfileRecord({ email, uid }) {
    const keys = getProfileKeys({ email, uid });
    if (db) {
        try {
            for (const key of keys) {
                const doc = await db.collection('profiles').doc(key).get();
                if (doc.exists) return doc.data();
            }
        } catch (e) {
            console.error("[Firestore] getProfileRecord error:", e.message);
        }
    }
    if (fs.existsSync(PROFILE_FILE)) {
        try {
            const profiles = JSON.parse(fs.readFileSync(PROFILE_FILE, "utf-8"));
            for (const key of keys) {
                if (profiles[key]) return profiles[key];
            }
        } catch(e) {}
    }
    return null;
}

async function saveUser(userData) {
    const key = getUserDocKey(userData);
    if (db) {
        try { await db.collection('users').doc(key).set(userData, { merge: true }); return; }
        catch (e) { console.error("[Firestore] saveUser error:", e.message); }
    }
    let users = [];
    if (fs.existsSync("./users.json")) {
        try { users = JSON.parse(fs.readFileSync("./users.json", "utf-8")); } catch(e) {}
    }
    const idx = users.findIndex(u => {
        if (userData.uid && u.uid === userData.uid) return true;
        if (userData.email && String(u.email || "").trim().toLowerCase() === String(userData.email).trim().toLowerCase()) return true;
        return !userData.email && !userData.uid && u.username === userData.username;
    });
    if (idx !== -1) users[idx] = { ...users[idx], ...userData };
    else users.push(userData);
    fs.writeFileSync("./users.json", JSON.stringify(users, null, 2));
}

async function getUserByEmail(email) {
    return getUserByIdentity({ email });
}

async function getAuthUserFromRequest(req) {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!token || !firebaseInitialized) return null;
    try {
        return await admin.auth().verifyIdToken(token);
    } catch (e) {
        console.warn("[AUTH] ID token verify failed:", e.message);
        return null;
    }
}

async function getUserByIdentity({ email, uid }) {
    const rawEmail = String(email || "").trim();
    const normalizedEmail = String(email || "").trim().toLowerCase();
    if (db) {
        try {
            if (uid) {
                const byUid = await db.collection('users').doc(getUserDocKey({ uid })).get();
                if (byUid.exists) return byUid.data();
            }
            const direct = await db.collection('users').doc(getUserDocKey({ email: normalizedEmail })).get();
            if (direct.exists) return direct.data();
            const snap = await db.collection('users').where('email', '==', normalizedEmail).get();
            if (!snap.empty) {
                return snap.docs
                    .map(d => d.data())
                    .sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0))[0];
            }
            if (rawEmail && rawEmail !== normalizedEmail) {
                const rawSnap = await db.collection('users').where('email', '==', rawEmail).get();
                if (!rawSnap.empty) {
                    return rawSnap.docs
                        .map(d => d.data())
                        .sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0))[0];
                }
            }
        } catch (e) { console.error("[Firestore] getUserByEmail error:", e.message); }
    }
    const users = await getUsers();
    return users.find(u => String(u.email || "").trim().toLowerCase() === normalizedEmail) || null;
}
// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

// Nodemailer TÃ‰â„¢nzimlÃ‰â„¢mÃ‰â„¢lÃ‰â„¢ri (OTP gÃƒÂ¶ndÃ‰â„¢rmÃ‰â„¢k ÃƒÂ¼ÃƒÂ§ÃƒÂ¼n)
// DÃ„Â°QQÃ†ÂT: Buraya ÃƒÂ¶z email vÃ‰â„¢ tÃ‰â„¢tbiq Ã…Å¸ifrÃ‰â„¢nizi (App Password) yazmalÃ„Â±sÃ„Â±nÃ„Â±z
const transporter = nodemailer.createTransport({
    service: 'gmail',
    connectionTimeout: 8000,
    greetingTimeout: 8000,
    socketTimeout: 10000,
    auth: {
        user: process.env.EMAIL_USER || 'rabonamedialive@gmail.com', // Sizin email
        pass: process.env.EMAIL_PASS || 'clku ygjx olqe udpo'    // Sizin "App Password" Ã…Å¸ifrÃ‰â„¢niz
    }
});

app.use(cors({
    origin: '*', // HÃ‰â„¢lÃ‰â„¢lik hÃ‰â„¢r yerÃ‰â„¢ icazÃ‰â„¢ veririk, Render linki bÃ‰â„¢lli olandan sonra bunu GitHub linkinlÃ‰â„¢ Ã‰â„¢vÃ‰â„¢z edÃ‰â„¢ bilÃ‰â„¢rik
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: "15mb" }));
app.use((req, res, next) => {
    const requestPath = req.path || "";
    if (
        requestPath === "/" ||
        requestPath.endsWith(".html") ||
        requestPath === "/sw.js" ||
        requestPath === "/firebase-messaging-sw.js"
    ) {
        res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
        res.set("Pragma", "no-cache");
        res.set("Expires", "0");
        res.set("Surrogate-Control", "no-store");
    }
    next();
});

function sendNoStoreHtml(res, fileName) {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");
    res.set("Surrogate-Control", "no-store");
    res.sendFile(path.join(__dirname, fileName));
}

app.get(["/", "/index.html"], (req, res, next) => {
    if (String(process.env.LOCAL_SAFE_MODE || "false").toLowerCase() === "true") {
        return sendNoStoreHtml(res, "local-safe.html");
    }
    return sendNoStoreHtml(res, "index.html");
});

app.use((req, res, next) => {
    const sensitive = ['server.js', 'serviceaccountkey.json', 'users.json', 'profiles.json', '.env', 'match-details-cache.json', 'package.json', 'package-lock.json'];
    const lowerPath = req.path.toLowerCase();
    if (sensitive.some(f => lowerPath.endsWith(f)) || (lowerPath.endsWith('.json') && !lowerPath.endsWith('manifest.json'))) {
        return res.status(403).json({ success: false, message: "Forbidden Access" });
    }
    next();
});
app.use(express.static(path.join(__dirname), {
    setHeaders(res, filePath) {
        if (
            filePath.endsWith("index.html") ||
            filePath.endsWith("sw.js") ||
            filePath.endsWith("firebase-messaging-sw.js")
        ) {
            res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
            res.set("Pragma", "no-cache");
            res.set("Expires", "0");
            res.set("Surrogate-Control", "no-store");
        }
    }
}));
app.get("/favicon.ico", (req, res) => {
    res.set("Cache-Control", "public, max-age=86400");
    res.type("image/png").sendFile(path.join(__dirname, "ayble.png"));
});
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
const SOFA_IMAGE_APIS = [...new Set([
    "https://img.sofascore.com/api/v1",
    process.env.SOFA_IMAGE_API_BASE,
    SOFA_API,
    SOFA_WEB_API,
    "https://api.sofascore.app/api/v1"
].filter(Boolean))];
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

    throw new Error(`BÃƒÂ¼tÃƒÂ¼n baÃ„Å¸lantÃ„Â± cÃ‰â„¢hdlÃ‰â„¢ri uÃ„Å¸ursuz oldu: ${lastError ? lastError.message : 'Unknown'}`);
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

let rapidApiDisabledUntil = 0;
const RAPIDAPI_ENABLED = String(process.env.RAPIDAPI_ENABLED || "true").toLowerCase() !== "false";

function rememberRapidApiFailure(error) {
    const status = error?.response?.status;
    const message = String(error?.response?.data?.message || error?.message || "");
    if (status === 429 || message.toLowerCase().includes("quota") || message.toLowerCase().includes("rate limit")) {
        rapidApiDisabledUntil = Date.now() + 30 * 60 * 1000;
        console.warn(`[RAPIDAPI] Disabled temporarily: ${message.slice(0, 160)}`);
    }
}

function ensureRapidApiAvailable() {
    if (!RAPIDAPI_ENABLED) throw new Error("RAPIDAPI disabled by RAPIDAPI_ENABLED=false");
    const rapidApiKey = process.env.RAPIDAPI_KEY;
    if (!rapidApiKey) throw new Error("RAPIDAPI_KEY is not configured");
    if (Date.now() < rapidApiDisabledUntil) throw new Error("RAPIDAPI temporarily disabled after quota/rate-limit response");
    return rapidApiKey;
}

async function fetchRapidApiIncidents(matchId) {
    try {
        const rapidApiKey = ensureRapidApiAvailable();
        const response = await axios.get(`https://${RAPIDAPI_HOST}/matches/get-incidents`, {
            headers: {
                "x-rapidapi-key": rapidApiKey,
                "x-rapidapi-host": RAPIDAPI_HOST
            },
            params: { matchId },
            timeout: 5500
        });

        return normalizeIncidentsData(response.data);
    } catch (error) {
        rememberRapidApiFailure(error);
        throw error;
    }
}

async function fetchRapidApiSofaPath(path, params = {}, timeout = 12000) {
    try {
        const rapidApiKey = ensureRapidApiAvailable();
        const response = await axios.get(`https://${RAPIDAPI_HOST}${path}`, {
            headers: {
                "x-rapidapi-key": rapidApiKey,
                "x-rapidapi-host": RAPIDAPI_HOST
            },
            params,
            timeout: Math.min(timeout, 5500)
        });

        return normalizeSofaData(response.data);
    } catch (error) {
        rememberRapidApiFailure(error);
        throw error;
    }
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

async function fetchFromSofaNativeFast(path, params = {}, timeout = 2500) {
    if (typeof fetch !== "function") throw new Error("Native fetch is unavailable");
    const query = new URLSearchParams(params).toString();
    const urls = SOFA_APIS.map(baseUrl => `${baseUrl}${path}${query ? `?${query}` : ""}`);

    const attempts = urls.map(async (url) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);
        try {
            const response = await fetch(url, {
                signal: controller.signal,
                headers: {
                    "Accept": "application/json, text/plain, */*",
                    "User-Agent": getRandomUA(),
                    "Referer": "https://www.sofascore.com/"
                }
            });
            const text = await response.text();
            let data = text;
            try { data = JSON.parse(text); } catch (_) {}
            if (!response.ok) {
                const reason = data?.error?.reason || data?.message || response.statusText;
                throw new Error(`HTTP ${response.status}: ${reason}`);
            }
            return normalizeSofaData(data);
        } finally {
            clearTimeout(timer);
        }
    });

    try {
        return await Promise.any(attempts);
    } catch (error) {
        const reasons = error.errors?.map(e => e.message).join(" | ") || error.message;
        throw new Error(`Native Sofa fetch failed for ${path}: ${reasons}`);
    }
}

async function fetchFromSofaApiDirect(path, params = {}, timeout = 3000) {
    const attempts = SOFA_APIS.map(async (baseUrl) => {
        const response = await axios.get(`${baseUrl}${path}`, {
            headers: { ...HEADERS, "User-Agent": getRandomUA() },
            params,
            timeout
        });
        return normalizeSofaData(response.data);
    });
    try {
        return await Promise.any(attempts);
    } catch (error) {
        const reasons = error.errors?.map(e => e.message).join(" | ") || error.message;
        throw new Error(`Direct Sofa fetch failed for ${path}: ${reasons}`);
    }
}

function pickActiveSeason(seasons = []) {
    if (!Array.isArray(seasons) || seasons.length === 0) return null;
    const currentYear = new Date().getFullYear();
    return seasons.find(s => s.isCurrent || s.current || s.year === currentYear) ||
        seasons.find(s => String(s.year || s.name || "").includes(String(currentYear))) ||
        seasons[0];
}

function getSeasonCandidates(seasons = [], requestedSeasonId = null, limit = 6) {
    const ordered = [];
    const addSeason = (season) => {
        if (!season?.id) return;
        if (!ordered.some(item => String(item.id) === String(season.id))) ordered.push(season);
    };
    const requested = requestedSeasonId ? seasons.find(s => String(s.id) === String(requestedSeasonId)) : null;
    if (requested) addSeason(requested);
    else if (requestedSeasonId) addSeason({ id: requestedSeasonId });
    addSeason(pickActiveSeason(seasons));
    seasons.forEach(addSeason);
    return ordered.slice(0, limit);
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

// -------------------------------------------------------------------
// SSE stream for live match updates
// -------------------------------------------------------------------
app.get('/api/match/stream/:id', (req, res) => {
  const matchId = req.params.id;
  // Set headers for SSE
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const send = data => res.write(`data: ${JSON.stringify(data)}\n\n`);

  const initialMatch = matchCache[matchId] || { id: matchId };
  if (initialMatch || matchDetailsCache[matchId]) {
    send({
      type: 'init',
      payload: {
        ...initialMatch,
        details: matchDetailsCache[matchId] || null
      }
    });
  }
  if (!matchDetailsCache[matchId]) {
    refreshMatchDetails(matchId).catch(error => {
      console.warn(`[SSE DETAILS WARMUP] ${matchId}: ${error.message}`);
    });
  }

  const listener = updated => {
    if (String(updated.id) === String(matchId)) {
      send({
        type: 'update',
        payload: {
          ...updated,
          details: matchDetailsCache[matchId] || updated.details || null
        }
      });
    }
  };

  const listenerRecord = { id: matchId, fn: listener };
  sseListeners.push(listenerRecord);

  // Cleanup on client disconnect
  req.on('close', () => {
    sseListeners = sseListeners.filter(l => l !== listenerRecord);
    res.end();
  });
});

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
        webpush_registration_count: Object.keys(webPushRegistrations).length,
        last_scores_size: Object.keys(lastScores).length,
        score_push_state_size: Object.keys(scorePushState).length
    };

    res.json(diagnostic);
});

// Caching System

// -------------------------------------------------------------------
// Keepâ€‘alive and health endpoints
// -------------------------------------------------------------------
// Consolidated Ping and Health endpoints moved to the end of file or kept here

const cache = {};
const CACHE_TIMES = {
    LIVE: 150,        // Live must not lag behind Mackolik.
    SCHEDULED: 5 * 60 * 1000, // 5 dÃ‰â„¢qiqÃ‰â„¢
    STATIC: 60 * 60 * 1000    // 1 saat
};
const BACKGROUND_REFRESH_THROTTLE_MS = 60 * 1000;
const backgroundRefreshAttempts = {};

function shouldStartBackgroundRefresh(key, isFresh = false, force = false) {
    if (isFresh && !force) return false;
    const now = Date.now();
    if (!force && now - (backgroundRefreshAttempts[key] || 0) < BACKGROUND_REFRESH_THROTTLE_MS) return false;
    backgroundRefreshAttempts[key] = now;
    return true;
}

const IMAGE_CACHE_DIR = path.join(__dirname, ".image-cache");
const imageMemoryCache = new Map();
const imageInFlight = new Map();
const imageFailureCache = new Map();
const IMAGE_FAILURE_TTL = 30 * 60 * 1000;

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

function rememberFailedImage(imagePath, error) {
    imageFailureCache.set(imagePath, {
        timestamp: Date.now(),
        message: error?.message || "Image fetch failed"
    });
}

function getRecentImageFailure(imagePath) {
    const cachedFailure = imageFailureCache.get(imagePath);
    if (!cachedFailure) return null;
    if (Date.now() - cachedFailure.timestamp > IMAGE_FAILURE_TTL) {
        imageFailureCache.delete(imagePath);
        return null;
    }
    return cachedFailure;
}

async function fetchSofaImageCached(imagePath) {
    const cached = readCachedImage(imagePath);
    if (cached) return cached;

    const recentFailure = getRecentImageFailure(imagePath);
    if (recentFailure) {
        throw new Error(`Image unavailable: ${recentFailure.message}`);
    }

    if (imageInFlight.has(imagePath)) {
        return imageInFlight.get(imagePath);
    }

    const request = (async () => {
        let response = null;
        let lastImageError = null;
        for (const baseUrl of SOFA_IMAGE_APIS) {
            try {
                response = await axios.get(`${baseUrl}${imagePath}`, {
                    responseType: "arraybuffer",
                    timeout: 1800,
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

        if (!response) {
            rememberFailedImage(imagePath, lastImageError);
            throw lastImageError || new Error("Image fetch failed");
        }

        const payload = {
            body: Buffer.from(response.data),
            contentType: response.headers["content-type"] || "image/png"
        };
        imageFailureCache.delete(imagePath);
        saveCachedImage(imagePath, payload);
        return { ...payload, cached: false };
    })().finally(() => {
        imageInFlight.delete(imagePath);
    });

    imageInFlight.set(imagePath, request);
    return request;
}

const EXTERNAL_IMAGE_HOSTS = new Set([
    "file.mackolikfeeds.com",
    "static.flashscore.com",
    "flagcdn.com",
    "img.sofascore.com",
    "api.sofascore.com",
    "www.sofascore.com",
    "api.sofascore.app"
]);

function getExternalImageCacheKey(imageUrl) {
    return `external:${imageUrl}`;
}

function inferImageContentType(imageUrl, fallback = "image/png") {
    const pathname = (() => {
        try { return new URL(imageUrl).pathname.toLowerCase(); } catch (e) { return ""; }
    })();
    if (pathname.endsWith(".svg")) return "image/svg+xml";
    if (pathname.endsWith(".webp")) return "image/webp";
    if (pathname.endsWith(".jpg") || pathname.endsWith(".jpeg")) return "image/jpeg";
    if (pathname.endsWith(".gif")) return "image/gif";
    if (pathname.endsWith(".avif")) return "image/avif";
    return fallback;
}

async function fetchExternalImageCached(imageUrl) {
    const cacheKey = getExternalImageCacheKey(imageUrl);
    const cached = readCachedImage(cacheKey);
    if (cached) return cached;

    const recentFailure = getRecentImageFailure(cacheKey);
    if (recentFailure) {
        throw new Error(`External image unavailable: ${recentFailure.message}`);
    }

    if (imageInFlight.has(cacheKey)) {
        return imageInFlight.get(cacheKey);
    }

    const request = (async () => {
        try {
            const imageHost = new URL(imageUrl).hostname;
            const response = await axios.get(imageUrl, {
                responseType: "arraybuffer",
                timeout: imageHost === "file.mackolikfeeds.com" ? 6000 : 2200,
                maxRedirects: 3,
                headers: {
                    ...HEADERS,
                    Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
                    Referer: imageHost === "file.mackolikfeeds.com"
                        ? "https://www.mackolik.com/"
                        : (imageHost === "static.flashscore.com" ? "https://www.flashscore.com/" : "https://www.sofascore.com/"),
                    "User-Agent": getRandomUA()
                }
            });
            const contentType = String(response.headers["content-type"] || inferImageContentType(imageUrl)).split(";")[0].trim();
            if (!contentType.startsWith("image/")) {
                throw new Error(`Unexpected image content-type: ${contentType || "unknown"}`);
            }
            const payload = {
                body: Buffer.from(response.data),
                contentType
            };
            imageFailureCache.delete(cacheKey);
            saveCachedImage(cacheKey, payload);
            return { ...payload, cached: false };
        } catch (error) {
            rememberFailedImage(cacheKey, error);
            throw error;
        }
    })().finally(() => {
        imageInFlight.delete(cacheKey);
    });

    imageInFlight.set(cacheKey, request);
    return request;
}

let lastScores = {};
let scorePushState = {};
let liveGoalIncidentState = {};
const SCORES_FILE = "./last_scores.json";
const SCORE_PUSH_STATE_FILE = "./score_push_state.json";
const INCIDENT_STATE_FILE = "./incident_state.json";

function loadPersistentState() {
    try {
        if (fs.existsSync(SCORES_FILE)) {
            lastScores = JSON.parse(fs.readFileSync(SCORES_FILE, "utf-8"));
            console.log(`[STATE] Loaded ${Object.keys(lastScores).length} match scores from disk.`);
        }
        if (fs.existsSync(SCORE_PUSH_STATE_FILE)) {
            scorePushState = JSON.parse(fs.readFileSync(SCORE_PUSH_STATE_FILE, "utf-8"));
            console.log(`[STATE] Loaded score push state for ${Object.keys(scorePushState).length} matches.`);
        }
        if (fs.existsSync(INCIDENT_STATE_FILE)) {
            const raw = JSON.parse(fs.readFileSync(INCIDENT_STATE_FILE, "utf-8"));
            // Convert arrays back to Sets
            liveGoalIncidentState = {};
            for (const id in raw) {
                liveGoalIncidentState[id] = new Set(raw[id]);
            }
            console.log(`[STATE] Loaded incident state for ${Object.keys(liveGoalIncidentState).length} matches.`);
        }
    } catch (e) { console.error("[STATE] Load error:", e.message); }
}

function savePersistentState() {
    try {
        fs.writeFileSync(SCORES_FILE, JSON.stringify(lastScores, null, 2));
        fs.writeFileSync(SCORE_PUSH_STATE_FILE, JSON.stringify(scorePushState, null, 2));
        // Convert Sets to arrays for JSON
        const toSave = {};
        for (const id in liveGoalIncidentState) {
            toSave[id] = Array.from(liveGoalIncidentState[id]);
        }
        fs.writeFileSync(INCIDENT_STATE_FILE, JSON.stringify(toSave, null, 2));
    } catch (e) { console.error("[STATE] Save error:", e.message); }
}

loadPersistentState();
loadMatchDetailsCacheFromDisk();

let goalNotificationState = {};
let pendingGoalDetailNotifications = {};
const scorePushInFlight = new Set();
const goalScorerProbeTimers = new Map();
let globalLiveEvents = null;
let lastLiveFetchTime = 0;
let lastLiveFetchAttemptTime = 0;

let liveFetchPromise = null;
let liveSnapshotLoadPromise = null;
let liveDetailsWarmupPromise = null;
let lastLiveDetailsWarmupAt = 0;
let liveScoreWorkerInFlight = false;
let favoriteGoalCatchupInFlight = false;
const INCIDENTS_CACHE_TTL = 2500;
const INCIDENTS_STALE_REFRESH_MS = 1200;
const STATS_CACHE_TTL = 2500;
const STATS_STALE_REFRESH_MS = 500;
const EMPTY_STATS_CACHE_TTL = 500;
const MACKOLIK_DETAILS_CACHE_TTL = 450;
const MACKOLIK_FAST_DETAILS_CACHE_TTL = 30 * 60 * 1000;
const DETAILS_WARMUP_INTERVAL_MS = 700;
const MATCH_DETAILS_CACHE_FILE = "./match_details_cache.json";
const MATCH_DETAILS_DISK_MAX_ITEMS = 2500;
const MATCH_DETAILS_DISK_MAX_AGE = 14 * 24 * 60 * 60 * 1000;
const SCHEDULED_DETAILS_WARM_BATCH = 8;
const SCHEDULED_DETAILS_WARM_INTERVAL_MS = 600;
const RECENT_SCHEDULED_DETAILS_WARM_INTERVAL_MS = 60 * 1000;
const LIVE_SNAPSHOT_FILE = "./live_snapshot.json";
const LIVE_SNAPSHOT_MAX_AGE = 900;
const LIVE_DISK_SNAPSHOT_MAX_AGE = 10 * 60 * 1000;
const LIVE_STALE_RETURN_MAX_AGE = 1500;
const LIVE_SCORE_POLL_INTERVAL_MS = Math.max(450, Number(process.env.LIVE_SCORE_POLL_INTERVAL_MS) || 500);
const CLIENT_LIVE_SNAPSHOT_MAX_EVENTS = 160;
const LIVE_PRIMARY_SOURCE = String(process.env.LIVE_PRIMARY_SOURCE || "mackolik").toLowerCase();
const ENABLE_MACKOLIK_MATCHES = String(process.env.ENABLE_MACKOLIK_MATCHES || "true").toLowerCase() !== "false";
const ALLOW_MACKOLIK_FALLBACK = String(process.env.ALLOW_MACKOLIK_FALLBACK || "true").toLowerCase() !== "false";
const STRICT_SOFASCORE_ONLY = String(process.env.SOFASCORE_STRICT_ONLY || "false").toLowerCase() === "true";
const SOFASCORE_ONLY_MODE = STRICT_SOFASCORE_ONLY || (LIVE_PRIMARY_SOURCE === "sofascore" && !ENABLE_MACKOLIK_MATCHES && !ALLOW_MACKOLIK_FALLBACK);
const MACKOLIK_CANONICAL_MODE = !SOFASCORE_ONLY_MODE && LIVE_PRIMARY_SOURCE === "mackolik" && ENABLE_MACKOLIK_MATCHES;
const FLASHSCORE_CANONICAL_MODE = !SOFASCORE_ONLY_MODE && LIVE_PRIMARY_SOURCE === "flashscore";
const ENABLE_MACKOLIK_PUSH_FALLBACK = String(process.env.ENABLE_MACKOLIK_PUSH_FALLBACK || "true").toLowerCase() !== "false";
const ENABLE_MACKOLIK_SCORE_OVERLAY = String(process.env.ENABLE_MACKOLIK_SCORE_OVERLAY || "true").toLowerCase() !== "false";
let lastPushFallbackLogAt = 0;
const MACKOLIK_LIVE_URL = "https://www.mackolik.com/perform/p0/ajax/components/competition/livescores/json";
const MACKOLIK_LIVE_PAGE_URL = "https://www.mackolik.com/canli-sonuclar";
let mackolikLiveConfigCache = null;
let mackolikLiveConfigCacheAt = 0;
const MACKOLIK_LIVE_CONFIG_TTL = 15 * 1000;
const MACKOLIK_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Referer": "https://www.mackolik.com/canli-sonuclar",
    "X-Requested-With": "XMLHttpRequest"
};

function getMackolikTeamLogo(teamId) {
    const id = teamId ? String(teamId) : "";
    if (!id || id === "1" || id === "2" || /^macko/i.test(id) || /^mk_/i.test(id)) return null;
    return `https://file.mackolikfeeds.com/teams/${id}`;
}

function getMackolikCountryLogo(countryId) {
    return countryId ? `https://file.mackolikfeeds.com/areas/${countryId}` : null;
}

function getMackolikCompetitionLogo(competitionId) {
    return competitionId ? `https://file.mackolikfeeds.com/competitions/${competitionId}` : null;
}

const MACKOLIK_CURATED_CATEGORIES = {
    europe: { id: "mackolik_europe", name: "Europe", slug: "avrupa", alpha2: "EU", priority: 100, source: "mackolik" },
    turkey: { id: "mackolik_turkey", name: "Turkey", slug: "turkiye", alpha2: "TR", priority: 98, source: "mackolik" },
    england: { id: "mackolik_england", name: "England", slug: "ingiltere", alpha2: "GB-ENG", priority: 97, source: "mackolik" },
    spain: { id: "mackolik_spain", name: "Spain", slug: "ispanya", alpha2: "ES", priority: 96, source: "mackolik" },
    italy: { id: "mackolik_italy", name: "Italy", slug: "italya", alpha2: "IT", priority: 95, source: "mackolik" },
    germany: { id: "mackolik_germany", name: "Germany", slug: "almanya", alpha2: "DE", priority: 94, source: "mackolik" },
    france: { id: "mackolik_france", name: "France", slug: "fransa", alpha2: "FR", priority: 93, source: "mackolik" },
    netherlands: { id: "mackolik_netherlands", name: "Netherlands", slug: "hollanda", alpha2: "NL", priority: 92, source: "mackolik" },
    azerbaijan: { id: "mackolik_azerbaijan", name: "Azerbaijan", slug: "azerbaycan", alpha2: "AZ", priority: 91, source: "mackolik" }
};

const MACKOLIK_CURATED_LEAGUES = [
    { id: "4oogyu6o156iphvdvphwpck10", name: "UEFA Champions League", slug: "sampiyonlar-ligi", categoryKey: "europe", priority: 1000 },
    { id: "4c1nfi2j1m731hcay25fcgndq", name: "UEFA Europa League", slug: "avrupa-ligi", categoryKey: "europe", priority: 990 },
    { id: "482ofyysbdbeoxauk19yg7tdt", name: "Süper Lig", slug: "super-lig", categoryKey: "turkey", priority: 980 },
    { id: "2kwbbcootiqqgmrzs6o5inle5", name: "Premier League", slug: "premier-lig", categoryKey: "england", priority: 970 },
    { id: "34pl8szyvrbwcmfkuocjm3r6t", name: "LaLiga", slug: "laliga", categoryKey: "spain", priority: 960 },
    { id: "1r097lpxe0xn03ihb7wi98kao", name: "Serie A", slug: "serie-a", categoryKey: "italy", priority: 950 },
    { id: "6by3h89i2eykc341oz7lv1ddd", name: "Bundesliga", slug: "bundesliga", categoryKey: "germany", priority: 940 },
    { id: "dm5ka0os1e3dxcp3vh05kmp33", name: "Ligue 1", slug: "ligue-1", categoryKey: "france", priority: 930 },
    { id: "akmkihra9ruad09ljapsm84b3", name: "Eredivisie", slug: "eredivisie", categoryKey: "netherlands", priority: 920 },
    { id: "3428tckxcirwwh3o3jgc1m8ji", name: "Azerbaijan Premier Lig", slug: "misli-premier-lig", categoryKey: "azerbaijan", priority: 910 },
    { id: "1pz0ch210cun5hthsvq0lb7x3", name: "Azerbaijan 1.Lig", slug: "1lig", categoryKey: "azerbaijan", priority: 900 }
];

function addCuratedMackolikLeagues(categoriesById, leaguesByCategory) {
    Object.values(MACKOLIK_CURATED_CATEGORIES).forEach(category => {
        if (!categoriesById.has(String(category.id))) {
            categoriesById.set(String(category.id), {
                ...category,
                flag: null,
                logoUrl: null
            });
        }
    });

    MACKOLIK_CURATED_LEAGUES.forEach(item => {
        const category = MACKOLIK_CURATED_CATEGORIES[item.categoryKey] || MACKOLIK_CURATED_CATEGORIES.europe;
        const categoryId = String(category.id);
        if (!leaguesByCategory.has(categoryId)) leaguesByCategory.set(categoryId, []);
        const list = leaguesByCategory.get(categoryId);
        if (list.some(league => String(league.id) === String(item.id))) return;
        list.push({
            id: String(item.id),
            name: item.name,
            slug: item.slug,
            priority: item.priority,
            category: categoriesById.get(categoryId),
            uniqueTournament: {
                id: String(item.id),
                name: item.name,
                slug: item.slug
            },
            logoUrl: getMackolikCompetitionLogo(item.id),
            source: "mackolik",
            seasonId: "auto",
            isUnique: true
        });
    });
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
    if (mackolikLiveConfigCache && Date.now() - mackolikLiveConfigCacheAt < MACKOLIK_LIVE_CONFIG_TTL) {
        return mackolikLiveConfigCache;
    }
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

        mackolikLiveConfigCache = {
            matchDate: params.matchDate,
            sports: ["Soccer"],
            urlJson: settings?.urlJson || MACKOLIK_LIVE_URL
        };
        mackolikLiveConfigCacheAt = Date.now();
        return mackolikLiveConfigCache;
    } catch (error) {
        console.warn("[MACKOLIK CONFIG] Falling back to default live config:", error.message);
        mackolikLiveConfigCache = {
            matchDate: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10),
            sports: ["Soccer"],
            urlJson: MACKOLIK_LIVE_URL
        };
        mackolikLiveConfigCacheAt = Date.now();
        return mackolikLiveConfigCache;
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

function formatMackolikElapsedMinute(totalSeconds, periodId) {
    const totalMinute = Math.floor(Math.max(0, totalSeconds) / 60) + 1;
    if (!Number.isFinite(totalMinute) || totalMinute <= 0) return null;
    const period = Number(periodId);
    if (period === 1 && totalMinute > 45) return `45+${totalMinute - 45}`;
    if (period === 2 && totalMinute > 90) return `90+${totalMinute - 90}`;
    if (period === 3 && totalMinute > 105) return `105+${totalMinute - 105}`;
    if (period === 4 && totalMinute > 120) return `120+${totalMinute - 120}`;
    return `${totalMinute}'`;
}

function getMackolikMinuteText(match) {
    const box = String(match?.statusBoxContent || "").trim();
    if (box && box !== "-" && box.toUpperCase() !== "LIVE") return box;
    return null;
}

function getMackolikComputedMinuteText(match) {
    if (!match?.periodStart) return null;
    const periodStartMs = Number(match.periodStart);
    if (!Number.isFinite(periodStartMs) || periodStartMs <= 0) return null;
    const elapsedSeconds = Math.floor((Date.now() - periodStartMs) / 1000) + getMackolikInitialSeconds(match.periodId);
    return formatMackolikElapsedMinute(elapsedSeconds, match.periodId);
}

function isMackolikOvertimeStaleLive(match) {
    if (!match?.periodStart) return false;
    const periodStartMs = Number(match.periodStart);
    if (!Number.isFinite(periodStartMs) || periodStartMs <= 0) return false;
    const totalMinute = Math.floor(Math.max(0, (Date.now() - periodStartMs) / 1000 + getMackolikInitialSeconds(match.periodId)) / 60) + 1;
    const period = Number(match.periodId);
    if (period === 1 && totalMinute > 57) return true;
    if (period === 2 && totalMinute > 102) return true;
    if (period === 3 && totalMinute > 117) return true;
    if (period === 4 && totalMinute > 132) return true;
    return false;
}

function getMackolikLiveMinuteText(match) {
    return getMackolikMinuteText(match);
}

function mapMackolikStatus(match) {
    const state = match?.state;
    const substate = String(match?.substate || "").toLowerCase();
    const rawBox = String(match?.statusBoxContent || "").trim();
    const box = rawBox.toUpperCase();

    if (state === "live") {
        if (substate === "halftime" || box === "IY" || box === "İY" || box === "HT") {
            return { type: "inprogress", description: rawBox || "HT" };
        }
        return {
            type: "inprogress",
            description: getMackolikLiveMinuteText(match) || rawBox || "LIVE"
        };
    }

    if (state === "post") {
        if (substate === "penalties") return { type: "finished", description: rawBox || "PEN" };
        if (substate === "afterextratime") return { type: "finished", description: rawBox || "AET" };
        return { type: "finished", description: rawBox || "FT" };
    }

    if (substate === "postponed") {
        return { type: "notstarted", description: rawBox || "POSTPONED" };
    }

    return { type: "notstarted", description: rawBox || "" };
}

function isMackolikFinishedStatus(match) {
    const state = String(match?.state || "").toLowerCase();
    const substate = String(match?.substate || "").toLowerCase();
    const box = String(match?.statusBoxContent || "").trim().toUpperCase();
    if (state === "post" || state === "finished") return true;
    if (["post", "finished", "ended", "afterextratime", "penalties"].includes(substate)) return true;
    return [
        "MS",
        "FT",
        "FULL TIME",
        "FINISHED",
        "ENDED",
        "BITTI",
        "BİTTİ",
        "MAÇ SONU",
        "MAC SONU",
        "PEN",
        "AET"
    ].includes(box);
}

function isMackolikLiveMatch(match) {
    const state = String(match?.state || "").toLowerCase();
    if (isMackolikFinishedStatus(match)) return false;
    if (isMackolikOvertimeStaleLive(match)) return false;
    return state === "live";
}

function parseMackolikScoreNumber(value) {
    if (value === null || value === undefined || value === "") return NaN;
    if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
    const match = String(value).match(/\d+/);
    return match ? Number(match[0]) : NaN;
}

function getMackolikScore(match, side) {
    const score = match?.score || {};
    const candidates = side === "home"
        ? [score.home, score.homeScore, match?.homeScore, match?.scoreHome, match?.homeTeamScore]
        : [score.away, score.awayScore, match?.awayScore, match?.scoreAway, match?.awayTeamScore];
    for (const candidate of candidates) {
        const parsed = parseMackolikScoreNumber(candidate);
        if (Number.isFinite(parsed)) return parsed;
    }

    const combined = [
        score.current,
        score.display,
        score.fullTime,
        score.score,
        match?.scoreText,
        match?.result
    ].filter(Boolean).join(" ");
    const numbers = combined.match(/\d+/g);
    if (numbers && numbers.length >= 2) {
        return Number(numbers[side === "home" ? 0 : 1]);
    }

    return 0;
}

function parseMackolikIncidentMinuteText(timeText) {
    const raw = String(timeText || "").trim();
    const baseMatch = raw.match(/(\d+)/);
    if (!baseMatch) return null;
    const addedMatch = raw.match(/\+\s*(\d+)/);
    return {
        time: Number(baseMatch[1]),
        addedTime: addedMatch ? Number(addedMatch[1]) : 0
    };
}

function formatMackolikIncidentMinute(parts) {
    if (!parts) return "";
    if (parts.addedTime > 0) return `${parts.time}+${parts.addedTime}'`;
    return parts.time > 0 ? `${parts.time}'` : "";
}

function getLatestMackolikIncidentMinute(match) {
    const keyEvents = Array.isArray(match?.keyEvents) ? match.keyEvents : [];
    return keyEvents
        .map(event => parseMackolikIncidentMinuteText(event?.timeMin))
        .filter(Boolean)
        .sort((a, b) => (b.time - a.time) || (b.addedTime - a.addedTime))[0] || null;
}

function normalizeMackolikMatch(match, competitions, options = {}) {
    const { liveOnly = false } = options;
    const competition = competitions[match?.competitionId] || {};
    if (competition?.sport !== "S") return null;
    if (liveOnly && !isMackolikLiveMatch(match)) return null;

    const category = competition.country || {};
    const status = mapMackolikStatus(match);
    const homeScore = getMackolikScore(match, "home");
    const awayScore = getMackolikScore(match, "away");
    const homeTeamId = match?.homeTeam?.id || `mk_home_${match.id}`;
    const awayTeamId = match?.awayTeam?.id || `mk_away_${match.id}`;
    const tournamentLogoUrl = getMackolikCountryLogo(category.id);

    return {
        id: match.id,
        slug: match.matchSlug || `${match.homeTeam?.slug || "home"}-vs-${match.awayTeam?.slug || "away"}`,
        customId: match.iddaaCode ? String(match.iddaaCode) : match.id,
        startTimestamp: match.mstUtc ? Math.floor(Number(match.mstUtc) / 1000) : undefined,
        status,
        time: undefined,
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
                name: category.name || "DigÉ™r",
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

function syncLiveMatchCache(events = []) {
    const liveIds = new Set((Array.isArray(events) ? events : [])
        .map(event => event?.id ? String(event.id) : "")
        .filter(Boolean));
    Object.keys(matchCache).forEach(id => {
        const cached = matchCache[id];
        if (String(cached?.source || "").toLowerCase().includes("mackolik") && !liveIds.has(id)) {
            delete matchCache[id];
        }
    });
    (Array.isArray(events) ? events : []).forEach(event => {
        if (event?.id) matchCache[String(event.id)] = event;
    });
}

function normalizeMackolikCompetitionsData(payload = {}) {
    const data = payload?.data || payload || {};
    const competitions = Object.values(data.competitions || {})
        .filter(competition => competition?.sport === "S");
    const categoriesById = new Map();
    const leaguesByCategory = new Map();

    competitions.forEach(competition => {
        const country = competition.country || {};
        const categoryId = String(country.id || "mackolik_other");
        if (!categoriesById.has(categoryId)) {
            categoriesById.set(categoryId, {
                id: categoryId,
                name: country.name || "Digər",
                slug: competition.countrySlug || "",
                alpha2: country.code || country.alpha2 || "",
                flag: getMackolikCountryLogo(country.id),
                logoUrl: getMackolikCountryLogo(country.id),
                source: "mackolik"
            });
        }

        const league = {
            id: String(competition.id),
            name: competition.name || "Liqa",
            slug: competition.competitionSlug || "",
            priority: Number(competition.priority || 0),
            category: categoriesById.get(categoryId),
            uniqueTournament: {
                id: String(competition.id),
                name: competition.name || "Liqa",
                slug: competition.competitionSlug || ""
            },
            logoUrl: getMackolikCompetitionLogo(competition.id),
            source: "mackolik",
            seasonId: competition.seasonId || null,
            isUnique: true
        };
        if (!leaguesByCategory.has(categoryId)) leaguesByCategory.set(categoryId, []);
        leaguesByCategory.get(categoryId).push(league);
    });

    addCuratedMackolikLeagues(categoriesById, leaguesByCategory);

    const sortLeagues = list => list
        .sort((a, b) => (b.priority || 0) - (a.priority || 0) || String(a.name || "").localeCompare(String(b.name || ""), "az"));

    return {
        categories: Array.from(categoriesById.values()).sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "az")),
        leaguesByCategory: Object.fromEntries(Array.from(leaguesByCategory.entries()).map(([key, value]) => [key, sortLeagues(value)])),
        uniqueTournaments: sortLeagues(Array.from(leaguesByCategory.values()).flat()),
        source: "mackolik",
        generatedAt: new Date().toISOString()
    };
}

async function fetchMackolikCompetitionCatalog(matchDate = null) {
    const config = await fetchMackolikLiveConfig();
    let response = null;
    try {
        response = await axios.get(config.urlJson, {
            params: {
                sports: config.sports,
                matchDate: matchDate || config.matchDate
            },
            headers: MACKOLIK_HEADERS,
            timeout: 6000
        });
        if (response.data?.status !== "success") {
            throw new Error(`Mackolik competitions failed: ${response.data?.status || "unknown"}`);
        }
    } catch (error) {
        console.warn("[MACKOLIK CATALOG] Live catalog failed, returning curated leagues:", error.message);
        const curatedCatalog = normalizeMackolikCompetitionsData({ data: { competitions: {} } });
        curatedCatalog.matchDate = matchDate || config.matchDate;
        curatedCatalog.curatedOnly = true;
        return curatedCatalog;
    }
    const catalog = normalizeMackolikCompetitionsData(response.data);
    catalog.matchDate = matchDate || config.matchDate;
    return catalog;
}

function mackolikUnavailablePayload(message = "Mackolik bu məlumatı hazırda vermir") {
    return {
        source: "mackolik",
        unavailable: true,
        message,
        standings: [],
        topPlayers: { goals: [] },
        seasons: []
    };
}

function normalizeSofaEventsData(payload) {
    const events = Array.isArray(payload?.events) ? payload.events : [];
    return {
        ...payload,
        events: events.map(event => ({
            ...event,
            homeTeam: event.homeTeam ? { ...event.homeTeam } : event.homeTeam,
            awayTeam: event.awayTeam ? { ...event.awayTeam } : event.awayTeam,
            tournament: event.tournament ? { ...event.tournament } : event.tournament,
            source: "sofascore"
        })),
        source: "sofascore",
        generatedAt: new Date().toISOString()
    };
}

function buildMackolikCompetitionSlug(league = {}) {
    const countrySlug = String(league?.category?.slug || league?.countrySlug || "").trim();
    const competitionSlug = String(league?.slug || league?.competitionSlug || "").trim();
    return [countrySlug, competitionSlug].filter(Boolean).join("-");
}

function getMackolikActiveSeason(settings = {}) {
    const season = settings.season || {};
    if (season?.id) return season;
    const seasons = Object.values(settings?.seasonList || settings?.competition?.tournamentCalendar || {});
    return seasons.find(item => String(item?.active || "").toLowerCase() === "yes") || seasons[0] || null;
}

function normalizeMackolikNumber(value) {
    if (value === null || value === undefined || value === "") return null;
    const parsed = Number(String(value).replace("%", "").replace(",", ".").replace(/[^\d.-]/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
}

function normalizeMackolikCompetitionStandings(settings = {}, competitionId = "") {
    const competition = settings.competition || {};
    const season = getMackolikActiveSeason(settings);
        const standingsRaw = [];

    function findStandings(obj) {
        if (!obj || typeof obj !== 'object') return;
        if (Array.isArray(obj)) {
            obj.forEach(findStandings);
            return;
        }
        if (Array.isArray(obj.table) && obj.table.length > 0) {
            standingsRaw.push(obj);
        }
        Object.keys(obj).forEach(key => {
            if (key !== 'table' && typeof obj[key] === 'object') {
                findStandings(obj[key]);
            }
        });
    }

    findStandings(competition.standings);
    findStandings(competition.groups);
    findStandings(competition.stages);
    findStandings(competition.phases);

    const standings = standingsRaw.map(standing => {
        const table = Array.isArray(standing?.table) ? standing.table : [];
        const rows = table.map(item => {
            const team = item.team || {};
            const teamId = String(team.uuid || team.id || "");
            const logoTeamId = String(team.id || team.uuid || "");
            return {
                position: item.rank ?? item.position ?? null,
                team: {
                    id: teamId,
                    name: team.display_name || team.name || "Komanda",
                    shortName: team.name || team.display_name || "Komanda",
                    logoUrl: getMackolikTeamLogo(logoTeamId),
                    source: "mackolik",
                    mackolikId: team.id || team.uuid || ""
                },
                matches: item.played ?? null,
                wins: item.win ?? null,
                draws: item.draw ?? null,
                losses: item.lost ?? null,
                scoresFor: item.pro ?? null,
                scoresAgainst: item.against ?? null,
                points: item.pts ?? null,
                source: "mackolik",
                form: item.serie || "",
                zone: item.zone || null
            };
        }).filter(row => row.team?.id || row.team?.name);

        return {
            name: standing?.name || competition.name || "Mackolik",
            type: "total",
            rows
        };
    }).filter(s => s.rows.length > 0);

    return {
        standings,
        seasonId: season?.id || "auto",
        season: season ? { id: season.id, name: season.name, year: season.name } : null,
        competition: {
            id: competition.id || competitionId,
            name: competition.name || "Liqa",
            country: competition.country || null
        },
        source: "mackolik",
        generatedAt: new Date().toISOString()
    };
}

function normalizeMackolikTopScorers(settings = {}) {
    const competition = settings.competition || {};
    const season = getMackolikActiveSeason(settings);
    const standingsRows = competition.standings?.[0]?.table || [];
    const teamsById = new Map();
    standingsRows.forEach(row => {
        const team = row.team || {};
        const uuid = String(team.uuid || team.id || "");
        const logoTeamId = String(team.id || team.uuid || "");
        if (!uuid) return;
        const value = {
            id: uuid,
            name: team.display_name || team.name || "Komanda",
            shortName: team.name || team.display_name || "Komanda",
            logoUrl: getMackolikTeamLogo(logoTeamId),
            source: "mackolik",
            mackolikId: team.id || team.uuid || ""
        };
        [uuid, team.id].map(v => String(v || "")).filter(Boolean).forEach(id => teamsById.set(id, value));
    });
    (competition.teamStats || []).forEach(stat => {
        const teams = Array.isArray(stat?.teams) ? stat.teams : Object.values(stat?.teams || {});
        teams.forEach(team => {
            const primaryId = String(team.uuid || team.team_id || team.id || "");
            if (!primaryId) return;
            const value = {
                id: primaryId,
                name: team.n || team.name || "Komanda",
                logoUrl: getMackolikTeamLogo(String(team.id || team.team_id || team.uuid || primaryId)),
                source: "mackolik",
                mackolikId: team.id || team.team_id || team.uuid || primaryId
            };
            [primaryId, team.id, team.uuid, team.team_id].map(v => String(v || "")).filter(Boolean).forEach(id => {
                if (!teamsById.has(id)) teamsById.set(id, value);
            });
        });
    });

    const goalStat = (competition.playerStats || []).find(stat => stat?.key === "ps_g") ||
        (competition.playerStats || []).find(stat => /goal|gol|ps_g/i.test(String(stat?.key || "")));
    const players = Array.isArray(goalStat?.players) ? goalStat.players : Object.values(goalStat?.players || {});
    const goals = players.map((item, index) => {
        const teamId = String(item.team_id || "");
        const playerId = String(item.uuid || item.i || "");
        const goalValue = normalizeMackolikNumber(item.v);
        return {
            player: {
                id: playerId,
                name: item.n || "Oyunçu",
                shortName: item.n || "Oyunçu",
                logoUrl: item.uuid ? `https://file.mackolikfeeds.com/people/${item.uuid}` : "",
                source: "mackolik"
            },
            team: teamsById.get(teamId) || {
                id: teamId,
                name: "Komanda",
                logoUrl: teamId ? getMackolikTeamLogo(teamId) : "",
                source: "mackolik"
            },
            goals: goalValue ?? item.v ?? 0,
            statistics: { goals: goalValue ?? item.v ?? 0 },
            value: item.v,
            rank: index + 1,
            source: "mackolik"
        };
    }).filter(item => item.player?.name);

    return {
        topPlayers: { goals },
        seasonId: season?.id || "auto",
        season: season ? { id: season.id, name: season.name, year: season.name } : null,
        source: "mackolik",
        generatedAt: new Date().toISOString()
    };
}

async function fetchMackolikCompetitionPageSettings(competitionId, seasonId = null) {
    const catalog = await getCachedData("mackolik_competition_catalog", fetchMackolikCompetitionCatalog, 30 * 1000, { skipJitter: true });
    const league = (catalog.uniqueTournaments || []).find(item => String(item.id) === String(competitionId)) || {
        id: competitionId,
        slug: "",
        category: { slug: "" }
    };
    const slug = buildMackolikCompetitionSlug(league) || String(competitionId);
    const seasonPart = seasonId && !["auto", "null", "undefined"].includes(String(seasonId)) ? `/${encodeURIComponent(String(seasonId))}` : "";
    const candidates = [
        `https://www.mackolik.com/puan-durumu/${slug}${seasonPart}/${competitionId}`,
        `https://www.mackolik.com/puan-durumu/${slug}/${competitionId}`
    ];
    let lastError = null;
    for (const url of Array.from(new Set(candidates))) {
        try {
            const response = await axios.get(url, {
                headers: {
                    ...MACKOLIK_HEADERS,
                    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                    Referer: "https://www.mackolik.com/canli-sonuclar"
                },
                timeout: 14000,
                maxRedirects: 5
            });
            const settings = extractMackolikSettingsObjects(response.data)
                .find(item => item?.competition?.id || item?.competition?.standings || item?.competition?.playerStats);
            if (settings?.competition) return settings;
            throw new Error("Mackolik competition settings not found");
        } catch (error) {
            lastError = error;
        }
    }
    throw lastError || new Error("Mackolik competition page unavailable");
}

async function fetchMackolikLeagueStandings(competitionId, seasonId = null) {
    const settings = await fetchMackolikCompetitionPageSettings(competitionId, seasonId);
    return normalizeMackolikCompetitionStandings(settings, competitionId);
}

async function fetchMackolikLeagueTopPlayers(competitionId, seasonId = null) {
    const settings = await fetchMackolikCompetitionPageSettings(competitionId, seasonId);
    return normalizeMackolikTopScorers(settings);
}

async function fetchMackolikLeagueSeasons(competitionId) {
    const settings = await fetchMackolikCompetitionPageSettings(competitionId);
    const seasonList = settings?.seasonList || settings?.competition?.tournamentCalendar || {};
    return Object.values(seasonList).filter(item => item?.id).map(item => ({
        id: item.id,
        name: item.name,
        year: item.name,
        slug: item.slug || item.id,
        isCurrent: String(item.active || "").toLowerCase() === "yes",
        current: String(item.active || "").toLowerCase() === "yes",
        source: "mackolik"
    }));
}

function normalizeSofaLiveEventsData(payload) {
    return normalizeSofaEventsData(payload);
}

function isLiveSofaEvent(event) {
    if (!event?.status) return false;
    if (event.status.type === "inprogress") return true;
    if (event.status.type === "live") return true;
    const desc = String(event.status.description || "").toUpperCase();
    const code = Number(event.status.code || 0);
    if (code >= 6 && code < 100) return true;
    return ["HT", "HALFTIME", "HALF TIME", "ET", "EXTRA TIME", "LIVE", "1ST HALF", "2ND HALF", "STARTED"].includes(desc) || desc.includes("'");
}

async function fetchLiveFromSofaScore() {
    const attempts = [
        ["SofaScore native live", fetchFromSofaNativeFast("/sport/football/events/live", {}, 3000), 3500],
        ["SofaScore proxy live", fetchFromSofaFastRace("/sport/football/events/live", {}, 6500), 7000],
        ["SofaScore queued live", fetchFromSofa("/sport/football/events/live").then(result => result.data), 8000],
        ["RapidAPI SofaScore live", fetchRapidApiSofaPath("/sport/football/events/live", {}, 9000), 9500],
        ["SofaScore scheduled live", fetchLiveFromScheduledFallback("live endpoint unavailable"), 18000]
    ];

    const normalizedAttempts = attempts.map(([name, promise, timeout]) =>
        withServerTimeout(promise, timeout, name)
            .then(data => ({ name, data: normalizeSofaLiveEventsData(data) }))
    );

    try {
        return await Promise.any(normalizedAttempts.map(promise => promise.then(({ name, data }) => {
        if (!Array.isArray(data?.events)) {
                throw new Error(`${name}: events array yoxdur`);
        }
        if (data.events.length > 0) {
            return {
                ...data,
                source: data.source || (name.includes("scheduled") ? "scheduled-live-fallback" : "sofascore")
            };
        }
            throw new Error(`${name}: empty`);
        })));
    } catch (nonEmptyError) {
        try {
            const firstValid = await Promise.any(normalizedAttempts.map(promise => promise.then(({ data }) => {
                if (!Array.isArray(data?.events)) throw new Error("events array yoxdur");
                return { ...data, source: data.source || "sofascore" };
            })));
            return firstValid;
        } catch (validError) {
            const reasons = nonEmptyError.errors?.map(error => error.message).join(" | ") ||
                validError.errors?.map(error => error.message).join(" | ") ||
                nonEmptyError.message ||
                validError.message;
            throw new Error(`SofaScore live unavailable: ${reasons || "no response"}`);
        }
    }
}

async function fetchLiveFromRapidApi() {
    const data = await fetchRapidApiSofaPath("/sport/football/events/live", {}, 12000);
    const normalized = normalizeSofaLiveEventsData(data);
    if (!Array.isArray(normalized.events)) {
        throw new Error("RapidAPI live response missing events array");
    }
    return {
        ...normalized,
        source: "rapidapi-sofascore",
        fallback: true
    };
}

function shouldTreatAsMackolikLivePayload(data) {
    return data?.source === "mackolik" || data?.source === "mackolik-push-fallback" ||
        (Array.isArray(data?.events) && data.events.some(event => event?.source === "mackolik"));
}

function normalizeLivePollPayload(data) {
    if (shouldTreatAsMackolikLivePayload(data)) {
        return {
            ...data,
            events: Array.isArray(data.events) ? data.events : [],
            source: data.source || "mackolik"
        };
    }
    return normalizeSofaLiveEventsData(data);
}

function getScoreOverlayKey(event) {
    const home = normalizeSearchName(event?.homeTeam?.name || event?.homeTeam?.shortName);
    const away = normalizeSearchName(event?.awayTeam?.name || event?.awayTeam?.shortName);
    if (!home || !away) return "";
    return `${home}|${away}`;
}

function isScoreOverlayTeamMatch(primaryName, mackolikName) {
    const a = normalizeSearchName(primaryName);
    const b = normalizeSearchName(mackolikName);
    if (!a || !b) return false;
    if (a === b) return true;

    const compactA = a.replace(/\s+/g, "");
    const compactB = b.replace(/\s+/g, "");
    if (compactA.length >= 4 && compactB.length >= 4 && (compactA.includes(compactB) || compactB.includes(compactA))) {
        return true;
    }

    const tokensA = new Set(a.split(/\s+/).filter(token => token.length >= 3));
    const tokensB = b.split(/\s+/).filter(token => token.length >= 3);
    if (!tokensA.size || !tokensB.length) return false;
    const overlap = tokensB.filter(token => tokensA.has(token)).length;
    return overlap > 0 && overlap / Math.min(tokensA.size, tokensB.length) >= 0.67;
}

function findMackolikOverlayMatch(primaryEvent, exactMap, mackolikEvents) {
    const exact = exactMap.get(getScoreOverlayKey(primaryEvent));
    if (exact) return exact;

    const homeName = primaryEvent?.homeTeam?.name || primaryEvent?.homeTeam?.shortName;
    const awayName = primaryEvent?.awayTeam?.name || primaryEvent?.awayTeam?.shortName;
    return mackolikEvents.find(event =>
        isScoreOverlayTeamMatch(homeName, event?.homeTeam?.name || event?.homeTeam?.shortName) &&
        isScoreOverlayTeamMatch(awayName, event?.awayTeam?.name || event?.awayTeam?.shortName)
    ) || null;
}

function applyMackolikScoreOverlay(primaryData, mackolikData) {
    const primaryEvents = Array.isArray(primaryData?.events) ? primaryData.events : [];
    const mackolikEvents = Array.isArray(mackolikData?.events) ? mackolikData.events : [];
    if (!primaryEvents.length || !mackolikEvents.length) return primaryData;

    const mackolikByKey = new Map();
    mackolikEvents.forEach(event => {
        const key = getScoreOverlayKey(event);
        if (key) mackolikByKey.set(key, event);
    });
    if (!mackolikByKey.size) return primaryData;

    let changed = 0;
    const events = primaryEvents.map(event => {
        const match = findMackolikOverlayMatch(event, mackolikByKey, mackolikEvents);
        if (!match) return event;
        const home = Number(match.homeScore?.current ?? event.homeScore?.current ?? 0);
        const away = Number(match.awayScore?.current ?? event.awayScore?.current ?? 0);
        const homeLogo = match.homeTeam?.logoUrl || event.homeTeam?.logoUrl;
        const awayLogo = match.awayTeam?.logoUrl || event.awayTeam?.logoUrl;
        const scoreChanged = home !== Number(event.homeScore?.current ?? 0) || away !== Number(event.awayScore?.current ?? 0);
        const logoChanged = homeLogo !== event.homeTeam?.logoUrl || awayLogo !== event.awayTeam?.logoUrl;
        if (!scoreChanged && !logoChanged) return event;
        changed++;
        return {
            ...event,
            homeTeam: {
                ...(event.homeTeam || {}),
                logoUrl: homeLogo,
                mackolikId: match.homeTeam?.id || event.homeTeam?.mackolikId || ""
            },
            awayTeam: {
                ...(event.awayTeam || {}),
                logoUrl: awayLogo,
                mackolikId: match.awayTeam?.id || event.awayTeam?.mackolikId || ""
            },
            homeScore: { ...(event.homeScore || {}), current: home },
            awayScore: { ...(event.awayScore || {}), current: away },
            mackolikMatchId: match.id || event.mackolikMatchId || "",
            mackolikSlug: match.slug || event.mackolikSlug || "",
            mackolikScoreOverlay: true,
            mackolikScoreUpdatedAt: new Date().toISOString()
        };
    });

    return changed ? {
        ...primaryData,
        events,
        source: `${primaryData.source || "sofascore"}+mackolik-score`,
        mackolikScoreOverlayCount: changed
    } : primaryData;
}

async function maybeApplyMackolikScoreOverlay(primaryData, timeoutMs = 1600) {
    if (!ENABLE_MACKOLIK_SCORE_OVERLAY) return primaryData;
    if (shouldTreatAsMackolikLivePayload(primaryData)) return primaryData;
    try {
        const mackolik = await withServerTimeout(fetchLiveFromMackolik(), timeoutMs, "Mackolik score overlay");
        return applyMackolikScoreOverlay(primaryData, mackolik);
    } catch (error) {
        return primaryData;
    }
}

function saveLivePollPayloadIfPublic(normalized, saveSnapshot) {
    if (!saveSnapshot || normalized?.pushOnly) return;
    if (SOFASCORE_ONLY_MODE && shouldTreatAsMackolikLivePayload(normalized)) return;
    if (shouldTreatAsMackolikLivePayload(normalized)) syncLiveMatchCache(normalized.events);
    globalLiveEvents = normalized;
    lastLiveFetchTime = Date.now();
    saveLiveSnapshot();
}

async function fetchMackolikPushFallback(primaryError) {
    if (!ENABLE_MACKOLIK_PUSH_FALLBACK) return null;
    try {
        const fallback = await fetchLiveFromMackolik();
        if (!Array.isArray(fallback.events) || fallback.events.length === 0) return null;

        const now = Date.now();
        if (now - lastPushFallbackLogAt > 60 * 1000) {
            console.warn(`[LIVE SCORE POLL] SofaScore unavailable for server push; using Mackolik push-only fallback (${fallback.events.length} live). UI cache is unchanged.`);
            lastPushFallbackLogAt = now;
        }

        return {
            ...fallback,
            source: "mackolik-push-fallback",
            pushOnly: true,
            primarySourceError: primaryError || ""
        };
    } catch (fallbackError) {
        console.warn(`[LIVE SCORE POLL] Push-only fallback failed: ${fallbackError.message}`);
        return null;
    }
}

const FLASHSCORE_FEED_URL = "https://www.flashscore.mobi/x/feed/f_1_0_3_en_1";

function normalizeFlashscoreName(value) {
    return String(value || "").trim();
}

function parseFlashscoreFeed(rawText) {
    const feedText = String(rawText || "")
        .replace(/\u00c2\u00ac/g, "¬")
        .replace(/\u00c3\u00b7/g, "÷");
    const sections = feedText.split("~");
    const events = [];
    let tournament = null;

    for (const section of sections) {
        if (!section) continue;
        const parts = section.split("¬");
        const fields = {};
        for (const part of parts) {
            const splitAt = part.indexOf("÷");
            if (splitAt <= 0) continue;
            fields[part.slice(0, splitAt)] = part.slice(splitAt + 1);
        }

        if (fields.ZA || fields.ZE || fields.ZEE) {
            const countryName = normalizeFlashscoreName(fields.ZY || fields.ZAF || fields.ZB || "");
            const tournamentName = normalizeFlashscoreName(fields.ZA || fields.ZE || fields.ZEE || "Football");
            tournament = {
                id: fields.ZEE || fields.ZC || fields.ZE || tournamentName,
                name: tournamentName,
                slug: String(tournamentName).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
                category: {
                    id: fields.ZC || countryName || "world",
                    name: countryName || "World",
                    slug: String(countryName || "world").toLowerCase().replace(/[^a-z0-9]+/g, "-")
                },
                logoUrl: fields.OAJ ? `https://static.flashscore.com/res/image/data/${fields.OAJ}.png` : null
            };
            continue;
        }

        if (!fields.AA || (!fields.AE && !fields.AF)) continue;

        const statusCode = Number(fields.AB || 0);
        const stateCode = Number(fields.AC || 0);
        let statusType = "notstarted";
        let statusDescription = "";
        let currentPeriodStartTimestamp = null;
        let initial = 0;

        if (statusCode === 2) {
            statusType = "inprogress";
            if (stateCode === 38 || fields.CR === "3") {
                statusDescription = "HT";
            } else if (fields.AO && Number.isFinite(Number(fields.AO))) {
                currentPeriodStartTimestamp = Number(fields.AO);
                if (stateCode === 13 || stateCode === 15) initial = 45 * 60;
                if (stateCode === 14) initial = 90 * 60;
                const elapsed = Math.max(0, Math.floor(Date.now() / 1000) - currentPeriodStartTimestamp);
                const minute = Math.max(1, Math.floor((elapsed + initial) / 60) + 1);
                statusDescription = minute > 90 && minute <= 130 ? `90+${minute - 90}'` : `${minute}'`;
            } else {
                statusDescription = "LIVE";
            }
        } else if (statusCode === 3) {
            statusType = "finished";
            statusDescription = "FT";
        }

        const homeScore = Number(fields.AG);
        const awayScore = Number(fields.AH);
        const safeHomeScore = Number.isFinite(homeScore) ? homeScore : 0;
        const safeAwayScore = Number.isFinite(awayScore) ? awayScore : 0;
        const startTimestamp = Number(fields.AD || 0) || Math.floor(Date.now() / 1000);
        const homeTeamId = fields.PX || fields.WU || `${fields.AA}-home`;
        const awayTeamId = fields.PY || fields.WV || `${fields.AA}-away`;

        events.push({
            id: `fs_${fields.AA}`,
            flashscoreId: fields.AA,
            source: "flashscore",
            slug: fields.WE || fields.AA,
            startTimestamp,
            status: { type: statusType, description: statusDescription },
            time: currentPeriodStartTimestamp ? { currentPeriodStartTimestamp, initial } : undefined,
            homeTeam: {
                id: homeTeamId,
                name: normalizeFlashscoreName(fields.AE || ""),
                shortName: normalizeFlashscoreName(fields.AE || ""),
                slug: fields.WU || "",
                logoUrl: fields.JA ? `https://static.flashscore.com/res/image/data/${fields.JA}.png` : null
            },
            awayTeam: {
                id: awayTeamId,
                name: normalizeFlashscoreName(fields.AF || ""),
                shortName: normalizeFlashscoreName(fields.AF || ""),
                slug: fields.WV || "",
                logoUrl: fields.JB ? `https://static.flashscore.com/res/image/data/${fields.JB}.png` : null
            },
            homeScore: { current: safeHomeScore, display: statusType === "notstarted" ? null : safeHomeScore },
            awayScore: { current: safeAwayScore, display: statusType === "notstarted" ? null : safeAwayScore },
            tournament: tournament || {
                id: "flashscore-football",
                name: "Football",
                category: { id: "world", name: "World" }
            }
        });
    }

    return {
        events,
        source: "flashscore",
        generatedAt: new Date().toISOString()
    };
}

function dateToFlashscoreOffset(date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ""))) return 0;
    const [year, month, day] = String(date).split("-").map(Number);
    const targetUtc = Date.UTC(year, month - 1, day);
    const now = new Date();
    const todayUtc = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
    return Math.round((targetUtc - todayUtc) / (24 * 60 * 60 * 1000));
}

async function fetchFlashscoreFeedByOffset(offset = 0) {
    const safeOffset = Number.isFinite(Number(offset)) ? Number(offset) : 0;
    const feedUrl = `https://www.flashscore.mobi/x/feed/f_1_${safeOffset}_3_en_1`;
    const response = await axios.get(feedUrl, {
        timeout: 3200,
        responseType: "text",
        transformResponse: [data => data],
        headers: {
            ...HEADERS,
            Accept: "*/*",
            Referer: "https://www.flashscore.com/",
            Origin: "https://www.flashscore.com",
            "X-Fsign": "SW9D1eZo",
            "User-Agent": getRandomUA()
        }
    });
    return parseFlashscoreFeed(response.data);
}

async function fetchLiveFromFlashscore() {
    const parsed = await fetchFlashscoreFeedByOffset(0);
    parsed.events = parsed.events.filter(event => String(event.status?.type || "").toLowerCase() === "inprogress");
    parsed.source = "flashscore";
    return parsed;
}

async function fetchMatchesFromFlashscoreByDate(date) {
    const offset = dateToFlashscoreOffset(date);
    const parsed = await fetchFlashscoreFeedByOffset(offset);
    parsed.events = parsed.events.sort((a, b) => Number(a.startTimestamp || 0) - Number(b.startTimestamp || 0));
    parsed.source = "flashscore-scheduled";
    parsed.matchDate = date;
    parsed.flashscoreOffset = offset;
    return parsed;
}

async function fetchLiveScoresForNotifications(options = {}) {
    const { allowPushFallback = true, saveSnapshot = true } = options;
    let primaryErrorMessage = "";
    try {
        if (FLASHSCORE_CANONICAL_MODE) {
            const normalized = await fetchLiveFromFlashscore();
            saveLivePollPayloadIfPublic(normalized, saveSnapshot);
            return normalized;
        }

        if (MACKOLIK_CANONICAL_MODE) {
            const normalized = await fetchLiveFromMackolik();
            saveLivePollPayloadIfPublic(normalized, saveSnapshot);
            return normalized;
        }

        const fastSources = SOFASCORE_ONLY_MODE
            ? [
                fetchLiveFromSofaScore()
            ]
            : [
                fetchFromSofaNativeFast("/sport/football/events/live", {}, 1800),
                fetchFromSofaFastRace("/sport/football/events/live", {}, 3200),
                fetchRapidApiSofaPath("/sport/football/events/live", {}, 4200),
                fetchLiveFromScheduledFallback("live-poll-fast-fallback")
            ];
        if (!SOFASCORE_ONLY_MODE && ENABLE_MACKOLIK_MATCHES) {
            fastSources.push(fetchLiveFromMackolik());
        }

        const data = await Promise.any(fastSources);
        let normalized = normalizeLivePollPayload(data);
        normalized = await maybeApplyMackolikScoreOverlay(normalized, 1400);
        if (Array.isArray(normalized.events)) {
            saveLivePollPayloadIfPublic(normalized, saveSnapshot);
            return normalized;
        }
    } catch (fastError) {
        primaryErrorMessage = fastError.errors?.map(error => error.message).join(" | ") || fastError.message;
        console.warn(`[LIVE SCORE POLL] Fast source failed: ${fastError.message}`);
    }

    if (allowPushFallback) {
        const pushFallback = await fetchMackolikPushFallback(primaryErrorMessage);
        if (pushFallback) return pushFallback;
    }

    return getLiveEventsData(true);
}

async function fetchLiveFromScheduledFallback(sourceError = "") {
    const now = Date.now();
    const dateCandidates = Array.from(new Set([
        new Date(now).toISOString().slice(0, 10),
        new Date(now + 4 * 60 * 60 * 1000).toISOString().slice(0, 10),
        new Date(now - 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
        new Date(now + 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    ]));
    const attempts = dateCandidates.flatMap(date => ([
        fetchFromSofaFastRace(`/sport/football/scheduled-events/${date}`, {}, 9000),
        fetchFromSofaFastRace(`/sport/football/scheduled-events/${date}/inverse`, {}, 9000),
        fetchRapidApiSofaPath(`/sport/football/scheduled-events/${date}`, {}, 12000),
        fetchRapidApiSofaPath(`/sport/football/scheduled-events/${date}/inverse`, {}, 12000)
    ]));
    const results = await Promise.allSettled(attempts);
    const eventsById = new Map();
    for (const result of results) {
        if (result.status !== "fulfilled") continue;
        const normalized = normalizeSofaEventsData(result.value?.data || result.value);
        normalized.events.filter(isLiveSofaEvent).forEach(event => {
            if (event?.id) eventsById.set(event.id.toString(), event);
        });
    }
    const liveEvents = Array.from(eventsById.values());
    if (!liveEvents.length) {
        throw new Error("Scheduled fallback returned no live events");
    }
    return {
        events: liveEvents,
        source: "scheduled-live-fallback",
        fallback: true,
        primarySourceError: sourceError
    };
}

async function fetchScheduledFromSofaScore(date) {
    const attempts = await Promise.allSettled([
        fetchFromSofaFastRace(`/sport/football/scheduled-events/${date}`, {}, 9000),
        fetchFromSofaFastRace(`/sport/football/scheduled-events/${date}/inverse`, {}, 9000),
        fetchFromSofa(`/sport/football/scheduled-events/${date}`),
        fetchFromSofa(`/sport/football/scheduled-events/${date}/inverse`).catch(() => null)
    ]);
    const eventsById = new Map();
    let firstMeta = null;
    for (const attempt of attempts) {
        if (attempt.status !== "fulfilled" || !attempt.value) continue;
        const normalized = normalizeSofaEventsData(attempt.value?.data || attempt.value);
        if (!firstMeta && normalized) firstMeta = normalized;
        (normalized.events || []).forEach(event => {
            if (event?.id) eventsById.set(event.id.toString(), event);
        });
    }
    const events = Array.from(eventsById.values()).sort((a, b) => (a.startTimestamp || 0) - (b.startTimestamp || 0));
    if (!events.length) {
        throw new Error("SofaScore scheduled response missing events array");
    }
    return {
        ...(firstMeta || {}),
        events,
        source: "sofascore-scheduled-merged"
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
        timeout: 4500
    });

    if (response.data?.status !== "success") {
        throw new Error(`Mackolik live request failed: ${response.data?.status || "unknown"}`);
    }

    const normalized = normalizeMackolikMatchesData(response.data, { liveOnly: true });
    normalized.matchDate = config.matchDate;
    return normalized;
}

async function fetchLiveWithFallback() {
    if (FLASHSCORE_CANONICAL_MODE) {
        return await fetchLiveFromFlashscore();
    }

    if (MACKOLIK_CANONICAL_MODE) {
        return await fetchLiveFromMackolik();
    }

    const errors = [];
    const trySource = async (name, fetchFn) => {
        try {
            const data = await fetchFn();
            if (Array.isArray(data?.events) && data.events.length > 0) {
                if (errors.length) {
                    data.primarySourceError = errors.join(" | ");
                    data.fallback = true;
                }
                return data;
            }
            errors.push(`${name}: empty`);
        } catch (error) {
            errors.push(`${name}: ${error.message}`);
            // Sadece ciddi xetalarÄ± logla (403/timeout cox olanda logu doldurmasÄ±n)
            if (!error.message.includes("403") && !error.message.includes("timeout")) {
                console.warn(`[LIVE SOURCE] ${name} failed: ${error.message}`);
            }
        }
        return null;
    };

    const sources = SOFASCORE_ONLY_MODE
        ? [["SofaScore live", fetchLiveFromSofaScore]]
        : (LIVE_PRIMARY_SOURCE === "mackolik" && ENABLE_MACKOLIK_MATCHES
            ? [
                ["Mackolik", fetchLiveFromMackolik],
                ["SofaScore live", fetchLiveFromSofaScore],
                ["RapidAPI live", fetchLiveFromRapidApi],
                ["Scheduled live", () => fetchLiveFromScheduledFallback(errors.join(" | "))]
            ]
            : [
                ["SofaScore live", fetchLiveFromSofaScore],
                ["RapidAPI live", fetchLiveFromRapidApi],
                ["Scheduled live", () => fetchLiveFromScheduledFallback(errors.join(" | "))]
            ]);

    if (ALLOW_MACKOLIK_FALLBACK && ENABLE_MACKOLIK_MATCHES && LIVE_PRIMARY_SOURCE !== "mackolik") {
        sources.push(["Mackolik", fetchLiveFromMackolik]);
    }

    for (const [name, fetchFn] of sources) {
        const data = await trySource(name, fetchFn);
        if (data) return data;
    }

    throw new Error(errors.join(" | ") || "All live sources failed");
}

async function fetchMackolikMatchesByDate(matchDate) {
    const response = await axios.get(MACKOLIK_LIVE_URL, {
        params: {
            sports: ["Soccer"],
            matchDate
        },
        headers: MACKOLIK_HEADERS,
        timeout: 6500
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
        timeMin: rawTime,
        minuteText: rawTime,
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

function containsMackolikLiveData(payload) {
    const events = Array.isArray(payload?.events) ? payload.events : [];
    return events.some(event => {
        if (String(event?.source || "").toLowerCase() === "mackolik") return true;
        const logoFields = [
            event?.homeTeam?.logoUrl,
            event?.awayTeam?.logoUrl,
            event?.tournament?.logoUrl,
            event?.tournament?.category?.logoUrl,
            event?.tournament?.uniqueTournament?.logoUrl
        ];
        return logoFields.some(value => String(value || "").includes("mackolikfeeds.com"));
    });
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

function parseMackolikStatNumber(value) {
    if (value === null || value === undefined || value === "") return NaN;
    if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
    if (typeof value === "string") {
        const normalized = value.replace(",", ".");
        const match = normalized.match(/-?\d+(?:\.\d+)?/);
        return match ? Number(match[0]) : NaN;
    }
    if (typeof value === "object") {
        const candidates = [
            value.value,
            value.displayValue,
            value.display,
            value.home,
            value.homeValue,
            value.local,
            value[0]
        ];
        for (const candidate of candidates) {
            const parsed = parseMackolikStatNumber(candidate);
            if (Number.isFinite(parsed)) return parsed;
        }
    }
    return NaN;
}

function parseMackolikStatPair(homeValue, awayValue) {
    if (Array.isArray(homeValue)) {
        return {
            home: parseMackolikStatNumber(homeValue[0]),
            away: parseMackolikStatNumber(homeValue[1])
        };
    }

    if (homeValue && typeof homeValue === "object") {
        const homeCandidate = homeValue.home ?? homeValue.homeValue ?? homeValue.local ?? homeValue[0] ?? homeValue.value;
        const awayCandidate = homeValue.away ?? homeValue.awayValue ?? homeValue.visitor ?? homeValue.guest ?? homeValue[1];
        const parsedHome = parseMackolikStatNumber(homeCandidate);
        const parsedAway = parseMackolikStatNumber(awayCandidate);
        if (Number.isFinite(parsedHome) || Number.isFinite(parsedAway)) {
            return { home: parsedHome, away: parsedAway };
        }
    }

    const combined = [homeValue, awayValue]
        .filter(value => value !== null && value !== undefined)
        .map(value => typeof value === "string" ? value : "")
        .join(" ");
    const combinedNumbers = combined.match(/\d+(?:[.,]\d+)?/g);
    if (combinedNumbers && combinedNumbers.length >= 2) {
        return {
            home: parseMackolikStatNumber(combinedNumbers[0]),
            away: parseMackolikStatNumber(combinedNumbers[1])
        };
    }

    return {
        home: parseMackolikStatNumber(homeValue),
        away: parseMackolikStatNumber(awayValue)
    };
}

function formatMackolikStatValue(value) {
    const parsed = parseMackolikStatNumber(value);
    if (Number.isFinite(parsed)) return Number.isInteger(parsed) ? String(parsed) : String(Number(parsed.toFixed(1)));
    if (value === null || value === undefined || value === "") return "0";
    return String(value);
}

function hasMackolikStatValue(value) {
    return value !== null && value !== undefined && value !== "" && Number.isFinite(parseMackolikStatNumber(value));
}

function mergeMackolikStatItem(homeStats, awayStats, item) {
    if (!item || typeof item !== "object") return;
    const key = item.key || item.name || item.type || item.statName || item.title;
    if (!key) return;
    const pair = parseMackolikStatPair(
        item.home ?? item.homeValue ?? item.local ?? item.value ?? item.values,
        item.away ?? item.awayValue ?? item.visitor ?? item.guest
    );
    if (Number.isFinite(pair.home)) homeStats[key] = pair.home;
    if (Number.isFinite(pair.away)) awayStats[key] = pair.away;
}

function normalizeMackolikGameStatsPayload(payload = {}) {
    const source = payload?.data || payload || {};
    const homeStats = { ...(source.home || {}) };
    const awayStats = { ...(source.away || {}) };
    const statArrays = [
        source.stats,
        source.statistics,
        source.statisticsItems,
        source.items,
        source.gameStats,
        source.matchStats
    ].filter(Array.isArray);
    statArrays.flat().forEach(item => mergeMackolikStatItem(homeStats, awayStats, item));

    ["possesionPercentage", "possessionPercentage"].forEach(key => {
        const pair = parseMackolikStatPair(homeStats[key], awayStats[key]);
        const homeValue = pair.home;
        const awayValue = pair.away;
        if (Number.isFinite(homeValue) && !Number.isFinite(awayValue) && homeValue > 0 && homeValue < 100) {
            awayStats[key] = Math.max(0, 100 - homeValue);
        } else if (!Number.isFinite(homeValue) && Number.isFinite(awayValue) && awayValue > 0 && awayValue < 100) {
            homeStats[key] = Math.max(0, 100 - awayValue);
        } else if (Number.isFinite(homeValue) && Number.isFinite(awayValue)) {
            homeStats[key] = homeValue;
            awayStats[key] = awayValue;
        }
    });

    const statKeys = [...new Set([...Object.keys(homeStats), ...Object.keys(awayStats)])];
    return statKeys
        .filter(key => hasMackolikStatValue(homeStats[key]) && hasMackolikStatValue(awayStats[key]))
        .filter(key => {
            const home = parseMackolikStatNumber(homeStats[key]);
            const away = parseMackolikStatNumber(awayStats[key]);
            const missingWhenZero = ["possesionPercentage", "possessionPercentage", "totalPasses", "accuratePasses"];
            return !(missingWhenZero.includes(key) && home === 0 && away === 0);
        })
        .map(key => ({
            name: formatMackolikStatName(key),
            homeValue: formatMackolikStatValue(homeStats[key]),
            awayValue: formatMackolikStatValue(awayStats[key])
        }));
}

async function fetchMackolikGameStats(matchId, slug = "") {
    const safeSlug = slug || "mac";
    const response = await axios.get("https://www.mackolik.com/ajax/soccer/match/gameStats", {
        params: { matchId },
        headers: {
            ...MACKOLIK_HEADERS,
            Referer: `https://www.mackolik.com/mac/${safeSlug}/${matchId}`
        },
        timeout: 2800
    });
    if (response.data?.status && response.data.status !== "success") {
        throw new Error(`Mackolik stats failed: ${response.data.status}`);
    }
    return response.data?.data || response.data;
}

async function fetchMackolikKeyEvents(matchId, slug = "") {
    const safeSlug = slug || "mac";
    const response = await axios.get("https://www.mackolik.com/ajax/football/key-events", {
        params: {
            ajaxViewName: "Football_Match_KeyEvents",
            matchId
        },
        headers: {
            ...MACKOLIK_HEADERS,
            Referer: `https://www.mackolik.com/mac/${safeSlug}/${matchId}`
        },
        timeout: 2800
    });
    if (response.data?.status && response.data.status !== "success") {
        throw new Error(`Mackolik key events failed: ${response.data.status}`);
    }
    const payload = response.data?.data || response.data || {};
    return Array.isArray(payload.keyEvents) ? payload.keyEvents : [];
}

function buildMackolikDetailsPayload(keyEvents = [], statsSource = {}) {
    const incidents = (Array.isArray(keyEvents) ? keyEvents : []).map(mapMackolikIncident).filter(Boolean);
    const statisticsItems = normalizeMackolikGameStatsPayload(statsSource || {});

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

async function fetchMackolikMatchDetails(matchId, slug = "", options = {}) {
    const safeSlug = slug || "mac";
    const url = `https://www.mackolik.com/mac/${safeSlug}/${matchId}`;
    const freshStatsPromise = fetchMackolikGameStats(matchId, safeSlug).catch(() => null);
    let gameStatsSettings = null;
    let keyEvents = await fetchMackolikKeyEvents(matchId, safeSlug).catch(() => []);

    if (options.fast) {
        const freshStats = await freshStatsPromise;
        return buildMackolikDetailsPayload(keyEvents, freshStats || {});
    }

    if (!keyEvents.length) {
        const response = await axios.get(url, {
            headers: {
                "User-Agent": MACKOLIK_HEADERS["User-Agent"],
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
            },
            timeout: 4500
        }).catch(() => null);

        const settingsObjects = extractMackolikSettingsObjects(response?.data || "");
        const keyEventsSettings = settingsObjects.find(obj => obj?.url?.includes("/ajax/football/key-events"));
        gameStatsSettings = settingsObjects.find(obj => obj?.url?.includes("/ajax/soccer/match/gameStats"));

        keyEvents = Array.isArray(keyEventsSettings?.keyEvents) ? keyEventsSettings.keyEvents : [];
        if (!keyEvents.length && keyEventsSettings?.url && keyEventsSettings?.asyncRequestParams) {
            const keyEventsResponse = await axios.get(keyEventsSettings.url, {
                params: keyEventsSettings.asyncRequestParams,
                headers: MACKOLIK_HEADERS,
                timeout: 2500
            }).catch(() => null);
            const keyPayload = keyEventsResponse?.data?.data || keyEventsResponse?.data || {};
            keyEvents = Array.isArray(keyPayload.keyEvents) ? keyPayload.keyEvents : [];
        }
    }

    const freshStats = await freshStatsPromise;
    return buildMackolikDetailsPayload(keyEvents, freshStats || gameStatsSettings || {});
}

function loadLiveSnapshot() {
    try {
        if (!fs.existsSync(LIVE_SNAPSHOT_FILE)) return;
        const snapshot = JSON.parse(fs.readFileSync(LIVE_SNAPSHOT_FILE, "utf-8"));
        if (snapshot?.data?.events && Array.isArray(snapshot.data.events)) {
            const snapshotAge = Date.now() - Number(snapshot.timestamp || 0);
            const source = String(snapshot.data.source || "").toLowerCase();
            const hasMackolikEvents = containsMackolikLiveData(snapshot.data);
            if (SOFASCORE_ONLY_MODE && source && source !== "sofascore") {
                console.log(`[LIVE SNAPSHOT] Ignoring ${source} disk cache; Sofascore-only mode is active.`);
                return;
            }
            if (SOFASCORE_ONLY_MODE && hasMackolikEvents) {
                console.log("[LIVE SNAPSHOT] Ignoring disk cache with Mackolik events.");
                return;
            }
            if (MACKOLIK_CANONICAL_MODE && source && source !== "mackolik" && !hasMackolikEvents) {
                console.log(`[LIVE SNAPSHOT] Ignoring ${source} disk cache; Mackolik canonical mode is active.`);
                return;
            }
            // Snapshot age yoxlanÄ±ÅŸÄ±nÄ± yumÅŸaldÄ±rÄ±q - 12 saata qÉ™dÉ™r icazÉ™ veririk
            // Ã§Ã¼nki heÃ§ olmasa kÃ¶hnÉ™ mÉ™lumatÄ±n olmasÄ± sÄ±fÄ±r mÉ™lumatdan yaxÅŸÄ±dÄ±r.
            if (!Number.isFinite(snapshotAge) || snapshotAge > LIVE_DISK_SNAPSHOT_MAX_AGE) {
                console.log("[LIVE SNAPSHOT] Ignoring stale disk cache.");
                return;
            }
            globalLiveEvents = snapshot.data;
            lastLiveFetchTime = snapshot.timestamp || 0;
            
            // matchCache-i dÉ™ snapshot-dan doldururuq ki, ilk saniyÉ™lÉ™rdÉ™ sayt boÅŸ olmasÄ±n
            if (Array.isArray(globalLiveEvents.events)) {
                globalLiveEvents.events.forEach(match => {
                    if (match.id) matchCache[String(match.id)] = match;
                });
                console.log(`[LIVE SNAPSHOT] Seeded matchCache with ${globalLiveEvents.events.length} events.`);
            }
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
            const snapshotAge = Date.now() - Number(data.timestamp || 0);
            const source = String(data.payload.source || "").toLowerCase();
            const hasMackolikEvents = containsMackolikLiveData(data.payload);
            if (SOFASCORE_ONLY_MODE && source && source !== "sofascore") {
                console.log(`[LIVE SNAPSHOT] Ignoring ${source} Firestore cache; Sofascore-only mode is active.`);
                return false;
            }
            if (SOFASCORE_ONLY_MODE && hasMackolikEvents) {
                console.log("[LIVE SNAPSHOT] Ignoring Firestore cache with Mackolik events.");
                return false;
            }
            if (MACKOLIK_CANONICAL_MODE && source && source !== "mackolik" && !hasMackolikEvents) {
                console.log(`[LIVE SNAPSHOT] Ignoring ${source} Firestore cache; Mackolik canonical mode is active.`);
                return false;
            }
            if (!Number.isFinite(snapshotAge) || snapshotAge > LIVE_DISK_SNAPSHOT_MAX_AGE) {
                console.log("[LIVE SNAPSHOT] Ignoring stale Firestore cache.");
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
        if (SOFASCORE_ONLY_MODE && containsMackolikLiveData(globalLiveEvents)) {
            console.log("[LIVE SNAPSHOT] Skipping save with Mackolik data in Sofascore-only mode.");
            return;
        }
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
    { id: 17015, name: "UEFA Conference League", category: { id: 1465, name: "Europe" } },
    { id: 17, name: "Premier League", category: { id: 1, name: "England" } },
    { id: 8, name: "LaLiga", category: { id: 32, name: "Spain" } },
    { id: 23, name: "Serie A", category: { id: 31, name: "Italy" } },
    { id: 35, name: "Bundesliga", category: { id: 30, name: "Germany" } },
    { id: 34, name: "Ligue 1", category: { id: 7, name: "France" } },
    { id: 52, name: "Super Lig", category: { id: 46, name: "Turkey" } },
    { id: 709, name: "AzÉ™rbaycan Premyer LiqasÄ±", category: { id: 297, name: "Azerbaijan" }, season: { id: 78700 } }
];

const KNOWN_CURRENT_SEASONS = {
    7: 76953,   // UEFA Champions League 25/26
    17015: 76960, // UEFA Conference League 25/26
    17: 76986,  // Premier League 25/26
    8: 77559,   // LaLiga 25/26
    23: 76457,  // Serie A 25/26
    35: 77333,  // Bundesliga 25/26
    34: 77356,  // Ligue 1 25/26
    52: 77805,  // Super Lig 25/26
    709: 78700, // AzÉ™rbaycan Premyer LiqasÄ± 25/26
    736: 81188, // AzÉ™rbaycan Birinci Liqa 25/26
    21050: 79799, // AzÉ™rbaycan Ä°kinci Liqa 25/26
    20077: 84274, // AzÉ™rbaycan Regional League 25/26
    679: 76984  // UEFA Europa League 25/26
};

const TOP_PLAYER_FALLBACK_SEASONS = {
    7: [61644, 41897, 29267] // Champions League recent seasons; current stats can be 403-limited
};

const TEAM_INFO_TTL = 12 * 60 * 60 * 1000;
const TEAM_PLAYERS_TTL = 30 * 60 * 1000;

const ESPN_STANDINGS_LEAGUES = {
    7: "uefa.champions",
    679: "uefa.europa",
    17015: "uefa.europa.conf",
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
let topPlayersWarmIndex = 0;
let categoryWarmIndex = 0;
let runtimeWarmupInFlight = false;
let lastRuntimeWarmupAt = 0;
let lastRuntimeWarmupResult = null;
let selfPingInFlight = false;

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

function getFallbackStanding(tourId, seasonId, options = {}) {
    const item = FALLBACK_STANDINGS[String(tourId)];
    const data = item?.data || null;
    if (!data?.standings?.length) return null;
    if (!options.allowSeasonMismatch && seasonId && data.seasonId && String(data.seasonId) !== String(seasonId)) return null;
    return data;
}

function findCachedStandingEntry(tourId, seasonId = null) {
    const id = String(tourId);
    const requestedSeason = seasonId && /^\d+$/.test(String(seasonId)) ? String(seasonId) : null;
    const exactKey = requestedSeason ? `standings_${id}_${requestedSeason}` : null;
    if (exactKey && cache[exactKey]?.data?.standings?.length) {
        return { key: exactKey, seasonId: requestedSeason, data: cache[exactKey].data, staleSeason: false };
    }

    const cached = Object.entries(cache).find(([key, value]) =>
        key.startsWith(`standings_${id}_`) &&
        value?.data?.standings?.length
    );
    if (!cached) return null;

    const cachedSeasonId = cached[0].split("_").pop();
    return {
        key: cached[0],
        seasonId: cachedSeasonId,
        data: cached[1].data,
        staleSeason: !!(requestedSeason && cachedSeasonId && String(cachedSeasonId) !== requestedSeason)
    };
}

function buildTopPlayersFromStandingData(tournamentId, seasonId, standingData, meta = {}) {
    if (!standingData?.standings?.length) return null;

    const playersByTeam = new Map();
    for (const standing of standingData.standings) {
        const rows = Array.isArray(standing?.rows) ? standing.rows : [];
        for (const row of rows) {
            const goals = Number(row?.scoresFor ?? row?.goalsFor ?? row?.for ?? row?.pointsFor ?? 0);
            const team = row?.team || {};
            const teamName = team.name || team.shortName;
            if (!teamName || !Number.isFinite(goals) || goals <= 0) continue;
            const key = team.id ? `team_${team.id}` : `team_${String(teamName).toLowerCase()}`;
            const current = playersByTeam.get(key);
            const item = current || {
                player: {
                    id: team.id ? `team-${team.id}` : key,
                    name: teamName,
                    shortName: team.shortName || teamName
                },
                team: team.id ? {
                    id: team.id,
                    name: team.name || teamName,
                    shortName: team.shortName || teamName,
                    logoUrl: team.logoUrl || null
                } : { name: teamName, shortName: team.shortName || teamName },
                statistics: { goals: 0 },
                goals: 0,
                synthetic: true
            };
            item.statistics.goals = Math.max(item.statistics.goals || 0, goals);
            item.goals = item.statistics.goals;
            playersByTeam.set(key, item);
        }
    }

    const goals = Array.from(playersByTeam.values())
        .sort((a, b) => (b.statistics?.goals || 0) - (a.statistics?.goals || 0) || String(a.player?.name || "").localeCompare(String(b.player?.name || "")))
        .slice(0, 50);

    if (!goals.length) return null;
    return {
        topPlayers: { goals },
        source: "standings-goals-fallback",
        derived: true,
        seasonId: meta.seasonId || standingData.seasonId || seasonId || "snapshot"
    };
}

function buildTopPlayersFromStandingsFallback(tournamentId, seasonId) {
    const cachedStanding = findCachedStandingEntry(tournamentId, seasonId);
    const fallbackStanding = getFallbackStanding(tournamentId, seasonId) ||
        getFallbackStanding(tournamentId, seasonId, { allowSeasonMismatch: true });
    const standingData = cachedStanding?.data || fallbackStanding;
    return buildTopPlayersFromStandingData(tournamentId, seasonId, standingData, {
        seasonId: cachedStanding?.seasonId || standingData?.seasonId
    });
}

async function fetchTopPlayersFromStandingsFallback(tournamentId, seasonId, options = {}) {
    const cached = buildTopPlayersFromStandingsFallback(tournamentId, seasonId);
    if (hasTopPlayers(cached) || !options.fetchFresh || !/^\d+$/.test(String(seasonId || ""))) return cached;

    try {
        const timeout = Number(options.timeout || 2600);
        const standingData = await Promise.any([
            fetchFromSofaApiDirect(`/unique-tournament/${tournamentId}/season/${seasonId}/standings/total`, {}, timeout),
            fetchFromSofaNativeFast(`/unique-tournament/${tournamentId}/season/${seasonId}/standings/total`, {}, timeout),
            fetchFromSofaFastRace(`/unique-tournament/${tournamentId}/season/${seasonId}/standings/total`, {}, timeout + 1000)
        ]);
        if (standingData?.standings?.length) {
            saveStandingSnapshot(`standings_${tournamentId}_${seasonId}`, standingData);
            cache[`standings_${tournamentId}_${seasonId}`] = { data: standingData, timestamp: Date.now() };
            return buildTopPlayersFromStandingData(tournamentId, seasonId, standingData, { seasonId });
        }
    } catch (error) {
        console.warn(`[Top Players] Standings fallback failed for ${tournamentId}/${seasonId}: ${error.message}`);
    }

    return null;
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

function saveCategoryTournamentsSnapshot(categoryId, data) {
    if (!data) return;
    try {
        let parsed = { generatedAt: new Date().toISOString(), source: "runtime-category-unique-tournaments", items: {} };
        if (fs.existsSync(FOOTBALL_CATEGORY_TOURNAMENTS_SNAPSHOT_FILE)) {
            try { parsed = JSON.parse(fs.readFileSync(FOOTBALL_CATEGORY_TOURNAMENTS_SNAPSHOT_FILE, "utf8")); } catch (_) {}
        }
        parsed.items = parsed.items || {};
        const category = data.category || FALLBACK_CATEGORIES.find(cat => String(cat.id) === String(categoryId)) || null;
        parsed.items[String(categoryId)] = {
            category,
            data,
            timestamp: Date.now()
        };
        fs.writeFileSync(FOOTBALL_CATEGORY_TOURNAMENTS_SNAPSHOT_FILE, JSON.stringify(parsed));
        FALLBACK_CATEGORY_TOURNAMENTS[String(categoryId)] = parsed.items[String(categoryId)];
    } catch (error) {
        console.warn(`[Category Snapshot Save] ${categoryId}: ${error.message}`);
    }
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

function collectStandingTeamImageUrls(data) {
    const rows = data?.standings?.flatMap(standing => standing.rows || []) || [];
    return rows
        .map(row => row?.team?.logoUrl || null)
        .filter(Boolean);
}

function warmStandingTeamImages(data, limit = 32) {
    return Promise.allSettled([
        warmImagePaths(collectStandingTeamImagePaths(data), limit),
        warmExternalImageUrls(collectStandingTeamImageUrls(data), limit)
    ]);
}

function collectTopPlayerImagePaths(data) {
    const list = extractTopPlayersList(data);
    if (!Array.isArray(list)) return [];
    return list.flatMap(item => [
        item?.player?.id ? `/player/${item.player.id}/image` : null,
        item?.team?.id ? `/team/${item.team.id}/image` : null
    ]).filter(Boolean);
}

function warmTopPlayerImages(data, limit = 28) {
    return warmImagePaths(collectTopPlayerImagePaths(data), limit);
}

function addTeamToMap(map, team) {
    if (!team?.id && !team?.name) return;
    const key = team.id ? `id_${team.id}` : `name_${String(team.name || team.shortName || "").toLowerCase()}`;
    if (!key || map.has(key)) return;
    map.set(key, {
        id: team.id,
        name: team.name || team.shortName || "Komanda",
        shortName: team.shortName || team.name || "Komanda",
        slug: team.slug || "",
        logoUrl: team.logoUrl || null,
        country: team.country || null,
        teamColors: team.teamColors || null
    });
}

function extractTeamsFromPayload(payload) {
    const teams = new Map();
    const rawTeams = payload?.teams || payload?.uniqueTournamentTeams || payload?.data?.teams || [];
    if (Array.isArray(rawTeams)) {
        rawTeams.forEach(item => addTeamToMap(teams, item.team || item));
    }
    const events = payload?.events || payload?.data?.events || [];
    if (Array.isArray(events)) {
        events.forEach(event => {
            addTeamToMap(teams, event.homeTeam);
            addTeamToMap(teams, event.awayTeam);
        });
    }
    return Array.from(teams.values());
}

async function fetchTournamentTeamsFallback(tournamentId, seasonId) {
    const attempts = [
        fetchFromSofaFastRace(`/unique-tournament/${tournamentId}/season/${seasonId}/teams`, {}, 4500),
        fetchFromSofaNativeFast(`/unique-tournament/${tournamentId}/season/${seasonId}/teams`, {}, 3000),
        fetchFromSofaFastRace(`/unique-tournament/${tournamentId}/season/${seasonId}/events/last/0`, {}, 4500),
        fetchFromSofaFastRace(`/unique-tournament/${tournamentId}/season/${seasonId}/events/last/1`, {}, 4500),
        fetchFromSofaFastRace(`/unique-tournament/${tournamentId}/season/${seasonId}/events/next/0`, {}, 4500)
    ].map(promise => promise.catch(() => null));

    const results = await Promise.all(attempts);
    const teams = new Map();
    results.forEach(payload => {
        extractTeamsFromPayload(payload).forEach(team => addTeamToMap(teams, team));
    });
    return Array.from(teams.values())
        .sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "az"))
        .slice(0, 80);
}

function extractTopPlayersList(data) {
    if (!data) return [];
    if (data.data) {
        const nested = extractTopPlayersList(data.data);
        if (nested.length) return nested;
    }
    if (Array.isArray(data)) return data;
    if (Array.isArray(data.topPlayers)) return data.topPlayers;
    if (Array.isArray(data.players)) return data.players;
    if (Array.isArray(data.results)) return data.results;
    const topPlayers = data.topPlayers || {};
    if (Array.isArray(topPlayers.goals)) return topPlayers.goals;
    if (Array.isArray(topPlayers.scoring)) return topPlayers.scoring;
    if (Array.isArray(topPlayers.rating)) return topPlayers.rating;
    if (topPlayers && typeof topPlayers === "object") {
        const firstList = Object.values(topPlayers).find(Array.isArray);
        if (firstList) return firstList;
    }
    return [];
}

function extractGoalTopPlayersList(data) {
    if (!data) return [];
    if (data.data) {
        const nested = extractGoalTopPlayersList(data.data);
        if (nested.length) return nested;
    }
    if (Array.isArray(data)) return data;
    const topPlayers = data.topPlayers || {};
    const direct = data.goals || data.scoring || data.topScorers || data.players || data.results;
    if (Array.isArray(direct)) return direct;
    if (Array.isArray(topPlayers.goals)) return topPlayers.goals;
    if (Array.isArray(topPlayers.scoring)) return topPlayers.scoring;
    if (Array.isArray(topPlayers.topScorers)) return topPlayers.topScorers;
    return [];
}

function hasTopPlayers(data) {
    return extractTopPlayersList(data).length > 0 || extractGoalTopPlayersList(data).length > 0;
}

function getTopPlayerGoalValue(item = {}) {
    const candidates = [
        item.goals,
        item.totalGoals,
        item.value,
        item.statistic,
        item.statistics?.goals,
        item.statistics?.totalGoals,
        item.statistics?.goal,
        item.stat?.goals,
        item.stat?.value
    ];
    for (const value of candidates) {
        const number = Number(value);
        if (Number.isFinite(number) && number > 0) return number;
    }
    if (Array.isArray(item.statistics)) {
        const stat = item.statistics.find(entry => {
            const key = String(entry?.name || entry?.key || entry?.type || "").toLowerCase();
            return key.includes("goal") || key === "g";
        });
        const number = Number(stat?.value || stat?.statistic || stat?.total);
        if (Number.isFinite(number) && number > 0) return number;
    }
    return 0;
}

function normalizeGoalTopPlayers(items = []) {
    return (Array.isArray(items) ? items : [])
        .map(item => {
            const goals = getTopPlayerGoalValue(item);
            const player = item.player || item;
            return {
                ...item,
                player: player?.id || player?.name ? player : item.player,
                team: item.team || player?.team,
                statistics: {
                    ...(item.statistics && !Array.isArray(item.statistics) ? item.statistics : {}),
                    goals
                },
                goals
            };
        })
        .filter(item => getTopPlayerGoalValue(item) > 0)
        .sort((a, b) => getTopPlayerGoalValue(b) - getTopPlayerGoalValue(a));
}

function extractSearchTeams(data) {
    const buckets = [
        data?.results,
        data?.entities,
        data?.teams,
        data?.data?.results,
        data?.data?.entities,
        Array.isArray(data) ? data : null
    ].filter(Array.isArray);
    return buckets.flatMap(items => items)
        .map(item => item?.entity || item?.team || item)
        .filter(item => item?.id && (item.type === 0 || item.type === "team" || item.entityType === "team" || item.name || item.shortName));
}

function normalizeSearchName(value) {
    return String(value || "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/\b(fc|fk|cf|sk|sc|afc|club|futbol|football)\b/g, "")
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
}

function pickBestSearchTeam(teams, query) {
    const target = normalizeSearchName(query);
    if (!target) return null;
    return teams.find(team => {
        const name = normalizeSearchName(team.name || team.shortName);
        return name === target || name.includes(target) || target.includes(name);
    }) || teams[0] || null;
}

function addUniqueSeasonId(candidates, seasonId) {
    if (!seasonId) return;
    const normalized = String(seasonId);
    if (!candidates.includes(normalized)) candidates.push(normalized);
}

function getPrimaryTopPlayerSeasonIds(tournamentId, requestedSeasonId) {
    const candidates = [];
    if (/^\d+$/.test(String(requestedSeasonId || ""))) {
        addUniqueSeasonId(candidates, requestedSeasonId);
    }
    addUniqueSeasonId(candidates, KNOWN_CURRENT_SEASONS[tournamentId]);
    (TOP_PLAYER_FALLBACK_SEASONS[tournamentId] || []).forEach(seasonId => addUniqueSeasonId(candidates, seasonId));
    return candidates;
}

async function getFallbackTopPlayerSeasonIds(tournamentId, existingCandidates = [], options = {}) {
    const candidates = [...existingCandidates];
    const addCandidate = (seasonId) => {
        addUniqueSeasonId(candidates, seasonId);
    };
    const cachedStanding = findCachedStandingEntry(tournamentId);
    addCandidate(cachedStanding?.seasonId);
    addCandidate(getFallbackStanding(tournamentId, null, { allowSeasonMismatch: true })?.seasonId);
    if (options.fast && candidates.length > existingCandidates.length) {
        return candidates;
    }

    try {
        const data = await getCachedData(`seasons_unique-tournament_${tournamentId}`, async () => {
            return await Promise.any([
                fetchFromSofaApiDirect(`/unique-tournament/${tournamentId}/seasons`, {}, 2600),
                fetchFromSofaNativeFast(`/unique-tournament/${tournamentId}/seasons`, {}, 3200),
                fetchFromSofaFastRace(`/unique-tournament/${tournamentId}/seasons`, {}, 5200)
            ]);
        }, CACHE_TIMES.STATIC, { skipJitter: true });
        const seasons = Array.isArray(data?.seasons) ? data.seasons : [];
        const currentYear = new Date().getFullYear();
        seasons
            .slice()
            .sort((a, b) => {
                const aCurrent = a.isCurrent || a.current || a.editor || Number(a.year) === currentYear ? 1 : 0;
                const bCurrent = b.isCurrent || b.current || b.editor || Number(b.year) === currentYear ? 1 : 0;
                if (aCurrent !== bCurrent) return bCurrent - aCurrent;
                return Number(b.year || b.id || 0) - Number(a.year || a.id || 0);
            })
            .slice(0, 10)
            .forEach(season => addCandidate(season.id));
    } catch (error) {
        console.warn(`[Top Players] Season candidates failed for ${tournamentId}: ${error.message}`);
    }

    return candidates;
}

function getGoalIncidentPlayer(incident) {
    return incident?.player || incident?.footballPlayer || incident?.scorer || null;
}

function getGoalIncidentPlayerName(incident, player) {
    return player?.name || player?.shortName || incident?.playerName || incident?.scorerName || incident?.name || "";
}

async function fetchTopPlayersFromEventsFallback(tournamentId, seasonId, options = {}) {
    const pageCount = Number(options.pages || 6);
    const eventLimit = Number(options.eventLimit || 90);
    const eventNativeTimeout = Number(options.eventNativeTimeout || 2600);
    const eventFastTimeout = Number(options.eventFastTimeout || 4200);
    const incidentNativeTimeout = Number(options.incidentNativeTimeout || 2300);
    const incidentFastTimeout = Number(options.incidentFastTimeout || 3600);
    const batchSize = Number(options.batchSize || 10);
    const eventPaths = Array.from({ length: pageCount }, (_, page) => `/unique-tournament/${tournamentId}/season/${seasonId}/events/last/${page}`);
    const eventResults = await Promise.allSettled(
        eventPaths.map(path => Promise.any([
            fetchFromSofaApiDirect(path, {}, eventNativeTimeout),
            fetchFromSofaNativeFast(path, {}, eventNativeTimeout),
            fetchFromSofaFastRace(path, {}, eventFastTimeout)
        ]))
    );
    const eventsById = new Map();
    for (const result of eventResults) {
        if (result.status !== "fulfilled") continue;
        const events = result.value?.events || result.value?.data?.events || [];
        if (!Array.isArray(events)) continue;
        for (const event of events) {
            if (!event?.id) continue;
            const statusType = String(event.status?.type || "").toLowerCase();
            if (statusType && !["finished", "inprogress", "notstarted"].includes(statusType)) continue;
            eventsById.set(event.id, event);
        }
    }

    const events = Array.from(eventsById.values()).slice(0, eventLimit);
    if (!events.length) return null;

    const scorers = new Map();
    for (let i = 0; i < events.length; i += batchSize) {
        const batch = events.slice(i, i + batchSize);
        const incidentResults = await Promise.allSettled(
            batch.map(event => Promise.any([
                fetchFromSofaApiDirect(`/event/${event.id}/incidents`, {}, incidentNativeTimeout),
                fetchFromSofaNativeFast(`/event/${event.id}/incidents`, {}, incidentNativeTimeout),
                fetchFromSofaFastRace(`/event/${event.id}/incidents`, {}, incidentFastTimeout)
            ]).then(data => ({ event, data })))
        );

        for (const result of incidentResults) {
            if (result.status !== "fulfilled") continue;
            const { event, data } = result.value;
            const incidents = normalizeIncidentsData(data)?.incidents || data?.incidents || [];
            if (!Array.isArray(incidents)) continue;

            for (const incident of incidents) {
                if (incident?.incidentType !== "goal") continue;
                if (incident?.incidentClass === "ownGoal") continue;

                const player = getGoalIncidentPlayer(incident);
                const playerName = getGoalIncidentPlayerName(incident, player);
                const team = incident.team || (incident.isHome ? event.homeTeam : event.awayTeam) || {};
                if (!playerName) continue;

                const key = player?.id ? `id_${player.id}` : `name_${playerName.toLowerCase()}_${team?.id || ""}`;
                const current = scorers.get(key) || {
                    player: {
                        id: player?.id,
                        name: playerName,
                        shortName: player?.shortName || playerName
                    },
                    team: team?.id ? { id: team.id, name: team.name, shortName: team.shortName } : undefined,
                    statistics: { goals: 0 }
                };
                current.statistics.goals += 1;
                scorers.set(key, current);
            }
        }
    }

    const goals = Array.from(scorers.values())
        .sort((a, b) => (b.statistics?.goals || 0) - (a.statistics?.goals || 0) || String(a.player?.name || "").localeCompare(String(b.player?.name || "")))
        .slice(0, 50);

    if (!goals.length) return null;
    return {
        topPlayers: { goals },
        source: "events-fallback",
        derived: true
    };
}

async function fetchOfficialTopPlayersData(tournamentId, seasonId) {
    const statsPath = `/unique-tournament/${tournamentId}/season/${seasonId}/statistics`;
    const attempts = [
        {
            source: "top-players",
            promise: Promise.any([
                fetchFromSofaNativeFast(`/unique-tournament/${tournamentId}/season/${seasonId}/top-players/overall`, {}, 2400),
                fetchFromSofaFastRace(`/unique-tournament/${tournamentId}/season/${seasonId}/top-players/overall`, {}, 3800)
            ])
        },
        {
            source: "top-players",
            promise: Promise.any([
                fetchFromSofaNativeFast(`/unique-tournament/${tournamentId}/season/${seasonId}/top-players`, {}, 2400),
                fetchFromSofaFastRace(`/unique-tournament/${tournamentId}/season/${seasonId}/top-players`, {}, 3800)
            ])
        },
        {
            source: "statistics-goals",
            promise: Promise.any([
                fetchFromSofaNativeFast(statsPath, { limit: 50, order: "-goals", accumulation: "total", group: "summary" }, 2600),
                fetchFromSofaNativeFast(statsPath, { limit: 50, order: "-goals", group: "attack" }, 2600),
                fetchFromSofaFastRace(statsPath, { limit: 50, order: "-goals", accumulation: "total", group: "summary" }, 4200),
                fetchFromSofaFastRace(statsPath, { limit: 50, order: "-goals", group: "attack" }, 4200)
            ])
        }
    ];

    return Promise.any(attempts.map(({ source, promise }) => promise.then(data => {
        const goals = normalizeGoalTopPlayers(extractGoalTopPlayersList(data));
        if (!goals.length) throw new Error(`${source} returned no goal players`);
        return { topPlayers: { goals }, source };
    })));
}

async function fetchTopPlayersData(tournamentId, seasonId, options = {}) {
    const fastFallbackOptions = {
        pages: 2,
        eventLimit: 48,
        eventNativeTimeout: 1800,
        eventFastTimeout: 2400,
        incidentNativeTimeout: 1600,
        incidentFastTimeout: 2000,
        batchSize: 24
    };

    if (options.fast) {
        const cachedStandingsFallback = buildTopPlayersFromStandingsFallback(tournamentId, seasonId);
        if (hasTopPlayers(cachedStandingsFallback)) {
            return { ...cachedStandingsFallback, fast: true, instant: true };
        }

        const officialPromise = fetchOfficialTopPlayersData(tournamentId, seasonId);
        const eventsPromise = fetchTopPlayersFromEventsFallback(tournamentId, seasonId, fastFallbackOptions);
        const standingsPromise = fetchTopPlayersFromStandingsFallback(tournamentId, seasonId, {
            fetchFresh: true,
            timeout: 1400
        }).then(data => {
            if (hasTopPlayers(data)) return { ...data, fast: true };
            throw new Error("standings fallback returned no players");
        });
        const realData = await Promise.race([
            Promise.any([officialPromise, eventsPromise, standingsPromise]).catch(error => {
                console.warn(`[Top Players] Fast real data failed for ${tournamentId}/${seasonId}: ${error.message}`);
                return null;
            }),
            new Promise(resolve => setTimeout(() => resolve(null), 4200))
        ]);
        if (hasTopPlayers(realData)) return realData;
        throw new Error("Top players unavailable");
    }

    try {
        return await fetchOfficialTopPlayersData(tournamentId, seasonId);
    } catch (error) {
        console.warn(`[Top Players] Official data failed for ${tournamentId}/${seasonId}: ${error.message}`);
    }

    if (options.officialOnly) {
        throw new Error("Official top players unavailable");
    }

    const fallbackData = await fetchTopPlayersFromEventsFallback(tournamentId, seasonId, {});
    if (fallbackData && extractGoalTopPlayersList(fallbackData).length) return fallbackData;

    const standingsFallback = await fetchTopPlayersFromStandingsFallback(tournamentId, seasonId, {
        fetchFresh: true,
        timeout: 2400
    }).catch(error => {
        console.warn(`[Top Players] Standings final fallback failed for ${tournamentId}/${seasonId}: ${error.message}`);
        return null;
    });
    if (hasTopPlayers(standingsFallback)) return standingsFallback;

    throw new Error("Top players unavailable");
}

async function fetchTopPlayersDataForBestSeason(tournamentId, seasonId, options = {}) {
    let seasonIds = getPrimaryTopPlayerSeasonIds(tournamentId, seasonId);
    if (!seasonIds.length) {
        seasonIds = await getFallbackTopPlayerSeasonIds(tournamentId, seasonIds, options);
    }
    if (!seasonIds.length) throw new Error("Season id tapÄ±lmadÄ±");
    if (options.maxSeasons) seasonIds = seasonIds.slice(0, Number(options.maxSeasons));

    let firstData = null;
    let firstError = null;

    const trySeasonIds = async (ids) => {
        for (const sid of ids) {
            try {
                const data = await fetchTopPlayersData(tournamentId, sid, options);
                if (!firstData) firstData = { ...data, seasonId: sid };
                if (hasTopPlayers(data)) {
                    return { ...data, seasonId: sid };
                }
            } catch (error) {
                firstError = firstError || error;
                console.warn(`[Top Players] Season ${tournamentId}/${sid} failed: ${error.message}`);
            }
        }
        return null;
    };

    const primaryData = await trySeasonIds(seasonIds);
    if (primaryData) return primaryData;

    seasonIds = await getFallbackTopPlayerSeasonIds(tournamentId, seasonIds, options);
    if (options.maxSeasons) seasonIds = seasonIds.slice(0, Number(options.maxSeasons));
    const remainingSeasonIds = seasonIds.filter(sid => !getPrimaryTopPlayerSeasonIds(tournamentId, seasonId).includes(sid));
    const fallbackSeasonData = await trySeasonIds(remainingSeasonIds);
    if (fallbackSeasonData) return fallbackSeasonData;

    if (firstData) return firstData;
    throw firstError || new Error("Top players unavailable");
}

function withServerTimeout(promise, ms, label) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timeout`)), ms))
    ]);
}

async function getCachedDataWithTimeout(key, fetchFn, ttl, timeoutMs, timeoutLabel, options = {}) {
    const now = Date.now();
    if (cache[key] && (now - cache[key].timestamp < ttl)) {
        console.log(`[CACHE HIT] Key: ${key}`);
        return cache[key].data;
    }

    try {
        return await withServerTimeout(
            getCachedData(key, fetchFn, ttl, options),
            timeoutMs,
            timeoutLabel
        );
    } catch (error) {
        if (cache[key]) {
            console.warn(`[CACHE STALE] Key: ${key}. Returning stale data after timeout/error: ${error.message}`);
            return cache[key].data;
        }
        throw error;
    }
}

async function warmImagePaths(paths, limit = 12) {
    const unique = [...new Set(paths)].filter(Boolean).slice(0, limit);
    if (!unique.length) return;
    await Promise.allSettled(unique.map(imagePath => fetchSofaImageCached(imagePath)));
}

async function warmExternalImageUrls(urls, limit = 12) {
    const unique = [...new Set(urls)].filter(Boolean).slice(0, limit);
    if (!unique.length) return;
    await Promise.allSettled(unique.map(async imageUrl => {
        try {
            const parsed = new URL(imageUrl);
            if (!["https:", "http:"].includes(parsed.protocol) || !EXTERNAL_IMAGE_HOSTS.has(parsed.hostname)) return;
            await fetchExternalImageCached(parsed.href);
        } catch (e) {}
    }));
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

function normalizeSvgColor(value, fallback) {
    const raw = String(value || "").replace("#", "").trim();
    return /^[0-9a-fA-F]{6}$/.test(raw) ? `#${raw}` : fallback;
}

function escapeSvgText(value) {
    return String(value || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function getBadgeInitials(value, fallback = "FC") {
    const source = String(value || fallback).trim();
    const parts = source.split(/\s+/).filter(Boolean);
    if (!parts.length) return fallback;
    if (parts.length === 1) return parts[0].slice(0, 3).toUpperCase();
    return parts.slice(0, 2).map(part => part[0]).join("").toUpperCase();
}

function generatedImageFallbackSvg(query = {}) {
    const label = escapeSvgText(getBadgeInitials(query.label, query.type === "league" ? "LG" : "FC"));
    const primary = normalizeSvgColor(query.primary, query.type === "league" ? "#ef4444" : "#2563eb");
    const secondary = normalizeSvgColor(query.secondary, "#0f172a");
    return `
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
            <defs>
                <linearGradient id="g" x1="0" x2="1" y1="0" y2="1">
                    <stop offset="0" stop-color="${primary}"/>
                    <stop offset="1" stop-color="${secondary}"/>
                </linearGradient>
            </defs>
            <rect width="64" height="64" rx="18" fill="url(#g)"/>
            <circle cx="32" cy="32" r="22" fill="none" stroke="rgba(255,255,255,.55)" stroke-width="3"/>
            <text x="32" y="38" text-anchor="middle" font-family="Arial, sans-serif" font-size="18" font-weight="900" fill="#fff">${label}</text>
        </svg>`;
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
    const cacheAge = lastLiveFetchTime ? (now - lastLiveFetchTime) : Infinity;
    if (preferImmediateCache && hasUsableCache && (cacheAge <= LIVE_SNAPSHOT_MAX_AGE)) {
        if (!liveFetchPromise) {
            getLiveEventsData(true).catch(() => {});
        }
        warmLiveMatchDetails(globalLiveEvents.events).catch(() => {});
        return {
            ...globalLiveEvents,
            stale: true,
            staleSince: lastLiveFetchTime ? new Date(lastLiveFetchTime).toISOString() : null
        };
    }

    if (!forceFresh && hasUsableCache && (cacheAge < CACHE_TIMES.LIVE)) {
        warmLiveMatchDetails(globalLiveEvents.events).catch(() => {});
        return globalLiveEvents;
    }

    if (!forceFresh && hasUsableCache && (now - lastLiveFetchAttemptTime < CACHE_TIMES.LIVE)) {
        warmLiveMatchDetails(globalLiveEvents.events).catch(() => {});
        return {
            ...globalLiveEvents,
            stale: true,
            staleSince: new Date(lastLiveFetchTime).toISOString()
        };
    }

    if (!liveFetchPromise) {
        lastLiveFetchAttemptTime = now;
        liveFetchPromise = (async () => {
            const data = await fetchLiveWithFallback();
            if (!data || !Array.isArray(data.events)) {
                throw new Error("Live response missing events array");
            }
            if (shouldTreatAsMackolikLivePayload(data)) syncLiveMatchCache(data.events);
            globalLiveEvents = data;
            lastLiveFetchTime = Date.now();
            saveLiveSnapshot();
            warmLiveMatchDetails(globalLiveEvents.events).catch(() => {});
            return globalLiveEvents;
        })().finally(() => {
            liveFetchPromise = null;
        });
    }

    try {
        return await liveFetchPromise;
    } catch (error) {
        if (MACKOLIK_CANONICAL_MODE) {
            globalLiveEvents = {
                events: [],
                source: "mackolik",
                stale: true,
                warning: error.message,
                generatedAt: new Date().toISOString()
            };
            lastLiveFetchTime = Date.now();
            return globalLiveEvents;
        }
        if (SOFASCORE_ONLY_MODE && containsMackolikLiveData(globalLiveEvents)) {
            globalLiveEvents = null;
            lastLiveFetchTime = 0;
            throw error;
        }
        if (hasUsableCache && cacheAge <= LIVE_STALE_RETURN_MAX_AGE) {
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
    Object.keys(pendingGoalDetailNotifications).forEach(matchId => {
        if (now - pendingGoalDetailNotifications[matchId].createdAt > 10 * 60 * 1000) {
            delete pendingGoalDetailNotifications[matchId];
        }
    });
    Object.keys(scorePushState).forEach(matchId => {
        if (now - Number(scorePushState[matchId]?.sentAt || 0) > maxAgeMs) {
            delete scorePushState[matchId];
        }
    });
}

function getScoreSnapshot(source) {
    return {
        homeScore: Number(source?.homeScore?.current ?? source?.homeScore ?? source?.home ?? 0),
        awayScore: Number(source?.awayScore?.current ?? source?.awayScore ?? source?.away ?? 0)
    };
}

function scorePushAlreadySent(matchId, scoreMarker, maxAgeMs = 12 * 60 * 60 * 1000) {
    const entry = scorePushState[matchId?.toString()];
    return !!entry && entry.marker === scoreMarker && (Date.now() - Number(entry.sentAt || 0)) <= maxAgeMs;
}

function getGoalPushDeliveryMarker(payload = {}) {
    const type = payload.type || "goal";
    if (payload.deliveryMarker) return `${type}:${payload.deliveryMarker}`;
    if (type === "goal_scorer" && payload.tag) return `${type}:${payload.tag}`;
    if (payload.score) return `${type}:score-${String(payload.score).replace(/[^0-9]+/g, "-").replace(/^-|-$/g, "")}`;
    if (payload.tag) return `${type}:${payload.tag}`;
    return "";
}

function recipientScorePushAlreadySent(reg, matchId, scoreMarker, maxAgeMs = 12 * 60 * 60 * 1000) {
    const entry = reg?.recipientScorePushState?.[matchId?.toString()];
    if (!entry || !scoreMarker) return false;
    if (entry.markers && entry.markers[scoreMarker]) {
        return (Date.now() - Number(entry.markers[scoreMarker] || 0)) <= maxAgeMs;
    }
    return entry.marker === scoreMarker && (Date.now() - Number(entry.sentAt || 0)) <= maxAgeMs;
}

function rememberRecipientScorePush(reg, matchId, scoreMarker) {
    const key = matchId?.toString();
    if (!reg || !key || !scoreMarker) return;
    if (!reg.recipientScorePushState || typeof reg.recipientScorePushState !== "object") {
        reg.recipientScorePushState = {};
    }
    const previous = reg.recipientScorePushState[key] || {};
    const markers = previous.markers && typeof previous.markers === "object" ? previous.markers : {};
    if (previous.marker && previous.sentAt) {
        markers[previous.marker] = previous.sentAt;
    }
    markers[scoreMarker] = Date.now();
    const freshMarkers = Object.fromEntries(
        Object.entries(markers)
            .filter(([, sentAt]) => Date.now() - Number(sentAt || 0) <= 12 * 60 * 60 * 1000)
            .slice(-20)
    );
    reg.recipientScorePushState[key] = {
        marker: scoreMarker,
        sentAt: Date.now(),
        markers: freshMarkers
    };
    const entries = Object.entries(reg.recipientScorePushState)
        .filter(([, value]) => Date.now() - Number(value?.sentAt || 0) <= 12 * 60 * 60 * 1000)
        .slice(-80);
    reg.recipientScorePushState = Object.fromEntries(entries);
}

function rememberScorePush(matchId, scoreMarker, snapshot) {
    const key = matchId?.toString();
    if (!key || !scoreMarker) return;
    scorePushState[key] = {
        marker: scoreMarker,
        homeScore: snapshot.homeScore,
        awayScore: snapshot.awayScore,
        sentAt: Date.now()
    };
    markGoalNotification(key, scoreMarker);
    savePersistentState();
}

// ─── ONESIGNAL PUSH ───────────────────────────────────────────────────────────
const ONESIGNAL_APP_ID = process.env.ONESIGNAL_APP_ID || "9f13e700-01e4-4259-9747-c9140e93d657";
const ONESIGNAL_API_KEY = process.env.ONESIGNAL_API_KEY || "os_v2_app_t4j6oaab4rbftf2hzeka5e6wk4tmvph2ctmulunlpfzz443esiz3nulrekzb7qfawwpxacelfwzwhp6bbfwcyzzwkhrioqu75qipotq";

async function sendOneSignalGoalNotification(payload) {
    if (!ONESIGNAL_APP_ID || !ONESIGNAL_API_KEY) return null;
    try {
        const body = {
            app_id: ONESIGNAL_APP_ID,
            included_segments: ["All"],
            headings: { en: payload.title || "Rabona Media", az: payload.title || "Rabona Media" },
            contents: { en: payload.body || "Hesab dəyişdi!", az: payload.body || "Hesab dəyişdi!" },
            data: {
                matchId: payload.matchId || "",
                leagueId: payload.leagueId || "",
                type: payload.type || "goal_score",
                score: payload.score || "",
                url: payload.url || "/"
            },
            url: payload.url || "/",
            web_url: payload.url || "/",
            app_url: payload.url || "/",
            priority: 10,
            ttl: Number(payload.ttl || 120),
            web_push_topic: payload.tag || `goal-${payload.matchId}-${payload.score}`
        };

        const response = await axios.post(
            "https://onesignal.com/api/v1/notifications",
            body,
            {
                headers: {
                    "Content-Type": "application/json; charset=utf-8",
                    "Authorization": `Basic ${ONESIGNAL_API_KEY}`
                },
                timeout: 8000
            }
        );

        const result = response.data;
        if (result?.errors?.length) {
            console.warn(`[OneSignal] Xəbərdarlıq: ${JSON.stringify(result.errors).substring(0, 120)}`);
        } else {
            console.log(`[OneSignal] ✅ Bildiriş göndərildi. recipients=${result?.recipients ?? "?"}  id=${result?.id ?? "?"}`);
        }
        return result;
    } catch (err) {
        const detail = err?.response?.data ? JSON.stringify(err.response.data).substring(0, 200) : err.message;
        console.error(`[OneSignal] ❌ Göndərmə xətası: ${detail}`);
        return null;
    }
}
// ──────────────────────────────────────────────────────────────────────────────

function addServerNotification({ type, title, body, matchId, leagueId }) {
    const notifObj = {
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        type,
        title,
        body,
        matchId,
        leagueId,
        time: new Date().toLocaleTimeString('az-AZ', { hour: '2-digit', minute: '2-digit' })
    };
    serverNotifHistory.unshift(notifObj);
    if (serverNotifHistory.length > 50) serverNotifHistory.pop();
    saveNotifHistory();
}

function buildFcmGoalMessage({ title, body, matchId, leagueId, type, tag, score = "", ttl = "120" }) {
    return {
        notification: { title, body },
        data: {
            matchId: matchId?.toString() || "",
            leagueId: leagueId?.toString() || "",
            type,
            score: score?.toString() || "",
            sentAt: Date.now().toString()
        },
        android: {
            priority: "high",
            notification: {
                sound: "default",
                channelId: "goal_notifications",
                notificationPriority: "PRIORITY_MAX",
                tag
            }
        },
        apns: { 
            payload: { 
                aps: { 
                    sound: "default", 
                    badge: 1, 
                    "mutable-content": 1,
                    alert: { title, body }
                } 
            } 
        },
        webpush: {
            headers: { Urgency: "high", TTL: ttl },
            notification: {
                title,
                body,
                vibrate: [500, 110, 500],
                icon: "/icons/icon-192.png",
                badge: "/icons/icon-192.png",
                tag,
                renotify: true
            },
            fcm_options: { link: "/" }
        }
    };
}

async function sendGoalPushToRecipients(recipients, payload) {
    const deliveryMarker = getGoalPushDeliveryMarker(payload);
    const deliverableRecipients = deliveryMarker
        ? recipients.filter(recipient => !recipientScorePushAlreadySent(recipient.reg, payload.matchId, deliveryMarker))
        : recipients;
    const fcmRecipients = deliverableRecipients.filter(r => r.channel === "fcm");
    const webPushRecipients = deliverableRecipients.filter(r => r.channel === "webpush");
    const result = {
        attempted: recipients.length,
        sent: 0,
        failed: 0,
        skipped: recipients.length - deliverableRecipients.length
    };

    if (fcmRecipients.length > 0 && firebaseInitialized) {
        const message = buildFcmGoalMessage(payload);
        const fcmResults = await Promise.allSettled(fcmRecipients.map(async ({ id: token }) => {
            try {
                await admin.messaging().send({ ...message, token });
                return { ok: true, token };
            } catch (err) {
                if (err.code === "messaging/registration-token-not-registered") {
                    delete fcmRegistrations[token];
                    saveRegistrations();
                }
                console.error("[Push][FCM] Goal send error:", err.message || err.code || err);
                return { ok: false, token };
            }
        }));
        let fcmStateChanged = false;
        fcmResults.forEach(item => {
            if (item.status === "fulfilled" && item.value?.ok) {
                result.sent++;
                if (deliveryMarker && fcmRegistrations[item.value.token]) {
                    rememberRecipientScorePush(fcmRegistrations[item.value.token], payload.matchId, deliveryMarker);
                    fcmStateChanged = true;
                }
            } else {
                result.failed++;
            }
        });
        if (fcmStateChanged) saveRegistrations();
    } else if (fcmRecipients.length > 0) {
        result.skipped += fcmRecipients.length;
    }

    if (webPushRecipients.length > 0) {
        const webPayload = createPushPayload({
            title: payload.title,
            body: payload.body,
            matchId: payload.matchId,
            leagueId: payload.leagueId,
            type: payload.type,
            tag: payload.tag,
            requireInteraction: true,
            ttl: Number(payload.ttl || 120),
            urgency: "high"
        });
        const webResults = await Promise.allSettled(webPushRecipients.map(({ id: deviceId }) => {
            return sendWebPushMessage(deviceId, webPayload).then(ok => ({ ok, deviceId }));
        }));
        let webStateChanged = false;
        webResults.forEach(item => {
            if (item.status === "fulfilled" && item.value?.ok) {
                result.sent++;
                if (deliveryMarker && webPushRegistrations[item.value.deviceId]) {
                    rememberRecipientScorePush(webPushRegistrations[item.value.deviceId], payload.matchId, deliveryMarker);
                    webStateChanged = true;
                }
            } else {
                result.failed++;
            }
        });
        if (webStateChanged) saveWebPushRegistrations();
    }

    console.log(`[Push][Goal] attempted=${result.attempted} sent=${result.sent} failed=${result.failed} skipped=${result.skipped} type=${payload.type || "goal"}`);
    return result;
}

async function sendImmediateScoreGoalPush(event, previousScoreSource, source = "score") {
    if (!event?.id) return { sent: 0, skipped: true, reason: "missing-event" };

    const matchId = event.id.toString();
    const current = getScoreSnapshot(event);
    const previous = getScoreSnapshot(previousScoreSource);
    const homeDelta = current.homeScore - previous.homeScore;
    const awayDelta = current.awayScore - previous.awayScore;

    if (homeDelta <= 0 && awayDelta <= 0) {
        return { sent: 0, skipped: true, reason: "score-not-increased" };
    }

    const scoreMarker = `score-${current.homeScore}-${current.awayScore}`;
    const inFlightKey = `${matchId}:${scoreMarker}`;
    if (
        scorePushInFlight.has(inFlightKey) ||
        scorePushAlreadySent(matchId, scoreMarker) ||
        hasRecentGoalNotification(matchId, scoreMarker, 12 * 60 * 60 * 1000)
    ) {
        return { sent: 0, skipped: true, reason: "duplicate-score" };
    }

    scorePushInFlight.add(inFlightKey);
    try {
        const leagueId = (event.tournament?.uniqueTournament?.id || event.tournament?.id || "").toString();
        const homeName = event.homeTeam?.name || "Ev sahibi";
        const awayName = event.awayTeam?.name || "Qonaq";
        const scoringSide = homeDelta > 0 ? "home" : "away";
        const scoringTeam = scoringSide === "home" ? homeName : awayName;
        const previousGoalTotal = previous.homeScore + previous.awayScore;
        const title = `QOL! ${scoringTeam}`;
        const body = `${homeName} ${current.homeScore} - ${current.awayScore} ${awayName}`;
        const recipients = collectFavoriteRecipientsForEvent(event, matchId, leagueId);

        if (recipients.length === 0) {
            console.log(`[Push][Goal][${source}] ${matchId} score changed but no favorite recipient matched.`);
            return { sent: 0, skipped: true, reason: "no-recipients" };
        }

        addServerNotification({
            type: "goal_score",
            title,
            body,
            matchId,
            leagueId
        });

        const sendResult = await sendGoalPushToRecipients(recipients, {
            title,
            body,
            matchId,
            leagueId,
            type: "goal_score",
            score: `${current.homeScore}-${current.awayScore}`,
            tag: `goal-score-${matchId}-${current.homeScore}-${current.awayScore}`,
            ttl: "300"
        });

        if (sendResult.sent === 0) {
            console.warn(`[Push][Goal][${source}] No notification reached devices for match ${matchId}. Check stale subscriptions or Web Push delivery.`);
            return {
                ...sendResult,
                skipped: true,
                reason: sendResult.failed > 0 ? "send-failed" : "duplicate-recipient"
            };
        }

        pendingGoalDetailNotifications[matchId] = {
            scoreMarker,
            homeScore: current.homeScore,
            awayScore: current.awayScore,
            score: `${current.homeScore}-${current.awayScore}`,
            previousGoalTotal,
            scoringSide,
            leagueId,
            createdAt: Date.now()
        };

        rememberScorePush(matchId, scoreMarker, current);
        queueGoalScorerChecks(event, `${source}-score`);
        getMatchIncidentsData(matchId).catch(() => {});
        return sendResult;
    } finally {
        scorePushInFlight.delete(inFlightKey);
    }
}

async function getScorerIncidentDataForEvent(event) {
    const matchId = event?.id?.toString();
    if (!matchId) return { incidents: [] };
    const source = String(event.source || "").toLowerCase();
    if (source.includes("mackolik")) {
        const details = await getCachedData(`mackolik_scorer_incidents_${matchId}_${event.slug || ""}`, async () => {
            const data = await fetchMackolikMatchDetails(matchId, event.slug || "");
            return data.incidents;
        }, 12000, { skipJitter: true });
        return details;
    }
    return getMatchIncidentsData(matchId);
}

function getGoalScorerName(incident) {
    const name =
        incident?.playerName ||
        incident?.player?.name ||
        incident?.player?.shortName ||
        incident?.scorerName ||
        incident?.playerIn?.name ||
        "";
    return String(name || "").trim();
}

async function sendGoalScorerPushForEvent(event, reason = "incident-probe") {
    if (!event?.id) return { sent: 0, reason: "missing-event" };
    const matchId = event.id.toString();
    const leagueId = (event.tournament?.uniqueTournament?.id || event.tournament?.id || "").toString();
    const recipients = collectFavoriteRecipientsForEvent(event, matchId, leagueId);
    if (recipients.length === 0) return { sent: 0, reason: "no-recipients" };

    let incidentsData = null;
    try {
        incidentsData = await getScorerIncidentDataForEvent(event);
    } catch (error) {
        console.warn(`[Goal Scorer Probe] ${matchId} incidents unavailable: ${error.message}`);
        return { sent: 0, reason: "incidents-unavailable" };
    }

    const goalIncidents = extractGoalIncidents(incidentsData);
    if (!goalIncidents.length) return { sent: 0, reason: "no-goal-incidents" };

    const pendingGoalDetail = pendingGoalDetailNotifications[matchId];
    const currentHomeScore = Number(event.homeScore?.current || 0);
    const currentAwayScore = Number(event.awayScore?.current || 0);
    const currentGoalTotal = currentHomeScore + currentAwayScore;
    const previousScore = lastScores[matchId];
    const previousGoalTotal = pendingGoalDetail?.previousGoalTotal ?? (
        previousScore
            ? (Number(previousScore.homeScore) || 0) + (Number(previousScore.awayScore) || 0)
            : null
    );
    const scoreMovedSinceLastTrack = previousGoalTotal !== null && currentGoalTotal > previousGoalTotal;

    if (!liveGoalIncidentState[matchId]) {
        liveGoalIncidentState[matchId] = new Set();
        if (!scoreMovedSinceLastTrack && !pendingGoalDetail) {
            goalIncidents.map(buildGoalIncidentKey).forEach(key => liveGoalIncidentState[matchId].add(key));
            return { sent: 0, reason: "primed" };
        }
    }

    const knownKeys = liveGoalIncidentState[matchId];
    const newestCandidates = goalIncidents
        .slice()
        .sort((a, b) => (Number(b.time) || 0) - (Number(a.time) || 0));
    let incidentsToNotify = newestCandidates.filter(incident => !knownKeys.has(buildGoalIncidentKey(incident)));

    if ((pendingGoalDetail || scoreMovedSinceLastTrack) && incidentsToNotify.length) {
        const scoringSide = pendingGoalDetail?.scoringSide ||
            (currentHomeScore > (Number(previousScore?.homeScore) || 0) ? "home" : "away");
        const sideFiltered = incidentsToNotify.filter(incident =>
            scoringSide === "home" ? incident.isHome === true : incident.isHome === false
        );
        incidentsToNotify = (sideFiltered.length ? sideFiltered : incidentsToNotify).slice(0, 1);
    } else if (pendingGoalDetail && currentGoalTotal > pendingGoalDetail.previousGoalTotal) {
        const sideFiltered = newestCandidates.filter(incident =>
            pendingGoalDetail.scoringSide === "home" ? incident.isHome === true : incident.isHome === false
        );
        incidentsToNotify = (sideFiltered.length ? sideFiltered : newestCandidates).slice(0, 1);
    }

    if (!incidentsToNotify.length) return { sent: 0, reason: "no-new-scorer" };

    let sent = 0;
    for (const incident of incidentsToNotify) {
        const scorerName = getGoalScorerName(incident);
        if (!scorerName) continue;

        const incidentKey = buildGoalIncidentKey(incident);
        if (hasRecentGoalNotification(matchId, incidentKey, 12 * 60 * 60 * 1000)) continue;

        const minuteText = incident.time ? `${incident.time}'` : "CanlÄ±";
        const goalLabel =
            incident.incidentClass === "ownGoal" ? "Avtoqol" :
            incident.incidentClass === "penalty" ? "PenaltidÉ™n qol" :
            "Qol";
        const title = "Rabona Media";
        const body = `${minuteText} ${goalLabel}: ${scorerName}. ${event.homeTeam.name} ${currentHomeScore} - ${currentAwayScore} ${event.awayTeam.name}`;

        addServerNotification({ type: "goal_scorer", title, body, matchId, leagueId });
        const sendResult = await sendGoalPushToRecipients(recipients, {
            title,
            body,
            matchId,
            leagueId,
            type: "goal_scorer",
            score: `${currentHomeScore}-${currentAwayScore}`,
            tag: `goal-scorer-${matchId}-${incidentKey}`,
            deliveryMarker: incidentKey,
            ttl: "300"
        });

        knownKeys.add(incidentKey);
        if (sendResult.sent > 0) {
            sent += sendResult.sent;
            markGoalNotification(matchId, incidentKey);
            if (pendingGoalDetailNotifications[matchId]) {
                delete pendingGoalDetailNotifications[matchId];
            }
            console.log(`[Push][Scorer][${reason}] sent=${sendResult.sent} match=${matchId}`);
        } else {
            console.warn(`[Push][Scorer][${reason}] No notification reached devices for match ${matchId}.`);
        }
    }

    return { sent };
}

function queueGoalScorerChecks(event, reason = "score") {
    const matchId = event?.id?.toString();
    if (!matchId) return;
    const score = `${event.homeScore?.current || 0}-${event.awayScore?.current || 0}`;
    const key = `${matchId}:${score}`;
    const previousTimers = goalScorerProbeTimers.get(key) || [];
    previousTimers.forEach(timer => clearTimeout(timer));

    const delays = [1500, 4000, 8000, 15000, 30000, 60000];
    const timers = delays.map((delay, index) => setTimeout(() => {
        const latestEvent = matchCache[matchId] || event;
        sendGoalScorerPushForEvent(latestEvent, `${reason}+${delay}ms`).catch(error => {
            console.warn(`[Goal Scorer Probe] ${matchId}: ${error.message}`);
        }).finally(() => {
            if (index === delays.length - 1) goalScorerProbeTimers.delete(key);
        });
    }, delay));
    goalScorerProbeTimers.set(key, timers);
}

function normalizeStatisticsData(data) {
    const payload = data?.data || data || {};
    if (Array.isArray(payload.statistics)) return payload;
    if (Array.isArray(payload.stats?.statistics)) return payload.stats;
    if (Array.isArray(payload.statisticsItems)) {
        return {
            statistics: [{
                period: payload.period || "ALL",
                groups: [{
                    groupName: payload.groupName || "Ãœmumi",
                    statisticsItems: payload.statisticsItems
                }]
            }]
        };
    }
    return { statistics: [] };
}

function hasUsefulStatsData(data) {
    const payload = normalizeStatisticsData(data);
    return payload.statistics.some(period => {
        const groups = Array.isArray(period?.groups)
            ? period.groups
            : (Array.isArray(period?.statisticsItems) ? [{ statisticsItems: period.statisticsItems }] : []);
        return groups.some(group => Array.isArray(group.statisticsItems) && group.statisticsItems.length > 0);
    });
}

async function getMatchIncidentsData(matchId) {
    return getCachedData(`incidents_${matchId}`, async () => {
        try {
            const data = await Promise.any([
                fetchFromSofaApiDirect(`/event/${matchId}/incidents`, {}, 1600),
                fetchFromSofaNativeFast(`/event/${matchId}/incidents`, {}, 2000),
                fetchFromSofaFastRace(`/event/${matchId}/incidents`, {}, 2600),
                fetchRapidApiSofaPath(`/event/${matchId}/incidents`, {}, 2800)
            ]);
            return normalizeIncidentsData(data);
        } catch (error) {
            console.warn(`[INCIDENTS FALLBACK] Native incidents failed for ${matchId}: ${error.message}`);
            const fallback = await Promise.race([
                fetchRapidApiIncidents(matchId),
                new Promise(resolve => setTimeout(() => resolve(null), 900))
            ]);
            if (fallback) return fallback;
            throw error;
        }
    }, INCIDENTS_CACHE_TTL, { skipJitter: true });
}

async function fetchMatchStatisticsFresh(matchId) {
    try {
        const fast = await Promise.any([
            fetchFromSofaApiDirect(`/event/${matchId}/statistics`, {}, 1400),
            fetchFromSofaNativeFast(`/event/${matchId}/statistics`, {}, 1800),
            fetchFromSofaFastRace(`/event/${matchId}/statistics`, {}, 2800),
            fetchRapidApiSofaPath(`/event/${matchId}/statistics`, {}, 3000)
        ]);
        return normalizeStatisticsData(fast);
    } catch (error) {
        const reasons = error.errors?.map(e => e.message).join(" | ") || error.message;
        if (String(reasons).includes("404") || String(reasons).toLowerCase().includes("not found")) {
            return { statistics: [], unavailable: true, reason: "not-found" };
        }
        throw error;
    }
}

async function getMatchStatisticsData(matchId, ttl = STATS_CACHE_TTL) {
    const key = `stats_${matchId}`;
    const cached = cache[key];
    const cachedTtl = hasUsefulStatsData(cached?.data) ? ttl : Math.min(ttl, EMPTY_STATS_CACHE_TTL);
    if (cached && Date.now() - cached.timestamp < cachedTtl) {
        console.log(`[CACHE HIT] Key: ${key}`);
        return cached.data;
    }

    return getCachedData(key, async () => {
        try {
            return await fetchMatchStatisticsFresh(matchId);
        } catch (error) {
            throw error;
        }
    }, cachedTtl, { skipJitter: true });
}

function refreshMatchStatisticsInBackground(matchId, label = "STATS BACKGROUND REFRESH") {
    fetchMatchStatisticsFresh(matchId)
        .then(data => {
            if (!data) return;
                        const existing = cache[`stats_${matchId}`]?.data;
            if (hasUsefulStatsData(data) || !hasUsefulStatsData(existing)) {
                cache[`stats_${matchId}`] = { data, timestamp: Date.now() };
            }
        })
        .catch(error => {
            console.warn(`[${label}] ${matchId}: ${error.message}`);
        });
}

async function warmLiveMatchDetails(events = []) {
    if (!ALWAYS_ON_ENABLED) return;
    const now = Date.now();
    if (liveDetailsWarmupPromise || now - lastLiveDetailsWarmupAt < DETAILS_WARMUP_INTERVAL_MS) return;
    const warmableEvents = events
        .filter(event => event?.id)
        .sort((a, b) => {
            const aLive = isLiveSofaEvent(a) ? 1 : 0;
            const bLive = isLiveSofaEvent(b) ? 1 : 0;
            return bLive - aLive;
        })
        .slice(0, 60);
    if (!warmableEvents.length) return;

    lastLiveDetailsWarmupAt = now;
    liveDetailsWarmupPromise = (async () => {
        const batchSize = 10;
        for (let i = 0; i < warmableEvents.length; i += batchSize) {
            const batch = warmableEvents.slice(i, i + batchSize);
            await Promise.allSettled(batch.flatMap(event => {
                const id = event.id.toString();
                if (String(event.source || "").toLowerCase().includes("mackolik")) {
                    return [fetchMackolikMatchDetails(id, event.slug || "", { fast: true })
                        .then(details => storeMatchDetailsCache(id, details, "mackolik-fast-warm"))];
                }
                const tasks = [];
                if (!cache[`incidents_${id}`] || Date.now() - cache[`incidents_${id}`].timestamp > INCIDENTS_STALE_REFRESH_MS) {
                    tasks.push(getMatchIncidentsData(id));
                }
                const statsCached = cache[`stats_${id}`];
                const statsAge = statsCached ? Date.now() - statsCached.timestamp : Infinity;
                if (!statsCached || statsAge > STATS_STALE_REFRESH_MS || !hasUsefulStatsData(statsCached.data)) {
                    tasks.push(getMatchStatisticsData(id, STATS_CACHE_TTL));
                }
                return tasks;
            }));
            batch.forEach(event => {
                const id = event.id?.toString();
                if (!id) return;
                const cachedIncidents = cache[`incidents_${id}`]?.data;
                const cachedStats = cache[`stats_${id}`]?.data;
                if (cachedIncidents || cachedStats) {
                    storeMatchDetailsCache(id, {
                        incidents: cachedIncidents || { incidents: [] },
                        stats: cachedStats || { statistics: [] }
                    }, "live-warm-cache");
                }
            });
        }
    })().catch(error => {
        console.warn("[LIVE DETAILS WARMUP] Failed:", error.message);
    }).finally(() => {
        liveDetailsWarmupPromise = null;
    });
}

// API vasitÃ‰â„¢ÃƒÂ§isi (Komanda mÃ‰â„¢lumatlarÃ„Â± vÃ‰â„¢ heyÃ‰â„¢t ÃƒÂ¼ÃƒÂ§ÃƒÂ¼n)
const scheduledDetailsWarmQueue = [];
const scheduledDetailsWarmQueued = new Set();
let scheduledDetailsWarmWorkerRunning = false;

function getEventDetailCacheId(event = {}) {
    return String(event.mackolikMatchId || event.id || "");
}

function hasReadyMatchDetails(matchId) {
    const cached = matchDetailsCache[matchId];
    return hasUsefulIncidentData(cached?.incidents) || hasUsefulStatsData(cached?.stats);
}

function enqueueScheduledMatchDetails(events = [], reason = "scheduled") {
    if (!ALWAYS_ON_ENABLED) return;
    const candidates = (Array.isArray(events) ? events : [])
        .filter(event => event?.id)
        .filter(event => {
            const status = String(event.status?.type || "").toLowerCase();
            return status === "finished" || status === "inprogress" || matchHasAnyGoalScore(event);
        })
        .slice(0, 700);

    for (const event of candidates) {
        const detailId = getEventDetailCacheId(event);
        if (!detailId || hasReadyMatchDetails(detailId) || scheduledDetailsWarmQueued.has(detailId)) continue;
        scheduledDetailsWarmQueued.add(detailId);
        scheduledDetailsWarmQueue.push({ event, detailId, reason, queuedAt: Date.now() });
        if (event?.id) matchCache[String(event.id)] = event;
        if (detailId && !matchCache[detailId]) matchCache[detailId] = { ...event, id: detailId };
    }

    setTimeout(() => {
        runScheduledDetailsWarmWorker().catch(error => {
            console.warn("[SCHEDULED DETAILS WARMUP] Worker failed:", error.message);
        });
    }, 250);
}

function enqueueScheduledMatchDetailsPriority(event = {}, reason = "priority-click") {
    if (!ALWAYS_ON_ENABLED || !event?.id) return;
    const detailId = getEventDetailCacheId(event);
    if (!detailId || hasReadyMatchDetails(detailId)) return;
    if (!scheduledDetailsWarmQueued.has(detailId)) {
        scheduledDetailsWarmQueued.add(detailId);
    }
    scheduledDetailsWarmQueue.unshift({ event, detailId, reason, queuedAt: Date.now(), priority: true });
    if (event?.id) matchCache[String(event.id)] = event;
    if (detailId && !matchCache[detailId]) matchCache[detailId] = { ...event, id: detailId };
    runScheduledDetailsWarmWorker().catch(error => {
        console.warn("[SCHEDULED DETAILS WARMUP] Priority worker failed:", error.message);
    });
}

async function warmOneScheduledMatchDetails(item) {
    const event = item.event || {};
    const detailId = item.detailId || getEventDetailCacheId(event);
    if (!detailId || hasReadyMatchDetails(detailId)) return;

    const source = String(event.source || "").toLowerCase();
    const slug = event.mackolikSlug || event.slug || "";
    if (source.includes("mackolik") || event.mackolikMatchId) {
        const details = await withServerTimeout(
            fetchMackolikMatchDetails(detailId, slug, { fast: true }),
            3200,
            `Mackolik scheduled details ${detailId}`
        );
        storeMatchDetailsCache(detailId, details, `scheduled-${item.reason || "warm"}-mackolik`);
        return;
    }

    const details = await withServerTimeout(
        fetchMatchDetailsFromServer(detailId),
        3600,
        `Scheduled details ${detailId}`
    );
    if (details) storeMatchDetailsCache(detailId, details, `scheduled-${item.reason || "warm"}`);
}

async function runScheduledDetailsWarmWorker() {
    if (scheduledDetailsWarmWorkerRunning) return;
    scheduledDetailsWarmWorkerRunning = true;
    try {
        while (scheduledDetailsWarmQueue.length) {
            const batch = scheduledDetailsWarmQueue.splice(0, SCHEDULED_DETAILS_WARM_BATCH);
            await Promise.allSettled(batch.map(item =>
                warmOneScheduledMatchDetails(item).catch(error => {
                    if (!String(error.message || "").includes("timeout")) {
                        console.warn(`[SCHEDULED DETAILS WARMUP] ${item.detailId}: ${error.message}`);
                    }
                }).finally(() => {
                    scheduledDetailsWarmQueued.delete(item.detailId);
                })
            ));
            if (scheduledDetailsWarmQueue.length) {
                await new Promise(resolve => setTimeout(resolve, SCHEDULED_DETAILS_WARM_INTERVAL_MS));
            }
        }
    } finally {
        scheduledDetailsWarmWorkerRunning = false;
    }
}

function isPastMatchDate(date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ""))) return false;
    const [year, month, day] = String(date).split("-").map(Number);
    const targetUtc = Date.UTC(year, month - 1, day);
    const now = new Date();
    const todayUtc = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
    return targetUtc < todayUtc;
}

async function warmScheduledMatchDetailsImmediate(events = [], options = {}) {
    if (!ALWAYS_ON_ENABLED) return { warmed: 0 };
    const limit = Number(options.limit || 18);
    const batchSize = Number(options.batchSize || 4);
    const budgetMs = Number(options.budgetMs || 4200);
    const startedAt = Date.now();
    let warmed = 0;

    const candidates = (Array.isArray(events) ? events : [])
        .filter(event => event?.id)
        .filter(event => {
            const detailId = getEventDetailCacheId(event);
            if (!detailId || hasReadyMatchDetails(detailId)) return false;
            const status = String(event.status?.type || "").toLowerCase();
            return status === "finished" || status === "inprogress" || matchHasAnyGoalScore(event);
        })
        .slice(0, limit);

    for (let i = 0; i < candidates.length; i += batchSize) {
        if (Date.now() - startedAt > budgetMs) break;
        const batch = candidates.slice(i, i + batchSize);
        const results = await Promise.allSettled(batch.map(event =>
            warmOneScheduledMatchDetails({
                event,
                detailId: getEventDetailCacheId(event),
                reason: options.reason || "immediate"
            })
        ));
        warmed += results.filter(result => result.status === "fulfilled").length;
    }

    return { warmed, durationMs: Date.now() - startedAt };
}

let lastRecentScheduledDetailsWarmAt = 0;
async function warmRecentScheduledDetails(options = {}) {
    if (!ALWAYS_ON_ENABLED) return;
    const now = Date.now();
    if (!options.force && now - lastRecentScheduledDetailsWarmAt < RECENT_SCHEDULED_DETAILS_WARM_INTERVAL_MS) return;
    lastRecentScheduledDetailsWarmAt = now;

    const dayOffsets = options.force
        ? [0, -1, -2, -3, -4, -5, -6, -7, -8, -9, -10, -14]
        : [0, -1, -2, -3, -4, -5, -6];
    for (const offset of dayOffsets) {
        const date = new Date();
        date.setDate(date.getDate() + offset);
        const dateStr = date.toISOString().slice(0, 10);
        try {
            const data = await withServerTimeout(
                fetchMackolikMatchesByDate(dateStr),
                7000,
                `Recent scheduled ${dateStr}`
            );
            if (Array.isArray(data?.events) && data.events.length > 0) {
                cache[`matches_mackolik_${dateStr}_serverwarm`] = { data: { ...data, source: "mackolik" }, timestamp: Date.now() };
                enqueueScheduledMatchDetails(data.events, `serverwarm-${dateStr}`);
            }
        } catch (error) {
            if (!String(error.message || "").includes("timeout")) {
                console.warn(`[RECENT DETAILS WARMUP] ${dateStr}: ${error.message}`);
            }
        }
    }
}

app.get("/api/team/:id(\\d+)", async (req, res) => {
    try {
        if (MACKOLIK_CANONICAL_MODE) {
            return res.json({
                info: { team: null, source: "mackolik", unavailable: true },
                players: { players: [], source: "mackolik", unavailable: true },
                fast: req.query.fast === "1",
                mackolikOnly: true
            });
        }
        const teamId = req.params.id;
        const fast = req.query.fast === "1";
        const fetchTeamInfo = async () => {
            const data = await Promise.any([
                fetchFromSofaNativeFast(`/team/${teamId}`, {}, 2800),
                fetchFromSofaFastRace(`/team/${teamId}`, {}, 4500),
                fetchFromSofa(`/team/${teamId}`).then(result => result.data)
            ]);
            return data?.team ? data : (data?.data || data);
        };
        const fetchTeamPlayers = async () => {
            const data = await Promise.any([
                fetchFromSofaNativeFast(`/team/${teamId}/players`, {}, 3200),
                fetchFromSofaFastRace(`/team/${teamId}/players`, {}, 5200),
                fetchFromSofa(`/team/${teamId}/players`).then(result => result.data)
            ]);
            return data?.players ? data : (data?.data || data);
        };

        const infoPromise = getCachedDataWithTimeout(
            `team_info_${teamId}`,
            fetchTeamInfo,
            TEAM_INFO_TTL,
            fast ? 4200 : 6500,
            `Team info ${teamId}`,
            { skipJitter: true }
        );
        const playersPromise = getCachedDataWithTimeout(
            `team_players_${teamId}`,
            fetchTeamPlayers,
            TEAM_PLAYERS_TTL,
            fast ? 7000 : 7000,
            `Team players ${teamId}`,
            { skipJitter: true }
        );
        const safePlayersPromise = fast
            ? playersPromise.catch(() => ({ players: [], partial: true }))
            : playersPromise;

        if (fast) {
            const playersCacheKey = `team_players_${teamId}`;
            const info = await infoPromise;
            const cachedPlayers = cache[playersCacheKey]?.data;
            const players = cachedPlayers || { players: [], partial: true };
            if (!cachedPlayers) {
                getCachedData(playersCacheKey, fetchTeamPlayers, TEAM_PLAYERS_TTL, { skipJitter: true }).catch(e => {
                    console.warn(`[TEAM PLAYERS WARMUP] ${teamId}: ${e.message}`);
                });
            }
            return res.json({ info, players, fast: true, partialPlayers: !!players?.partial });
        }

        const [infoResult, playersResult] = await Promise.allSettled([
            infoPromise,
            safePlayersPromise
        ]);

        if (infoResult.status !== "fulfilled") {
            throw infoResult.reason;
        }

        res.json({
            info: infoResult.value,
            players: playersResult.status === "fulfilled" ? playersResult.value : { players: [] }
        });
    } catch (error) {
        console.error(`[API ERROR] Team ${req.params.id}: ${error.message}${error.response ? ' | Status: ' + error.response.status : ''}`);
        res.status(500).json({ error: true, message: error.message, details: error.response?.data?.substring?.(0, 100) });
    }
});

// Yeni API: CanlÃ„Â± MatÃƒÂ§lar
app.post("/api/matches/live/client-snapshot", (req, res) => {
    try {
        if (FLASHSCORE_CANONICAL_MODE) {
            return res.json({ success: false, skipped: true, message: "Flashscore mode keeps server live cache authoritative" });
        }
        if (MACKOLIK_CANONICAL_MODE) {
            return res.json({ success: false, skipped: true, message: "Mackolik canonical mode keeps server live cache authoritative" });
        }

        const rawEvents = Array.isArray(req.body?.events) ? req.body.events : [];
        if (!rawEvents.length) {
            return res.json({ success: false, skipped: true, message: "events array required" });
        }

        const normalized = normalizeSofaLiveEventsData({
            events: rawEvents.slice(0, CLIENT_LIVE_SNAPSHOT_MAX_EVENTS),
            source: "sofascore",
            generatedAt: req.body?.generatedAt || new Date().toISOString()
        });
        normalized.events = normalized.events.filter(isLiveSofaEvent);
        normalized.source = "sofascore";
        normalized.clientSnapshot = true;
        normalized.client = String(req.body?.client || "web").slice(0, 24);
        normalized.generatedAt = new Date().toISOString();

        if (!normalized.events.length) {
            return res.json({ success: false, skipped: true, message: "no live SofaScore events in snapshot" });
        }
        if (containsMackolikLiveData(normalized)) {
            return res.json({ success: false, skipped: true, message: "Mackolik data is not accepted in SofaScore snapshot" });
        }

        globalLiveEvents = normalized;
        lastLiveFetchTime = Date.now();
        normalized.events.forEach(match => {
            if (match?.id) matchCache[String(match.id)] = match;
        });
        saveLiveSnapshot();

        res.json({
            success: true,
            accepted: normalized.events.length,
            source: normalized.source,
            clientSnapshot: true
        });
    } catch (error) {
        console.warn("[CLIENT LIVE SNAPSHOT] Rejecting snapshot:", error.message);
        res.status(400).json({ success: false, message: error.message });
    }
});

app.get("/api/matches/live", async (req, res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');

    try {
        if (FLASHSCORE_CANONICAL_MODE && globalLiveEvents?.source && globalLiveEvents.source !== "flashscore") {
            globalLiveEvents = null;
            lastLiveFetchTime = 0;
        }
        if (!globalLiveEvents?.events?.length && !MACKOLIK_CANONICAL_MODE && !FLASHSCORE_CANONICAL_MODE) {
            await ensureLiveSnapshotLoaded();
        }
        if (req.query.source === "flashscore") {
            const data = await fetchLiveFromFlashscore();
            syncLiveMatchCache(data.events);
            globalLiveEvents = data;
            lastLiveFetchTime = Date.now();
            saveLiveSnapshot();
            return res.json(data);
        }
        if (FLASHSCORE_CANONICAL_MODE && req.query.source === "mackolik") {
            const data = await getLiveEventsData(req.query.fresh === "1", req.query.fresh !== "1");
            return res.json(data);
        }
        if (req.query.source === "mackolik") {
            if (!ENABLE_MACKOLIK_MATCHES) {
                return res.status(410).json({ error: true, message: "Mackolik match source is disabled. Sofascore-only mode is active." });
            }
            const data = await fetchLiveFromMackolik();
            syncLiveMatchCache(data.events);
            globalLiveEvents = data;
            lastLiveFetchTime = Date.now();
            saveLiveSnapshot();
            warmLiveMatchDetails(data.events).catch(() => {});
            return res.json(data);
        }
        if (req.query.source === "sofascore") {
            if (MACKOLIK_CANONICAL_MODE) {
                return res.status(410).json({ error: true, source: "mackolik", message: "SofaScore source is disabled. Mackolik-only mode is active." });
            }
            return res.json(await fetchLiveFromSofaScore());
        }
        const allowImmediateCache = req.query.fresh !== "1" && (req.query.fast === "1" || !!globalLiveEvents?.events?.length);
        const data = await getLiveEventsData(req.query.fresh === "1", allowImmediateCache);
        res.json(data);
    } catch (error) {
        console.error(`[API ERROR] Live matches: ${error.message}${error.response ? ' | Status: ' + error.response.status : ''}`);
        if (MACKOLIK_CANONICAL_MODE) {
            return res.json({
                events: [],
                source: "mackolik",
                stale: true,
                warning: error.message,
                generatedAt: new Date().toISOString()
            });
        }
        if (globalLiveEvents && Array.isArray(globalLiveEvents.events)) {
            const cacheAge = lastLiveFetchTime ? Date.now() - lastLiveFetchTime : Infinity;
            if (cacheAge <= LIVE_STALE_RETURN_MAX_AGE) {
                return res.json({
                    ...globalLiveEvents,
                    stale: true,
                    staleSince: lastLiveFetchTime ? new Date(lastLiveFetchTime).toISOString() : null,
                    warning: error.message
                });
            }
        }
        res.json({
            events: [],
            source: "none",
            stale: true,
            warning: error.message,
            generatedAt: new Date().toISOString()
        });
    }
});

// Yeni API: MatÃƒÂ§lar (Skedullu)
app.get("/api/matches/:date", async (req, res) => {
    const { date } = req.params;
    try {
        const today = new Date().toISOString().split('T')[0];
        const ttl = (date === today) ? 10 * 1000 : CACHE_TIMES.SCHEDULED; // 10s cache for today
        const source = MACKOLIK_CANONICAL_MODE
            ? "mackolik"
            : String(req.query.source || (ENABLE_MACKOLIK_MATCHES ? "mackolik" : "sofascore")).toLowerCase();
        if (source === "flashscore") {
            const flashCacheKey = `matches_flashscore_${date}_v5`;
            const cached = cache[flashCacheKey];
            if (cached && Date.now() - cached.timestamp < ttl && Array.isArray(cached.data?.events) && cached.data.events.length > 0) {
                return res.json(cached.data);
            }

            let data = null;
            try {
                const flashscoreData = await fetchMatchesFromFlashscoreByDate(date);
                if (Array.isArray(flashscoreData.events) && flashscoreData.events.length > 0) {
                    data = flashscoreData;
                } else {
                    throw new Error("Flashscore returned no scheduled events for this date");
                }
            } catch (flashscoreError) {
                console.warn(`[SCHEDULED] Flashscore failed for ${date}: ${flashscoreError.message}`);
                if (ENABLE_MACKOLIK_MATCHES && ALLOW_MACKOLIK_FALLBACK) {
                    try {
                        const mackolikData = await withServerTimeout(
                            fetchMackolikMatchesByDate(date),
                            6500,
                            "Mackolik scheduled fallback"
                        );
                        if (Array.isArray(mackolikData.events) && mackolikData.events.length > 0) {
                            data = { ...mackolikData, source: "mackolik-fallback" };
                        }
                    } catch (mackolikError) {
                        console.warn(`[SCHEDULED] Mackolik fallback failed for ${date}: ${mackolikError.message}`);
                    }
                }
                if (!data) {
                    try {
                        data = await withServerTimeout(
                            fetchScheduledFromSofaScore(date),
                            7000,
                            "SofaScore scheduled fallback"
                        );
                    } catch (sofaError) {
                        console.warn(`[SCHEDULED] SofaScore fallback failed for ${date}: ${sofaError.message}`);
                    }
                }
                if (!data) {
                    data = { events: [], source: "flashscore", warning: flashscoreError.message, generatedAt: new Date().toISOString() };
                }
            }

            if (Array.isArray(data?.events) && data.events.length > 0) {
                if (isPastMatchDate(date)) {
                    await warmScheduledMatchDetailsImmediate(data.events, {
                        limit: 8,
                        batchSize: 2,
                        budgetMs: 1600,
                        reason: `priority-${date}`
                    });
                }
                cache[flashCacheKey] = { data, timestamp: Date.now() };
                warmLiveMatchDetails(data.events).catch(() => {});
                enqueueScheduledMatchDetails(data.events, `date-${date}`);
            }
            return res.json(data);
        }
        const data = await getCachedData(`matches_${source}_${date}_v3`, async () => {
            if (source === "flashscore") {
                try {
                    const flashscoreData = await fetchMatchesFromFlashscoreByDate(date);
                    if (Array.isArray(flashscoreData.events) && flashscoreData.events.length > 0) {
                        return flashscoreData;
                    }
                    throw new Error("Flashscore returned no scheduled events for this date");
                } catch (flashscoreError) {
                    console.warn(`[SCHEDULED] Flashscore failed for ${date}: ${flashscoreError.message}`);
                    if (FLASHSCORE_CANONICAL_MODE) {
                        if (ENABLE_MACKOLIK_MATCHES && ALLOW_MACKOLIK_FALLBACK) {
                            try {
                                const mackolikData = await withServerTimeout(
                                    fetchMackolikMatchesByDate(date),
                                    6500,
                                    "Mackolik scheduled fallback"
                                );
                                if (Array.isArray(mackolikData.events) && mackolikData.events.length > 0) {
                                    return { ...mackolikData, source: "mackolik-fallback" };
                                }
                            } catch (mackolikError) {
                                console.warn(`[SCHEDULED] Mackolik fallback failed for ${date}: ${mackolikError.message}`);
                            }
                        }
                        try {
                            return await withServerTimeout(
                                fetchScheduledFromSofaScore(date),
                                7000,
                                "SofaScore scheduled fallback"
                            );
                        } catch (sofaError) {
                            console.warn(`[SCHEDULED] SofaScore fallback failed for ${date}: ${sofaError.message}`);
                        }
                        return { events: [], source: "flashscore", warning: flashscoreError.message, generatedAt: new Date().toISOString() };
                    }
                }
            }
            if (source === "mackolik") {
                if (!ENABLE_MACKOLIK_MATCHES) {
                    throw new Error("Mackolik match source is disabled. Sofascore-only mode is active.");
                }
                try {
                    const mackolikData = await fetchMackolikMatchesByDate(date);
                    return { ...mackolikData, source: "mackolik" };
                } catch (mackolikError) {
                    console.warn(`[SCHEDULED] Mackolik failed for ${date}: ${mackolikError.message}`);
                    if (MACKOLIK_CANONICAL_MODE) {
                        return { events: [], source: "mackolik", warning: mackolikError.message, generatedAt: new Date().toISOString() };
                    }
                }
                if (ALLOW_MACKOLIK_FALLBACK || !SOFASCORE_ONLY_MODE) {
                    return await fetchScheduledFromSofaScore(date);
                }
                return { events: [], source: "mackolik", warning: "No Mackolik scheduled events" };
            }
            return await fetchScheduledFromSofaScore(date);
        }, ttl);
        if (Array.isArray(data?.events)) {
            if (isPastMatchDate(date)) {
                await warmScheduledMatchDetailsImmediate(data.events, {
                    limit: 8,
                    batchSize: 2,
                    budgetMs: 1600,
                    reason: `priority-${date}`
                });
            }
            warmLiveMatchDetails(data.events).catch(() => {});
            enqueueScheduledMatchDetails(data.events, `date-${date}`);
        }
        res.json(data);
    } catch (error) {
        console.error(`[API ERROR] Scheduled matches for date ${date}: ${error.message}${error.response ? ' | Status: ' + error.response.status : ''}`);
        res.json({
            events: [],
            source: MACKOLIK_CANONICAL_MODE ? "mackolik" : "none",
            stale: true,
            warning: error.message,
            generatedAt: new Date().toISOString()
        });
    }
});

// Yeni API: MatÃƒÂ§ HadisÃ‰â„¢lÃ‰â„¢ri (Qollar, Kartlar)
// Client-side SofaScore details snapshot. This keeps match details instant on
// devices where the server or iOS Safari hits a temporary upstream block.
app.post("/api/match/:id/client-details", (req, res) => {
    const id = req.params.id;
    try {
        const incidents = normalizeIncidentsData(req.body?.incidents) || { incidents: [] };
        const stats = normalizeStatisticsData(req.body?.stats || req.body?.statistics || { statistics: [] });
        if (!hasUsefulIncidentData(incidents) && !hasUsefulStatsData(stats)) {
            return res.status(400).json({ error: true, message: "No useful details in snapshot" });
        }

        const stored = storeMatchDetailsCache(id, { incidents, stats }, "client-snapshot");
        return res.json({
            success: true,
            cached: true,
            instant: true,
            hasIncidents: hasUsefulIncidentData(stored?.incidents),
            hasStats: hasUsefulStatsData(stored?.stats),
            updatedAt: stored?.updatedAt || Date.now()
        });
    } catch (error) {
        console.warn(`[CLIENT DETAILS SNAPSHOT] ${id}: ${error.message}`);
        return res.status(400).json({ error: true, message: "Invalid details snapshot" });
    }
});

app.get("/api/match/:id/incidents", async (req, res) => {
    const id = req.params.id;
    try {
        if (req.query.source !== "mackolik" && !hasReadyMatchDetails(id)) {
            enqueueScheduledMatchDetailsPriority(matchCache[id] || { id }, "incidents-click");
        }
        if (req.query.source === "mackolik") {
            if (!ENABLE_MACKOLIK_MATCHES) {
                return res.json([]);
            }
            const data = await getCachedData(`mackolik_incidents_${id}_${req.query.slug || ""}`, async () => {
                const details = await fetchMackolikMatchDetails(id, req.query.slug || "");
                return details.incidents;
            }, 12000);
            return res.json(data);
        }
        const id = req.params.id;
        const cachedFromLoop = matchDetailsCache[id];
        if (req.query.fresh !== "1" && hasUsefulIncidentData(cachedFromLoop?.incidents)) {
            return res.json({ ...normalizeIncidentsData(cachedFromLoop.incidents), cached: true, instant: true, source: 'background_cache' });
        }
        const flashscoreMatch = String(matchCache[id]?.source || "").toLowerCase() === "flashscore" ? matchCache[id] : null;
        if (flashscoreMatch && req.query.fresh !== "1") {
            const synthetic = buildSyntheticIncidentsFromScore(flashscoreMatch);
            if (hasUsefulIncidentData(synthetic)) {
                cache[`incidents_${id}`] = { data: synthetic, timestamp: Date.now() };
                return res.json({ ...synthetic, cached: true, instant: true });
            }
        }
        const cached = cache[`incidents_${id}`];
        const matchHasScore = matchHasAnyGoalScore(matchCache[id]);
        const cachedUseful = hasUsefulIncidentData(cached?.data);
        if (req.query.fresh !== "1" && cached?.data && (cachedUseful || !matchHasScore)) {
            if (Date.now() - cached.timestamp > INCIDENTS_STALE_REFRESH_MS) {
                getMatchIncidentsData(id).catch(error => {
                    console.warn(`[INCIDENTS BACKGROUND REFRESH] ${id}: ${error.message}`);
                });
            }
            return res.json({ ...cached.data, cached: true, instant: true });
        }
        let data;
        if (req.query.fresh === "1") {
            try {
                data = normalizeIncidentsData(await Promise.any([
                    fetchFromSofaApiDirect(`/event/${id}/incidents`, {}, 1500),
                    fetchFromSofaNativeFast(`/event/${id}/incidents`, {}, 1800),
                    fetchFromSofaFastRace(`/event/${id}/incidents`, {}, 2400),
                    fetchRapidApiSofaPath(`/event/${id}/incidents`, {}, 2600)
                ]));
                if (data) cache[`incidents_${id}`] = { data, timestamp: Date.now() };
            } catch (freshError) {
                console.warn(`[INCIDENTS FRESH FALLBACK] ${id}: ${freshError.message}`);
                data = await getMatchIncidentsData(id);
            }
        } else {
            data = await getMatchIncidentsData(id);
        }
        res.json(data);
    } catch (error) {
        console.error(`[API ERROR] Match incidents ${id}: ${error.message}`);
        const cached = cache[`incidents_${id}`];
        if (cached) return res.json(cached.data);
        res.json({ incidents: [], unavailable: true, warning: error.message });
    }
});

// Yeni API: MatÃƒÂ§ StatistikasÃ„Â±
app.get("/api/match/:id/statistics", async (req, res) => {
    const id = req.params.id;
    try {
        if (!hasReadyMatchDetails(id)) {
            enqueueScheduledMatchDetailsPriority(matchCache[id] || { id }, "statistics-click");
        }
        const cachedFromLoop = matchDetailsCache[id];
        if (req.query.fresh !== "1" && hasUsefulStatsData(cachedFromLoop?.stats)) {
            return res.json({
                ...normalizeStatisticsData(cachedFromLoop.stats),
                cached: true,
                instant: true,
                source: 'background_cache'
            });
        }
        const cached = cache[`stats_${id}`];
        const cachedUseful = hasUsefulStatsData(cached?.data);
        const cachedAge = cached ? Date.now() - cached.timestamp : Infinity;

        if (req.query.fresh !== "1" && cached?.data && (cachedUseful || cachedAge < EMPTY_STATS_CACHE_TTL)) {
            if (cachedAge > STATS_STALE_REFRESH_MS || !cachedUseful) {
                refreshMatchStatisticsInBackground(id, "STATS INSTANT REFRESH");
            }
            return res.json({
                ...normalizeStatisticsData(cached.data),
                cached: true,
                instant: true,
                stale: cachedAge > STATS_STALE_REFRESH_MS
            });
        }

        const data = await fetchMatchStatisticsFresh(id).then(data => {
            if (data) cache[`stats_${id}`] = { data, timestamp: Date.now() };
            return data;
        });
        res.json(normalizeStatisticsData(data));
    } catch (error) {
        console.error(`[API ERROR] Match statistics ${id}: ${error.message}`);
        const cached = cache[`stats_${id}`];
        if (cached) return res.json({ ...normalizeStatisticsData(cached.data), cached: true, stale: true });
        res.json({ statistics: [], unavailable: true, warning: error.message });
    }
});

// Yeni API: H2H (Head to Head) MatÃƒÂ§lar - Native Sofascore API
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

// MatÃƒÂ§ detallarÃ„Â±nÃ„Â± vahid endpoint-dÃ‰â„¢ birlÃ‰â„¢Ã…Å¸diririk (bloklanmamaq ÃƒÂ¼ÃƒÂ§ÃƒÂ¼n)
app.get("/api/match/:id/details", async (req, res) => {
    const id = req.params.id;
    try {
        if (req.query.source !== "mackolik" && !hasReadyMatchDetails(id)) {
            enqueueScheduledMatchDetailsPriority(matchCache[id] || { id }, "details-click");
        }
        if (req.query.source === "mackolik") {
            if (!ENABLE_MACKOLIK_MATCHES) {
                return res.json({ incidents: [], stats: null, unavailable: true, source: "mackolik", message: "Mackolik details disabled" });
            }
            const cacheKey = `mackolik_details_${id}_${req.query.slug || ""}_${req.query.stats === "0" ? "nostats" : "all"}`;
            const cached = cache[cacheKey];
            const cachedAge = cached ? Date.now() - cached.timestamp : Infinity;
            const fastMode = req.query.fast === "1";
            const cacheTtl = fastMode ? MACKOLIK_FAST_DETAILS_CACHE_TTL : MACKOLIK_DETAILS_CACHE_TTL;
            const hasUsefulMackolikDetails = (details) =>
                hasUsefulIncidentData(details?.incidents) ||
                (req.query.stats !== "0" && hasUsefulStatsData(details?.stats));
            const cachedUnified = matchDetailsCache[id];
            if (req.query.fresh !== "1" && cachedUnified && hasUsefulMackolikDetails(cachedUnified)) {
                return res.json(req.query.stats === "0"
                    ? { incidents: cachedUnified.incidents, stats: null, cached: true, instant: true, source: "match_details_cache" }
                    : {
                        incidents: cachedUnified.incidents,
                        stats: normalizeStatisticsData(cachedUnified.stats || { statistics: [] }),
                        cached: true,
                        instant: true,
                        source: "match_details_cache"
                    });
            }
            let data = null;
            if (req.query.fresh !== "1" && cached && cachedAge < cacheTtl) {
                data = cached.data;
            } else {
                try {
                    const fetchPromise = fetchMackolikMatchDetails(id, req.query.slug || "", { fast: fastMode });
                    
                    fetchPromise.then(resolvedData => {
                        if (hasUsefulMackolikDetails(resolvedData)) {
                            cache[cacheKey] = { data: resolvedData, timestamp: Date.now() };
                            matchDetailsCache[id] = resolvedData;
                        }
                    }).catch(() => {});

                    data = fastMode
                        ? await withServerTimeout(fetchPromise, 2850, "Mackolik fast details")
                        : await fetchPromise;
                    if (hasUsefulMackolikDetails(data) || !fastMode) {
                        cache[cacheKey] = { data, timestamp: Date.now() };
                    } else if (cached?.data && hasUsefulMackolikDetails(cached.data)) {
                        data = { ...cached.data, stale: true, pendingRefresh: true };
                    } else if (fastMode) {
                        const sourceMatch = matchCache[id];
                        const syntheticIncidents = sourceMatch ? buildSyntheticIncidentsFromScore(sourceMatch) : null;
                        data = {
                            incidents: hasUsefulIncidentData(syntheticIncidents) ? syntheticIncidents : { incidents: [] },
                            stats: req.query.stats === "0" ? null : { statistics: [] },
                            pending: true,
                            syntheticFallback: true,
                            warning: "Mackolik details are still loading"
                        };
                    }
                } catch (error) {
                    if (cached?.data && hasUsefulMackolikDetails(cached.data)) {
                        data = { ...cached.data, stale: true, warning: error.message };
                    } else {
                        const sourceMatch = matchCache[id];
                        const syntheticIncidents = sourceMatch ? buildSyntheticIncidentsFromScore(sourceMatch) : null;
                        data = {
                            incidents: hasUsefulIncidentData(syntheticIncidents) ? syntheticIncidents : { incidents: [] },
                            stats: req.query.stats === "0" ? null : { statistics: [] },
                            pending: true,
                            syntheticFallback: true,
                            warning: error.message
                        };
                    }
                }
            }
            return res.json(req.query.stats === "0" ? { incidents: data.incidents, stats: null } : data);
        }

        const statsDisabled = req.query.stats === "0";
        const forceFresh = req.query.fresh === "1";
        const fastMode = req.query.fast === "1";

        const cachedFromLoop = matchDetailsCache[id];
        const cachedLoopUseful = hasUsefulIncidentData(cachedFromLoop?.incidents) ||
            (!statsDisabled && hasUsefulStatsData(cachedFromLoop?.stats));
        if (!forceFresh && cachedFromLoop && cachedLoopUseful) {
            return res.json({
                incidents: cachedFromLoop.incidents,
                stats: statsDisabled ? null : (cachedFromLoop.stats ? normalizeStatisticsData(cachedFromLoop.stats) : null),
                cached: true,
                instant: true,
                source: 'background_cache'
            });
        }
        const flashscoreMatch = String(matchCache[id]?.source || "").toLowerCase() === "flashscore" ? matchCache[id] : null;
        if (!forceFresh && flashscoreMatch) {
            const syntheticIncidents = buildSyntheticIncidentsFromScore(flashscoreMatch);
            if (hasUsefulIncidentData(syntheticIncidents)) {
                const syntheticStats = statsDisabled ? null : { statistics: [] };
                storeMatchDetailsCache(id, { incidents: syntheticIncidents, stats: syntheticStats || { statistics: [] } }, "flashscore-score-summary");
                return res.json({
                    incidents: syntheticIncidents,
                    stats: syntheticStats,
                    cached: true,
                    instant: true,
                    source: "flashscore-score-summary"
                });
            }
        }

        const cachedIncidents = cache[`incidents_${id}`];
        const cachedStats = cache[`stats_${id}`];
        const cachedIncidentUseful = hasUsefulIncidentData(cachedIncidents?.data);
        const cachedStatsUseful = !statsDisabled && hasUsefulStatsData(cachedStats?.data);
        const matchHasScore = matchHasAnyGoalScore(matchCache[id]);
        if (!forceFresh && (cachedIncidentUseful || cachedStatsUseful || (cachedIncidents?.data && !matchHasScore))) {
            if (!cachedIncidents || Date.now() - cachedIncidents.timestamp > INCIDENTS_STALE_REFRESH_MS) {
                getMatchIncidentsData(id).catch(error => {
                    console.warn(`[DETAILS INCIDENTS BACKGROUND REFRESH] ${id}: ${error.message}`);
                });
            }
            if (!statsDisabled && (!cachedStats || Date.now() - cachedStats.timestamp > STATS_STALE_REFRESH_MS || !hasUsefulStatsData(cachedStats.data))) {
                refreshMatchStatisticsInBackground(id, "DETAILS STATS BACKGROUND REFRESH");
            }
            return res.json({
                incidents: cachedIncidents?.data || { incidents: [] },
                stats: statsDisabled ? null : (cachedStats?.data ? normalizeStatisticsData(cachedStats.data) : null),
                cached: true,
                instant: true
            });
        }
        const optionalCachedFetch = (key, path, ttl) => {
            const fetchFresh = async () => {
                try {
                    const data = key.startsWith("stats_")
                        ? await getMatchStatisticsData(id, STATS_CACHE_TTL)
                        : await Promise.any([
                            fetchFromSofaApiDirect(path, {}, fastMode ? 1500 : 2200),
                            fetchFromSofaNativeFast(path, {}, fastMode ? 1800 : 2600),
                            fetchFromSofaFastRace(path, {}, fastMode ? 2400 : 3600),
                            fetchRapidApiSofaPath(path, {}, fastMode ? 2600 : 4200)
                        ]);
                    return key.startsWith("incidents_") ? normalizeIncidentsData(data) : normalizeStatisticsData(data);
                } catch (error) {
                    if (error.response?.status === 404 || error.message.includes("404")) {
                        return null;
                    }
                    if (key.startsWith("incidents_")) {
                        console.warn(`[INCIDENTS FALLBACK] Native details incidents failed for ${id}: ${error.message}`);
                        const fallback = fastMode
                            ? await Promise.race([
                                fetchRapidApiIncidents(id),
                                new Promise(resolve => setTimeout(() => resolve(null), 800))
                            ])
                            : await fetchRapidApiIncidents(id);
                        if (fallback) return fallback;
                    }
                    throw error;
                }
            };
            if (!forceFresh) return getCachedData(key, fetchFresh, ttl).catch(() => null);
            return fetchFresh().then(data => {
                if (data) cache[key] = { data, timestamp: Date.now() };
                return data;
            }).catch(() => null);
        };

        const incidentsPromise = optionalCachedFetch(`incidents_${id}`, `/event/${id}/incidents`, INCIDENTS_CACHE_TTL);
        const statsPromise = statsDisabled
            ? Promise.resolve(null)
            : optionalCachedFetch(`stats_${id}`, `/event/${id}/statistics`, STATS_CACHE_TTL);

        const [incidents, stats] = await Promise.all([incidentsPromise, statsPromise]);
        const normalizedIncidents = normalizeIncidentsData(incidents) || { incidents: [] };
        const normalizedStats = statsDisabled ? null : normalizeStatisticsData(stats);
        if (hasUsefulIncidentData(normalizedIncidents) || hasUsefulStatsData(normalizedStats)) {
            storeMatchDetailsCache(id, { incidents: normalizedIncidents, stats: normalizedStats || { statistics: [] } }, "details-endpoint");
        } else {
            refreshMatchDetails(id).catch(error => {
                console.warn(`[DETAILS BACKGROUND WARM] ${id}: ${error.message}`);
            });
        }

        res.json({
            incidents: normalizedIncidents,
            stats: normalizedStats,
            pending: !hasUsefulIncidentData(normalizedIncidents) && !hasUsefulStatsData(normalizedStats)
        });
    } catch (error) {
        console.error(`[API ERROR] Match details main ${id}: ${error.message}`);
        const cachedFromLoop = matchDetailsCache[id];
        const cachedIncidents = cache[`incidents_${id}`];
        const cachedStats = cache[`stats_${id}`];
        if (cachedFromLoop || cachedIncidents?.data || cachedStats?.data) {
            return res.json({
                incidents: normalizeIncidentsData(cachedFromLoop?.incidents || cachedIncidents?.data) || { incidents: [] },
                stats: req.query.stats === "0" ? null : normalizeStatisticsData(cachedFromLoop?.stats || cachedStats?.data),
                cached: true,
                stale: true,
                instant: true,
                warning: error.message
            });
        }
        refreshMatchDetails(id).catch(() => {});
        res.json({
            incidents: { incidents: [] },
            stats: req.query.stats === "0" ? null : { statistics: [] },
            pending: true,
            warning: error.message
        });
    }
});



// Yeni API: CanlÃ„Â± Liqa CÃ‰â„¢dvÃ‰â„¢li ÃƒÂ¼ÃƒÂ§ÃƒÂ¼n Proxy
function fetchFastStandingForSeason(tourId, seasonId) {
    const standingPath = `/unique-tournament/${tourId}/season/${seasonId}/standings/total`;
    return Promise.any([
        fetchFromSofaApiDirect(standingPath, {}, 2200),
        fetchFromSofaNativeFast(standingPath, {}, 2200),
        fetchFromSofaFastRace(standingPath, {}, 3200),
        fetchFromSofaApiDirect(`/unique-tournament/${tourId}/season/${seasonId}/standings`, {}, 2200),
        fetchFromSofaNativeFast(`/unique-tournament/${tourId}/season/${seasonId}/standings`, {}, 2200),
        fetchFromSofaFastRace(`/unique-tournament/${tourId}/season/${seasonId}/standings`, {}, 3200)
    ]);
}

function getEventScoreValue(score) {
    const value = score?.current ?? score?.display ?? score?.normaltime;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function addDerivedStandingTeam(teams, team) {
    if (!team?.id && !team?.name) return null;
    const key = team.id ? `id_${team.id}` : `name_${String(team.name || team.shortName).toLowerCase()}`;
    if (!teams.has(key)) {
        teams.set(key, {
            position: 0,
            team: {
                id: team.id,
                name: team.name || team.shortName || "Komanda",
                shortName: team.shortName || team.name || "Komanda",
                slug: team.slug,
                logoUrl: team.logoUrl || null
            },
            matches: 0,
            wins: 0,
            draws: 0,
            losses: 0,
            scoresFor: 0,
            scoresAgainst: 0,
            points: 0
        });
    }
    return teams.get(key);
}

async function fetchStandingsFromEventsFallback(tourId, seasonId, options = {}) {
    if (!seasonId) return null;
    const pageCount = Number(options.pages || 8);
    const timeout = Number(options.timeout || 4200);
    const paths = Array.from({ length: pageCount }, (_, page) => `/unique-tournament/${tourId}/season/${seasonId}/events/last/${page}`);
    const results = await Promise.allSettled(
        paths.map(path => Promise.any([
            fetchFromSofaApiDirect(path, {}, timeout),
            fetchFromSofaNativeFast(path, {}, timeout),
            fetchFromSofaFastRace(path, {}, timeout + 1200)
        ]))
    );

    const eventsById = new Map();
    for (const result of results) {
        if (result.status !== "fulfilled") continue;
        const events = result.value?.events || result.value?.data?.events || [];
        if (!Array.isArray(events)) continue;
        events.forEach(event => {
            if (event?.id) eventsById.set(event.id, event);
        });
    }

    const teams = new Map();
    for (const event of eventsById.values()) {
        const statusType = String(event.status?.type || "").toLowerCase();
        if (!["finished", "inprogress"].includes(statusType)) continue;
        const homeGoals = getEventScoreValue(event.homeScore);
        const awayGoals = getEventScoreValue(event.awayScore);
        if (homeGoals === null || awayGoals === null) continue;

        const home = addDerivedStandingTeam(teams, event.homeTeam);
        const away = addDerivedStandingTeam(teams, event.awayTeam);
        if (!home || !away) continue;

        home.matches += 1;
        away.matches += 1;
        home.scoresFor += homeGoals;
        home.scoresAgainst += awayGoals;
        away.scoresFor += awayGoals;
        away.scoresAgainst += homeGoals;

        if (homeGoals > awayGoals) {
            home.wins += 1;
            away.losses += 1;
            home.points += 3;
        } else if (awayGoals > homeGoals) {
            away.wins += 1;
            home.losses += 1;
            away.points += 3;
        } else {
            home.draws += 1;
            away.draws += 1;
            home.points += 1;
            away.points += 1;
        }
    }

    const rows = Array.from(teams.values())
        .filter(row => row.matches > 0)
        .sort((a, b) => {
            const goalDiffA = a.scoresFor - a.scoresAgainst;
            const goalDiffB = b.scoresFor - b.scoresAgainst;
            return b.points - a.points ||
                goalDiffB - goalDiffA ||
                b.scoresFor - a.scoresFor ||
                String(a.team.name || "").localeCompare(String(b.team.name || ""), "az");
        })
        .map((row, index) => ({ ...row, position: index + 1 }));

    if (!rows.length) return null;
    return {
        standings: [{
            type: "total",
            name: "HesablanmÄ±ÅŸ cÉ™dvÉ™l",
            rows
        }],
        seasonId,
        source: "events-derived",
        derived: true,
        fast: true
    };
}

function extractCategoryTournamentIds(data, limit = 24) {
    const out = [];
    const add = (item) => {
        const id = item?.id || item?.uniqueTournament?.id || item?.tournament?.id;
        if (id && !out.some(existing => String(existing) === String(id))) out.push(id);
    };
    if (Array.isArray(data?.uniqueTournaments)) data.uniqueTournaments.forEach(add);
    if (Array.isArray(data?.tournaments)) data.tournaments.forEach(add);
    if (Array.isArray(data?.groups)) {
        data.groups.forEach(group => {
            if (Array.isArray(group?.uniqueTournaments)) group.uniqueTournaments.forEach(add);
            if (Array.isArray(group?.tournaments)) group.tournaments.forEach(add);
            if (Array.isArray(group?.items)) group.items.forEach(add);
        });
    }
    return out.slice(0, limit);
}

function warmCategoryStandings(data, limit = 20) {
    const ids = extractCategoryTournamentIds(data, limit);
    ids.forEach((tourId, index) => {
        setTimeout(() => {
            const fallbackStanding = getFallbackStanding(tourId, null, { allowSeasonMismatch: true });
            const seasonId = KNOWN_CURRENT_SEASONS[tourId] || fallbackStanding?.seasonId;
            if (!seasonId) return;
            const cacheKey = `standings_${tourId}_${seasonId}`;
            if (cache[cacheKey]?.data?.standings?.length) return;
            getCachedData(cacheKey, async () => {
                return await fetchFastStandingForSeason(tourId, seasonId);
            }, CACHE_TIMES.STATIC, { skipJitter: true })
                .then(standing => {
                    if (standing?.standings?.length) saveStandingSnapshot(cacheKey, standing);
                })
                .catch(() => {});
        }, 300 + index * 220);
    });
}

app.get("/api/standings-fast/:tourId", async (req, res) => {
    const startedAt = Date.now();
    try {
        if (MACKOLIK_CANONICAL_MODE) {
            const data = await getCachedData(
                `mackolik_standings_${req.params.tourId}_${req.query.seasonId || "auto"}`,
                () => fetchMackolikLeagueStandings(req.params.tourId, req.query.seasonId || null),
                45 * 1000,
                { skipJitter: true }
            );
            return res.json({
                ...data,
                fast: true,
                durationMs: Date.now() - startedAt
            });
        }
        const { tourId } = req.params;
        let seasonId = req.query.seasonId;
        let season = null;
        const fallbackStanding = getFallbackStanding(tourId, seasonId) ||
            getFallbackStanding(tourId, seasonId, { allowSeasonMismatch: true });

        const cachedStanding = findCachedStandingEntry(tourId, seasonId);
        if (cachedStanding) {
            warmStandingTeamImages(cachedStanding.data, 36).catch(e => {
                console.warn(`[Image Warmup] Cached standings teams ${tourId} failed:`, e.message);
            });
            return res.json({
                ...cachedStanding.data,
                seasonId: cachedStanding.seasonId,
                cached: true,
                staleSeason: cachedStanding.staleSeason,
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
                staleSeason: !!(seasonId && fallbackStanding.seasonId && String(fallbackStanding.seasonId) !== String(seasonId)),
                fast: true,
                durationMs: Date.now() - startedAt
            });

            warmStandingTeamImages(fallbackStanding, 36).catch(e => {
                console.warn(`[Image Warmup] Snapshot standings teams ${tourId} failed:`, e.message);
            });

            const refreshSeasonId = seasonId || KNOWN_CURRENT_SEASONS[tourId] || fallbackStanding.seasonId;
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

        const initialSeasonId = seasonId || null;
        const initialStandingPromise = initialSeasonId
            ? getCachedData(`standings_${tourId}_${initialSeasonId}`, async () => {
                return await fetchFastStandingForSeason(tourId, initialSeasonId);
            }, CACHE_TIMES.STATIC, { skipJitter: true }).catch(error => {
                console.warn(`[STANDINGS FAST INITIAL] ${tourId}/${initialSeasonId}: ${error.message}`);
                return null;
            })
            : null;

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

        const seasonCacheKey = `fast_seasons_${tourId}`;
        let seasons = [];
        try {
            const seasonsData = await getCachedData(seasonCacheKey, async () => {
                return await Promise.any([
                    fetchFromSofaApiDirect(`/unique-tournament/${tourId}/seasons`, {}, 2400),
                    fetchFromSofaNativeFast(`/unique-tournament/${tourId}/seasons`, {}, 2500),
                    fetchFromSofaFastRace(`/unique-tournament/${tourId}/seasons`, {}, 4200)
                ]);
            }, CACHE_TIMES.STATIC, { skipJitter: true });
            seasons = Array.isArray(seasonsData?.seasons) ? seasonsData.seasons : [];
        } catch (seasonError) {
            console.warn(`[STANDINGS SEASONS] ${tourId}: ${seasonError.message}`);
        }

        if (!seasonId) {
            season = pickActiveSeason(seasons);
            seasonId = season?.id;
        } else {
            season = seasons.find(s => String(s.id) === String(seasonId)) || null;
        }

        if (!seasonId) {
            return res.json({
                standings: [],
                teamsFallback: [],
                message: "Season not found",
                unavailable: true,
                fast: true,
                durationMs: Date.now() - startedAt
            });
        }

        let standingsCacheKey = `standings_${tourId}_${seasonId}`;
        let data = null;
        let resolvedSeasonId = seasonId;
        let resolvedSeason = season;
        const candidates = getSeasonCandidates(seasons, seasonId, 3);
        const candidateResults = await Promise.all(candidates.map(async candidate => {
            const candidateKey = `standings_${tourId}_${candidate.id}`;
            const candidateData = String(candidate.id) === String(initialSeasonId) && initialStandingPromise
                ? await initialStandingPromise
                : await getCachedData(candidateKey, async () => {
                    return await fetchFastStandingForSeason(tourId, candidate.id);
                }, CACHE_TIMES.STATIC, { skipJitter: true }).catch(error => {
                console.warn(`[STANDINGS TRY] ${tourId}/${candidate.id}: ${error.message}`);
                return null;
            });
            return { candidate, candidateKey, candidateData };
        }));
        for (const { candidate, candidateKey, candidateData } of candidateResults) {
            if (candidateData?.standings?.length) {
                data = candidateData;
                standingsCacheKey = candidateKey;
                resolvedSeasonId = candidate.id;
                resolvedSeason = candidate;
                break;
            }
            if (!data) data = candidateData;
        }

        if (data?.standings?.length) {
            saveStandingSnapshot(standingsCacheKey, data);
            warmStandingTeamImages(data, 36).catch(e => {
                console.warn(`[Image Warmup] Standings teams ${tourId} failed:`, e.message);
            });
        }

        if (!data?.standings?.length && resolvedSeasonId) {
            const derivedCacheKey = `standings_events_${tourId}_${resolvedSeasonId}`;
            data = await getCachedData(derivedCacheKey, async () => {
                return await fetchStandingsFromEventsFallback(tourId, resolvedSeasonId, { pages: 8, timeout: 3800 });
            }, 10 * 60 * 1000, { skipJitter: true }).catch(error => {
                console.warn(`[STANDINGS EVENTS FALLBACK] ${tourId}/${resolvedSeasonId}: ${error.message}`);
                return null;
            });
            if (data?.standings?.length) {
                standingsCacheKey = `standings_${tourId}_${resolvedSeasonId}`;
                saveStandingSnapshot(standingsCacheKey, data);
                warmStandingTeamImages(data, 36).catch(e => {
                    console.warn(`[Image Warmup] Derived standings teams ${tourId} failed:`, e.message);
                });
            }
        }

        let teamsFallback = [];
        if (!data?.standings?.length && resolvedSeasonId) {
            const teamsCacheKey = `tournament_teams_${tourId}_${resolvedSeasonId}`;
            const teamsFetch = () => getCachedData(teamsCacheKey, async () => {
                return await withServerTimeout(fetchTournamentTeamsFallback(tourId, resolvedSeasonId), 2400, "Teams fallback");
            }, CACHE_TIMES.STATIC, { skipJitter: true });
            teamsFallback = await withServerTimeout(teamsFetch(), 2600, "Teams fallback response").catch(error => {
                console.warn(`[TEAMS FALLBACK] ${tourId}/${resolvedSeasonId}: ${error.message}`);
                teamsFetch()
                    .then(list => {
                        if (Array.isArray(list) && list.length) {
                            warmImagePaths(list.map(team => team?.id ? `/team/${team.id}/image` : null).filter(Boolean), 36).catch(() => {});
                        }
                    })
                    .catch(() => {});
                return [];
            });
            if (teamsFallback.length) {
                warmImagePaths(teamsFallback.map(team => team?.id ? `/team/${team.id}/image` : null).filter(Boolean), 36).catch(e => {
                    console.warn(`[Image Warmup] Teams fallback ${tourId} failed:`, e.message);
                });
            }
        }

        res.json({
            ...(data || { standings: [] }),
            teamsFallback,
            seasonId: resolvedSeasonId,
            season: resolvedSeason,
            fast: true,
            durationMs: Date.now() - startedAt
        });
    } catch (error) {
        console.error(`[API ERROR] Fast standings tour=${req.params.tourId}: ${error.message}`);
        const fallbackStanding = getFallbackStanding(req.params.tourId, req.query.seasonId) ||
            getFallbackStanding(req.params.tourId, req.query.seasonId, { allowSeasonMismatch: true });
        if (fallbackStanding) {
            warmStandingTeamImages(fallbackStanding, 36).catch(e => {
                console.warn(`[Image Warmup] Error fallback standings teams ${req.params.tourId} failed:`, e.message);
            });
            return res.json({
                ...fallbackStanding,
                seasonId: fallbackStanding.seasonId || req.query.seasonId || "snapshot",
                cached: true,
                snapshot: true,
                staleSeason: !!(req.query.seasonId && fallbackStanding.seasonId && String(fallbackStanding.seasonId) !== String(req.query.seasonId)),
                fast: true,
                durationMs: Date.now() - startedAt
            });
        }
        res.json({
            standings: [],
            seasonId: req.query.seasonId || KNOWN_CURRENT_SEASONS[req.params.tourId] || null,
            unavailable: true,
            fast: true,
            durationMs: Date.now() - startedAt,
            message: "Standings unavailable from provider"
        });
    }
});

app.get("/api/standings/:tourId/:seasonId", async (req, res) => {
    try {
        if (MACKOLIK_CANONICAL_MODE) {
            const data = await getCachedData(
                `mackolik_standings_${req.params.tourId}_${req.params.seasonId || "auto"}`,
                () => fetchMackolikLeagueStandings(req.params.tourId, req.params.seasonId || null),
                45 * 1000,
                { skipJitter: true }
            );
            return res.json(data);
        }
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
        const fallbackStanding = getFallbackStanding(req.params.tourId, req.params.seasonId) ||
            getFallbackStanding(req.params.tourId, req.params.seasonId, { allowSeasonMismatch: true });
        if (fallbackStanding) {
            warmStandingTeamImages(fallbackStanding, 36).catch(e => {
                console.warn(`[Image Warmup] Direct fallback standings teams ${req.params.tourId} failed:`, e.message);
            });
            return res.json({
                ...fallbackStanding,
                seasonId: fallbackStanding.seasonId || req.params.seasonId,
                cached: true,
                snapshot: true,
                staleSeason: !!(req.params.seasonId && fallbackStanding.seasonId && String(fallbackStanding.seasonId) !== String(req.params.seasonId))
            });
        }
        res.json({
            standings: [],
            seasonId: req.params.seasonId,
            unavailable: true,
            message: "Standings unavailable from provider"
        });
    }
});

// Yeni API: Populyar Liqalar siyahÃ„Â±sÃ„Â±
app.get("/api/top-leagues", async (req, res) => {
    if (MACKOLIK_CANONICAL_MODE) {
        try {
            const catalog = await getCachedData("mackolik_competition_catalog", fetchMackolikCompetitionCatalog, 30 * 1000, { skipJitter: true });
            return res.json({
                uniqueTournaments: catalog.uniqueTournaments,
                source: "mackolik",
                matchDate: catalog.matchDate,
                generatedAt: catalog.generatedAt
            });
        } catch (error) {
            return res.json({ uniqueTournaments: [], source: "mackolik", unavailable: true, message: error.message });
        }
    }
    const cachedEntry = cache.top_leagues;
    const cachedData = cachedEntry?.data;
    const hasCachedLeagues = Array.isArray(cachedData?.uniqueTournaments) && cachedData.uniqueTournaments.length;
    const fallback = { uniqueTournaments: FALLBACK_TOP_LEAGUES, fallback: true, snapshot: true, instant: true };
    const payload = hasCachedLeagues
        ? { ...cachedData, cached: true, instant: true }
        : fallback;

    res.json(payload);
    warmImagePaths(collectTopLeagueImagePaths(payload), 24).catch(e => {
        console.warn("[Image Warmup] Top leagues failed:", e.message);
    });

    const isFresh = hasCachedLeagues && (Date.now() - cachedEntry.timestamp < CACHE_TIMES.STATIC);
    if (!shouldStartBackgroundRefresh("top_leagues", isFresh, req.query.refresh === "1")) return;

    getCachedData("top_leagues", async () => {
        try {
            const result = await fetchFromSofa("/config/top-unique-tournaments/AZ/football");
            return result.data;
        } catch (error) {
            console.error(`[API ERROR] Top Leagues refresh: ${error.message}`);
            throw error;
        }
    }, CACHE_TIMES.STATIC, { skipJitter: true }).catch(() => {});
});

// Yeni API: BÃƒÂ¼tÃƒÂ¼n Kategoriyalar (Ãƒâ€“lkÃ‰â„¢lÃ‰â„¢r)
app.get("/api/categories", async (req, res) => {
    if (MACKOLIK_CANONICAL_MODE) {
        try {
            const catalog = await getCachedData("mackolik_competition_catalog", fetchMackolikCompetitionCatalog, 30 * 1000, { skipJitter: true });
            return res.json({
                categories: catalog.categories,
                source: "mackolik",
                matchDate: catalog.matchDate,
                generatedAt: catalog.generatedAt
            });
        } catch (error) {
            return res.json({ categories: [], source: "mackolik", unavailable: true, message: error.message });
        }
    }
    const cachedEntry = cache.categories;
    const cachedData = cachedEntry?.data;
    const cachedCategories = Array.isArray(cachedData?.categories) && cachedData.categories.length
        ? cachedData.categories
        : null;
    const fallback = { categories: FALLBACK_CATEGORIES, fallback: true, snapshot: true, instant: true };
    const payload = cachedCategories
        ? { ...cachedData, categories: cachedCategories, cached: true, instant: true }
        : fallback;

    res.json(payload);
    warmImagePaths(collectCategoryImagePaths(payload), 30).catch(e => {
        console.warn("[Image Warmup] Categories failed:", e.message);
    });

    const isFresh = cachedCategories && (Date.now() - cachedEntry.timestamp < CACHE_TIMES.STATIC);
    if (!shouldStartBackgroundRefresh("categories", isFresh, req.query.refresh === "1")) return;

    getCachedData("categories", async () => {
        try {
            const result = await fetchFromSofa("/sport/football/categories");
            return result.data;
        } catch (error) {
            console.error(`[API ERROR] Categories refresh: ${error.message}`);
            throw error;
        }
    }, CACHE_TIMES.STATIC, { skipJitter: true }).catch(() => {});
});

app.get("/api/sofa-image", async (req, res) => {
    const sendFallbackImage = (statusCode = 200) => {
        res.status(statusCode);
        res.set("Cache-Control", "public, max-age=300");
        return res.type("image/svg+xml").send(generatedImageFallbackSvg(req.query));
    };

    try {
        const imagePath = String(req.query.path || "");
        const allowedImagePath = /^\/(?:unique-tournament|tournament|category|team|player)\/[\w-]+\/image$/;
        if (!allowedImagePath.test(imagePath)) {
            return sendFallbackImage(200);
        }

        const candidatePaths = [imagePath];
        const uniqueMatch = imagePath.match(/^\/unique-tournament\/([\w-]+)\/image$/);
        const tournamentMatch = imagePath.match(/^\/tournament\/([\w-]+)\/image$/);
        if (uniqueMatch) candidatePaths.push(`/tournament/${uniqueMatch[1]}/image`);
        if (tournamentMatch) candidatePaths.push(`/unique-tournament/${tournamentMatch[1]}/image`);

        let image = null;
        let lastImageError = null;
        for (const candidatePath of Array.from(new Set(candidatePaths))) {
            try {
                image = await fetchSofaImageCached(candidatePath);
                break;
            } catch (error) {
                lastImageError = error;
            }
        }
        if (!image) throw lastImageError || new Error("Image unavailable");
        res.set("Content-Type", image.contentType || "image/png");
        res.set("Cache-Control", "public, max-age=604800, immutable");
        res.set("X-Image-Cache", image.cached ? "HIT" : "MISS");
        res.send(image.body);
    } catch (error) {
        console.warn(`[IMAGE FALLBACK] ${req.query.path}: ${error.message}`);
        return sendFallbackImage(200);
    }
});

// Yeni API: Kateqoriya ÃƒÂ¼zrÃ‰â„¢ Liqalar
app.get("/api/image-proxy", async (req, res) => {
    try {
        const rawUrl = String(req.query.url || "");
        const parsed = new URL(rawUrl);
        if (!["https:", "http:"].includes(parsed.protocol) || !EXTERNAL_IMAGE_HOSTS.has(parsed.hostname)) {
            return res.status(400).json({ error: "Image host not allowed" });
        }

        const image = await fetchExternalImageCached(parsed.href);
        res.set("Content-Type", image.contentType || inferImageContentType(parsed.href));
        res.set("Cache-Control", "public, max-age=604800, immutable");
        res.set("X-Image-Cache", image.cached ? "HIT" : "MISS");
        res.set("Access-Control-Allow-Origin", "*");
        res.send(image.body);
    } catch (error) {
        console.warn(`[IMAGE PROXY] ${req.query.url || ""}: ${error.message}`);
        res.set("Cache-Control", "public, max-age=300");
        res.set("X-Image-Cache", "FALLBACK");
        res.status(200).type("image/svg+xml").send(generatedImageFallbackSvg({
            label: "RM",
            type: "team"
        }));
    }
});

app.post("/api/image-warmup", async (req, res) => {
    try {
        const paths = Array.isArray(req.body?.paths) ? req.body.paths : [];
        const urls = Array.isArray(req.body?.urls) ? req.body.urls : [];
        Promise.allSettled([
            warmImagePaths(paths, 120),
            warmExternalImageUrls(urls, 120)
        ]).catch(() => {});
        res.json({
            success: true,
            acceptedPaths: Math.min(paths.filter(Boolean).length, 120),
            acceptedUrls: Math.min(urls.filter(Boolean).length, 120)
        });
    } catch (error) {
        res.json({ success: false, message: error.message });
    }
});

app.get("/api/category/:id/tournaments", async (req, res) => {
    const categoryId = String(req.params.id);
    if (MACKOLIK_CANONICAL_MODE) {
        try {
            const catalog = await getCachedData("mackolik_competition_catalog", fetchMackolikCompetitionCatalog, 30 * 1000, { skipJitter: true });
            const uniqueTournaments = catalog.leaguesByCategory?.[categoryId] || [];
            return res.json({
                uniqueTournaments,
                tournaments: uniqueTournaments,
                groups: uniqueTournaments.length ? [{ uniqueTournaments, tournaments: uniqueTournaments }] : [],
                source: "mackolik",
                matchDate: catalog.matchDate,
                generatedAt: catalog.generatedAt
            });
        } catch (error) {
            return res.json({ uniqueTournaments: [], tournaments: [], groups: [], source: "mackolik", unavailable: true, message: error.message });
        }
    }
    const fallbackData = getFallbackCategoryTournaments(categoryId);
    const cacheKey = `category_tournaments_${categoryId}`;
    const cached = cache[cacheKey]?.data;
    const fetchFresh = async () => {
        const data = await Promise.any([
            fetchFromSofaNativeFast(`/category/${categoryId}/unique-tournaments`, {}, 2500),
            fetchFromSofaFastRace(`/category/${categoryId}/unique-tournaments`, {}, 4200)
        ]);
        if (data?.uniqueTournaments?.length || data?.groups?.length) saveCategoryTournamentsSnapshot(categoryId, data);
        return data;
    };

    if (req.query.fast === "1" && cached) {
        res.json({ ...cached, cached: true, fast: true });
        warmCategoryStandings(cached, 20);
        if (shouldStartBackgroundRefresh(cacheKey, Date.now() - (cache[cacheKey]?.timestamp || 0) < CACHE_TIMES.STATIC, req.query.refresh === "1")) {
            getCachedData(cacheKey, fetchFresh, CACHE_TIMES.STATIC, { skipJitter: true })
                .then(data => warmImagePaths(collectTournamentImagePaths(data), 24))
                .catch(e => console.warn(`[Category Cache Refresh] ${categoryId} failed:`, e.message));
        }
        return;
    }

    if (req.query.fast === "1" && fallbackData) {
        res.json({ ...fallbackData, fallback: true, snapshot: true });
        warmCategoryStandings(fallbackData, 20);
        if (shouldStartBackgroundRefresh(cacheKey, false, req.query.refresh === "1")) {
            getCachedData(cacheKey, fetchFresh, CACHE_TIMES.STATIC, { skipJitter: true })
                .then(data => warmImagePaths(collectTournamentImagePaths(data), 36))
                .catch(e => console.warn(`[Category Snapshot Refresh] ${categoryId} failed:`, e.message));
        }
        return;
    }

    if (req.query.fast === "1") {
        try {
            const data = await fetchFresh();
            cache[cacheKey] = { data, timestamp: Date.now() };
            res.json({ ...data, fast: true });
            warmCategoryStandings(data, 20);
            warmImagePaths(collectTournamentImagePaths(data), 24).catch(e => {
                console.warn(`[Image Warmup] Category ${categoryId} fast leagues failed:`, e.message);
            });
        } catch (error) {
            res.json({
                uniqueTournaments: [],
                groups: [],
                pending: true,
                fast: true,
                message: "Category tournaments are loading"
            });
            if (shouldStartBackgroundRefresh(cacheKey, false, req.query.refresh === "1")) {
                getCachedData(cacheKey, fetchFresh, CACHE_TIMES.STATIC, { skipJitter: true })
                    .then(data => warmImagePaths(collectTournamentImagePaths(data), 24))
                    .catch(e => console.warn(`[Category Fast Refresh] ${categoryId} failed:`, e.message));
            }
        }
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
        warmCategoryStandings(data, 20);
        warmImagePaths(collectTournamentImagePaths(data), 36).catch(e => {
            console.warn(`[Image Warmup] Category ${categoryId} leagues failed:`, e.message);
        });
    } catch (error) {
        if (fallbackData) {
            res.json({ ...fallbackData, fallback: true, snapshot: true });
            warmCategoryStandings(fallbackData, 20);
            return;
        }
        res.json({
            uniqueTournaments: [],
            groups: [],
            unavailable: true,
            message: "Category tournaments unavailable"
        });
    }
});

// Yeni API: Turnir MÃ‰â„¢lumatÃ„Â± (Single League Info)
app.get("/api/tournament/:id", async (req, res) => {
    try {
        if (MACKOLIK_CANONICAL_MODE) {
            const catalog = await getCachedData("mackolik_competition_catalog", fetchMackolikCompetitionCatalog, 30 * 1000, { skipJitter: true });
            const league = catalog.uniqueTournaments.find(item => String(item.id) === String(req.params.id));
            if (!league) return res.json({ source: "mackolik", unavailable: true, message: "Mackolik liqa məlumatı tapılmadı" });
            return res.json({ uniqueTournament: league, tournament: league, source: "mackolik" });
        }
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

// Yeni API: Turnir MÃƒÂ¶vsÃƒÂ¼mlÃ‰â„¢ri (Seasons)
app.get("/api/tournament/:id/seasons", async (req, res) => {
    try {
        if (MACKOLIK_CANONICAL_MODE) {
            const seasons = await getCachedData(
                `mackolik_seasons_${req.params.id}`,
                () => fetchMackolikLeagueSeasons(req.params.id),
                6 * 60 * 60 * 1000,
                { skipJitter: true }
            );
            return res.json({ seasons, source: "mackolik" });
        }
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

// Yeni API: Qlobal AxtarÃ„Â±Ã…Å¸
app.get("/api/search", async (req, res) => {
    try {
        const { q } = req.query;
        if (!q) return res.json({ results: [] });
        if (MACKOLIK_CANONICAL_MODE) {
            const query = normalizeSearchName(String(q || ""));
            const catalog = await getCachedData("mackolik_competition_catalog", fetchMackolikCompetitionCatalog, 30 * 1000, { skipJitter: true });
            const leagues = (catalog.uniqueTournaments || [])
                .filter(league => {
                    const haystack = normalizeSearchName([
                        league?.name,
                        league?.slug,
                        league?.category?.name,
                        league?.country
                    ].filter(Boolean).join(" "));
                    return haystack.includes(query);
                })
                .slice(0, 50)
                .map(league => ({
                    type: "uniqueTournament",
                    entity: league,
                    source: "mackolik"
                }));
            return res.json({
                results: leagues,
                source: "mackolik",
                generatedAt: catalog.generatedAt
            });
        }
        const result = await fetchFromSofa("/search/all", { q });
        res.json(result.data);
    } catch (error) {
        res.status(500).json({ error: true });
    }
});

app.get("/api/team/resolve", async (req, res) => {
    try {
        const q = String(req.query.q || "").trim();
        if (!q) return res.status(400).json({ error: true, message: "Team name required" });
        const cacheKey = `team_resolve_${normalizeSearchName(q)}`;
        const data = await getCachedDataWithTimeout(cacheKey, async () => {
            const searchData = await Promise.any([
                fetchFromSofaNativeFast("/search/all", { q }, 2600),
                fetchFromSofaFastRace("/search/all", { q }, 4200),
                fetchFromSofa("/search/all", { q }).then(result => result.data)
            ]);
            const teams = extractSearchTeams(searchData);
            const team = pickBestSearchTeam(teams, q);
            if (!team?.id) throw new Error("Team not found");
            return { team, teamId: team.id, query: q };
        }, 7 * 24 * 60 * 60 * 1000, 5200, `Resolve team ${q}`, { skipJitter: true });
        res.json(data);
    } catch (error) {
        console.error(`[API ERROR] Team resolve "${req.query.q || ""}": ${error.message}`);
        res.status(404).json({ error: true, message: error.message });
    }
});

async function mackolikToSofascoreTournament(mackolikId, mackolikName) {
    if (!mackolikId) return null;
    return await getCachedData(`mackolik_to_sofa_tour_${mackolikId}`, async () => {
        let q = mackolikName;
        if (!q) {
            try {
                const settings = await fetchMackolikCompetitionPageSettings(mackolikId);
                q = settings?.competition?.name;
            } catch (e) {}
        }
        if (!q) throw new Error("No name provided for Mackolik tournament resolution");
        
        const cleanName = String(q).replace(/fikstür|puan durumu|lig|league/gi, '').trim() || String(q);
        const searchData = await Promise.any([
            fetchFromSofaNativeFast("/search/all", { q: cleanName }, 2600),
            fetchFromSofaFastRace("/search/all", { q: cleanName }, 4200)
        ]).catch(() => null);

        if (searchData && Array.isArray(searchData.results)) {
            const tours = searchData.results.find(r => r.type === "uniqueTournament")?.entities || [];
            if (tours.length > 0) {
                return tours[0].id;
            }
        }
        throw new Error("No matching Sofascore tournament found for " + cleanName);
    }, 7 * 24 * 60 * 60 * 1000, { skipJitter: true });
}

app.get("/api/smart-league-logo/:id", async (req, res) => {
    try {
        const { id } = req.params;
        const name = req.query.name || "";
        const fallbackToSofa = async () => {
            if (name) {
                try {
                    const sofaId = await mackolikToSofascoreTournament(id, name);
                    if (sofaId) {
                        return res.redirect(`/api/sofa-image?path=/unique-tournament/${sofaId}/image`);
                    }
                } catch (e) {}
            }
            res.redirect(`https://file.mackolikfeeds.com/competitions/${id}`);
        };
        await fallbackToSofa();
    } catch (error) {
        res.status(404).send("Not found");
    }
});

// Yeni API: BombardirlÃ‰â„¢r (Top Players)
app.get("/api/tournament/:id/season/:sid/top-players", async (req, res) => {
    try {
        if (MACKOLIK_CANONICAL_MODE) {
            let data = await getCachedData(
                `mackolik_topplayers_${req.params.id}_${req.params.sid || "auto"}`,
                () => fetchMackolikLeagueTopPlayers(req.params.id, req.params.sid || null),
                60 * 1000,
                { skipJitter: true }
            );
            
            if (!data || !data.topPlayers || !data.topPlayers.goals || data.topPlayers.goals.length === 0) {
                try {
                    const sofaId = await mackolikToSofascoreTournament(req.params.id, req.query.name);
                    if (sofaId) {
                        const sofaData = await fetchTopPlayersDataForBestSeason(sofaId, 'auto', { fast: req.query.fast === "1", officialOnly: false });
                        if (hasTopPlayers(sofaData)) {
                            data = sofaData;
                            data.source = "sofascore-fallback";
                        }
                    }
                } catch (e) {
                    console.warn(`[Top Players] Sofa fallback failed for Mackolik ${req.params.id}: ${e.message}`);
                }
            }
            
            return res.json({
                ...data,
                fast: req.query.fast === "1"
            });
        }
        const { id, sid } = req.params;
        const fast = req.query.fast === "1";
        const cacheKey = `topplayers_goals_v6_${id}_${sid}`;
        const now = Date.now();
        const cached = cache[cacheKey];
        const cachedHasPlayers = hasTopPlayers(cached?.data);
        const ttl = !cachedHasPlayers ? 60 * 1000 : (cached?.data?.derived ? 2 * 60 * 1000 : CACHE_TIMES.STATIC);

        let data;
        if (cached && now - cached.timestamp < ttl) {
            console.log(`[CACHE HIT] Key: ${cacheKey}`);
            data = cached.data;
        } else {
            data = await withServerTimeout(
                fetchTopPlayersDataForBestSeason(id, sid, fast ? { fast: true, maxSeasons: 1 } : {}),
                fast ? 4800 : 8500,
                "Top players"
            );
            if (data?.derived && cached?.data && !cached.data.derived && extractTopPlayersList(cached.data).length) {
                console.warn(`[Top Players] Keeping official cached data over derived fallback for ${id}/${sid}`);
                data = cached.data;
            } else if (hasTopPlayers(data)) {
                cache[cacheKey] = { data, timestamp: Date.now() };
            }
        }

        if (fast && !data?.derived && hasTopPlayers(data)) {
            getCachedData(cacheKey, async () => fetchTopPlayersDataForBestSeason(id, data.seasonId || sid), CACHE_TIMES.STATIC, { skipJitter: true })
                .catch(e => console.warn(`[Top Players Deep Refresh] ${id}/${sid}: ${e.message}`));
        }

        warmTopPlayerImages(data, 32).catch(e => {
            console.warn(`[Image Warmup] Top players ${id}/${sid} failed:`, e.message);
        });
        res.json(data);
    } catch (error) {
        const fallback = await fetchTopPlayersFromStandingsFallback(req.params.id, req.params.sid, {
            fetchFresh: req.query.fast === "1",
            timeout: 1800
        }).catch(() => null);
        if (hasTopPlayers(fallback)) {
            return res.json({ ...fallback, fast: req.query.fast === "1", fallback: true });
        }
        res.json({ topPlayers: { goals: [] }, error: true, message: error.message });
    }
});
// Yeni API: Ã…Å¾ifrÃ‰â„¢ SÃ„Â±fÃ„Â±rlama Kodu GÃƒÂ¶ndÃ‰â„¢r (OTP)
function buildPasswordResetOtpEmail(to, otp) {
    const subject = "\u015eifr\u0259 s\u0131f\u0131rlama kodunuz - Rabona Media";
    const plainText = [
        "Rabona Media LIVE",
        "",
        "Salam,",
        "",
        "\u015eifr\u0259nizi s\u0131f\u0131rlamaq \u00fc\u00e7\u00fcn t\u0259l\u0259b g\u00f6nd\u0259rdiniz. Sizin bird\u0259f\u0259lik t\u0259sdiq kodunuz (OTP):",
        otp,
        "",
        "Bu kod 3 d\u0259qiq\u0259 \u0259rzind\u0259 etibarl\u0131d\u0131r.",
        "",
        "\u018fg\u0259r bunu siz etm\u0259misinizs\u0259, z\u0259hm\u0259t olmasa bu emaili n\u0259z\u0259r\u0259 almay\u0131n.",
        "",
        "Bu avtomatik g\u00f6nd\u0259ril\u0259n bir mesajd\u0131r, cavab yazmay\u0131n."
    ].join("\n");

    const html = `
        <!doctype html>
        <html lang="az">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>${subject}</title>
        </head>
        <body style="margin:0; padding:0; background:#0f172a;">
            <div style="font-family: Arial, Helvetica, sans-serif; padding:24px; color:#e5e7eb; background:#0f172a;">
                <h2 style="color:#7aa2ff; margin:0 0 24px; font-size:28px;">Rabona Media LIVE</h2>
                <p style="font-size:16px; line-height:1.6; margin:0 0 16px;">Salam,</p>
                <p style="font-size:16px; line-height:1.6; margin:0 0 18px;">
                    \u015eifr\u0259nizi s\u0131f\u0131rlamaq \u00fc\u00e7\u00fcn t\u0259l\u0259b g\u00f6nd\u0259rdiniz. Sizin bird\u0259f\u0259lik t\u0259sdiq kodunuz (OTP):
                </p>
                <div style="font-size:36px; font-weight:800; color:#f87171; padding:18px 32px; background:#1f2937; border-radius:10px; display:inline-block; margin:8px 0 22px; letter-spacing:6px;">
                    ${otp}
                </div>
                <p style="font-size:16px; line-height:1.6; margin:0 0 16px;">Bu kod <b>3 d\u0259qiq\u0259</b> \u0259rzind\u0259 etibarl\u0131d\u0131r.</p>
                <p style="font-size:16px; line-height:1.6; margin:0 0 24px;">
                    \u018fg\u0259r bunu siz etm\u0259misinizs\u0259, z\u0259hm\u0259t olmasa bu emaili n\u0259z\u0259r\u0259 almay\u0131n.
                </p>
                <hr style="border:0; border-top:1px solid #334155; margin:24px 0;">
                <p style="font-size:13px; line-height:1.5; color:#94a3b8; margin:0;">Bu avtomatik g\u00f6nd\u0259ril\u0259n bir mesajd\u0131r, cavab yazmay\u0131n.</p>
            </div>
        </body>
        </html>
    `;

    return {
        from: `"Rabona Media" <${process.env.EMAIL_USER || "rabonamedialive@gmail.com"}>`,
        to,
        subject,
        text: plainText,
        html,
        encoding: "utf-8",
        textEncoding: "base64",
        headers: {
            "Content-Language": "az",
            "X-Auto-Response-Suppress": "All"
        }
    };
}

// Sadə Rate Limiter Memory
const rateLimitMap = new Map();
function isRateLimited(ip) {
    const now = Date.now();
    const records = rateLimitMap.get(ip) || [];
    const recent = records.filter(t => now - t < 60000); // 1 minute window
    recent.push(now);
    rateLimitMap.set(ip, recent);
    return recent.length > 5; // Max 5 requests per minute per IP
}

app.post("/api/auth/send-otp", async (req, res) => {
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    if (isRateLimited(clientIp)) {
        return res.status(429).json({ success: false, message: "Çox sayda sorğu göndərdiniz. 1 dəqiqə gözləyin." });
    }
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, message: "Email lazÃ„Â±mdÃ„Â±r." });
    console.log(`[AUTH] Sending OTP to: ${email}`);

    const otp = Math.floor(1000 + Math.random() * 9000).toString();
    const expiry = Date.now() + 3 * 60 * 1000; // 3 dÃ‰â„¢qiqÃ‰â„¢ valid

    try {
        let user = await getUserByEmail(email) || { email: email, resendCount: 0 };

        // GÃƒÂ¼ndÃ‰â„¢lik Limit YoxlanÃ„Â±Ã…Å¸Ã„Â± (5 dÃ‰â„¢fÃ‰â„¢)
        const today = new Date().toISOString().split('T')[0];
        
        if (user.lastResendDate === today) {
            if (user.resendCount >= 5) {
                return res.status(429).json({ success: false, message: "GÃƒÂ¼ndÃ‰â„¢lik limitiniz (5 dÃ‰â„¢fÃ‰â„¢) dolub. Sabah yenidÃ‰â„¢n cÃ‰â„¢hd edin." });
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
            subject: 'Ã…Å¾ifrÃ‰â„¢ SÃ„Â±fÃ„Â±rlama Kodunuz - Rabona Media',
            html: `
                <div style="font-family: Arial, sans-serif; padding: 20px; color: #333;">
                    <h2 style="color: #3b82f6;">Rabona Media LIVE</h2>
                    <p>Salam,</p>
                    <p>Ã…Å¾ifrÃ‰â„¢nizi sÃ„Â±fÃ„Â±rlamaq ÃƒÂ¼ÃƒÂ§ÃƒÂ¼n tÃ‰â„¢lÃ‰â„¢b gÃƒÂ¶ndÃ‰â„¢rdiniz. Sizin birdÃ‰â„¢fÃ‰â„¢lik tÃ‰â„¢sdiq kodunuz (OTP):</p>
                    <div style="font-size: 32px; font-weight: bold; color: #ef4444; padding: 15px 30px; background: #f1f5f9; border-radius: 8px; display: inline-block; margin: 10px 0; letter-spacing: 5px;">
                        ${otp}
                    </div>
                    <p>Bu kod <b>3 dÃ‰â„¢qiqÃ‰â„¢</b> Ã‰â„¢rzindÃ‰â„¢ etibarlÃ„Â±dÃ„Â±r.</p>
                    <p>Ã† gÃ‰â„¢r bunu siz etmÃ‰â„¢misinizsÃ‰â„¢, zÃ‰â„¢hmÃ‰â„¢t olmasa bu emaili nÃ‰â„¢zÃ‰â„¢rÃ‰â„¢ almayÃ„Â±n.</p>
                    <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;">
                    <p style="font-size: 12px; color: #94a3b8;">Bu avtomatik gÃƒÂ¶ndÃ‰â„¢rilÃ‰â„¢n bir mesajdÃ„Â±r, cavab yazmayÃ„Â±n.</p>
                </div>
            `
        };

        await transporter.sendMail(buildPasswordResetOtpEmail(email, otp));
        res.json({ success: true, message: "OTP kod email Ã¼nvanÄ±nÄ±za gÃ¶ndÉ™rildi." });

    } catch (error) {
        console.error("OTP Error:", error);
        res.status(500).json({ success: false, message: "Email gÃ¶ndÉ™rilÉ™rkÉ™n xÉ™ta baÅŸ verdi." });
    }
});

// Yeni API: OTP Kodu Yoxla (SadÃ‰â„¢cÃ‰â„¢ DoÃ„Å¸rulama)
app.post("/api/auth/check-otp", async (req, res) => {
    const { email, otp } = req.body;
    try {
        const userData = await getUserByEmail(email);
        const user = (userData && userData.otp === otp) ? userData : null;
        console.log(`[AUTH] Checking OTP for ${email}: ${otp ? 'Provided' : 'Missing'}`);
        
        if (!user) {
            console.log(`[AUTH] OTP mismatch for ${email}`);
            return res.status(400).json({ success: false, message: "Kod yanlÃ„Â±Ã…Å¸dÃ„Â±r." });
        }
        if (Date.now() > user.otpExpiry) {
            console.log(`[AUTH] OTP expired for ${email}`);
            return res.status(400).json({ success: false, message: "Kodun vaxtÃ„Â± bitib." });
        }

        res.json({ success: true, message: "Kod tÃ‰â„¢sdiqlÃ‰â„¢ndi. Yeni Ã…Å¸ifrÃ‰â„¢ni daxil edin." });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

// Yeni API: Ã…Å¾ifrÃ‰â„¢ni Final Olaraq DÃ‰â„¢yiÃ…Å¸
app.post("/api/auth/verify-otp", async (req, res) => {
    const { email, otp, newPassword } = req.body;
    
    try {
        const user = await getUserByEmail(email);
        
        if (!user || user.otp !== otp) {
            return res.status(400).json({ success: false, message: "Kod yanlÃ„Â±Ã…Å¸dÃ„Â±r." });
        }
        
        if (Date.now() > user.otpExpiry) {
            return res.status(400).json({ success: false, message: "Kodun vaxtÃ„Â± bitib." });
        }

        // ===== FIREBASE Ã…Å¾Ã„Â°FRÃ†  DEYÃ„Â°Ã…Å¾Ã„Â°KLÃ„Â°YÃ„Â° ======
        if (firebaseInitialized) {
            try {
                const firebaseUser = await admin.auth().getUserByEmail(email);
                await admin.auth().updateUser(firebaseUser.uid, {
                    password: newPassword
                });
                console.log(`[AUTH] Firebase password successfully updated for UID: ${firebaseUser.uid}`);
            } catch (fbError) {
                console.error("[AUTH] Firebase update password error:", fbError);
                return res.status(500).json({ success: false, message: "Firebase hesabÃ„Â±nÃ„Â±zla Ã‰â„¢laqÃ‰â„¢ yaradÃ„Â±la bilmÃ‰â„¢di. Ã…Å¾ifrÃ‰â„¢ yenilÃ‰â„¢nmÃ‰â„¢di." });
            }
        } else {
            console.warn("[AUTH] Firebase not initialized, skipping Firebase Auth password update.");
        }

        // OTP-ni tÃ‰â„¢mizlÃ‰â„¢ vÃ‰â„¢ Ã…Å¸ifrÃ‰â„¢ni hash-lÃ‰â„¢yÃ‰â„¢rÃ‰â„¢k saxla
        const salt = await bcrypt.genSalt(10);
        user.password = await bcrypt.hash(newPassword, salt);
        delete user.otp;
        delete user.otpExpiry;
        await saveUser(user);
        res.json({ success: true, message: "Ã…Å¾ifrÃ‰â„¢ uÃ„Å¸urla dÃ‰â„¢yiÃ…Å¸dirildi." });

    } catch (e) {
        res.status(500).json({ success: false });
    }
});

// Yeni API: Profil MÃ‰â„¢lumatlarÃ„Â±nÃ„Â± YenilÃ‰â„¢
app.post("/api/auth/update-profile", async (req, res) => {
    const { email, displayName, status, profilePic } = req.body;
    
    if (!email) return res.status(400).json({ success: false, message: "Email lazÃ„Â±mdÃ„Â±r." });

    try {
        const authUser = await getAuthUserFromRequest(req);
        const normalizedEmail = String(email).trim().toLowerCase();
        const cleanDisplayName = typeof displayName === "string" ? displayName.trim() : "";
        const uid = authUser?.uid || String(req.body.uid || "").trim();
        const effectiveEmail = String(authUser?.email || normalizedEmail).trim().toLowerCase();
        let user = await getUserByIdentity({ email: effectiveEmail, uid }) || { email: effectiveEmail, username: cleanDisplayName || effectiveEmail.split('@')[0], status: status || "Rabona Media istifadÉ™Ã§isi" };
        if (uid) user.uid = uid;
        user.email = normalizedEmail;
        user.email = effectiveEmail;
        if (cleanDisplayName) user.username = cleanDisplayName;
        if (status !== undefined) user.status = status;
        user.updatedAt = new Date().toISOString();
        await saveUser(user);
        const existingProfile = await getProfileRecord({ email: effectiveEmail, uid });
        const savedProfile = await saveProfileRecord({
            uid,
            email: effectiveEmail,
            displayName: cleanDisplayName || user.username,
            status: user.status || "Rabona Media istifadÉ™Ã§isi",
            profilePic: profilePic !== undefined ? profilePic : (existingProfile?.profilePic || ""),
            updatedAt: user.updatedAt
        });
        if (firebaseInitialized && cleanDisplayName) {
            try {
                const firebaseUid = uid || (await admin.auth().getUserByEmail(effectiveEmail)).uid;
                await admin.auth().updateUser(firebaseUid, { displayName: cleanDisplayName });
            } catch (fbError) {
                console.warn("[AUTH] Firebase displayName update skipped:", fbError.message);
            }
        }
        res.json({
            success: true,
            message: "Profil uÃ„Å¸urla yenilÃ‰â„¢ndi.",
            data: {
                displayName: savedProfile.displayName,
                status: savedProfile.status || "Rabona Media istifadÉ™Ã§isi",
                profilePic: savedProfile.profilePic || "",
                updatedAt: savedProfile.updatedAt || null
            }
        });
    } catch (e) {
        console.error("Update profile error:", e);
        res.status(500).json({ success: false, message: "Server xÃ‰â„¢tasÃ„Â± baÃ…Å¸ verdi." });
    }
});

// Yeni API: Profil MÃ‰â„¢lumatlarÃ„Â±nÃ„Â± GÃ‰â„¢tir
app.get("/api/auth/profile/:email", async (req, res) => {
    const email = String(req.params.email || "").trim().toLowerCase();
    try {
        const authUser = await getAuthUserFromRequest(req);
        const requestUid = authUser?.uid || String(req.query.uid || "").trim();
        const profile = await getProfileRecord({ email: authUser?.email || email, uid: requestUid });
        if (profile?.displayName) {
            res.set("Cache-Control", "no-store");
            return res.json({
                success: true,
                data: {
                    displayName: profile.displayName,
                    status: profile.status || "Rabona Media istifadÉ™Ã§isi",
                    profilePic: profile.profilePic || "",
                    updatedAt: profile.updatedAt || null
                }
            });
        }
        let user = await getUserByIdentity({ email: authUser?.email || email, uid: requestUid });
        if (!user && firebaseInitialized && requestUid) {
            try {
                const firebaseUser = await admin.auth().getUser(requestUid);
                user = {
                    uid: firebaseUser.uid,
                    email: String(firebaseUser.email || email).trim().toLowerCase(),
                    username: firebaseUser.displayName || String(firebaseUser.email || email).split('@')[0],
                    status: "Rabona Media istifadÉ™Ã§isi",
                    updatedAt: new Date().toISOString()
                };
                await saveUser(user);
            } catch (fbError) {
                console.warn("[AUTH] Firebase profile fallback failed:", fbError.message);
            }
        }
        if (!user) return res.status(404).json({ success: false, message: "Ã„Â°stifadÃ‰â„¢ÃƒÂ§i tapÃ„Â±lmadÃ„Â±." });

        res.set("Cache-Control", "no-store");
        res.json({
            success: true,
            data: {
                displayName: user.username,
                status: user.status || "Rabona Media istifadÉ™Ã§isi",
                profilePic: user.profilePic || "",
                updatedAt: user.updatedAt || null
            }
        });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

const SUPPORT_NOTIFY_EMAIL = process.env.SUPPORT_NOTIFY_EMAIL || "eltensabutov23@gmail.com";
const SUPPORT_EMAIL_QUEUE_FILE = "./support_email_queue.json";
let supportEmailQueueProcessing = false;

function escapeEmailHtml(value) {
    return String(value || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function buildSupportEmail(item) {
    const userLine = item.user
        ? `${item.user.displayName || "Adsiz"} ${item.user.email ? `<${item.user.email}>` : ""} ${item.user.uid ? `(${item.user.uid})` : ""}`.trim()
        : "Giris edilmeyib";
    const text = [
        "Yeni destek mesaji",
        "",
        `ID: ${item.id}`,
        `Movzu: ${item.type}`,
        `Basliq: ${item.title}`,
        `Elaqe: ${item.contact || "Yoxdur"}`,
        `Istifadeci: ${userLine}`,
        `Sehife: ${item.page || "Yoxdur"}`,
        `Tarix: ${item.createdAt}`,
        `IP: ${item.ip || "Yoxdur"}`,
        "",
        "Mesaj:",
        item.message,
        "",
        `User-Agent: ${item.userAgent || ""}`
    ].join("\n");

    const html = `
        <div style="font-family:Arial,sans-serif;line-height:1.5;color:#111827">
            <h2>Yeni dÉ™stÉ™k mesajÄ±</h2>
            <p><b>ID:</b> ${escapeEmailHtml(item.id)}</p>
            <p><b>MÃ¶vzu:</b> ${escapeEmailHtml(item.type)}</p>
            <p><b>BaÅŸlÄ±q:</b> ${escapeEmailHtml(item.title)}</p>
            <p><b>ÆlaqÉ™:</b> ${escapeEmailHtml(item.contact || "Yoxdur")}</p>
            <p><b>Ä°stifadÉ™Ã§i:</b> ${escapeEmailHtml(userLine)}</p>
            <p><b>SÉ™hifÉ™:</b> ${escapeEmailHtml(item.page || "Yoxdur")}</p>
            <p><b>Tarix:</b> ${escapeEmailHtml(item.createdAt)}</p>
            <p><b>IP:</b> ${escapeEmailHtml(item.ip || "Yoxdur")}</p>
            <hr>
            <p style="white-space:pre-wrap">${escapeEmailHtml(item.message)}</p>
            <hr>
            <p style="font-size:12px;color:#6b7280"><b>User-Agent:</b> ${escapeEmailHtml(item.userAgent || "")}</p>
        </div>`;

    return { text, html };
}

async function sendSupportEmail(item) {
    const { text, html } = buildSupportEmail(item);
    const contact = item.contact || "";
    const replyTo = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact)
        ? contact
        : (item.user?.email || undefined);
    return await transporter.sendMail({
        from: `"Rabona Media DÉ™stÉ™k" <${process.env.EMAIL_USER || 'typingmaster.az@gmail.com'}>`,
        to: SUPPORT_NOTIFY_EMAIL,
        replyTo,
        subject: `Rabona Media dÉ™stÉ™k: ${item.title}`,
        text,
        html
    });
}

function loadSupportEmailQueue() {
    try {
        if (!fs.existsSync(SUPPORT_EMAIL_QUEUE_FILE)) return [];
        const parsed = JSON.parse(fs.readFileSync(SUPPORT_EMAIL_QUEUE_FILE, "utf-8"));
        return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
        console.error("[Support] Email queue read error:", error.message);
        return [];
    }
}

function saveSupportEmailQueue(queue) {
    try {
        fs.writeFileSync(SUPPORT_EMAIL_QUEUE_FILE, JSON.stringify(queue.slice(-200), null, 2));
    } catch (error) {
        console.error("[Support] Email queue write error:", error.message);
    }
}

function enqueueSupportEmail(item) {
    const queue = loadSupportEmailQueue();
    queue.push({
        item,
        status: "pending",
        attempts: 0,
        createdAt: new Date().toISOString(),
        lastError: ""
    });
    saveSupportEmailQueue(queue);
    processSupportEmailQueue();
}

async function processSupportEmailQueue() {
    if (supportEmailQueueProcessing) return;
    supportEmailQueueProcessing = true;
    try {
        const queue = loadSupportEmailQueue();
        let changed = false;
        for (const entry of queue) {
            if (entry.status === "sent") continue;
            if ((entry.attempts || 0) >= 5) continue;
            try {
                entry.attempts = (entry.attempts || 0) + 1;
                entry.lastAttemptAt = new Date().toISOString();
                const info = await sendSupportEmail(entry.item);
                entry.status = "sent";
                entry.sentAt = new Date().toISOString();
                entry.messageId = info?.messageId || "";
                entry.lastError = "";
                changed = true;
                console.log(`[Support] Email sent to ${SUPPORT_NOTIFY_EMAIL}: ${entry.item?.id || ""}`);
            } catch (error) {
                entry.status = "pending";
                entry.lastError = error.message;
                changed = true;
                console.error("[Support] Email send error:", error.message);
                break;
            }
        }
        const keep = queue.filter(entry => entry.status !== "sent" || Date.now() - Date.parse(entry.sentAt || 0) < 24 * 60 * 60 * 1000);
        if (changed || keep.length !== queue.length) saveSupportEmailQueue(keep);
    } finally {
        supportEmailQueueProcessing = false;
    }
}

app.post("/api/support", async (req, res) => {
    try {
        const type = String(req.body?.type || "other").slice(0, 40);
        const title = String(req.body?.title || "").trim().slice(0, 120);
        const message = String(req.body?.message || "").trim().slice(0, 1200);
        const contact = String(req.body?.contact || "").trim().slice(0, 120);

        if (!title || !message) {
            return res.status(400).json({ success: false, message: "BaÅŸlÄ±q vÉ™ mesaj lazÄ±mdÄ±r" });
        }

        let items = [];
        if (fs.existsSync(SUPPORT_MESSAGES_FILE)) {
            try {
                const parsed = JSON.parse(fs.readFileSync(SUPPORT_MESSAGES_FILE, "utf-8"));
                if (Array.isArray(parsed)) items = parsed;
            } catch (_) {}
        }

        const item = {
            id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
            type,
            title,
            message,
            contact,
            page: String(req.body?.page || "").slice(0, 300),
            userAgent: String(req.body?.userAgent || req.headers["user-agent"] || "").slice(0, 300),
            user: req.body?.user ? {
                uid: String(req.body.user.uid || "").slice(0, 120),
                email: String(req.body.user.email || "").slice(0, 160),
                displayName: String(req.body.user.displayName || "").slice(0, 120)
            } : null,
            createdAt: req.body?.createdAt || new Date().toISOString(),
            ip: req.headers["x-forwarded-for"] || req.socket?.remoteAddress || ""
        };

        items.unshift(item);
        try {
            const info = await sendSupportEmail(item);
            item.emailStatus = "sent";
            item.emailSentAt = new Date().toISOString();
            item.emailMessageId = info?.messageId || "";
            fs.writeFileSync(SUPPORT_MESSAGES_FILE, JSON.stringify(items.slice(0, 500), null, 2));
            res.json({ success: true, id: item.id, emailSent: true });
        } catch (mailError) {
            item.emailStatus = "failed";
            item.emailError = mailError.message;
            item.emailFailedAt = new Date().toISOString();
            fs.writeFileSync(SUPPORT_MESSAGES_FILE, JSON.stringify(items.slice(0, 500), null, 2));
            enqueueSupportEmail(item);
            console.error("[Support] Email send failed:", mailError.message);
            res.status(502).json({
                success: false,
                id: item.id,
                message: "Mesaj saxlanÄ±ldÄ±, amma email gÃ¶ndÉ™rilmÉ™di. Email ayarlarÄ±nÄ± yoxlayÄ±n."
            });
        }
    } catch (error) {
        console.error("[Support] Save error:", error.message);
        res.status(500).json({ success: false, message: "DÉ™stÉ™k mesajÄ± saxlanmadÄ±" });
    }
});

// FCM Device & Favorites Tracking
const REG_FILE = "./registrations.json";
let fcmRegistrations = {}; // { token: { favorites: [] } }
const WEB_PUSH_FILE = "./webpush_registrations.json";
let webPushRegistrations = {}; // { deviceId: { subscription, favorites, leagues } }
const SUPPORT_MESSAGES_FILE = "./support_messages.json";

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
const registrationsReadyPromise = loadRegistrations();

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
const webPushRegistrationsReadyPromise = loadWebPushRegistrations();

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

function repairFavoriteText(value) {
    const text = String(value || "");
    if (!/[ÃƒÃ‚Ã„Ã…Ã†]/.test(text)) return text;
    try {
        const repaired = Buffer.from(text, "latin1").toString("utf8");
        return repaired && !repaired.includes("ï¿½") ? repaired : text;
    } catch (e) {
        return text;
    }
}

function normalizeFavoriteText(value) {
    return repairFavoriteText(value)
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[ÆÉ™]/g, "e")
        .replace(/[Ä°IÄ±]/g, "i")
        .replace(/[ÄÄŸ]/g, "g")
        .replace(/[ÃœÃ¼]/g, "u")
        .replace(/[ÅÅŸ]/g, "s")
        .replace(/[Ã–Ã¶]/g, "o")
        .replace(/[Ã‡Ã§]/g, "c")
        .toLowerCase()
        .replace(/&/g, " and ")
        .replace(/[^a-z0-9]+/g, " ")
        .trim()
        .replace(/\s+/g, " ");
}

function normalizeFavoriteKey(value) {
    return String(value || "")
        .split("|")
        .map(part => {
            const trimmed = part.trim();
            return /^\d+$/.test(trimmed) ? trimmed : normalizeFavoriteText(trimmed);
        })
        .filter(Boolean)
        .join("|");
}

function normalizeFavoriteKeyList(list) {
    return Array.isArray(list)
        ? [...new Set(list.map(normalizeFavoriteKey).filter(Boolean))]
        : [];
}

function stripTeamNoise(value) {
    return normalizeFavoriteText(value)
        .replace(/\b(football club|futbol klubu|club de football|club|fc|cf|sc|afc|fk|sk|wfc)\b/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function favoriteTextsMatch(a, b) {
    const left = normalizeFavoriteText(a);
    const right = normalizeFavoriteText(b);
    if (!left || !right) return false;
    if (left === right) return true;

    const leftTeam = stripTeamNoise(left);
    const rightTeam = stripTeamNoise(right);
    if (leftTeam && rightTeam && leftTeam === rightTeam) return true;

    return left.length >= 6 && right.length >= 6 && (left.includes(right) || right.includes(left));
}

function favoriteTournamentMatches(a, b) {
    const left = normalizeFavoriteText(a);
    const right = normalizeFavoriteText(b);
    if (!left || !right) return true;
    return left === right || (left.length >= 6 && right.length >= 6 && (left.includes(right) || right.includes(left)));
}

function favoriteStartMatches(refStart, eventStart) {
    if (!refStart || !eventStart) return false;
    const left = Number(refStart);
    const right = Number(eventStart);
    return Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= 12 * 60 * 60;
}

function favoriteStartLooselyMatches(refStart, eventStart) {
    if (!refStart || !eventStart) return false;
    const left = Number(refStart);
    const right = Number(eventStart);
    return Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= 30 * 60 * 60;
}

function favoriteStartSameLiveWindow(refStart, eventStart) {
    if (!refStart || !eventStart) return false;
    const left = Number(refStart);
    const right = Number(eventStart);
    return Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= 48 * 60 * 60;
}

function favoriteRefWasRecentlyUpdated(ref, maxAgeMs = 12 * 60 * 60 * 1000) {
    const ts = Number(ref?.favoritedAt || ref?.savedAt || 0);
    return Number.isFinite(ts) && ts > 0 && Date.now() - ts <= maxAgeMs;
}

function isCrossSourceLiveEvent(event) {
    const source = String(event?.source || "").toLowerCase();
    return source.includes("mackolik") || source.includes("push-fallback") || source.includes("fallback");
}

function getEventTournamentName(event) {
    return event?.tournament?.name || event?.tournament?.uniqueTournament?.name || event?.uniqueTournament?.name || "";
}

function buildServerFavoriteKey(event, options = {}) {
    if (!event) return "";
    const home = normalizeFavoriteText(event.homeTeam?.name || event.homeTeam?.shortName);
    const away = normalizeFavoriteText(event.awayTeam?.name || event.awayTeam?.shortName);
    const tournament = normalizeFavoriteText(getEventTournamentName(event));
    const start = options.includeStart === false ? "" : (event.startTimestamp ? String(event.startTimestamp) : "");
    return [home, away, tournament, start].filter(Boolean).join("|");
}

function buildServerFavoriteKeyVariants(event) {
    const keys = new Set();
    const exact = buildServerFavoriteKey(event);
    const noStart = buildServerFavoriteKey(event, { includeStart: false });
    if (exact) keys.add(exact);
    if (noStart) keys.add(noStart);
    return Array.from(keys);
}

function normalizeFavoriteMatchRefs(list) {
    if (!Array.isArray(list)) return [];
    return list
        .map(item => {
            if (!item || typeof item !== "object") return null;
            const ref = {
                id: item.id ? String(item.id) : "",
                favoriteKey: normalizeFavoriteKey(item.favoriteKey || buildServerFavoriteKey(item)),
                favoriteKeyNoStart: normalizeFavoriteKey(item.favoriteKeyNoStart || buildServerFavoriteKey(item, { includeStart: false })),
                home: normalizeFavoriteText(item.homeTeam?.name || item.homeTeam?.shortName || item.home || item.homeName),
                away: normalizeFavoriteText(item.awayTeam?.name || item.awayTeam?.shortName || item.away || item.awayName),
                tournament: normalizeFavoriteText(item.tournament?.name || item.tournamentName || item.leagueName),
                startTimestamp: item.startTimestamp ? String(item.startTimestamp) : "",
                favoritedAt: Number(item.favoritedAt || item.savedAt || 0) || 0,
                homeScoreAtFavorite: Number(item.homeScoreAtFavorite ?? item.homeScore?.current ?? item.homeScore ?? 0),
                awayScoreAtFavorite: Number(item.awayScoreAtFavorite ?? item.awayScore?.current ?? item.awayScore ?? 0)
            };
            return (ref.id || ref.favoriteKey || ref.favoriteKeyNoStart || (ref.home && ref.away)) ? ref : null;
        })
        .filter(Boolean)
        .slice(0, 200);
}

function favoriteRefMatchesEvent(ref, event, matchKey, eventKeySet) {
    if (!ref || !event) return false;
    if (ref.id && ref.id === matchKey) return true;
    if (ref.favoriteKey && eventKeySet.has(ref.favoriteKey)) return true;
    if (ref.favoriteKeyNoStart && eventKeySet.has(ref.favoriteKeyNoStart)) return true;

    const home = normalizeFavoriteText(event.homeTeam?.name || event.homeTeam?.shortName);
    const away = normalizeFavoriteText(event.awayTeam?.name || event.awayTeam?.shortName);
    const tournament = normalizeFavoriteText(getEventTournamentName(event));
    if (!ref.home || !ref.away) return false;
    const sameOrder = favoriteTextsMatch(ref.home, home) && favoriteTextsMatch(ref.away, away);
    const reverseOrder = favoriteTextsMatch(ref.home, away) && favoriteTextsMatch(ref.away, home);
    const sameTournament = favoriteTournamentMatches(ref.tournament, tournament);
    const sameStart = favoriteStartMatches(ref.startTimestamp, event.startTimestamp);
    const looseStart = favoriteStartLooselyMatches(ref.startTimestamp, event.startTimestamp);
    const sameLiveWindow = favoriteStartSameLiveWindow(ref.startTimestamp, event.startTimestamp);
    const teamsMatch = sameOrder || reverseOrder;
    const hasStartData = !!ref.startTimestamp && !!event.startTimestamp;
    const canTrustTeamsOnly = !hasStartData && (!ref.tournament || !tournament);
    const crossSourceLive = isCrossSourceLiveEvent(event);
    const recentlyFavorited = favoriteRefWasRecentlyUpdated(ref);

    if (teamsMatch && crossSourceLive) {
        const tournamentLooksDifferent = ref.tournament && tournament && !sameTournament;
        const sourceCanRenameTournament = tournamentLooksDifferent || !ref.tournament || !tournament;
        if (sameStart || looseStart || sameLiveWindow || recentlyFavorited || sourceCanRenameTournament) {
            return true;
        }
    }

    return teamsMatch && (sameTournament || sameStart || looseStart || canTrustTeamsOnly);
}

function getFavoritePayloadFromReg(reg) {
    const favoriteMatches = normalizeFavoriteMatchRefs(reg?.favoriteMatches || reg?.matches || []);
    const favoriteKeySet = new Set(normalizeFavoriteKeyList(reg?.favoriteKeys));
    favoriteMatches.forEach(ref => {
        if (ref.favoriteKey) favoriteKeySet.add(ref.favoriteKey);
        if (ref.favoriteKeyNoStart) favoriteKeySet.add(ref.favoriteKeyNoStart);
    });
    return {
        favorites: normalizeIdList(reg?.favorites),
        leagues: normalizeIdList(reg?.leagues),
        teams: normalizeIdList(reg?.teams),
        favoriteKeys: Array.from(favoriteKeySet),
        favoriteMatches
    };
}

function favoriteTeamsMatchEvent(teamIds = [], event = null) {
    if (!event || !Array.isArray(teamIds) || teamIds.length === 0) return false;
    const homeId = event.homeTeam?.id?.toString();
    const awayId = event.awayTeam?.id?.toString();
    return teamIds.includes(homeId) || teamIds.includes(awayId);
}

function getFavoriteRefInitialScore(ref) {
    const home = Number(ref?.homeScoreAtFavorite);
    const away = Number(ref?.awayScoreAtFavorite);
    if (!Number.isFinite(home) || !Number.isFinite(away)) return null;
    return { homeScore: home, awayScore: away };
}

function findLiveEventForFavoriteRef(ref, events = []) {
    if (!ref) return null;
    for (const event of events) {
        if (!event?.id) continue;
        const eventKeys = new Set(buildServerFavoriteKeyVariants(event));
        if (favoriteRefMatchesEvent(ref, event, String(event.id), eventKeys)) return event;
    }
    return null;
}

async function sendMissedGoalPushForRegistration(channel, id, reg, reason = "favorite-sync", liveEvents = null) {
    const payload = getFavoritePayloadFromReg(reg);
    if (!payload.favoriteMatches.length) return { checked: 0, sent: 0 };

    let sourceEvents = Array.isArray(liveEvents) ? liveEvents : [];
    if (!sourceEvents.length) {
        const liveData = await fetchLiveScoresForNotifications({ allowPushFallback: true, saveSnapshot: false }).catch(() => globalLiveEvents);
        sourceEvents = Array.isArray(liveData?.events) ? liveData.events : [];
    }
    if (!sourceEvents.length) return { checked: payload.favoriteMatches.length, sent: 0 };

    let sent = 0;
    for (const ref of payload.favoriteMatches) {
        const initial = getFavoriteRefInitialScore(ref);
        if (!initial) continue;
        const event = findLiveEventForFavoriteRef(ref, sourceEvents);
        if (!event?.id) continue;

        const current = getScoreSnapshot(event);
        if ((current.homeScore + current.awayScore) <= (initial.homeScore + initial.awayScore)) continue;

        const matchId = String(event.id);
        const scoreMarker = `score-${current.homeScore}-${current.awayScore}`;
        const deliveryMarker = getGoalPushDeliveryMarker({
            type: "goal_score",
            score: `${current.homeScore}-${current.awayScore}`
        });
        if (recipientScorePushAlreadySent(reg, matchId, deliveryMarker)) continue;

        const leagueId = (event.tournament?.uniqueTournament?.id || event.tournament?.id || "").toString();
        const homeName = event.homeTeam?.name || ref.home || "Ev sahibi";
        const awayName = event.awayTeam?.name || ref.away || "Qonaq";
        const homeDelta = current.homeScore - initial.homeScore;
        const awayDelta = current.awayScore - initial.awayScore;
        const scoringSide = homeDelta > 0 ? "home" : "away";
        const scoringTeam = homeDelta > 0 ? homeName : awayName;
        const title = `QOL! ${scoringTeam}`;
        const body = `${homeName} ${current.homeScore} - ${current.awayScore} ${awayName}`;

        const result = await sendGoalPushToRecipients([{ channel, id, reg }], {
            title,
            body,
            matchId,
            leagueId,
            type: "goal_score",
            score: `${current.homeScore}-${current.awayScore}`,
            tag: `goal-score-${matchId}-${current.homeScore}-${current.awayScore}`,
            ttl: "300"
        });
        if (result.sent > 0) {
            sent += result.sent;
            pendingGoalDetailNotifications[matchId] = {
                scoreMarker,
                homeScore: current.homeScore,
                awayScore: current.awayScore,
                score: `${current.homeScore}-${current.awayScore}`,
                previousGoalTotal: initial.homeScore + initial.awayScore,
                scoringSide: awayDelta > 0 && homeDelta <= 0 ? "away" : scoringSide,
                leagueId,
                createdAt: Date.now()
            };
            rememberRecipientScorePush(reg, matchId, deliveryMarker);
            if (channel === "fcm") saveRegistrations();
            if (channel === "webpush") saveWebPushRegistrations();
            queueGoalScorerChecks(event, `missed-${reason}`);
            console.log(`[Push][MissedGoal][${reason}] sent=${result.sent} channel=${channel} match=${matchId}`);
        }
    }
    return { checked: payload.favoriteMatches.length, sent };
}

function queueMissedGoalCheck(channel, id, reg, reason) {
    const delays = [250, 3500, 12000];
    delays.forEach(delay => {
        setTimeout(() => {
            sendMissedGoalPushForRegistration(channel, id, reg, reason).catch(error => {
                console.warn(`[Push][MissedGoal] ${channel}:${id} failed: ${error.message}`);
            });
        }, delay);
    });
}

async function runFavoriteGoalCatchup(events, reason = "live-poll") {
    if (favoriteGoalCatchupInFlight || !Array.isArray(events) || events.length === 0) return;
    favoriteGoalCatchupInFlight = true;
    try {
        const tasks = [];
        Object.entries(fcmRegistrations).forEach(([token, reg]) => {
            tasks.push(sendMissedGoalPushForRegistration("fcm", token, reg, reason, events));
        });
        Object.entries(webPushRegistrations).forEach(([deviceId, reg]) => {
            tasks.push(sendMissedGoalPushForRegistration("webpush", deviceId, reg, reason, events));
        });
        if (tasks.length) await Promise.allSettled(tasks);
    } finally {
        favoriteGoalCatchupInFlight = false;
    }
}

function collectFavoriteRecipients(matchId, leagueId, favoriteKey = "", event = null) {
    const matchKey = matchId?.toString();
    const leagueKey = leagueId?.toString();
    const eventKeys = new Set([normalizeFavoriteKey(favoriteKey), ...(event ? buildServerFavoriteKeyVariants(event) : [])].filter(Boolean));
    const recipients = [];

    Object.entries(fcmRegistrations).forEach(([token, reg]) => {
        const { favorites, leagues, teams, favoriteKeys, favoriteMatches } = getFavoritePayloadFromReg(reg);
        if (
            favorites.includes(matchKey) ||
            leagues.includes(leagueKey) ||
            favoriteTeamsMatchEvent(teams, event) ||
            favoriteKeys.some(key => eventKeys.has(key)) ||
            favoriteMatches.some(ref => favoriteRefMatchesEvent(ref, event, matchKey, eventKeys))
        ) {
            recipients.push({ channel: "fcm", id: token, reg });
        }
    });

    Object.entries(webPushRegistrations).forEach(([deviceId, reg]) => {
        const { favorites, leagues, teams, favoriteKeys, favoriteMatches } = getFavoritePayloadFromReg(reg);
        if (
            favorites.includes(matchKey) ||
            leagues.includes(leagueKey) ||
            favoriteTeamsMatchEvent(teams, event) ||
            favoriteKeys.some(key => eventKeys.has(key)) ||
            favoriteMatches.some(ref => favoriteRefMatchesEvent(ref, event, matchKey, eventKeys))
        ) {
            recipients.push({ channel: "webpush", id: deviceId, reg });
        }
    });

    return recipients;
}

function collectFavoriteRecipientsForEvent(event, matchId, leagueId) {
    return collectFavoriteRecipients(matchId || event?.id, leagueId, buildServerFavoriteKey(event), event);
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
        reg.lastPushAttemptAt = Date.now();
        reg.lastPushType = payload?.data?.type || payload?.type || "general";
        reg.lastPushTitle = payload?.title || "";
        await webpush.sendNotification(reg.subscription, JSON.stringify(payload), {
            TTL: payload.ttl || 4 * 60 * 60,
            urgency: payload.urgency || "high"
        });
        reg.lastPushSuccessAt = Date.now();
        reg.lastPushError = "";
        return true;
    } catch (err) {
        const detail = err.body || err.response?.body || err.message || "";
        reg.lastPushErrorAt = Date.now();
        reg.lastPushError = String(detail || err.message || "").slice(0, 240);
        console.error(`[WebPush] Send error for ${deviceId}:`, err.statusCode || err.message, detail ? String(detail).slice(0, 240) : "");
        if (err.statusCode === 404 || err.statusCode === 410) {
            removeInvalidWebPushRegistration(deviceId);
        }
        return false;
    }
}

function createPushPayload({ title, body, matchId, leagueId, type, tag, requireInteraction = false, ttl = 4 * 60 * 60, urgency = "high" }) {
    return {
        title,
        body,
        icon: "/icons/icon-192.png",
        badge: "/icons/icon-192.png",
        tag,
        vibrate: [300, 100, 300],
        requireInteraction,
        ttl,
        urgency,
        data: {
            matchId: matchId?.toString() || "",
            leagueId: leagueId?.toString() || "",
            type: type || "general",
            sentAt: Date.now().toString(),
            url: "/"
        }
    };
}

function buildRegistrationFavoriteKeys(favorites = [], favoriteKeys = [], favoriteMatches = []) {
    const keySet = new Set(normalizeFavoriteKeyList(favoriteKeys));
    const refs = normalizeFavoriteMatchRefs(favoriteMatches);
    refs.forEach(ref => {
        if (ref.favoriteKey) keySet.add(ref.favoriteKey);
        if (ref.favoriteKeyNoStart) keySet.add(ref.favoriteKeyNoStart);
    });
    normalizeIdList(favorites).forEach(id => {
        const liveMatch = globalLiveEvents?.events?.find(event => event?.id?.toString() === id);
        buildServerFavoriteKeyVariants(liveMatch).forEach(key => keySet.add(key));
    });
    return Array.from(keySet);
}

function buildRegistrationFavoriteState({ favorites, leagues, teams, favoriteKeys, favoriteMatches }) {
    const refs = normalizeFavoriteMatchRefs(favoriteMatches);
    return {
        favorites: normalizeIdList(favorites),
        leagues: normalizeIdList(leagues),
        teams: normalizeIdList(teams),
        favoriteKeys: buildRegistrationFavoriteKeys(favorites, favoriteKeys, refs),
        favoriteMatches: refs,
        lastUpdated: Date.now()
    };
}

app.post("/api/fcm/register", (req, res) => {
    const { token, favorites, leagues, teams, favoriteKeys, favoriteMatches } = req.body;
    if (token) {
        const previous = fcmRegistrations[token] || {};
        fcmRegistrations[token] = { 
            ...previous,
            ...buildRegistrationFavoriteState({ favorites, leagues, teams, favoriteKeys, favoriteMatches }),
            recipientScorePushState: previous.recipientScorePushState || {}
        };
        saveRegistrations();
        console.log(`[FCM] Token updated. Matches: ${(favorites||[]).length}, Keys: ${fcmRegistrations[token].favoriteKeys.length}, Leagues: ${(leagues||[]).length}, Teams: ${(teams||[]).length}`);
        queueMissedGoalCheck("fcm", token, fcmRegistrations[token], "fcm-register");
        res.json({ success: true });
    } else {
        res.status(400).json({ success: false, message: "Token is required" });
    }
});

app.get("/api/push/public-key", (req, res) => {
    res.json({ success: true, publicKey: VAPID_PUBLIC_KEY });
});

app.post("/api/push/subscribe", (req, res) => {
    const { deviceId, subscription, favorites, leagues, teams, favoriteKeys, favoriteMatches, platform, userAgent } = req.body || {};
    if (!deviceId || !subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
        return res.status(400).json({ success: false, message: "deviceId and valid subscription are required" });
    }

    const previous = webPushRegistrations[deviceId] || {};
    webPushRegistrations[deviceId] = {
        ...previous,
        subscription,
        ...buildRegistrationFavoriteState({ favorites, leagues, teams, favoriteKeys, favoriteMatches }),
        platform: platform || "webpush",
        userAgent: userAgent || "",
        recipientScorePushState: previous.recipientScorePushState || {}
    };
    saveWebPushRegistrations();
    console.log(`[WebPush] Device updated. Device: ${deviceId}, Matches: ${(favorites || []).length}, Keys: ${webPushRegistrations[deviceId].favoriteKeys.length}, Leagues: ${(leagues || []).length}, Teams: ${(teams || []).length}`);
    queueMissedGoalCheck("webpush", deviceId, webPushRegistrations[deviceId], "webpush-subscribe");
    let endpointHost = "";
    try {
        endpointHost = new URL(subscription.endpoint).hostname;
    } catch (e) {}
    res.json({
        success: true,
        deviceId,
        platform: webPushRegistrations[deviceId].platform,
        endpointHost,
        favoriteCount: webPushRegistrations[deviceId].favorites.length,
        favoriteKeyCount: webPushRegistrations[deviceId].favoriteKeys.length,
        vapidKeySource: VAPID_KEY_SOURCE
    });
});

app.post("/api/push/favorites-sync", (req, res) => {
    const { token, deviceId, favorites, leagues, teams, favoriteKeys, favoriteMatches } = req.body || {};
    const favoriteState = buildRegistrationFavoriteState({ favorites, leagues, teams, favoriteKeys, favoriteMatches });
    let updated = 0;

    if (token && fcmRegistrations[token]) {
        fcmRegistrations[token] = {
            ...fcmRegistrations[token],
            ...favoriteState
        };
        queueMissedGoalCheck("fcm", token, fcmRegistrations[token], "favorites-sync");
        updated++;
    }

    if (deviceId && webPushRegistrations[deviceId]) {
        webPushRegistrations[deviceId] = {
            ...webPushRegistrations[deviceId],
            ...favoriteState
        };
        queueMissedGoalCheck("webpush", deviceId, webPushRegistrations[deviceId], "favorites-sync");
        updated++;
    }

    if (updated > 0) {
        saveRegistrations();
        saveWebPushRegistrations();
    }

    res.json({
        success: true,
        updated,
        favoriteCount: favoriteState.favorites.length,
        favoriteKeyCount: favoriteState.favoriteKeys.length,
        leagueCount: favoriteState.leagues.length,
        teamCount: favoriteState.teams.length
    });
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
            body: "TÉ™briklÉ™r! Arxa plan bildiriÅŸlÉ™ri artÄ±q aktivdir."
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
                icon: '/icons/icon-192.png',
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
            body: "Test bildiriÅŸi uÄŸurla gÃ¶ndÉ™rildi. Arxa plan bildiriÅŸlÉ™ri hazÄ±rdÄ±r.",
            type: "test",
            tag: `test-${deviceId}-${Date.now()}`,
            requireInteraction: true
        });
        const sent = await sendWebPushMessage(deviceId, payload);
        if (!sent) {
            return res.status(502).json({ success: false, message: "Web Push gÃ¶ndÉ™rilmÉ™di. AbunÉ™liyi yenidÉ™n aktiv edin." });
        }
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.get("/api/push/status", (req, res) => {
    const fcmFavoriteMatches = Object.values(fcmRegistrations).reduce((sum, reg) => sum + getFavoritePayloadFromReg(reg).favorites.length, 0);
    const webPushFavoriteMatches = Object.values(webPushRegistrations).reduce((sum, reg) => sum + getFavoritePayloadFromReg(reg).favorites.length, 0);
    const fcmFavoriteKeys = Object.values(fcmRegistrations).reduce((sum, reg) => sum + getFavoritePayloadFromReg(reg).favoriteKeys.length, 0);
    const webPushFavoriteKeys = Object.values(webPushRegistrations).reduce((sum, reg) => sum + getFavoritePayloadFromReg(reg).favoriteKeys.length, 0);
    const webPushPlatforms = Object.values(webPushRegistrations).reduce((acc, reg) => {
        const key = reg.platform || "unknown";
        acc[key] = (acc[key] || 0) + 1;
        return acc;
    }, {});
    const webPushEndpointHosts = Object.values(webPushRegistrations).reduce((acc, reg) => {
        try {
            const key = new URL(reg.subscription?.endpoint || "").hostname || "unknown";
            acc[key] = (acc[key] || 0) + 1;
        } catch (e) {
            acc.unknown = (acc.unknown || 0) + 1;
        }
        return acc;
    }, {});
    res.json({
        success: true,
        firebaseInitialized,
        vapidKeySource: VAPID_KEY_SOURCE,
        vapidPairComplete: !!VAPID_PUBLIC_KEY && !!VAPID_PRIVATE_KEY,
        envVapidPairComplete: HAS_COMPLETE_ENV_VAPID_PAIR,
        fcmRegistrations: Object.keys(fcmRegistrations).length,
        webPushRegistrations: Object.keys(webPushRegistrations).length,
        webPushPlatforms,
        webPushEndpointHosts,
        fcmFavoriteMatches,
        webPushFavoriteMatches,
        fcmFavoriteKeys,
        webPushFavoriteKeys,
        lastScores: Object.keys(lastScores).length,
        scorePushState: Object.keys(scorePushState).length,
        lastLiveFetchTime: lastLiveFetchTime ? new Date(lastLiveFetchTime).toISOString() : null,
        liveSnapshotEvents: Array.isArray(globalLiveEvents?.events) ? globalLiveEvents.events.length : 0,
        liveSnapshotClient: !!globalLiveEvents?.clientSnapshot,
        sofaScoreOnlyMode: SOFASCORE_ONLY_MODE,
        mackolikVisibleMatchesEnabled: ENABLE_MACKOLIK_MATCHES,
        mackolikPushFallbackEnabled: ENABLE_MACKOLIK_PUSH_FALLBACK
    });
});

app.get("/api/push/device-status/:deviceId", (req, res) => {
    const deviceId = String(req.params.deviceId || "");
    const reg = webPushRegistrations[deviceId];
    if (!deviceId || !reg) {
        return res.status(404).json({
            success: false,
            registered: false,
            message: "Device Web Push qeydiyyatÄ± serverdÉ™ tapÄ±lmadÄ±"
        });
    }

    const payload = getFavoritePayloadFromReg(reg);
    let endpointHost = "";
    try {
        endpointHost = new URL(reg.subscription?.endpoint || "").hostname;
    } catch (e) {}

    res.json({
        success: true,
        registered: true,
        deviceId,
        platform: reg.platform || "webpush",
        endpointHost,
        favoriteCount: payload.favorites.length,
        favoriteKeyCount: payload.favoriteKeys.length,
        leagueCount: payload.leagues.length,
        favoriteMatchCount: payload.favoriteMatches.length,
        recipientScoreStateCount: Object.keys(reg.recipientScorePushState || {}).length,
        lastUpdated: reg.lastUpdated || null,
        vapidKeySource: VAPID_KEY_SOURCE
    });
});

async function sendBroadcastPushTest() {
    const title = "Rabona Media Test";
    const body = "Bu test bildiriÅŸidir. Sayt baÄŸlÄ± olsa da telefona Ã§atmalÄ±dÄ±r.";

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
                            icon: "/icons/icon-192.png",
                            badge: "/icons/icon-192.png",
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
            tag: `broadcast-${deviceId}-${Date.now()}`,
            requireInteraction: true
        }));
        if (ok) sentWebPush++;
    }

    return {
        success: true,
        sentFcm,
        sentWebPush,
        totalTargets: fcmTokens.length + webPushDevices.length,
        timestamp: new Date().toISOString()
    };
}

app.post("/api/push/broadcast-test", async (req, res) => {
    try {
        res.json(await sendBroadcastPushTest());
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get("/api/push/broadcast-test", async (req, res) => {
    try {
        const result = await sendBroadcastPushTest();
        res.type("html").send(`
            <!doctype html>
            <meta charset="utf-8">
            <title>Push Test</title>
            <body style="font-family:Arial,sans-serif;background:#020617;color:#f8fafc;padding:32px">
                <h1>Push test gÃ¶ndÉ™rildi</h1>
                <p>FCM: ${result.sentFcm} | WebPush: ${result.sentWebPush} | CÉ™mi qeydiyyat: ${result.totalTargets}</p>
                <pre style="background:#0f172a;border:1px solid #1e293b;padding:16px;border-radius:12px">${JSON.stringify(result, null, 2)}</pre>
                <a href="/push-test.html" style="color:#60a5fa">Test panelinÉ™ qayÄ±t</a>
            </body>
        `);
    } catch (error) {
        res.status(500).send("Push test xÉ™tasÄ±: " + error.message);
    }
});

// YENI YOXLANIS UCUN (KÃ† NAR VASÃ„Â°TÃ† )
// Bu linkÃ‰â„¢ kompÃƒÂ¼terdÃ‰â„¢n girdiyinizdÃ‰â„¢ BÃƒÅ“TÃƒÅ“N qeydiyyatdan keÃƒÂ§miÃ…Å¸ cihazlara (o cÃƒÂ¼mlÃ‰â„¢dÃ‰â„¢n baÃ„Å¸lÃ„Â± olan iPhone-a) bildiriÃ…Å¸ gÃƒÂ¶ndÃ‰â„¢rÃ‰â„¢cÃ‰â„¢k
app.get("/api/fcm/broadcast-test", async (req, res) => {
    if (!firebaseInitialized) return res.status(500).send("Firebase qoÅŸulmayÄ±b");
    
    const tokens = Object.keys(fcmRegistrations);
    if (tokens.length === 0) return res.send("HeÃ§ bir cihaz qeydiyyatda deyil.");

    const message = {
        notification: {
            title: "XÃ¼susi Test BildiriÅŸi",
            body: "ÆgÉ™r tÉ™tbiq tam baÄŸlÄ±dÄ±rsa vÉ™ bu bildiriÅŸ gÉ™lirsÉ™, hÉ™r ÅŸey É™la iÅŸlÉ™yir!"
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
                icon: '/icons/icon-192.png',
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
        res.send(`<h1>UÄŸurlu!</h1><p>${sentCount} cihaza bildiriÅŸ gÃ¶ndÉ™rildi.</p><p>Ä°ndi iPhone-unuzu yoxlayÄ±n.</p>`);
    } catch (e) {
        res.status(500).send("XÉ™ta baÅŸ verdi: " + e.message);
    }
});

// Background Worker for Live Matches Push Notifications
async function runBackgroundGoalTracker() {

    if (liveScoreWorkerInFlight) return;
    liveScoreWorkerInFlight = true;
    try {
        const liveData = await fetchLiveScoresForNotifications();
        if (!liveData || !Array.isArray(liveData.events)) return;

        const events = liveData.events;
        await runFavoriteGoalCatchup(events, liveData.source || "live-poll");
        
        for (const ev of events) {
            if (!ev?.id) continue;
            const matchId = ev.id.toString();
            const hs = ev.homeScore?.current || 0;
            const as = ev.awayScore?.current || 0;
            const leagueId = (ev.tournament?.uniqueTournament?.id || ev.tournament?.id || "").toString();
            const prev = lastScores[matchId];
            
            if (prev) {
                const immediateResult = await sendImmediateScoreGoalPush(ev, prev, "tracker").catch(e => {
                    console.error(`[Push][Goal][tracker] Immediate score push failed for ${matchId}:`, e.message);
                    return null;
                });
                if (
                    immediateResult &&
                    immediateResult.reason !== "score-not-increased" &&
                    immediateResult.reason !== "missing-event" &&
                    immediateResult.reason !== "send-failed"
                ) {
                    lastScores[matchId] = { homeScore: hs, awayScore: as };
                    continue;
                }
                if (hs > prev.homeScore || as > prev.awayScore) {
                    const scoreMarker = `score-${hs}-${as}`;
                    if (hasRecentGoalNotification(matchId, scoreMarker, 90 * 1000)) {
                        lastScores[matchId] = { homeScore: hs, awayScore: as };
                        continue;
                    }
                    const scoringSide = hs > prev.homeScore ? "home" : "away";
                    const previousGoalTotal = (Number(prev.homeScore) || 0) + (Number(prev.awayScore) || 0);
                    const title = `Rabona Media`;
                    const body = `${ev.homeTeam.name} ${hs} - ${as} ${ev.awayTeam.name}. Hesab dÉ™yiÅŸdi, qol vuruldu.`;
                    
                    console.log(`[GOAL] ${ev.homeTeam.name} - ${ev.awayTeam.name} GOOOL!`);

                    sendGoalNotification();
                    addServerNotification({
                        type: 'goal_score',
                        title,
                        body,
                        matchId: ev.id,
                        leagueId
                    });

                    const recipients = collectFavoriteRecipientsForEvent(ev, matchId, leagueId);
                    let sentFallbackGoal = false;
                    if (recipients.length > 0) {
                        const sendResult = await sendGoalPushToRecipients(recipients, {
                            title,
                            body,
                            matchId,
                            leagueId,
                            type: "goal_score",
                            score: `${hs}-${as}`,
                            tag: `goal-score-${matchId}-${hs}-${as}`,
                            ttl: "120"
                        });
                        if (sendResult.sent === 0) {
                            console.warn(`[Push][Goal] No notification reached devices for match ${matchId}. Check stale subscriptions or VAPID/APNs delivery.`);
                        }
                        sentFallbackGoal = sendResult.sent > 0;

                        if (sentFallbackGoal) {
                            pendingGoalDetailNotifications[matchId] = {
                                scoreMarker,
                                homeScore: hs,
                                awayScore: as,
                                score: `${hs}-${as}`,
                                previousGoalTotal,
                                scoringSide,
                                leagueId,
                                createdAt: Date.now()
                            };
                            queueGoalScorerChecks(ev, "tracker-fallback");
                        }

                        getMatchIncidentsData(matchId).catch(() => {});
                    }

                    if (sentFallbackGoal) {
                        markGoalNotification(matchId, scoreMarker);
                    }
                }
            }
            lastScores[matchId] = { homeScore: hs, awayScore: as };
        }
        pruneGoalNotificationState();
    } catch (e) {
        console.error("[Background Tracker] Error:", e.message);
    } finally {
        liveScoreWorkerInFlight = false;
    }
}


async function runIncidentScorerWorker() {

    try {
        const favoriteMatchIds = new Set();
        const favoriteMatchKeys = new Set();
        const favoriteLeagueIds = new Set();
        const favoriteMatchRefs = [];

        Object.values(fcmRegistrations).forEach(reg => {
            const payload = getFavoritePayloadFromReg(reg);
            payload.favorites.forEach(id => favoriteMatchIds.add(id.toString()));
            payload.favoriteKeys.forEach(key => favoriteMatchKeys.add(key.toString()));
            payload.leagues.forEach(id => favoriteLeagueIds.add(id.toString()));
            favoriteMatchRefs.push(...payload.favoriteMatches);
        });
        Object.values(webPushRegistrations).forEach(reg => {
            const payload = getFavoritePayloadFromReg(reg);
            payload.favorites.forEach(id => favoriteMatchIds.add(id.toString()));
            payload.favoriteKeys.forEach(key => favoriteMatchKeys.add(key.toString()));
            payload.leagues.forEach(id => favoriteLeagueIds.add(id.toString()));
            favoriteMatchRefs.push(...payload.favoriteMatches);
        });

        if (favoriteMatchIds.size === 0 && favoriteMatchKeys.size === 0 && favoriteLeagueIds.size === 0 && favoriteMatchRefs.length === 0) return;

        const liveData = await fetchLiveScoresForNotifications({ allowPushFallback: true, saveSnapshot: false })
            .catch(() => getLiveEventsData(true));
        if (!liveData?.events?.length) return;

        const favoriteLiveMatches = liveData.events.filter(ev => {
            const leagueId = (ev.tournament?.uniqueTournament?.id || ev.tournament?.id || "").toString();
            const eventKeys = new Set(buildServerFavoriteKeyVariants(ev));
            const isFavorite =
                favoriteMatchIds.has(ev.id?.toString()) ||
                favoriteLeagueIds.has(leagueId) ||
                Array.from(eventKeys).some(key => favoriteMatchKeys.has(key)) ||
                favoriteMatchRefs.some(ref => favoriteRefMatchesEvent(ref, ev, ev.id?.toString(), eventKeys));
            return isFavorite &&
                (ev.status?.type === "inprogress" || ["HT", "HALFTIME", "EXTRA TIME", "ET"].includes((ev.status?.description || "").toUpperCase()));
        });

        for (const ev of favoriteLiveMatches) {
            const matchId = ev.id.toString();
            const leagueId = (ev.tournament?.uniqueTournament?.id || ev.tournament?.id || "").toString();

            let incidentsData = null;
            try {
                incidentsData = await getScorerIncidentDataForEvent(ev);
            } catch (e) {
                console.warn(`[Goal Incidents] ${matchId} incidents unavailable: ${e.message}`);
                continue;
            }

            const goalIncidents = extractGoalIncidents(incidentsData);
            const goalKeys = goalIncidents.map(buildGoalIncidentKey);
            const pendingGoalDetail = pendingGoalDetailNotifications[matchId];
            const currentHomeScore = Number(ev.homeScore?.current || 0);
            const currentAwayScore = Number(ev.awayScore?.current || 0);
            const currentGoalTotal = currentHomeScore + currentAwayScore;
            const previousScore = lastScores[matchId];
            const previousGoalTotal = previousScore
                ? (Number(previousScore.homeScore) || 0) + (Number(previousScore.awayScore) || 0)
                : null;
            const scoreMovedSinceLastTrack = previousGoalTotal !== null && currentGoalTotal > previousGoalTotal;

            if (!liveGoalIncidentState[matchId]) {
                liveGoalIncidentState[matchId] = new Set();
                if (!scoreMovedSinceLastTrack && (!pendingGoalDetail || goalIncidents.length <= pendingGoalDetail.previousGoalTotal)) {
                    goalKeys.forEach(key => liveGoalIncidentState[matchId].add(key));
                    continue;
                }
            }

            const knownKeys = liveGoalIncidentState[matchId];
            const newGoalIncidents = goalIncidents.filter(incident => !knownKeys.has(buildGoalIncidentKey(incident)));

            goalKeys.forEach(key => knownKeys.add(key));
            let incidentsToNotify = newGoalIncidents;
            if ((pendingGoalDetail || scoreMovedSinceLastTrack) && newGoalIncidents.length) {
                const sideFiltered = newGoalIncidents.filter(incident =>
                    pendingGoalDetail
                        ? (pendingGoalDetail.scoringSide === "home" ? incident.isHome === true : incident.isHome === false)
                        : (currentHomeScore > (Number(previousScore?.homeScore) || 0) ? incident.isHome === true : incident.isHome === false)
                );
                incidentsToNotify = (sideFiltered.length ? sideFiltered : newGoalIncidents)
                    .slice()
                    .sort((a, b) => (Number(b.time) || 0) - (Number(a.time) || 0))
                    .slice(0, 1);
            }
            if (incidentsToNotify.length === 0) continue;

            const recipients = collectFavoriteRecipientsForEvent(ev, matchId, leagueId);
            if (recipients.length === 0) continue;

            for (const incident of incidentsToNotify) {
                const incidentKey = buildGoalIncidentKey(incident);
                if (hasRecentGoalNotification(matchId, incidentKey)) continue;

                const scorerName =
                    incident.playerName ||
                    incident.player?.name ||
                    incident.player?.shortName ||
                    incident.playerIn?.name ||
                    "";
                if (!scorerName) continue;
                const minuteText = incident.time ? `${incident.time}'` : "CanlÄ±";
                const goalLabel =
                    incident.incidentClass === "ownGoal" ? "Avtoqol" :
                    incident.incidentClass === "penalty" ? "PenaltidÉ™n qol" :
                    "Qol";
                const title = "Rabona Media";
                const body = `${minuteText} ${goalLabel}: ${scorerName}. ${ev.homeTeam.name} ${ev.homeScore?.current || 0} - ${ev.awayScore?.current || 0} ${ev.awayTeam.name}`;

                addServerNotification({ type: "goal_scorer", title, body, matchId, leagueId });
                const sendResult = await sendGoalPushToRecipients(recipients, {
                    title,
                    body,
                    matchId,
                    leagueId,
                    type: "goal_scorer",
                    score: `${ev.homeScore?.current || 0}-${ev.awayScore?.current || 0}`,
                    tag: `goal-scorer-${matchId}-${incidentKey}`,
                    ttl: "300"
                });
                if (sendResult.sent === 0) {
                    console.warn(`[Push][Scorer] No notification reached devices for match ${matchId}.`);
                    continue;
                }

                markGoalNotification(matchId, incidentKey);
                if (pendingGoalDetailNotifications[matchId]) {
                    delete pendingGoalDetailNotifications[matchId];
                }
            }
            lastScores[matchId] = { homeScore: currentHomeScore, awayScore: currentAwayScore };
        }

        pruneGoalNotificationState();
    } catch (e) {
        // Log noise-u azaltmaq Ã¼Ã§Ã¼n daha qÄ±sa mesaj
        const shortMsg = e.message.length > 100 ? e.message.substring(0, 100) + "..." : e.message;
        console.warn("[Goal Incident Worker] Warning:", shortMsg);
    }
}


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
                        icon: "/icons/icon-192.png",
                        badge: "/icons/icon-192.png",
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
// --- Reminder Worker for Upcoming Favorited Matches ---
async function runReminderWorker() {

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
            const { favorites, leagues, teams, favoriteKeys, favoriteMatches: favoriteMatchRefs } = getFavoritePayloadFromReg(recipient.reg);
            if (favorites.length === 0 && leagues.length === 0 && teams.length === 0 && favoriteKeys.length === 0 && favoriteMatchRefs.length === 0) continue;

            const favoriteMatches = allUpcomingEvents.filter(ev =>
                favorites.includes(ev.id?.toString()) ||
                leagues.includes((ev.tournament?.uniqueTournament?.id || ev.tournament?.id || '').toString()) ||
                favoriteTeamsMatchEvent(teams, ev) ||
                buildServerFavoriteKeyVariants(ev).some(key => favoriteKeys.includes(key)) ||
                favoriteMatchRefs.some(ref =>
                    favoriteRefMatchesEvent(ref, ev, ev.id?.toString(), new Set(buildServerFavoriteKeyVariants(ev)))
                )
            );

            for (const match of favoriteMatches) {
                const favId = match.id?.toString();
                if (!match?.startTimestamp) continue;

                const timeUntilStart = match.startTimestamp - nowSec;
                const reminderKey = `${recipient.channel}:${recipient.id}`;

                if (!remindersSent[reminderKey]) remindersSent[reminderKey] = {};
                if (!remindersSent[reminderKey][favId]) remindersSent[reminderKey][favId] = { timestamp: Date.now() };

                const state = remindersSent[reminderKey][favId];

                if (timeUntilStart > 0 && timeUntilStart <= 40 * 60 && timeUntilStart >= 20 * 60 && !state.soon) {
                    const sent = await sendReminderToRecipient(recipient, {
                        title: `XatÄ±rlatma: ${match.homeTeam.name} - ${match.awayTeam.name}`,
                        body: "Oyunun baÅŸlamasÄ±na tÉ™xminÉ™n 30 dÉ™qiqÉ™ qaldÄ±.",
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
                        title: "Oyun baÅŸladÄ±",
                        body: `${match.homeTeam.name} - ${match.awayTeam.name} oyunu baÅŸladÄ±.`,
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
}


async function warmRuntimeCaches(options = {}) {
    const now = Date.now();
    if (runtimeWarmupInFlight) return lastRuntimeWarmupResult;
    if (!options.force && now - lastRuntimeWarmupAt < Math.max(3000, Math.floor(RUNTIME_WARMUP_INTERVAL_MS * 0.5))) {
        return lastRuntimeWarmupResult;
    }

    runtimeWarmupInFlight = true;
    const startedAt = Date.now();
    const result = {
        startedAt: new Date(startedAt).toISOString(),
        liveEvents: 0,
        scheduledEvents: 0,
        warmedCategories: 0,
        warmedAt: null,
        durationMs: 0
    };

    try {
        warmLeagueImages(options.force ? 12 : 6).catch(e => {
            console.warn("[Warmup] League image prefetch failed:", e.message);
        });

        const liveData = await getLiveEventsData(true);
        result.liveEvents = liveData?.events?.length || 0;
        warmRecentScheduledDetails({ force: options.force }).catch(e => {
            console.warn("[Warmup] Recent scheduled details prefetch failed:", e.message);
        });

        if (options.force) {
            const todayStr = new Date().toISOString().split('T')[0];
            const scheduled = await getCachedData(`matches_sofascore_${todayStr}`, async () => {
                return await fetchScheduledFromSofaScore(todayStr);
            }, 30 * 1000);
            result.scheduledEvents = scheduled?.events?.length || 0;
            if (Array.isArray(scheduled?.events)) {
                warmLiveMatchDetails(scheduled.events).catch(() => {});
            }
        }
        warmOneLeagueStanding().catch(e => {
            console.warn("[Warmup] Standing prefetch failed:", e.message);
        });
        if (options.force) {
            warmOneLeagueTopPlayers().catch(e => {
                console.warn("[Warmup] Top players prefetch failed:", e.message);
            });
            result.warmedCategories = await warmOneCategoryLeagues(1);
        }
    } catch (e) {
        console.warn("[Warmup] Cache prefetch failed:", e.message);
        result.error = e.message;
    } finally {
        result.warmedAt = new Date().toISOString();
        result.durationMs = Date.now() - startedAt;
        lastRuntimeWarmupAt = Date.now();
        lastRuntimeWarmupResult = result;
        runtimeWarmupInFlight = false;
    }

    return result;
}

async function warmOneCategoryLeagues(limit = 1) {
    if (Date.now() - (warmOneCategoryLeagues.lastRunAt || 0) < CATEGORY_WARMUP_INTERVAL_MS) return 0;
    warmOneCategoryLeagues.lastRunAt = Date.now();

    const categories = FALLBACK_CATEGORIES.filter(category => category?.id);
    if (!categories.length) return 0;

    let warmed = 0;
    for (let i = 0; i < Math.min(limit, categories.length); i++) {
        const category = categories[categoryWarmIndex % categories.length];
        categoryWarmIndex++;
        const categoryId = String(category.id);
        const cacheKey = `category_tournaments_${categoryId}`;
        const cached = cache[cacheKey]?.data || getFallbackCategoryTournaments(categoryId);

        if (cached) {
            warmCategoryStandings(cached, 14);
            warmImagePaths(collectTournamentImagePaths(cached), 18).catch(() => {});
            warmed++;
        }

        try {
            const data = await Promise.any([
                fetchFromSofaNativeFast(`/category/${categoryId}/unique-tournaments`, {}, 2500),
                fetchFromSofaFastRace(`/category/${categoryId}/unique-tournaments`, {}, 4200)
            ]);
            if (data?.uniqueTournaments?.length || data?.groups?.length || data?.tournaments?.length) {
                cache[cacheKey] = { data, timestamp: Date.now() };
                saveCategoryTournamentsSnapshot(categoryId, data);
                warmCategoryStandings(data, 18);
                warmImagePaths(collectTournamentImagePaths(data), 24).catch(() => {});
                warmed++;
            }
        } catch (error) {
            if (!cached) console.warn(`[Warmup] Category ${categoryId} prefetch failed:`, error.message);
        }
    }

    return warmed;
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

async function warmOneLeagueTopPlayers() {
    if (!FALLBACK_TOP_LEAGUES.length) return;
    const warmableLeagues = FALLBACK_TOP_LEAGUES.filter(league => KNOWN_CURRENT_SEASONS[league.id]);
    if (!warmableLeagues.length) return;

    const league = warmableLeagues[topPlayersWarmIndex % warmableLeagues.length];
    topPlayersWarmIndex++;
    const seasonId = KNOWN_CURRENT_SEASONS[league.id];
    if (!seasonId) return;

    const cacheKey = `topplayers_goals_v6_${league.id}_${seasonId}`;
    if (cache[cacheKey] && cache[cacheKey]?.data) return;

    console.log(`[Warmup] Prefetch top players for ${league.name} (${league.id})`);
    const data = await getCachedDataWithTimeout(cacheKey, async () => {
        return await fetchTopPlayersDataForBestSeason(league.id, seasonId);
    }, CACHE_TIMES.STATIC, 12000, "Warm top players", { skipJitter: true });
    warmTopPlayerImages(data, 32).catch(e => {
        console.warn(`[Image Warmup] Warm top players ${league.id}/${seasonId} failed:`, e.message);
    });
}

app.get("/api/keepalive", async (req, res) => {
    const force = req.query.force === "1";
    const light = req.query.light === "1";
    res.json({
        status: "alive",
        warmed: false,
        warmingInBackground: !light,
        light,
        keepaliveEnabled: KEEPALIVE_ENABLED,
        liveEvents: globalLiveEvents?.events?.length || 0,
        liveTimestamp: lastLiveFetchTime ? new Date(lastLiveFetchTime).toISOString() : null,
        lastWarmup: lastRuntimeWarmupResult,
        timestamp: new Date().toISOString()
    });

    if (light) return;

    warmRuntimeCaches({ force }).catch(e => {
        console.warn("[Keep-Alive] Background warmup failed:", e.message);
    });
});

app.get("/api/warmup", async (req, res) => {
    const force = req.query.force === "1";
    warmRuntimeCaches({ force }).catch(e => {
        console.warn("[Warmup API] Background warmup failed:", e.message);
    });
    res.json({
        status: "warming",
        keepaliveEnabled: KEEPALIVE_ENABLED,
        force,
        liveEvents: globalLiveEvents?.events?.length || 0,
        liveTimestamp: lastLiveFetchTime ? new Date(lastLiveFetchTime).toISOString() : null,
        lastWarmup: lastRuntimeWarmupResult,
        timestamp: new Date().toISOString()
    });
});


// Ã¢â‚¬â€Ã¢â‚¬â€Ã¢â‚¬â€ API ENDPOINTS FOR KEEPALIVE & SSE Ã¢â‚¬â€Ã¢â‚¬â€Ã¢â‚¬â€Ã¢â‚¬â€Ã¢â‚¬â€Ã¢â‚¬â€Ã¢â‚¬â€Ã¢â‚¬â€Ã¢â‚¬â€Ã¢â‚¬â€Ã¢â‚¬â€Ã¢â‚¬â€Ã¢â‚¬â€Ã¢â‚¬â€Ã¢â‚¬â€

app.get("/api/ping", (req, res) => {
    const source = req.query.source || "unknown";
    console.log(`[PING] Received from: ${source} at ${new Date().toISOString()}`);
    res.json({ 
        status: "ok", 
        source,
        uptime: Math.round(process.uptime()), 
        timestamp: Date.now(),
        serverTime: new Date().toISOString()
    });
});

app.get("/api/health", (req, res) => {
    const source = req.query.source || "unknown";
    console.log(`[HEALTH] Check from: ${source}`);
    res.json({
        status: "healthy",
        source,
        uptime: Math.round(process.uptime()),
        uptimeHours: (process.uptime() / 3600).toFixed(2),
        memory: {
            rss: (process.memoryUsage().rss / 1024 / 1024).toFixed(2) + " MB",
            heapTotal: (process.memoryUsage().heapTotal / 1024 / 1024).toFixed(2) + " MB",
            heapUsed: (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2) + " MB"
        },
        cache: {
            general: Object.keys(cache).length,
            matches: Object.keys(matchCache).length,
            details: Object.keys(matchDetailsCache).length
        },
        liveEvents: globalLiveEvents?.events?.length || 0,
        lastLiveFetch: lastLiveFetchTime ? new Date(lastLiveFetchTime).toISOString() : null,
        sseListeners: sseListeners.length,
        version: "v7-stable-keepalive"
    });
});

// Aqressiv keep-alive endpoint - hÉ™m dÉ™ yÃ¼ngÃ¼l warmup edir
app.get("/api/keepalive-v2", async (req, res) => {
    const source = req.query.source || "external";
    console.log(`[KEEPALIVE-V2] Aggressive ping from: ${source}`);
    
    // YÃ¼ngÃ¼l warmup - serverin aktiv olduÄŸunu platformaya gÃ¶stÉ™rmÉ™k Ã¼Ã§Ã¼n
    const warmupResult = await warmRuntimeCaches({ light: true }).catch(() => ({ error: "failed" }));
    
    res.json({
        status: "active",
        source,
        warmup: !!warmupResult,
        liveMatches: globalLiveEvents?.events?.length || 0,
        timestamp: new Date().toISOString()
    });
});


app.get("/api/match/stream/:id", (req, res) => {
    const matchId = String(req.params.id);
    res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive"
    });

    const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

    if (matchCache[matchId]) {
        send({ 
            type: "init", 
            payload: { 
                ...matchCache[matchId], 
                details: matchDetailsCache[matchId] 
            } 
        });
    } else {
        refreshMatchDetails(matchId);
    }

    const listener = (updated) => {
        if (String(updated.id) === matchId) {
            send({ 
                type: "update", 
                payload: { 
                    ...updated, 
                    details: matchDetailsCache[matchId] 
                } 
            });
        }
    };

    sseListeners.push({ id: matchId, fn: listener });

    req.on("close", () => {
        sseListeners = sseListeners.filter(l => l.fn !== listener);
        res.end();
    });
});


// --- BACKGROUND REFRESH LOGIC ---
async function refreshLiveData() {
    try {
        const data = await fetchLiveScoresForNotifications({ allowPushFallback: false });
        const liveEvents = data?.events || [];
        const scorePushTasks = [];
        
        for (const match of liveEvents) {
            const id = String(match.id);
            const prev = matchCache[id];
            matchCache[id] = match;
            const scoreChanged = prev && (
                prev.homeScore?.current !== match.homeScore?.current ||
                prev.awayScore?.current !== match.awayScore?.current
            );

            if (!prev || (
                scoreChanged ||
                prev.status?.type !== match.status?.type
            )) {
                refreshMatchDetails(id);
                notifySseListeners(match);
                
                if (scoreChanged) {
                    console.log(`[GOAL] ${match.homeTeam.name} ${match.homeScore.current} - ${match.awayScore.current} ${match.awayTeam.name}`);
                    scorePushTasks.push(sendImmediateScoreGoalPush(match, prev, "refresh").catch(e => {
                        console.error(`[Push][Goal][refresh] Immediate score push failed for ${id}:`, e.message);
                    }));
                }
            }
        }
        if (scorePushTasks.length > 0) {
            await Promise.allSettled(scorePushTasks);
        }
        warmLiveMatchDetails(liveEvents).catch(error => {
            console.warn(`[DETAILS-WARMUP] Live details warmup failed: ${error.message}`);
        });
        console.log(`[REFRESH] Background update success. Live matches: ${liveEvents.length}`);
    } catch (e) {
        console.error("[REFRESH] Error:", e.message);
    }
}

let lastDetailIndex = 0;
async function refreshLiveDetailsLoop() {
    const ids = Object.keys(matchCache).sort((a, b) => {
        const aLive = isLiveSofaEvent(matchCache[a]) ? 1 : 0;
        const bLive = isLiveSofaEvent(matchCache[b]) ? 1 : 0;
        return bLive - aLive;
    });
    if (ids.length === 0) return;

    const count = 12;
    const tasks = [];
    for (let i = 0; i < count; i++) {
        const idx = (lastDetailIndex + i) % ids.length;
        const id = ids[idx];
        tasks.push(refreshMatchDetails(id));
    }
    await Promise.allSettled(tasks);
    lastDetailIndex = (lastDetailIndex + count) % ids.length;
}

async function runEnhancedSelfPing() {
    if (!KEEPALIVE_ENABLED) return;

    const getSelfUrl = () => {
        if (process.env.KEEPALIVE_URL) return process.env.KEEPALIVE_URL;
        if (process.env.RENDER_EXTERNAL_URL) return process.env.RENDER_EXTERNAL_URL;
        if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL;
        return `http://localhost:${PORT}`;
    };

    const targetUrl = getSelfUrl();
    if (!targetUrl) return;
    const baseUrl = targetUrl.replace(/\/+$/, "");
    
    const endpoints = [
        `${baseUrl}/api/ping`,
        `${baseUrl}/api/health`,
        `${baseUrl}/api/warmup?force=0`
    ];

    console.log(`[Keep-Alive] Pinging ${baseUrl} to stay awake...`);
    
    for (const url of endpoints) {
        try {
            await axios.get(`${url}?t=${Date.now()}`, { timeout: 10000 });
        } catch (e) {
            console.warn(`[Keep-Alive] Ping to ${url.split('/').pop()} failed: ${e.message}`);
        }
    }
}

async function startAlwaysOnWorkers() {
    console.log("-----------------------------------------");
    console.log("[Always-On] Starting background services...");
    console.log("-----------------------------------------");
    
    const runLivePulse = async () => {
        const [refreshResult, trackerResult] = await Promise.allSettled([
            refreshLiveData(),
            runBackgroundGoalTracker()
        ]);
        if (refreshResult.status === "rejected") {
            console.warn("[Always-On] Public live refresh failed:", refreshResult.reason?.message || refreshResult.reason);
        }
        if (trackerResult.status === "rejected") {
            console.warn("[Always-On] Push tracker failed:", trackerResult.reason?.message || trackerResult.reason);
        }
    };

    // 1. Live Score & Goal Detection (Tight Loop: 3-5s)
    runLivePulse().catch(e => console.error("[Always-On] Initial live pulse failed:", e.message));
    setInterval(() => {
        runLivePulse().catch(e => console.error("[Always-On] Live pulse failed:", e.message));
    }, LIVE_SCORE_POLL_INTERVAL_MS);

    // 2. Incident Scorer Detection
    runIncidentScorerWorker().catch(e => console.error("[Always-On] Initial incident worker failed:", e.message));
    setInterval(() => {
        runIncidentScorerWorker().catch(e => console.error("[Always-On] Incident worker failed:", e.message));
    }, 5000);

    // 3. Reminders & State Persistence (1 min)
    setInterval(async () => {
        await runReminderWorker();
        savePersistentState();
    }, 60000);

    // 4. Cache Warmup (delayed so first user request after boot is not blocked)
    setTimeout(() => {
        refreshLiveDetailsLoop().catch(e => console.error("[Always-On] Initial details warmup failed:", e.message));
    }, 20000);
    setInterval(async () => {
        await refreshLiveDetailsLoop();
        await warmRuntimeCaches({ light: true });
    }, 10000);

    // 5. Optional self-ping for platforms that sleep.
    if (KEEPALIVE_ENABLED) {
        runEnhancedSelfPing().catch(e => console.warn("[Keep-Alive] Initial self-ping failed:", e.message));
        setInterval(async () => {
            await runEnhancedSelfPing();
        }, SELF_PING_INTERVAL_MS);
    }
}

// --- Cuptrees (Bracket) API ---
app.get("/api/tournament/:tourId/season/:seasonId/cuptrees", async (req, res) => {
    try {
        const { tourId, seasonId } = req.params;
        let sofaId = tourId;
        if (MACKOLIK_CANONICAL_MODE) {
            sofaId = await mackolikToSofascoreTournament(tourId, req.query.name) || tourId;
        }
        
        const data = await getCachedData(`cuptrees_${sofaId}_${seasonId}`, async () => {
            const sid = seasonId === 'auto' ? '' : seasonId;
            const result = await fetchFromSofa(`/unique-tournament/${sofaId}/season/${sid}/cuptrees`);
            return result.data;
        }, CACHE_TIMES.STATIC);
        
        res.json(data);
    } catch (error) {
        console.warn(`[Cuptrees] Error for tour=${req.params.tourId}:`, error.message);
        res.json({ cuptrees: [], unavailable: true });
    }
});

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, "0.0.0.0", async () => {
    console.log(`Server ${PORT} portunda aktivdir.`);
    console.log(`[ALWAYS-ON] Background orchestration initialized.`);

    await Promise.allSettled([registrationsReadyPromise, webPushRegistrationsReadyPromise]);
    console.log(`[BOOT] Push registrations ready. FCM: ${Object.keys(fcmRegistrations).length}, WebPush: ${Object.keys(webPushRegistrations).length}`);

    if (ALWAYS_ON_ENABLED) {
        startAlwaysOnWorkers();
    } else {
        console.log("[Always-On] Disabled by ALWAYS_ON_ENABLED=false.");
    }

    ensureLiveSnapshotLoaded().then(() => {
        console.log(`[BOOT] Live snapshot loaded. Events: ${globalLiveEvents?.events?.length || 0}`);
        if (ALWAYS_ON_ENABLED) {
            setTimeout(() => {
                refreshLiveData().catch?.(() => {});
                refreshLiveDetailsLoop().catch(error => {
                    console.warn(`[BOOT] Initial details warmup failed: ${error.message}`);
                });
                warmRecentScheduledDetails({ force: true }).catch(error => {
                    console.warn(`[BOOT] Recent scheduled details warmup failed: ${error.message}`);
                });
            }, 30000);
            runBackgroundGoalTracker().catch(() => {});
        }
    });
});

server.on("error", (error) => {
    if (error?.code === "EADDRINUSE") {
        console.log(`[STARTUP] Port ${PORT} artiq istifadededir. Server zaten aciqdir: http://localhost:${PORT}`);
        console.log("[STARTUP] Yeni proses dayandirildi; brauzerde movcud localhost sehifesini refresh edin.");
        process.exit(0);
    }
    throw error;
});
