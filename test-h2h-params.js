const axios = require('axios');

const API_KEY = '2f8ef458aemsha05f2f0c4ce9b06p1f15fejsn702617d3780e';
const HOST = 'sofascore.p.rapidapi.com';

async function testParam(paramName) {
  try {
    const response = await axios.get(`https://${HOST}/matches/get-h2h-events`, {
      headers: {
        'x-rapidapi-key': API_KEY,
        'x-rapidapi-host': HOST
      },
      params: {
         [paramName]: '11352376' 
      }
    });
    console.log(`Success with ${paramName}!`);
    console.log(response.data);
  } catch (error) {
    console.log(`Failed with ${paramName}:`, error.response ? error.response.status : error.message);
  }
}

async function run() {
  await testParam('matchId');
  await testParam('eventId');
  await testParam('customId');
  await testParam('id');
}

run();