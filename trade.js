// === CONFIG ===
const APP_ID = 85077; // Your real Deriv App ID
const API_TOKEN = process.argv[2] || 'YOUR_REAL_API_TOKEN_HERE'; // Your real Deriv API token
const SYMBOL = 'R_100';
const BASE_STAKE = 1; // Base stake amount
const CONTRACT_DURATION = 1; // in minutes
const MAX_MARTINGALE_LEVELS = 4;

// === Environment Detection ===
const isNode = (typeof process !== 'undefined') && process.release?.name === 'node';
const WS = isNode ? require('ws') : WebSocket;

// === State ===
let ws;
let lastPrice = null;
let streakCount = 0;
let streakDirection = null; // 'up' or 'down'
let tradeInProgress = false;
let lastContractId = null;
let reverseTradePending = false;
let currentStake = BASE_STAKE;
let martingaleLevel = 0;

// === Connect WebSocket ===
function connect() {
    ws = new WS(`wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`);

    ws.onopen = () => {
        console.log('✅ Connected to Deriv');
        getInitialTicks(); // Initialize from last 8 ticks
    };

    ws.onmessage = (msg) => {
        const data = JSON.parse(msg.data);
        handleMessage(data);
    };

    ws.onerror = (err) => console.error('❌ WebSocket error', err);
    ws.onclose = () => {
        console.log('🔄 Reconnecting in 3s...');
        setTimeout(connect, 3000);
    };
}

// === Get Last 8 Ticks from History ===
function getInitialTicks() {
    ws.send(JSON.stringify({
        ticks_history: SYMBOL,
        count: 8,
        end: 'latest',
        style: 'ticks'
    }));
}

// === Subscribe to Live Ticks ===
function subscribeTicks() {
    ws.send(JSON.stringify({ ticks: SYMBOL }));
}

// === Authorize ===
function authorize() {
    ws.send(JSON.stringify({ authorize: API_TOKEN }));
}

// === Buy Contract ===
function buyContract(contractType) {
    console.log(`📤 Placing ${contractType} trade with stake: ${currentStake}`);
    ws.send(JSON.stringify({
        buy: 1,
        price: currentStake,
        parameters: {
            amount: currentStake,
            basis: 'stake',
            contract_type: contractType,
            currency: 'USD',
            duration: CONTRACT_DURATION,
            duration_unit: 'm',
            symbol: SYMBOL
        }
    }));
}

// === Handle Incoming Messages ===
function handleMessage(data) {
    switch (data.msg_type) {
        case 'history':
            initFromHistory(data.history.prices);
            break;

        case 'tick':
            handleTick(data.tick);
            break;

        case 'authorize':
            console.log('🔑 Authorized');
            placeTrade();
            break;

        case 'buy':
            console.log(`✅ Trade opened: ${data.buy.contract_id}`);
            lastContractId = data.buy.contract_id;
            tradeInProgress = true;
            subscribeToContract(lastContractId);
            break;

        case 'proposal_open_contract':
            if (data.proposal_open_contract.is_sold) {
                tradeInProgress = false;
                const profit = data.proposal_open_contract.profit;
                console.log(`📊 Trade ended. Profit: ${profit}`);

                if (profit < 0) {
                    martingaleLevel++;
                    if (martingaleLevel > MAX_MARTINGALE_LEVELS) {
                        console.log(`🛑 Max martingale level (${MAX_MARTINGALE_LEVELS}) reached. Stopping bot.`);
                        process.exit(0);
                    }
                    console.log(`🔄 Loss detected — reversing direction and doubling stake (Level ${martingaleLevel})`);
                    reverseTradePending = true;
                    currentStake *= 2;
                    authorize();
                } else {
                    currentStake = BASE_STAKE;
                    martingaleLevel = 0;
                }
            }
            break;
    }
}

// === Initialize Streak from History ===
function initFromHistory(prices) {
    console.log(`📜 Initializing from last ${prices.length} ticks...`);
    streakCount = 1;
    streakDirection = null;
    lastPrice = prices[0];

    for (let i = 1; i < prices.length; i++) {
        if (prices[i] > lastPrice) {
            if (streakDirection === 'up') streakCount++;
            else { streakDirection = 'up'; streakCount = 1; }
        } else if (prices[i] < lastPrice) {
            if (streakDirection === 'down') streakCount++;
            else { streakDirection = 'down'; streakCount = 1; }
        }
        lastPrice = prices[i];
    }

    console.log(`📊 Initial streak: ${streakCount} ${streakDirection}`);
    subscribeTicks();
}

// === Handle Live Tick Updates ===
function handleTick(tick) {
    if (lastPrice !== null) {
        if (tick.quote > lastPrice) {
            if (streakDirection === 'up') streakCount++;
            else { streakDirection = 'up'; streakCount = 1; }
        } else if (tick.quote < lastPrice) {
            if (streakDirection === 'down') streakCount++;
            else { streakDirection = 'down'; streakCount = 1; }
        }

        if (!tradeInProgress && streakCount >= 8) {
            console.log(`🔥 ${streakCount} ${streakDirection === 'up' ? 'Green' : 'Red'} in a row`);
            authorize();
        }
    }
    lastPrice = tick.quote;
}

// === Place Trade ===
function placeTrade() {
    if (reverseTradePending) {
        buyContract(streakDirection === 'up' ? 'PUT' : 'CALL');
        reverseTradePending = false;
    } else {
        buyContract(streakDirection === 'down' ? 'CALL' : 'PUT');
    }
}

// === Subscribe to Contract Updates ===
function subscribeToContract(contractId) {
    ws.send(JSON.stringify({ proposal_open_contract: 1, contract_id: contractId }));
}

// === Start Bot ===
connect();
