const axios = require('axios');
const { Log } = require('../logging_middleware/logger');
const { AUTH_TOKEN, BASE_URL } = require('../logging_middleware/constants');

const headers = { Authorization: `Bearer ${AUTH_TOKEN}` };

function knapsack(items, capacity) {
  const n = items.length;
  const dp = Array(n + 1).fill(null).map(() => Array(capacity + 1).fill(0));
  for (let i = 1; i <= n; i++) {
    const { Duration: w, Impact: v } = items[i - 1];
    for (let c = 0; c <= capacity; c++) {
      dp[i][c] = dp[i - 1][c];
      if (w <= c) dp[i][c] = Math.max(dp[i][c], dp[i - 1][c - w] + v);
    }
  }
  let c = capacity, selected = [];
  for (let i = n; i >= 1; i--) {
    if (dp[i][c] !== dp[i - 1][c]) {
      selected.push(items[i - 1].TaskID);
      c -= items[i - 1].Duration;
    }
  }
  return { totalImpact: dp[n][capacity], selected };
}

async function run() {
  await Log('backend', 'info', 'service', 'Fetching depots and vehicles');
  const [depotsRes, vehiclesRes] = await Promise.all([
    axios.get(`${BASE_URL}/evaluation-service/depots`, { headers }),
    axios.get(`${BASE_URL}/evaluation-service/vehicles`, { headers })
  ]);

  const depots = depotsRes.data.depots;
  const vehicles = vehiclesRes.data.vehicles;

  for (const depot of depots) {
    const result = knapsack(vehicles, depot.MechanicHours);
    await Log('backend', 'info', 'service', `Depot ${depot.ID}: impact=${result.totalImpact}, tasks=${result.selected.length}`);
    console.log(`Depot ${depot.ID} | Impact: ${result.totalImpact} | Tasks:`, result.selected);
  }
}

run().catch(async err => {
  await Log('backend', 'fatal', 'service', err.message);
  console.error(err.message);
});