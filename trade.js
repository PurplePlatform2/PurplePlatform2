// === Configuration Constants ===
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

// === Trading State ===
const TRADING_STATE = {
    token: process.argv[3]|| 'JklMzewtX7Da9mT', // 🔐 Replace with real token
    stake: 0.35,
    symbol: 'stpRNG',
    proposalId: null,
    proposalPrice: null,
    isTradeDone: false,
    hasAveragedDown: false,
    entryTime: null,
    expiryTime: null,
    currentTradeType: null,
    candleStartTime: null,
    currentCandle: [],
    lastCandles: [],
    patternHistory: [],
    hasTradedThisCandle: false // ✅ Only one new trade per candle
};

// === WebSocket Setup ===
let ws = null;

const initWebSocket = () => {
   ws = new (require('ws')) WebSocket(CONFIG.WS_URL);
    ws.onopen = handleWsOpen;
    ws.onmessage = handleWsMessage;
    ws.onerror = (e) => console.error('⚠️ WebSocket error:', e);
    ws.onclose = () => {
        console.warn('🔌 WebSocket closed. Reconnecting...');
        setTimeout(initWebSocket, 3000);
    };
};

// === Epoch-based Candle Logic ===
const startNewCandle = (epoch) => {
    TRADING_STATE.candleStartTime = epoch;
    TRADING_STATE.currentCandle = [];
    TRADING_STATE.hasTradedThisCandle = false; // ✅ Reset trade flag on new candle
};

const finalizeCandle = () => {
    const candleTicks = TRADING_STATE.currentCandle;
    if (candleTicks.length === 0) return;

    const open = candleTicks[0];
    const close = candleTicks[candleTicks.length - 1];
    const direction = getCandleDirection(open, close);

    const candle = { open, close, direction };
    TRADING_STATE.lastCandles.push(candle);
    TRADING_STATE.patternHistory.push(direction);

    if (TRADING_STATE.lastCandles.length > CONFIG.MAX_CANDLE_HISTORY)
        TRADING_STATE.lastCandles.shift();
    if (TRADING_STATE.patternHistory.length > CONFIG.MAX_PATTERN_HISTORY)
        TRADING_STATE.patternHistory.shift();

    checkTradingPatterns();
};

const getCandleDirection = (open, close) => {
    if (Math.abs(close - open) < 0.0001) return 'D';
    return close > open ? 'G' : 'R';
};

// === Trade Management ===
const enterTrade = (type) => {
    TRADING_STATE.entryTime = Math.floor(Date.now() / 1000);
    TRADING_STATE.expiryTime = TRADING_STATE.entryTime + CONFIG.CONTRACT_DURATION;
    TRADING_STATE.currentTradeType = type;

    ws.send(JSON.stringify({
        proposal: 1,
        amount: TRADING_STATE.stake,
        basis: 'stake',
        contract_type: type,
        currency: 'USD',
        symbol: TRADING_STATE.symbol,
        date_expiry: TRADING_STATE.expiryTime
    }));
};

const checkAveragingDown = (price) => {
    if (!TRADING_STATE.proposalPrice || TRADING_STATE.hasAveragedDown || !TRADING_STATE.isTradeDone) return;

    const entry = TRADING_STATE.proposalPrice;
    const type = TRADING_STATE.currentTradeType;

    const shouldAverageDown =
        (type === 'CALL' && price <= entry - CONFIG.AVERAGE_DOWN_THRESHOLD) ||
        (type === 'PUT' && price >= entry + CONFIG.AVERAGE_DOWN_THRESHOLD);

    if (shouldAverageDown) {
        console.log(`🔁 Averaging down ${type}: Price moved against entry`);
        enterTrade(type);
        TRADING_STATE.hasAveragedDown = true;
        TRADING_STATE.isTradeDone = false;
    }
};

// === Pattern Matching ===
const checkTradingPatterns = () => {
    if (TRADING_STATE.hasTradedThisCandle) return;

    const patternStr = TRADING_STATE.patternHistory.join('');
    const lastPattern = patternStr.slice(-5);

    const matchCall = CONFIG.CALL_PATTERNS.some(p => lastPattern.endsWith(p));
    const matchPut = CONFIG.PUT_PATTERNS.some(p => lastPattern.endsWith(p));

    if (matchCall) {
        console.log(`📈 CALL Pattern Detected: ${lastPattern}`);
        enterTrade('CALL');
        TRADING_STATE.hasTradedThisCandle = true;
    } else if (matchPut) {
        console.log(`📉 PUT Pattern Detected: ${lastPattern}`);
        enterTrade('PUT');
        TRADING_STATE.hasTradedThisCandle = true;
    }
};

// === Tick Handling ===
const processTickData = (tickData) => {
    const quote = parseFloat(tickData.tick.quote);
    const epoch = tickData.tick.epoch;

    const expectedStart = Math.floor(epoch / CONFIG.CANDLE_DURATION_SEC) * CONFIG.CANDLE_DURATION_SEC;

    if (!TRADING_STATE.candleStartTime) {
        startNewCandle(expectedStart);
    }

    if (expectedStart !== TRADING_STATE.candleStartTime) {
        finalizeCandle();
        startNewCandle(expectedStart);
    }

    TRADING_STATE.currentCandle.push(quote);
    checkAveragingDown(quote);
};

// === Historical Initialization ===
const requestHistoricalTicks = () => {
    const count = CONFIG.CANDLE_TICK_COUNT * CONFIG.MAX_CANDLE_HISTORY;
    ws.send(JSON.stringify({
        ticks_history: TRADING_STATE.symbol,
        style: 'ticks',
        count,
        end: 'latest'
    }));
};

const processHistoricalTicks = (history) => {
    const candles = [];
    let bucket = [];
    let bucketStart = Math.floor(history[0].epoch / CONFIG.CANDLE_DURATION_SEC) * CONFIG.CANDLE_DURATION_SEC;

    for (let tick of history) {
        const tickTime = Math.floor(tick.epoch / CONFIG.CANDLE_DURATION_SEC) * CONFIG.CANDLE_DURATION_SEC;

        if (tickTime !== bucketStart) {
            if (bucket.length > 0) {
                candles.push({
                    open: bucket[0].quote,
                    close: bucket[bucket.length - 1].quote,
                    direction: getCandleDirection(bucket[0].quote, bucket[bucket.length - 1].quote)
                });
                bucket = [];
            }
            bucketStart = tickTime;
        }
        bucket.push(tick);
    }

    if (bucket.length > 0) {
        candles.push({
            open: bucket[0].quote,
            close: bucket[bucket.length - 1].quote,
            direction: getCandleDirection(bucket[0].quote, bucket[bucket.length - 1].quote)
        });
    }

    TRADING_STATE.lastCandles = candles.slice(-CONFIG.MAX_CANDLE_HISTORY);
    TRADING_STATE.patternHistory = TRADING_STATE.lastCandles.map(c => c.direction);
    console.log('📊 Initialized with historical candles:', TRADING_STATE.patternHistory.join(''));
};

// === WebSocket Handlers ===
const handleWsOpen = () => {
    console.log('🔌 Connected to WebSocket');
    ws.send(JSON.stringify({ authorize: TRADING_STATE.token }));
};

const handleWsMessage = (msg) => {
    try {
        const data = JSON.parse(msg.data);
        if (data.error) return console.error('❌ API Error:', data.error.message);

        switch (data.msg_type) {
            case 'authorize':
                console.log('✅ Authorized');
                requestHistoricalTicks();
                break;

            case 'history':
                processHistoricalTicks(data.history.prices.map((quote, i) => ({
                    quote,
                    epoch: data.history.times[i]
                })));
                ws.send(JSON.stringify({ ticks: TRADING_STATE.symbol, subscribe: 1 }));
                break;

            case 'tick':
                processTickData(data);
                break;

            case 'proposal':
                if (!TRADING_STATE.isTradeDone) {
                    TRADING_STATE.proposalId = data.proposal.id;
                    TRADING_STATE.proposalPrice = parseFloat(data.proposal.spot);
                    ws.send(JSON.stringify({
                        buy: TRADING_STATE.proposalId,
                        price: TRADING_STATE.stake
                    }));
                }
                break;

            case 'buy':
                TRADING_STATE.isTradeDone = true;
                console.log('✅ Trade purchased:', data.buy.contract_id);
                ws.send(JSON.stringify({
                    proposal_open_contract: 1,
                    contract_id: data.buy.contract_id,
                    subscribe: 1
                }));
                break;

            case 'proposal_open_contract':
                if (data.proposal_open_contract.status === 'sold') {
                    console.log('🏁 Contract settled. Resetting...');
                    TRADING_STATE.isTradeDone = false;
                    TRADING_STATE.hasAveragedDown = false;
                    TRADING_STATE.proposalPrice = null;
                    TRADING_STATE.currentTradeType = null;
                }
                break;
        }
    } catch (err) {
        console.error('⚠️ Message parse error:', err);
    }
};

// === Startup ===
console.log('🚀 Starting trading bot...');
initWebSocket();

window.addEventListener('beforeunload', () => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.close();
});
