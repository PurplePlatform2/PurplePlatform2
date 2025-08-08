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
    CALL_PATTERNS: ['RRGGG', 'RRRG'],
    MAX_RETRY_ATTEMPTS: 5,
    RETRY_BASE_DELAY: 3000
};

// === Trading State ===
const TRADING_STATE = {
    token: typeof process !== 'undefined' ? process.argv[2] || 'JklMzewtX7Da9mT' : 'JklMzewtX7Da9mT',
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
    hasTradedThisCandle: false,
    activeContractId: null,
    reconnectAttempts: 0
};

// === WebSocket Setup ===
let ws = null;
let isConnected = false;
const messageQueue = [];

// Get WebSocket class based on environment
const getWebSocketClass = () => {
    if (typeof WebSocket !== 'undefined') return WebSocket;
    if (typeof global !== 'undefined' && global.WebSocket) return global.WebSocket;
    return require('ws');
};

const safeSend = (data) => {
    try {
        if (ws && ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify(data));
            return true;
        }
        messageQueue.push(data);
        return false;
    } catch (error) {
        console.error('⚠️ Send error:', error);
        return false;
    }
};

const flushQueue = () => {
    while (messageQueue.length > 0 && ws && ws.readyState === ws.OPEN) {
        const msg = messageQueue.shift();
        ws.send(JSON.stringify(msg));
    }
};

const reconnectWithBackoff = () => {
    if (TRADING_STATE.reconnectAttempts >= CONFIG.MAX_RETRY_ATTEMPTS) {
        console.error('❌ Max reconnection attempts reached');
        return;
    }

    const delay = CONFIG.RETRY_BASE_DELAY * Math.pow(2, TRADING_STATE.reconnectAttempts);
    TRADING_STATE.reconnectAttempts++;
    
    console.log(`⏳ Reconnecting in ${Math.round(delay/1000)}s (Attempt ${TRADING_STATE.reconnectAttempts})`);
    setTimeout(initWebSocket, delay);
};

const initWebSocket = () => {
    const WebSocketClass = getWebSocketClass();
    ws = new WebSocketClass(CONFIG.WS_URL);

    ws.onopen = () => {
        isConnected = true;
        TRADING_STATE.reconnectAttempts = 0;
        console.log('🔌 WebSocket connected');
        flushQueue();
        handleWsOpen();
    };

    ws.onmessage = (msg) => {
        try {
            handleWsMessage(msg);
        } catch (error) {
            console.error('⚠️ Message handling error:', error);
        }
    };

    ws.onerror = (error) => {
        console.error('⚠️ WebSocket error:', error.message || error);
    };

    ws.onclose = () => {
        isConnected = false;
        console.warn('🔌 WebSocket disconnected');
        reconnectWithBackoff();
    };
};

// === Epoch-based Candle Logic ===
const startNewCandle = (epoch) => {
    TRADING_STATE.candleStartTime = epoch;
    TRADING_STATE.currentCandle = [];
    TRADING_STATE.hasTradedThisCandle = false;
};

const finalizeCandle = () => {
    const candleTicks = TRADING_STATE.currentCandle;
    if (candleTicks.length === 0) return;

    const open = candleTicks[0];
    const close = candleTicks[candleTicks.length - 1];
    const direction = getCandleDirection(open, close);

    TRADING_STATE.lastCandles.push({ open, close, direction });
    TRADING_STATE.patternHistory.push(direction);

    // Maintain history limits
    if (TRADING_STATE.lastCandles.length > CONFIG.MAX_CANDLE_HISTORY) {
        TRADING_STATE.lastCandles.shift();
    }
    if (TRADING_STATE.patternHistory.length > CONFIG.MAX_PATTERN_HISTORY) {
        TRADING_STATE.patternHistory.shift();
    }

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

    safeSend({
        proposal: 1,
        amount: TRADING_STATE.stake,
        basis: 'stake',
        contract_type: type,
        currency: 'USD',
        symbol: TRADING_STATE.symbol,
        date_expiry: TRADING_STATE.expiryTime
    });
};

const checkAveragingDown = (price) => {
    if (!TRADING_STATE.proposalPrice || 
        TRADING_STATE.hasAveragedDown || 
        !TRADING_STATE.isTradeDone) return;

    const entry = TRADING_STATE.proposalPrice;
    const type = TRADING_STATE.currentTradeType;
    const threshold = CONFIG.AVERAGE_DOWN_THRESHOLD;

    const shouldAverageDown = (
        (type === 'CALL' && price <= entry - threshold) ||
        (type === 'PUT' && price >= entry + threshold)
    );

    if (shouldAverageDown) {
        console.log(`🔁 Averaging down ${type}: Price moved against entry`);
        enterTrade(type);
        TRADING_STATE.hasAveragedDown = true;
        TRADING_STATE.isTradeDone = false;
    }
};

// === Pattern Matching ===
const checkTradingPatterns = () => {
    if (TRADING_STATE.hasTradedThisCandle || 
        TRADING_STATE.patternHistory.length < 3) return;

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
    safeSend({
        ticks_history: TRADING_STATE.symbol,
        style: 'ticks',
        count,
        end: 'latest'
    });
};

const processHistoricalTicks = (history) => {
    if (!history || history.length === 0) return;
    
    const candles = [];
    let bucket = [];
    let bucketStart = Math.floor(history[0].epoch / CONFIG.CANDLE_DURATION_SEC) * CONFIG.CANDLE_DURATION_SEC;

    history.forEach(tick => {
        const tickTime = Math.floor(tick.epoch / CONFIG.CANDLE_DURATION_SEC) * CONFIG.CANDLE_DURATION_SEC;
        
        if (tickTime !== bucketStart) {
            if (bucket.length > 0) {
                const open = bucket[0].quote;
                const close = bucket[bucket.length - 1].quote;
                candles.push({
                    open,
                    close,
                    direction: getCandleDirection(open, close)
                });
                bucket = [];
            }
            bucketStart = tickTime;
        }
        bucket.push(tick);
    });

    // Process final bucket
    if (bucket.length > 0) {
        const open = bucket[0].quote;
        const close = bucket[bucket.length - 1].quote;
        candles.push({
            open,
            close,
            direction: getCandleDirection(open, close)
        });
    }

    // Maintain state
    TRADING_STATE.lastCandles = candles.slice(-CONFIG.MAX_CANDLE_HISTORY);
    TRADING_STATE.patternHistory = TRADING_STATE.lastCandles.map(c => c.direction);
    console.log('📊 Initialized with historical candles:', TRADING_STATE.patternHistory.join(''));
};

// === WebSocket Handlers ===
const handleWsOpen = () => {
    safeSend({ authorize: TRADING_STATE.token });
};

const handleWsMessage = (msg) => {
    const data = JSON.parse(msg.data);
    if (data.error) {
        console.error('❌ API Error:', data.error.message);
        return;
    }

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
            safeSend({ ticks: TRADING_STATE.symbol, subscribe: 1 });
            
            // Resubscribe to active contract if exists
            if (TRADING_STATE.activeContractId) {
                safeSend({
                    proposal_open_contract: 1,
                    contract_id: TRADING_STATE.activeContractId,
                    subscribe: 1
                });
            }
            break;
            
        case 'tick':
            processTickData(data);
            break;
            
        case 'proposal':
            if (!TRADING_STATE.isTradeDone) {
                TRADING_STATE.proposalId = data.proposal.id;
                TRADING_STATE.proposalPrice = parseFloat(data.proposal.spot);
                safeSend({
                    buy: TRADING_STATE.proposalId,
                    price: TRADING_STATE.stake
                });
            }
            break;
            
        case 'buy':
            TRADING_STATE.isTradeDone = true;
            TRADING_STATE.activeContractId = data.buy.contract_id;
            console.log('✅ Trade purchased:', data.buy.contract_id);
            safeSend({
                proposal_open_contract: 1,
                contract_id: data.buy.contract_id,
                subscribe: 1
            });
            break;
            
        case 'proposal_open_contract':
            if (data.proposal_open_contract.status === 'sold') {
                console.log('🏁 Contract settled');
                TRADING_STATE.isTradeDone = false;
                TRADING_STATE.hasAveragedDown = false;
                TRADING_STATE.proposalPrice = null;
                TRADING_STATE.currentTradeType = null;
                TRADING_STATE.activeContractId = null;
            }
            break;
    }
};

// === Startup & Cleanup ===
console.log('🚀 Starting trading bot...');
initWebSocket();

// Cross-platform cleanup handler
const cleanup = () => {
    if (ws && [ws.OPEN, ws.CONNECTING].includes(ws.readyState)) {
        ws.close();
    }
};

if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', cleanup);
} else if (typeof process !== 'undefined') {
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
}
