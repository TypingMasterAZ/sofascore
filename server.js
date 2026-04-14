const express = require("express");
// Version: 1.1.3 - Triggering Render Redeploy (Force)
require('dotenv').config();
const path = require("path");
const axios = require("axios");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const app = express();
const fs = require("fs");
const nodemailer = require("nodemailer");
const admin = require("firebase-admin");

// Firebase Admin SDK-nın yaradılması
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

// Render Secret File dəstəyi
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

if (firebaseInitialized) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
} else {
  console.warn("[WARNING] Firebase Admin SDK not initialized. Push notifications will not work.");
}

// Nodemailer Tənzimləmələri (OTP göndərmək üçün)
// DİQQƏT: Buraya öz email və tətbiq şifrənizi (App Password) yazmalısınız
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER || 'typingmaster.az@gmail.com', // Sizin email
        pass: process.env.EMAIL_PASS || 'hlwg iaey ryxn klsq'    // Sizin "App Password" şifrəniz
    }
});

app.use(cors({
    origin: '*', // Hələlik hər yerə icazə veririk, Render linki bəlli olandan sonra bunu GitHub linkinlə əvəz edə bilərik
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());
app.use(express.static(path.join(__dirname)));
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
});

const SOFA_API = "https://api.sofascore.com/api/v1";
const GAS_PROXY_URL = process.env.GAS_PROXY_URL;
const HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
    "Accept-Language": "en-US,en;q=0.9,az;q=0.8",
    "Referer": "https://www.sofascore.com/",
    "Origin": "https://www.sofascore.com",
    "Cache-Control": "max-age=0",
    "sec-ch-ua": '"Google Chrome";v="123", "Not:A-Brand";v="8", "Chromium";v="123"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-site",
    "Upgrade-Insecure-Requests": "1"
};

async function fetchFromSofa(path, params = {}) {
    try {
        let result;
        if (GAS_PROXY_URL) {
            console.log(`[PROXY FETCH] Path: ${path}`);
            result = await axios.get(GAS_PROXY_URL, { 
                params: { path, ...params },
                timeout: 10000 // 10 saniyə timeout
            });
        } else {
            console.log(`[DIRECT FETCH] Path: ${path}`);
            result = await axios.get(`${SOFA_API}${path}`, { 
                headers: HEADERS,
                params: params,
                timeout: 10000
            });
        }

        // Validate that we got a JSON object or at least not an HTML page
        if (result.data && typeof result.data === 'string' && (result.data.trim().startsWith('<!doctype') || result.data.trim().startsWith('<html'))) {
            console.error(`[FETCH ERROR] Received HTML instead of JSON for path: ${path}`);
            throw new Error("SofaScore-dan və ya Proxy-dən etibarsız cavab gəldi (HTML). Böyük ehtimalla Google Script login tələb edir və ya bloklanıb.");
        }
        
        return result;
    } catch (error) {
        console.error(`[FETCH EXCEPTION] Path: ${path} | Error: ${error.message}`);
        
        // Enhance error message if it's a proxy/parse issue
        if (error.response) {
            const status = error.response.status;
            const dataPreview = typeof error.response.data === 'string' ? error.response.data.substring(0, 100) : 'Non-string data';
            
            if (dataPreview.includes('<!doctype') || dataPreview.includes('<html')) {
                error.message = "Google Script etibarsız cavab qaytardı (Login səhifəsi). Lütfən Script icazələrini (Execute as: Me, Access: Anyone) yoxlayın.";
            } else if (status === 403) {
                error.message = "SofaScore tərəfindən bloklanma (403 Forbidden).";
            } else if (status === 429) {
                error.message = "Həddindən artıq sorğu (429 Too Many Requests).";
            } else {
                error.message = `Proxy/API Xətası: ${status} - ${error.message}`;
            }
        } else if (error.code === 'ECONNABORTED') {
            error.message = "Sorğu vaxtı bitdi (Timeout).";
        } else if (!GAS_PROXY_URL && !path.includes('/debug/')) {
            error.message = "GAS_PROXY_URL mühit dəyişəni təyin edilməyib! Lütfən Render Dashboard-da əlavə edin.";
        }
        
        throw error;
    }
}

// Diagnostic Endpoint Enhanced
app.get("/api/debug/proxy", async (req, res) => {
    const diagnostic = {
        timestamp: new Date().toISOString(),
        proxy_configured: !!GAS_PROXY_URL,
        proxy_prefix: GAS_PROXY_URL ? GAS_PROXY_URL.substring(0, 40) + "..." : "NONE",
        sofa_api: SOFA_API,
        node_version: process.version,
        env_keys: Object.keys(process.env).filter(key => key.includes("GAS") || key.includes("URL") || key.includes("API")),
        test_fetch: null
    };

    if (GAS_PROXY_URL) {
        try {
            console.log("[DEBUG] Testing proxy connectivity...");
            const start = Date.now();
            const test = await axios.get(GAS_PROXY_URL, { 
                params: { path: "/sport/football/events/live" },
                timeout: 5000
            });
            const duration = Date.now() - start;
            
            diagnostic.test_fetch = {
                status: "SUCCESS",
                duration_ms: duration,
                data_type: typeof test.data,
                data_preview: typeof test.data === 'object' ? "Valid JSON Object" : (typeof test.data === 'string' ? test.data.substring(0, 50) : "Unknown")
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
    LIVE: 30 * 1000,       // 30 saniyə
    SCHEDULED: 5 * 60 * 1000, // 5 dəqiqə
    STATIC: 60 * 60 * 1000    // 1 saat
};

async function getCachedData(key, fetchFn, ttl) {
    const now = Date.now();
    if (cache[key] && (now - cache[key].timestamp < ttl)) {
        console.log(`[CACHE HIT] Key: ${key}`);
        return cache[key].data;
    }
    
    console.log(`[CACHE MISS] Key: ${key}. Fetching fresh data...`);
    // Random jitter (100ms - 500ms) to avoid robotic patterns
    await new Promise(resolve => setTimeout(resolve, Math.random() * 400 + 100));
    
    const data = await fetchFn();
    cache[key] = { data, timestamp: now };
    return data;
}

// API vasitəçisi (Komanda məlumatları və heyət üçün)
app.get("/api/team/:id", async (req, res) => {
    try {
        const teamId = req.params.id;
        const [info, players] = await Promise.all([
            fetchFromSofa(`/team/${teamId}`),
            fetchFromSofa(`/team/${teamId}/players`)
        ]);
        res.json({ info: info.data, players: players.data });
    } catch (error) {
        console.error(`[API ERROR] Team ${req.params.id}: ${error.message}${error.response ? ' | Status: ' + error.response.status : ''}`);
        res.status(500).json({ error: true, message: error.message, details: error.response?.data?.substring?.(0, 100) });
    }
});

// Yeni API: Canlı Matçlar
app.get("/api/matches/live", async (req, res) => {
    try {
        const data = await getCachedData("live_matches", async () => {
            const result = await fetchFromSofa("/sport/football/events/live");
            return result.data;
        }, CACHE_TIMES.LIVE);
        res.json(data);
    } catch (error) {
        console.error(`[API ERROR] Live matches: ${error.message}${error.response ? ' | Status: ' + error.response.status : ''}`);
        res.status(500).json({ error: true, message: error.message, details: error.response?.data?.substring?.(0, 100) });
    }
});

// Yeni API: Matçlar (Skedullu)
app.get("/api/matches/:date", async (req, res) => {
    const { date } = req.params;
    try {
        const data = await getCachedData(`matches_${date}`, async () => {
            const result = await fetchFromSofa(`/sport/football/scheduled-events/${date}`);
            return result.data;
        }, CACHE_TIMES.SCHEDULED);
        res.json(data);
    } catch (error) {
        console.error(`[API ERROR] Scheduled matches for date ${date}: ${error.message}${error.response ? ' | Status: ' + error.response.status : ''}`);
        res.status(500).json({ error: true, message: error.message, details: error.response?.data?.substring?.(0, 100) });
    }
});

// Yeni API: Matç Hadisələri (Qollar, Kartlar)
app.get("/api/match/:id/incidents", async (req, res) => {
    try {
        const { id } = req.params;
        const result = await fetchFromSofa(`/event/${id}/incidents`);
        res.json(result.data);
    } catch (error) {
        console.error(`[API ERROR] Match incidents ${req.params.id}: ${error.message}${error.response ? ' | Status: ' + error.response.status : ''}`);
        res.status(500).json({ error: true, message: error.message });
    }
});

// Yeni API: Matç Statistikası
app.get("/api/match/:id/statistics", async (req, res) => {
    try {
        const { id } = req.params;
        const result = await fetchFromSofa(`/event/${id}/statistics`);
        res.json(result.data);
    } catch (error) {
        console.error(`[API ERROR] Match statistics ${req.params.id}: ${error.message}${error.response ? ' | Status: ' + error.response.status : ''}`);
        res.status(500).json({ error: true, message: error.message });
    }
});

// Yeni API: Turnirin mövsümləri
app.get("/api/tournament/:id/seasons", async (req, res) => {
    try {
        const { id } = req.params;
        const result = await fetchFromSofa(`/unique-tournament/${id}/seasons`);
        res.json(result.data);
    } catch (error) {
        console.error(`[API ERROR] Tournament seasons ${req.params.id}: ${error.message}${error.response ? ' | Status: ' + error.response.status : ''}`);
        res.status(500).json({ error: true, message: error.message });
    }
});

// Yeni API: Canlı Liqa Cədvəli üçün Proxy
app.get("/api/standings/:tourId/:seasonId", async (req, res) => {
    try {
        const { tourId, seasonId } = req.params;
        const result = await fetchFromSofa(`/unique-tournament/${tourId}/season/${seasonId}/standings/total`);
        res.json(result.data);
    } catch (error) {
        console.error(`[API ERROR] Standings tour=${tourId} season=${seasonId}: ${error.message}${error.response ? ' | Status: ' + error.response.status : ''}`);
        res.status(500).json({ error: true, message: error.message });
    }
});

// Yeni API: Populyar Liqalar siyahısı
app.get("/api/top-leagues", async (req, res) => {
    try {
        const data = await getCachedData("top_leagues", async () => {
            const result = await fetchFromSofa("/config/top-unique-tournaments/AZ/football");
            return result.data;
        }, CACHE_TIMES.STATIC);
        res.json(data);
    } catch (error) {
        console.error(`[API ERROR] Top Leagues: ${error.message}`);
        res.status(500).json({ error: true, message: error.message, details: error.response?.data?.substring?.(0, 100) });
    }
});

// Yeni API: Bütün Kategoriyalar (Ölkələr)
app.get("/api/categories", async (req, res) => {
    try {
        const data = await getCachedData("categories", async () => {
            const result = await fetchFromSofa("/sport/football/categories");
            return result.data;
        }, CACHE_TIMES.STATIC);
        res.json(data);
    } catch (error) {
        console.error(`[API ERROR] Categories: ${error.message}`);
        res.status(500).json({ error: true, message: error.message, details: error.response?.data?.substring?.(0, 100) });
    }
});

// Yeni API: Kateqoriya üzrə Liqalar
app.get("/api/category/:id/tournaments", async (req, res) => {
    try {
        const result = await fetchFromSofa(`/category/${req.params.id}/unique-tournaments`);
        res.json(result.data);
    } catch (error) {
        res.status(500).json({ error: true });
    }
});

// Yeni API: Turnir Məlumatı (Single League Info)
app.get("/api/tournament/:id", async (req, res) => {
    try {
        const result = await fetchFromSofa(`/unique-tournament/${req.params.id}`);
        res.json(result.data);
    } catch (error) {
        res.status(500).json({ error: true });
    }
});

// Yeni API: Turnir Mövsümləri (Seasons)
app.get("/api/tournament/:id/seasons", async (req, res) => {
    try {
        const result = await fetchFromSofa(`/unique-tournament/${req.params.id}/seasons`);
        res.json(result.data);
    } catch (error) {
        res.status(500).json({ error: true });
    }
});

// Yeni API: Qlobal Axtarış
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

// Yeni API: Bombardirlər (Top Players)
app.get("/api/tournament/:id/season/:sid/top-players", async (req, res) => {
    try {
        const { id, sid } = req.params;
        const result = await fetchFromSofa(`/unique-tournament/${id}/season/${sid}/top-players/overall`);
        res.json(result.data);
    } catch (error) {
        res.status(500).json({ error: true });
    }
});
// Yeni API: Şifrə Sıfırlama Kodu Göndər (OTP)
app.post("/api/auth/send-otp", async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, message: "Email lazımdır." });
    console.log(`[AUTH] Sending OTP to: ${email}`);

    const otp = Math.floor(1000 + Math.random() * 9000).toString();
    const expiry = Date.now() + 3 * 60 * 1000; // 3 dəqiqə valid

    try {
        let users = [];
        if (fs.existsSync("./users.json")) {
            users = JSON.parse(fs.readFileSync("./users.json", "utf-8"));
        }

        let userIdx = users.findIndex(u => u.email === email);
        if (userIdx === -1) {
            // Əgər istifadəçi yalnız Firebase-də varsa və localda yoxdursa, onu yaradırıq
            users.push({ email: email, resendCount: 0 });
            userIdx = users.length - 1;
        }

        // Gündəlik Limit Yoxlanışı (5 dəfə)
        const today = new Date().toISOString().split('T')[0];
        const user = users[userIdx];
        
        if (user.lastResendDate === today) {
            if (user.resendCount >= 5) {
                return res.status(429).json({ success: false, message: "Gündəlik limitiniz (5 dəfə) dolub. Sabah yenidən cəhd edin." });
            }
            user.resendCount++;
        } else {
            user.lastResendDate = today;
            user.resendCount = 1;
        }

        user.otp = otp;
        user.otpExpiry = expiry;
        fs.writeFileSync("./users.json", JSON.stringify(users, null, 2));

        const mailOptions = {
            from: '"Rabona Media" <typingmaster.az@gmail.com>',
            to: email,
            subject: 'Şifrə Sıfırlama Kodunuz - Rabona Media',
            html: `
                <div style="font-family: Arial, sans-serif; padding: 20px; color: #333;">
                    <h2 style="color: #3b82f6;">Rabona Media LIVE</h2>
                    <p>Salam,</p>
                    <p>Şifrənizi sıfırlamaq üçün tələb göndərdiniz. Sizin birdəfəlik təsdiq kodunuz (OTP):</p>
                    <div style="font-size: 32px; font-weight: bold; color: #ef4444; padding: 15px 30px; background: #f1f5f9; border-radius: 8px; display: inline-block; margin: 10px 0; letter-spacing: 5px;">
                        ${otp}
                    </div>
                    <p>Bu kod <b>3 dəqiqə</b> ərzində etibarlıdır.</p>
                    <p>Əgər bunu siz etməmisinizsə, zəhmət olmasa bu emaili nəzərə almayın.</p>
                    <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;">
                    <p style="font-size: 12px; color: #94a3b8;">Bu avtomatik göndərilən bir mesajdır, cavab yazmayın.</p>
                </div>
            `
        };

        await transporter.sendMail(mailOptions);
        res.json({ success: true, message: "OTP kod email ünvanınıza göndərildi." });

    } catch (error) {
        console.error("OTP Error:", error);
        res.status(500).json({ success: false, message: "Email göndərilərkən xəta baş verdi." });
    }
});

// Yeni API: OTP Kodu Yoxla (Sadəcə Doğrulama)
app.post("/api/auth/check-otp", async (req, res) => {
    const { email, otp } = req.body;
    try {
        if (!fs.existsSync("./users.json")) return res.status(404).json({ success: false });
        let users = JSON.parse(fs.readFileSync("./users.json", "utf-8"));
        const user = users.find(u => u.email === email && u.otp === otp);
        console.log(`[AUTH] Checking OTP for ${email}: ${otp ? 'Provided' : 'Missing'}`);
        
        if (!user) {
            console.log(`[AUTH] OTP mismatch for ${email}`);
            return res.status(400).json({ success: false, message: "Kod yanlışdır." });
        }
        if (Date.now() > user.otpExpiry) {
            console.log(`[AUTH] OTP expired for ${email}`);
            return res.status(400).json({ success: false, message: "Kodun vaxtı bitib." });
        }

        res.json({ success: true, message: "Kod təsdiqləndi. Yeni şifrəni daxil edin." });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

// Yeni API: Şifrəni Final Olaraq Dəyiş
app.post("/api/auth/verify-otp", async (req, res) => {
    const { email, otp, newPassword } = req.body;
    
    try {
        if (!fs.existsSync("./users.json")) return res.status(404).json({ success: false });
        let users = JSON.parse(fs.readFileSync("./users.json", "utf-8"));
        
        const user = users.find(u => u.email === email && u.otp === otp);
        
        if (!user) {
            return res.status(400).json({ success: false, message: "Kod yanlışdır." });
        }
        
        if (Date.now() > user.otpExpiry) {
            return res.status(400).json({ success: false, message: "Kodun vaxtı bitib." });
        }

        // ===== FIREBASE ŞİFRƏ DEYİŞİKLİYİ ======
        if (firebaseInitialized) {
            try {
                const firebaseUser = await admin.auth().getUserByEmail(email);
                await admin.auth().updateUser(firebaseUser.uid, {
                    password: newPassword
                });
                console.log(`[AUTH] Firebase password successfully updated for UID: ${firebaseUser.uid}`);
            } catch (fbError) {
                console.error("[AUTH] Firebase update password error:", fbError);
                return res.status(500).json({ success: false, message: "Firebase hesabınızla əlaqə yaradıla bilmədi. Şifrə yenilənmədi." });
            }
        } else {
            console.warn("[AUTH] Firebase not initialized, skipping Firebase Auth password update.");
        }

        // OTP-ni təmizlə və şifrəni hash-ləyərək saxla
        const salt = await bcrypt.genSalt(10);
        user.password = await bcrypt.hash(newPassword, salt);
        
        delete user.otp;
        delete user.otpExpiry;
        
        fs.writeFileSync("./users.json", JSON.stringify(users, null, 2));
        res.json({ success: true, message: "Şifrə uğurla dəyişdirildi." });

    } catch (e) {
        res.status(500).json({ success: false });
    }
});

// Yeni API: Profil Məlumatlarını Yenilə
app.post("/api/auth/update-profile", async (req, res) => {
    const { email, displayName, status, profilePic } = req.body;
    
    if (!email) return res.status(400).json({ success: false, message: "Email lazımdır." });

    try {
        let users = [];
        if (fs.existsSync("./users.json")) {
            users = JSON.parse(fs.readFileSync("./users.json", "utf-8"));
        }
        
        let userIdx = users.findIndex(u => u.email === email);
        if (userIdx === -1) {
            users.push({ email: email, username: displayName || email.split('@')[0], status: status || "ProScore istifadəçisi" });
            userIdx = users.length - 1;
        }

        const user = users[userIdx];
        if (displayName) user.username = displayName;
        if (status !== undefined) user.status = status;
        if (profilePic !== undefined) user.profilePic = profilePic;

        fs.writeFileSync("./users.json", JSON.stringify(users, null, 2));
        res.json({ success: true, message: "Profil uğurla yeniləndi." });
    } catch (e) {
        console.error("Update profile error:", e);
        res.status(500).json({ success: false, message: "Server xətası baş verdi." });
    }
});

// Yeni API: Profil Məlumatlarını Gətir
app.get("/api/auth/profile/:email", async (req, res) => {
    const { email } = req.params;
    try {
        if (!fs.existsSync("./users.json")) return res.status(404).json({ success: false });
        let users = JSON.parse(fs.readFileSync("./users.json", "utf-8"));
        const user = users.find(u => u.email === email);
        
        if (!user) return res.status(404).json({ success: false, message: "İstifadəçi tapılmadı." });

        res.json({
            success: true,
            data: {
                displayName: user.username,
                status: user.status || "ProScore istifadəçisi",
                profilePic: user.profilePic || "U"
            }
        });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

// FCM Device & Favorites Tracking
const REG_FILE = "./registrations.json";
let fcmRegistrations = {}; // { token: { favorites: [] } }

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

function loadRegistrations() {
    try {
        if (fs.existsSync(REG_FILE)) {
            fcmRegistrations = JSON.parse(fs.readFileSync(REG_FILE, "utf-8"));
            console.log(`[FCM] Loaded ${Object.keys(fcmRegistrations).length} registrations from file.`);
        }
    } catch (e) {
        console.error("[FCM] Error loading registrations:", e.message);
    }
}
loadRegistrations();

function saveRegistrations() {
    try {
        fs.writeFileSync(REG_FILE, JSON.stringify(fcmRegistrations, null, 2));
    } catch (e) {
        console.error("[FCM] Error saving registrations:", e.message);
    }
}

app.post("/api/fcm/register", (req, res) => {
    const { token, favorites, leagues } = req.body;
    if (token) {
        fcmRegistrations[token] = { 
            favorites: favorites || [], 
            leagues: leagues || [],
            lastUpdated: Date.now() 
        };
        saveRegistrations();
        console.log(`[FCM] Token updated. Matches: ${(favorites||[]).length}, Leagues: ${(leagues||[]).length}`);
        res.json({ success: true });
    } else {
        res.status(400).json({ success: false, message: "Token is required" });
    }
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
            body: "Təbriklər! Arxa plan bildirişləri artıq aktivdir 🚀"
        },
        data: { type: 'test' },
        android: { 
            priority: 'high',
            notification: { 
                sound: 'default',
                channel_id: 'goal_notifications',
                vibrate_timings_ms: [0, 500, 200, 500, 200, 500],
                notification_priority: 'priority_max',
                visibility: 'public'
            } 
        },
        apns: { 
            payload: { 
                aps: { 
                    sound: 'default', 
                    badge: 1,
                    content_available: true,
                    priority: 10
                } 
            } 
        },
        webpush: {
            headers: {
                Urgency: 'high'
            },
            notification: {
                requireInteraction: true,
                vibrate: [500, 100, 500, 100, 500],
                icon: 'https://imglink.cc/cdn/hC_7Jg-pCe.png',
                tag: 'test-push',
                renotify: true
            },
            fcm_options: {
                link: '/'
            }
        },
        token: token
    };

    try {
        const resp = await admin.messaging().send(message);
        res.json({ success: true, messageId: resp });
    } catch (e) {
        console.error("[FCM] Test push error:", e);
        res.status(500).json({ success: false, message: e.message });
    }
});

// Background Worker for Live Matches Push Notifications
let lastScores = {};

setInterval(async () => {
    if (Object.keys(fcmRegistrations).length === 0) return;

    try {
        const result = await fetchFromSofa("/sport/football/events/live");
        if (!result || !result.data || !result.data.events) return;
        
        const events = result.data.events;
        
        events.forEach(ev => {
            const matchId = ev.id.toString();
            const hs = ev.homeScore?.current || 0;
            const as = ev.awayScore?.current || 0;
            const leagueId = (ev.tournament.uniqueTournament?.id || ev.tournament.id).toString();
            const prev = lastScores[matchId];
            
            if (prev) {
                if (hs > prev.homeScore || as > prev.awayScore) {
                    const title = `Rabona Media`;
                    const body = `${ev.homeTeam.name} ${hs} - ${as} ${ev.awayTeam.name}\nQol vuruldu! ⚽`;
                    
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

                    const tokensToNotify = Object.keys(fcmRegistrations).filter(token => {
                        const reg = fcmRegistrations[token];
                        return (reg.favorites && reg.favorites.includes(matchId)) || (reg.leagues && reg.leagues.includes(leagueId));
                    });
                    
                    if (tokensToNotify.length > 0 && firebaseInitialized) {
                        const message = {
                            notification: { title, body },
                            data: { matchId: matchId, type: 'goal' },
                            android: { 
                                priority: 'high',
                                notification: { 
                                    sound: 'default',
                                    channel_id: 'goal_notifications',
                                    notification_priority: 'priority_max',
                                    vibrate_timings_ms: [0, 500, 100, 500, 100, 500],
                                    visibility: 'public'
                                } 
                            },
                            apns: { 
                                payload: { 
                                    aps: { 
                                        sound: 'default', 
                                        badge: 1,
                                        content_available: true
                                    } 
                                } 
                            },
                            webpush: { 
                                headers: { Urgency: 'high' },
                                notification: { 
                                    requireInteraction: true, 
                                    vibrate: [500, 110, 500, 110, 450, 110, 200, 110, 170, 40], 
                                    icon: 'https://imglink.cc/cdn/hC_7Jg-pCe.png',
                                    tag: `goal-${matchId}`,
                                    renotify: true
                                },
                                fcm_options: {
                                    link: '/'
                                }
                            }
                        };
                        
                        tokensToNotify.forEach(token => {
                            admin.messaging().send({ ...message, token })
                                .catch(err => {
                                    if (err.code === 'messaging/registration-token-not-registered') delete fcmRegistrations[token];
                                });
                        });
                    }
                }
            }
            lastScores[matchId] = { homeScore: hs, awayScore: as };
        });
    } catch (e) {
        console.error("[Background Tracker] Error:", e.message);
    }
}, 12000);

// --- Reminder Worker for Upcoming Favorited Matches ---
setInterval(async () => {
    if (Object.keys(fcmRegistrations).length === 0 || !firebaseInitialized) return;

    try {
        const todayStr = new Date().toISOString().split('T')[0];
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        const tomorrowStr = tomorrow.toISOString().split('T')[0];

        // Fetch events for today and tomorrow
        // We use direct fetching to ensure background correctness, but Sofa API is cached at CDN level anyway
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

        for (const token in fcmRegistrations) {
            const reg = fcmRegistrations[token];
            if (!reg.favorites || reg.favorites.length === 0) continue;

            reg.favorites.forEach(favId => {
                const match = allUpcomingEvents.find(ev => ev.id.toString() === favId.toString());
                if (!match) return;

                const startTimestamp = match.startTimestamp;
                if (!startTimestamp) return;

                const timeUntilStart = startTimestamp - nowSec;
                
                if (!remindersSent[token]) remindersSent[token] = {};
                if (!remindersSent[token][favId]) remindersSent[token][favId] = { timestamp: Date.now() };

                const state = remindersSent[token][favId];

                // 1. 30 Minutes Reminder (Between 20 and 40 minutes before start)
                if (timeUntilStart > 0 && timeUntilStart <= 40 * 60 && timeUntilStart >= 20 * 60 && !state.soon) {
                    const title = `Xatırlatma: ${match.homeTeam.name} - ${match.awayTeam.name}`;
                    const body = `Oyunun başlamasına təxminən 30 dəqiqə qaldı! ⏳`;
                    
                    admin.messaging().send({
                        notification: { title, body },
                        data: { matchId: favId.toString(), type: 'reminder_soon' },
                        token: token,
                        android: { 
                            priority: 'high',
                            notification: { 
                                sound: 'default',
                                channel_id: 'goal_notifications',
                                notification_priority: 'priority_max'
                            } 
                        },
                        apns: { payload: { aps: { sound: 'default', badge: 1, content_available: true } } },
                        webpush: { 
                            headers: { Urgency: 'high' },
                            notification: { icon: 'https://www.sofascore.com/favicon.ico', requireInteraction: true } 
                        }
                    }).then(() => {
                        state.soon = true;
                        state.timestamp = Date.now();
                        saveReminders();
                        console.log(`[Reminder] Sent 'Soon' notification for match ${favId}`);
                    }).catch(err => {
                        if (err.code === 'messaging/registration-token-not-registered') delete fcmRegistrations[token];
                    });
                }

                // 2. Match Started Reminder (Between 0 and -10 minutes start)
                // Note: The main live tracker handles goals, this handles the start whistle
                const isStarted = match.status?.type === 'inprogress' || (timeUntilStart <= 0 && timeUntilStart >= -600);
                if (isStarted && !state.started) {
                    const title = `Oyun Başladı! ⚽`;
                    const body = `${match.homeTeam.name} - ${match.awayTeam.name} oyunu start götürdü.`;
                    
                    admin.messaging().send({
                        notification: { title, body },
                        data: { matchId: favId.toString(), type: 'reminder_started' },
                        token: token,
                        android: { 
                            priority: 'high',
                            notification: { 
                                sound: 'default',
                                channel_id: 'goal_notifications',
                                notification_priority: 'priority_max'
                            } 
                        },
                        apns: { payload: { aps: { sound: 'default', badge: 1, content_available: true } } },
                        webpush: { 
                            headers: { Urgency: 'high' },
                            notification: { icon: 'https://www.sofascore.com/favicon.ico', requireInteraction: true } 
                        }
                    }).then(() => {
                        state.started = true;
                        state.timestamp = Date.now();
                        saveReminders();
                        console.log(`[Reminder] Sent 'Started' notification for match ${favId}`);
                    }).catch(err => {
                        if (err.code === 'messaging/registration-token-not-registered') delete fcmRegistrations[token];
                    });
                }
            });
        }
    } catch (e) {
        console.error("[Reminder Worker] Error:", e.name, e.message);
    }
}, 5 * 60 * 1000); // Check every 5 minutes

app.get("/api/ping", (req, res) => {
    res.json({ status: "alive", timestamp: new Date().toISOString() });
});

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server ${PORT} portunda aktivdir.`);
});