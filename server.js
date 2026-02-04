const express = require("express");
const cors = require("cors");
const axios = require("axios");
const app = express();
app.use(cors());

app.get("/live-scores", async (req, res) => {
    try {
        // Sofascore API-ni real brauzer kimi çağırırıq
        const response = await axios.get("https://api.sofascore.com/api/v1/sport/football/events/live", {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
            }
        });

        if (!response.data.events || response.data.events.length === 0) {
            return res.json([]);
        }

        const matches = response.data.events.map(event => ({
            id: event.id,
            league: event.tournament.name,
            home: event.homeTeam.name,
            away: event.awayTeam.name,
            homeId: event.homeTeam.id,
            awayId: event.awayTeam.id,
            score: {
                home: event.homeScore.current || 0,
                away: event.awayScore.current || 0
            },
            minute: event.status.description === "Live" ? (event.lastPeriod || "Canlı") : event.status.description
        }));

        res.json(matches);
    } catch (err) {
        console.error("Xəta baş verdi:", err.message);
        res.json([]);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log(`Server ${PORT} portunda aktivdir`));