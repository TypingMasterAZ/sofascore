const axios = require('axios');

async function testEndpoint(path, params = {}) {
    const rapidApiKey = '2f8ef458aemsha05f2f0c4ce9b06p1f15fejsn702617d3780e';
    const host = 'sofascore.p.rapidapi.com';
    
    try {
        console.log(`Testing: https://${host}${path} with params`, params);
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
    const id = '16076017'; // Live match id
    
    await testEndpoint('/matches/get-incidents', { customId: id });
    await testEndpoint('/matches/get-statistics', { customId: id });
    await testEndpoint('/matches/get-incidents', { matchId: id });
    await testEndpoint('/matches/get-statistics', { matchId: id });
}

runTests();
