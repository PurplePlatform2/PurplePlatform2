// === Configuration ===
const CONFIG = {
    WS_URL: 'wss://ws.derivws.com/websockets/v3?app_id=85077',
    CANDLE_TICK_COUNT: 60,
    CANDLE_DURATION_SEC: 60,
    AVERAGE_DOWN_THRESHOLD: 0.2,
    CONTRACT_DURATION: 60,
    MAX_CANDLE_HISTORY: 5,
    MAX_PATTERN_HISTORY: 5,
    PUT_PATTERNS: ['GGGRR', 'GGGR'],
    CALL_PATTERNS: ['RRGGG', 'RRRG']
};

const TRADING_STATE = {
    token: process.argv[2] || 'JklMzewtX7Da9mT',
    stake: 0.35,
    symbol: 'stpRNG',
    proposalId: null,
    proposalPrice: null,
    isTradeDone: false,
    hasAveragedDown: false,
    currentTradeType: null,
    candleStartTime: null,
    currentCandle: [],
    lastCandles: [],
    patternHistory: [],
    hasTradedThisCandle: false,
    activeContractId: null
};

const WebSocket = require('ws');
let ws;
const messageQueue = [];

// === WebSocket helpers ===
function safeSend(data) {
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(data));
    } else {
        messageQueue.push(data);
    }
}

function flushQueue() {
    while (messageQueue.length && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(messageQueue.shift()));
    }
}

// === Candle Logic ===
function startNewCandle(epoch) {
    TRADING_STATE.candleStartTime = epoch;
    TRADING_STATE.currentCandle = [];
    TRADING_STATE.hasTradedThisCandle = false;
}

function finalizeCandle() {
    const c = TRADING_STATE.currentCandle;
    if (!c.length) return;
    const open = c[0], close = c[c.length - 1];
    const dir = Math.abs(close - open) < 0.0001 ? 'D' : (close > open ? 'G' : 'R');
    TRADING_STATE.lastCandles.push({ open, close, direction: dir });
    TRADING_STATE.patternHistory.push(dir);
    if (TRADING_STATE.lastCandles.length > CONFIG.MAX_CANDLE_HISTORY) TRADING_STATE.lastCandles.shift();
    if (TRADING_STATE.patternHistory.length > CONFIG.MAX_PATTERN_HISTORY) TRADING_STATE.patternHistory.shift();
    checkTradingPatterns();
}

function processTick(tick) {
    const quote = parseFloat(tick.tick.quote);
    const epoch = tick.tick.epoch;
    const expectedStart = Math.floor(epoch / CONFIG.CANDLE_DURATION_SEC) * CONFIG.CANDLE_DURATION_SEC;
    if (!TRADING_STATE.candleStartTime) startNewCandle(expectedStart);
    if (expectedStart !== TRADING_STATE.candleStartTime) {
        finalizeCandle();
        startNewCandle(expectedStart);
    }
    TRADING_STATE.currentCandle.push(quote);
    checkAveragingDown(quote);
}

// === Pattern & Trade Logic ===
function checkTradingPatterns() {
    if (TRADING_STATE.hasTradedThisCandle || TRADING_STATE.patternHistory.length < 3) return;
    const lastPattern = TRADING_STATE.patternHistory.join('').slice(-5);
    if (CONFIG.CALL_PATTERNS.some(p => lastPattern.endsWith(p))) {
        console.log(`📈 CALL Pattern: ${lastPattern}`);
        enterTrade('CALL');
        TRADING_STATE.hasTradedThisCandle = true;
    }
    if (CONFIG.PUT_PATTERNS.some(p => lastPattern.endsWith(p))) {
        console.log(`📉 PUT Pattern: ${lastPattern}`);
        enterTrade('PUT');
        TRADING_STATE.hasTradedThisCandle = true;
    }
}

function enterTrade(type) {
    TRADING_STATE.currentTradeType = type;
    let duration = CONFIG.CONTRACT_DURATION % 60 === 0 ? CONFIG.CONTRACT_DURATION / 60 : CONFIG.CONTRACT_DURATION;
    let duration_unit = CONFIG.CONTRACT_DURATION % 60 === 0 ? 'm' : 's';
    safeSend({
        proposal: 1,
        amount: TRADING_STATE.stake,
        basis: 'stake',
        contract_type: type,
        currency: 'USD',
        symbol: TRADING_STATE.symbol,
        duration,
        duration_unit
    });
}

function checkAveragingDown(price) {
    if (!TRADING_STATE.proposalPrice || TRADING_STATE.hasAveragedDown || !TRADING_STATE.isTradeDone) return;
    const entry = TRADING_STATE.proposalPrice;
    const type = TRADING_STATE.currentTradeType;
    if ((type === 'CALL' && price <= entry - CONFIG.AVERAGE_DOWN_THRESHOLD) ||
        (type === 'PUT' && price >= entry + CONFIG.AVERAGE_DOWN_THRESHOLD)) {
        console.log(`🔁 Averaging down ${type}`);
        enterTrade(type);
        TRADING_STATE.hasAveragedDown = true;
        TRADING_STATE.isTradeDone = false;
    }
}

// === Historical Initialization ===
function requestHistory() {
    safeSend({
        ticks_history: TRADING_STATE.symbol,
        style: 'ticks',
        count: CONFIG.CANDLE_TICK_COUNT * CONFIG.MAX_CANDLE_HISTORY,
        end: 'latest'
    });
}

function processHistory(history) {
    let candles = [], bucket = [];
    let bucketStart = Math.floor(history[0].epoch / CONFIG.CANDLE_DURATION_SEC) * CONFIG.CANDLE_DURATION_SEC;
    for (let tick of history) {
        const tickTime = Math.floor(tick.epoch / CONFIG.CANDLE_DURATION_SEC) * CONFIG.CANDLE_DURATION_SEC;
        if (tickTime !== bucketStart) {
            if (bucket.length) {
                const open = bucket[0].quote, close = bucket[bucket.length - 1].quote;
                candles.push({ open, close, direction: Math.abs(close - open) < 0.0001 ? 'D' : (close > open ? 'G' : 'R') });
                bucket = [];
            }
            bucketStart = tickTime;
        }
        bucket.push(tick);
    }
    if (bucket.length) {
        const open = bucket[0].quote, close = bucket[bucket.length - 1].quote;
        candles.push({ open, close, direction: Math.abs(close - open) < 0.0001 ? 'D' : (close > open ? 'G' : 'R') });
    }
    TRADING_STATE.lastCandles = candles.slice(-CONFIG.MAX_CANDLE_HISTORY);
    TRADING_STATE.patternHistory = TRADING_STATE.lastCandles.map(c => c.direction);
}

// === WebSocket Events ===
function onMessage(raw) {
    const data = JSON.parse(raw);
    if (data.error) return console.error('API Error:', data.error.message);
    switch (data.msg_type) {
        case 'authorize':
            console.log('✅ Authorized');
            requestHistory();
            break;
        case 'history':
            processHistory(data.history.prices.map((q, i) => ({ quote: q, epoch: data.history.times[i] })));
            safeSend({ ticks: TRADING_STATE.symbol, subscribe: 1 });
            break;
        case 'tick':
            processTick(data);
            break;
        case 'proposal':
            if (!TRADING_STATE.isTradeDone) {
                TRADING_STATE.proposalId = data.proposal.id;
                TRADING_STATE.proposalPrice = parseFloat(data.proposal.spot || data.proposal.spot_price);
                safeSend({ buy: TRADING_STATE.proposalId, price: TRADING_STATE.stake });
            }
            break;
         case 'sell':
            console.log(`📤 Sell result: Sold for $${data.sell.sold_for}`);
            cleanup();
            process.exit(0);
            break;
        case 'buy':
            TRADING_STATE.isTradeDone = true;
            TRADING_STATE.activeContractId = data.buy.contract_id;
            safeSend({ proposal_open_contract: 1, contract_id: TRADING_STATE.activeContractId, subscribe: 1 });
            break;
        case 'proposal_open_contract':
            if (data.proposal_open_contract.status === 'sold') {
                console.log('🏁 Contract settled. Exiting...');
                cleanup();
                process.exit(0);
            }
            break;
    }
}

function initWebSocket() {
    ws = new WebSocket(CONFIG.WS_URL);
    ws.on('open', () => { flushQueue(); safeSend({ authorize: TRADING_STATE.token }); });
    ws.on('message', onMessage);
    ws.on('error', err => console.error('WS error:', err.message));
    ws.on('close', () => console.log('🔌 Disconnected'));
}

function cleanup() {
    if (ws && ws.readyState === WebSocket.OPEN) ws.close();
}

// === Start ===
console.log('🚀 Starting Node trading bot...');
initWebSocket();
