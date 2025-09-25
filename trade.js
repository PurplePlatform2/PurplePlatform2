// Works in both Browser and Node.js
const APP_ID = 1089;
const TOKEN = "tUgDTQ6ZclOuNBl"; // 🔑 Replace with your Deriv token
const SYMBOL = "stpRNG";
const STAKE = 0.35;
const DURATION = 1;
const UNIT = "t";

// Detect environment
let WSClass;
if (typeof WebSocket !== "undefined") {
  WSClass = WebSocket; // Browser
} else {
  WSClass = require("ws"); // Node.js
}

const ws = new WSClass(`wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`);

let lastTwo = [];
let streakCount = 0;
let pabsTicks = [];

// trade state
let inTrade = false;
let tradeId = null;
let backoff = false;

ws.onopen = () => {
  ws.send(JSON.stringify({ authorize: TOKEN }));

  // 🔄 keepalive ping every 30s
  setInterval(() => {
    ws.send(JSON.stringify({ ping: 1 }));
  }, 30000);
};

ws.onmessage = (msg) => {
  const data = JSON.parse(msg.data || msg);

  if (data.authorize) {
  //  console.log("🔑 Authorized:", data.authorize.loginid);
    ws.send(JSON.stringify({ ticks: SYMBOL }));
  }

  // Tick stream
  if (data.tick) {
    const price = parseFloat(data.tick.quote).toFixed(1);

    // Only log ticks if in trade
    if (inTrade && tradeId) {
      console.log("📊 Tick:", price);
      ws.send(JSON.stringify({ proposal_open_contract: 1, contract_id: tradeId }));
    }

    if (inTrade || backoff) return; // 🚫 don’t open trades during active/backoff

    // breakout detection logic
    if (lastTwo.length < 2) {
      if (!lastTwo.includes(price)) lastTwo.push(price);
      pabsTicks.push(price);
      return;
    }

    const expected = lastTwo[(pabsTicks.length) % 2];
    if (price === expected) {
      streakCount++;
      pabsTicks.push(price);
    } else if (lastTwo.includes(price)) {
      lastTwo = [pabsTicks[pabsTicks.length - 1], price];
      streakCount = 1;
      pabsTicks = [lastTwo[0], price];
    } else {
      // Breakout
      if (streakCount > 10) {
        console.log("🚨 PABS Breakout after", streakCount, "ticks:", pabsTicks.join(", "));
        console.log("Breakout Tick:", price);

        const minVal = Math.min(...lastTwo.map(Number));
        const maxVal = Math.max(...lastTwo.map(Number));

        if (price > maxVal) {
          console.log("📈 Sending CALL trade...");
          sendTrade("CALL");
        } else if (price < minVal) {
          console.log("📉 Sending PUT trade...");
          sendTrade("PUT");
        }
      }
      // Reset streak
      lastTwo = [pabsTicks[pabsTicks.length - 1], price];
      streakCount = 1;
      pabsTicks = [lastTwo[0], price];
    }
  }

  // handle buy response
  if (data.buy) {
    tradeId = data.buy.contract_id;
    inTrade = true;
    console.log("✅ Trade opened:", tradeId);
  }

  // monitor open contract updates
  if (data.proposal_open_contract) {
    const poc = data.proposal_open_contract;
    if (poc.contract_id === tradeId) {
      console.log("💹 Entry:", poc.entry_tick, "→ Spot:", poc.current_spot, "Profit:", poc.profit);

      if (poc.is_sold) {
        console.log("🔔 Contract closed. Profit:", poc.profit);
        inTrade = false;
        tradeId = null;

        // apply 5s backoff
        backoff = true;
        console.log("⏳ Cooling down for 10s...");
        setTimeout(() => {
          backoff = false;
          console.log("✅ Ready for new trades.");
        }, 10000);
      }
    }
  }
};

function sendTrade(direction) {
  const contract_type = direction === "CALL" ? "CALL" : "PUT";

  const proposal = {
    buy: 1,
    price: STAKE,
    parameters: {
      amount: STAKE,
      basis: "stake",
      contract_type,
      currency: "USD",
      duration: DURATION,
      duration_unit: UNIT,
      symbol: SYMBOL,
    },
  };

  ws.send(JSON.stringify(proposal));
}
