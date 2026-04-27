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
        console.log(`FAILED [${path}]:`, e.response?.status, e.response?.data || e.message);
        return false;
    }
}

async function runTests() {
    await testEndpoint('/matches/get-live');
    await testEndpoint('/matches/get-live-events');
    await testEndpoint('/matches/get-live-v2');
    await testEndpoint('/events/get-live');
    await testEndpoint('/events/get-live-events');
}

runTests();
