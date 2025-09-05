// TRADERXY.JS
const APP_ID = 1089; // Replace with your app_id
const TOKEN = "tUgDTQ6ZclOuNBl"; // Replace with your token
const SYMBOL = "stpRNG"; // Example symbol
const BASE_STAKE = 1; // Stake in USD
const DURATION = 15;
const DURATION_UNIT = "s";
const MULTIPLIER = 2.3;
const HISTORY_COUNT = 100;

/* === WebSocket === */
const WS_URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const WSClass =
  typeof globalThis !== "undefined" && globalThis.WebSocket
    ? globalThis.WebSocket
    : (typeof require !== "undefined" ? require("ws") : null);

if (!WSClass) throw new Error("WebSocket not found. Use browser or install 'ws'.");

let ws = new WSClass(WS_URL);

/* === State === */
let stake = BASE_STAKE;
let contracts = { CALL: null, PUT: null };
let activeContracts = { CALL: null, PUT: null };
let results = { CALL: null, PUT: null };
let lastTicks = [];
let tradeReady = false;

/* === Helpers === */
function send(msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function resetCycle() {
  contracts = { CALL: null, PUT: null };
  activeContracts = { CALL: null, PUT: null };
  results = { CALL: null, PUT: null };
}

function round2(num) {
  return Math.round(num * 100) / 100;
}

/* === Flow === */
ws.onopen = () => {
  console.log("Connected ✅");
  // Request initial history
  send({
    ticks_history: SYMBOL,
    count: HISTORY_COUNT,
    end: "latest",
    style: "ticks",
  });
};

ws.onmessage = (msg) => {
  const data = JSON.parse(msg.data);
  if (data.error) {
    console.error("Error:", data.error.message);
    return;
  }

  switch (data.msg_type) {
    case "history":
      lastTicks = data.history.prices;
      console.log(`📊 Loaded ${lastTicks.length} historical ticks`);
      send({ ticks: SYMBOL, subscribe: 1 }); // Subscribe to live ticks
      break;

    case "tick":
      handleTick(data.tick);
      break;

    case "authorize":
      console.log("Authorized 🔑");
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

/* === Tick Handling & Condition === */
function handleTick(tick) {
  lastTicks.push(tick.quote);
  if (lastTicks.length > HISTORY_COUNT) lastTicks.shift();

  console.log(`💹 Tick: ${tick.quote}`);

  // Only trade if last tick == tick 15 steps ago
  if (!tradeReady && lastTicks.length > 15) {
    const latest = lastTicks[lastTicks.length - 1];
    const prev15 = lastTicks[lastTicks.length - 1 - 15];

    if (latest === prev15) {
      console.log(`🚀 Condition met! Tick ${latest} repeated after 15 steps`);
      tradeReady = true;
      send({ authorize: TOKEN });
    }
  }
}

/* === Proposals & Buying === */
function requestProposals() {
  resetCycle();
  ["CALL", "PUT"].forEach((type) => {
    send({
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
  const contractType = data.echo_req.contract_type;
  contracts[contractType] = data.proposal.id;
  console.log(`Proposal for ${contractType} → payout: ${data.proposal.display_value}`);

  if (contracts.CALL && contracts.PUT && !activeContracts.CALL && !activeContracts.PUT) {
    ["CALL", "PUT"].forEach((type) => {
      send({ buy: contracts[type], price: stake });
    });
  }
}

function handleBuy(data) {
  const contractId = data.buy?.contract_id;
  if (!contractId) return;

  const type = data.echo_req.buy === contracts.CALL ? "CALL" : "PUT";
  activeContracts[type] = contractId;
  console.log(`Trade opened: ${type} ID=${contractId}, stake=${stake}`);

  send({
    proposal_open_contract: 1,
    contract_id: contractId,
    subscribe: 1,
  });
}

/* === Proposal Open Contract === */
function handlePOC(data) {
  const poc = data.proposal_open_contract;
  if (!poc) return;

  const type = poc.contract_type;
  const profit = +poc.profit;
  const isSold = !!poc.is_sold;

  console.log(`POC ${type} → profit=${profit.toFixed(2)} sold=${isSold}`);

  if (isSold) {
    results[type] = profit;

    if (results.CALL !== null && results.PUT !== null) {
      evaluateFinal();
    }
  }
}

/* === Final Evaluation === */
function evaluateFinal() {
  const net = results.CALL + results.PUT;
  console.log(`Final results → CALL=${results.CALL}, PUT=${results.PUT}, NET=${net}`);

  if (net > 0) {
    console.log("✅ Profitable! Exiting.");
    ws.close();
  } else {
    console.log("❌ Not profitable. Retrying with martingale...");
    stake = round2(stake * MULTIPLIER);
    console.log(`🔄 Next stake = ${stake}`);
    tradeReady = false; // reset so next repeat can trigger
    requestProposals();
  }
}
