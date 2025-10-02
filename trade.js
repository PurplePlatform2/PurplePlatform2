/* === Professional Candle Strategy: Engulfing + Momentum Confirmation === */

// Use browser WebSocket if available, otherwise require("ws") for Node
const WSClass = (typeof window !== "undefined" && window.WebSocket) ? window.WebSocket : require("ws");

/* === CONFIG === */
const APP_ID = 1089; // Replace with your App ID
const TOKEN = "tUgDTQ6ZclOuNBl"; // Replace with your API token
const SYMBOL = "stpRNG"; // Market symbol
const STAKE = 0.35; // stake amount
const DURATION = 59; // seconds

// === WebSocket Connection ===
const ws = new WSClass(`wss://ws.binaryws.com/websockets/v3?app_id=${APP_ID}`);

ws.onopen = () => {
  console.log("Connected ✅");
  ws.send(JSON.stringify({ authorize: TOKEN }));
};

ws.onmessage = (msg) => {
  const data = JSON.parse(msg.data);

  if (data.error) {
    console.error("❌ Error:", data.error.message);
    return;
  }

  // === Step 1: Authorize and request candles ===
  if (data.msg_type === "authorize") {
    console.log("Authorized as:", data.authorize.loginid);
    ws.send(JSON.stringify({
      ticks_history: SYMBOL,
      style: "candles",
      count: 5,
      end: "latest",
      granularity: 60 // 1-minute candles
    }));
  }

  // === Step 2: Evaluate entry condition ===
  if (data.msg_type === "candles") {
    const candles = data.candles;
    const c1 = candles[candles.length - 3]; // third last
    const c2 = candles[candles.length - 2]; // second last (setup candle)
    const c3 = candles[candles.length - 1]; // most recent closed

    console.log("Last 3 Candles:", { c1, c2, c3 });

    // Bearish Engulfing + Momentum Filter
    const bearishEngulfing = (c2.close > c2.open) && (c3.open > c2.close) && (c3.close < c2.open);
    const momentumFilter = (c3.close < c1.close); // confirms short-term weakness

    if (bearishEngulfing && momentumFilter) {
      console.log("✅ Entry Condition Met → PUT trade");

      ws.send(JSON.stringify({
        proposal: 1,
        amount: STAKE,
        basis: "stake",
        contract_type: "PUT",
        currency: "USD",
        duration: DURATION,
        duration_unit: "s",
        symbol: SYMBOL
      }));
    } else {
      console.log("⚠️ No valid entry, conditions not met.");
    }
  }

  // === Step 3: Receive Proposal ===
  if (data.msg_type === "proposal") {
    console.log("Proposal received →", data.proposal.display_value);
    ws.send(JSON.stringify({ buy: data.proposal.id, price: STAKE }));
  }

  // === Step 4: Trade Confirmation ===
  if (data.msg_type === "buy") {
    console.log("📌 Trade Executed | Transaction ID:", data.buy.transaction_id);
  }
};
