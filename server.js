const express = require("express");
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
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    firebaseInitialized = true;
    console.log("Firebase Admin SDK initialized from Environment Variable.");
  } catch (e) {
    console.error("FIREBASE_SERVICE_ACCOUNT parse error.");
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
  console.warn("[WARNING] Firebase Admin SDK not initialized. Push notifications and Firebase Auth updates will not work.");
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

const SOFA_API = "https://www.sofascore.com/api/v1";
const HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9,az;q=0.8",
    "Referer": "https://www.sofascore.com/",
    "Origin": "https://www.sofascore.com",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache"
};

// API vasitəçisi (Komanda məlumatları və heyət üçün)
app.get("/api/team/:id", async (req, res) => {
    try {
        const teamId = req.params.id;
        const [info, players] = await Promise.all([
            axios.get(`${SOFA_API}/team/${teamId}`, { headers: HEADERS }),
            axios.get(`${SOFA_API}/team/${teamId}/players`, { headers: HEADERS })
        ]);
        res.json({ info: info.data, players: players.data });
    } catch (error) {
        res.status(500).json({ error: true });
    }
});

// Yeni API: Canlı Matçlar
app.get("/api/matches/live", async (req, res) => {
    try {
        const result = await axios.get(`${SOFA_API}/sport/football/events/live`, { headers: HEADERS });
        res.json(result.data);
    } catch (error) {
        res.status(500).json({ error: true, message: error.message });
    }
});

// Yeni API: Matçlar (Skedullu)
app.get("/api/matches/:date", async (req, res) => {
    try {
        const { date } = req.params;
        const result = await axios.get(`${SOFA_API}/sport/football/scheduled-events/${date}`, { headers: HEADERS });
        res.json(result.data);
    } catch (error) {
        res.status(500).json({ error: true, message: error.message });
    }
});

// Yeni API: Matç Hadisələri (Qollar, Kartlar)
app.get("/api/match/:id/incidents", async (req, res) => {
    try {
        const { id } = req.params;
        const result = await axios.get(`${SOFA_API}/event/${id}/incidents`, { headers: HEADERS });
        res.json(result.data);
    } catch (error) {
        res.status(500).json({ error: true, message: error.message });
    }
});

// Yeni API: Matç Statistikası
app.get("/api/match/:id/statistics", async (req, res) => {
    try {
        const { id } = req.params;
        const result = await axios.get(`${SOFA_API}/event/${id}/statistics`, { headers: HEADERS });
        res.json(result.data);
    } catch (error) {
        res.status(500).json({ error: true, message: error.message });
    }
});

// Yeni API: Turnirin mövsümləri
app.get("/api/tournament/:id/seasons", async (req, res) => {
    try {
        const { id } = req.params;
        const result = await axios.get(`${SOFA_API}/unique-tournament/${id}/seasons`, { headers: HEADERS });
        res.json(result.data);
    } catch (error) {
        res.status(500).json({ error: true, message: error.message });
    }
});

// Yeni API: Canlı Liqa Cədvəli üçün Proxy
app.get("/api/standings/:tourId/:seasonId", async (req, res) => {
    try {
        const { tourId, seasonId } = req.params;
        const result = await axios.get(`${SOFA_API}/unique-tournament/${tourId}/season/${seasonId}/standings/total`, { headers: HEADERS });
        res.json(result.data);
    } catch (error) {
        console.error("Standings fetch error: ", error.message);
        res.status(500).json({ error: true, message: error.message });
    }
});

// Yeni API: Populyar Liqalar siyahısı
app.get("/api/top-leagues", async (req, res) => {
    try {
        const result = await axios.get(`${SOFA_API}/config/top-unique-tournaments/AZ/football`, { headers: HEADERS });
        res.json(result.data);
    } catch (error) {
        res.status(500).json({ error: true });
    }
});

// Yeni API: Bütün Kategoriyalar (Ölkələr)
app.get("/api/categories", async (req, res) => {
    try {
        const result = await axios.get(`${SOFA_API}/sport/football/categories`, { headers: HEADERS });
        res.json(result.data);
    } catch (error) {
        res.status(500).json({ error: true });
    }
});

// Yeni API: Kateqoriya üzrə Liqalar
app.get("/api/category/:id/tournaments", async (req, res) => {
    try {
        const result = await axios.get(`${SOFA_API}/category/${req.params.id}/unique-tournaments`, { headers: HEADERS });
        res.json(result.data);
    } catch (error) {
        res.status(500).json({ error: true });
    }
});

// Yeni API: Turnir Məlumatı (Single League Info)
app.get("/api/tournament/:id", async (req, res) => {
    try {
        const result = await axios.get(`${SOFA_API}/unique-tournament/${req.params.id}`, { headers: HEADERS });
        res.json(result.data);
    } catch (error) {
        res.status(500).json({ error: true });
    }
});

// Yeni API: Turnir Mövsümləri (Seasons)
app.get("/api/tournament/:id/seasons", async (req, res) => {
    try {
        const result = await axios.get(`${SOFA_API}/unique-tournament/${req.params.id}/seasons`, { headers: HEADERS });
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
        const result = await axios.get(`${SOFA_API}/search/all?q=${encodeURIComponent(q)}`, { headers: HEADERS });
        res.json(result.data);
    } catch (error) {
        res.status(500).json({ error: true });
    }
});

// Yeni API: Bombardirlər (Top Players)
app.get("/api/tournament/:id/season/:sid/top-players", async (req, res) => {
    try {
        const { id, sid } = req.params;
        const result = await axios.get(`${SOFA_API}/unique-tournament/${id}/season/${sid}/top-players/overall`, { headers: HEADERS });
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
let fcmRegistrations = {}; // { token: { favorites: [] } }

app.post("/api/fcm/register", (req, res) => {
    const { token, favorites } = req.body;
    if (token) {
        fcmRegistrations[token] = { 
            favorites: favorites || [], 
            lastUpdated: Date.now() 
        };
        console.log(`[FCM] Token registered. Favs count: ${(favorites||[]).length}`);
        res.json({ success: true });
    } else {
        res.status(400).json({ success: false, message: "Token is required" });
    }
});

// Background Worker for Live Matches Push Notifications
let lastScores = {};

setInterval(async () => {
    if (Object.keys(fcmRegistrations).length === 0) return; // No tokens registered

    try {
        const result = await axios.get(`${SOFA_API}/sport/football/events/live`, { headers: HEADERS });
        const events = result.data.events || [];
        
        events.forEach(ev => {
            const matchId = ev.id.toString();
            const hs = ev.homeScore?.current || 0;
            const as = ev.awayScore?.current || 0;
            const prev = lastScores[matchId];
            
            if (prev) {
                // Goal Detection
                if (hs > prev.homeScore || as > prev.awayScore) {
                    console.log(`[SERVER GOAL DETECTED] Match ${matchId}: ${ev.homeTeam.name} ${hs} - ${as} ${ev.awayTeam.name}`);
                    
                    const tokensToNotify = Object.keys(fcmRegistrations).filter(token => {
                        const favs = fcmRegistrations[token].favorites;
                        return favs.includes(matchId);
                    });
                    
                    if (tokensToNotify.length > 0 && firebaseInitialized) {
                        const message = {
                            notification: {
                                title: `${ev.homeTeam.name} - ${ev.awayTeam.name} GOOOL!`,
                                body: `${ev.homeTeam.name} ${hs} - ${as} ${ev.awayTeam.name}. Qool vuruldu!`
                            },
                            android: {
                                notification: {
                                    sound: 'default',
                                    defaultSound: true
                                }
                            },
                            apns: {
                                payload: {
                                    aps: {
                                        sound: 'default'
                                    }
                                }
                            },
                            webpush: {
                                notification: {
                                    requireInteraction: true,
                                    vibrate: [200, 100, 200]
                                }
                            }
                        };
                        
                        tokensToNotify.forEach(token => {
                            admin.messaging().send({ ...message, token: token })
                                .then(resp => console.log('[FCM] Sent successfully:', resp))
                                .catch(err => {
                                    if (err.code === 'messaging/registration-token-not-registered') {
                                        delete fcmRegistrations[token];
                                    }
                                });
                        });
                    } else if (tokensToNotify.length > 0 && !firebaseInitialized) {
                        console.warn("[FCM] Goal detected but Firebase not initialized. Cannot send notification.");
                    }
                }
            }
            lastScores[matchId] = { homeScore: hs, awayScore: as };
        });
    } catch (e) {
        console.error("[Background Tracker] Fetch error:", e.message);
    }
}, 30000);

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server ${PORT} portunda aktivdir.`);
});