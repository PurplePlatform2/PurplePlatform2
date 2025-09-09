// TRADERXY.JS (15-tick candle version) — martingale removed

const APP_ID = 1089;
const TOKEN = "tUgDTQ6ZclOuNBl";
const SYMBOL = "stpRNG";
const BASE_STAKE = 1;
const DURATION = 15;
const DURATION_UNIT = "s";
const HISTORY_COUNT = 46; // pull 46 ticks
const MaxTradeCycles= 2;

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
let cyclesDone=0;

/* === Protection flags to avoid double actions === */
let isTickSubscribed = false; // prevents subscribing to ticks multiple times
let isAuthorizeRequested = false; // prevents sending authorize multiple times
let proposalsRequested = false; // prevents requesting proposals repeatedly
let buyInProgress = false; // prevents duplicate buys for same proposals

/* === Helpers === */
function sendWhenReady(msg) {
  // only send when socket is OPEN; queue if needed (simple approach)
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify(msg));
  } else {
    // if socket not open, attempt to send on next tick
    const tryOnce = () => {
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify(msg));
      } else {
        // if still not open after a short delay, give up silently (or handle reconnect)
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
  // request history once on connect
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
      // server responded to authorize; continue with proposals
      console.log("Authorized response received.");
      isAuthorizeRequested = true; // mark that we've authorized
      requestProposals(); // will be idempotent because we guard by proposalsRequested
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

    default:
      // other messages can be ignored or logged if helpful
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

function tryPatternAndTradeFromTicks() {
  const candles = build15TickCandles(lastTicks);
  console.log(`Built ${candles.length} candles from ${lastTicks.length} ticks`);

  if (candles.length < 3) {
    console.log("Not enough candles to test tomRed/tomGreen");
    return;
  }

  const c1 = candles[candles.length - 1]; // previous candle
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
    // only request authorize once per needed cycle
    if (!isAuthorizeRequested) {
      console.log("Requesting authorization...");
      sendWhenReady({ authorize: TOKEN });
      isAuthorizeRequested = true;
    } else {
      // already authorized earlier — directly request proposals if not already asked
      if (!proposalsRequested) requestProposals();
    }
  } else {
    console.log("No tom pattern yet.");
    // subscribe to live ticks only once to receive new ticks
    if (!isTickSubscribed) {
      console.log("Subscribing to live ticks...");
      sendWhenReady({ ticks: SYMBOL, subscribe: 1 });
      isTickSubscribed = true;
    } else {
      console.log("Already subscribed to ticks; waiting for new ticks...");
    }
  }
}

/* === Tick Handling === */
function handleTick(tick) {
  lastTicks.push({ epoch: tick.epoch, quote: tick.quote });
  if (lastTicks.length > HISTORY_COUNT) lastTicks.shift();

  console.log(`💹 Tick: ${tick.quote}`);

  if (!tradeReady && lastTicks.length >= HISTORY_COUNT) {
    // only attempt pattern once per new tick; tryPattern will be idempotent with flags
    tryPatternAndTradeFromTicks();
  }
}

/* === Proposals & Buying === */
function requestProposals() {
  // prevent duplicate proposal requests
  if (proposalsRequested) {
    console.log("Proposals already requested — skipping duplicate request.");
    return;
  }
  proposalsRequested = true;
  resetCycle(); // clear any previous per-cycle state
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
  // data.echo_req.contract_type should contain the contract type requested
  const echo = data.echo_req || {};
  const contractType = echo.contract_type || (echo.proposal && echo.proposal.contract_type);
  if (!contractType) {
    console.warn("Proposal received but contract_type unknown. Ignoring.");
    return;
  }

  // store proposal id
  const proposalId = data.proposal && data.proposal.id;
  if (!proposalId) {
    console.warn("Proposal has no id; ignoring.");
    return;
  }

  contracts[contractType] = proposalId;
  console.log(`Proposal received for ${contractType} → id=${proposalId}`);

  // once both proposals available, attempt buy once
  if (contracts.CALL && contracts.PUT && !buyInProgress) {
    buyInProgress = true; // prevent duplicate buys
    console.log("Both proposals present — buying CALL and PUT...");
    ["CALL", "PUT"].forEach((type) => {
      // send buy using the proposal id
      sendWhenReady({ buy: contracts[type], price: stake });
    });
  }
}

function handleBuy(data) {
  const buyRes = data.buy;
  if (!buyRes) {
    console.warn("Buy response without buy payload");
    return;
  }

  const contractId = buyRes.contract_id;
  if (!contractId) {
    console.warn("Buy response missing contract_id; ignoring");
    return;
  }

  // Determine type by matching contract_id into activeContracts (if echoed) or by matching echo_req.buy to proposal id
  const echoBuy = data.echo_req && data.echo_req.buy;
  let typeFound = null;

  if (echoBuy) {
    if (echoBuy === contracts.CALL) typeFound = "CALL";
    else if (echoBuy === contracts.PUT) typeFound = "PUT";
  }

  // fallback: if only one activeContracts slot is empty, fill the first empty one
  if (!typeFound) {
    if (!activeContracts.CALL) typeFound = "CALL";
    else if (!activeContracts.PUT) typeFound = "PUT";
    else typeFound = "UNKNOWN";
  }

  activeContracts[typeFound] = contractId;
  console.log(`Trade opened: ${typeFound}, ID=${contractId}, stake=${stake}`);

  // subscribe to the open contract updates for this contract
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
    cyclesDone++;
    resetCycle();
  if(cyclesDone<MaxTradeCycles)  requestProposals();
 else  ws.close();
  } else {
    console.log("❌ Loss. Exiting.");
    stake = BASE_STAKE;
    ws.close();
  }
}

