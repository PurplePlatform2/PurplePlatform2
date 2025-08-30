// combined-bot-regression-sma-advanced.js
// Strategy: Linear regression + SMA crossover (CALL + PUT)
// Added filters: ensemble confirmation, volatility regime, slope t-test, normalized slope,
// CUSUM change detector, EWMA trend smoothing, z-score on SMA diff, simple EV filter,
// cooldown & basic risk controls. Compatible with Node.js and browser.

// === CONFIG ===
const APP_ID = 1089; // Your Deriv/Binary App ID
const TOKEN = /*process.argv[2] ||*/ "tUgDTQ6ZclOuNBl"; // Your API token
const SYMBOL = "stpRNG"; // Market symbol (example)
const HISTORY_COUNT = 500; // Number of ticks to keep in memory
const STAKE = process.argv[3] ||  0.35; // base stake in USD (you could make dynamic via Kelly later)
const CONTRACT_DURATION_TICKS = 15; // contract duration in ticks
const AUTO_CLOSE_LOSS_THRESHOLD = -0.5; // loss threshold in USD
const REGRESSION_WINDOW = 100; // regression slope window
const TRADE_COOLDOWN_MS = 60 * 1000; // 1 minute between trades
const MIN_TICKS_BEFORE_TRADE = 200; // keep same minimum initialization

// === FILTER THRESHOLDS (tweak after backtest) ===
const VOL_WINDOW = 50; // window for volatility (std of returns)
const VOL_MIN = 0.00001; // minimum volatility allowed
const VOL_MAX = 0.01; // maximum volatility allowed

const SLOPE_T_CRIT = 2.0; // t-stat critical threshold (approx p<0.05 for n~100)
const NORM_SLOPE_MIN = 1e-7; // minimal absolute normalized slope required

const CUSUM_WINDOW = 30; // window used by CUSUM
const CUSUM_THRESHOLD = 0.0005; // threshold to declare persistent change

const EWMA_ALPHA = 0.15; // smoothing for EWMA trend estimator

const ZSMA_THRESHOLD = 1.0; // require |zscore(SMA50-SMA200)| >= this

const MIN_EV = 0.01; // minimum expected value (dollar) to allow trade

const TRADE_HISTORY_LOOKBACK = 100; // lookback for EV calc & winrate

const MAX_TRADES_PER_HOUR = 12; // additional protection

// === GLOBALS ===
let ws = null;
let ticks = []; // { epoch, quote }
let mainContractId = null;
let mainBuyPrice = 0;
let mainContractTickCounter = 0;
let awaitingProposal = false;
let lastTradeTime = 0;
let pendingDirection = null; // "CALL" or "PUT"
let ewmaPrice = null;
let tradeHistory = []; // { profit: Number, timestamp: Number }
let tradesThisHour = []; // timestamps of trade entries

// === WebSocket Polyfill for Node.js ===
let WSClass;
if (typeof WebSocket === "undefined") {
  WSClass = require("ws");
} else {
  WSClass = WebSocket;
}

// === HELPERS ===
function safeMean(arr) {
  if (!arr || arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}
function stddev(arr) {
  if (!arr || arr.length < 2) return 0;
  const m = safeMean(arr);
  return Math.sqrt(safeMean(arr.map((v) => (v - m) ** 2)));
}
function linearRegressionSlope(arr) {
  const n = arr.length;
  if (n < 2) return 0;
  const x = [...Array(n).keys()];
  const xMean = safeMean(x);
  const yMean = safeMean(arr);
  let num = 0,
    den = 0;
  for (let i = 0; i < n; i++) {
    num += (x[i] - xMean) * (arr[i] - yMean);
    den += (x[i] - xMean) ** 2;
  }
  return den === 0 ? 0 : num / den;
}
function slopeAndT(arr) {
  // returns { slope, tstat } where tstat = slope / SE(slope)
  const n = arr.length;
  if (n < 3) return { slope: 0, t: 0 };
  const x = [...Array(n).keys()];
  const xMean = safeMean(x);
  const yMean = safeMean(arr);
  let num = 0,
    den = 0;
  for (let i = 0; i < n; i++) {
    num += (x[i] - xMean) * (arr[i] - yMean);
    den += (x[i] - xMean) ** 2;
  }
  const slope = den === 0 ? 0 : num / den;
  // residuals and standard error
  let sse = 0;
  for (let i = 0; i < n; i++) {
    const yhat = yMean + slope * (x[i] - xMean);
    sse += (arr[i] - yhat) ** 2;
  }
  const mse = sse / Math.max(1, n - 2);
  const seB = den === 0 ? 0 : Math.sqrt(mse / den);
  const t = seB === 0 ? 0 : slope / seB;
  return { slope, t };
}
function simpleSMA(arr, len) {
  if (arr.length < len) return null;
  return safeMean(arr.slice(-len));
}
function formatPrice(p) {
  return Number(p).toFixed(5);
}
function returnsArray(quotes) {
  const r = [];
  for (let i = 1; i < quotes.length; i++) r.push(quotes[i] - quotes[i - 1]);
  return r;
}
function updateEWMA(price) {
  if (ewmaPrice === null) ewmaPrice = price;
  else ewmaPrice = EWMA_ALPHA * price + (1 - EWMA_ALPHA) * ewmaPrice;
  return ewmaPrice;
}
function zscore(value, arr) {
  const s = stddev(arr);
  const m = safeMean(arr);
  if (s === 0) return 0;
  return (value - m) / s;
}
function cusumDetector(returnsArr) {
  // simple one-sided CUSUM magnitude over last CUSUM_WINDOW
  const len = Math.min(CUSUM_WINDOW, returnsArr.length);
  if (len <= 1) return 0;
  let pos = 0,
    neg = 0;
  const window = returnsArr.slice(-len);
  const k = 0; // reference value (0 for detecting persistent mean shifts)
  for (let i = 0; i < window.length; i++) {
    pos = Math.max(0, pos + window[i] - k);
    neg = Math.min(0, neg + window[i] + k);
  }
  return Math.max(pos, -neg); // return magnitude
}
function tradesInLastHour() {
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  tradesThisHour = tradesThisHour.filter((t) => t >= oneHourAgo);
  return tradesThisHour.length;
}
function updateTradeHistory(profit) {
  tradeHistory.push({ profit: Number(profit), timestamp: Date.now() });
  if (tradeHistory.length > 1000) tradeHistory.shift();
}
function computeEV() {
  // simple EV over last TRADE_HISTORY_LOOKBACK trades: EV = mean(profit)
  const recent = tradeHistory.slice(-TRADE_HISTORY_LOOKBACK);
  if (recent.length === 0) return 0;
  const avg = safeMean(recent.map((r) => r.profit));
  return avg;
}
function computeWinRate() {
  const recent = tradeHistory.slice(-TRADE_HISTORY_LOOKBACK);
  if (recent.length === 0) return 0;
  const wins = recent.filter((r) => r.profit > 0).length;
  return wins / recent.length;
}

// === LOGGING ===
function logStats() {
  const L = ticks.length;
  if (L < MIN_TICKS_BEFORE_TRADE) return;
  const quotes = ticks.map((t) => t.quote);

  const regWindow = quotes.slice(-Math.min(REGRESSION_WINDOW, quotes.length));
  const { slope, t } = slopeAndT(regWindow);

  const sma50 = simpleSMA(quotes, 50);
  const sma200 = simpleSMA(quotes, 200);
  const vol = stddev(returnsArray(quotes).slice(-VOL_WINDOW));

  console.log(
    `[STATS] last=${formatPrice(quotes[quotes.length - 1])} | slope=${slope.toFixed(
      6
    )} | t=${t.toFixed(2)} | vol=${vol.toExponential(2)} | SMA50=${sma50?.toFixed(
      5
    )} | SMA200=${sma200?.toFixed(5)} | EV=${computeEV().toFixed(4)} | WR=${(
      computeWinRate() * 100
    ).toFixed(1)}%`
  );
}

// === WEBSOCKET ===
function init() {
  ws = new WSClass(`wss://ws.binaryws.com/websockets/v3?app_id=${APP_ID}`);

  ws.onopen = () => {
    console.log("Connected ✅");
    ws.send(JSON.stringify({ authorize: TOKEN }));
  };

  ws.onmessage = (msg) => {
    const data = JSON.parse(msg.data);
    if (data.error) {
      console.error("❌ API Error:", data.error.message);
      return;
    }

    if (data.msg_type === "authorize") {
      console.log("Authorized ✅", data.authorize && data.authorize.loginid);
      ws.send(
        JSON.stringify({
          ticks_history: SYMBOL,
          count: HISTORY_COUNT,
          end: "latest",
          style: "ticks",
        })
      );
    }

    if (data.msg_type === "history") {
      ticks = data.history.prices.map((p, i) => ({
        epoch: data.history.times[i],
        quote: Number(p),
      }));
      console.log(`History loaded: ${ticks.length} ticks`);
      ws.send(JSON.stringify({ ticks: SYMBOL, subscribe: 1 }));
    }

    if (data.msg_type === "tick") {
      const q = Number(data.tick.quote);
      ticks.push({ epoch: data.tick.epoch, quote: q });
      if (ticks.length > HISTORY_COUNT) ticks.shift();

      updateEWMA(q);
      logStats();
      tradingLogic();
    }

    if (data.msg_type === "proposal" && data.proposal && awaitingProposal) {
      ws.send(JSON.stringify({ buy: data.proposal.id, price: STAKE }));
      awaitingProposal = false;
    }

    if (data.msg_type === "buy") {
      mainContractId = data.buy.contract_id;
      mainBuyPrice = Number(data.buy.buy_price);
      mainContractTickCounter = 0;
      lastTradeTime = Date.now(); // start cooldown
      tradesThisHour.push(Date.now());
      console.log(
        `Bought ${pendingDirection} contract ${mainContractId} at ${mainBuyPrice}`
      );
      ws.send(
        JSON.stringify({
          proposal_open_contract: 1,
          contract_id: mainContractId,
          subscribe: 1,
        })
      );
    }

    if (data.msg_type === "proposal_open_contract") {
      const poc = data.proposal_open_contract;
      if (poc.contract_id !== mainContractId) return;

      if (!poc.is_sold) {
        mainContractTickCounter++;
        console.log(
          `Contract ${mainContractId} tick #${mainContractTickCounter} | profit=${poc.profit}`
        );

        if (
          mainContractTickCounter >= CONTRACT_DURATION_TICKS &&
          Number(poc.profit) < AUTO_CLOSE_LOSS_THRESHOLD
        ) {
          if (poc.is_valid_to_sell) {
            console.log(`Auto-selling ${mainContractId}`);
            ws.send(JSON.stringify({ sell: mainContractId, price: 0 }));
          }
        }
      } else {
        console.log(`Contract ${mainContractId} closed. profit=${poc.profit}`);
        updateTradeHistory(Number(poc.profit));
        mainContractId = null;
      }
    }

    if (data.msg_type === "sell") {
      console.log("Sell response:", data.sell);
      mainContractId = null;
    }
  };

  ws.onclose = () => {
    console.log("WebSocket closed ❌ Reconnecting...");
    setTimeout(init, 2000);
  };

  ws.onerror = (err) => {
    console.error("WebSocket error", err && err.message ? err.message : err);
  };
}

// === TRADING ===
function requestTradeProposal(direction) {
  // basic readiness and cooldown checks
  if (awaitingProposal || !ws || ws.readyState !== 1) return;
  // hour cap
  if (tradesInLastHour() >= MAX_TRADES_PER_HOUR) {
    console.log("Hourly trade cap reached → skipping trade");
    return;
  }
  awaitingProposal = true;
  pendingDirection = direction;
  ws.send(
    JSON.stringify({
      proposal: 1,
      amount: STAKE,
      basis: "stake",
      contract_type: direction,
      currency: "USD",
      duration: CONTRACT_DURATION_TICKS,
      duration_unit: "s", // seconds
      symbol: SYMBOL,
    })
  );
}

function tradingLogic() {
  if (mainContractId || ticks.length < MIN_TICKS_BEFORE_TRADE) return;

  // cooldown
  if (Date.now() - lastTradeTime < TRADE_COOLDOWN_MS) return;

  const quotes = ticks.map((t) => t.quote);
  const returns = returnsArray(quotes);
  const vol = stddev(returns.slice(-VOL_WINDOW));

  // Volatility regime filter
  if (vol < VOL_MIN || vol > VOL_MAX) {
    // too quiet or too noisy
    // console.log("Vol filter blocked (vol)", vol);
    return;
  }

  // Regression and t-test
  const regWindow = quotes.slice(-Math.min(REGRESSION_WINDOW, quotes.length));
  const { slope, t } = slopeAndT(regWindow);

  // Normalized slope (unitless)
  const meanPrice = Math.max(1e-8, safeMean(regWindow));
  const normSlope = Math.abs(slope / meanPrice);

  if (Math.abs(t) < SLOPE_T_CRIT) {
    // t-stat not significant
    // console.log("T-stat too low", t);
    return;
  }
  if (normSlope < NORM_SLOPE_MIN) {
    // slope too small relative to price
    // console.log("Normalized slope too small", normSlope);
    return;
  }

  // EWMA trend direction (smoothed)
  const ewma = ewmaPrice === null ? regWindow[regWindow.length - 1] : ewmaPrice;
  const ewmaDir = slope > 0 ? 1 : slope < 0 ? -1 : 0;

  // SMA z-score confirmation
  const sma50 = simpleSMA(quotes, 50);
  const sma200 = simpleSMA(quotes, 200);
  if (sma50 === null || sma200 === null) return;
  const smaDiff = sma50 - sma200;
  // compute zscore of smaDiff using recent smaDiff history (approx using last 200 diffs)
  // build diff history quickly:
  const diffs = [];
  for (let i = 200; i < quotes.length; i++) {
    if (i - 200 + 200 <= quotes.length) {
      const s50 = simpleSMA(quotes.slice(0, i + 1), 50);
      const s200 = simpleSMA(quotes.slice(0, i + 1), 200);
      if (s50 !== null && s200 !== null) diffs.push(s50 - s200);
    }
  }
  // fallback if diffs unavailable
  const zSMA = diffs.length >= 10 ? zscore(smaDiff, diffs) : smaDiff / Math.max(1e-8, Math.abs(meanPrice));
  if (Math.abs(zSMA) < ZSMA_THRESHOLD) {
    // console.log("SMA zscore not extreme enough", zSMA);
    return;
  }

  // CUSUM - require persistent shift
  const cusum = cusumDetector(returns);
  if (cusum < CUSUM_THRESHOLD) {
    // console.log("CUSUM not exceeded", cusum);
    return;
  }

  // Simple ensemble scoring (each filter gives 1 point)
  let score = 0;
  // slope sign + EWMA direction agreement
  if (slope > 0 && ewmaDir > 0) score++;
  if (slope < 0 && ewmaDir < 0) score++;
  // SMA crossover direction
  if (sma50 > sma200 && slope > 0) score++;
  if (sma50 < sma200 && slope < 0) score++;
  // t-stat significance
  if (Math.abs(t) >= SLOPE_T_CRIT) score++;
  // SMA zscore
  if (Math.abs(zSMA) >= ZSMA_THRESHOLD) score++;
  // CUSUM
  if (cusum >= CUSUM_THRESHOLD) score++;

  const requiredScore = 4; // require at least 4/6 confirmations
  if (score < requiredScore) {
    // console.log("Ensemble score too low", score);
    return;
  }

  // Expected Value filter from recent trades (simple mean profit)
  const ev = computeEV();
  if (ev < MIN_EV && tradeHistory.length >= 10) {
    // if we have enough history and EV negative/small, skip
    // console.log("EV too low", ev);
    return;
  }

  // Final decision
  const bullCondition = slope > 0 && sma50 > sma200;
  const bearCondition = slope < 0 && sma50 < sma200;

  console.log(
    `[DECIDE] slope=${slope.toFixed(6)} t=${t.toFixed(2)} normSlope=${normSlope.toExponential(
      2
    )} | vol=${vol.toExponential(2)} | zSMA=${zSMA.toFixed(2)} | cusum=${cusum.toExponential(2)} | score=${score}`
  );

  if (bullCondition) {
    console.log("CALL condition met → proposal");
    requestTradeProposal("CALL");
  } else if (bearCondition) {
    console.log("PUT condition met → proposal");
    requestTradeProposal("PUT");
  } else {
    // no directional agreement
  }
}

// === START ===
init();
