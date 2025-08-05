const token = process.argv[2] || 'JklMzewtX7Da9mT'; // 🔐 Replace with your real token
const stake = 1;
const marketSymbol = 'stpRNG';
const duration = 3;

const ws = new (require('ws'))('wss://ws.derivws.com/websockets/v3?app_id=85077');
let recentTicks = [];
let waitingForBuy = false; // Cooldown

// --- Indicator Functions ---
function binaryMomentum(prices) {
  let score = 0;
  for (let i = 1; i < prices.length; i++) {
    if (prices[i] > prices[i - 1]) score++;
    else if (prices[i] < prices[i - 1]) score--;
  }
  return score;
}

function regressionSlope(prices) {
  const n = prices.length;
  const x = [...Array(n).keys()];
  const sumX = x.reduce((a, b) => a + b, 0);
  const sumY = prices.reduce((a, b) => a + b, 0);
  const sumXY = x.reduce((acc, val, i) => acc + val * prices[i], 0);
  const sumX2 = x.reduce((acc, val) => acc + val * val, 0);
  const numerator = n * sumXY - sumX * sumY;
  const denominator = n * sumX2 - sumX * sumX;
  return denominator !== 0 ? numerator / denominator : 0;
}

function rateOfChange(prices) {
  const first = prices[0];
  const last = prices[prices.length - 1];
  return first !== 0 ? ((last - first) / first) * 100 : 0;
}

function upDownRatio(prices) {
  let ups = 0, downs = 0;
  for (let i = 1; i < prices.length; i++) {
    if (prices[i] > prices[i - 1]) ups++;
    else if (prices[i] < prices[i - 1]) downs++;
  }
  return ups / (downs + 1);
}

function tickVolatility(prices) {
  const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
  const variance = prices.reduce((acc, p) => acc + (p - mean) ** 2, 0) / prices.length;
  return Math.sqrt(variance);
}

// --- WebSocket Events ---
ws.onopen = () => {
  console.log('🔌 Connected to Deriv');
  ws.send(JSON.stringify({ authorize: token }));
};

ws.onmessage = function (event) {
  const data = JSON.parse(event.data);

  if (data.error) {
    console.error('❌ Error:', data.error.message);
    return;
  }

  if (data.msg_type === 'authorize') {
    console.log('✅ Authorized');
    ws.send(JSON.stringify({ ticks: marketSymbol, subscribe: 1 }));
  }

  if (data.msg_type === 'tick') {
    const tick = parseFloat(data.tick.quote);
    recentTicks.push(tick);
    if (recentTicks.length > 50) recentTicks.shift();
    if (recentTicks.length >= 12) analyzeAndTrade(recentTicks.slice());
  }

  if (data.msg_type === 'proposal') {
    console.log(`💰 Proposal (${data.proposal.contract_type}): $${data.proposal.display_value}`);
    if (!waitingForBuy) {
      const id = data.proposal.id;
      waitingForBuy = true;
      ws.send(JSON.stringify({ buy: id, price: stake }));
    }
  }

  if (data.msg_type === 'buy') {
    console.log(`🛒 Bought: ${data.buy.contract_id} | ${data.buy.longcode}`);
    // Cooldown to prevent rapid re-trades
    setTimeout(() => {
      waitingForBuy = false;
    }, 5000); // 5 seconds
  }
};

// --- Decision & Trading Logic ---
function analyzeAndTrade(ticks) {
  if (waitingForBuy) return;

  const shortPrices = ticks.slice(-6);
  const longPrices = ticks.slice(-12);

  const momentum = binaryMomentum(shortPrices.slice(1));
  const slopeShort = regressionSlope(shortPrices);
  const slopeLong = regressionSlope(longPrices);
  const roc = rateOfChange(shortPrices);
  const ratio = upDownRatio(shortPrices);
  const volatility = tickVolatility(shortPrices);

  if (volatility < 0.01) {
    console.log('⚠️ Low volatility. Skipping...');
    return;
  }

  const trend = slopeLong > 0.0002 ? 'up' : (slopeLong < -0.0001 ? 'down' : 'flat');

  let score = 0;
  if (momentum > 0) score += 1;
  if (slopeShort > 0.0002 && slopeLong > 0.0001) score += 2;
  if (roc > 0.02) score += 1.5;
  if (ratio > 1.3) score += 1;

  let contractType = null;
  if (trend === 'up' && score >= 3) {
    contractType = 'CALL';
  } else if ((trend === 'down' || trend === 'flat') && score >= 3) {
    contractType = 'PUT';
  } else {
    console.log(`⏭️ Skipping trade | Trend: ${trend}, Score: ${score.toFixed(2)}`);
    return;
  }

  console.log(`📈 Signal: ${contractType} | Trend: ${trend}, Score: ${score.toFixed(2)}, Volatility: ${volatility.toFixed(4)}`);
  requestProposal(contractType);
}

function requestProposal(contractType) {
  const proposal = {
    proposal: 1,
    amount: stake,
    basis: 'stake',
    contract_type: contractType,
    currency: 'USD',
    duration: duration,
    duration_unit: 't',
    symbol: marketSymbol
  };
  ws.send(JSON.stringify(proposal));
}
