// === CONFIG ===
const APP_ID = 1089;
const SYMBOL = 'stpRNG'; 
const API_TOKEN = process.argv[2] || 'JklMzewtX7Da9mT';

const TIMEFRAME = 60;
const CANDLE_DIFF_THRESHOLD = 1.7;
const BASE_STAKE = 0.35;
const DURATION_SECONDS = 1;
const MARTINGALE_MULTIPLIER = 2.2;
const MAX_MARTINGALE_LEVELS = 10;

// === Environment ===
const isNode = (typeof process !== 'undefined') && process.release?.name === 'node';
const WS = isNode ? require('ws') : WebSocket;

// === State ===
let ws;
let heartbeat;
let hasAuthorized = false;
let pendingTradeType = null;

let tradeInProgress = false;
let proposalPending = false;
let lastContractId = null;
let currentStake = BASE_STAKE;
let martingaleLevel = 0;
let isMartingaleActive = false;

// === Stake Helper ===
function roundStake(value) {
  return Math.round(value * 100) / 100; // clamp to 2 decimals
}

// === Connect ===
function connect() {
  if (isNode) {
    ws = new WS(`wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`, {
      perMessageDeflate: false   // 🚀 prevent Node crash
    });
  } else {
    ws = new WS(`wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`);
  }

  ws.onopen = () => {
    console.log('✅ Connected');
    subscribeCandles();
    startHeartbeat();
  };

  ws.onmessage = (msg) => handleMessage(JSON.parse(msg.data));

  ws.onclose = () => {
    console.log('⚠️ Disconnected. Reconnecting in 3s...');
    clearInterval(heartbeat);
    setTimeout(connect, 3000);
  };

  ws.onerror = (err) => console.error('❌ WebSocket Error', err);
}

// === Heartbeat ===
function startHeartbeat() {
  heartbeat = setInterval(() => {
    if (ws && ws.readyState === WS.OPEN) {
      ws.send(JSON.stringify({ ping: 1 }));
      console.log('🔄 Ping');
    }
  }, 20000);
}

// === Candle Subscription ===
function subscribeCandles() {
  ws.send(JSON.stringify({
    ticks_history: SYMBOL,
    end: 'latest',
    count: 2,
    subscribe: 1,
    style: 'candles',
    granularity: TIMEFRAME,
  }));
  console.log(`📡 Subscribed to ${SYMBOL} ${TIMEFRAME}s candles`);
}

// === Candle Handler ===
function isCandleClosed(candle) {
  const now = Math.floor(Date.now() / 1000);
  return now >= (candle.epoch + TIMEFRAME);
}

function handleCandle(candle) {
  const open = parseFloat(candle.open);
  const close = parseFloat(candle.close);
  const high = parseFloat(candle.high);
  const low = parseFloat(candle.low);
  const range = high - low;
  const bullish = close > open;

  console.log(`🕯️ Closed Candle O=${open} H=${high} L=${low} C=${close} R=${range.toFixed(2)}`);

  if (true) { // (range >= CANDLE_DIFF_THRESHOLD && bullish && !tradeInProgress)
    console.log('🟢 Big Bullish Candle → prepare PUT trade');
    isMartingaleActive = true;
    martingaleLevel = 0;
    currentStake = roundStake(BASE_STAKE);

    if (!hasAuthorized) {
      pendingTradeType = 'PUT';
      ws.send(JSON.stringify({ authorize: API_TOKEN }));
      console.log('🔑 Requesting authorization...');
    } else {
      placeTrade('PUT');
    }
  }
}

// === Trade Flow ===
function sendProposal(type) {
  proposalPending = true;
  ws.send(JSON.stringify({
    proposal: 1,
    amount: currentStake,
    basis: 'stake',
    contract_type: type,
    currency: 'USD',
    duration: DURATION_SECONDS,
    duration_unit: 't',
    symbol: SYMBOL
  }));
  console.log(`📝 Proposal requested: ${type} @ $${currentStake.toFixed(2)}`);
}

function buyFromProposal(id) {
  ws.send(JSON.stringify({ buy: id, price: currentStake }));
  console.log(`🛒 Buying proposal id ${id}`);
}

function subscribeToContract(contractId) {
  ws.send(JSON.stringify({ proposal_open_contract: 1, contract_id: contractId, subscribe: 1 }));
}

// === Place Trade ===
function placeTrade(type) {
  if (tradeInProgress || proposalPending) return;
  currentStake = roundStake(currentStake); // ensure stake is clean before sending
  sendProposal(type);
}

// === Handle Messages ===
function handleMessage(data) {
  if (data.error) {
    console.error(`⚠️ API Error: ${data.error.code} - ${data.error.message}`);
    proposalPending = false;
    return;
  }

  if (data.msg_type === 'authorize') {
    hasAuthorized = true;
    console.log('🔑 Authorized');
    if (pendingTradeType) {
      placeTrade(pendingTradeType);
      pendingTradeType = null;
    }
    return;
  }

  if (data.msg_type === 'candles' && data.candles?.length > 0) {
    const c = data.candles[0];
    if (isCandleClosed(c)) handleCandle(c);
    return;
  }

  if (data.msg_type === 'proposal') {
    proposalPending = false;
    if (!data.proposal?.id) return console.error('⚠️ Proposal missing id');
    buyFromProposal(data.proposal.id);
    return;
  }

  if (data.msg_type === 'buy') {
    if (!data.buy?.contract_id) return console.error('⚠️ Buy missing contract_id');
    lastContractId = data.buy.contract_id;
    tradeInProgress = true;
    console.log(`✅ Trade opened: ${lastContractId} | Stake: $${currentStake.toFixed(2)}`);
    subscribeToContract(lastContractId);
    return;
  }

  if (data.msg_type === 'proposal_open_contract' && data.proposal_open_contract) {
    const poc = data.proposal_open_contract;
    if (poc.is_sold) {
      tradeInProgress = false;
      const profit = parseFloat(poc.profit);
      const result = profit >= 0 ? 'WON ✅' : 'LOST ❌';
      console.log(`📊 Contract ${poc.contract_id} settled → ${result} | P/L ${profit.toFixed(2)}`);

      if (profit < 0) {
        martingaleLevel++;
        if (martingaleLevel > MAX_MARTINGALE_LEVELS) {
          console.log('🛑 Max martingale reached. Stopping.');
          return;
        }
        currentStake = roundStake(currentStake * MARTINGALE_MULTIPLIER);
        console.log(`🔄 Loss → Martingale step ${martingaleLevel} @ $${currentStake.toFixed(2)}`);
        placeTrade('PUT');
      } else {
        console.log('✅ Win → Resetting martingale');
        currentStake = roundStake(BASE_STAKE);
        martingaleLevel = 0;
        isMartingaleActive = false;
      }
    }
    return;
  }
}

// === Start Bot ===
connect();
