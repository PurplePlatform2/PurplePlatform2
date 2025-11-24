// TRADERXY.JS (15-tick candle version) — martingale removed

const APP_ID = 1089;
const TOKEN = "tUgDTQ6ZclOuNBl";
const SYMBOL = "stpRNG";
const BASE_STAKE = 0.35;
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
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify(msg));
  } else {
    const tryOnce = () => {
      if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
      else setTimeout(() => {
        if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
      }, 250);
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

/* === Initial Flow === */
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
      sendWhenReady({"profit_table":1,"description":1,"limit":2,"offset":0,"sort":"DESC"});
      break;

    case "proposal":
      handleProposal(data);
      break;

    case "profit_table":
      let redeem = cProfit(data.profit_table.transactions);
      if (redeem.total < 0) {
        console.log("\n**Recieved History>>loss::", redeem.total);
        stake = redeem.stake ;
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
    candles.push({
      open: slice[0].quote,
      close: slice[slice.length - 1].quote,
      high: Math.max(...slice.map(t => t.quote)),
      low: Math.min(...slice.map(t => t.quote))
    });
  }
  return candles;
}

const cProfit = r => {
  const t = typeof r==="string"?JSON.parse("["+r.replace(/^\[?|\]?$/g,"")+"]"):r;
  const i = t.map(x=>({id:x.contract_id,type:x.contract_type,profit:+(x.sell_price-x.buy_price).toFixed(2)}));
  return {
    individual:i,
    total:+i.reduce((s,x)=>s+x.profit,0).toFixed(2),
    stake:+(t.reduce((s,x)=>s+x.buy_price,0)/t.length).toFixed(2)
  };
};

/* === Pattern Detection === */
function tryPatternAndTradeFromTicks() {
  const candles = build15TickCandles(lastTicks);

  console.log(`Built ${candles.length} candles from ${lastTicks.length} ticks`);

  if (candles.length < 3) {
    console.log("Not enough candles to test tomRed/tomGreen");
    return;
  }

  const c1 = candles[candles.length - 1];
  const h2 = candles[candles.length - 2].high;
  const h3 = candles[candles.length - 3].high;
  const l2 = candles[candles.length - 2].low;
  const l3 = candles[candles.length - 3].low;

  const tomRed =true || c1.close > Math.max(h2, h3);
  const tomGreen =true || c1.close < Math.min(l2, l3);

  const lastRangeOK = (c1.high - c1.low) <= 0.3;

  console.log(`tomRed=${tomRed} tomGreen=${tomGreen} rangeOK=${lastRangeOK}`);

  /** ENTRY CONDITION FIXED HERE **/
  if ((tomRed || tomGreen) && lastRangeOK) {
    console.log("🚀 tom pattern + low-range candle → entering CALL+PUT");

    tradeReady = true;
    if (!isAuthorizeRequested) {
      console.log("Requesting authorization...");
      sendWhenReady({ authorize: TOKEN });
      isAuthorizeRequested = true;
    } else {
      if (!proposalsRequested)
        sendWhenReady({"profit_table":1,"description":1,"limit":2,"offset":0,"sort":"DESC"});
    }
  } else {
    console.log("No entry signal yet.");
    if (!isTickSubscribed) {
      console.log("Subscribing to live ticks...");
      sendWhenReady({ ticks: SYMBOL, subscribe: 1 });
      isTickSubscribed = true;
    }
  }
}

/* === Tick Handler === */
function handleTick(tick) {
  lastTicks.push({ epoch: tick.epoch, quote: tick.quote });
  if (lastTicks.length > HISTORY_COUNT) lastTicks.shift();

  console.log(`💹 Tick: ${tick.quote}`);

  if (!tradeReady && lastTicks.length >= HISTORY_COUNT) {
    tryPatternAndTradeFromTicks();
  }
}

/* === Proposal & Buying === */
function requestProposals() {
  if (proposalsRequested) return console.log("Proposals already requested.");
  proposalsRequested = true;
  resetCycle();

  console.log("Requesting proposals for CALL and PUT...");

  ["CALL","PUT"].forEach(type => {
    sendWhenReady({
      proposal:1,
      amount:stake,
      basis:"stake",
      contract_type:type,
      currency:"USD",
      duration:DURATION,
      duration_unit:DURATION_UNIT,
      symbol:SYMBOL
    });
  });
}

function handleProposal(data) {
  const echo = data.echo_req || {};
  const contractType = echo.contract_type;

  if (!contractType) return console.warn("Unknown proposal type.");

  const proposalId = data.proposal && data.proposal.id;
  if (!proposalId) return console.warn("Proposal has no ID.");

  contracts[contractType] = proposalId;
  console.log(`Proposal for ${contractType} → id=${proposalId}`);

  if (contracts.CALL && contracts.PUT && !buyInProgress) {
    buyInProgress = true;
    console.log("Buying CALL & PUT...");
    ["CALL","PUT"].forEach(type =>
      sendWhenReady({ buy: contracts[type], price: stake })
    );
  }
}

function handleBuy(data) {
  const buyRes = data.buy;
  if (!buyRes) return;

  const contractId = buyRes.contract_id;
  if (!contractId) return;

  const echoBuy = data.echo_req && data.echo_req.buy;
  let typeFound = null;

  if (echoBuy === contracts.CALL) typeFound = "CALL";
  else if (echoBuy === contracts.PUT) typeFound = "PUT";
  else typeFound = !activeContracts.CALL ? "CALL" : "PUT";

  activeContracts[typeFound] = contractId;
  console.log(`Trade opened: ${typeFound}, ID=${contractId}, stake=${stake}`);

  sendWhenReady({
    proposal_open_contract: 1,
    contract_id: contractId,
    subscribe: 1
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
    if (results.CALL !== null && results.PUT !== null) {
      evaluateFinal();
    }
  }
}

function evaluateFinal() {
  const net = (results.CALL || 0) + (results.PUT || 0);
  console.log(`Final results → NET=${net}`);

  if (net > 0) {
    console.log("✅ PROFIT — Exiting.");
  } else {
    console.log("❌ LOSS — Resetting stake.");
    stake = BASE_STAKE;
  }

  ws.close();
}
