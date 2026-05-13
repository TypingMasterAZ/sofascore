/**
 * Patch script: Replaces the app.listen block in server.js with
 * aggressive always-on background refresh system.
 */
const fs = require('fs');
const path = require('path');

const serverPath = path.join(__dirname, '..', 'server.js');
let content = fs.readFileSync(serverPath, 'utf8');

// Find the start of the block to replace
const startMarker = 'const PORT = process.env.PORT || 3000;';
const startIdx = content.indexOf(startMarker);
if (startIdx === -1) {
    console.error('ERROR: Could not find PORT marker');
    process.exit(1);
}

// Everything before the PORT line stays
const before = content.substring(0, startIdx);

// New app.listen block
const newBlock = `const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(\`Server \${PORT} portunda aktivdir.\`);
    console.log(\`[ALWAYS-ON] Background refresh: \${BACKGROUND_REFRESH_INTERVAL_MS}ms | Self-ping: \${SELF_PING_INTERVAL_MS}ms | Warmup: \${RUNTIME_WARMUP_INTERVAL_MS}ms\`);
    warmLeagueImages(30).catch(e => {
        console.warn("[Warmup] Initial league image prefetch failed:", e.message);
    });
    setTimeout(() => {
        warmRuntimeCaches({ force: true }).catch(e => {
            console.warn("[Warmup] Initial delayed warmup failed:", e.message);
        });
    }, 3000);
    processSupportEmailQueue();
    setInterval(processSupportEmailQueue, 60 * 1000);
    setInterval(() => warmRuntimeCaches().catch(e => {
        console.warn("[Warmup] Runtime interval failed:", e.message);
    }), RUNTIME_WARMUP_INTERVAL_MS);
    setInterval(() => warmLeagueImages(8).catch(e => {
        console.warn("[Warmup] League image interval failed:", e.message);
    }), 2 * 60 * 1000);

    // ——— AGGRESSIVE BACKGROUND REFRESH (HER 5 SANIYE) ———————————————
    // Server HECVAXT yatmir. Sayt bagli olsa bele her 5 saniyede:
    //   1) Canli oyun melumatlarini yenileyir
    //   2) Butun canli oyunlarin hadiselerini (incidents) ve statistikalarini evvelceden yukleyir
    //   3) Qol askarlanmasi HEMISE aktiv qalir - bildiris aninda gonderilir
    //   4) Istifadeci oyuna basdiqda hadiseler DERHAL gosterilir (artiq cache-dedir)
    let bgRefreshInFlight = false;
    let bgRefreshCycle = 0;
    let lastBgRefreshLog = 0;

    setInterval(async () => {
        if (bgRefreshInFlight) return;
        bgRefreshInFlight = true;
        bgRefreshCycle++;

        try {
            // === 1. HEMISE canli neticeleri yenile (sayt bagli olsa bele) ===
            const liveData = await fetchLiveScoresForNotifications();
            const liveEvents = liveData?.events || [];
            const liveCount = liveEvents.length;

            // Her 30 saniyede bir log yaz (spam olmasin)
            if (Date.now() - lastBgRefreshLog > 30000) {
                console.log(\`[BG-REFRESH #\${bgRefreshCycle}] \${liveCount} canli oyun | Cache keys: \${Object.keys(cache).length} | Uptime: \${Math.round(process.uptime())}s\`);
                lastBgRefreshLog = Date.now();
            }

            // === 2. Canli oyunlarin hadise/statistikalarini evvelceden yukle ===
            // Istifadeci oyuna basdiqda DERHAL hazir olsun
            const liveInProgress = liveEvents.filter(ev =>
                ev?.id &&
                String(ev.source || "sofascore").toLowerCase() !== "mackolik" &&
                (ev.status?.type === "inprogress" ||
                 ["HT", "HALFTIME", "1ST_HALF", "2ND_HALF", "EXTRA_TIME", "ET"].includes(
                     (ev.status?.description || "").toUpperCase()
                 ))
            );

            // Her dongude 15 oyunun hadiselerini yenile (rotation ile)
            const batchSize = 15;
            const startIdx = ((bgRefreshCycle - 1) * batchSize) % Math.max(liveInProgress.length, 1);
            const batchEvents = liveInProgress.slice(startIdx, startIdx + batchSize);
            if (batchEvents.length < batchSize && startIdx > 0) {
                const remaining = batchSize - batchEvents.length;
                batchEvents.push(...liveInProgress.slice(0, remaining));
            }

            if (batchEvents.length > 0) {
                await Promise.allSettled(batchEvents.flatMap(event => {
                    const id = event.id.toString();
                    const tasks = [];

                    // Hadiseleri (incidents) yenile - qol bildirisleri ucun vacib
                    const incidentsCached = cache[\`incidents_\${id}\`];
                    const incidentsAge = incidentsCached ? Date.now() - incidentsCached.timestamp : Infinity;
                    if (incidentsAge > INCIDENTS_STALE_REFRESH_MS) {
                        tasks.push(getMatchIncidentsData(id).catch(() => {}));
                    }

                    // Statistikalari yenile
                    const statsCached = cache[\`stats_\${id}\`];
                    const statsAge = statsCached ? Date.now() - statsCached.timestamp : Infinity;
                    if (!statsCached || statsAge > STATS_STALE_REFRESH_MS || !hasUsefulStatsData(statsCached.data)) {
                        tasks.push(getMatchStatisticsData(id, STATS_CACHE_TTL).catch(() => {}));
                    }

                    return tasks;
                }));
            }

            // === 3. Her 6-ci dongude (30 san) bugunku planlanan oyunlari da yenile ===
            if (bgRefreshCycle % 6 === 0) {
                const todayStr = new Date().toISOString().split('T')[0];
                getCachedData(\`matches_sofascore_\${todayStr}\`, async () => {
                    return await fetchScheduledFromSofaScore(todayStr);
                }, 30 * 1000).catch(() => {});
            }

        } catch (e) {
            console.error(\`[BG-REFRESH] Error: \${e.message}\`);
        } finally {
            bgRefreshInFlight = false;
        }
    }, BACKGROUND_REFRESH_INTERVAL_MS);
    // —————————————————————————————————————————————————————————————————

    // ——— RENDER KEEP-ALIVE (HER 30 SANIYE) ——————————————————————————
    // Render free plan serveri 15 deqiqelik hereketsizlikden sonra yuxuya gonderir.
    // Bu interval her 30 saniyede bir ozune sorgu vurur - serveri HEC VAXT yatdirmir.
    const getSelfUrl = () => {
        if (process.env.KEEPALIVE_URL) return process.env.KEEPALIVE_URL;
        if (process.env.RENDER_EXTERNAL_URL) return process.env.RENDER_EXTERNAL_URL;
        if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL;
        if (process.env.RENDER_SERVICE_NAME) return \`https://\${process.env.RENDER_SERVICE_NAME}.onrender.com\`;
        return detectedHostUrl;
    };

    // Ilk ping derhal - server ayaga qalxan kimi
    setTimeout(async () => {
        const targetUrl = getSelfUrl();
        if (targetUrl && targetUrl.startsWith('http')) {
            try {
                await axios.get(\`\${targetUrl.replace(/\\/$/, "")}/api/ping?t=\${Date.now()}\`, { timeout: 7000 });
                console.log(\`[Keep-Alive] Initial self-ping OK: \${targetUrl}\`);
            } catch (e) {
                console.warn("[Keep-Alive] Initial self-ping failed:", e.message);
            }
        }
    }, 8000);

    setInterval(async () => {
        if (!KEEPALIVE_ENABLED || selfPingInFlight) return;
        const targetUrl = getSelfUrl();
        if (!targetUrl || !targetUrl.startsWith('http')) return;
        selfPingInFlight = true;
        const baseUrl = targetUrl.replace(/\\/$/, "");
        const timestamp = Date.now();

        try {
            const results = await Promise.allSettled([
                axios.get(\`\${baseUrl}/api/ping?t=\${timestamp}\`, { timeout: 7000 }),
                axios.get(\`\${baseUrl}/api/keepalive?light=1&t=\${timestamp}\`, { timeout: 7000 })
            ]);
            if (results.every(item => item.status === "rejected")) {
                throw results[0].reason;
            }
            // Her 2 deqiqede bir log (spam olmasin)
            if (timestamp % (2 * 60 * 1000) < SELF_PING_INTERVAL_MS) {
                console.log(\`[Keep-Alive] Self ping OK: \${baseUrl}\`);
            }
        } catch(e) {
            console.warn("[Keep-Alive] Self ping failed:", e.message);
        } finally {
            selfPingInFlight = false;
        }
    }, SELF_PING_INTERVAL_MS);
    // —————————————————————————————————————————————————————————————————
});
`;

// Write the patched file
fs.writeFileSync(serverPath, before + newBlock, 'utf8');
console.log('✅ server.js patched successfully!');
console.log(`   Before block: ${before.length} chars`);
console.log(`   New block: ${newBlock.length} chars`);
console.log(`   Total: ${(before + newBlock).length} chars`);
