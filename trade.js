// TRADERXY.JS (15-tick distance entry) — dual trade system

const APP_ID = 1089;
const TOKEN = "tUgDTQ6ZclOuNBl";
const SYMBOL = "stpRNG";
const BASE_STAKE = 1;
const DURATION = 15;
const DURATION_UNIT = "s";
const HISTORY_COUNT = 15; // always 15 ticks

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

/* === Flags === */
let isTickSubscribed = false;
let isAuthorizeRequested = false;
let proposalsRequested = false;
let buyInProgress = false;

/* === Helpers === */
function sendWhenReady(msg) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify(msg));
  } else {
    setTimeout(() => sendWhenReady(msg), 100);
  }
}

function resetCycle() {
  contracts = { CALL: null, PUT: null };
  activeContracts = { CALL: null, PUT: null };
  results = { CALL: null, PUT: null };
  buyInProgress = false;
  proposalsRequested = false;
}

const cProfit = r => {
  const t = typeof r==="string"?JSON.parse("["+r.replace(/^\[?|\]?$/g,"")+"]"):r;
  const i = t.map(x=>({id:x.contract_id,type:x.contract_type,profit:+(x.sell_price-x.buy_price).toFixed(2)}));
  return {individual:i,total:+i.reduce((s,x)=>s+x.profit,0).toFixed(2),stake:+(t.reduce((s,x)=>s+x.buy_price,0)/t.length).toFixed(2)};
};

/* === Distance Test === */
function getDistanceScore(ticks) {
  if (ticks.length < 15) return 0;
  const first = ticks[0].quote;
  const last = ticks[ticks.length - 1].quote;
  return Math.abs(last - first);
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
      tryTradeFromDistance();
      break;

    case "tick":
      handleTick(data.tick);
      break;

    case "authorize":
      console.log("Authorized.");
      isAuthorizeRequested = true;
      sendWhenReady({ profit_table: 1, description: 1, limit: 2, offset: 0, sort: "DESC" });
      break;

    case "proposal":
      handleProposal(data);
      break;

    case "profit_table":
      let redeem = cProfit(data.profit_table.transactions);
      if (redeem.total < 0) {
        console.log("📉 Previous loss:", redeem.total);
        stake = redeem.stake * 5;
        requestProposals();
      } else {
        console.log("📈 Previous profit:", redeem.total);
        requestProposals();
      }
      break;

    case "buy":
      handleBuy(data);
      break;

    case "proposal_open_contract":
      handlePOC(data);
      break;
  }
};

/* === Entry Logic === */
function tryTradeFromDistance() {
  const score = getDistanceScore(lastTicks);
  console.log(`🔎 Distance score=${score.toFixed(3)}`);

  if (score > 0.7) {
    console.log("🚀 Condition met → enter CALL+PUT");
    tradeReady = true;
    if (!isAuthorizeRequested) {
      sendWhenReady({ authorize: TOKEN });
      isAuthorizeRequested = true;
    } else {
      if (!proposalsRequested)
        sendWhenReady({ profit_table: 1, description: 1, limit: 2, offset: 0, sort: "DESC" });
    }
  } else {
    console.log("⚠️ Condition not met. Waiting...");
    if (!isTickSubscribed) {
      sendWhenReady({ ticks: SYMBOL, subscribe: 1 });
      isTickSubscribed = true;
    }
  }
}

function handleTick(tick) {
  lastTicks.push({ epoch: tick.epoch, quote: tick.quote });
  if (lastTicks.length > HISTORY_COUNT) lastTicks.shift();
  console.log(`💹 Tick: ${tick.quote}`);
  if (!tradeReady && lastTicks.length >= HISTORY_COUNT) {
    tryTradeFromDistance();
  }
}

/* === Proposals & Buying === */
function requestProposals() {
  if (proposalsRequested) return;
  proposalsRequested = true;
  resetCycle();
  ["CALL", "PUT"].forEach((type) => {
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
  contracts[type] = data.proposal?.id;
  console.log(`Proposal for ${type} → id=${contracts[type]}`);
  if (contracts.CALL && contracts.PUT && !buyInProgress) {
    buyInProgress = true;
    ["CALL", "PUT"].forEach((t) =>
      sendWhenReady({ buy: contracts[t], price: stake })
    );
  }
}

function handleBuy(data) {
  const buyRes = data.buy;
  if (!buyRes) return;
  const contractId = buyRes.contract_id;
  const echoBuy = data.echo_req?.buy;
  let typeFound = echoBuy === contracts.CALL ? "CALL" : echoBuy === contracts.PUT ? "PUT" : null;
  if (!typeFound) typeFound = !activeContracts.CALL ? "CALL" : "PUT";
  activeContracts[typeFound] = contractId;
  console.log(`Trade opened: ${typeFound}, ID=${contractId}, stake=${stake}`);
  sendWhenReady({ proposal_open_contract: 1, contract_id: contractId, subscribe: 1 });
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
    if (results.CALL !== null && results.PUT !== null) evaluateFinal();
  }
}

function evaluateFinal() {
  const net = (results.CALL || 0) + (results.PUT || 0);
  console.log(`Final results → NET=${net}`);
  if (net > 0) {
    console.log("✅ Profitable! Exiting.");
    ws.close();
  } else {
    console.log("❌ Loss. Reset stake.");
    stake = BASE_STAKE;
    ws.close();
  }
}
