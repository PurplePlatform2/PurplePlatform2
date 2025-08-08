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

// WebSocket ready states
const WS_STATES = { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 };

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

// ------- Robust safeSend / flushQueue -------
const safeSend = (data) => {
    try {
        if (ws && ws.readyState === WS_STATES.OPEN) {
            ws.send(JSON.stringify(data));
            return true;
        }
        // not open yet — queue and debug
        messageQueue.push(data);
        console.log('🔁 Message queued (socket not open):', data);
        return false;
    } catch (error) {
        console.error('⚠️ Send error:', error);
        return false;
    }
};

const flushQueue = () => {
    while (messageQueue.length > 0 && ws && ws.readyState === WS_STATES.OPEN) {
        const msg = messageQueue.shift();
        try {
            ws.send(JSON.stringify(msg));
            console.log('✅ Flushed queued message:', msg);
        } catch (err) {
            console.error('⚠️ Flush send failed:', err, msg);
            // push back and break to avoid tight loop
            messageQueue.unshift(msg);
            break;
        }
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

// ------- Cross-env initWebSocket (browser + node 'ws') -------
const initWebSocket = () => {
    const WebSocketClass = getWebSocketClass();
    ws = new WebSocketClass(CONFIG.WS_URL);

    const onOpen = () => {
        isConnected = true;
        TRADING_STATE.reconnectAttempts = 0;
        console.log('🔌 WebSocket connected');
        // Normalize ready state numeric values if using class constants
        // If the WebSocket class exposes OPEN as a static, keep WS_STATES in sync
        if (WebSocketClass.OPEN !== undefined) {
            WS_STATES.OPEN = WebSocketClass.OPEN;
            WS_STATES.CONNECTING = WebSocketClass.CONNECTING ?? WS_STATES.CONNECTING;
            WS_STATES.CLOSING = WebSocketClass.CLOSING ?? WS_STATES.CLOSING;
            WS_STATES.CLOSED = WebSocketClass.CLOSED ?? WS_STATES.CLOSED;
        }
        flushQueue();
        handleWsOpen();
    };

    const onMessage = (raw) => {
        // adapt browser MessageEvent and node data
        const rawData = raw && raw.data !== undefined ? raw.data : raw;
        try {
            handleWsMessage({ data: rawData });
        } catch (error) {
            console.error('⚠️ Message handling error:', error);
        }
    };

    const onError = (err) => {
        console.error('⚠️ WebSocket error:', err && (err.message || err));
    };

    const onClose = (code, reason) => {
        isConnected = false;
        console.warn('🔌 WebSocket disconnected', code, reason);
        reconnectWithBackoff();
    };

    // Bind events in a cross-environment way
    if (typeof ws.addEventListener === 'function') {
        // Browser / ws with addEventListener
        ws.addEventListener('open', onOpen);
        ws.addEventListener('message', onMessage);
        ws.addEventListener('error', onError);
        ws.addEventListener('close', onClose);
    } else if (typeof ws.on === 'function') {
        // Node 'ws' EventEmitter
        ws.on('open', onOpen);
        ws.on('message', (data) => onMessage(data));
        ws.on('error', onError);
        ws.on('close', onClose);
    } else {
        // last-resort (some environments)
        ws.onopen = onOpen;
        ws.onmessage = onMessage;
        ws.onerror = onError;
        ws.onclose = onClose;
    }
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
// ------- enterTrade: use duration + duration_unit (more reliable) -------
const enterTrade = (type) => {
    TRADING_STATE.entryTime = Math.floor(Date.now() / 1000);
    TRADING_STATE.currentTradeType = type;

    // Choose sensible duration unit: if CONTRACT_DURATION is multiple of 60 -> minutes
    let duration, duration_unit;
    if (CONFIG.CONTRACT_DURATION % 60 === 0) {
        duration = CONFIG.CONTRACT_DURATION / 60;
        duration_unit = 'm';
    } else {
        duration = CONFIG.CONTRACT_DURATION;
        duration_unit = 's';
    }

    console.log(`➡️ Sending proposal (${type}) duration=${duration}${duration_unit} stake=${TRADING_STATE.stake}`);

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

// ------- Better handleWsMessage (more debug, robust parsing) -------
const handleWsMessage = (msg) => {
    // msg may be {data: string} (browser) or raw string (node)
    const raw = msg && msg.data !== undefined ? msg.data : msg;
    let data;
    try {
        data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (err) {
        console.error('⚠️ Failed to parse WS message:', raw, err);
        return;
    }

    // Log important messages (you can reduce verbosity later)
    if (data.msg_type && data.msg_type !== 'tick') {
        console.log('◀ Received:', data.msg_type, data);
    } else if (!data.msg_type) {
        console.log('◀ Received (no msg_type):', data);
    }

    if (data.error) {
        console.error('❌ API Error:', data.error);
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
            // Detailed debug
            console.log('◀ proposal payload:', data.proposal);
            if (!TRADING_STATE.isTradeDone) {
                // accept multiple possible id keys (robust)
                TRADING_STATE.proposalId = data.proposal.id ?? data.proposal.proposal_id ?? data.proposal.proposal?.id;
                TRADING_STATE.proposalPrice = parseFloat(data.proposal.spot ?? data.proposal.spot_price ?? data.proposal.ask_price ?? NaN);

                if (!TRADING_STATE.proposalId) {
                    console.warn('⚠️ proposal returned with no id:', data.proposal);
                    break;
                }

                console.log(`🔔 Buying proposal id=${TRADING_STATE.proposalId} price(stake)=${TRADING_STATE.stake}`);
                safeSend({
                    buy: TRADING_STATE.proposalId,
                    price: TRADING_STATE.stake
                });
            }
            break;

        case 'buy':
            TRADING_STATE.isTradeDone = true;
            TRADING_STATE.activeContractId = data.buy.contract_id;
            console.log('✅ Trade purchased:', data.buy.contract_id, 'buy payload:', data.buy);
            safeSend({
                proposal_open_contract: 1,
                contract_id: data.buy.contract_id,
                subscribe: 1
            });
            break;

        case 'proposal_open_contract':
            if (data.proposal_open_contract && data.proposal_open_contract.status === 'sold') {
                console.log('🏁 Contract settled:', data.proposal_open_contract);
                TRADING_STATE.isTradeDone = false;
                TRADING_STATE.hasAveragedDown = false;
                TRADING_STATE.proposalPrice = null;
                TRADING_STATE.currentTradeType = null;
                TRADING_STATE.activeContractId = null;
            }
            break;

        default:
            // optionally handle other msg types
            break;
    }
};

// === Startup & Cleanup ===
console.log('🚀 Starting trading bot...');
initWebSocket();

// ------- cleanup: check numeric states directly -------
const cleanup = () => {
    if (ws && (ws.readyState === WS_STATES.OPEN || ws.readyState === WS_STATES.CONNECTING)) {
        try { ws.close(); } catch (e) { /* ignore */ }
    }
};

// Cross-platform cleanup handler
if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', cleanup);
} else if (typeof process !== 'undefined') {
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
}
