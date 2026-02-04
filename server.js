const express = require("express");
const cors = require("cors");
const app = express();
app.use(cors());

app.get("/live-scores", async (req, res) => {
    try {
        // Sofascore-un bloklanmayan canlı oyunlar API-si
        const response = await fetch("https://api.sofascore.com/api/v1/sport/football/events/live");
        const data = await response.json();
        
        if (!data.events) return res.json([]);

        const matches = data.events.map(event => ({
            id: event.id,
            league: event.tournament.name,
            home: event.homeTeam.shortName || event.homeTeam.name,
            away: event.awayTeam.shortName || event.awayTeam.name,
            homeId: event.homeTeam.id,
            awayId: event.awayTeam.id,
            score: {
                home: event.homeScore.current || 0,
                away: event.awayScore.current || 0
            },
            minute: event.status.description === "Live" ? event.lastPeriod : event.status.description,
            // Sofascore-da qol vuranlar fərqli endpointdədir, ilkin olaraq boş göndəririk
            scorers: [] 
        }));

        res.json(matches);
    } catch (err) {
        console.error(err);
        res.json([]);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0");