const express = require("express");
const cors = require("cors");
const app = express();
app.use(cors());

app.get("/", (req, res) => res.send("ProScore LiveServer Aktivdir!"));

app.get("/live-scores", async (req, res) => {
    try {
        // LiveScore daxili JSON endpoint-i
        const response = await fetch("https://prod-public-api.livescore.com/v1/api/app/live/soccer/0");
        const data = await response.json();
        
        if (!data.Stages) return res.json([]);

        let allMatches = [];
        data.Stages.forEach(stage => {
            stage.Events.forEach(event => {
                allMatches.push({
                    id: event.Eid,
                    displayLeague: `${stage.Cnm}: ${stage.Snm}`,
                    home: event.T1[0].Nm,
                    // Livescore ID-si ilə loqo təminatı
                    homeLogo: `https://static.livescore.com/content/team/v2/img/${event.T1[0].Img}`,
                    away: event.T2[0].Nm,
                    awayLogo: `https://static.livescore.com/content/team/v2/img/${event.T2[0].Img}`,
                    score: {
                        home: event.Tr1 || 0,
                        away: event.Tr2 || 0
                    },
                    // HT, FT və ya dəqiqə statusu
                    minute: event.Eps, 
                    // Qolları "Incs" (Incidents) bölməsindən süzürük
                    scorers: event.Incs ? event.Incs.filter(i => i.InType === "Goal").map(i => ({
                        name: i.Pn,
                        time: i.Min,
                        side: i.ScSide // 1 = Ev, 2 = Qonaq
                    })) : []
                });
            });
        });

        res.json(allMatches);
    } catch (err) {
        console.error("Server Xətası:", err.message);
        res.json([]);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0");