
            // G_URL silindi, yerinə yerli API istifadə olunur
            let allEvents = [];
            let groupedDataGlobal = {};
            let isLiveFiltered = false;

            /* Storage & Settings */
            let favMatches = JSON.parse(localStorage.getItem('favMatches') || '[]');
            let favLeagues = JSON.parse(localStorage.getItem('favLeagues') || '[]');
            let toastTimer = null;
            let userSettings = JSON.parse(localStorage.getItem('userSettings') || '{"defaultView":"matches", "timeFormat":"24h", "browserNotifEnabled":false, "soundEnabled":true, "onlyFavNotif":true, "notifSound":"https://assets.mixkit.co/active_storage/sfx/2869/2869-preview.mp3"}');
            let topLeaguesRaw = [];
            let allCategoriesGlobal = [];
            let expandedCategories = new Set();

            let authTimer = null;
            let userHasNavigated = false;
            let selectedDate = new Date().toISOString().split('T')[0];

            function generateDateTabs() {
                console.log("Generating date tabs...");
                const container = document.getElementById('dateTabsContainer');
                if (!container) return;
                const today = new Date();
                const days = ['Bazar', 'B.Ertəsi', 'Ç.Axşamı', 'Çərşənbə', 'C.Axşamı', 'Cümə', 'Şənbə'];
                const months = ['Yan', 'Fev', 'Mar', 'Apr', 'May', 'İyun', 'İyul', 'Avq', 'Sent', 'Okt', 'Noy', 'Dek'];
                
                let html = '';
                for (let i = -1; i <= 2; i++) {
                    const d = new Date();
                    d.setDate(today.getDate() + i);
                    const isToday = i === 0;
                    const dateStr = d.toISOString().split('T')[0];
                    const activeClass = (dateStr === selectedDate && !isLiveFiltered) ? 'active' : '';
                    
                    html += `
                        <div class="date-tab ${activeClass}" onclick="selectDate('${dateStr}', this)">
                            <span class="day-name">${isToday ? 'BU GÜN' : days[d.getDay()].toUpperCase()}</span>
                            <span class="date-num">${d.getDate()} ${months[d.getMonth()]}</span>
                        </div>
                    `;
                    
                    if (isToday) {
                        html += `
                            <div class="date-tab live-tab ${isLiveFiltered ? 'active' : ''}" id="filterLiveBtn" onclick="toggleLiveFilter(this)">
                                <span class="day-name">CANLI</span>
                                <span class="date-num">LIVE</span>
                            </div>
                        `;
                    }
                }
                container.innerHTML = html;
            }

            window.selectDate = function(dateStr, el) {
                isLiveFiltered = false;
                selectedDate = dateStr;
                document.querySelectorAll('.date-tab').forEach(t => t.classList.remove('active'));
                if (el) el.classList.add('active');
                fetchData(dateStr);
            };

            window.toggleLiveFilter = function(el) {
                isLiveFiltered = true;
                selectedDate = null;
                document.querySelectorAll('.date-tab').forEach(t => t.classList.remove('active'));
                if (el) el.classList.add('active');
                fetchData('live');
            };

            /* Notification System */
            class NotificationManager {
                constructor() {
                    this.history = JSON.parse(localStorage.getItem('notifHistory') || '[]');
                    this.lastEventState = new Map();
                    this.unreadCount = 0;
                    this.audio = new Audio(userSettings.notifSound || 'https://assets.mixkit.co/active_storage/sfx/2869/2869-preview.mp3');
                }

                init() {
                    this.renderHistory();
                    this.updateBadge();
                    if (userSettings.browserNotifEnabled) {
                        this.requestPermission();
                    }

                    // PWA Message Listener
                    if ('serviceWorker' in navigator) {
                        navigator.serviceWorker.addEventListener('message', (event) => {
                            if (event.data.type === 'openMatch') {
                                openMatchById(event.data.matchId);
                            }
                        });
                    }
                }

                playTestSound() {
                    const tempAudio = new Audio(document.getElementById('soundSelect').value);
                    tempAudio.play().catch(e => console.log("Blocked"));
                }

                requestPermission() {
                    if (!("Notification" in window)) return;
                    if (Notification.permission !== "granted" && Notification.permission !== "denied") {
                        Notification.requestPermission();
                    }
                }

                checkUpdates(newEvents) {
                    if (this.lastEventState.size === 0) {
                        newEvents.forEach(ev => {
                            this.lastEventState.set(ev.id, { h: ev.homeScore.current, a: ev.awayScore.current, status: ev.status.type });
                        });
                        return;
                    }

                    const favoritesOnly = userSettings.onlyFavNotif;

                    newEvents.forEach(ev => {
                        const prev = this.lastEventState.get(ev.id);
                        if (prev) {
                            // Filter match
                            const isMatchFav = favMatches.some(f => f.id.toString() === ev.id.toString());
                            const isLeagueFav = favLeagues.some(f => f.id.toString() === (ev.tournament.uniqueTournament?.id || ev.tournament.id).toString());

                            if (favoritesOnly && !isMatchFav && !isLeagueFav) {
                                this.lastEventState.set(ev.id, { h: ev.homeScore.current, a: ev.awayScore.current, status: ev.status.type });
                                return;
                            }

                            // Check for GOAL
                            if (ev.homeScore.current > prev.h || ev.awayScore.current > prev.a) {
                                const scorer = ev.homeScore.current > prev.h ? ev.homeTeam.name : ev.awayTeam.name;
                                this.addNotification('goal', 'QOOL!', `${scorer} qol vurdu! (${ev.homeTeam.name} ${ev.homeScore.current} - ${ev.awayScore.current} ${ev.awayTeam.name})`, ev.id);
                            }
                            // Check for Match Start
                            else if (prev.status === 'notstarted' && ev.status.type === 'inprogress') {
                                this.addNotification('start', 'Oyun Başladı', `${ev.homeTeam.name} - ${ev.awayTeam.name} oyunu başladı!`, ev.id);
                            }
                        }
                        this.lastEventState.set(ev.id, { h: ev.homeScore.current, a: ev.awayScore.current, status: ev.status.type });
                    });
                }

                addNotification(type, title, body, matchId) {
                    const notif = {
                        id: Date.now(),
                        type,
                        title,
                        body,
                        matchId,
                        time: new Date().toLocaleTimeString('az-AZ', { hour: '2-digit', minute: '2-digit' }),
                        unread: true
                    };

                    this.history.unshift(notif);
                    if (this.history.length > 50) this.history.pop();
                    localStorage.setItem('notifHistory', JSON.stringify(this.history));

                    this.unreadCount++;
                    this.updateBadge();

                    if (document.getElementById('notificationsView').classList.contains('active')) {
                        this.renderHistory();
                    }

                    // Browser notification
                    if (userSettings.browserNotifEnabled && Notification.permission === "granted") {
                        const n = new Notification(title, {
                            body: body,
                            icon: 'https://www.sofascore.com/favicon.ico',
                            data: { matchId: matchId }
                        });
                        n.onclick = (e) => {
                            window.focus();
                            openMatchById(matchId);
                            n.close();
                        };
                    }

                    // Sound
                    if (userSettings.soundEnabled && type === 'goal') {
                        this.audio.src = userSettings.notifSound || 'https://assets.mixkit.co/active_storage/sfx/2869/2869-preview.mp3';
                        this.audio.play().catch(e => console.log("Audio play blocked"));
                    }

                    // Toast
                    showToast(`${title}: ${body}`);
                }

                renderHistory() {
                    const container = document.getElementById('notificationsContent');
                    if (this.history.length === 0) {
                        container.innerHTML = `
                    <div class="empty-state">
                        <div class="empty-state-icon">🔔</div>
                        <div class="empty-state-title">Bildiriş yoxdur</div>
                        <div class="empty-state-text">Qollar və digər önəmli hadisələr burada görünəcək.</div>
                    </div>`;
                        return;
                    }

                    let html = `
                <div class="notif-header-actions">
                    <span style="font-weight:800; opacity:0.6;">SON HADİSƏLƏR</span>
                    <div class="clear-all-btn" onclick="notificationMgr.clearAllHistory()">🗑️ HAMSINI SİL</div>
                </div>
            `;

                    html += this.history.map(n => `
                <div class="notification-item ${n.unread ? 'unread' : ''}" onclick="openMatchById('${n.matchId}'); notificationMgr.markRead(${n.id})">
                    <div class="notification-icon-box">
                        ${n.type === 'goal' ? '⚽' : '📢'}
                    </div>
                    <div class="notification-info">
                        <span class="notification-title">${n.title}</span>
                        <span class="notification-body">${n.body}</span>
                        <span class="notification-time">${n.time}</span>
                    </div>
                    <div style="font-size:18px; cursor:pointer; padding:10px;" onclick="event.stopPropagation(); notificationMgr.deleteNotification(${n.id})">✕</div>
                </div>
            `).join('');

                    container.innerHTML = html;
                }

                markRead(id) {
                    const notif = this.history.find(n => n.id === id);
                    if (notif && notif.unread) {
                        notif.unread = false;
                        this.unreadCount = Math.max(0, this.unreadCount - 1);
                        localStorage.setItem('notifHistory', JSON.stringify(this.history));
                        this.updateBadge();
                        this.renderHistory();
                    }
                }

                deleteNotification(id) {
                    this.history = this.history.filter(n => n.id !== id);
                    localStorage.setItem('notifHistory', JSON.stringify(this.history));
                    this.unreadCount = this.history.filter(n => n.unread).length;
                    this.updateBadge();
                    this.renderHistory();
                }

                clearAllHistory() {
                    if (confirm('Bütün bildiriş tarixçəsini silmək istəyirsiniz?')) {
                        this.history = [];
                        this.unreadCount = 0;
                        localStorage.setItem('notifHistory', JSON.stringify(this.history));
                        this.updateBadge();
                        this.renderHistory();
                    }
                }

                markAllAsRead() {
                    this.history.forEach(n => n.unread = false);
                    this.unreadCount = 0;
                    localStorage.setItem('notifHistory', JSON.stringify(this.history));
                    this.updateBadge();
                    this.renderHistory();
                }

                updateBadge() {
                    const badge = document.getElementById('notifBadge');
                    if (this.unreadCount > 0) {
                        badge.classList.add('active');
                    } else {
                        badge.classList.remove('active');
                    }
                }
            }

            const notificationMgr = new NotificationManager();

            /* View Route Logic */
            let currentStandingsTourId = null;
            let standingsTimeout = null;

            function switchMainView(viewType) {
                currentStandingsTourId = null;
                document.querySelectorAll('.container').forEach(c => c.classList.remove('active'));
                document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

                const mc = document.querySelector('.main-content');
                if (viewType === 'matches') {
                    document.getElementById('matchView').classList.add('active');
                    document.getElementById('navMatches').classList.add('active');
                    document.getElementById('dateTabsContainer').style.display = 'flex';
                    document.getElementById('logoTitle').innerText = 'RABONA MEDIA';
                    hideBackBtn();
                    mc.style.paddingTop = '130px';
                }
                else if (viewType === 'leagues') {
                    document.getElementById('leaguesView').classList.add('active');
                    document.getElementById('navLeagues').classList.add('active');
                    document.getElementById('dateTabsContainer').style.display = 'none';
                    document.getElementById('logoTitle').innerText = 'LİQALAR';
                    hideBackBtn();
                    mc.style.paddingTop = '80px';
                    renderLeaguesView();
                }
                else if (viewType === 'favorites') {
                    document.getElementById('favoritesView').classList.add('active');
                    document.getElementById('navFavorites').classList.add('active');
                    document.getElementById('dateTabsContainer').style.display = 'none';
                    document.getElementById('logoTitle').innerText = 'FAVORİTLƏR';
                    hideBackBtn();
                    mc.style.paddingTop = '80px';
                    renderFavoritesView();
                }
                else if (viewType === 'profile') {
                    const token = localStorage.getItem('proscore_token');
                    if (!token) {
                        showToast('Profil üçün daxil olun');
                        switchMainView('auth');
                        return;
                    }
                    userHasNavigated = true;
                    if (authTimer) clearTimeout(authTimer);

                    document.getElementById('profileView').classList.add('active');
                    document.getElementById('navProfile').classList.add('active');
                    document.getElementById('dateTabsContainer').style.display = 'none';
                    document.getElementById('logoTitle').innerText = 'PROFİL';
                    hideBackBtn();
                    mc.style.paddingTop = '80px';
                    loadProfile();
                }
                else if (viewType === 'auth') {
                    userHasNavigated = true;
                    if (authTimer) clearTimeout(authTimer);
                    document.getElementById('authView').classList.add('active');
                    document.getElementById('navProfile').classList.add('active');
                    document.getElementById('dateTabsContainer').style.display = 'none';
                    document.getElementById('logoTitle').innerText = 'QEYDİYYAT';
                    hideBackBtn();
                    mc.style.paddingTop = '80px';
                }
                else if (viewType === 'notifications') {
                    document.getElementById('notificationsView').classList.add('active');
                    document.getElementById('navLeagues').classList.remove('active'); // Reset other navs
                    document.getElementById('dateTabsContainer').style.display = 'none';
                    document.getElementById('logoTitle').innerText = 'BİLDİRİŞLƏR';
                    showBackBtn();
                    notificationMgr.renderHistory();
                    notificationMgr.markAllAsRead();
                    mc.style.paddingTop = '60px';
                }
                mc.scrollTo({ top: 0, behavior: 'auto' });
            }

            async function openSingleLeague(keyId, manualId = null) {
                let group = manualId ? null : groupedDataGlobal[keyId];

                if (!group && manualId) {
                    // For categories that were opened manually
                    group = { id: manualId, name: keyId, country: "Liqa", matches: [], seasonId: null };
                    // We need more info for logos
                    const cInfo = await fetch(`/api/tournament/${manualId}/seasons`);
                    const cData = await cInfo.json();
                    group.seasonId = cData.seasons && cData.seasons[0] ? cData.seasons[0].id : null;
                }

                if (!group) return;

                document.querySelectorAll('.container').forEach(c => c.classList.remove('active'));
                document.getElementById('dateTabsContainer').style.display = 'none';

                const singleView = document.getElementById('singleLeagueView');
                singleView.classList.add('active');
                document.querySelector('.main-content').style.paddingTop = '70px';

                document.getElementById('logoTitle').innerText = group.name.toUpperCase();
                showBackBtn();

                if (!group.seasonId) {
                    const sResp = await fetch(`/api/tournament/${group.id}/seasons`);
                    const sData = await sResp.json();
                    group.seasonId = sData.seasons && sData.seasons[0] ? sData.seasons[0].id : null;
                }

                const { logoUrl, fallBack } = getLeagueLogoData(group);
                const hasMatches = group.matches && group.matches.length > 0;
                const matchesHtml = hasMatches
                    ? group.matches.map(m => createMatchRow(m, group)).join("")
                    : `<div style="text-align:center; padding:40px; color:var(--text-muted); font-weight:600;">Bu gün üçün oyun tapılmadı. <br><span style="font-size:12px; font-weight:400; opacity:0.7;">Cədvələ (Puan Durumu) keçid edərək xal durumuna baxa bilərsiniz.</span></div>`;

                const html = `
            <div class="league-group" style="margin-top:20px; border-radius: 12px 12px 0 0; border-bottom: none;">
                <div class="league-header" style="justify-content:center; flex-direction:column; padding:24px; background: transparent; border:none; pointer-events:none;">
                    <img src="${logoUrl}" style="width:70px; height:70px; border-radius:12px; box-shadow:0 4px 15px rgba(0,0,0,0.5)" onerror="this.src='${fallBack}'; this.onerror=function(){this.src='data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0iIzFmMjkzZCI+PHJlY3Qgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiByeD0iNCIvPjwvc3ZnPg=='}">
                    <div style="font-size:22px; font-weight:900; margin-top:16px; text-align:center; width:100%; display:-webkit-box; -webkit-line-clamp:2; line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; word-wrap:break-word;">${group.name}</div>
                    <div style="font-size:14px; font-weight:600; color:var(--text-muted); text-transform:uppercase; letter-spacing:1px; margin-top:4px; max-width:100%; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${group.country}</div>
                </div>
                
                <div class="modal-tabs" style="background:var(--card); border-bottom:1px solid rgba(255,255,255,0.05); border-top:1px solid rgba(255,255,255,0.05); position:relative; z-index:1;">
                    <button class="tab-btn ${hasMatches ? 'active' : ''}" onclick="switchLeagueTab('leagueMatches', this)">OYUNLAR</button>
                    <button class="tab-btn ${!hasMatches ? 'active' : ''}" onclick="switchLeagueTab('leagueStandings', this)">CƏDVƏL</button>
                    <button class="tab-btn" onclick="switchLeagueTab('leagueTopPlayers', this)">BOMBARDİRLƏR</button>
                </div>
                
                <div class="league-tab-content ${hasMatches ? 'active' : ''}" id="leagueMatches" style="${!hasMatches ? 'display:none;' : ''}">
                    ${matchesHtml}
                </div>
                <div class="league-tab-content ${!hasMatches ? 'active' : ''}" id="leagueStandings" style="${hasMatches ? 'display:none;' : ''} padding:16px 0;">
                    <div class="loader-wrapper"><div class="skel-row"><div class="skel-teams"><div class="skel-team skeleton"></div></div></div></div>
                </div>
                <div class="league-tab-content" id="leagueTopPlayers" style="display:none; padding:16px 0;">
                    <div class="loader-wrapper"><div class="skel-row"><div class="skel-teams"><div class="skel-team skeleton"></div></div></div></div>
                </div>
            </div>
        `;
                document.getElementById('singleLeagueContent').innerHTML = html;
                window.scrollTo({ top: 0 });

                loadStandings(group.id, group.seasonId);
                loadTopPlayers(group.id, group.seasonId);
            }
            window.switchLeagueTab = function (tabId, btn) {
                document.querySelectorAll('.league-tab-content').forEach(c => c.style.display = 'none');
                btn.parentElement.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
                document.getElementById(tabId).style.display = 'block';
                btn.classList.add('active');
            };

            async function fetchNativeStandings(tourId, seasonId) {
                if (currentStandingsTourId !== tourId) return;

                try {
                    const res = await fetch(`/api/standings/${tourId}/${seasonId}`);
                    const data = await res.json();

                    if (data && data.standings && data.standings.length > 0) {
                        const sData = data.standings[0];
                        const rows = sData.rows || [];

                        let tableHtml = `
                <div style="background:var(--card); border-radius:12px; margin-top:10px; padding:0; overflow-x:auto;">
                    <table class="standings-table">
                        <thead>
                            <tr>
                                <th style="width: 30px;">#</th>
                                <th>KOMANDA</th>
                                <th>O</th>
                                <th>Q</th>
                                <th>H</th>
                                <th>M</th>
                                <th>QOL</th>
                                <th>X</th>
                                <th>FORMA</th>
                            </tr>
                        </thead>
                        <tbody>
                `;

                        rows.forEach(row => {
                            let formHtml = '';
                            if (row.form && row.form.length > 0) {
                                formHtml = `<div style="display:flex; gap:3px; justify-content:center;">`;
                                row.form.slice(0, 5).forEach(f => {
                                    let color = f === 'W' ? '#16a34a' : (f === 'D' ? '#fbbf24' : '#dc2626');
                                    let textCol = f === 'W' ? '#FFF' : (f === 'D' ? '#000' : '#FFF');
                                    let ftext = f === 'W' ? 'Q' : (f === 'D' ? 'H' : 'M');
                                    formHtml += `<span style="display:inline-flex; align-items:center; justify-content:center; width:18px; height:18px; border-radius:5px; font-size:10px; font-weight:700; background:${color}; color:${textCol}; box-shadow: 0 2px 6px rgba(0,0,0,0.3); border: 1px solid rgba(0,0,0,0.2);">${ftext}</span>`;
                                });
                                formHtml += `</div>`;
                            }

                            tableHtml += `
                        <tr style="transition: background 0.2s;" onmouseover="this.style.background='rgba(255,255,255,0.03)'" onmouseout="this.style.background='transparent'">
                            <td style="font-weight:700; color:var(--text-muted);">${row.position}</td>
                            <td class="team-cell">
                                <img class="team-logo" src="https://www.sofascore.com/api/v1/team/${row.team.id}/image" onerror="this.src='data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSI+PGNpcmNsZSBjeD0iMTIiIGN5PSIxMiIgcj0iMTEiIGZpbGw9IiMxZjI5M2QiLz48L3N2Zz4='">
                                <span>${row.team.name}</span>
                            </td>
                            <td>${row.matches}</td>
                            <td>${row.wins}</td>
                            <td>${row.draws}</td>
                            <td>${row.losses}</td>
                            <td>${row.scoresFor}:${row.scoresAgainst}</td>
                            <td class="pts">${row.points}</td>
                            <td>${formHtml}</td>
                        </tr>
                    `;
                        });

                        tableHtml += `</tbody></table></div>`;

                        const box = document.getElementById('leagueStandings');
                        if (currentStandingsTourId === tourId) {
                            box.innerHTML = tableHtml;
                        }
                    } else {
                        if (currentStandingsTourId === tourId && document.getElementById('leagueStandings').innerHTML.includes('skeleton')) {
                            document.getElementById('leagueStandings').innerHTML = "<div class='loader-wrapper' style='text-align:center; padding:40px; color:var(--text-muted); font-weight:600;'>Cədvəl məlumatı yoxdur.</div>";
                        }
                    }
                } catch (e) {
                    console.error("Standings fetch error: ", e);
                }

                if (currentStandingsTourId === tourId) {
                    clearTimeout(standingsTimeout);
                    standingsTimeout = setTimeout(() => fetchNativeStandings(tourId, seasonId), 30000);
                }
            }

            async function loadTopPlayers(tourId, seasonId) {
                if (!tourId || !seasonId) return;
                try {
                    const res = await fetch(`/api/tournament/${tourId}/season/${seasonId}/top-players`);
                    const data = await res.json();
                    const box = document.getElementById("leagueTopPlayers");

                    if (data.topPlayers && data.topPlayers.length > 0) {
                        let html = '<div class="top-players-list">';
                        data.topPlayers.slice(0, 15).forEach((p, index) => {
                            html += `
                        <div class="player-row">
                            <span class="player-rank">${index + 1}</span>
                            <img class="player-img" src="https://www.sofascore.com/api/v1/player/${p.player.id}/image" onerror="this.src='data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSI+PGNpcmNsZSBjeD0iMTIiIGN5PSIxMiIgcj0iMTEiIGZpbGw9IiMxZjI5M2QiLz48L3N2Zz4='">
                            <div class="player-info">
                                <span class="player-name">${p.player.name}</span>
                                <span class="player-team">${p.team.name}</span>
                            </div>
                            <span class="player-goals">${p.statistics.goals} Qol</span>
                        </div>
                    `;
                        });
                        html += '</div>';
                        box.innerHTML = html;
                    } else {
                        box.innerHTML = "<div style='text-align:center; padding:40px; color:var(--text-muted); font-weight:600;'>Məlumat tapılmadı.</div>";
                    }
                } catch (e) {
                    console.error("Top players load error", e);
                }
            }

            function loadStandings(tourId, seasonId) {
                currentStandingsTourId = tourId;
                const box = document.getElementById('leagueStandings');
                if (!seasonId || !tourId) {
                    box.innerHTML = "<div class='loader-wrapper' style='text-align:center; padding:40px; color:var(--text-muted); font-weight:600;'>Cədvəl sistemi mövcud deyil.</div>";
                    return;
                }

                box.innerHTML = `<div class="loader-wrapper"><div class="skel-row"><div class="skel-teams"><div class="skel-team skeleton" style="width:100%;"></div></div></div><div class="skel-row"><div class="skel-teams"><div class="skel-team skeleton" style="width:70%;"></div></div></div><div class="skel-row"><div class="skel-teams"><div class="skel-team skeleton" style="width:90%;"></div></div></div></div>`;

                fetchNativeStandings(tourId, seasonId);
            }


            function showBackBtn() {
                document.getElementById('backBtn').style.display = 'block';
                document.getElementById('menuBtn').style.display = 'none';
            }

            function hideBackBtn() {
                document.getElementById('backBtn').style.display = 'none';
                document.getElementById('menuBtn').style.display = 'block';
            }

            function goBack() { switchMainView('leagues'); }

            window.toggleCollapsible = function (headerElement) {
                const matchesContainer = headerElement.nextElementSibling;
                const chevron = headerElement.querySelector('.chevron');
                if (matchesContainer) {
                    matchesContainer.classList.toggle('collapsed');
                    chevron.classList.toggle('down');
                }
            };

            function getMatchTime(m) {
                if (m.status && m.status.type === 'inprogress' && m.time && m.time.currentPeriodStartTimestamp) {
                    const now = Math.floor(Date.now() / 1000);
                    let elapsed = now - m.time.currentPeriodStartTimestamp;
                    let totalSeconds = elapsed;
                    if (m.time.initial) totalSeconds += m.time.initial;
                    if (totalSeconds < 0) totalSeconds = 0;
                    let min = Math.floor(totalSeconds / 60) + 1;
                    return min + "'";
                }
                let desc = (m.status && m.status.description) ? m.status.description : "";
                let uc = desc.toUpperCase();
                if (uc === 'HALFTIME' || uc === 'HALF TIME') return 'HT';
                if (uc === 'ENDED') return 'FT';
                return desc;
            }

            function applyFilters() {
                console.log("Applying filters... allEvents count:", allEvents.length);
                let listRaw = allEvents;
                if (isLiveFiltered) {
                    listRaw = allEvents.filter(m => m.status.type === 'inprogress' || m.status.description.toUpperCase() === 'HT' || m.status.description.toUpperCase() === 'ET' || m.status.description.includes("'"));
                } else if (selectedDate) {
                    listRaw = allEvents.filter(m => {
                        if (!m.startTimestamp) return false;
                        try {
                            const eventDate = new Date(m.startTimestamp * 1000).toISOString().split('T')[0];
                            return eventDate === selectedDate;
                        } catch (e) {
                            return false;
                        }
                    });
                }

                groupedDataGlobal = listRaw.reduce((acc, ev) => {
                    if (!ev.tournament || !ev.tournament.name) return acc;
                    const catName = (ev.tournament.category && ev.tournament.category.name) ? ev.tournament.category.name : "Other";
                    const groupKey = `${ev.tournament.name}_${catName}`;
                    
                    if (!acc[groupKey]) {
                        const isUnique = !!ev.tournament.uniqueTournament;
                        const tourId = isUnique ? ev.tournament.uniqueTournament.id : ev.tournament.id;
                        const catId = (ev.tournament.category && ev.tournament.category.id) ? ev.tournament.category.id : 0;
                        const seasonId = ev.season ? ev.season.id : null;
                        acc[groupKey] = {
                            key: groupKey, id: tourId, isUnique, catId,
                            name: ev.tournament.name, country: catName,
                            seasonId, matches: [], hasLive: false
                        };
                    }
                    acc[groupKey].matches.push(ev);
                    if (ev.status && ev.status.type === 'inprogress') acc[groupKey].hasLive = true;
                    return acc;
                }, {});

                topLeaguesRaw.forEach(t => {
                    if (!t || !t.name || !t.category) return;
                    const groupKey = `${t.name}_${t.category.name}`;
                    if (!groupedDataGlobal[groupKey]) {
                        groupedDataGlobal[groupKey] = {
                            key: groupKey, id: t.id, isUnique: true, catId: t.category.id,
                            name: t.name, country: t.category.name,
                            seasonId: null, matches: [], hasLive: false
                        };
                    }
                });

                renderMatchView(groupedDataGlobal);
                if (document.getElementById('leaguesView').classList.contains('active')) renderLeaguesView();
            }

            async function fetchData(param = null) {
                let url = '/api/matches/live';
                
                if (param === 'live' || isLiveFiltered) {
                    url = '/api/matches/live';
                } else {
                    const dateToFetch = param || selectedDate || new Date().toISOString().split('T')[0];
                    url = `/api/matches/${dateToFetch}`;
                }

                console.log("Fetching data from:", url);
                
                try {
                    console.log("Fetching matches from:", url);
                    const resEvents = await fetch(url);
                    if (!resEvents.ok) throw new Error(`HTTP error! status: ${resEvents.status}`);
                    const dataEvents = await resEvents.json();
                    
                    if (dataEvents && dataEvents.events) {
                        allEvents = dataEvents.events;
                        console.log(`Successfully loaded ${allEvents.length} events.`);
                    } else if (Array.isArray(dataEvents)) {
                        allEvents = dataEvents;
                        console.log(`Successfully loaded ${allEvents.length} events from array.`);
                    } else {
                        allEvents = [];
                        console.log("No events found in response data.");
                    }

                    if (window.notificationMgr) {
                        notificationMgr.checkUpdates(allEvents);
                    }

                    applyFilters();
                } catch (e) {
                    console.error("Matches fetch error:", e);
                    // Silently fail but keep current state or show error in UI
                }

                // Fetch Local Config (Top Leagues & Categories)
                if (topLeaguesRaw.length === 0) {
                    try {
                        const [resTop, resCats] = await Promise.all([
                            fetch('/api/top-leagues').catch(() => null),
                            fetch('/api/categories').catch(() => null)
                        ]);

                        if (resTop && resTop.ok) topLeaguesRaw = (await resTop.json()).data || [];
                        if (resCats && resCats.ok) allCategoriesGlobal = (await resCats.json()).data || [];

                        if (document.getElementById('leaguesView').classList.contains('active')) {
                            renderLeaguesView();
                        }
                    } catch (e) {
                        console.log("Local API is unreachable, some features may be disabled.");
                    }
                }
            }

            function createMatchRow(m, group) {
                const timeRaw = getMatchTime(m);
                const isLive = m.status.type === 'inprogress' || timeRaw === 'HT' || timeRaw === 'ET' || timeRaw === 'LIVE';

                let displayTime = timeRaw;
                const timeClass = isLive ? 'match-time is-live' : 'match-time';
                const formattedMinute = isLive ? `<span class="live-min">${displayTime}</span>` : displayTime;

                const safeTimeRaw = timeRaw.replace(/'/g, "\\'");
                const safeHomeName = m.homeTeam.name.replace(/'/g, "\\'");
                const safeAwayName = m.awayTeam.name.replace(/'/g, "\\'");
                const safeGroupName = group.name.replace(/'/g, "\\'");

                const isFav = favMatches.some(f => f.id.toString() === m.id.toString());

                return `
        <div class="match-row">
            <div class="${timeClass}" onclick="openMatch('${m.id}', '${m.homeTeam.id}', '${m.awayTeam.id}', '${safeHomeName}', '${safeAwayName}', '${m.homeScore.current}', '${m.awayScore.current}', '${safeTimeRaw}', '${safeGroupName}')">${formattedMinute}</div>
            <div class="match-teams" onclick="openMatch('${m.id}', '${m.homeTeam.id}', '${m.awayTeam.id}', '${safeHomeName}', '${safeAwayName}', '${m.homeScore.current}', '${m.awayScore.current}', '${safeTimeRaw}', '${safeGroupName}')">
                <div class="team-line">
                    <img class="team-logo" src="https://www.sofascore.com/api/v1/team/${m.homeTeam.id}/image" onerror="this.src='data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSI+PGNpcmNsZSBjeD0iMTIiIGN5PSIxMiIgcj0iMTEiIGZpbGw9IiMxZjI5M2QiLz48L3N2Zz4='"> 
                    <span class="team-name">${m.homeTeam.name}</span>
                </div>
                <div class="team-line">
                    <img class="team-logo" src="https://www.sofascore.com/api/v1/team/${m.awayTeam.id}/image" onerror="this.src='data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSI+PGNpcmNsZSBjeD0iMTIiIGN5PSIxMiIgcj0iMTEiIGZpbGw9IiMxZjI5M2QiLz48L3N2Zz4='"> 
                    <span class="team-name">${m.awayTeam.name}</span>
                </div>
            </div>
            <div class="match-scores" onclick="openMatch('${m.id}', '${m.homeTeam.id}', '${m.awayTeam.id}', '${safeHomeName}', '${safeAwayName}', '${m.homeScore.current}', '${m.awayScore.current}', '${safeTimeRaw}', '${safeGroupName}')">
                <span class="score-val ${isLive ? 'is-live' : ''}">${m.homeScore.current}</span>
                <span class="score-val ${isLive ? 'is-live' : ''}">${m.awayScore.current}</span>
            </div>
            <div class="fav-star ${isFav ? 'active' : ''}" onclick="toggleFavoriteMatch('${m.id}', this)">${isFav ? '★' : '☆'}</div>
        </div>`;
            }

            function getLeagueLogoData(group) {
                const type = group.isUnique ? 'unique-tournament' : 'tournament';
                const logoUrl = `https://www.sofascore.com/api/v1/${type}/${group.id}/image`;
                const fallBack = `https://www.sofascore.com/api/v1/category/${group.catId}/image`;
                return { logoUrl, fallBack };
            }

            function renderMatchView(grouped) {
                const list = document.getElementById("matchList");
                const keys = Object.keys(grouped).filter(k => grouped[k].matches.length > 0);

                if (keys.length === 0) {
                    list.innerHTML = "<div class='loader-wrapper' style='text-align:center; padding:50px; font-weight:600;'>Heç bir oyun tapılmadı.</div>";
                    return;
                }

                let html = "";
                for (const key of keys) {
                    const group = grouped[key];
                    const isFav = favLeagues.some(f => f.id.toString() === group.id.toString());
                    const { logoUrl, fallBack } = getLeagueLogoData(group);

                    html += `
                <div class="league-group">
                    <div class="league-header">
                        <div style="display:flex; align-items:center; gap:12px; flex:1; min-width:0;" onclick="toggleCollapsible(this.parentElement)">
                            <img src="${logoUrl}" onerror="this.src='${fallBack}'; this.onerror=function(){this.src='data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0iIzFmMjkzZCI+PHJlY3Qgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiByeD0iNCIvPjwvc3ZnPg=='}">
                            <div class="league-title-box">
                                <span class="league-country">${group.country}</span>
                                <span class="league-title">${group.name}</span>
                            </div>
                        </div>
                        <div class="fav-star ${isFav ? 'active' : ''}" style="margin-right:15px;" onclick="toggleFavoriteLeague('${group.id}', '${group.name.replace(/'/g, "\\'")}', '${group.country.replace(/'/g, "\\'")}', this)">${isFav ? '★' : '☆'}</div>
                        <span class="chevron" onclick="toggleCollapsible(this.parentElement)">▼</span>
                    </div>
                    <div class="league-matches">
                        ${group.matches.map(m => createMatchRow(m, group)).join("")}
                    </div>
                </div>`;
                }
                list.innerHTML = html;
            }

            async function toggleCategory(catId, catName, element) {
                if (expandedCategories.has(catId)) {
                    expandedCategories.delete(catId);
                    const container = document.getElementById(`cat-leagues-${catId}`);
                    if (container) container.remove();
                    return;
                }

                expandedCategories.add(catId);
                const leagueContainer = document.createElement('div');
                leagueContainer.id = `cat-leagues-${catId}`;
                leagueContainer.innerHTML = `<div style="padding:15px; text-align:center;"><div class="skeleton" style="height:20px; width:40%; margin:auto;"></div></div>`;
                element.after(leagueContainer);

                try {
                    const res = await fetch(`/api/category/${catId}/tournaments`);
                    const data = await res.json();
                    const leagues = data.uniqueTournaments || [];

                    if (leagues.length === 0) {
                        leagueContainer.innerHTML = `<div style="padding:15px; color:var(--text-muted); text-align:center; font-size:12px;">Bu ölkə üçün aktiv liqa tapılmadı.</div>`;
                        return;
                    }

                    leagueContainer.innerHTML = leagues.map(l => `
                <div class="league-sub-row" onclick="openSingleLeague('${l.name.replace(/'/g, "\\'")}', '${l.id}')">
                    <img class="league-sub-logo" src="https://www.sofascore.com/api/v1/unique-tournament/${l.id}/image" onerror="this.src='data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0iIzFmMjkzZCI+PHJlY3Qgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiByeD0iNCIvPjwvc3ZnPg=='">
                    <span class="league-sub-name">${l.name}</span>
                </div>
            `).join("");
                } catch (e) {
                    leagueContainer.innerHTML = `<div style="padding:15px; color:var(--live); text-align:center; font-size:12px;">Xəta baş verdi.</div>`;
                }
            }

            function renderLeaguesView() {
                const list = document.getElementById("leaguesList");
                const searchTerm = (document.getElementById("leagueSearchTerm") ? document.getElementById("leagueSearchTerm").value : "").toLowerCase();

                let html = "";

                // Popular (Top Leagues)
                const popularMatches = Object.keys(groupedDataGlobal).filter(k =>
                    (k.toLowerCase().includes(searchTerm) || groupedDataGlobal[k].country.toLowerCase().includes(searchTerm))
                );

                if (popularMatches.length > 0) {
                    html += `<div class="category-header"><span>Populyar Liqalar</span> <span class="category-count">${popularMatches.length}</span></div>`;
                    popularMatches.forEach(key => {
                        const group = groupedDataGlobal[key];
                        const escapedKey = key.replace(/'/g, "\\'");
                        const { logoUrl, fallBack } = getLeagueLogoData(group);
                        const isFav = favLeagues.some(f => f.id.toString() === group.id.toString());

                        html += `
                <div class="league-card">
                    <div style="display:flex; align-items:center; gap:16px; flex:1; min-width:0;" onclick="openSingleLeague('${escapedKey}')">
                        <img class="league-card-logo" src="${logoUrl}" onerror="this.src='${fallBack}'; this.onerror=function(){this.src='data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0iIzFmMjkzZCI+PHJlY3Qgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiByeD0iNCIvPjwvc3ZnPg=='}">
                        <div class="league-card-info">
                            <span class="league-card-country">${group.country}</span>
                            <span class="league-card-name">${group.name}</span>
                        </div>
                        ${group.hasLive ? '<span class="live-badge">LIVE</span>' : ''}
                    </div>
                    <div class="fav-star ${isFav ? 'active' : ''}" onclick="toggleFavoriteLeague('${group.id}', '${group.name.replace(/'/g, "\\'")}', '${group.country.replace(/'/g, "\\'")}', this)">${isFav ? '★' : '☆'}</div>
                </div>`;
                    });
                }

                // Browse Categories (Countries)
                let filteredCats = allCategoriesGlobal;
                if (searchTerm) {
                    filteredCats = allCategoriesGlobal.filter(c => c.name.toLowerCase().includes(searchTerm));
                }

                if (filteredCats.length > 0) {
                    html += `<div class="category-header"><span>Ölkələr (${filteredCats.length})</span></div>`;
                    filteredCats.forEach(cat => {
                        html += `
                    <div class="category-row" onclick="toggleCategory('${cat.id}', '${cat.name.replace(/'/g, "\\'")}', this)">
                        <img class="category-flag" src="https://www.sofascore.com/api/v1/category/${cat.id}/image" onerror="this.src='data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0iIzFmMjkzZCI+PHJlY3Qgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiByeD0iNCIvPjwvc3ZnPg=='">
                        <span class="category-name">${cat.name}</span>
                        <span style="opacity:0.4; font-size:10px;">▼</span>
                    </div>
                `;
                    });
                }

                if (!html) {
                    list.innerHTML = "<div class='loader-wrapper' style='text-align:center; padding:50px; font-weight:600;'>Məlumat tapılmadı.</div>";
                    return;
                }

                list.innerHTML = html;
            }

            /* Native Modal Logic */
            async function openMatch(id, idH, idA, nameH, nameA, sH, sA, timeRaw, league) {
                document.body.classList.add('modal-open');
                const modal = document.getElementById("detailsModal");
                modal.style.display = "flex";
                setTimeout(() => modal.classList.add("show"), 10);

                document.getElementById("logoH").src = `https://www.sofascore.com/api/v1/team/${idH}/image`;
                document.getElementById("logoA").src = `https://www.sofascore.com/api/v1/team/${idA}/image`;
                document.getElementById("nameH").innerText = nameH;
                document.getElementById("nameA").innerText = nameA;
                document.getElementById("scoreM").innerText = `${sH} - ${sA}`;

                const isLive = timeRaw.includes("'") || timeRaw === 'HT' || timeRaw === 'LIVE' || timeRaw === 'ET';
                const tb = document.getElementById("timeM");
                tb.innerHTML = timeRaw;
                if (isLive) tb.classList.add("is-live"); else tb.classList.remove("is-live");
                document.getElementById("leagueM").innerText = league;

                // Skeleton loaders inside modal
                const skelHtml = `<div class="loader-wrapper"><div class="skel-row"><div class="skel-time skeleton"></div><div class="skel-teams"><div class="skel-team skeleton"></div></div></div><div class="skel-row"><div class="skel-time skeleton"></div><div class="skel-teams"><div class="skel-team skeleton" style="width:60%"></div></div></div></div>`;
                document.getElementById("goalsBox").innerHTML = skelHtml;
                document.getElementById("statsBox").innerHTML = `<div class="loader-wrapper"><div class="skel-header skeleton" style="height:20px;width:30%;margin:auto;"></div><div class="skel-header skeleton" style="height:8px;margin-top:20px;"></div><div class="skel-header skeleton" style="height:8px;margin-top:20px;"></div></div>`;

                try {
                    const [resI, resS] = await Promise.all([
                        fetch(`/api/match/${id}/incidents`),
                        fetch(`/api/match/${id}/statistics`)
                    ]);
                    const dataI = await resI.json();
                    const dataS = await resS.json();

                    // Render Incidents
                    const incidents = (dataI.incidents || []).filter(i => ["goal", "card", "substitution"].includes(i.incidentType));
                    if (incidents.length) {
                        document.getElementById("goalsBox").innerHTML = incidents.map(g => {
                            const isHome = g.isHome;
                            let icon = g.incidentType === "goal" ? "⚽" : (g.incidentType === "card" ? (g.incidentClass === "yellow" ? "🟨" : "🟥") : "🔄");
                            let player = g.player ? g.player.name : "Oyunçu";
                            if (g.incidentType === "substitution") player = `${g.playerIn?.name || ''} ⬅️ ${g.playerOut?.name || ''}`;

                            return `
                    <div class="incident ${isHome ? 'inc-home' : 'inc-away'}">
                        <div class="inc-time">${g.time}'</div>
                        <div class="inc-icon">${icon}</div>
                        <div class="inc-detail">${player}</div>
                    </div>`;
                        }).join("");
                    } else {
                        document.getElementById("goalsBox").innerHTML = "<div class='loader-wrapper' style='text-align:center; padding:40px; color:var(--text-muted); font-weight:600;'>Hadisə tapılmadı</div>";
                    }

                    // Render Stats
                    const stats = dataS.statistics ? (dataS.statistics.find(s => s.period === "ALL") || dataS.statistics[0]) : null;
                    if (stats) {
                        let sHtml = "";
                        stats.groups.forEach(group => {
                            sHtml += `<div class="stat-group-title">${group.groupName}</div>`;
                            group.statisticsItems.forEach(st => {
                                const hV = parseFloat(st.homeValue) || 0;
                                const aV = parseFloat(st.awayValue) || 0;
                                const hP = (hV + aV) > 0 ? (hV / (hV + aV)) * 100 : 50;
                                sHtml += `
                            <div class="stat-box">
                                <div class="stat-labels"><span>${st.homeValue}</span><span>${st.name}</span><span>${st.awayValue}</span></div>
                                <div class="stat-bar-outer"><div class="bar-home" style="width:${hP}%"></div><div class="bar-away" style="width:${100 - hP}%"></div></div>
                            </div>`;
                            });
                        });
                        document.getElementById("statsBox").innerHTML = sHtml;
                    } else {
                        document.getElementById("statsBox").innerHTML = "<div class='loader-wrapper' style='text-align:center; padding:40px; color:var(--text-muted); font-weight:600;'>Statistika tapılmadı</div>";
                    }
                } catch (e) {
                    document.getElementById("goalsBox").innerHTML = "<div class='loader-wrapper' style='text-align:center; padding:40px; color:var(--text-muted); font-weight:600;'>Xəta baş verdi</div>";
                    document.getElementById("statsBox").innerHTML = "<div class='loader-wrapper' style='text-align:center; padding:40px; color:var(--text-muted); font-weight:600;'>Xəta baş verdi</div>";
                }
            }

            function openMatchById(id) {
                const match = allEvents.find(m => m.id.toString() === id.toString());
                if (match) {
                    const timeRaw = getMatchTime(match);
                    const safeHomeName = match.homeTeam.name.replace(/'/g, "\\'");
                    const safeAwayName = match.awayTeam.name.replace(/'/g, "\\'");
                    const safeGroupName = match.tournament.name.replace(/'/g, "\\'");
                    openMatch(match.id, match.homeTeam.id, match.awayTeam.id, safeHomeName, safeAwayName, match.homeScore.current, match.awayScore.current, timeRaw, safeGroupName);
                } else {
                    showToast("Oyun datası yenilənərkən tapılmadı.");
                }
            }

            function switchTab(tabId, btn) {
                document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
                btn.parentElement.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
                document.getElementById(tabId).classList.add('active');
                btn.classList.add('active');
            }

            function closeModal() {
                const modal = document.getElementById("detailsModal");
                modal.classList.remove("show");
                setTimeout(() => {
                    modal.style.display = "none";
                    document.body.classList.remove('modal-open');
                }, 300); // Wait for native transition
            }

            document.getElementById('detailsModal').addEventListener('click', function (e) {
                if (e.target === this || e.target.classList.contains('drag-handle') || e.target.id === 'dragHeader') closeModal();
            });

            document.getElementById('filterLiveBtn').addEventListener('click', function () {
                document.querySelectorAll('.date-tab').forEach(t => t.classList.remove('active'));
                this.classList.add('active');
                isLiveFiltered = true;
                applyFilters();
            });

            document.querySelectorAll('.date-tab:not(#filterLiveBtn)').forEach(tab => {
                tab.addEventListener('click', function () {
                    document.querySelectorAll('.date-tab').forEach(t => t.classList.remove('active'));
                    this.classList.add('active');
                    isLiveFiltered = false;
                    applyFilters();
                });
            });

            /* Favorites Logic */
            function toggleFavoriteMatch(id, btn) {
                event.stopPropagation();
                const idx = favMatches.findIndex(f => f.id.toString() === id.toString());
                if (idx === -1) {
                    const match = allEvents.find(m => m.id.toString() === id.toString());
                    if (match) {
                        favMatches.push(match);
                        btn.innerHTML = '★';
                        btn.classList.add('active');
                        showToast('Oyun favoritlərə əlavə edildi');
                    }
                } else {
                    favMatches.splice(idx, 1);
                    btn.innerHTML = '☆';
                    btn.classList.remove('active');
                    showToast('Oyun favoritlərdən çıxarıldı');
                }
                localStorage.setItem('favMatches', JSON.stringify(favMatches));
            }

            function toggleFavoriteLeague(id, name, country, btn) {
                event.stopPropagation();
                const idx = favLeagues.findIndex(f => f.id.toString() === id.toString());
                if (idx === -1) {
                    favLeagues.push({ id, name, country });
                    btn.innerHTML = '★';
                    btn.classList.add('active');
                    showToast('Liqa favoritlərə əlavə edildi');
                } else {
                    favLeagues.splice(idx, 1);
                    btn.innerHTML = '☆';
                    btn.classList.remove('active');
                    showToast('Liqa favoritlərdən çıxarıldı');
                }
                localStorage.setItem('favLeagues', JSON.stringify(favLeagues));
            }

            function renderFavoritesView() {
                const container = document.getElementById('favoritesContent');
                if (favMatches.length === 0 && favLeagues.length === 0) {
                    container.innerHTML = `
                <div class="empty-state">
                    <div class="empty-state-icon">⭐</div>
                    <div class="empty-state-title">Favoritləriniz yoxdur</div>
                    <div class="empty-state-text">Oyunları və ya liqaları favoritlərinizə əlavə edərək burada görə bilərsiniz.</div>
                </div>`;
                    return;
                }

                let html = "";

                if (favLeagues.length > 0) {
                    html += "<div style='padding: 24px 24px 10px; font-weight:700; color:var(--text-muted); font-size:13px; text-transform:uppercase;'>Favorit Liqalar</div>";
                    favLeagues.forEach(l => {
                        const groupKey = Object.keys(groupedDataGlobal).find(k => k.startsWith(l.name));
                        html += `
                    <div class="league-card">
                        <div style="display:flex; align-items:center; gap:16px; flex:1;" onclick="${groupKey ? `openSingleLeague('${groupKey.replace(/'/g, "\\'")}')` : `showToast('Liqa məlumatı tapılmadı')`}">
                            <img class="league-card-logo" src="https://www.sofascore.com/api/v1/tournament/${l.id}/image" onerror="this.src='data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0iIzFmMjkzZCI+PHJlY3Qgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiByeD0iNCIvPjwvc3ZnPg=='">
                            <div class="league-card-info">
                                <span class="league-card-country">${l.country}</span>
                                <span class="league-card-name">${l.name}</span>
                            </div>
                        </div>
                        <div class="fav-star active" onclick="toggleFavoriteLeague('${l.id}', '${l.name.replace(/'/g, "\\'")}', '${l.country.replace(/'/g, "\\'")}', this); renderFavoritesView();">★</div>
                    </div>`;
                    });
                }

                if (favMatches.length > 0) {
                    html += "<div style='padding: 24px 24px 10px; font-weight:700; color:var(--text-muted); font-size:13px; text-transform:uppercase;'>Favorit Oyunlar</div>";
                    html += `<div class="league-group" style="margin-top:0;">`;
                    favMatches.forEach(m => {
                        const group = { name: m.tournament.name }; // dummy group for createMatchRow
                        html += createMatchRow(m, group);
                    });
                    html += `</div>`;
                }

                container.innerHTML = html;
            }

            /* Profile Logic */
            function saveProfile() {
                const name = document.getElementById('usernameInput').value;
                const status = document.getElementById('statusInput').value;
                const profile = { name, status };
                localStorage.setItem('userProfile', JSON.stringify(profile));

                document.getElementById('profileDisplayName').innerText = name || 'İstifadəçi';
                document.getElementById('profileAvatar').innerText = (name || 'U').charAt(0).toUpperCase();

                showToast('Profil məlumatları saxlanıldı');
            }

            function loadProfile() {
                const storedUser = localStorage.getItem('proscore_user');
                const profile = JSON.parse(localStorage.getItem('userProfile') || `{"name":"${storedUser || 'İstifadəçi'}", "status":"ProScore istifadəçisi"}`);

                document.getElementById('usernameInput').value = profile.name;
                document.getElementById('statusInput').value = profile.status;
                document.getElementById('profileDisplayName').innerText = profile.name;
                document.getElementById('profileAvatar').innerText = profile.name.charAt(0).toUpperCase();

                document.getElementById('defaultViewSelect').value = userSettings.defaultView;
                document.getElementById('timeFormatSelect').value = userSettings.timeFormat;
                document.getElementById('soundSelect').value = userSettings.notifSound || 'https://assets.mixkit.co/active_storage/sfx/2869/2869-preview.mp3';
                document.getElementById('browserNotifToggle').checked = userSettings.browserNotifEnabled;
                document.getElementById('soundNotifToggle').checked = userSettings.soundEnabled;
                document.getElementById('onlyFavNotifToggle').checked = !!userSettings.onlyFavNotif;

                const theme = localStorage.getItem('theme') || 'dark';
                if (theme === 'light') {
                    document.documentElement.style.setProperty('--bg', '#f8fafc');
                    document.documentElement.style.setProperty('--card', '#ffffff');
                    document.documentElement.style.setProperty('--text-main', '#0f172a');
                    document.documentElement.style.setProperty('--text-muted', '#64748b');
                    document.documentElement.style.setProperty('--border', '#e2e8f0');
                    document.getElementById('themeStatus').innerText = 'Deaktiv';
                }
            }

            function updateSetting(key, val) {
                userSettings[key] = val;
                localStorage.setItem('userSettings', JSON.stringify(userSettings));
                showToast('Tənzimləmə yadda saxlanıldı');
            }

            function toggleBrowserNotifications(enabled) {
                if (enabled) {
                    if (!("Notification" in window)) {
                        alert("Bu brauzer bildirişləri dəstəkləmir.");
                        document.getElementById('browserNotifToggle').checked = false;
                        return;
                    }
                    Notification.requestPermission().then(permission => {
                        if (permission === "granted") {
                            updateSetting('browserNotifEnabled', true);
                        } else {
                            alert("Bildirişlərə icazə verilmədi.");
                            document.getElementById('browserNotifToggle').checked = false;
                            updateSetting('browserNotifEnabled', false);
                        }
                    });
                } else {
                    updateSetting('browserNotifEnabled', false);
                }
            }

            function clearAllData() {
                if (confirm('Bütün favoritləriniz və profil məlumatlarınız silinəcək. Əminsiniz?')) {
                    localStorage.clear();
                    location.reload();
                }
            }

            function toggleTheme() {
                const current = localStorage.getItem('theme') || 'dark';
                const next = current === 'dark' ? 'light' : 'dark';
                localStorage.setItem('theme', next);

                if (next === 'light') {
                    document.documentElement.style.setProperty('--bg', '#f8fafc');
                    document.documentElement.style.setProperty('--card', '#ffffff');
                    document.documentElement.style.setProperty('--text-main', '#0f172a');
                    document.documentElement.style.setProperty('--text-muted', '#64748b');
                    document.documentElement.style.setProperty('--border', '#e2e8f0');
                    document.getElementById('themeStatus').innerText = 'Deaktiv';
                } else {
                    document.documentElement.style.setProperty('--bg', '#020617');
                    document.documentElement.style.setProperty('--card', '#0f172a');
                    document.documentElement.style.setProperty('--text-main', '#f8fafc');
                    document.documentElement.style.setProperty('--text-muted', '#94a3b8');
                    document.documentElement.style.setProperty('--border', '#1e293b');
                    document.getElementById('themeStatus').innerText = 'Aktiv';
                }
                showToast(next === 'light' ? 'İşıqlı tema aktivdir' : 'Qaranlıq tema aktivdir');
            }

            /* Auth Logic */
            function switchAuthTab(tab) {
                document.getElementById('tabLogin').classList.remove('active');
                document.getElementById('tabRegister').classList.remove('active');

                if (tab === 'login') {
                    document.getElementById('tabLogin').classList.add('active');
                    document.getElementById('authTitle').innerText = 'Xoş Gəlmisiniz';
                    document.getElementById('authSubtitle').innerText = 'Davam etmək üçün daxil olun';
                    document.getElementById('authSubmitBtn').innerText = 'Daxil Ol';
                } else {
                    document.getElementById('tabRegister').classList.add('active');
                    document.getElementById('authTitle').innerText = 'Yeni Hesab';
                    document.getElementById('authSubtitle').innerText = 'ProScore ailəsinə qoşulun';
                    document.getElementById('authSubmitBtn').innerText = 'Qeydiyyatdan Keç';
                }
                document.getElementById('authError').innerText = '';
            }

            async function handleAuthSubmit() {
                const usernameInput = document.getElementById('authUsername');
                const passwordInput = document.getElementById('authPassword');
                const username = usernameInput.value.trim();
                const password = passwordInput.value.trim();
                const isLogin = document.getElementById('tabLogin').classList.contains('active');
                const endpoint = isLogin ? '/api/login' : '/api/register';
                const errorDiv = document.getElementById('authError');
                const btn = document.getElementById('authSubmitBtn');

                if (!username || !password) {
                    errorDiv.innerText = 'Zəhmət olmasa bütün xanaları doldurun.';
                    return;
                }

                errorDiv.innerText = '';
                btn.innerText = 'Gözləyin...';
                btn.disabled = true;
                btn.style.opacity = '0.7';

                try {
                    const res = await fetch(endpoint, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ username, password })
                    });
                    const data = await res.json();

                    if (data.success) {
                        if (isLogin) {
                            localStorage.setItem('proscore_token', data.token);
                            localStorage.setItem('proscore_user', data.username);
                            showToast(`Xoş gəldin, ${data.username}!`);
                            updateAuthUI();

                            // Clear inputs
                            usernameInput.value = '';
                            passwordInput.value = '';

                            switchMainView('matches');
                        } else {
                            showToast('Qeydiyyat uğurludur! İndi daxil ola bilərsiniz.');
                            switchAuthTab('login');
                        }
                    } else {
                        errorDiv.innerText = data.error || 'Bir xəta baş verdi.';
                    }
                } catch (error) {
                    errorDiv.innerText = 'Serverlə əlaqə kəsildi.';
                } finally {
                    if (!localStorage.getItem('proscore_token') || !isLogin) {
                        btn.innerText = isLogin ? 'Daxil Ol' : 'Qeydiyyatdan Keç';
                        btn.disabled = false;
                        btn.style.opacity = '1';
                    }
                }
            }

            function logoutUser() {
                if (confirm('Hesabdan çıxmaq istəyirsiniz?')) {
                    localStorage.removeItem('proscore_token');
                    localStorage.removeItem('proscore_user');
                    showToast('Hesabdan çıxıldı.');
                    updateAuthUI();
                    switchMainView('matches');
                }
            }

            function updateAuthUI() {
                const token = localStorage.getItem('proscore_token');
                const username = localStorage.getItem('proscore_user');
                const authLink = document.getElementById('sidebarAuthLink');
                const logoutBox = document.getElementById('logoutBtnBox');

                if (token) {
                    if (authLink) authLink.style.display = 'none';
                    if (logoutBox) logoutBox.style.display = 'flex';
                    if (username) {
                        const nameEl = document.getElementById('profileDisplayName');
                        const avatarEl = document.getElementById('profileAvatar');
                        if (nameEl) nameEl.innerText = username;
                        if (avatarEl) avatarEl.innerText = username.charAt(0).toUpperCase();
                    }
                } else {
                    if (authLink) authLink.style.display = 'flex';
                    if (logoutBox) logoutBox.style.display = 'none';
                }
            }

            /* Utils */
            function showToast(msg) {
                const toast = document.getElementById('toast');
                const msgEl = document.getElementById('toastMsg');
                msgEl.innerHTML = `✨ ${msg}`;

                clearTimeout(toastTimer);
                toast.classList.add('show');

                toastTimer = setTimeout(() => {
                    toast.classList.remove('show');
                }, 3500);
            }

            // Initial Load
            function startAuthRedirectTimer() {
                const token = localStorage.getItem('proscore_token');
                if (token) return;

                authTimer = setTimeout(() => {
                    if (!userHasNavigated && !localStorage.getItem('proscore_token')) {
                        const overlay = document.getElementById('authOverlay');
                        overlay.classList.add('show');

                        setTimeout(() => {
                            switchMainView('auth');
                            setTimeout(() => {
                                overlay.classList.remove('show');
                                setTimeout(() => overlay.style.display = 'none', 800);
                            }, 1000);
                        }, 2500);
                    }
                }, 45000); // 45 seconds
            }

            generateDateTabs();
            fetchData();
            setInterval(() => {
                fetchData();
                generateDateTabs();
            }, 30000);
            notificationMgr.init();
            loadProfile();
            updateAuthUI();
            startAuthRedirectTimer();

            // Arxa plandan önə qayıdanda köhnə hesabların görünməsinin qarşısını almaq üçün dərhal yeniləmə
            document.addEventListener("visibilitychange", () => {
                if (document.visibilityState === "visible") {
                    console.log("App foregrounded. Fetching instant live data.");
                    fetchData();
                }
            });

            // Register PWA Service Worker
            if ('serviceWorker' in navigator) {
                window.addEventListener('load', () => {
                    navigator.serviceWorker.register('/sw.js').then(reg => {
                        console.log('SW registered:', reg);
                    }).catch(err => {
                        console.log('SW registration failed:', err);
                    });
                });
            }

            // Uygulama yüklendiğinde default view'e geç
            if (userSettings.defaultView === 'leagues') {
                setTimeout(() => switchMainView('leagues'), 100);
            }
        