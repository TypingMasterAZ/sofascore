const https = require('https');

const options = {
  hostname: 'sofascore.p.rapidapi.com',
  path: '/sport/football/events/live', // Trying original path
  method: 'GET',
  headers: {
    'x-rapidapi-key': '2f8ef458aemsha05f2f0c4ce9b06p1f15fejsn702617d3780e',
    'x-rapidapi-host': 'sofascore.p.rapidapi.com'
  }
};

const req = https.request(options, (res) => {
  console.log(`STATUS: ${res.statusCode}`);
  let data = '';
  res.on('data', (chunk) => {
    data += chunk;
  });
  res.on('end', () => {
    console.log(data);
  });
});

req.on('error', (e) => {
  console.error(`Problem: ${e.message}`);
});

req.end();
