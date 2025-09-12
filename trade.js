//Checking if 30ticks crossed 1minute threshold

/* === Mean Reversion Multiplier Bot (Node.js + Browser Compatible) === */

let WSClass;
if (typeof window !== "undefined" && window.WebSocket) {
  WSClass = window.WebSocket; // Browser
} else {
  WSClass = require("ws"); // Node.js
}

/* === CONFIG === */
const APP_ID = 1089;
const token = "GrDCl7fo5axufb2"; // 🔐 Replace with your real token
const stake = 2;
const symbol = "stpRNG";
const multiplier = 750;
const THRESHOLD = 0.7;
const MIN_BALANCE = 50;

/* === STATE === */
const ws = new WSClass(`wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`);
let contract_id = null;
let bought = false;
let ticksWindow = [];
let subscribedToTicks = false;
let accountBalance = 0;
let trackedContracts = new Set(); // ✅ track already-subscribed contracts

/* === HELPERS === */
const safeParseFloat = v => (Number.isFinite(parseFloat(v)) ? parseFloat(v) : null);

function checkWindowAndMaybeBuy() {
  if (bought || ticksWindow.length < 15) return;
  if (accountBalance <= MIN_BALANCE) {
    console.log(`⛔ Balance $${accountBalance} ≤ ${MIN_BALANCE}`);
    return;
  }

  const oldest = ticksWindow[0];
  const latest = ticksWindow[ticksWindow.length - 1];
  if (oldest == null || latest == null) return;

  const diff = latest - oldest;
  console.log(`📈 15-tick Δ: ${diff.toFixed(5)}`);

  let direction = null;
  if (diff > THRESHOLD) direction = "MULTDOWN";
  else if (diff < -THRESHOLD) direction = "MULTUP";

  if (direction) buyMultiplier(direction);
}

function buyMultiplier(contract_type) {
  if (bought) return;
  bought = true;
  console.log(`🚀 BUY ${contract_type} | stake $${stake} | x${multiplier}`);
  ws.send(JSON.stringify({
    buy: 1,
    price: stake,
    parameters: {
      amount: stake, basis: "stake", contract_type,
      currency: "USD", multiplier, symbol
    },
  }));
}

function subscribeTicks() {
  if (subscribedToTicks) return;
  subscribedToTicks = true;
  console.log("🔔 Subscribed to ticks");
  ws.send(JSON.stringify({ ticks: symbol, subscribe: 1 }));
}

function unsubscribeTicks() {
  subscribedToTicks = false;
  console.log("🔕 Tick feed off");
}

/* === Portfolio Helpers === */
function checkPortfolio() {
  ws.send(JSON.stringify({ portfolio: 1 }));
}

function inspectContract(cid) {
  if (trackedContracts.has(cid)) return; // ✅ skip duplicates
  trackedContracts.add(cid);
  ws.send(JSON.stringify({ proposal_open_contract: 1, contract_id: cid, subscribe: 1 }));
}

/* === CONNECTION === */
ws.onopen = () => {
  console.log("🔌 Connecting...");
  ws.send(JSON.stringify({ authorize: token }));
};

ws.onmessage = (msg) => {
  const data = JSON.parse(msg.data || msg);
  if (data.error) {
    console.error("❌", data.error.message || data.error);
    return;
  }

  const mt = data.msg_type || "";

  if (mt === "authorize") {
    console.log("✅ Authorized", data.authorize?.loginid);
    ws.send(JSON.stringify({ balance: 1 }));
    checkPortfolio(); // ✅ only once at startup
    ws.send(JSON.stringify({ ticks_history: symbol, end: "latest", count: 15, style: "ticks" }));
    return;
  }

  if (mt === "balance") {
    accountBalance = safeParseFloat(data.balance?.balance) || 0;
    console.log(`💰 Balance: $${accountBalance}`);
    return;
  }

  if (mt === "portfolio") {
    const contracts = data.portfolio?.contracts || [];
    console.log(`📂 Open contracts: ${contracts.length}`);
    contracts.forEach(c => inspectContract(c.contract_id)); // ✅ subscribe live
    return;
  }

  if (mt === "history") {
    ticksWindow = (data.history?.prices || [])
      .map(safeParseFloat).filter(p => p !== null).slice(-15);
    console.log(`🧾 History: ${ticksWindow.length} ticks`);
    checkWindowAndMaybeBuy();
    if (!bought) subscribeTicks();
    return;
  }

  if (mt === "tick") {
    const quote = safeParseFloat(data.tick?.quote);
    if (quote == null) return;
    ticksWindow.push(quote);
    if (ticksWindow.length > 15) ticksWindow.shift();
    if (!bought) checkWindowAndMaybeBuy();
    return; // ✅ no more portfolio spam
  }

  if (mt === "buy") {
    contract_id = data.buy?.contract_id;
    console.log(`✅ Bought #${contract_id}`);
    unsubscribeTicks();
    inspectContract(contract_id); // ✅ live subscribe
    return;
  }

  if (mt === "proposal_open_contract") {
    const poc = data.proposal_open_contract;
    if (!poc) return;
    console.log(`📊 #${poc.contract_id} | ${poc.status} | entry:${poc.buy_price} spot:${poc.current_spot} P/L:${poc.profit}`);

    if (poc.profit > 0 && poc.is_sold === 0) {
      console.log(`🛑 Closing #${poc.contract_id} | Profit:${poc.profit}`);
      ws.send(JSON.stringify({ sell: poc.contract_id, price: poc.bid_price || 0 }));
    }

    if (poc.status !== "open") {
      console.log(`🏁 Closed #${poc.contract_id} | Final P/L:${poc.profit}`);
      bought = false;
      contract_id = null;
      trackedContracts.delete(poc.contract_id); // ✅ free up slot
    }
    return;
  }

  if (mt === "sell") {
    console.log(`💰 Sold #${data.sell.contract_id} @${data.sell.sell_price}`);
    return;
  }
};

ws.onerror = (err) => console.error("⚠️ WS error:", err.message || err);
ws.onclose = () => console.log("🔒 WS closed");
