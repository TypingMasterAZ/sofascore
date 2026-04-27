const axios = require('axios');

async function testEndpoint(path, params = {}) {
    const rapidApiKey = '2f8ef458aemsha05f2f0c4ce9b06p1f15fejsn702617d3780e';
    const host = 'sofascore.p.rapidapi.com';
    
    try {
        console.log(`Testing: https://${host}${path}`);
        const response = await axios.get(`https://${host}${path}`, {
            headers: {
                'x-rapidapi-key': rapidApiKey,
                'x-rapidapi-host': host
            },
            params: params
        });
        console.log(`SUCCESS [${path}]:`, JSON.stringify(response.data).substring(0, 300));
        return true;
    } catch (e) {
        console.log(`FAILED [${path}]:`, e.response?.status, e.response?.data?.message || e.message);
        return false;
    }
}

async function runTests() {
    // 429 xətasından qaçmaq üçün fasilə ilə
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    
    await testEndpoint('/matches/get-live-matches');
    await sleep(2000);
    await testEndpoint('/events/get-v2-live');
    await sleep(2000);
    await testEndpoint('/sport/football/get-live-events');
    await sleep(2000);
    await testEndpoint('/get-live');
}

runTests();
