// TRADERXY.JS (30-tick distance version with full logging) — corrected stable

const APP_ID = 1089;
const TOKEN = "tUgDTQ6ZclOuNBl";
const SYMBOL = "stpRNG";
const BASE_STAKE = 1;
const DURATION = 15;
const DURATION_UNIT = "s";
const HISTORY_COUNT = 31;

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
let lastTicks = []; // array of { epoch: Number, quote: Number }
let tradeReady = false;

/* === Protection flags === */
let isTickSubscribed = false;
let isAuthorizeRequested = false;
let proposalsRequested = false;
let buyInProgress = false;

/* === Helpers === */
function sendWhenReady(msg) {
  if (ws && ws.readyState === 1) {
    try {
      console.log("➡️ Sending:", JSON.stringify(msg));
    } catch (e) {
      console.log("➡️ Sending (non-serializable):", msg);
    }
    ws.send(JSON.stringify(msg));
  } else {
    console.log("⚠️ Socket not ready (state=", ws && ws.readyState, ") - retrying in 100ms...");
    setTimeout(() => sendWhenReady(msg), 100);
  }
}

function resetCycle() {
  console.log("🔄 Resetting trade cycle state...");
  contracts = { CALL: null, PUT: null };
  activeContracts = { CALL: null, PUT: null };
  results = { CALL: null, PUT: null };
  buyInProgress = false;
  proposalsRequested = false;
  // 🚫 Do NOT reset isTickSubscribed, otherwise we resubscribe again
}

function round2(num) {
  return Math.round(num * 100) / 100;
}

/* === Flow === */
ws.onopen = () => {
  console.log("✅ Connected to Deriv WebSocket.");
  console.log(`📥 Requesting last ${HISTORY_COUNT} ticks for ${SYMBOL}...`);
  sendWhenReady({
    ticks_history: SYMBOL,
    count: HISTORY_COUNT,
    end: "latest",
    style: "ticks",
  });
};

ws.onclose = (ev) => {
  console.log("🔌 WebSocket closed.", ev && ev.reason ? ev.reason : "");
};

ws.onerror = (err) => {
  console.error("❌ WebSocket error:", err);
};

ws.onmessage = (msg) => {
  let data;
  try {
    data = JSON.parse(msg.data);
  } catch (e) {
    console.error("❌ Failed to parse message:", msg.data);
    return;
  }

  if (data.error) {
    console.error("❌ API Error:", data.error.message || data.error);
    return;
  }

  switch (data.msg_type) {
    case "history":
      lastTicks = (data.history.prices || []).map((p, i) => ({
        epoch: Number(data.history.times[i]),
        quote: Number(p),
      }));
      console.log(`📊 Loaded ${lastTicks.length} ticks (HISTORY_COUNT=${HISTORY_COUNT})`);
      tryPatternAndTradeFromTicks();
      break;

    case "tick":
      handleTick({
        epoch: Number(data.tick.epoch),
        quote: Number(data.tick.quote),
      });
      break;

    case "authorize":
      console.log("🔑 Authorized successfully.");
      isAuthorizeRequested = true;
      sendWhenReady({
        profit_table: 1,
        description: 1,
        limit: 2,
        offset: 0,
        sort: "DESC",
      });
      break;

    case "proposal":
      handleProposal(data);
      break;

    case "profit_table": {
      let redeem = cProfit(data.profit_table && data.profit_table.transactions);
      if (redeem.total < 0) {
        console.log(`📉 Previous trade LOSS = ${redeem.total}`);
        stake = redeem.stake * 5;
        requestProposals();
      } else {
        console.log(`📈 Previous trade PROFIT = ${redeem.total}`);
        requestProposals();
      }
      break;
    }

    case "buy":
      handleBuy(data);
      break;

    case "proposal_open_contract":
      handlePOC(data);
      break;

    default:
      console.log("ℹ️ Other message:", data.msg_type);
      break;
  }
};

const cProfit = (r) => {
  try {
    if (!r) return { individual: [], total: 0, stake: BASE_STAKE };
    const t =
      typeof r === "string"
        ? JSON.parse("[" + r.replace(/^\[?|\]?$/g, "") + "]")
        : r;
    const i = t.map((x) => ({
      id: x.contract_id,
      type: x.contract_type,
      profit: Number((x.sell_price - x.buy_price).toFixed(2)),
    }));
    return {
      individual: i,
      total: Number(i.reduce((s, x) => s + x.profit, 0).toFixed(2)),
      stake: Number((t.reduce((s, x) => s + x.buy_price, 0) / t.length).toFixed(2)),
    };
  } catch (e) {
    console.error("❌ cProfit parse error:", e);
    return { individual: [], total: 0, stake: BASE_STAKE };
  }
};

/* === Pattern Check === */
function tryPatternAndTradeFromTicks() {
  if (lastTicks.length < HISTORY_COUNT) {
    console.log(`⏳ Waiting until we have ${HISTORY_COUNT} ticks... (have ${lastTicks.length})`);
    return;
  }

  const idxLatest = lastTicks.length - 1;
  const idx15 = lastTicks.length - 16;
  const idx30 = lastTicks.length - 31;

  if (idx15 < 0 || idx30 < 0) {
    console.log("⚠️ Not enough ticks to compute t15/t30.");
    return;
  }

  const t0 = lastTicks[idxLatest].quote;
  const t15 = lastTicks[idx15].quote;
  const t30 = lastTicks[idx30].quote;

  const d1 = round2(Math.abs(t0 - t15));
  const d2 = round2(Math.abs(t15 - t30));

  console.log(`📐 Distances: d1=${d1}, d2=${d2} (t0=${t0}, t15=${t15}, t30=${t30})`);
  console.log(`🔖 Flags: tradeReady=${tradeReady}, isAuthorizeRequested=${isAuthorizeRequested}, proposalsRequested=${proposalsRequested}, isTickSubscribed=${isTickSubscribed}`);

  if (d1 === 0.2 && d2 === 0.4) {
    console.log("✅ Condition met (d1=0.2, d2=0.4) → enter CALL+PUT");
    tradeReady = true;

    if (!isAuthorizeRequested) {
      console.log("🔑 Requesting authorization...");
      sendWhenReady({ authorize: TOKEN });
      isAuthorizeRequested = true;
    } else if (!proposalsRequested) {
      console.log("📥 Fetching profit table before proposals...");
      sendWhenReady({
        profit_table: 1,
        description: 1,
        limit: 2,
        offset: 0,
        sort: "DESC",
      });
    }
  } else {
    console.log("❌ Condition not met.");
    if (!isTickSubscribed) {
      console.log("🔔 Subscribing to live ticks...");
      sendWhenReady({ ticks: SYMBOL, subscribe: 1 });
      isTickSubscribed = true;
    } else {
      console.log("ℹ️ Already subscribed to live ticks; waiting for next ticks...");
    }
  }
}

/* === Tick Handling === */
function handleTick(tick) {
  lastTicks.push(tick);
  if (lastTicks.length > HISTORY_COUNT) lastTicks.shift();

  console.log(`💹 Tick received: epoch=${tick.epoch}, quote=${tick.quote} (stored=${lastTicks.length})`);

  if (!tradeReady && lastTicks.length >= HISTORY_COUNT) {
    tryPatternAndTradeFromTicks();
  }
}

/* === Proposals & Trading === */
function requestProposals() {
  if (proposalsRequested) {
    console.log("⚠️ Proposals already requested, skipping...");
    return;
  }
  proposalsRequested = true;
  resetCycle();
  console.log("📨 Requesting CALL + PUT proposals...");
  ["CALL", "PUT"].forEach((type) =>
    sendWhenReady({
      proposal: 1,
      amount: stake,
      basis: "stake",
      contract_type: type,
      currency: "USD",
      duration: DURATION,
      duration_unit: DURATION_UNIT,
      symbol: SYMBOL,
    })
  );
}

function handleProposal(data) {
  const type = data.echo_req?.contract_type;
  const id = data.proposal?.id;
  if (!type || !id) {
    console.log("⚠️ Proposal ignored (missing type/id).", data);
    return;
  }
  contracts[type] = id;
  console.log(`📨 Proposal received for ${type} → id=${id}`);
  if (contracts.CALL && contracts.PUT && !buyInProgress) {
    buyInProgress = true;
    console.log("🛒 Both proposals ready → Buying CALL and PUT...");
    ["CALL", "PUT"].forEach((t) =>
      sendWhenReady({ buy: contracts[t], price: stake })
    );
  }
}

function handleBuy(data) {
  const buyRes = data.buy;
  if (!buyRes) {
    console.log("⚠️ Buy response invalid.", data);
    return;
  }
  const id = buyRes.contract_id;
  const echoBuy = data.echo_req?.buy;
  let type = null;
  if (echoBuy === contracts.CALL) type = "CALL";
  else if (echoBuy === contracts.PUT) type = "PUT";
  if (!type) type = !activeContracts.CALL ? "CALL" : "PUT";
  activeContracts[type] = id;
  console.log(`✅ Trade opened: ${type}, ID=${id}, stake=${stake}`);
  sendWhenReady({
    proposal_open_contract: 1,
    contract_id: id,
    subscribe: 1,
  });
}

function handlePOC(data) {
  const poc = data.proposal_open_contract;
  if (!poc) return;
  const type = poc.contract_type;
  const profit = Number(poc.profit);
  const sold = !!poc.is_sold;
  console.log(
    `📡 Contract update: ${type}, profit=${isFinite(profit) ? profit.toFixed(2) : profit}, sold=${sold}`
  );
  if (sold) {
    results[type] = profit;
    if (results.CALL !== null && results.PUT !== null) evaluateFinal();
  }
}

function evaluateFinal() {
  const net = (results.CALL || 0) + (results.PUT || 0);
  console.log(`🏁 Final results → NET=${net}`);
  if (net > 0) {
    console.log("🎉 Trade cycle PROFIT. Closing WebSocket.");
    ws.close();
  } else {
    console.log("💔 Trade cycle LOSS. Reset stake and exit.");
    stake = BASE_STAKE;
    ws.close();
  }
}
