const express = require("express");
const axios = require("axios");
const path = require("path");
const cors = require("cors");
const app = express();

app.use(cors());
app.use(express.static(path.join(__dirname)));

app.get("/live-scores", async (req, res) => {
    try {
        const response = await axios.get("https://api.sofascore.com/api/v1/sport/football/events/live", {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
                "Referer": "https://www.sofascore.com/",
                "Origin": "https://www.sofascore.com"
            }
        });
        
        // Məlumatı təmizləyib sadəcə lazım olanı göndəririk
        if (response.data && response.data.events) {
            res.json(response.data.events);
        } else {
            res.json([]);
        }
    } catch (err) {
        console.error("Xəta baş verdi:", err.message);
        res.status(500).json({ error: "Məlumat alınarkən xəta baş verdi" });
    }
});

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server ${PORT} portunda aktivdir.`);
});