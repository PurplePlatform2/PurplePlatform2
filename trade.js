// deriv-pullback-regression.js
// Node.js + Browser compatible
// Strategy: Long-term regression trend + residual z-score pullback entries
// Martingale on loss (optional). Stop after daily profit target.

// === CONFIG ===
const APP_ID = 1089;                     // Your Deriv App ID
const TOKEN = "tUgDTQ6ZclOuNBl";         // Your API token
const SYMBOL = "stpRNG";                 // Market symbol
const BASE_STAKE = 0.35;                 // Initial stake in USD
const MULTIPLIER = 1.5;                    // Martingale multiplier (e.g., 2). 1=off
const DURATION = 1;                      // Duration in ticks
const MAX_DAILY_PROFIT = 10;             // Daily target in USD

// Math/Signal params
const N_LONG = 300;                      // Regression window (trend)
const N_VOL = 100;                       // Volatility window (std of returns)
const T_TSTAT = 2.0;                     // |t-stat| threshold for significant trend
const Z_PULL = 1.25;                     // Pullback z threshold
const MIN_VOL = 0.00002;                 // Volatility floor on tick returns (tune by symbol)

// Throttling & safety
const RETRY_MS = 1500;
const BETWEEN_TRADES_MS = 1200;

// === STATE ===
let currentStake = BASE_STAKE;
let dailyProfit = 0;
let lastContractId = null;
let lastProposal = null; // store full proposal incl ask_price
let inFlight = false;    // ensure one trade at a time
let tradeDirection = null;

// === WEBSOCKET ===
let connection;
if (typeof WebSocket !== "undefined") {
  // Browser
  connection = new WebSocket(`wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`);
} else {
  // Node.js
  const WebSocket = require("ws");
  connection = new WebSocket(`wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`);
}

// === HELPERS ===
function send(msg) {
  if (connection.readyState === 1) {
    connection.send(JSON.stringify(msg));
  } else {
    setTimeout(() => send(msg), 200);
  }
}

function authorize() {
  send({ authorize: TOKEN });
}

function mean(a) {
  return a.reduce((s, v) => s + v, 0) / a.length;
}

function variance(a, m = mean(a)) {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - m;
    s += d * d;
  }
  return s / (a.length - 1);
}

function stddev(a) {
  return Math.sqrt(Math.max(variance(a), 0));
}

function diffs(a) {
  const out = [];
  for (let i = 1; i < a.length; i++) out.push(a[i] - a[i - 1]);
  return out;
}

// Ordinary Least Squares on y over x = 0..n-1
function olsSlopeTstat(y) {
  const n = y.length;
  if (n < 3) return { slope: 0, intercept: y[n - 1], tstat: 0, resid: [], sigmaE: 0 };

  const x = [...Array(n).keys()];
  const xMean = (n - 1) / 2;
  const yMean = mean(y);

  let Sxx = 0, Sxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - xMean;
    Sxx += dx * dx;
    Sxy += dx * (y[i] - yMean);
  }
  const slope = Sxy / Sxx;
  const intercept = yMean - slope * xMean;

  // Residuals and sigma_e
  const resid = new Array(n);
  let SSE = 0;
  for (let i = 0; i < n; i++) {
    const yhat = intercept + slope * i;
    const e = y[i] - yhat;
    resid[i] = e;
    SSE += e * e;
  }
  // Standard error of slope: se(b) = sqrt( sigma^2 / Sxx ), sigma^2 = SSE/(n-2)
  const sigma2 = SSE / Math.max(n - 2, 1);
  const seSlope = Math.sqrt(sigma2 / Sxx);
  const tstat = seSlope > 0 ? slope / seSlope : 0;

  return { slope, intercept, tstat, resid, sigmaE: Math.sqrt(Math.max(sigma2, 0)) };
}

function fetchTicks() {
  if (dailyProfit >= MAX_DAILY_PROFIT) {
    console.log(`🏆 Daily profit reached: $${dailyProfit.toFixed(2)}. Stopping.`);
    try { connection.close(); } catch {}
    return;
  }
  if (inFlight) return; // wait for current trade to finish

  send({
    ticks_history: SYMBOL,
    style: "ticks",
    count: Math.max(N_LONG, N_VOL) + 2, // a bit extra
    end: "latest",
  });
}

function computeSignal(prices) {
  if (prices.length < N_LONG) return null;

  // 1) Trend via OLS on last N_LONG
  const y = prices.slice(-N_LONG);
  const { slope, intercept, tstat, resid, sigmaE } = olsSlopeTstat(y);

  // 2) Pullback via residual z-score (latest bar)
  const lastIdx = y.length - 1;
  const yhat_last = intercept + slope * lastIdx;
  const e_last = y[lastIdx] - yhat_last;
  const z_last = sigmaE > 0 ? e_last / sigmaE : 0;

  // 3) Volatility filter on returns (last N_VOL)
  const volBase = prices.slice(-N_VOL);
  const rets = diffs(volBase);  // tick-to-tick differences
  const vol = stddev(rets);

  const upTrend = slope > 0 && tstat >= T_TSTAT;
  const dnTrend = slope < 0 && tstat <= -T_TSTAT;

  let direction = null;
  if (vol >= MIN_VOL) {
    if (upTrend && z_last <= -Z_PULL) direction = "CALL";  // buy the dip
    if (dnTrend && z_last >=  Z_PULL) direction = "PUT";   // sell the rally
  }

  return {
    direction,
    slope,
    tstat,
    z_last,
    vol,
    debug: { intercept, sigmaE }
  };
}

function requestProposal(amount, direction) {
  console.log(`📥 Proposal | Stake: ${amount.toFixed(2)} | ${direction}`);
  send({
    proposal: 1,
    amount: amount,          // stake
    basis: "stake",
    contract_type: direction, // "CALL" or "PUT" as per user's flow
    currency: "USD",
    duration: DURATION,
    duration_unit: "t",
    symbol: SYMBOL,
  });
}

function buyContract(proposal) {
  // IMPORTANT: Use ask_price (or higher) for "price" to avoid validation errors.
  const ask = Number(proposal.ask_price || proposal.display_value || currentStake);
  console.log(`📈 Buying ${tradeDirection} | Stake: ${currentStake.toFixed(2)} | ask_price: ${ask}`);
  send({ buy: proposal.id, price: ask });
}

// === CONTRACT MANAGEMENT ===
function handlePOC(data) {
  const poc = data.proposal_open_contract;
  if (!poc) return;
  if (poc.contract_id !== lastContractId) return;

  if (poc.is_sold) {
    const profit = Number(poc.profit);
    console.log(`📉 Contract Closed | Profit: ${profit.toFixed(2)}`);

    dailyProfit += profit;
    console.log(`💰 Daily Profit: $${dailyProfit.toFixed(2)} / $${MAX_DAILY_PROFIT}`);

    if (dailyProfit >= MAX_DAILY_PROFIT) {
      console.log(`🏆 Target reached. Stopping.`);
      try { connection.close(); } catch {}
      return;
    }

    if (profit > 0) {
      console.log("✅ WIN → Reset stake");
      currentStake = BASE_STAKE;
    } else {
      console.log(`❌ LOSS → Martingale × ${MULTIPLIER}`);
      currentStake = Math.max(BASE_STAKE, currentStake * MULTIPLIER);
    }

    inFlight = false;
    setTimeout(fetchTicks, BETWEEN_TRADES_MS);
  } else {
    // Optional: live P/L view
    // console.log(`⏱ Ongoing | Profit: ${poc.profit}`);
  }
}

// === MAIN FLOW ===
connection.onopen = () => {
  console.log("✅ WebSocket connected");
  authorize();
};

connection.onmessage = (e) => {
  const data = JSON.parse(e.data);
  if (data.error) {
    console.error("❌ Error:", data.error.message, data.error.code || "");
    inFlight = false;
    setTimeout(fetchTicks, RETRY_MS);
    return;
  }

  switch (data.msg_type) {
    case "authorize":
      console.log("🔑 Authorized");
      fetchTicks();
      break;

    case "history":
      if (!data.history?.prices) break;
      // Compute signal
      const prices = data.history.prices.map(Number);
      const sig = computeSignal(prices);
      if (!sig || !sig.direction) {
        console.log(`🧪 No trade | slope=${sig?.slope?.toExponential?.(3)} t=${sig?.tstat?.toFixed?.(2)} z=${sig?.z_last?.toFixed?.(2)} vol=${sig?.vol?.toExponential?.(2)}`);
        setTimeout(fetchTicks, RETRY_MS);
        return;
      }

      tradeDirection = sig.direction;
      console.log(`🎯 Signal: ${tradeDirection} | slope=${sig.slope.toExponential(3)} t=${sig.tstat.toFixed(2)} z=${sig.z_last.toFixed(2)} vol=${sig.vol.toExponential(2)}`);

      if (inFlight) return;
      inFlight = true;
      requestProposal(currentStake, tradeDirection);
      break;

    case "proposal":
      if (data.proposal?.id) {
        lastProposal = data.proposal;
        buyContract(lastProposal);
      }
      break;

    case "buy":
      lastContractId = data.buy.contract_id;
      console.log("🎯 Bought contract:", lastContractId);
      // Subscribe to its lifecycle
      send({ proposal_open_contract: 1, contract_id: lastContractId, subscribe: 1 });
      break;

    case "proposal_open_contract":
      handlePOC(data);
      break;
  }
};

connection.onclose = () => {
  console.log("🔌 WebSocket closed");
};
