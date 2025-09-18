/* === Multiplier Trade Bot (cleaned & merged) ===
   - Node.js & Browser compatible
   - 15-tick lookback entry (mean/reversion style)
   - Single websocket session, single authorize
   - Balance & profit_table checks before buy
   - Auto-close on profit target
*/

let WSClass;
if (typeof window !== "undefined" && window.WebSocket) {
  WSClass = window.WebSocket; // Browser
} else {
  WSClass = require("ws"); // Node.js
}

/* === CONFIG === */
const APP_ID = 1089;
const TOKEN = "tUgDTQ6ZclOuNBl"; // 🔐 Replace with your real token
const STAKE = 2;
const SYMBOL = "stpRNG";
const MULTIPLIER = 750;
const HISTORY_COUNT = 46; // ticks for entry check
const DURATION_LOOKBACK = 15; // how many ticks ago to compare
const ENTRY_DIFF = 1.0; // entry threshold (use 0.8, 1.0 etc if you want stronger edge)
const MAX_PROFIT = 0.01; // Auto-close when profit reaches this
const MIN_BALANCE = 50; // minimum balance required

/* === STATE === */
const ws = new WSClass(`wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`);
let lastTicks = [];
let contract_id = null;
let tradeReady = false;
let selectedDirection = null; // MULTUP or MULTDOWN
let accountBalance = 0;
let subscribedTicks = false;
let authorized = false;
let lastBuyPayload = null; // debug: store last buy attempt
let awaitingBuyResponse = false;

/* === Helpers === */
function round2(num) {
  return Math.round(num * 100) / 100;
}

function sendWhenReady(msg) {
  const payload = JSON.stringify(msg);
  if (ws && ws.readyState === 1) {
    ws.send(payload);
  } else {
    // wait for the socket to open
    setTimeout(() => sendWhenReady(msg), 100);
  }
}

function logTS(...args) {
  console.log(new Date().toISOString(), ...args);
}

/* === Entry Logic === */
function tryPatternAndTradeFromTicks() {
  if (lastTicks.length < DURATION_LOOKBACK + 1) return;

  const current = lastTicks[lastTicks.length - 1].quote;
  const previous = lastTicks[lastTicks.length - 1 - DURATION_LOOKBACK].quote;
  const diff = round2(current - previous);

  logTS(`📏 Difference (current - ${DURATION_LOOKBACK} ago) = ${diff}`);

  if (diff >= ENTRY_DIFF || diff <= -ENTRY_DIFF) {
    tradeReady = true;
    // If price increased (diff > 0) sell the up-multiplier (bet down), else bet up
    selectedDirection = diff > 0 ? "MULTDOWN" : "MULTUP";
    logTS(`✅ Condition met (${diff}) → preparing ${selectedDirection} trade`);
    attemptBuyIfReady();
  } else {
    // Only subscribe to live ticks once we've got sufficient history
    if (!subscribedTicks && lastTicks.length >= HISTORY_COUNT) {
      sendWhenReady({ ticks: SYMBOL, subscribe: 1 });
      subscribedTicks = true;
      logTS("🔔 Subscribed to live ticks");
    } else {
      logTS("❌ Condition not met. Waiting for next tick...");
    }
  }
}

function attemptBuyIfReady() {
  if (!tradeReady || !selectedDirection) return;
  if (!authorized) {
    logTS("⏳ Trade ready but waiting for authorization & balance...");
    return;
  }
  if (awaitingBuyResponse) {
    logTS("⏳ Already sent a buy request, awaiting response...");
    return;
  }
  if (accountBalance < MIN_BALANCE) {
    logTS(`⛔ Balance $${accountBalance} below minimum $${MIN_BALANCE}. Aborting buy.`);
    return;
  }
  if (contract_id) {
    logTS(`⚠️ There's already an open contract (${contract_id}). Not opening another.`);
    return;
  }

  // Build buy payload (keeps the simple format used in your studied code)
  const buyPayload = {
    buy: 1,
    price: STAKE,
    parameters: {
      amount: STAKE,
      basis: "stake",
      contract_type: selectedDirection, // MULTUP or MULTDOWN
      currency: "USD",
      multiplier: MULTIPLIER,
      symbol: SYMBOL,
    },
  };

  lastBuyPayload = buyPayload; // store for debugging if an error occurs
  awaitingBuyResponse = true;
  sendWhenReady(buyPayload);
  logTS("🚀 Multiplier BUY request sent", JSON.stringify(buyPayload));
}

/* === WebSocket Flow === */
ws.onopen = () => {
  logTS("🔌 Connecting...");

  // Authorize immediately so we can query balance & profit_table and be ready to buy.
  sendWhenReady({ authorize: TOKEN });

  // Also request history (we'll receive 'history' and populate lastTicks)
  sendWhenReady({
    ticks_history: SYMBOL,
    count: HISTORY_COUNT,
    end: "latest",
    style: "ticks",
  });
};

ws.onmessage = (msg) => {
  const data = JSON.parse(msg.data || msg);

  // Log raw error payloads with code/message if present
  if (data.error) {
    logTS("❌ DERIV ERROR:", JSON.stringify(data.error));
    // If we recently tried to buy, show the payload we sent to help debugging
    if (lastBuyPayload) {
      logTS("🔎 Last buy payload (for debugging):", JSON.stringify(lastBuyPayload));
    }
    // Reset buy-wait flag so the bot can attempt again later
    awaitingBuyResponse = false;
    return;
  }

  switch (data.msg_type) {
    case "history":
      // 'history.prices' and 'history.times' expected
      lastTicks = data.history.prices.map((p, i) => ({
        epoch: data.history.times[i],
        quote: p,
      }));
      logTS(`📊 Loaded ${lastTicks.length} ticks`);
      tryPatternAndTradeFromTicks();
      break;

    case "tick":
      lastTicks.push({ epoch: data.tick.epoch, quote: data.tick.quote });
      if (lastTicks.length > HISTORY_COUNT) lastTicks.shift();
      logTS(`💹 Tick: ${data.tick.quote}`);
      if (!tradeReady) tryPatternAndTradeFromTicks();
      break;

    case "authorize":
      authorized = true;
      logTS("✅ Authorized:", data.authorize && data.authorize.loginid ? data.authorize.loginid : "(no loginid)");
      // Fetch account balance and recent profit_table to detect open trades
      sendWhenReady({ balance: 1 });
      sendWhenReady({ profit_table: 1, description: 1, limit: 10 });
      break;

    case "balance":
      accountBalance = +data.balance.balance;
      logTS(`💰 Account Balance: $${accountBalance}`);
      // If trade was already ready when auth returned, try to buy
      attemptBuyIfReady();
      break;

    case "profit_table":
      // Close any open trades (best-effort). Open trades often show sell_price === 0 or is_sold false.
      if (data.profit_table && data.profit_table.transactions && data.profit_table.transactions.length > 0) {
        data.profit_table.transactions.forEach((tx) => {
          // Best-effort detection; structure can vary depending on account/contract types
          const isOpen = (!tx.sell_price || tx.sell_price === 0) || tx.is_sold === false;
          if (isOpen && tx.contract_id) {
            logTS(`⚠️ Open trade found on startup → contract_id=${tx.contract_id}, attempting to close...`);
            sendWhenReady({ sell: tx.contract_id, price: 0 });
          }
        });
      }
      break;

    case "buy":
      awaitingBuyResponse = false;
      if (data.buy && data.buy.contract_id) {
        contract_id = data.buy.contract_id;
        logTS("✅ Bought contract:", contract_id);

        // Subscribe to contract updates for this contract
        sendWhenReady({
          proposal_open_contract: 1,
          contract_id,
          subscribe: 1,
        });
      } else {
        // Unexpected buy response shape — log for debugging
        logTS("⚠️ Unexpected buy response:", JSON.stringify(data));
      }
      break;

    case "proposal_open_contract": {
      const poc = data.proposal_open_contract;
      // Normalize profit to number if string-like
      const profit = typeof poc.profit === "string" ? parseFloat(poc.profit) : poc.profit;

      // Log both contract update and latest tick (if available) to help pairing
      const latestTick = lastTicks.length ? lastTicks[lastTicks.length - 1].quote : "n/a";
      logTS(
        `📊 Contract Update:
  contract_id: ${poc.contract_id}
  status: ${poc.status}
  entry_price: ${poc.buy_price}
  current_spot: ${poc.current_spot}
  profit: ${profit}
  latest_tick: ${latestTick}`
      );

      // Auto-close on profit target
      if (profit >= MAX_PROFIT && poc.status === "open") {
        logTS(`🛑 Closing trade: Profit reached ${profit}`);
        sendWhenReady({ sell: poc.contract_id, price: 0 });
      }

      // When closed, clean up
      if (poc.status !== "open") {
        logTS("🏁 Contract closed. Final Profit:", profit);

        // Unsubscribe ticks (best-effort)
        if (subscribedTicks) {
          sendWhenReady({ forget_all: "ticks" }); // best-effort; API supports forget_all in many cases
          subscribedTicks = false;
        }

        // Reset state to allow new trades
        contract_id = null;
        tradeReady = false;
        selectedDirection = null;
        lastBuyPayload = null;
      }
      break;
    }

    default:
      // other msg_types can be ignored or logged during debugging
      break;
  }
};

ws.onerror = (err) => {
  logTS("⚠️ WebSocket error:", err && (err.message || err));
};

ws.onclose = () => {
  logTS("🔌 WebSocket closed.");
};
