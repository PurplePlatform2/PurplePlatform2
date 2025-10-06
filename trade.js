/* === XGreen / XRed Continuous Multiplier Bot (with Tick Stream + OverBought/Oversold Filter) ===
   - Subscribes to ticks continuously (live market watch)
   - Dynamically maintains recent 8 candles
   - Detects XGreen / XRed entries in real time
   - Avoids trades near overbought/oversold levels
   - Tracks and auto-closes trades
*/

const WSClass = typeof window !== "undefined" && window.WebSocket ? window.WebSocket : require("ws");

/* === CONFIG === */
const APP_ID = 1089;
const TOKEN = "tUgDTQ6ZclOuNBl"; // Replace with your Deriv token
const SYMBOL = "RB100";
const MULTIPLIER = 2000;
const STAKE = 1000;
const MAX_PROFIT = 0.01;
const AUTO_CLOSE = true;
const CANDLE_COUNT = 8;
const GRANULARITY = 300; // seconds per candle

/* === CONNECTION === */
const ws = new WSClass(`wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`);

/* === STATE === */
let candles = [];
const subscribedContracts = new Map();
let lastTradeTime = 0;

/* === HELPERS === */
const safe = (v) => (Number.isFinite(+v) ? +v : 0);
const now = () => new Date().toLocaleTimeString();

function handleError(msg) {
  console.error("❌", msg);
}

function updateCandles(tick) {
  if (!candles.length) return;

  const tickTime = Math.floor(tick.epoch / GRANULARITY) * GRANULARITY;
  const lastCandle = candles[candles.length - 1];

  if (tickTime === lastCandle.epoch) {
    // Update current candle
    lastCandle.close = tick.quote;
    if (tick.quote > lastCandle.high) lastCandle.high = tick.quote;
    if (tick.quote < lastCandle.low) lastCandle.low = tick.quote;
  } else {
    // Start new candle
    candles.push({
      epoch: tickTime,
      open: lastCandle.close,
      high: tick.quote,
      low: tick.quote,
      close: tick.quote,
    });
    if (candles.length > CANDLE_COUNT) candles.shift();
  }
}

function getSignal() {
  if (candles.length < 4) return null;
  const last = candles[candles.length - 2];
  const prev = candles[candles.length - 3];
  const current = candles[candles.length - 1];

  const isXGreen = last.close > prev.high && current.close > last.high;
  const isXRed = last.close < prev.low && current.close < last.low;

  if (isXGreen) return "XGREEN";
  if (isXRed) return "XRED";
  return null;
}

function isOverBoughtOrSold(signal) {
  if (candles.length < 7) return false;

  const highs = candles.slice(-7).map((c) => safe(c.high));
  const lows = candles.slice(-7).map((c) => safe(c.low));
  const highestHigh = Math.max(...highs);
  const lowestLow = Math.min(...lows);
  const lastPrice = candles[candles.length - 1].close;

  if (signal === "XGREEN") {
    const distance = highestHigh - lastPrice;
    return distance < 5; // overbought, avoid
  }

  if (signal === "XRED") {
    const distance = lastPrice - lowestLow;
    return distance < 5; // oversold, avoid
  }

  return false;
}

/* === HANDLERS === */
ws.onopen = () => {
  console.log("🔌 Connected to Deriv, authorizing...");
  ws.send(JSON.stringify({ authorize: TOKEN }));
};

ws.onmessage = (msg) => {
  const data = JSON.parse(msg.data || msg);

  if (data.error) return handleError(data.error.message);

  switch (data.msg_type) {
    case "authorize": {
      console.log("✅ Authorized:", data.authorize?.loginid);
      ws.send(
        JSON.stringify({
          ticks_history: SYMBOL,
          adjust_start_time: 1,
          count: CANDLE_COUNT,
          end: "latest",
          style: "candles",
          granularity: GRANULARITY,
        })
      );
      ws.send(JSON.stringify({ portfolio: 1 }));
      break;
    }

    case "candles": {
      candles = data.candles || [];
      console.log(`📊 Loaded ${candles.length} initial candles.`);
      ws.send(JSON.stringify({ ticks: SYMBOL, subscribe: 1 }));
      console.log("📡 Subscribed to live ticks.");
      break;
    }

    case "tick": {
      const tick = data.tick;
      if (!tick) return;

      updateCandles(tick);
      const signal = getSignal();

      if (signal) {
        const skip = isOverBoughtOrSold(signal);
        if (skip) {
          console.log(`⚠️ ${signal} ignored (${signal === "XGREEN" ? "Overbought" : "Oversold"})`);
        } else {
          const nowTime = Date.now();
          if (nowTime - lastTradeTime > GRANULARITY * 1000 * 2) {
            const contractType = signal === "XGREEN" ? "MULTUP" : "MULTDOWN";
            ws.send(
              JSON.stringify({
                buy: 1,
                price: STAKE,
                parameters: {
                  amount: STAKE,
                  basis: "stake",
                  contract_type: contractType,
                  currency: "USD",
                  multiplier: MULTIPLIER,
                  symbol: SYMBOL,
                },
              })
            );
            console.log(`🚀 ${now()} — Sent ${contractType} trade (Signal: ${signal})`);
            lastTradeTime = nowTime;
          }
        }
      }

      // For live candle visualization
      const c = candles[candles.length - 1];
      console.log(
        `🕒 ${now()} | O:${c.open.toFixed(2)} H:${c.high.toFixed(2)} L:${c.low.toFixed(2)} C:${c.close.toFixed(2)}`
      );
      break;
    }

    case "buy": {
      const id = data.buy?.contract_id;
      if (!id) return handleError("Buy failed.");
      console.log("✅ Bought contract:", id);
      ws.send(JSON.stringify({ proposal_open_contract: 1, contract_id: id, subscribe: 1 }));
      break;
    }

    case "proposal_open_contract": {
      const poc = data.proposal_open_contract;
      if (!poc) return;
      const id = poc.contract_id;
      const profit = safe(poc.profit ?? poc.pnl ?? 0);
      subscribedContracts.set(id, { latest: poc });

      // Calculate total profit
      let totalProfit = 0;
      let openCount = 0;
      for (const [, v] of subscribedContracts) {
        const latest = v.latest || {};
        if (!latest.is_sold) openCount++;
        totalProfit += safe(latest.profit ?? latest.pnl ?? 0);
      }

      console.log(
        `📡 Contract ${id} | Profit=${profit.toFixed(4)} | ΣTotal=${totalProfit.toFixed(
          4
        )} | Active=${openCount}`
      );

      // Auto-close logic
      if (AUTO_CLOSE && totalProfit >= MAX_PROFIT) {
        console.log(`💰 Global target reached (${MAX_PROFIT}). Closing all trades.`);
        for (const [cid, v] of subscribedContracts) {
          if (!v.latest?.is_sold) ws.send(JSON.stringify({ sell: cid, price: 0 }));
        }
      }
      break;
    }

    case "sell": {
      if (data.error) console.warn("⚠️ Sell error:", data.error.message);
      else console.log("✅ Sell executed:", data.sell);
      break;
    }

    case "portfolio": {
      const portfolio = data.portfolio;
      const openContracts = portfolio?.contracts || [];
      console.log(`📂 Portfolio: ${openContracts.length} active trades.`);
      break;
    }

    default:
      break;
  }
};

ws.onerror = (err) => handleError(err.message);
ws.onclose = () => console.log("🔚 Connection closed.");
