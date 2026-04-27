const axios = require('axios');

async function testGasProxy(path) {
    const GAS_PROXY_URL = "https://script.google.com/macros/s/AKfycbxsHV0KhThLoQkzK5anpcQzb6-MdDed2bSIRWltFl46eHWVFQ-BJ4hNJgonVlgcX42_Ig/exec";
    
    try {
        console.log(`Testing via GAS proxy: ${path}`);
        const response = await axios.get(GAS_PROXY_URL, {
            params: { path: path }
        });
        console.log(`SUCCESS [${path}]:`, JSON.stringify(response.data).substring(0, 300));
        return true;
    } catch (e) {
        console.log(`FAILED [${path}]:`, e.response?.status, e.response?.data || e.message);
        return false;
    }
}

async function runTests() {
    // 12389658 is an example match ID, or we can use another one
    await testGasProxy('/event/12389658/incidents');
    await testGasProxy('/event/12389658/statistics');
}

runTests();
