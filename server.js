const express = require("express");
const cors = require("cors");
const app = express();
app.use(cors());

app.get("/", (req, res) => res.send("Server İşləyir!"));

app.get("/live-scores", async (req, res) => {
    try {
        // Alternativ açıq API mənbəsi
        const response = await fetch("https://worldcupjson.net/matches/current");
        const data = await response.json();
        
        if (!data || data.length === 0) {
            // Əgər oyun yoxdursa, test üçün bura bir "Sınaq Oyunu" əlavə edirik 
            // Beləcə sistemin işlədiyini görə biləcəksən
            return res.json([{
                id: 1,
                displayLeague: "Sınaq Liqası: Canlı",
                home: "Komanda A",
                away: "Komanda B",
                score: { home: 1, away: 0 },
                minute: "15'",
                homeGoals: [],
                awayGoals: []
            }]);
        }

        const matches = data.map(m => ({
            id: m.id,
            displayLeague: "Dünya Kuboku / Beynəlxalq",
            home: m.home_team.name,
            away: m.away_team.name,
            score: { home: m.home_team.goals, away: m.away_team.goals },
            minute: m.time || "Live",
            homeGoals: [],
            awayGoals: []
        }));

        res.json(matches);
    } catch (err) {
        res.json([{ id: 0, home: "Xəta", away: "Məlumat alınmadı", score: {home:0, away:0}, minute: "!", displayLeague: "Sistem", homeGoals: [], awayGoals: [] }]);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0");