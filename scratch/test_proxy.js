const axios = require('axios');

async function testProxy() {
    const GAS_PROXY_URL = process.env.GAS_PROXY_URL;
    if (!GAS_PROXY_URL) {
        console.error("Missing GAS_PROXY_URL environment variable.");
        return;
    }
    const path = "/sport/football/events/live";
    
    console.log(`Testing GAS Proxy: ${GAS_PROXY_URL}`);
    console.log(`Path: ${path}`);
    
    try {
        const response = await axios.get(GAS_PROXY_URL, {
            params: { path }
        });
        
        console.log("Status:", response.status);
        // Check if data is string and starts with <!doctype (HTML)
        if (typeof response.data === 'string' && response.data.trim().startsWith('<!doctype')) {
            console.error("FAIL: Received HTML instead of JSON. (Likely Login Page)");
            console.log("Snippet:", response.data.substring(0, 200));
        } else if (response.data && (response.data.events || response.data.error)) {
            console.log("SUCCESS! Received JSON response.");
            if (response.data.events) {
                console.log("Found", response.data.events.length, "events.");
            } else {
                console.log("Error from GAS:", response.data.message);
            }
        } else {
            console.log("Unexpected response format:", typeof response.data);
            console.log("Data:", response.data);
        }
    } catch (error) {
        console.error("Test failed:", error.message);
        if (error.response) {
            console.error("Response status:", error.response.status);
        }
    }
}

testProxy();
