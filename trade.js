/* === Multi-Contract Smart Multiplier Bot + True Fractals === */
const WSClass = (typeof window !== "undefined" && window.WebSocket) ? window.WebSocket : require("ws");

/* === CONFIG === */
const APP_ID = 1089;
const TOKEN = "tUgDTQ6ZclOuNBl"; // 🔐 Replace with your token
const SYMBOL = "stpRNG";
const STAKE = 1, MULTIPLIER = 750, MAX_PROFIT = 0.02; // USD

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
      ws.send(JSON.stringify({
        ticks_history: SYMBOL, count: 10, granularity: 60,
        style: "candles", end: "latest", adjust_start_time: 1
      }));
      break;

    case "portfolio":
      (data.portfolio?.contracts || []).forEach(c => {
        console.log(`📌 Managing contract ${c.contract_id}`);
        ws.send(JSON.stringify({ proposal_open_contract: 1, contract_id: c.contract_id, subscribe: 1 }));
      });
      break;

    case "candles": {
      let candles = data.candles;
      if (!candles || candles.length < 5) return;
      candles = candles.slice(0, -1); // drop unfinished
      if (candles.length < 5) return;

      const last = candles.at(-1), prev1 = candles.at(-2), prev2 = candles.at(-3);
      const high = +last.high, low = +last.low, close = +last.close;
      const range = high - low, closePct = range ? ((close - low) / range) * 100 : null;

      // ✅ Corrected entry logic
      const isHigherHigh = close > prev1.high && close > prev2.high;
      const isLowerLow = close < prev1.low && close < prev2.low;

      // --- 🔮 True Bill Williams Fractals ---
      const midIndex = candles.length - 3, mid = candles[midIndex];
      if (midIndex < 2) return;

      const f_up =
        mid.high > candles[midIndex - 2].high &&
        mid.high > candles[midIndex - 1].high &&
        mid.high > candles[midIndex + 1].high &&
        mid.high > candles[midIndex + 2].high;

      const f_down =
        mid.low < candles[midIndex - 2].low &&
        mid.low < candles[midIndex - 1].low &&
        mid.low < candles[midIndex + 1].low &&
        mid.low < candles[midIndex + 2].low;

      console.log(`📊 H:${high} L:${low} C:${close} %:${closePct?.toFixed(2)}`);
      console.log(`🔮 FractalUp:${f_up} FractalDown:${f_down}`);
      console.log(`📈 HigherHigh:${isHigherHigh} LowerLow:${isLowerLow}`);

      if (isHigherHigh && closePct >= 80 && f_up) placeTrade("MULTUP");
      else if (isLowerLow && closePct <= 20 && f_down) placeTrade("MULTDOWN");
      else console.log("⏸ No valid entry condition.");
      break;
    }

    case "buy":
      console.log("✅ Bought contract:", data.buy.contract_id);
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

function placeTrade(type) {
  console.log(`🚀 Placing ${type} trade...`);
  ws.send(JSON.stringify({
    buy: 1, price: STAKE,
    parameters: { amount: STAKE, basis: "stake", contract_type: type, currency: "USD", multiplier: MULTIPLIER, symbol: SYMBOL }
  }));
}
