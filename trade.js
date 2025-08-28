// === Big Candle Strategy with Martingale (Educational Use Only) ===
const API_TOKEN = process.argv[2] || 'JklMzewtX7Da9mT';
const MARKET = 'stpRNG';
const TIMEFRAME = 60;
const CANDLE_DIFF_THRESHOLD = 1.7;
const BASE_STAKE = 0.35;
const DURATION_SECONDS = 60;
const MARTINGALE_MULTIPLIER = 2.2;

let ws;
let isAuthorized = false;
let isMartingaleActive = false;
let martingaleStep = 0;
let currentStake = BASE_STAKE;
let pendingTradeType = null;
let heartbeatInterval;

function connect() {
    try {
        if (typeof window === 'undefined') {
            const WebSocket = require('ws');
            ws = new WebSocket('wss://ws.derivws.com/websockets/v3?app_id=1089');
            console.log('🌐 Node.js mode');
        } else {
            ws = new WebSocket('wss://ws.derivws.com/websockets/v3?app_id=1089');
            console.log('🌐 Browser mode');
        }
        ws.onopen = onOpen;
        ws.onmessage = onMessage;
        ws.onclose = onClose;
        ws.onerror = onError;
    } catch (err) {
        console.error("❌ Connection failed:", err);
    }
}

function onOpen() {
    console.log("✅ Connected to Deriv.");
    subscribeToCandles();
    startHeartbeat();
}

function onMessage(msg) {
    const data = JSON.parse(msg.data);

    if (data.msg_type === 'authorize' && data.authorize) {
        isAuthorized = true;
        console.log("🔑 Authorized successfully.");
        if (pendingTradeType) {
            console.log("🚀 Executing pending trade after auth...");
            placeTrade(pendingTradeType);
            pendingTradeType = null;
        }
    }

    if (data.msg_type === 'candles' && data.candles?.length > 1) {
        const completed = data.candles[0];
        if (isCandleClosed(completed)) {
            checkForBigBullishCandle(completed);
        }
    }

    if (data.msg_type === 'proposal_open_contract') {
        handleTradeResult(data.proposal_open_contract);
    }

    if (data.msg_type === 'error') {
        console.error("❌ API Error:", data.error.message, "| Code:", data.error.code);
    }
}

function subscribeToCandles() {
    ws.send(JSON.stringify({
        ticks_history: MARKET,
        end: 'latest',
        count: 2,
        subscribe: 1,
        style: 'candles',
        granularity: TIMEFRAME,
    }));
    console.log(`📡 Subscribed to ${MARKET}, ${TIMEFRAME}s candles`);
}

function isCandleClosed(candle) {
    const now = Math.floor(Date.now() / 1000);
    return now >= (candle.epoch + TIMEFRAME);
}

function checkForBigBullishCandle(candle) {
    const high = parseFloat(candle.high);
    const low = parseFloat(candle.low);
    const open = parseFloat(candle.open);
    const close = parseFloat(candle.close);
    const range = high - low;
    const bullish = close > open;

    console.log(`🕯️ Closed candle: O=${open}, H=${high}, L=${low}, C=${close}, R=${range.toFixed(2)}`);

    if (true){ //range >= CANDLE_DIFF_THRESHOLD && bullish && !isMartingaleActive) {
        console.log(`🟢 Big Bullish Candle!`);
        isMartingaleActive = true;
        martingaleStep = 0;
        currentStake = BASE_STAKE;

        if (!isAuthorized) {
            console.log("🔒 Not authorized yet. Requesting authorization...");
            pendingTradeType = 'PUT';
            ws.send(JSON.stringify({ authorize: API_TOKEN }));
        } else {
            placeTrade('PUT');
        }
    }
}

function placeTrade(type) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        console.error("❌ WebSocket not open. Trade aborted.");
        return;
    }
    console.log(`📈 Placing ${type} with stake $${currentStake.toFixed(2)}`);
    ws.send(JSON.stringify({
        buy: 1,
        price: currentStake,
        amount: currentStake,
        basis: 'stake',
        contract_type: type,
        currency: 'USD',
        duration: DURATION_SECONDS,
        duration_unit: 's',
        symbol: MARKET
    }));
}

function handleTradeResult(contract) {
    if (!isMartingaleActive) return;

    if (contract.is_sold === 1) {
        const profit = parseFloat(contract.profit);
        console.log(`💰 Trade closed. P/L: ${profit.toFixed(2)}`);

        if (profit > 0) {
            console.log("✅ Win. Resetting.");
            isMartingaleActive = false;
        } else {
            martingaleStep++;
            currentStake = BASE_STAKE * Math.pow(MARTINGALE_MULTIPLIER, martingaleStep);
            console.log(`❌ Loss. Martingale step ${martingaleStep}, next stake: $${currentStake.toFixed(2)}`);
            placeTrade('PUT');
        }
    }
}

function startHeartbeat() {
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    heartbeatInterval = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ ping: 1 }));
            console.log("🔄 Ping sent to keep alive.");
        }
    }, 20000);
}

function onClose() {
    console.log("⚠️ Disconnected. Reconnecting in 5s...");
    clearInterval(heartbeatInterval);
    setTimeout(connect, 5000);
}

function onError(err) {
    console.error("❌ WebSocket Error:", err);
}

connect();
