const axios = require('axios');

async function testEndpoint(path, params = {}) {
    const rapidApiKey = '2f8ef458aemsha05f2f0c4ce9b06p1f15fejsn702617d3780e';
    const host = 'sofascore.p.rapidapi.com';
    
    try {
        const response = await axios.get(`https://${host}${path}`, {
            headers: {
                'x-rapidapi-key': rapidApiKey,
                'x-rapidapi-host': host
            },
            params: params,
            timeout: 5000
        });
        console.log(`SUCCESS [${path}]: HTTP 200`);
        return true;
    } catch (e) {
        if (e.response && e.response.status !== 404) {
            console.log(`POTENTIAL [${path}]: HTTP ${e.response.status}`);
            return true;
        }
        return false;
    }
}

async function runTests() {
    const paths = [
        '/matches/get-live',
        '/matches/get-live-events',
        '/matches/get-v2-live',
        '/matches/get-v2-live-events',
        '/matches/get-live-scores',
        '/matches/get-live-matches',
        '/events/get-live',
        '/events/get-live-events',
        '/events/get-v2-live',
        '/sport/football/get-live',
        '/sport/football/get-live-events',
        '/get-live',
        '/get-live-events'
    ];
    
    for (const p of paths) {
        await testEndpoint(p);
    }
}

runTests();
