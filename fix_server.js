const fs = require('fs');
let text = fs.readFileSync('server.js', 'utf8');

const target1 = `    if (normalizedEmail) keys.push(\`email_\${normalizedEmail.replace(/[^a-zA-Z0-9_\\-]/g, '_')}\`);
    return keys;
}

async function saveProfileRecord(profile) {`;

const replacement1 = `        try { return JSON.parse(fs.readFileSync('./users.json', 'utf-8')); } catch(e) {}
    }
    return [];
}

function getUserDocKey(userData) {
    return (userData.uid || userData.email || userData.username || String(userData.id || Date.now())).replace(/[^a-zA-Z0-9_\\-]/g, '_');
}

const PROFILE_FILE = './profiles.json';

function getProfileKeys({ email, uid }) {
    const normalizedEmail = String(email || '').trim().toLowerCase();
    const keys = [];
    if (uid) keys.push(\`uid_\${String(uid).replace(/[^a-zA-Z0-9_\\-]/g, '_')}\`);
    if (normalizedEmail) keys.push(\`email_\${normalizedEmail.replace(/[^a-zA-Z0-9_\\-]/g, '_')}\`);
    return keys;
}

async function saveProfileRecord(profile) {`;

text = text.replace(target1, replacement1);

const target2 = `        updatedAt: profile.updatedAt || new Date().toISOString()
    };
    const keys = getProfileKeys(cleanProfile);`;

const replacement2 = `        updatedAt: profile.updatedAt || new Date().toISOString()
    };
    if (profile.favoritesState) {
        cleanProfile.favoritesState = profile.favoritesState;
    }
    const keys = getProfileKeys(cleanProfile);`;

text = text.replace(target2, replacement2);

fs.writeFileSync('server.js', text);
console.log('Fixed server.js');
