const express = require("express");
const path = require("path");
const axios = require("axios");
const cors = require("cors");
const app = express();

app.use(cors());
app.use(express.static(path.join(__dirname)));

const SOFA_API = "https://www.sofascore.com/api/v1";
const HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
    "Referer": "https://www.sofascore.com/"
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

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server ${PORT} portunda aktivdir.`);
});