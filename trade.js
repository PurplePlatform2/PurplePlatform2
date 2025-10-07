/* === 15-Tick Difference Strategy Bot (Improved) ===
   - Single trade lock
   - 15-tick difference rule + SMA confirmation
   - Volatility filter (avoid flat markets)
   - Adaptive stake (soft anti-martingale)
   - Cooldown after each trade (default 30s)
   - Hedge mode when 5 consecutive losses detected (×2 stake)
   - Detailed logging, auto-reconnect, Node.js + Browser compatible
*/

const WSClass = typeof window !== "undefined" && window.WebSocket ? window.WebSocket : require("ws");

/* === CONFIG === */
const APP_ID = 1089;
const TOKEN = "tUgDTQ6ZclOuNBl"; // Replace with your API token
const SYMBOL = "stpRNG";
let STAKE = 1;                 // base stake (USD)
const DURATION = 15;           // seconds
const PRICE_DIFF = 1.0;        // required difference for entry
const COOLDOWN_MS = 30_000;    // cooldown after trade (ms)
const HIST_LEN = 20;           // kept tick history length
const SMA_SHORT = 5;
const SMA_LONG = 15;
const VOL_THRESHOLD = 0.3;     // minimal volatility (price units) to allow trading
const PROFIT_TABLE_LIMIT = 5;  // how many last trades to check for losses -> hedge logic

/* === STATE === */
let ws = null;
let ticks = [];
let authorized = false;
let hedge = false;
let tradeActive = false;
let lastTradeId = null;
let cooldown = false;
let lossCountConsecutive = 0; // consecutive loss counter (local tracking)
let reconnectTries = 0;

/* === HELPERS === */
const log = (...a) => console.log(`[${new Date().toLocaleTimeString()}]`, ...a);

// Safe send (checks socket ready state)
function sendSafe(obj) {
  try {
    const payload = JSON.stringify(obj);
    if (ws && ws.readyState === ws.OPEN) {
      ws.send(payload);
    } else {
      log("⚠️ Can't send, socket not open. Buffering not implemented. Payload:", obj);
    }
  } catch (err) {
    log("❌ sendSafe error:", err.message);
  }
}

function sma(arr, len) {
  if (!arr || arr.length < len) return null;
  const slice = arr.slice(-len);
  const sum = slice.reduce((s, v) => s + v, 0);
  return sum / len;
}

function volatility(arr) {
  if (!arr || arr.length < 2) return 0;
  const min = Math.min(...arr);
  const max = Math.max(...arr);
  return max - min;
}

// Adaptive stake (soft anti-martingale)
function updateStakeFromProfit(profit) {
  if (profit > 0) {
    lossCountConsecutive = 0;
    STAKE = 1; // reset to base stake
  } else {
    lossCountConsecutive++;
    // increase stake gradually; cap at 3x base stake
    STAKE = +(1 * Math.min(3, 1 + lossCountConsecutive * 0.5)).toFixed(2);
  }
  // Hedge mode when 5 or more consecutive losses (also synced from profit_table)
  hedge = lossCountConsecutive >= 5;
  log(`💵 Stake set to ${STAKE} | Consecutive losses: ${lossCountConsecutive} | Hedge: ${hedge ? "ON (×2)" : "OFF"}`);
}

// Recompute lossCountConsecutive from profit_table (fallback to robust detection)
function recomputeLossesFromProfitTable(transactions = []) {
  // transactions assumed from newest -> oldest or as provided by API
  // find consecutive losses starting from the most recent
  let consecutive = 0;
  for (let i = 0; i < transactions.length; i++) {
    const t = transactions[i];
    if (t.profit < 0) consecutive++;
    else break;
  }
  lossCountConsecutive = consecutive;
  hedge = lossCountConsecutive >= 5;
  log(`🔁 Profit table sync -> consecutive losses: ${lossCountConsecutive} | Hedge: ${hedge ? "ON" : "OFF"}`);
}

/* === CONNECTION & RECONNECT === */
function connect() {
  const url = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
  ws = new WSClass(url);

  ws.onopen = () => {
    reconnectTries = 0;
    log("🌐 Connected to Deriv WS");
    // The older API used { authorize: TOKEN } — keep same as your original flow.
    sendSafe({ authorize: TOKEN });
  };

  ws.onmessage = (msg) => {
    let data;
    try {
      data = JSON.parse(msg.data);
    } catch (err) {
      return log("⚠️ Non-JSON message:", msg.data);
    }
    if (data.error) return log("⚠️ Error:", data.error.message);

    switch (data.msg_type) {
      case "authorize":
        authorized = true;
        log("✅ Authorized. Requesting last trades for hedge check...");
        // Request recent profit_table to check recent trades
        sendSafe({ profit_table: 1, limit: PROFIT_TABLE_LIMIT });
        break;

      case "profit_table": {
        const lastTx = (data.profit_table && data.profit_table.transactions) || [];
        log(`📊 Received profit_table with ${lastTx.length} transactions`);
        // recompute consecutive losses (start from newest transaction)
        recomputeLossesFromProfitTable(lastTx);
        // Request small history to prime ticks, then subscribe to live ticks
        sendSafe({ ticks_history: SYMBOL, count: HIST_LEN, end: "latest" });
        break;
      }

      case "history":
        // depending on API naming: `history.prices` or `history.prices` exists in old code
        if (data.history && data.history.prices) {
          ticks = data.history.prices.map(Number);
          // ensure we only keep HIST_LEN
          ticks = ticks.slice(-HIST_LEN);
          log(`📈 Loaded ${ticks.length} historical ticks`);
          sendSafe({ ticks: SYMBOL, subscribe: 1 });
          log("📡 Subscribed to live ticks for", SYMBOL);
        } else {
          log("⚠️ Unexpected history payload:", data);
        }
        break;

      case "tick": {
        const price = Number(data.tick.quote);
        if (Number.isNaN(price)) {
          log("⚠️ Ignoring NaN tick:", data.tick);
          break;
        }
        ticks.push(price);
        if (ticks.length > HIST_LEN) ticks.shift();
        log(`💹 Tick: ${price.toFixed(5)} | tickCount: ${ticks.length}`);

        if (!tradeActive && !cooldown && ticks.length >= SMA_LONG) {
          analyze(price);
        }
        break;
      }

      case "buy":
        // buy response: store buy_id and subscribe to open contract updates
        lastTradeId = data.buy && data.buy.buy_id;
        tradeActive = true;
        log(`🎯 Trade opened | ID: ${lastTradeId}`);
        if (lastTradeId) sendSafe({ proposal_open_contract: 1, contract_id: lastTradeId, subscribe: 1 });
        break;

      case "proposal_open_contract": {
        const c = data.proposal_open_contract;
        if (!c) break;
        // When open contract becomes sold, this indicates closure
        if (c.is_sold) {
          tradeActive = false;
          const profit = Number(c.profit || 0);
          log(`💰 Trade closed | ID:${c.contract_id || lastTradeId} | Entry: ${c.entry_spot} | Exit: ${c.exit_spot} | Profit: ${profit.toFixed(2)} USD`);
          // update local stake/lose counters
          updateStakeFromProfit(profit);
          // Request profit_table again to remain in sync (and detect hedge state robustly)
          sendSafe({ profit_table: 1, limit: PROFIT_TABLE_LIMIT });

          // start cooldown
          startCooldown();
        } else {
          // open contract ongoing; log some useful info
          log(`📌 Open contract update | ID:${c.contract_id || lastTradeId} | entry:${c.entry_spot}`);
        }
        break;
      }

      default:
        // handle other message types lightly
        // log("🔹 msg_type:", data.msg_type);
        break;
    }
  };

  ws.onerror = (e) => {
    // Browser error event may not include message; handle gracefully
    const errMsg = e && e.message ? e.message : JSON.stringify(e);
    log("❌ WebSocket error:", errMsg);
  };

  ws.onclose = (ev) => {
    log(`🔌 Connection closed (code: ${ev && ev.code ? ev.code : "unknown"})`);
    // attempt reconnect with exponential backoff (cap)
    reconnectTries++;
    const backoff = Math.min(30_000, 1000 * Math.pow(1.6, Math.min(10, reconnectTries)));
    log(`♻️ Reconnecting in ${Math.round(backoff)} ms... (attempt ${reconnectTries})`);
    setTimeout(() => connect(), backoff);
  };
}

/* === COOLDOWN === */
function startCooldown() {
  cooldown = true;
  setTimeout(() => {
    cooldown = false;
    log("⏳ Cooldown finished. Ready for entries.");
  }, COOLDOWN_MS);
}

/* === ANALYZE & TRADE === */
function analyze(price) {
  const past = ticks[ticks.length - 15];
  if (typeof past === "undefined") return;

  const diff = price - past;
  const smaShort = sma(ticks, SMA_SHORT);
  const smaLong = sma(ticks, SMA_LONG);
  const vol = volatility(ticks.slice(-SMA_LONG));

  log(`📊 Analyzing | Now: ${price.toFixed(5)} | 15t ago: ${past.toFixed(5)} | Δ: ${diff.toFixed(5)} | SMA${SMA_SHORT}:${smaShort ? smaShort.toFixed(5) : "n/a"} | SMA${SMA_LONG}:${smaLong ? smaLong.toFixed(5) : "n/a"} | Vol:${vol.toFixed(5)}`);

  // Volatility filter: skip small-moving markets
  if (vol < VOL_THRESHOLD) {
    log("😴 Market too quiet (vol < threshold). Skipping entry.");
    return;
  }

  // Trend confirmation: require short SMA to confirm the direction
  const trendUp = smaShort !== null && smaLong !== null && smaShort > smaLong;
  const trendDown = smaShort !== null && smaLong !== null && smaShort < smaLong;

  if (diff >= PRICE_DIFF && trendDown) {
    log(`🔻 SELL signal confirmed | Diff: +${diff.toFixed(3)} >= ${PRICE_DIFF} and trendDown`);
    trade("PUT");
  } else if (diff <= -PRICE_DIFF && trendUp) {
    log(`🔼 BUY signal confirmed | Diff: ${diff.toFixed(3)} <= -${PRICE_DIFF} and trendUp`);
    trade("CALL");
  } else {
    log("🔎 Signal not confirmed by trend or diff not large enough. No trade.");
  }
}

/* === BUY CONTRACT === */
function trade(type) {
  if (tradeActive) return log("⏳ Trade already active. Waiting for close...");
  if (cooldown) return log("⏳ In cooldown. Skipping trade attempt.");

  // stake may be doubled in hedge mode
  const stake = +( (hedge ? STAKE * 2 : STAKE) ).toFixed(2);
  log(`🚀 Attempting to open ${type} | Stake: ${stake} | Duration: ${DURATION}s | Hedge: ${hedge ? "ON" : "OFF"}`);

  const payload = {
    buy: 1,
    price: 100,
    parameters: {
      amount: stake,
      basis: "stake",
      contract_type: type,
      currency: "USD",
      duration: DURATION,
      duration_unit: "s",
      symbol: SYMBOL,
    },
  };

  sendSafe(payload);
  // mark tradeActive optimistically; will be cleared when closed (or on error)
  tradeActive = true;
}

/* === START === */
connect();

// export for Node.js (optional) to allow require(...) usage and external control
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    connect,
    getState: () => ({
      ticks,
      tradeActive,
      cooldown,
      hedge,
      STAKE,
      lossCountConsecutive,
    }),
  };
}
