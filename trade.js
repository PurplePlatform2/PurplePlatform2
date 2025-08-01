const WebSocket = require('ws');

// Required args
const TOKEN = process.argv[2];
const RAW_RESPONSE = process.argv[3]; // Optional: raw JSON string from /predict

if (!TOKEN) {
  console.error("❌ Usage: node trade.js YOUR_API_TOKEN [RAW_PREDICTION_JSON]");
  process.exit(1);
}

const SYMBOL = "stpRNG";
const MULTIPLIER = 5000;
const RISK_PERCENT = 10;

let contractId = null;
let sold = false;
let initialBalance = null;
let dynamicStake = 2000;
let ws;

connectWebSocket();

function connectWebSocket() {
  ws = new WebSocket("wss://ws.derivws.com/websockets/v3?app_id=1089");

  ws.onopen = () => {
    console.log("📡 Connecting...");
    ws.send(JSON.stringify({ authorize: TOKEN }));
  };

  ws.onmessage = ({ data }) => {
    const res = JSON.parse(data);
    console.log("📥", res);

    if (res.error) {
      console.error("❌", res.error.message);
      ws.close();
      return;
    }

    switch (res.msg_type) {
      case "authorize":
        console.log("🔓 Authorized");
        ws.send(JSON.stringify({ balance: 1, subscribe: 0 }));
        break;

      case "balance":
        if (initialBalance === null) {
          initialBalance = res.balance.balance;
          dynamicStake = Math.floor((initialBalance * RISK_PERCENT) / 100);
          console.log("💰 Balance before trade:", initialBalance);
          console.log("⚖️ Dynamic stake set to:", dynamicStake);
          fetchPredictionAndTrade(RAW_RESPONSE);
        } else {
          console.log("💸 Balance after trade:", res.balance.balance);
          ws.close();
        }
        break;

      case "proposal":
        console.log("📨 Buying Proposal:", res.proposal.id);
        ws.send(JSON.stringify({ buy: res.proposal.id, price: dynamicStake }));
        break;

      case "buy":
        contractId = res.buy.contract_id;
        console.log("✅ Bought:", contractId);
        ws.send(JSON.stringify({
          subscribe: 1,
          proposal_open_contract: 1,
          contract_id: contractId
        }));
        break;

      case "proposal_open_contract":
        const profit = res.proposal_open_contract.profit;
        console.log("📊 Current Profit:", profit);

        if (profit > 0 && !sold) {
          sold = true;
          console.log("📈 Profit detected. Selling...");
          ws.send(JSON.stringify({ sell: contractId, price: 0 }));
        }
        break;

      case "sell":
        console.log("💰 Contract Sold:", res.sell);
        ws.send(JSON.stringify({ balance: 1, subscribe: 0 }));
        break;
    }
  };

  ws.onclose = () => {
    if (!sold) {
      console.log("🔁 WebSocket closed. Attempting reconnect in 3 seconds...");
      setTimeout(connectWebSocket, 3000);
    }
  };

  ws.onerror = (err) => {
    console.error("⚠️ WebSocket error:", err.message);
    ws.close();
  };
}

async function fetchPredictionAndTrade(raw) {
  try {
    let predicted_high, predicted_low, last_candle_high, last_candle_low;

    if (raw) {
      console.log("📦 Using provided prediction JSON string...");
      const parsed = JSON.parse(raw);
      predicted_high = parseFloat(parsed.predicted_high);
      predicted_low = parseFloat(parsed.predicted_low);
      last_candle_high = parseFloat(parsed.last_candle_high);
      last_candle_low = parseFloat(parsed.last_candle_low);
    } else {
      const fetch = require('node-fetch');
      const res = await fetch("https://purplebot-official.onrender.com/predict");
      const json = await res.json();
      predicted_high = json.predicted_high;
      predicted_low = json.predicted_low;
      last_candle_high = json.last_candle_high;
      last_candle_low = json.last_candle_low;
    }

    console.log("📈 Prediction:", { predicted_high, predicted_low });
    console.log("📉 Last Candle:", { last_candle_high, last_candle_low });

    let direction = null;

    if (predicted_high > last_candle_high && predicted_low > last_candle_low) {
      direction = "MULTUP";
      console.log("🟢 Signal: BUY (Momentum Up)");
    } else if (predicted_high < last_candle_high && predicted_low < last_candle_low) {
      direction = "MULTDOWN";
      console.log("🔴 Signal: SELL (Momentum Down)");
    } else {
      console.log("⚪️ No clear momentum. Exiting.");
      ws.close();
      return;
    }

    ws.send(JSON.stringify({
      proposal: 1,
      symbol: SYMBOL,
      contract_type: direction,
      amount: dynamicStake,
      basis: "stake",
      currency: "USD",
      multiplier: MULTIPLIER
    }));

  } catch (err) {
    console.error("❌ Prediction processing error:", err.message);
    ws.close();
  }
}
