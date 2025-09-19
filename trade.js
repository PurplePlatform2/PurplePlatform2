/* === Multiplier Trade Bot (Optimized, Fixed POC NaN) === */

let WSClass;
if (typeof window !== "undefined" && window.WebSocket) {
  WSClass = window.WebSocket;
} else {
  WSClass = require("ws");
}

/* === CONFIG === */
const APP_ID = 1089;
const TOKEN = "tUgDTQ6ZclOuNBl";
const STAKE = 2;
const SYMBOL = "stpRNG";
const MULTIPLIER = 750;
const HISTORY_COUNT = 46;
const DURATION_LOOKBACK = 15;
const ENTRY_DIFF = 1.0;
const MAX_PROFIT = 0.01;
const MIN_BALANCE = 50;
const SingleTradeMode=false;
/* === STATE === */
const ws = new WSClass(`wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`);
let lastTicks = [];
let tradeReady = false;
let selectedDirection = null;
let accountBalance = 0;
let subscribedTicks = false;
let authorized = false;
let awaitingBuyResponse = false;

/* === Helpers === */
function round2(num) {
  return Math.round(num * 100) / 100;
}

function sendWhenReady(msg) {
  const payload = JSON.stringify(msg);
  if (ws && ws.readyState === 1) ws.send(payload);
  else setTimeout(() => sendWhenReady(msg), 100);
}

/* === Entry Logic === */
function tryPatternAndTradeFromTicks() {
  if (lastTicks.length < DURATION_LOOKBACK + 1) return;

  const current = lastTicks[lastTicks.length - 1].quote;
  const previous = lastTicks[lastTicks.length - 1 - DURATION_LOOKBACK].quote;
  const diff = round2(current - previous);

  console.log(`📏 Diff = ${diff}`);

  if (diff >= ENTRY_DIFF || diff <= -ENTRY_DIFF) {
    tradeReady = true;
    selectedDirection = diff > 0 ? "MULTDOWN" : "MULTUP";
    console.log(`✅ Entry → ${selectedDirection}`);
    attemptBuyIfReady();
  } else if (!subscribedTicks && lastTicks.length >= HISTORY_COUNT) {
    sendWhenReady({ ticks: SYMBOL, subscribe: 1 });
    subscribedTicks = true;
    console.log("🔔 Subscribed ticks");
  } else {
    console.log("…waiting");
  }
}

/* === Buy Logic === */
function attemptBuyIfReady() {
  if (!tradeReady || !selectedDirection || !authorized || awaitingBuyResponse || accountBalance < MIN_BALANCE) return;

  const buyPayload = {
    buy: 1,
    price: STAKE,
    parameters: {
      amount: STAKE,
      basis: "stake",
      contract_type: selectedDirection,
      multiplier: MULTIPLIER,
      currency: "USD",
      symbol: SYMBOL,
    },
  };

  awaitingBuyResponse = true;
  sendWhenReady(buyPayload);
  console.log("🚀 BUY sent");
}

/* === WebSocket Flow === */
ws.onopen = () => {
  console.log("🔌 Connecting...");
  sendWhenReady({ authorize: TOKEN });
  sendWhenReady({ ticks_history: SYMBOL, count: HISTORY_COUNT, end: "latest", style: "ticks" });
};

ws.onmessage = (msg) => {
  const data = JSON.parse(msg.data || msg);

  if (data.error) {
    console.log("❌ Error:", data.error.message);
    awaitingBuyResponse = false;
    return;
  }

  switch (data.msg_type) {
    case "history":
      lastTicks = data.history.prices.map((p, i) => ({ epoch: data.history.times[i], quote: p }));
      console.log(`📊 Loaded ${lastTicks.length} ticks`);
      tryPatternAndTradeFromTicks();
      break;

    case "tick":
      lastTicks.push({ epoch: data.tick.epoch, quote: data.tick.quote });
      if (lastTicks.length > HISTORY_COUNT) lastTicks.shift();
      console.log(`💹 ${data.tick.quote}`);
      if (!tradeReady) tryPatternAndTradeFromTicks();
      break;

    case "authorize":
      authorized = true;
      console.log("✅ Authorized");
      sendWhenReady({ balance: 1 });
      sendWhenReady({ proposal_open_contract: 1, subscribe: 1 });
      break;

    case "balance":
      accountBalance = +data.balance.balance;
      console.log(`💰 Balance: $${accountBalance}`);
      attemptBuyIfReady();
      break;

    case "buy":
      awaitingBuyResponse = false;
      if (data.buy?.contract_id) {
        console.log(`✅ Bought ${data.buy.contract_id}`);
        sendWhenReady({ proposal_open_contract: 1, contract_id: data.buy.contract_id, subscribe: 1 });
      }
      break;

    case "proposal_open_contract":
      const poc = data.proposal_open_contract;

      // Safe fallback values
      const spot = poc.current_spot ?? poc.entry_spot_display_value ?? poc.current_value ?? 0;
      const profit = poc.profit ?? (poc.current_value - poc.buy_price) ?? 0;
      const durationSec =
        Math.floor(Date.now() / 1000) - (poc.purchase_time || poc.start_time || Math.floor(Date.now() / 1000));

      console.log(`📊 Spot: ${spot} | P/L: ${profit} | Running: ${durationSec}s`);

      // Close if profit reached or 15s elapsed
      if (poc.status === "open" && (profit >= MAX_PROFIT || durationSec >= 15)) {
        console.log(`🛑 Closing trade ${poc.contract_id} (Profit: ${profit}, Time: ${durationSec}s)`);
        sendWhenReady({ sell: poc.contract_id, price: 0 });
      }

      // Reset state after closure
      if (poc.status !== "open") {
        console.log("🏁 Closed. Final P/L:", profit);
        if (subscribedTicks && SingleTradeMode) {
          sendWhenReady({ forget_all: "ticks" });
          subscribedTicks = false;
        }
        tradeReady = false;
        selectedDirection = null;
        awaitingBuyResponse = false;
      }
      break;
  }
};

ws.onerror = (err) => console.log("⚠️ Error:", err.message || err);
ws.onclose = () => console.log("🔌 Closed");
