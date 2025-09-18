//Trading Multipliers with 1.0 mean reversion
//Muktipliers
/* === Multiplier Trade Bot with 15-tick ±1.0 Entry + Balance & History Check === */

// Auto-detect WebSocket
let WSClass;
if (typeof window !== "undefined" && window.WebSocket) {
  WSClass = window.WebSocket; // Browser
} else {
  WSClass = require("ws"); // Node.js
}

/* === CONFIG === */
const APP_ID = 1089;
const TOKEN = "tUgDTQ6ZclOuNBl"; // 🔐 Replace with your real token
const STAKE = 100;
const SYMBOL = "stpRNG";
const MULTIPLIER = 750;
const HISTORY_COUNT = 46; // ticks for entry check
const DURATION_LOOKBACK = 15; // how many ticks ago to compare
const ENTRY_DIFF = 1.0; // entry threshold
const MAX_PROFIT = 0.01; // ✅ Auto-close when profit hits this
const MIN_BALANCE = 50; // ✅ minimum balance required

/* === STATE === */
let ws = new WSClass(`wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`);
let lastTicks = [];
let contract_id = null;
let tradeReady = false;
let selectedDirection = null; // MULTUP or MULTDOWN
let accountBalance = 0;
let subscribed = false; // ✅ prevent multiple subscriptions

/* === Helpers === */
function round2(num) {
  return Math.round(num * 100) / 100;
}

function sendWhenReady(msg) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify(msg));
  } else {
    setTimeout(() => sendWhenReady(msg), 100);
  }
}

/* === Entry Logic === */
function tryPatternAndTradeFromTicks() {
  if (lastTicks.length < DURATION_LOOKBACK + 1) return;

  const diff = round2(
    lastTicks[lastTicks.length - 1].quote -
      lastTicks[lastTicks.length - 1 - DURATION_LOOKBACK].quote
  );

  console.log(`📏 Difference (current - ${DURATION_LOOKBACK} ago) = ${diff}`);

  if (diff >= ENTRY_DIFF || diff <= -ENTRY_DIFF) {
    tradeReady = true;
    selectedDirection = diff > 0 ? "MULTDOWN" : "MULTUP"; // breakout style
    console.log(
      `✅ Condition met (${diff}) → preparing ${selectedDirection} trade`
    );
    sendWhenReady({ authorize: TOKEN });
  } else {
    console.log("❌ Condition not met. Waiting for next tick...");
    // Subscribe to live ticks once only
    if (!subscribed && lastTicks.length >= HISTORY_COUNT) {
      sendWhenReady({ ticks: SYMBOL, subscribe: 1 });
      subscribed = true;
    }
  }
}

/* === WebSocket Flow === */
ws.onopen = () => {
  console.log("🔌 Connecting...");
  sendWhenReady({
    ticks_history: SYMBOL,
    count: HISTORY_COUNT,
    end: "latest",
    style: "ticks",
  });
};

ws.onmessage = (msg) => {
  const data = JSON.parse(msg.data || msg);

  if (data.error) {
    console.error("❌ Error:", data.error.message);
    return;
  }

  switch (data.msg_type) {
    case "history":
      lastTicks = data.history.prices.map((p, i) => ({
        epoch: data.history.times[i],
        quote: p,
      }));
      console.log(`📊 Loaded ${lastTicks.length} ticks`);
      tryPatternAndTradeFromTicks();
      break;

    case "tick":
      lastTicks.push({ epoch: data.tick.epoch, quote: data.tick.quote });
      if (lastTicks.length > HISTORY_COUNT) lastTicks.shift();
      console.log(`💹 Tick: ${data.tick.quote}`);
      if (!tradeReady) tryPatternAndTradeFromTicks();
      break;

    case "authorize":
      console.log("✅ Authorized:", data.authorize.loginid);

      // Request account balance
      sendWhenReady({ balance: 1, currency: "USD" });

      // Check recent trades (profit_table)
      sendWhenReady({ profit_table: 1, description: 1, limit: 10 });
      break;

    case "balance":
      accountBalance = +data.balance.balance;
      console.log(`💰 Account Balance: $${accountBalance}`);
      if (accountBalance < MIN_BALANCE) {
        console.log(`⛔ Balance below $${MIN_BALANCE}. Trade cancelled.`);
        ws.close();
      } else {
        console.log("✅ Balance sufficient. Ready to trade...");
        if (tradeReady && selectedDirection) {
          ws.send(
            JSON.stringify({
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
            })
          );
        }
      }
      break;

    case "profit_table":
      if (data.profit_table && data.profit_table.transactions.length > 0) {
        data.profit_table.transactions.forEach((tx) => {
          if (!tx.sell_price || tx.sell_price === 0) {
            console.log(
              `⚠️ Open trade found → contract_id=${tx.contract_id}, attempting to close...`
            );
            sendWhenReady({ sell: tx.contract_id, price: 0 });
          }
        });
      }
      break;

    case "buy":
      contract_id = data.buy.contract_id;
      console.log("✅ Bought contract:", contract_id);

      ws.send(
        JSON.stringify({
          proposal_open_contract: 1,
          contract_id,
          subscribe: 1,
        })
      );
      break;

    case "proposal_open_contract":
      const poc = data.proposal_open_contract;

      console.log(`📊 Contract Update:
        \ncontract_id: ${poc.contract_id},
        \nstatus: ${poc.status},
        \nentry_price: ${poc.buy_price},
        \ncurrent_spot: ${poc.current_spot},
        \nprofit: ${poc.profit}`
      );

      // ✅ Auto-close on profit
      if (poc.profit >= MAX_PROFIT && poc.status === "open") {
        console.log(`🛑 Closing trade: Profit reached ${poc.profit}`);
        ws.send(JSON.stringify({ sell: poc.contract_id, price: 0 }));
      }

      // End when closed
      if (poc.status !== "open") {
        console.log("🏁 Contract closed. Final Profit:", poc.profit);

        // 🔄 Clean up tick subscription
        if (subscribed) {
          sendWhenReady({ forget_all: "ticks" });
          subscribed = false;
        }

        ws.close();
      }
      break;
  }
};

ws.onerror = (err) => {
  console.error("⚠️ WebSocket error:", err.message || err);
};

ws.onclose = () => {
  console.log("🔌 WebSocket closed.");
};
