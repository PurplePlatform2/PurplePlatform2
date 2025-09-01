// deriv-strategy-martingale-once.js
// Runs ONE strategy cycle per load, applies martingale until win

/* === CONFIG === */
const APP_ID = 1089; // Replace with your app_id
const TOKEN = "tUgDTQ6ZclOuNBl"; // Replace with your token
const SYMBOL = "stpRNG"; // Example symbol
const BASE_STAKE = 0.35; // Base stake in USD
const DURATION = 15;
const DURATION_UNIT = "s";

// Martingale
const MARTINGALE_MULTIPLIER = 2.0;
const MARTINGALE_MAX_STEPS = 5;

/* === WebSocket === */
const WS_URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const WSClass =
  typeof globalThis !== "undefined" && globalThis.WebSocket
    ? globalThis.WebSocket
    : (typeof require !== "undefined" ? require("ws") : null);

if (!WSClass) throw new Error("WebSocket not found. Use browser or install 'ws'.");

let ws = new WSClass(WS_URL);

/* === State === */
let contractType = null;
let inTrade = false;
let lastContractId = null;
let pocSubId = null;
let currentStake = BASE_STAKE;
let lossStreak = 0;

/* === Helpers === */
function send(msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function unsubscribe(id) {
  if (id) send({ unsubscribe: id });
}

function toNum(arr) {
  return arr.map(v => +v);
}

/* === Flow === */
ws.onopen = () => {
  console.log("Connected ✅");
  send({ authorize: TOKEN });
};

ws.onmessage = (msg) => {
  const data = JSON.parse(msg.data);
  if (data.error) {
    console.error("Error:", data.error.message);
    return;
  }

  switch (data.msg_type) {
    case "authorize":
      console.log("Authorized");
      fetchCandles();
      break;

    case "candles":
      handleCandles(data.candles);
      break;

    case "history":
      if (data.history?.prices) handleTicks(data.history.prices);
      break;

    case "buy":
      if (data.buy?.contract_id) {
        lastContractId = data.buy.contract_id;
        inTrade = true;
        console.log("Trade opened:", lastContractId, "stake=", currentStake.toFixed(2));
        send({
          proposal_open_contract: 1,
          contract_id: lastContractId,
          subscribe: 1,
        });
      }
      break;

    case "proposal_open_contract":
      handlePOC(data);
      break;
  }
};

/* === Candle check === */
function fetchCandles() {
  send({
    ticks_history: SYMBOL,
    style: "candles",
    granularity: 60,
    count: 4,
    end: "latest",
  });
}

function handleCandles(c) {
  if (c.length < 4) return;

  const sorted = c.slice().sort((a, b) => a.epoch - b.epoch);
  const prevClose = +sorted[2].close;
  const high2 = +sorted[1].high;
  const high3 = +sorted[0].high;
  const low2 = +sorted[1].low;
  const low3 = +sorted[0].low;

  if (prevClose > high2 && prevClose > high3) {
    contractType = "CALL";
  } else if (prevClose < low2 && prevClose < low3) {
    contractType = "PUT";
  } else {
    console.log("No signal, exiting.");
    ws.close();
    return;
  }
  console.log("Signal:", contractType);
  fetchTicks();
}

/* === Regression filter === */
function fetchTicks() {
  send({
    ticks_history: SYMBOL,
    style: "ticks",
    count: 100,
    end: "latest",
  });
}

function handleTicks(pricesRaw) {
  if (!contractType) return;
  const prices = toNum(pricesRaw);
  const n = prices.length;
  if (n < 2) return;

  const xMean = (n - 1) / 2;
  const yMean = prices.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    const dx = i - xMean;
    num += dx * (prices[i] - yMean);
    den += dx * dx;
  }
  const slope = num / den;
  console.log("Slope:", slope);

  if ((contractType === "CALL" && slope > 0) ||
      (contractType === "PUT" && slope < 0)) {
    placeTrade(contractType);
  } else {
    console.log("Regression blocked trade. Exiting.");
    ws.close();
  }
}

/* === Place trade === */
function placeTrade(type) {
  send({
    buy: 1,
    price: currentStake,
    parameters: {
      symbol: SYMBOL,
      contract_type: type,
      duration: DURATION,
      duration_unit: DURATION_UNIT,
      basis: "stake",
      amount: currentStake,
      currency: "USD",
    },
  });
}

/* === Proposal Open Contract handling === */
function handlePOC(data) {
  const poc = data.proposal_open_contract;
  if (!poc) return;
  if (!pocSubId && data.subscription?.id) pocSubId = data.subscription.id;

  const profit = +poc.profit;
  const isSold = !!poc.is_sold;

  console.log(`POC update: profit=${profit.toFixed(2)} sold=${isSold}`);

  if (isSold) {
    if (profit < 0) {
      lossStreak++;
      if (lossStreak <= MARTINGALE_MAX_STEPS) {
        currentStake *= MARTINGALE_MULTIPLIER;
        console.log("Loss. Next stake:", currentStake.toFixed(2));
        placeTrade(contractType);
      } else {
        console.log("Max martingale reached. Stopping.");
        ws.close();
      }
    } else {
      console.log("Win ✅ Martingale finished.");
      ws.close();
    }
  }
}
