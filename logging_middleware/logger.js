const axios = require('axios');
const { AUTH_TOKEN, BASE_URL } = require('./constants');

async function Log(stack, level, pkg, message) {
  try {
    await axios.post(`${BASE_URL}/evaluation-service/logs`,
      { stack, level, package: pkg, message },
      { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } }
    );
  } catch (err) {}
}

module.exports = { Log };