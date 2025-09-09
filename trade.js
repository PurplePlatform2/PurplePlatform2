// TRADERXY.JS (Markov–Volatility entry) — martingale removed

const APP_ID = 1089;
const TOKEN = "tUgDTQ6ZclOuNBl";
const SYMBOL = "stpRNG";
const BASE_STAKE = 1;
const DURATION = 15;
const DURATION_UNIT = "s";
const HISTORY_COUNT = 5000; // pull 5000 ticks for Markov-volatility model

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

/* === Markov–Volatility Model === */

// simple 2-state Markov regime model with EWMA variance per state
function getVolatilityScore(ticks) {
  if (ticks.length < 2) return 0;

  // returns
  const returns = new Float64Array(ticks.length - 1);
  for (let i = 1; i < ticks.length; i++) {
    returns[i - 1] = ticks[i].quote - ticks[i - 1].quote;
  }

  // 2 states: calm, volatile
  const alpha = 0.03;
  let mu = returns[0];
  let ewmaVar = 0;
  for (let i = 1; i < returns.length; i++) {
    const r = returns[i];
    mu = alpha * r + (1 - alpha) * mu;
    const dev = r - mu;
    ewmaVar = alpha * (dev * dev) + (1 - alpha) * ewmaVar;
  }
  const sigma = Math.sqrt(ewmaVar || 0);

  // Markov transition (fixed for simplicity; can be estimated offline)
  const P = [
    [0.92, 0.08], // Calm→Calm, Calm→Vol
    [0.15, 0.85], // Vol→Calm, Vol→Vol
  ];

  // infer regime probs (rough — based on sigma threshold)
  const calmProb = 1 / (1 + Math.exp(-(-2 + sigma * 50)));
  const volProb = 1 - calmProb;

  // forward 15 steps
  let gamma = [calmProb, volProb];
  let V15 = 0;
  let s2 = sigma * sigma;
  for (let k = 1; k <= 15; k++) {
    gamma = [gamma[0]*P[0][0] + gamma[1]*P[1][0],
             gamma[0]*P[0][1] + gamma[1]*P[1][1]];
    // expected variance: calm has lower, vol has higher
    const calmVar = s2 * 0.5;
    const volVar = s2 * 2.0;
    const expVar = gamma[0]*calmVar + gamma[1]*volVar;
    V15 += expVar;
  }

  // logistic squash into [0,1]
  const score = 1 / (1 + Math.exp(-V15 / (sigma + 1e-6)));
  return Math.min(1, Math.max(0, score));
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
      tryTradeFromVolatility();
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
function tryTradeFromVolatility() {
  const score = getVolatilityScore(lastTicks);
  console.log(`🔎 Volatility score=${score.toFixed(3)}`);

  if (score > 0.797) {
    console.log("🚀 Volatility regime favorable → enter CALL+PUT");
    tradeReady = true;
    if (!isAuthorizeRequested) {
      sendWhenReady({ authorize: TOKEN });
      isAuthorizeRequested = true;
    } else {
      if (!proposalsRequested)
        sendWhenReady({ profit_table: 1, description: 1, limit: 2, offset: 0, sort: "DESC" });
    }
  } else {
    console.log("⚠️ Volatility not favorable. Waiting...");
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
    tryTradeFromVolatility();
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
