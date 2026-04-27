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
        console.log(`SUCCESS [${path}]:`, JSON.stringify(response.data).substring(0, 200));
        return true;
    } catch (e) {
        console.log(`FAILED [${path}]:`, e.response?.status, e.response?.data || e.message);
        return false;
    }
}

async function runTests() {
    // Test 1: Standard Live Path (with /api/v1)
    await testEndpoint('/api/v1/sport/football/events/live');
    
    // Test 2: Standard Live Path (without /api/v1)
    await testEndpoint('/sport/football/events/live');
    
    // Test 3: RapidAPI-style path (from sidebar guess)
    await testEndpoint('/matches/get-live');
    
    // Test 4: Categories
    await testEndpoint('/api/v1/sport/football/categories');
    await testEndpoint('/categories/list');
}

runTests();
