const express = require("express");
const cors = require("cors");
const app = express();
app.use(cors());

app.get("/", (req, res) => res.send("LiveScore Bağlantısı Aktivdir!"));

app.get("/live-scores", async (req, res) => {
    try {
        // Bu link LiveScore-un rəsmi daxili JSON bazasıdır (API Key istəmir)
        const response = await fetch("https://prod-public-api.livescore.com/v1/api/app/live/soccer/0");
        const data = await response.json();
        
        if (!data.Stages || data.Stages.length === 0) {
            return res.json([]);
        }

        let matches = [];

        data.Stages.forEach(stage => {
            stage.Events.forEach(event => {
                matches.push({
                    id: event.Eid,
                    displayLeague: `${stage.Cnm}: ${stage.Snm}`, // Ölkə və Liqa adı
                    home: event.T1[0].Nm,
                    homeLogo: event.T1[0].Img ? `https://static.livescore.com/content/team/v2/img/${event.T1[0].Img}` : "",
                    away: event.T2[0].Nm,
                    awayLogo: event.T2[0].Img ? `https://static.livescore.com/content/team/v2/img/${event.T2[0].Img}` : "",
                    score: {
                        home: event.Tr1 || 0,
                        away: event.Tr2 || 0
                    },
                    // Oyunun statusu (Dəqiqə, HT, FT)
                    minute: event.Eps === "HT" ? "HT" : (event.Eps === "FT" ? "FT" : event.Eps),
                    events: [] // Qollar bu endpoint-də sadə formatda gəlir
                });
            });
        });

        res.json(matches);
    } catch (err) {
        console.error("Xəta:", err.message);
        res.json([]);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0");