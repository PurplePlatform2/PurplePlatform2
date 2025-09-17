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
let contracts = { CALL: null, PUT: null }; // stores proposal ids
let activeContracts = { CALL: null, PUT: null }; // stores contract ids after buy
let results = { CALL: null, PUT: null };
let lastTicks = [];
let tradeReady = false;

/* === Protection flags to avoid double actions === */
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
  contracts = { CALL: null, PUT: null };
  activeContracts = { CALL: null, PUT: null };
  results = { CALL: null, PUT: null };
  buyInProgress = false;
  proposalsRequested = false;
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
      sendWhenReady({ profit_table: 1, description: 1, limit: 2, offset: 0, sort: "DESC" });
      break;

    case "proposal":
      handleProposal(data);
      break;

    case "profit_table":
      let redeem = cProfit(data.profit_table.transactions);
      if (redeem.total < 0) {
        console.log("\n**Recieved History>>loss::", redeem.total);
        stake = redeem.stake * 5;
        requestProposals();
      } else {
        console.log("Previous trade profitable::", redeem.total);
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

/* === Build 15-tick candles === */
function build15TickCandles(ticks) {
  const candles = [];
  for (let i = 0; i + 14 < ticks.length; i += 15) {
    const slice = ticks.slice(i, i + 15);
    const open = slice[0].quote;
    const close = slice[slice.length - 1].quote;
    const high = Math.max(...slice.map((t) => t.quote));
    const low = Math.min(...slice.map((t) => t.quote));
    candles.push({ open, high, low, close });
  }
  return candles;
}

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

/* === ENTRY LOGIC MODIFIED WITH 15-TICK DIFFERENCE === */
function tryPatternAndTradeFromTicks() {
  if (lastTicks.length < 16) return;

  const diff = round2(lastTicks[lastTicks.length - 1].quote - lastTicks[lastTicks.length - 16].quote);
  console.log(`📏 Difference (current - 15 ago) = ${diff}`);

  if (diff !== 1.0 || diff !== -1.0) {
    console.log("❌ Condition not met (needs exactly +/-1.0). Waiting...");
    return;
  }

  const candles = build15TickCandles(lastTicks);
  console.log(`Built ${candles.length} candles from ${lastTicks.length} ticks`);

  if (candles.length < 3) return;

  const c1 = candles[candles.length - 1];
  const h2 = candles[candles.length - 2].high;
  const h3 = candles[candles.length - 3].high;
  const l2 = candles[candles.length - 2].low;
  const l3 = candles[candles.length - 3].low;

  const tomRed = c1.close > Math.max(h2, h3);
  const tomGreen = c1.close < Math.min(l2, l3);

  console.log(`tomRed=${tomRed} tomGreen=${tomGreen}`);

  if (tomRed || tomGreen) {
    console.log("🚀 tom pattern found → preparing to enter CALL+PUT");
    tradeReady = true;
    if (!isAuthorizeRequested) {
      console.log("Requesting authorization...");
      sendWhenReady({ authorize: TOKEN });
      isAuthorizeRequested = true;
    } else {
      if (!proposalsRequested)
        sendWhenReady({ profit_table: 1, description: 1, limit: 2, offset: 0, sort: "DESC" });
    }
  } else {
    console.log("No tom pattern yet.");
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
  if (proposalsRequested) {
    console.log("Proposals already requested — skipping duplicate request.");
    return;
  }
  proposalsRequested = true;
  resetCycle();
  console.log("Requesting proposals for CALL and PUT...");
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
  const echo = data.echo_req || {};
  const contractType = echo.contract_type || (echo.proposal && echo.proposal.contract_type);
  if (!contractType) return;
  const proposalId = data.proposal && data.proposal.id;
  if (!proposalId) return;
  contracts[contractType] = proposalId;
  console.log(`Proposal received for ${contractType} → id=${proposalId}`);
  if (contracts.CALL && contracts.PUT && !buyInProgress) {
    buyInProgress = true;
    console.log("Both proposals present — buying CALL and PUT...");
    ["CALL", "PUT"].forEach((type) => {
      sendWhenReady({ buy: contracts[type], price: stake });
    });
  }
}

function handleBuy(data) {
  const buyRes = data.buy;
  if (!buyRes) return;
  const contractId = buyRes.contract_id;
  if (!contractId) return;
  const echoBuy = data.echo_req && data.echo_req.buy;
  let typeFound = null;
  if (echoBuy) {
    if (echoBuy === contracts.CALL) typeFound = "CALL";
    else if (echoBuy === contracts.PUT) typeFound = "PUT";
  }
  if (!typeFound) {
    if (!activeContracts.CALL) typeFound = "CALL";
    else if (!activeContracts.PUT) typeFound = "PUT";
    else typeFound = "UNKNOWN";
  }
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
    if (results.CALL !== null && results.PUT !== null) {
      evaluateFinal();
    }
  }
}

function evaluateFinal() {
  const net = (results.CALL || 0) + (results.PUT || 0);
  console.log(`Final results → NET=${net}`);
  if (net > 0) {
    console.log("✅ Profitable! Exiting.");
    ws.close();
  } else {
    console.log("❌ Loss. Exiting.");
    stake = BASE_STAKE;
    ws.close();
  }
}
