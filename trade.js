// deriv-strategy.js
// Node.js + Browser compatible

const APP_ID = 1089; // Replace with your app_id
const TOKEN = "tUgDTQ6ZclOuNBl"; // Replace with your token
const SYMBOL = "stpRNG"; // Example symbol
const STAKE = 1; // Stake in USD
const DURATION = 15; // Contract duration
const DURATION_UNIT = "s"; // 't' = ticks, 's' = seconds, 'm' = minutes

let ws = new (require('ws'))(`wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`);
let contractType = null;

ws.onopen = () => {
  console.log("Connected to Deriv API");
  authorize();}

function authorize() {
  ws.send(JSON.stringify({ authorize: TOKEN }));
}

ws.onmessage = (msg) => {
  const data = JSON.parse(msg.data);

  if (data.error) {
    console.error("Error:", data.error.message);
    return;
  }

  switch (data.msg_type) {
    case "authorize":
      console.log("Authorized ✅");
      fetchCandles();
      break;

    case "candles":
      handleCandleData(data.candles);
      break;

    case "history":
      handleTickData(data.history.prices);
      break;

    case "buy":
      console.log("Trade bought:", data.buy.contract_id);
      ws.send(JSON.stringify({
        proposal_open_contract: 1,
        contract_id: data.buy.contract_id,
        subscribe: 1
      }));
      break;

    case "proposal_open_contract":
      console.log("Contract update:", data.proposal_open_contract.profit);
      break;
  }
};

// === Step 1: Get last 4 candles ===
function fetchCandles() {
  ws.send(JSON.stringify({
    ticks_history: SYMBOL,
    style: "candles",
    granularity: 60, 
    count: 4,
    end: "latest"
  }));
}

// === Step 2: Candle logic ===
function handleCandleData(candles) {
  if (candles.length < 4) return;

  let c1 = candles[2].close; // close[1]
  let h2 = candles[1].high;  // high[2]
  let h3 = candles[0].high;  // high[3]
  let l2 = candles[1].low;   // low[2]
  let l3 = candles[0].low;   // low[3]

  if (c1 > h2 && c1 > h3) {
    contractType = "CALL";
    console.log("Candle signal: CALL");
  } else if (c1 < l2 && c1 < l3) {
    contractType = "PUT";
    console.log("Candle signal: PUT");
  } else {
    console.log("No signal from candles\n",JSON.stringify(candles));
    return;
  }

  // Now fetch ticks for regression
  fetchTicks();
}

// === Step 3: Get last 100 ticks ===
function fetchTicks() {
  ws.send(JSON.stringify({
    ticks_history: SYMBOL,
    count: 100,
    end: "latest",
    style: "ticks"
  }));
}

// === Step 4: Regression analysis ===
function handleTickData(prices) {
  if (!contractType) return;

  let n = prices.length;
  let xMean = (n - 1) / 2;
  let yMean = prices.reduce((a, b) => a + b, 0) / n;

  let num = 0, den = 0;
  prices.forEach((p, i) => {
    num += (i - xMean) * (p - yMean);
    den += (i - xMean) ** 2;
  });

  let slope = num / den;
  console.log("Regression slope:", slope);

  if ((contractType === "CALL" && slope > 0) ||
      (contractType === "PUT" && slope < 0)) {
    placeTrade(contractType);
  } else {
    console.log("Regression filter blocked trade");
  }
}

// === Step 5: Place trade ===
function placeTrade(type) {
  ws.send(JSON.stringify({
    buy: 1,
    price: STAKE,
    parameters: {
      symbol: SYMBOL,
      contract_type: type,
      duration: DURATION,
      duration_unit: DURATION_UNIT,
      basis: "stake",
      amount: STAKE,
      currency: "USD"
    }
  }));
}
