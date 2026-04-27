const axios = require('axios');

const API_KEY = '2f8ef458aemsha05f2f0c4ce9b06p1f15fejsn702617d3780e';
const HOST = 'sofascore.p.rapidapi.com';

const client = axios.create({
  baseURL: `https://${HOST}`,
  headers: {
    'X-RapidAPI-Key': API_KEY,
    'X-RapidAPI-Host': HOST
  }
});

async function testEndpoint(path) {
  try {
    const response = await client.get(path);
    console.log(`[SUCCESS] ${path}`);
    if (response.data && typeof response.data === 'object') {
       console.log(`  Keys: ${JSON.stringify(Object.keys(response.data))}`);
    } else {
       console.log(`  Data: ${response.data}`);
    }
    return response.data;
  } catch (error) {
    console.error(`[ERROR] ${path}: ${error.response ? error.response.status : error.message}`);
    if (error.response && error.response.data) {
      console.error(`  Data:`, JSON.stringify(error.response.data));
    }
  }
}

async function run() {
  const date = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  
  // Test direct endpoints from sofascore api
  await testEndpoint('/sport/football/events/live');
  await testEndpoint(`/sport/football/scheduled-events/${date}`);
  const eventId = 11352376; // Example event ID
  await testEndpoint(`/event/${eventId}/incidents`);
  await testEndpoint(`/event/${eventId}/statistics`);

  // Let's also try Api Dojo common formats
  await testEndpoint('/events/live');
  await testEndpoint('/events/schedule');
  
  // Try to list categories
  await testEndpoint('/categories');
  await testEndpoint('/tournaments/get-category-events');
}

run();