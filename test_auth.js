
const axios = require('axios');

async function testAuth() {
    try {
        console.log("Testing Login...");
        const res = await axios.post('http://localhost:3000/api/login', {
            username: 'Elten',
            password: 'somepassword' // I don't know the password, expect failure
        });
        console.log("Login success:", res.data);
    } catch (err) {
        console.log("Login failed (expected if wrong password):", err.response?.data || err.message);
    }

    try {
        console.log("\nTesting Register...");
        const res = await axios.post('http://localhost:3000/api/register', {
            username: 'TestUser' + Date.now(),
            password: 'testpassword'
        });
        console.log("Register success:", res.data);
    } catch (err) {
        console.log("Register failed:", err.response?.data || err.message);
    }
}

testAuth();
