/****************************************************
 * Deriv Volatility Strategy (Production Build)
 * Author: Dr. Sanne Karibo
 * Strategy: 15-tick volatility breakout (σ > 0.25 → CALL/PUT)
 * Compatible: Node.js & Browser
 ****************************************************/

(() => {
  "use strict";

  // === CONFIGURATION ===
  const CONFIG = {
    SYMBOL: "stpRNG",       // Volatility market
    TICK_COUNT: 150,        // Number of ticks to fetch
    GROUP_SIZE: 15,         // 15-tick candles
    VOL_THRESHOLD: 0.25,    // Volatility trigger
    AMOUNT: 1,              // USD stake
    DURATION: 15,            // Duration in ticks
    APP_ID: 1089,           // Deriv App ID
    TOKEN: "tUgDTQ6ZclOuNBl",              // Optional: API token (leave blank for demo)
  };

  // === WEBSOCKET SETUP ===
  let WS;
  if (typeof window === "undefined") {
    const { WebSocket } = require("ws");
    WS = WebSocket;
  } else {
    WS = window.WebSocket;
  }

  const ws = new WS(`wss://ws.derivws.com/websockets/v3?app_id=${CONFIG.APP_ID}`);

  ws.onopen = () => {
    console.log("🦊 Connected to Deriv WebSocket");
    if (CONFIG.TOKEN) {
      ws.send(JSON.stringify({ authorize: CONFIG.TOKEN }));
    } else {
      requestTicks();
    }
  };

  ws.onmessage = (msg) => {
    const data = safeParse(msg.data || msg);
    if (!data) return;

    if (data.error) {
      console.error("❌ API Error:", data.error.message);
      reconnect();
      return;
    }

    if (data.authorize) {
      console.log(`🔑 Authorized as ${data.authorize.loginid}`);
      requestTicks();
      return;
    }

    if (data.history?.prices) {
      handleTickHistory(data.history.prices.map(Number));
      return;
    }

    if (data.proposal) {
      console.log("💰 Proposal received — executing trade...");
      ws.send(JSON.stringify({ buy: data.proposal.id, price: CONFIG.AMOUNT }));
      return;
    }

    if (data.buy) {
      console.log(`✅ Trade executed: Contract ID ${data.buy.contract_id}`);
      ws.close();
      return;
    }
  };

  ws.onerror = (err) => {
    console.error("⚠️ WebSocket Error:", err.message || err);
    reconnect();
  };

  ws.onclose = () => console.log("🔒 WebSocket closed.");

  // === CORE LOGIC ===
  function handleTickHistory(ticks) {
    console.log(`✅ Received ${ticks.length} ticks for ${CONFIG.SYMBOL}`);

    const candles = buildCandles(ticks, CONFIG.GROUP_SIZE);
    if (!candles.length) {
      console.warn("⚠️ Not enough data to build candles.");
      ws.close();
      return;
    }

    const last = candles[candles.length - 1];
    console.log(
      `📊 Last Candle → O:${last.open.toFixed(2)} H:${last.high.toFixed(2)} L:${last.low.toFixed(2)} C:${last.close.toFixed(2)} σ:${last.volatility.toFixed(5)}`
    );

    // --- Decision Logic ---
    if (last.volatility > CONFIG.VOL_THRESHOLD ) {
      const direction = last.close > last.open ? "CALL" : "PUT";
      console.log(`🚀 Volatility spike detected! Executing ${direction} trade...`);

      if (CONFIG.TOKEN) {
        sendProposal(direction);
      } else {
        console.log(`💡 DEMO: Would place ${direction} trade now.`);
        ws.close();
      }
    } else {
      console.log(`😴 Volatility too low (${last.volatility.toFixed(3)} < ${CONFIG.VOL_THRESHOLD})`);
      ws.close();
    }
  }

  // === HELPERS ===
  function requestTicks() {
    ws.send(JSON.stringify({
      ticks_history: CONFIG.SYMBOL,
      count: CONFIG.TICK_COUNT,
      end: "latest",
      style: "ticks"
    }));
  }

  function sendProposal(direction) {
    ws.send(JSON.stringify({
      proposal: 1,
      amount: CONFIG.AMOUNT,
      basis: "stake",
      contract_type: direction,
      currency: "USD",
      duration: CONFIG.DURATION,
      duration_unit: "s",
      symbol: CONFIG.SYMBOL
    }));
  }

  function buildCandles(ticks, group) {
    const candles = [];
    for (let i = 0; i < ticks.length; i += group) {
      const slice = ticks.slice(i, i + group);
      if (slice.length < group) break;

      const open = slice[0];
      const close = slice[slice.length - 1];
      const high = Math.max(...slice);
      const low = Math.min(...slice);
      const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
      const variance = slice.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / slice.length;
      const volatility = Math.sqrt(variance);

      candles.push({ open, close, high, low, mean, volatility });
    }
    return candles;
  }

  function safeParse(json) {
    try { return JSON.parse(json); }
    catch (e) {
      console.error("⚠️ Failed to parse message:", json);
      return null;
    }
  }

  function reconnect() {
    console.log("🔄 Attempting reconnection in 3s...");
    setTimeout(() => {
      if (typeof window === "undefined") {
        process.exit(0); // restart for Node.js (use pm2 or nodemon)
      } else {
        location.reload(); // refresh browser
      }
    }, 3000);
  }
})();
