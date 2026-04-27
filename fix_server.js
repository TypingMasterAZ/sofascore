// This script reads server.js, fixes all problems, and writes it back
const fs = require('fs');
const filePath = './server.js';
let code = fs.readFileSync(filePath, 'utf-8');
const lines = code.split('\n');

// === FIX 1: Replace lines 1-33 (add missing imports, remove duplicate fetchFromSofa) ===
// === FIX 2: Fix orphaned code block at line 34 (add missing Firebase ENV try/if) ===
const newTop = `const express = require("express");
// Version: 2.1.0 - Bug Fix Release
console.log("-----------------------------------------");
console.log(\`[STARTUP] Server booting at \${new Date().toISOString()}\`);
console.log("-----------------------------------------");
require('dotenv').config();
const path = require("path");
const axios = require("axios");
const cors = require("cors");
const fs = require("fs");
const admin = require("firebase-admin");
const bcrypt = require("bcryptjs");
const nodemailer = require("nodemailer");
const { HttpsProxyAgent } = require('https-proxy-agent');

const app = express();

// Proksi konfiqurasiyasi
const getProxyAgent = () => {
    if (!process.env.PROXY_HOST) return null;
    const proxyUrl = \`http://\${process.env.PROXY_USER}:\${process.env.PROXY_PASS}@\${process.env.PROXY_HOST}:\${process.env.PROXY_PORT}\`;
    return new HttpsProxyAgent(proxyUrl);
};

// Firebase Admin SDK Initialization
let firebaseInitialized = false;
let serviceAccount = null;

if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    if (serviceAccount.private_key && serviceAccount.private_key.includes('\\\\n')) {
        serviceAccount.private_key = serviceAccount.private_key.replace(/\\\\n/g, '\\n');
    }`;

// Find where line 34 content starts (the orphaned block)
// Lines 34-65 in original = Firebase init continuation
// We keep lines 34 onwards (index 33+)
const restAfterOrphan = lines.slice(33); // from "    firebaseInitialized = true;" onwards

// === FIX 3: Remove second duplicate fetchFromSofa (lines 172-194, index 171-193) ===
// We keep only the REAL fetchFromSofa but add proxy support to it

// Build the fixed file
let fixedLines = newTop.split('\n').concat(restAfterOrphan);
let fixedCode = fixedLines.join('\n');

// === FIX 4 & 5: Remove duplicate routes ===
// Remove the second /api/matches/:date (lines ~418-444 in original)
// Remove the second /api/match/:id/statistics (lines ~447-459 in original)

// Find and remove duplicate /api/matches/:date block
const matchesRoutePattern = '// Yeni API: Matçlar (Skedullu)\r\napp.get("/api/matches/:date"';
const firstMatchesIdx = fixedCode.indexOf('// Yeni API: Matçlar (Skedullu)');
if (firstMatchesIdx !== -1) {
    const secondMatchesIdx = fixedCode.indexOf('// Yeni API: Matçlar (Skedullu)', firstMatchesIdx + 10);
    if (secondMatchesIdx !== -1) {
        // Find the end of this duplicate block - next route or comment block
        const afterSecond = fixedCode.indexOf('\n// Yeni API:', secondMatchesIdx + 10);
        if (afterSecond !== -1) {
            fixedCode = fixedCode.substring(0, secondMatchesIdx) + fixedCode.substring(afterSecond);
            console.log('Removed duplicate /api/matches/:date route');
        }
    }
}

// Remove duplicate /api/match/:id/statistics
const statsPattern = '// Yeni API: Matç Statistikası';
const firstStatsIdx = fixedCode.indexOf(statsPattern);
if (firstStatsIdx !== -1) {
    const secondStatsIdx = fixedCode.indexOf(statsPattern, firstStatsIdx + 10);
    if (secondStatsIdx !== -1) {
        // Find end - next section
        let endOfDup = fixedCode.indexOf('\n\n\n', secondStatsIdx);
        if (endOfDup === -1) endOfDup = fixedCode.indexOf('\n// Yeni API: Canlı Liqa', secondStatsIdx);
        if (endOfDup !== -1) {
            fixedCode = fixedCode.substring(0, secondStatsIdx) + fixedCode.substring(endOfDup);
            console.log('Removed duplicate /api/match/:id/statistics route');
        }
    }
}

// === FIX 6: Fix teamId scope error ===
// Replace "const cached = cache[`team_${teamId}`];" with "const cached = cache[`team_${req.params.id}`];"
fixedCode = fixedCode.replace(
    'const cached = cache[`team_${teamId}`];',
    'const cached = cache[`team_${req.params.id}`];'
);
console.log('Fixed teamId scope error');

// === FIX: Update fetchFromSofa to use proxy ===
fixedCode = fixedCode.replace(
    `const res = await axios.get(\`\${SOFA_API}\${path}\`, { \r\n            headers: HEADERS,\r\n            params: params,\r\n            timeout: 8000\r\n        });`,
    `const res = await axios.get(\`\${SOFA_API}\${path}\`, { \r\n            headers: HEADERS,\r\n            params: params,\r\n            timeout: 8000,\r\n            httpsAgent: getProxyAgent()\r\n        });`
);
console.log('Added proxy support to fetchFromSofa');

// Write the fixed file
fs.writeFileSync(filePath, fixedCode, 'utf-8');
console.log('server.js fixed successfully!');

// Count lines
const finalLines = fixedCode.split('\n').length;
console.log(`Final line count: ${finalLines}`);
