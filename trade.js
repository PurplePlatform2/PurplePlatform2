// TRADERXY.JS — 15-tick candle version (range-based strategy)

const APP_ID = 1089;
const TOKEN = "tUgDTQ6ZclOuNBl";
const SYMBOL = "stpRNG";
const BASE_STAKE = 0.35;
const DURATION = 15;
const DURATION_UNIT = "s";
const HISTORY_COUNT = 46;

const WS_URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const WSClass =
  typeof globalThis !== "undefined" && globalThis.WebSocket
    ? globalThis.WebSocket
    : (typeof require !== "undefined" ? require("ws") : null);
if (!WSClass) throw new Error("WebSocket not found.");

let ws = new WSClass(WS_URL);

/* === State === */
let stake = BASE_STAKE;
let contracts = { CALL: null, PUT: null };
let activeContracts = { CALL: null, PUT: null };
let results = { CALL: null, PUT: null };
let lastTicks = [];
let tradeReady = false;

/* === Protection flags === */
let isTickSubscribed = false;
let isAuthorizeRequested = false;
let proposalsRequested = false;
let buyInProgress = false;

/* === Helpers === */
function sendWhenReady(msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
  else setTimeout(() => sendWhenReady(msg), 100);
}

function resetCycle() {
  contracts = { CALL: null, PUT: null };
  activeContracts = { CALL: null, PUT: null };
  results = { CALL: null, PUT: null };
  buyInProgress = false;
  proposalsRequested = false;
}

const cProfit = r => {
  const t = typeof r === "string" ? JSON.parse("[" + r.replace(/^\[?|\]?$/g, "") + "]") : r;
  const i = t.map(x => ({ profit: +(x.sell_price - x.buy_price).toFixed(2) }));
  return { total: +i.reduce((s, x) => s + x.profit, 0).toFixed(2), stake: +(t.reduce((s, x) => s + x.buy_price, 0) / t.length).toFixed(2) };
};

/* === 15-tick candle builder === */
function build15TickCandles(ticks) {
  const candles = [];
  for (let i = 0; i + 14 < ticks.length; i += 15) {
    const slice = ticks.slice(i, i + 15);
    const open = slice[0].quote;
    const close = slice[slice.length - 1].quote;
    const high = Math.max(...slice.map(t => t.quote));
    const low = Math.min(...slice.map(t => t.quote));
    candles.push({ open, high, low, close });
  }
  return candles;
}

/* === WebSocket Flow === */
ws.onopen = () => {
  console.log("Connected ✅");
  sendWhenReady({ ticks_history: SYMBOL, count: HISTORY_COUNT, end: "latest", style: "ticks" });
};

ws.onmessage = (msg) => {
  const data = JSON.parse(msg.data);
  if (data.error) return console.error("Error:", data.error.message);

  switch (data.msg_type) {
    case "history":
      lastTicks = data.history.prices.map((p, i) => ({ epoch: data.history.times[i], quote: p }));
      console.log(`📊 Loaded ${lastTicks.length} ticks`);
      tryRangePattern();
      break;

    case "tick":
      lastTicks.push({ epoch: data.tick.epoch, quote: data.tick.quote });
      if (lastTicks.length > HISTORY_COUNT) lastTicks.shift();
      console.log(`💹 Tick: ${data.tick.quote}`);
      if (!tradeReady) tryRangePattern();
      break;

    case "authorize":
      console.log("Authorized ✅");
      sendWhenReady({ profit_table: 1, description: 1, limit: 2, offset: 0, sort: "DESC" });
      break;

    case "profit_table":
      const redeem = cProfit(data.profit_table.transactions);
      console.log(`📒 Profit check → total=${redeem.total}`);
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
  }
};

/* === Core logic: range pattern === */
function tryRangePattern() {
  const candles = build15TickCandles(lastTicks);
  if (candles.length < 3) return console.log("Not enough candles yet.");

  const c2 = candles[candles.length - 2];
  const c3 = candles[candles.length - 3];
  const r2 = c2.high - c2.low;
  const r3 = c3.high - c3.low;

  console.log(`Range check → c2=${r2.toFixed(2)} c3=${r3.toFixed(2)}`);

  if (r2 <= 0.3 && r3 <= 0.3) {
    console.log("✅ Range condition met → preparing to trade.");
    tradeReady = true;

    if (!isAuthorizeRequested) {
      sendWhenReady({ authorize: TOKEN });
      isAuthorizeRequested = true;
    } else {
      sendWhenReady({ profit_table: 1, description: 1, limit: 2, offset: 0, sort: "DESC" });
    }
  } else {
    console.log("❌ Range too wide — no trade.");
    if (!isTickSubscribed) {
      sendWhenReady({ ticks: SYMBOL, subscribe: 1 });
      isTickSubscribed = true;
    }
  }
}

/* === Trade operations === */
function requestProposals() {
  if (proposalsRequested) return console.log("Proposals already requested.");
  proposalsRequested = true;
  resetCycle();
  console.log("Requesting proposals...");
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
  if (!id) return;
  const type = data.echo_req.buy === contracts.CALL ? "CALL" : "PUT";
  activeContracts[type] = id;
  console.log(`📈 Trade opened: ${type} → ID=${id}`);
  sendWhenReady({ proposal_open_contract: 1, contract_id: id, subscribe: 1 });
}

function handlePOC(data) {
  const poc = data.proposal_open_contract;
  if (!poc) return;
  const type = poc.contract_type;
  const profit = +poc.profit;
  const sold = poc.is_sold;
  console.log(`POC ${type} profit=${profit.toFixed(2)} sold=${sold}`);
  if (sold) {
    results[type] = profit;
    if (results.CALL !== null && results.PUT !== null) evaluateFinal();
  }
}

function evaluateFinal() {
  const net = (results.CALL || 0) + (results.PUT || 0);
  console.log(`🏁 Final result → NET=${net.toFixed(2)}`);
  ws.close();
}
