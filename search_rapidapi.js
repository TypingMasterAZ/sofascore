const https = require('https');

const options = {
  hostname: 'rapidapi.com',
  path: '/api/categories/sports/apis?limit=50', // We might find it here? No, let's hit their search endpoint
  method: 'GET'
};

// Actually, RapidAPI search is https://rapidapi.com/api/search?term=sofascore
// Let's try that.
const options2 = {
  hostname: 'rapidapi.com',
  path: '/api/search/apis?term=sofascore',
  method: 'GET',
  headers: {
    'Accept': 'application/json'
  }
};

const req = https.request(options2, (res) => {
  let data = '';
  res.on('data', (chunk) => data += chunk);
  res.on('end', () => console.log(data));
});
req.end();
