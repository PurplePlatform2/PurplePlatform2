// TRADERXY.JS (15-tick candle version) — martingale removed

const APP_ID = 1089;
const TOKEN = "tUgDTQ6ZclOuNBl";
const SYMBOL = "stpRNG";
const BASE_STAKE = 1;
const DURATION = 15;
const DURATION_UNIT = "s";
const HISTORY_COUNT = 46; // pull 46 ticks

const WS_URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const WSClass =
  typeof globalThis !== "undefined" && globalThis.WebSocket
    ? globalThis.WebSocket
    : (typeof require !== "undefined" ? require("ws") : null);

if (!WSClass) throw new Error("WebSocket not found. Use browser or install 'ws'.");

let ws = new WSClass(WS_URL);

/* === State === */
let stake = BASE_STAKE;
let contracts = {}; // stores proposal id for the selected type
let activeContracts = {}; // stores contract id after buy
let results = {};
let lastTicks = [];
let tradeReady = false;
let selectedContractType = null;

/* === Protection flags === */
let isTickSubscribed = false;
let isAuthorizeRequested = false;
let proposalsRequested = false;
let buyInProgress = false;

/* === Helpers === */
function sendWhenReady(msg) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify(msg));
  } else {
    const tryOnce = () => {
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify(msg));
      } else {
        setTimeout(() => {
          if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
        }, 250);
      }
    };
    setTimeout(tryOnce, 50);
  }
}

function resetCycle() {
  contracts = {};
  activeContracts = {};
  results = {};
  buyInProgress = false;
  proposalsRequested = false;
  selectedContractType = null;
}

function round2(num) {
  return Math.round(num * 100) / 100;
}

/* === Flow === */
ws.onopen = () => {
  console.log("Connected ✅");
  sendWhenReady({
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
      lastTicks = data.history.prices.map((p, i) => ({
        epoch: data.history.times[i],
        quote: p,
      }));
      console.log(`📊 Loaded ${lastTicks.length} ticks`);
      tryPatternAndTradeFromTicks();
      break;

    case "tick":
      handleTick(data.tick);
      break;

    case "authorize":
      console.log("Authorized response received.");
      isAuthorizeRequested = true;
      requestProposals();
      break;

    case "proposal":
      handleProposal(data);
      break;

    case "profit_table":
      let redeem = cProfit(data.profit_table.transactions);
      if (redeem.total < 0) {
        console.log("\n**Received History>>loss::", redeem.total);
        stake = redeem.stake ;
      } else {
        console.log("Previous trade profitable::", redeem.total);
      }
      requestProposals();
      break;

    case "buy":
      handleBuy(data);
      break;

    case "proposal_open_contract":
      handlePOC(data);
      break;
  }
};

/* === Profit Parser === */
const cProfit = (r) => {
  const t =
    typeof r === "string" ? JSON.parse("[" + r.replace(/^\[?|\]?$/g, "") + "]") : r;
  const i = t.map((x) => ({
    id: x.contract_id,
    type: x.contract_type,
    profit: +(x.sell_price - x.buy_price).toFixed(2),
  }));
  return {
    individual: i,
    total: +i.reduce((s, x) => s + x.profit, 0).toFixed(2),
    stake: +(t.reduce((s, x) => s + x.buy_price, 0) / t.length).toFixed(2),
  };
};

/* === ENTRY LOGIC: ONLY ±1.0 === */
function tryPatternAndTradeFromTicks() {
  if (lastTicks.length < 16) return;

  const diff = round2(
    lastTicks[lastTicks.length - 1].quote -
      lastTicks[lastTicks.length - 16].quote
  );
  console.log(`📏 Difference (current - 15 ago) = ${diff}`);

  if (diff >= 1.0 || diff <= -1.0) {
    tradeReady = true;
    selectedContractType = diff >0 ? "PUT" : "CALL";
    console.log(
      `✅ Condition met (${diff}) → preparing to ${
        selectedContractType === "CALL" ? "BUY" : "SELL"
      } (${selectedContractType})`
    );

    if (!isAuthorizeRequested) {
      console.log("Requesting authorization...");
      sendWhenReady({ authorize: TOKEN });
      isAuthorizeRequested = true;
    } else {
      requestProposals();
    }
  } else {
    console.log("❌ Condition not met (needs exactly ±1.0). Waiting...");
    if (!isTickSubscribed) {
      console.log("Subscribing to live ticks...");
      sendWhenReady({ ticks: SYMBOL, subscribe: 1 });
      isTickSubscribed = true;
    }
  }
}

/* === Tick Handling === */
function handleTick(tick) {
  lastTicks.push({ epoch: tick.epoch, quote: tick.quote });
  if (lastTicks.length > HISTORY_COUNT) lastTicks.shift();
  console.log(`💹 Tick: ${tick.quote}`);
  if (!tradeReady && lastTicks.length >= HISTORY_COUNT) {
    tryPatternAndTradeFromTicks();
  }
}

/* === Proposals & Buying === */
function requestProposals() {
  if (proposalsRequested || !selectedContractType) return;
  proposalsRequested = true;
  console.log(`Requesting proposal for ${selectedContractType}...`);
  sendWhenReady({
    proposal: 1,
    amount: stake,
    basis: "stake",
    contract_type: selectedContractType,
    currency: "USD",
    duration: DURATION,
    duration_unit: DURATION_UNIT,
    symbol: SYMBOL,
  });
  
  
}

function handleProposal(data) {
  const echo = data.echo_req || {};
  const contractType = echo.contract_type || (echo.proposal && echo.proposal.contract_type);
  if (!contractType || contractType !== selectedContractType) return;
  const proposalId = data.proposal && data.proposal.id;
  if (!proposalId) return;
  contracts[contractType] = proposalId;
  console.log(`Proposal received for ${contractType} → id=${proposalId}`);
  if (!buyInProgress) {
    buyInProgress = true;
    console.log(`Buying ${contractType}...`);
    sendWhenReady({ buy: contracts[contractType], price: stake });
  }
}

function handleBuy(data) {
  const buyRes = data.buy;
  if (!buyRes) return;
  const contractId = buyRes.contract_id;
  if (!contractId) return;
  activeContracts[selectedContractType] = contractId;
  console.log(`Trade opened: ${selectedContractType}, ID=${contractId}, stake=${stake}`);
  sendWhenReady({
    proposal_open_contract: 1,
    contract_id: contractId,
    subscribe: 1,
  });
}

function handlePOC(data) {
  const poc = data.proposal_open_contract;
  if (!poc) return;
  const type = poc.contract_type;
  const profit = +poc.profit;
  const isSold = !!poc.is_sold;
  console.log(`POC ${type} profit=${profit.toFixed(2)} sold=${isSold}`);
  if (isSold) {
    results[type] = profit;
    evaluateFinal();
  }
}

function evaluateFinal() {
  const net = results[selectedContractType] || 0;
  console.log(`Final result → NET=${net}`);
  if (net > 0) {
    console.log("✅ Profitable! Exiting.");
  } else {
    console.log("❌ Loss. Exiting.");
    stake = BASE_STAKE;
  }
  resetCycle();
}
