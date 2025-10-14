/****************************************************
 *  TRADERXY_1MIN.js — 1-Minute Range Strategy
 *  Author: Dr. Sanne Karibo
 *  Description:
 *   - Every minute, checks if (high - low) ≤ 0.5
 *   - If true → places simultaneous BUY + SELL (CALL + PUT)
 *   - Runs continuously with auto-refresh each minute
 ****************************************************/

const APP_ID = 1089;
const TOKEN = "tUgDTQ6ZclOuNBl";
const SYMBOL = "stpRNG";
const BASE_STAKE = 1;
const DURATION =59;           // trade lasts 60 seconds
const DURATION_UNIT = "s";
const TICK_COUNT = 300;        // fetch 5 min worth of ticks (safety buffer)

const WS_URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const WSClass =
  typeof globalThis !== "undefined" && globalThis.WebSocket
    ? globalThis.WebSocket
    : (typeof require !== "undefined" ? require("ws") : null);
if (!WSClass) throw new Error("WebSocket not found.");

let ws = new WSClass(WS_URL);

/* === State === */
let lastTicks = [];
let stake = BASE_STAKE;
let tradeReady = false;
let contracts = { CALL: null, PUT: null };
let activeContracts = { CALL: null, PUT: null };
let results = { CALL: null, PUT: null };
let isAuthorizeRequested = false;
let proposalsRequested = false;
let buyInProgress = false;

/* === Helper === */
function sendWhenReady(msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
  else setTimeout(() => sendWhenReady(msg), 100);
}

function resetCycle() {
  contracts = { CALL: null, PUT: null };
  activeContracts = { CALL: null, PUT: null };
  results = { CALL: null, PUT: null };
  tradeReady = false;
  proposalsRequested = false;
  buyInProgress = false;
}

/* === Build 1-minute candle === */
function build1MinuteCandles(ticks) {
  if (!ticks.length) return [];
  const candles = [];
  let current = [];
  let startEpoch = Math.floor(ticks[0].epoch / 60) * 60;

  for (const tick of ticks) {
    const minuteStart = Math.floor(tick.epoch / 60) * 60;
    if (minuteStart !== startEpoch) {
      if (current.length > 0) {
        const open = current[0].quote;
        const close = current[current.length - 1].quote;
        const high = Math.max(...current.map(t => t.quote));
        const low = Math.min(...current.map(t => t.quote));
        candles.push({ open, high, low, close });
      }
      startEpoch = minuteStart;
      current = [];
    }
    current.push(tick);
  }

  // push last candle
  if (current.length > 0) {
    const open = current[0].quote;
    const close = current[current.length - 1].quote;
    const high = Math.max(...current.map(t => t.quote));
    const low = Math.min(...current.map(t => t.quote));
    candles.push({ open, high, low, close });
  }

  return candles;
}

/* === Core: range check === */
function checkRangeAndTrade() {
  const candles = build1MinuteCandles(lastTicks);
  if (candles.length < 2) return console.log("⏳ Waiting for more data...");

  const recent = candles[candles.length - 2]; // last completed 1-min candle
  const range = +(recent.high - recent.low).toFixed(2);
  console.log(`🕐 1-min candle range = ${range}`);

  if (range <= 0.5) {
    console.log("✅ Range ≤ 0.5 → prepare trade (CALL + PUT)");
    tradeReady = true;
    if (!isAuthorizeRequested) {
      sendWhenReady({ authorize: TOKEN });
      isAuthorizeRequested = true;
    } else {
      requestProposals();
    }
  } else {
    console.log("❌ Range > 0.5 → skip trade.");
  }
}

/* === WebSocket Flow === */
ws.onopen = () => {
  console.log("✅ Connected to Deriv WebSocket");
  sendWhenReady({ ticks_history: SYMBOL, count: TICK_COUNT, end: "latest", style: "ticks" });
};

ws.onmessage = (msg) => {
  const data = JSON.parse(msg.data);
  if (data.error) return console.error("Error:", data.error.message);

  switch (data.msg_type) {
    case "history":
      lastTicks = data.history.prices.map((p, i) => ({
        epoch: data.history.times[i],
        quote: p,
      }));
      console.log(`📊 Loaded ${lastTicks.length} ticks`);
      checkRangeAndTrade();
      scheduleNextCheck();
      break;

    case "authorize":
      console.log("🔐 Authorized");
      requestProposals();
      break;

    case "proposal":
      handleProposal(data);
      break;

    case "buy":
      handleBuy(data);
      break;

    case "proposal_open_contract":
      handlePOC(data);
      break;

    case "tick":
      lastTicks.push({ epoch: data.tick.epoch, quote: data.tick.quote });
      if (lastTicks.length > TICK_COUNT) lastTicks.shift();
      break;
  }
};

/* === Auto re-check every minute === */
function scheduleNextCheck() {
  console.log("⏰ Waiting for next minute...");
  setTimeout(() => {
    resetCycle();
    sendWhenReady({ ticks_history: SYMBOL, count: TICK_COUNT, end: "latest", style: "ticks" });
  }, 60 * 1000);
}

/* === Trade ops === */
function requestProposals() {
  if (proposalsRequested) return;
  proposalsRequested = true;
  console.log("🧾 Requesting proposals...");
  ["CALL", "PUT"].forEach(type => {
    sendWhenReady({
      proposal: 1,
      amount: stake,
      basis: "stake",
      contract_type: type,
      currency: "USD",
      duration: DURATION,
      duration_unit: DURATION_UNIT,
      symbol: SYMBOL,
    });
  });
}

function handleProposal(data) {
  const type = data.echo_req.contract_type;
  if (!type) return;
  contracts[type] = data.proposal.id;
  console.log(`💼 Proposal ready: ${type}`);

  if (contracts.CALL && contracts.PUT && !buyInProgress) {
    buyInProgress = true;
    console.log("🚀 Buying CALL + PUT...");
    ["CALL", "PUT"].forEach(t => sendWhenReady({ buy: contracts[t], price: stake }));
  }
}

function handleBuy(data) {
  const id = data.buy.contract_id;
  const type = data.echo_req.buy === contracts.CALL ? "CALL" : "PUT";
  activeContracts[type] = id;
  console.log(`📈 Trade opened: ${type} (ID: ${id})`);
  sendWhenReady({ proposal_open_contract: 1, contract_id: id, subscribe: 1 });
}

function handlePOC(data) {
  const poc = data.proposal_open_contract;
  if (!poc) return;
  const type = poc.contract_type;
  const profit = +poc.profit;
  const sold = poc.is_sold;
  console.log(`📊 ${type}: profit=${profit.toFixed(2)} sold=${sold}`);
  if (sold) results[type] = profit;
}

/* === Reconnect if closed === */
ws.onclose = () => {
  console.log("🔄 Reconnecting...");
  setTimeout(() => {
    ws = new WSClass(WS_URL);
  }, 3000);
};
