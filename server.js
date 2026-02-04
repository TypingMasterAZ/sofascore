const express = require("express");
const cors = require("cors");
const app = express();
app.use(cors());

const HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Accept": "application/json",
    "Referer": "https://www.sofascore.com/",
    "Origin": "https://www.sofascore.com"
};

app.get("/", (req, res) => res.send("Server Hazırdır!"));

app.get("/live-scores", async (req, res) => {
    try {
        // Sofascore API-ni birbaşa çağırırıq
        const response = await fetch("https://api.sofascore.com/api/v1/sport/football/events/live", { headers: HEADERS });
        const data = await response.json();
        
        if (!data.events || data.events.length === 0) {
            return res.json([]);
        }

        const matches = data.events.map(event => ({
            id: event.id,
            displayLeague: event.tournament.name,
            leagueId: event.tournament.uniqueTournament?.id || 0,
            home: event.homeTeam.name,
            homeId: event.homeTeam.id,
            away: event.awayTeam.name,
            awayId: event.awayTeam.id,
            score: {
                home: event.homeScore?.current ?? 0,
                away: event.awayScore?.current ?? 0
            },
            minute: event.status.type === "inprogress" ? "Live" : event.status.description,
            homeGoals: [], // Sürət üçün hələlik boş qoyuruq
            awayGoals: []
        }));

        res.json(matches);
    } catch (err) {
        console.log("Xəta baş verdi:", err.message);
        res.json([]);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Server aktivdir: ${PORT}`));