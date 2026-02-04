const express = require("express");
const cors = require("cors");
const app = express();
app.use(cors());

// Test məlumatları (Artıq bloklanma ehtimalı 0-dır)
const MOCK_DATA = [
    {
        id: 1,
        displayLeague: "Premier League",
        leagueId: 1,
        home: "Arsenal",
        homeId: 42,
        away: "Liverpool",
        awayId: 44,
        score: { home: 2, away: 1 },
        minute: "75'",
        homeGoals: [{name: "Saka", time: 12}, {name: "Havertz", time: 60}],
        awayGoals: [{name: "Salah", time: 45}]
    },
    {
        id: 2,
        displayLeague: "La Liga",
        leagueId: 8,
        home: "Real Madrid",
        homeId: 2829,
        away: "Barcelona",
        awayId: 2817,
        score: { home: 0, away: 0 },
        minute: "12'",
        homeGoals: [],
        awayGoals: []
    }
];

app.get("/", (req, res) => res.send("Server Hazırdır!"));

app.get("/live-scores", (req, res) => {
    res.json(MOCK_DATA);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log("🚀 Server aktivdir!"));