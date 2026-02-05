const express = require("express");
const path = require("path");
const app = express();

// Statik faylları (index.html və s.) təqdim etmək üçün
app.use(express.static(path.join(__dirname)));

// Ana səhifəyə girəndə index.html-i açır
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
});

// Port tənzimləməsi
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server ${PORT} portunda aktivdir. http://localhost:${PORT}`);
});