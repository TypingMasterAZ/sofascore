const axios = require('axios');

const API_KEY = '2f8ef458aemsha05f2f0c4ce9b06p1f15fejsn702617d3780e';
const HOST = 'sofascore.p.rapidapi.com';

async function getH2H() {
  try {
    const response = await axios.get(`https://${HOST}/matches/get-h2h-events`, {
      headers: {
        'x-rapidapi-key': API_KEY,
        'x-rapidapi-host': HOST
      },
      // Usually h2h requires something like customId, matchId or eventId. 
      // Let's try without params to see the error message.
      // params: {
      //   eventId: '11352376' 
      // }
    });
    console.log("Success! Keys:", Object.keys(response.data));
    console.log("Data:", JSON.stringify(response.data).substring(0, 200));
  } catch (error) {
    console.error("Error:", error.response ? JSON.stringify(error.response.data) : error.message);
  }
}

getH2H();