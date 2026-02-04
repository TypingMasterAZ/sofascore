const express = require("express");
const cors = require("cors");
const app = express();
app.use(cors());

const HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Origin": "https://www.sofascore.com",
    "Referer": "https://www.sofascore.com/"
};

app.get("/live-scores", async (req, res) => {
    try {
        const response = await fetch("https://api.sofascore.com/api/v1/sport/football/events/live", { headers: HEADERS });
        const data = await response.json();
        
        if (!data || !data.events || data.events.length === 0) {
            return res.json([]); 
        }

        const matches = await Promise.all(data.events.slice(0, 40).map(async (event) => {
            let homeGoals = [], awayGoals = [];
            
            try {
                const incRes = await fetch(`https://api.sofascore.com/api/v1/event/${event.id}/incidents`, { headers: HEADERS });
                const incData = await incRes.json();
                if (incData && incData.incidents) {
                    incData.incidents.forEach(inc => {
                        if (inc.incidentType === "goal") {
                            const playerName = inc.player ? inc.player.name : (inc.playerName || "Goal");
                            const goalInfo = { name: playerName, time: inc.time };
                            if (inc.isHome) homeGoals.push(goalInfo);
                            else awayGoals.push(goalInfo);
                        }
                    });
                }
            } catch (e) { }

            let minute = "";
            const status = event.status.type;
            const desc = event.status.description;

            if (status === "finished") minute = "FT";
            else if (desc === "Halftime") minute = "HT";
            else if (status === "inprogress") {
                if (event.status.clock?.current !== undefined) {
                    minute = Math.floor(event.status.clock.current / 60) + "'";
                } else if (event.time?.current) {
                    const diff = Math.floor((Math.floor(Date.now() / 1000) - event.time.current) / 60);
                    minute = (desc === "2nd half" ? diff + 45 : diff) + "'";
                } else minute = "Live";
            } else minute = desc || "Soon";

            return {
                id: event.id,
                displayLeague: `${event.tournament?.category?.name || "Other"}: ${event.tournament?.name}`,
                leagueId: event.tournament?.uniqueTournament?.id || event.tournament?.id || 0,
                home: event.homeTeam.name,
                homeId: event.homeTeam.id,
                away: event.awayTeam.name,
                awayId: event.awayTeam.id,
                score: {
                    home: event.homeScore?.current ?? 0,
                    away: event.awayScore?.current ?? 0
                },
                minute,
                homeGoals,
                awayGoals
            };
        }));

        res.json(matches);

    } catch (err) { 
        console.error("Xəta:", err.message);
        res.json([]); 
    }
});

const PORT = process.env.PORT || 3000; 
app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Server ${PORT} portunda aktivdir!`);
});