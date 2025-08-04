const ws = new (require('ws'))('wss://ws.derivws.com/websockets/v3?app_id=1089');
const TOKEN = process.argv[2] || "JklMzewtX7Da9mT";
const SYMBOL = "stpRNG";
const MULTIPLIER = 5000;

let contractId = null;
let sold = false;
let initialBalance = null;
let STAKE= 2000;

ws.onopen = () => {
  console.log("📡 Connecting...");
  ws.send(JSON.stringify({ authorize: TOKEN }));
};

ws.onmessage = ({ data }) => {
  const res = JSON.parse(data);
  console.log("📥", res);

  if  (res.error) return console.error("❌", res.error.message), ws.close();

  switch (res.msg_type) {
    case "authorize":
      console.log("🔓 Authorized");
      ws.send(JSON.stringify({ balance: 1, subscribe: 0 }));
      break;

    case "balance":
      if (initialBalance === null) {
        initialBalance = res.balance.balance;
       STAKE = Math.min(Math.max(initialBalance*0.01, 1), 2000);
         console.log(`💰 Balance before trade: ${initialBalance}\n💵 Stake = ${STAKE}`);
         fetchPredictionAndTrade();
      } else {
        console.log("💸 Balance after trade:", res.balance.balance);
        ws.close();
      }
      break;

    case "proposal":
      console.log("📨 Buying Proposal:", res.proposal.id);
      ws.send(JSON.stringify({ buy: res.proposal.id, price: +Number(STAKE).toFixed(1) }));
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

// 🧠 Fetch prediction and determine trade direction
// 🧠 Improved Fetch prediction and determine trade direction
async function fetchPredictionAndTrade() {
  try {
    const res = process.argv[3]
      ? { json: async () => JSON.parse(process.argv[3]) }
      : await fetch("https://purplebot-official.onrender.com/predict");

    const { predicted_high, predicted_low, last_candle_high, last_candle_low } = await res.json();

    console.log("📈 Prediction:", { predicted_high, predicted_low });
    console.log("📉 Last Candle:", { last_candle_high, last_candle_low });

    const actual_range = last_candle_high - last_candle_low;
    const predicted_range = predicted_high - predicted_low;

    if (actual_range === 0) {
      console.log("⚠️ Flat candle detected. Skipping trade.");
      ws.close();
      return;
    }

    const range_ratio = predicted_range / actual_range;

    const predicted_mid = (predicted_high + predicted_low) / 2;
    const last_mid = (last_candle_high + last_candle_low) / 2;
    const bias = predicted_mid - last_mid;
    const bias_strength = bias / actual_range;

    console.log("📐 Range Ratio:", range_ratio.toFixed(3));
    console.log("⚖️ Bias Strength:", bias_strength.toFixed(3));

    let direction = null;

    if (range_ratio > 1.1 && bias_strength > 0.25) {
      direction = "MULTUP";
      console.log("🟢 Strong BUY signal");
    } else if (range_ratio > 1.1 && bias_strength < -0.25) {
      direction = "MULTDOWN";
      console.log("🔴 Strong SELL signal");
    } else {
      console.log("⚪️ No strong signal. Skipping.");
      ws.close();
      return;
    }

    ws.send(JSON.stringify({
      proposal: 1,
      symbol: SYMBOL,
      contract_type: direction,
      amount: +Number(STAKE).toFixed(1),
      basis: "stake",
      currency: "USD",
      multiplier: MULTIPLIER
    }));

  } catch (err) {
    console.error("❌ Failed to fetch prediction:", err.message);
    ws.close();
  }
}
