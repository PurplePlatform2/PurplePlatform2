// === Single-shot Pattern Bot (Auth only if trade needed) ===
// Author: Sanne Karibo
// ----------------------------------------------------------------

const WebSocket = require('ws');

const CONFIG = {
    WS_URL: 'wss://ws.derivws.com/websockets/v3?app_id=85077',
    CANDLE_TICK_COUNT: 60,
    CANDLE_DURATION_SEC: 60,
    AVERAGE_DOWN_PERCENT: 0.2, // 0.2% drop
    CONTRACT_DURATION: 60,
    MAX_CANDLE_HISTORY: 5,
    PUT_PATTERNS: ['GGGRR', 'GGGR'],
    CALL_PATTERNS: ['RRGGG', 'RRRG']
};

const STATE = {
    token: process.argv[2] || process.env.DERIV_TOKEN || '',
    stake: 0.35,
    symbol: 'stpRNG',
    entryPrice: null,
    tradeType: null,
    hasAveragedDown: false,
    activeContractId: null,
    isWatchingPrice: false
};

let ws;
let pingTimer = null;

// === WebSocket helpers ===
function send(data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        console.log(`📤 Sending: ${JSON.stringify(data)}`);
        ws.send(JSON.stringify(data));
    }
}

function connect() {
    ws = new WebSocket(CONFIG.WS_URL);
    ws.on('open', () => {
        console.log('🔌 Connected to Deriv');
        startKeepAlive();
        requestHistory(); // No auth yet
    });
    ws.on('message', onMessage);
    ws.on('error', err => console.error('❌ WS error:', err.message));
    ws.on('close', () => {
        stopKeepAlive();
        console.log('🔌 Disconnected');
    });
}

function startKeepAlive() {
    stopKeepAlive();
    pingTimer = setInterval(() => send({ ping: 1 }), 30000);
}

function stopKeepAlive() {
    if (pingTimer) clearInterval(pingTimer);
}

// === Process incoming messages ===
function onMessage(raw) {
    let data;
    try { data = JSON.parse(raw); } catch (e) { return; }

    if (data.error) {
        console.error('❌ API Error:', data.error.message);
        process.exit(1);
    }

    console.log(`📥 Received: ${data.msg_type}`);

    switch (data.msg_type) {
        case 'history':
            const hasPattern = checkPatternFromHistory(data.history);
            if (!hasPattern) {
                console.log('❌ No trade pattern found. Exiting...');
                process.exit(0);
            }
            console.log(`📌 Pattern matched: ${STATE.tradeType} → Authorizing...`);
            send({ authorize: STATE.token });
            break;

        case 'authorize':
            console.log('✅ Authorized, entering trade...');
            enterTrade(STATE.tradeType);
            break;

        case 'proposal':
            // We no longer set entry price here — we wait for open contract data
            send({ buy: data.proposal.id, price: STATE.stake });
            break;

        case 'buy':
            console.log(`✅ Bought ${STATE.tradeType}. Contract ID: ${data.buy.contract_id}`);
            STATE.activeContractId = data.buy.contract_id;
            send({ proposal_open_contract: 1, contract_id: STATE.activeContractId, subscribe: 1 });
            break;

        case 'proposal_open_contract':
            if (data.proposal_open_contract.status === 'sold') {
                console.log('🏁 Contract settled. Exiting...');
                process.exit(0);
            } else {
                if (!STATE.entryPrice && data.proposal_open_contract.entry_spot) {
                    STATE.entryPrice = parseFloat(data.proposal_open_contract.entry_spot);
                    console.log(`💰 Entry price set to ${STATE.entryPrice}`);
                    STATE.isWatchingPrice = true;
                    send({ ticks: STATE.symbol, subscribe: 1 });
                }
            }
            break;

        case 'tick':
            if (STATE.isWatchingPrice) {
                checkAveragingDown(parseFloat(data.tick.quote));
            }
            break;

        case 'sell':
            console.log(`📤 Sold for $${data.sell.sold_for}. Exiting...`);
            process.exit(0);
            break;
    }
}

// === Request historical ticks (public) ===
function requestHistory() {
    send({
        ticks_history: STATE.symbol,
        style: 'ticks',
        count: CONFIG.CANDLE_TICK_COUNT * (CONFIG.MAX_CANDLE_HISTORY + 1), // Need one extra
        end: 'latest'
    });
}

// === Pattern check from one candle before latest ===
function checkPatternFromHistory(history) {
    const prices = history.prices;
    const times = history.times;
    let candles = [];
    let bucket = [];
    let bucketStart = Math.floor(times[0] / CONFIG.CANDLE_DURATION_SEC) * CONFIG.CANDLE_DURATION_SEC;

    for (let i = 0; i < prices.length; i++) {
        const tickTime = Math.floor(times[i] / CONFIG.CANDLE_DURATION_SEC) * CONFIG.CANDLE_DURATION_SEC;
        if (tickTime !== bucketStart) {
            if (bucket.length) {
                candles.push(getCandle(bucket));
                bucket = [];
            }
            bucketStart = tickTime;
        }
        bucket.push(prices[i]);
    }
    if (bucket.length) candles.push(getCandle(bucket));

    // Remove latest incomplete candle
    const pattern = candles
        .slice(-(CONFIG.MAX_CANDLE_HISTORY + 1), -1)
        .map(c => c.dir)
        .join('');

    console.log(`📊 Pattern (excluding last candle): ${pattern}`);

    if (CONFIG.CALL_PATTERNS.some(p => pattern.endsWith(p))) {
        STATE.tradeType = 'CALL';
        return true;
    }
    if (CONFIG.PUT_PATTERNS.some(p => pattern.endsWith(p))) {
        STATE.tradeType = 'PUT';
        return true;
    }
    return false;
}

function getCandle(bucket) {
    const open = bucket[0], close = bucket[bucket.length - 1];
    const dir = Math.abs(close - open) < 0.0001 ? 'D' : (close > open ? 'G' : 'R');
    return { open, close, dir };
}

// === Trade entry ===
function enterTrade(type) {
    let duration = CONFIG.CONTRACT_DURATION % 60 === 0 ? CONFIG.CONTRACT_DURATION / 60 : CONFIG.CONTRACT_DURATION;
    let duration_unit = CONFIG.CONTRACT_DURATION % 60 === 0 ? 'm' : 's';
    send({
        proposal: 1,
        amount: STATE.stake,
        basis: 'stake',
        contract_type: type,
        currency: 'USD',
        symbol: STATE.symbol,
        duration,
        duration_unit
    });
}

// === Averaging down check ===
function checkAveragingDown(price) {
    if (!STATE.entryPrice || STATE.hasAveragedDown) return;

    const threshold = STATE.entryPrice * (CONFIG.AVERAGE_DOWN_PERCENT / 100);

    if ((STATE.tradeType === 'CALL' && price <= STATE.entryPrice - threshold) ||
        (STATE.tradeType === 'PUT' && price >= STATE.entryPrice + threshold)) {
        
        console.log(`🔁 Averaging down ${STATE.tradeType} at ${price} (entry was ${STATE.entryPrice}, threshold ${threshold})`);
        STATE.hasAveragedDown = true;
        enterTrade(STATE.tradeType);
    } else {
        console.log(`📈 Price check: ${price} | Entry: ${STATE.entryPrice} | Threshold: ${threshold}`);
    }
}

// === Start ===
if (!STATE.token) {
    console.error('❌ No token provided. Pass as argument or set DERIV_TOKEN env var.');
    process.exit(1);
}
console.log('🚀 Starting pattern-check bot (Sanne JS engine)...');
connect();
