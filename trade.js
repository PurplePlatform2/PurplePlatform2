/* === Dual CALL & PUT Smart Bot + True Fractals + Trend Strength === */
const WSClass = (typeof window !== "undefined" && window.WebSocket) ? window.WebSocket : require("ws");

/* === CONFIG === */
const APP_ID = 1089;
const TOKEN = "tUgDTQ6ZclOuNBl"; // 🔐 Replace with your token
const SYMBOL = "stpRNG";
const STAKE = 1, DURATION = 59, MAX_PROFIT = 0.20; // duration in seconds

/* === CONNECTION === */
const ws = new WSClass(`wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`);

ws.onopen = () => {
  console.log("🔌 Connecting...");
  ws.send(JSON.stringify({ authorize: TOKEN }));
};

ws.onmessage = (msg) => {
  const data = JSON.parse(msg.data || msg);
  if (data.error) return console.error("❌ Error:", data.error.message);

  switch (data.msg_type) {
    case "authorize":
      console.log("✅ Authorized:", data.authorize.loginid);
      ws.send(JSON.stringify({ portfolio: 1 }));
      requestCandles();
      break;

    case "portfolio":
      (data.portfolio?.contracts || []).forEach(c => {
        console.log(`📌 Managing contract ${c.contract_id}`);
        ws.send(JSON.stringify({ proposal_open_contract: 1, contract_id: c.contract_id, subscribe: 1 }));
      });
      break;

    case "candles": {
      let candles = data.candles;
      if (!candles || candles.length < 6) return;

      candles = candles.slice(0, -1); // drop unfinished
      const last5 = candles.slice(-5);
      if (last5.length < 5) return;

      const [c1, c2, c3, c4, c5] = last5;
      const high = +c5.high, low = +c5.low, close = +c5.close;
      const range = high - low, closePct = range ? ((close - low) / range) * 100 : null;

      // 🔮 Trend Strength (0–100)
      const closes = candles.map(c => +c.close);
      let gains = 0, losses = 0;
      for (let i = 1; i < closes.length; i++) {
        const diff = closes[i] - closes[i - 1];
        if (diff > 0) gains += diff;
        else losses -= diff;
      }
      const rs = losses ? gains / losses : 100;
      const trendStrength = 100 - (100 / (1 + rs));

      // ✅ Higher-high / Lower-low checks
      const isHigherHigh = c5.high > c4.high && c5.high > c3.high;
      const isLowerLow = c5.low < c4.low && c5.low < c3.low;

      // --- 🔮 Bill Williams Fractals ---
      const mid = c3;
      const f_up =
        mid.high > c1.high &&
        mid.high > c2.high &&
        mid.high > c4.high &&
        mid.high > c5.high;

      const f_down =
        mid.low < c1.low &&
        mid.low < c2.low &&
        mid.low < c4.low &&
        mid.low < c5.low;

      console.log(`📊 H:${high} L:${low} C:${close} %:${closePct?.toFixed(2)} | 📈 Trend:${trendStrength.toFixed(1)}`);
      console.log(`🔮 FractalUp:${f_up} FractalDown:${f_down}`);
      console.log(`📈 HigherHigh:${isHigherHigh} LowerLow:${isLowerLow}`);

      // === Entry Condition ===
      if ((isHigherHigh && closePct >= 80 && f_down) ||
          (isLowerLow && closePct <= 20 && f_up)) {
        placeDualTrade();
      } else {
        console.log("⏸ No valid entry condition. Retrying in 60s...");
        setTimeout(requestCandles, 60000);
      }
      break;
    }

    case "buy":
      console.log("✅ Bought contract:", data.buy.contract_id, "|", data.buy.longcode);
      ws.send(JSON.stringify({
        proposal_open_contract: 1,
        contract_id: data.buy.contract_id,
        subscribe: 1
      }));
      break;

    case "proposal_open_contract": {
      const poc = data.proposal_open_contract;
      if (!poc) return;
      console.log(`📈 Contract ${poc.contract_id} | PnL:${poc.profit} | ${poc.status}`);
      if (poc.profit >= MAX_PROFIT && poc.status === "open") {
        console.log(`🛑 Closing ${poc.contract_id} (profit ${poc.profit})`);
        ws.send(JSON.stringify({ sell: poc.contract_id, price: 0 }));
      }
      if (poc.status !== "open") console.log(`🏁 Closed ${poc.contract_id}. Final PnL:${poc.profit}`);
      break;
    }
  }
};

/* === Place Dual CALL + PUT === */
function placeDualTrade() {
  console.log("🚀 Placing CALL & PUT trades...");
  ["CALL", "PUT"].forEach(type => {
    ws.send(JSON.stringify({
      buy: 1, price: STAKE,
      parameters: {
        amount: STAKE, basis: "stake",
        contract_type: type, currency: "USD",
        duration: DURATION, duration_unit: "s",
        symbol: SYMBOL
      }
    }));
  });
}

function requestCandles() {
  ws.send(JSON.stringify({
    ticks_history: SYMBOL,
    count: 100,
    granularity: 60,
    style: "candles",
    end: "latest",
    adjust_start_time: 1
  }));
}
