/* === One-shot SMA Candle Bot (Node.js) === */

const WSClass = (typeof window !== "undefined" && window.WebSocket) ? window.WebSocket : require("ws");

/* === CONFIG === */
const APP_ID = 1089; // Replace with your App ID
const TOKEN = "tUgDTQ6ZclOuNBl"; // Replace with your API token
const SYMBOL = "stpRNG"; // Market symbol
const STAKE = 1; // stake in USD
const DURATION = 59; // seconds
const SMA_PERIOD = 10;
const GRANULARITY = 60; // 1-min candles

const ws = new WSClass(`wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`);

ws.onopen = () => {
  console.log("✅ Connected to Deriv API");
  ws.send(JSON.stringify({ authorize: TOKEN }));
};

ws.onmessage = (msg) => {
  const data = JSON.parse(msg.data);

  if (data.error) {
    console.error("❌ Error:", data.error.message);
    ws.close();
    process.exit(1);
  }

  // === Authorized ===
  if (data.msg_type === "authorize") {
    console.log("🔑 Authorized as:", data.authorize.loginid);

    // Request 10 candles
    ws.send(JSON.stringify({
      ticks_history: SYMBOL,
      style: "candles",
      count: SMA_PERIOD,
      end: "latest",
      granularity: GRANULARITY
    }));
  }

  // === Got 10-candle history ===
  if (data.msg_type === "candles") {
    const candles = data.candles;
    if (candles.length < SMA_PERIOD) {
      console.log("⚠ Not enough candles");
      ws.close();
      process.exit(0);
    }

    const sma = candles.reduce((sum, c) => sum + c.close, 0) / SMA_PERIOD;
    const lastCandle = candles[candles.length - 1];

    let tradeType = null;
    if (lastCandle.close > sma) tradeType = "CALL";
    else if (lastCandle.close < sma) tradeType = "PUT";

    console.log(
      `📊 Last Candle Close: ${lastCandle.close}, SMA(${SMA_PERIOD}): ${sma.toFixed(2)}`
    );

    if (!tradeType) {
      console.log("⏸ No trade signal.");
      ws.close();
      process.exit(0);
    }

    console.log(`✅ Trade Signal: ${tradeType}`);

    ws.send(JSON.stringify({
      proposal: 1,
      amount: STAKE,
      basis: "stake",
      contract_type: tradeType,
      currency: "USD",
      duration: DURATION,
      duration_unit: "s",
      symbol: SYMBOL
    }));
  }

  // === Got Proposal ===
  if (data.msg_type === "proposal" && data.proposal) {
    console.log(
      `📩 Proposal → ${data.proposal.contract_type} @ ${data.proposal.display_value}`
    );

    ws.send(JSON.stringify({ buy: data.proposal.id, price: STAKE }));
  }

  // === Trade Bought ===
  if (data.msg_type === "buy" && data.buy) {
    console.log(`🎯 Bought ${data.buy.contract_type} | ID: ${data.buy.contract_id}`);
    ws.close();
    if (typeof window == "undefined")process.exit(0);
  }
};
