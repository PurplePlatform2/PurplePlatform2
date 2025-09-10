//Checking if 30ticks crossed 1minute thresshold

/* === Mean Reversion Multiplier Bot (Node.js + Browser Compatible) === */

// Auto-detect WebSocket implementation
let WSClass;
if (typeof window !== "undefined" && window.WebSocket) {
  WSClass = window.WebSocket; // Browser
} else {
  WSClass = require("ws"); // Node.js
}

/* === CONFIG === */
const APP_ID = 1089; // Your Deriv App ID
const token = "tUgDTQ6ZclOuNBl"; // 🔐 Replace with your real token
const stake = 2;
const symbol = "stpRNG";
const multiplier = 750;
const MAX_PROFIT = 0.01; // ✅ Auto-close when profit hits this
const THRESHOLD = 0.7; // mean-reversion trigger

/* === STATE === */
const ws = new WSClass(`wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`);
let contract_id = null;
let bought = false;
let ticksWindow = [];
let subscribedToTicks = false;

/* === HELPERS === */
function safeParseFloat(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function checkWindowAndMaybeBuy() {
  if (bought || ticksWindow.length < 15) return;

  const oldest = ticksWindow[0];
  const latest = ticksWindow[ticksWindow.length - 1];
  if (oldest == null || latest == null) return;

  const diff = latest - oldest;
  console.log(`🔎 15-tick diff -> oldest: ${oldest}, latest: ${latest}, diff: ${diff.toFixed(6)}`);

  // === Mean Reversion Logic ===
  let direction = null;
  if (diff > THRESHOLD) {
    // Price went UP too much → expect down
    direction = "MULTDOWN";
  } else if (diff < -THRESHOLD) {
    // Price went DOWN too much → expect up
    direction = "MULTUP";
  }

  if (direction) buyMultiplier(direction);
}

function buyMultiplier(contract_type) {
  if (bought) return;
  bought = true;
  console.log(`🚀 Sending MULTIPLIER BUY (${contract_type}) - stake: ${stake}, multiplier: ${multiplier}`);

  const payload = {
    buy: 1,
    price: stake,
    parameters: {
      amount: stake,
      basis: "stake",
      contract_type,
      currency: "USD",
      multiplier,
      symbol,
    },
  };

  ws.send(JSON.stringify(payload));
}

function subscribeTicks() {
  if (subscribedToTicks) return;
  subscribedToTicks = true;
  console.log("🔔 Subscribing to live ticks...");
  ws.send(JSON.stringify({ ticks: symbol, subscribe: 1 }));
}

function unsubscribeTicks() {
  subscribedToTicks = false;
  console.log("🔕 Entry tick subscription disabled (flag only).");
}

/* === CONNECTION === */
ws.onopen = () => {
  console.log("🔌 Connecting...");
  ws.send(JSON.stringify({ authorize: token }));
};

ws.onmessage = (msg) => {
  const data = JSON.parse(msg.data || msg);
  if (data.error) {
    console.error("❌ Error:", data.error.message || data.error);
    return;
  }

  const mt = data.msg_type || "";

  // --- Authorization complete ---
  if (mt === "authorize" || data.authorize) {
    console.log("✅ Authorized:", data.authorize?.loginid);
    // Request last 15 ticks
    ws.send(
      JSON.stringify({
        ticks_history: symbol,
        end: "latest",
        count: 15,
        style: "ticks",
      })
    );
    return;
  }

  // --- History response ---
  if (mt === "history" || data.history) {
    const prices = (data.history && data.history.prices) || [];
    ticksWindow = prices.map((p) => safeParseFloat(p)).filter((p) => p !== null);
    if (ticksWindow.length > 15) ticksWindow = ticksWindow.slice(-15);
    console.log(`🧾 Got history ticks (${ticksWindow.length})`);
    checkWindowAndMaybeBuy();
    if (!bought) subscribeTicks();
    return;
  }

  // --- Live tick ---
  if (mt === "tick" || data.tick) {
    const quote = safeParseFloat(data.tick?.quote);
    if (quote == null) return;

    ticksWindow.push(quote);
    if (ticksWindow.length > 15) ticksWindow.shift();

    if (!bought) checkWindowAndMaybeBuy();
    return;
  }

  // --- Buy response ---
  if (mt === "buy" || data.buy) {
    contract_id = data.buy?.contract_id;
    console.log("✅ Bought contract:", contract_id);
    unsubscribeTicks();
    ws.send(
      JSON.stringify({
        proposal_open_contract: 1,
        contract_id,
        subscribe: 1,
      })
    );
    return;
  }

  // --- Contract updates ---
  if (mt === "proposal_open_contract" || data.proposal_open_contract) {
    const poc = data.proposal_open_contract;
    if (!poc) return;

    console.log(`📊 Contract Update:
      contract_id: ${poc.contract_id}
      status: ${poc.status}
      entry_price: ${poc.buy_price}
      current_price: ${poc.current_spot}
      profit: ${poc.profit}`
    );

    if (poc.profit >= MAX_PROFIT && poc.status === "open") {
      console.log(`🛑 Closing trade: Profit reached ${poc.profit}`);
      ws.send(JSON.stringify({ sell: poc.contract_id, price: 0 }));
    }

    if (poc.status !== "open") {
      console.log("🏁 Contract closed. Final Profit:", poc.profit);
      ws.close();
    }
    return;
  }
};

ws.onerror = (err) => console.error("⚠️ WebSocket error:", err.message || err);
ws.onclose = () => console.log("🔒 WebSocket closed.");
