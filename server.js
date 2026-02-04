const express = require("express");
const cors = require("cors");
const app = express();
app.use(cors());

app.get("/live-scores", async (req, res) => {
    try {
        const response = await fetch("https://prod-public-api.livescore.com/v1/api/app/live/soccer/0");
        const data = await response.json();
        
        if (!data.Stages) return res.json([]);

        let allMatches = [];
        data.Stages.forEach(stage => {
            stage.Events.forEach(event => {
                // Qolları daha dəqiq süzmək üçün
                const goals = event.Incs ? event.Incs.filter(i => i.InType === "Goal") : [];
                
                allMatches.push({
                    id: event.Eid,
                    displayLeague: `${stage.Cnm}: ${stage.Snm}`,
                    home: event.T1[0].Nm,
                    homeId: event.T1[0].ID,
                    // Sofascore loqo bazasına keçid (daha stabil)
                    homeLogo: `https://api.sofascore.app/api/v1/team/${event.T1[0].ID}/image`,
                    away: event.T2[0].Nm,
                    awayId: event.T2[0].ID,
                    awayLogo: `https://api.sofascore.app/api/v1/team/${event.T2[0].ID}/image`,
                    score: {
                        home: event.Tr1 || 0,
                        away: event.Tr2 || 0
                    },
                    minute: event.Eps, 
                    scorers: goals.map(i => ({
                        name: i.Pn,
                        time: i.Min,
                        side: i.ScSide // 1: Ev, 2: Qonaq
                    }))
                });
            });
        });

        res.json(allMatches);
    } catch (err) {
        res.json([]);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0");