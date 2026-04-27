const axios = require('axios');

async function testH2H(id) {
    const rapidApiKey = '2f8ef458aemsha05f2f0c4ce9b06p1f15fejsn702617d3780e';
    try {
        const response = await axios.get('https://sofascore.p.rapidapi.com/matches/get-h2h-events', {
            headers: {
                'x-rapidapi-key': rapidApiKey,
                'x-rapidapi-host': 'sofascore.p.rapidapi.com'
            },
            params: {
                eventId: id
            }
        });
        console.log("Success with eventId!", JSON.stringify(response.data));
    } catch (e) {
        console.log("Failed with eventId", e.response?.data || e.message);
    }

    try {
        const response = await axios.get('https://sofascore.p.rapidapi.com/matches/get-h2h-events', {
            headers: {
                'x-rapidapi-key': rapidApiKey,
                'x-rapidapi-host': 'sofascore.p.rapidapi.com'
            },
            params: {
                matchId: id
            }
        });
        console.log("Success with matchId!", JSON.stringify(response.data));
    } catch (e) {
        console.log("Failed with matchId", e.response?.data || e.message);
    }
}

testH2H('11352376');