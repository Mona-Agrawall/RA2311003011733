const axios = require('axios');
const { Log } = require('../logging_middleware/logger');
const { AUTH_TOKEN, BASE_URL } = require('../logging_middleware/constants');

const WEIGHTS = { Placement: 3, Result: 2, Event: 1 };

async function getTopN(n = 10) {
  await Log('backend', 'info', 'handler', `Fetching top ${n} priority notifications`);

  const res = await axios.get(`${BASE_URL}/evaluation-service/notifications`, {
    headers: { Authorization: `Bearer ${AUTH_TOKEN}` }
  });

  const notifications = res.data.notifications;
  const now = Date.now();

  const scored = notifications.map(item => ({
    ...item,
    score: WEIGHTS[item.Type] * (1 / ((now - new Date(item.Timestamp).getTime()) / 60000 + 1))
  }));

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, n);

  await Log('backend', 'info', 'handler', `Top ${n} notifications computed successfully`);
  console.log(JSON.stringify(top, null, 2));
  return top;
}

getTopN(10).catch(async err => {
  await Log('backend', 'fatal', 'handler', err.message);
  console.error(err.message);
});