const ws = new (require('ws'))('wss://ws.derivws.com/websockets/v3?app_id=1089');
const TOKEN = process.argv[2] || "JklMzewtX7Da9mT";
const SYMBOL = "stpRNG";
const STAKE = 2000;
const MULTIPLIER = 5000;

let contractId = null;
let sold = false;
let initialBalance = null;

ws.onopen = () => {
  console.log("📡 Connecting...");
  ws.send(JSON.stringify({ authorize: TOKEN }));
};

ws.onmessage = ({ data }) => {
  const res = JSON.parse(data);
  console.log("📥", res);

  if (res.error) return console.error("❌", res.error.message), ws.close();

  switch (res.msg_type) {
    case "authorize":
      console.log("🔓 Authorized");
      ws.send(JSON.stringify({ balance: 1, subscribe: 0 }));
      break;

    case "balance":
      if (initialBalance === null) {
        initialBalance = res.balance.balance;
        console.log("💰 Balance before trade:", initialBalance);
        fetchPredictionAndTrade();
      } else {
        console.log("💸 Balance after trade:", res.balance.balance);
        ws.close();
      }
      break;

    case "proposal":
      console.log("📨 Buying Proposal:", res.proposal.id);
      ws.send(JSON.stringify({ buy: res.proposal.id, price: STAKE }));
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
async function fetchPredictionAndTrade() {
  try {
    const res = process.argv[3] ? { json: async () => JSON.parse(process.argv[3]) } : await fetch("https://purplebot-official.onrender.com/predict");
    const { predicted_high, predicted_low, last_candle_high, last_candle_low } = await res.json();

    console.log("📈 Prediction:", { predicted_high, predicted_low });
    console.log("📉 Last Candle:", { last_candle_high, last_candle_low });

    let direction = null;

    if (predicted_high > last_candle_high) {
      direction = "MULTUP";
      console.log("🟢 Signal: BUY (MULTUP)");
    } else if (predicted_low < last_candle_low) {
      direction = "MULTDOWN";
      console.log("🔴 Signal: SELL (MULTDOWN)");
    } else {
      console.log("⚪️ No clear signal. Exiting.");
      ws.close();
      return;
    }

    ws.send(JSON.stringify({
      proposal: 1,
      symbol: SYMBOL,
      contract_type: direction,
      amount: STAKE,
      basis: "stake",
      currency: "USD",
      multiplier: MULTIPLIER
    }));

  } catch (err) {
    console.error("❌ Failed to fetch prediction:", err.message);
    ws.close();
  }
}
