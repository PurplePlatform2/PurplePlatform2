/* =====================================================
 *  ATR 1-Minute Range Strategy (Node.js + Browser)
 *  Author: Dr. Sanne Karibo
 *  Description: Checks last 1-minute candle.
 *               If range >= 2.2 → trade in candle direction.
 *               Manages ALL open multiplier contracts
 *               (including those not opened by this script),
 *               closing each when its profit target hits.
 * ===================================================== */

// === Auto-detect WebSocket implementation ===
let WSClass;
if (typeof window !== "undefined" && window.WebSocket) WSClass = window.WebSocket;
else WSClass = require("ws");

// === CONFIG ===
const APP_ID = 1089;                // Your Deriv App ID
const token = "tUgDTQ6ZclOuNBl";    // 🔐 Replace with real token
const SYMBOL = "stpRNG";
const STAKE = 10;
const MULTIPLIER = 2000;
const RANGE_THRESHOLD = 2.2;        // ATR threshold
const MAX_PROFIT = 0.01;            // close when reached
const TIMEFRAME = 60;               // 1-minute candles

// === STATE ===
let ws, authorized = false;
let openContracts = new Map(); // {id: profit}

// === INIT ===
function connect() {
  ws = new WSClass(`wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`);
  ws.onopen = () => ws.send(JSON.stringify({ authorize: token }));
  ws.onmessage = handleMessage;
  ws.onerror = (err) => console.error("⚠️ WebSocket error:", err.message || err);
}

// === MESSAGE HANDLER ===
function handleMessage(msg) {
  const data = JSON.parse(msg.data || msg);

  if (data.error) return console.error("❌ Error:", data.error.message);

  switch (data.msg_type) {
    case "authorize":
      authorized = true;
      console.log("✅ Authorized:", data.authorize.loginid);
      fetchOpenContracts();       // ← NEW: manage already open contracts
      subscribeCandles();
      break;

    case "candles":
      if (data.candles?.length) analyzeCandle(data.candles);
      break;

    case "buy":
      const cid = data.buy.contract_id;
      console.log("🟢 Bought contract:", cid);
      openContracts.set(cid, 0);
      subscribeContract(cid);
      break;

    case "proposal_open_contract":
      manageContract(data.proposal_open_contract);
      break;

    case "portfolio":
      if (data.portfolio?.contracts?.length) {
        data.portfolio.contracts.forEach(c => {
          if (!openContracts.has(c.contract_id)) {
            console.log(`📥 Found existing open contract: ${c.contract_id}`);
            openContracts.set(c.contract_id, 0);
            subscribeContract(c.contract_id);
          }
        });
      } else {
        console.log("📭 No existing open contracts found.");
      }
      break;

    default:
      break;
  }
}

// === FETCH ANY CURRENTLY OPEN CONTRACTS ===
function fetchOpenContracts() {
  console.log("📡 Fetching open contracts...");
  ws.send(JSON.stringify({ portfolio: 1 }));
}

// === SUBSCRIBE TO 1-MINUTE CANDLES ===
function subscribeCandles() {
  console.log("📡 Subscribing to 1-minute candles...");
  ws.send(JSON.stringify({
    ticks_history: SYMBOL,
    count: 2,
    style: "candles",
    end: "latest",
    granularity: TIMEFRAME,
    subscribe: 1,
  }));
}

// === ANALYZE LAST COMPLETED CANDLE ===
function analyzeCandle(candles) {
  const last = candles[0];
  if (!last) return console.log("No finished candle found");

  const nowSec = Math.floor(Date.now() / 1000);
  if (nowSec - last.epoch < TIMEFRAME) return; // still forming

  const range = last.high - last.low;
  const bullish = last.close > last.open;
  const bearish = last.close < last.open;

  console.log(
    `🕒 Candle ${new Date(last.epoch * 1000).toLocaleTimeString()} | O:${last.open} H:${last.high} L:${last.low} C:${last.close} | Range=${range.toFixed(2)}`
  );

  if (range >= RANGE_THRESHOLD) {
    const type = bullish ? "MULTUP" : bearish ? "MULTDOWN" : null;
    if (type) executeTrade(type);
  }
}

// === EXECUTE TRADE ===
function executeTrade(contract_type) {
  ws.send(JSON.stringify({
    buy: 1,
    price: STAKE,
    parameters: {
      amount: STAKE,
      basis: "stake",
      contract_type,
      currency: "USD",
      multiplier: MULTIPLIER,
      symbol: SYMBOL,
    },
  }));
  console.log(`🚀 Sent ${contract_type} trade`);
}

// === SUBSCRIBE TO CONTRACT UPDATES ===
function subscribeContract(contract_id) {
  ws.send(JSON.stringify({
    proposal_open_contract: 1,
    contract_id,
    subscribe: 1,
  }));
}

// === MANAGE CONTRACTS ===
function manageContract(poc) {
  if (!poc || !poc.contract_id) return;
  const cid = poc.contract_id;
  const profit = poc.profit || 0;

  if (poc.status === "open") {
    console.log(
      `📈 Contract ${cid}: entry=${poc.buy_price}, current=${poc.current_spot}, profit=${profit}`
    );

    if (profit >= MAX_PROFIT) {
      console.log(`💰 Profit ${profit} reached — closing ${cid}`);
      ws.send(JSON.stringify({ sell: cid, price: 0 }));
    }
  } else if (poc.status !== "open") {
    console.log(`🏁 Contract ${cid} closed. Final profit: ${profit}`);
    openContracts.delete(cid);
    if (openContracts.size === 0) console.log("✅ All contracts closed.");
  }
}

// === START ===
connect();
