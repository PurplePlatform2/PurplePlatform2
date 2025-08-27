// === CONFIG ===
const APP_ID = 1089; // Your Deriv app_id
const API_TOKEN = process.argv[2] || "JklMzewtX7Da9mT"; // Your API token
const SYMBOL = "stpRNG"; // Your market
const GRANULARITY = 60; // 1-minute candles
const STAKE = process.argv[3] || 0.35; // USD
const DURATION = 60; // seconds
const MAX_PYRAMID = 10;
const CANDLE_COUNT = 5; // last 5 candles

// Support Node.js & browser
let WebSocketClass;
if (typeof window === "undefined") {
  WebSocketClass = require("ws");
} else {
  WebSocketClass = WebSocket;
}

const ws = new WebSocketClass(`wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`);

let expiryTime = null;
let pyramidCount = 0;

// --- AUTHENTICATE ---
ws.onopen = () => {
  console.log("🔌 Connected to Deriv");

  // Authorize first
  ws.send(JSON.stringify({ authorize: API_TOKEN }));
};

ws.onmessage = (msg) => {
  const data = JSON.parse(msg.data);

  if (data.error) {
    console.error("❌ Error:", data.error.message || data.error.code);
    return;
  }

  switch (data.msg_type) {
    case "authorize":
      console.log("🔑 Authorized as:", data.authorize.loginid);
      fetchLastCandles(CANDLE_COUNT);
      break;

    case "candles":
      if (!data.candles || !data.candles.length) return;
      const candles = data.candles.reverse(); // oldest first
      console.log("🕯 Last candles:", candles.map(c => c.close));

      const CONTRACT_TYPE = analyzeCandles(candles);
      console.log("📊 Analysis suggests:", CONTRACT_TYPE);

      placeInitialTrade(CONTRACT_TYPE);
      
      break;

    case "proposal":
      console.log("📩 Proposal:", data.proposal.longcode);
      buyContract(data.proposal.id);
      break;

    case "buy":
      console.log(`💸 Bought contract (${data.buy.contract_id}) at ${data.buy.buy_price}`);
      break;

    case "proposal_open_contract":
      if (data.proposal_open_contract.is_sold) {
        console.log(`✅ Contract settled. Result: ${data.proposal_open_contract.status}`);
        console.log(`Payout: ${data.proposal_open_contract.payout}, Profit: ${data.proposal_open_contract.profit}`);
      }
      break;
  }
};

// --- FUNCTIONS ---

function fetchLastCandles(count) {
  ws.send(JSON.stringify({
    ticks_history: SYMBOL,
    style: "candles",
    granularity: GRANULARITY,
    count,
    end: "latest",
    subscribe: 1
  }));
}

// Analyze candles (majority green = CALL, else PUT)
function analyzeCandles(candles) {
  const greenCount = candles.filter(c => c.close > c.open).length;
  return greenCount >= Math.ceil(candles.length / 2) ? "CALL" : "PUT";
}

function placeInitialTrade(CONTRACT_TYPE) {
  expiryTime = Math.floor(Date.now() / 1000) + DURATION;
  console.log("🎯 Placing initial trade:", CONTRACT_TYPE);

  ws.send(JSON.stringify({
    proposal: 1,
    amount: STAKE,
    basis: "stake",
    contract_type: CONTRACT_TYPE,
    currency: "USD",
    duration: DURATION,
    duration_unit: "s",
    symbol: SYMBOL
  }));

  setTimeout(() => placePyramidTrade(CONTRACT_TYPE), 3000);
}

function placePyramidTrade(CONTRACT_TYPE) {
  if (pyramidCount >= MAX_PYRAMID) return;

  pyramidCount++;
  console.log(`📊 Pyramiding trade #${pyramidCount}`);

  const remainingTime = expiryTime - Math.floor(Date.now() / 1000);
  if (remainingTime <= 5) {
    console.log("⚠️ Too close to expiry, skipping pyramid trade.");
    return;
  }

  ws.send(JSON.stringify({
    proposal: 1,
    amount: STAKE,
    basis: "stake",
    contract_type: CONTRACT_TYPE,
    currency: "USD",
    duration: remainingTime,
    duration_unit: "s",
    symbol: SYMBOL
  }));

  if (pyramidCount < MAX_PYRAMID) {
    setTimeout(() => placePyramidTrade(CONTRACT_TYPE), 3000);
  }
}

function buyContract(proposalId) {
  ws.send(JSON.stringify({ buy: proposalId, price: STAKE }));
}
