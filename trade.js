// TRADERXY.JS (15-tick candle version) — VolPrime entry

const APP_ID = 1089, TOKEN = "tUgDTQ6ZclOuNBl", SYMBOL = "stpRNG";
const BASE_STAKE = 0.35 DURATION = 15, UNIT = "s", HISTORY_COUNT = 46;
const WS_URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const WSClass = globalThis.WebSocket || (typeof require !== "undefined" ? require("ws") : null);
if (!WSClass) throw new Error("WebSocket not found");

let ws = new WSClass(WS_URL), stake = BASE_STAKE;
let contracts = {}, active = {}, results = {}, lastTicks = [];
let tradeReady = false, isTickSub = false, isAuth = false, gotProposals = false, buying = false;

const send = (m) => ws?.readyState === 1 ? ws.send(JSON.stringify(m)) : setTimeout(() => send(m), 100);
const resetCycle = () => (contracts = {}, active = {}, results = {}, buying = false, gotProposals = false);
const round2 = (n) => Math.round(n * 100) / 100;

/* === Flow === */
ws.onopen = () => {
  console.log("Connected ✅");
  send({ ticks_history: SYMBOL, count: HISTORY_COUNT, end: "latest", style: "ticks" });
};

ws.onmessage = (msg) => {
  const d = JSON.parse(msg.data); if (d.error) return console.error("Error:", d.error.message);
  switch (d.msg_type) {
    case "history":
      lastTicks = d.history.prices.map((p, i) => ({ epoch: d.history.times[i], quote: p }));
      console.log(`📊 Loaded ${lastTicks.length} ticks`); tryPatternAndTrade(); break;
    case "tick": handleTick(d.tick); break;
    case "authorize": console.log("Authorized ✅"); isAuth = true; requestProposals(); break;
    case "proposal": handleProposal(d); break;
    case "buy": handleBuy(d); break;
    case "proposal_open_contract": handlePOC(d); break;
  }
};

/* === Build 15-tick candles === */
const buildCandles = (ticks) => {
  const c = [];
  for (let i = 0; i + 14 < ticks.length; i += 15) {
    const s = ticks.slice(i, i + 15), o = s[0].quote, cl = s[s.length - 1].quote;
    c.push({ open: o, close: cl, high: Math.max(...s.map(t => t.quote)), low: Math.min(...s.map(t => t.quote)) });
  }
  return c;
};

/* === Entry Condition: VolPrime === */
function tryPatternAndTrade() {
  const c = buildCandles(lastTicks);
  if (!c.length) return console.log("Not enough candles");
  const { high, low } = c[c.length - 1], range = round2(high - low);
  console.log(`VolPrime check → high=${high}, low=${low}, range=${range}`);
  if (range <= 0.2) {
    console.log("🚀 VolPrime triggered → CALL+PUT");
    tradeReady = true;
    if (!isAuth) send({ authorize: TOKEN }); else if (!gotProposals) requestProposals();
  } else if (!isTickSub) {
    console.log("No VolPrime yet → subscribing ticks...");
    send({ ticks: SYMBOL, subscribe: 1 }); isTickSub = true;
  }
}

/* === Tick Handling === */
function handleTick(tick) {
  lastTicks.push({ epoch: tick.epoch, quote: tick.quote });
  if (lastTicks.length > HISTORY_COUNT) lastTicks.shift();
  console.log(`💹 Tick: ${tick.quote}`);
  if (!tradeReady && lastTicks.length >= HISTORY_COUNT) tryPatternAndTrade();
}

/* === Proposals & Buying === */
function requestProposals() {
  if (gotProposals) return; gotProposals = true; resetCycle();
  ["CALL", "PUT"].forEach(type => send({
    proposal: 1, amount: stake, basis: "stake", contract_type: type,
    currency: "USD", duration: DURATION, duration_unit: UNIT, symbol: SYMBOL
  }));
}
function handleProposal(d) {
  const t = d.echo_req?.contract_type, id = d.proposal?.id; if (!t || !id) return;
  contracts[t] = id; console.log(`Proposal ${t} → id=${id}`);
  if (contracts.CALL && contracts.PUT && !buying) {
    buying = true; console.log("Buying CALL+PUT...");
    ["CALL", "PUT"].forEach(t => send({ buy: contracts[t], price: stake }));
  }
}
function handleBuy(d) {
  const id = d.buy?.contract_id; if (!id) return;
  const e = d.echo_req?.buy, t = e === contracts.CALL ? "CALL" : e === contracts.PUT ? "PUT" : (!active.CALL ? "CALL" : "PUT");
  active[t] = id; console.log(`Trade opened: ${t}, ID=${id}, stake=${stake}`);
  send({ proposal_open_contract: 1, contract_id: id, subscribe: 1 });
}
function handlePOC(d) {
  const p = d.proposal_open_contract; if (!p) return;
  const t = p.contract_type, profit = +p.profit, sold = !!p.is_sold;
  console.log(`POC ${t} profit=${profit.toFixed(2)} sold=${sold}`);
  if (sold) { results[t] = profit; if (results.CALL != null && results.PUT != null) evaluateFinal(); }
}
function evaluateFinal() {
  const net = (results.CALL || 0) + (results.PUT || 0);
  console.log(`Final results → NET=${net}`);
  console.log(net > 0 ? "✅ Profitable! Exiting." : "❌ Loss. Exiting.");
  stake = BASE_STAKE; ws.close();
}
