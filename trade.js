/**
 * 🎯 Martingale 5-Minute Candle Strategy for Deriv (Exact TraderXY cProfit)
 * Author: Dr. Sanne Karibo
 *
 * ✅ Uses TraderXY-style cProfit() → profit = sell_price - buy_price.
 * ✅ Only evaluates the latest closed trade.
 * ✅ If last trade was LOSS → doubles stake (max 8× Base_Stake).
 * ✅ If exceeds limit → resets to Base_Stake.
 * ✅ Uses 5-minute candles for direction & re-entry.
 */

const token = 'tUgDTQ6ZclOuNBl'; // 🔐 Replace with your real token
const symbol = 'stpRNG';
const Base_Stake = 1;
let currentStake = Base_Stake;

let lastTradeId = null;
let tradeDirection = null;
let proposalId = null;
let waitingNextCandle = false;

const ws = new WebSocket('wss://ws.derivws.com/websockets/v3?app_id=1089');

function log(msg, data = '') {
  const time = new Date().toLocaleTimeString();
  console.log(`[${time}] ${msg}`, data || '');
}

// ===============================
// 🔌 WebSocket Lifecycle
// ===============================
ws.onopen = () => {
  log('🌐 Connecting to Deriv...');
  ws.send(JSON.stringify({ authorize: token }));
};

ws.onmessage = (msg) => {
  const data = JSON.parse(msg.data);
  if (data.error) {
    log('❌ Error:', data.error.message);
    return;
  }

  switch (data.msg_type) {
    case 'authorize':
      log(`✅ Authorized as ${data.authorize.loginid}`);
      getLastProfit();
      break;
    case 'profit_table':
      handleProfitTable(data);
      break;
    case 'candles':
      handleCandleData(data);
      break;
    case 'proposal':
      handleProposal(data);
      break;
    case 'buy':
      handleBuy(data);
      break;
    case 'proposal_open_contract':
      handleOpenContract(data);
      break;
  }
};

// ===============================
// 📊 Candle Data Logic
// ===============================
function fetchCandles() {
  ws.send(JSON.stringify({
    ticks_history: symbol,
    count: 3,
    granularity: 300, // 5-minute candles
    end: 'latest',
    style: 'candles'
  }));
}

function handleCandleData(data) {
  const candles = data.candles;
  if (!candles?.length) return;

  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];

  const direction = decideDirection(prev, last);
  tradeDirection = direction;

  log(`📊 Candle closed at ${last.close}. Strategy suggests: ${direction}`);
  sendProposal(direction);
}

function decideDirection(prev, last) {
  const diff = last.close - prev.close;
  return diff > 0 ? 'CALL' : 'PUT';
}

// ===============================
// 💸 Trade Proposal & Execution
// ===============================
function sendProposal(direction) {
  log(`🧾 Requesting proposal → ${direction} | Stake: $${currentStake}`);
  ws.send(JSON.stringify({
    proposal: 1,
    amount: currentStake,
    basis: 'stake',
    contract_type: direction,
    currency: 'USD',
    duration: 59,
    duration_unit: 's',
    symbol
  }));
}

function handleProposal(data) {
  proposalId = data.proposal.id;
  log(`💡 Proposal ready → ${data.proposal.contract_type} | Payout: $${data.proposal.payout.toFixed(2)}`);
  ws.send(JSON.stringify({ buy: proposalId, price: currentStake }));
}

function handleBuy(data) {
  lastTradeId = data.buy.contract_id;
  log(`🟢 Trade executed: ${tradeDirection} | Contract ID: ${lastTradeId}`);

  ws.send(JSON.stringify({
    proposal_open_contract: 1,
    contract_id: lastTradeId,
    subscribe: 1
  }));
}

// ===============================
// 🧠 Contract Status Tracking
// ===============================
function handleOpenContract(data) {
  const poc = data.proposal_open_contract;
  if (!poc) return;

  if (poc.status === 'open') {
    const profit = parseFloat(poc.profit).toFixed(2);
    const current = parseFloat(poc.current_spot).toFixed(4);
    log(`📡 Live Contract → Profit: $${profit} | Spot: ${current}`);
  } else {
    const buy = parseFloat(poc.buy_price) || 0;
    const sell = parseFloat(poc.sell_price || poc.current_spot) || 0;
    const profit = +(sell - buy).toFixed(2);

    log(`🏁 Contract Closed:
       → ${profit > 0 ? '✅ WIN' : '❌ LOSS'}
       → Entry: $${buy.toFixed(2)}
       → Exit: $${sell.toFixed(2)}
       → Profit/Loss: $${profit.toFixed(2)}
    `);

    ws.send(JSON.stringify({ forget_all: 'proposal_open_contract' }));
    getLastProfit();
    waitForNextCandle();
  }
}

// ===============================
// 💰 Profit Check (Exact TraderXY logic)
// ===============================
function getLastProfit() {
  ws.send(JSON.stringify({
    profit_table: 1,
    description: 1,
    limit: 1, // ✅ Only last trade
    sort: 'DESC'
  }));
}

// 🔍 TraderXY’s exact logic (sell_price - buy_price)
function cProfit(lastTrade) {
  if (!lastTrade) return { profit: 0, stake: 0, type: 'N/A' };

  const buy = parseFloat(lastTrade.buy_price) || 0;
  const sell = parseFloat(lastTrade.sell_price) || 0;
  const profit = +(sell - buy).toFixed(2);
  const type = lastTrade.contract_type || 'Unknown';

  return {
    profit,
    stake: buy.toFixed(2),
    type
  };
}

function handleProfitTable(data) {
  const lastTrade = data.profit_table.transactions?.[0];
  if (!lastTrade) {
    log('ℹ️ No previous trades found. Starting fresh...');
    fetchCandles();
    return;
  }

  const cp = cProfit(lastTrade);
  const profit = cp.profit;
  const stake = parseFloat(cp.stake);

  log(`📋 Last Trade Summary:
       → Contract: ${cp.type}
       → Stake: $${stake}
       → Profit/Loss: $${profit.toFixed(2)}
  `);

  if (profit < 0) {
    currentStake = Math.min(stake * 2, Base_Stake * 8);
    if (currentStake >= Base_Stake * 8) {
      log('🛑 Reached 8× Base Stake. Resetting to Base.');
      currentStake = Base_Stake;
    } else {
      log(`📉 LOSS detected. Increasing stake → $${currentStake}`);
    }
  } else if (profit > 0) {
    currentStake = Base_Stake;
    log(`💰 WIN detected. Resetting stake → $${currentStake}`);
  } else {
    log('ℹ️ Neutral result or still open.');
  }

  if (!waitingNextCandle) fetchCandles();
}

// ===============================
// ⏳ Candle Wait Timer
// ===============================
function waitForNextCandle() {
  waitingNextCandle = true;
  const now = new Date();

  const msToNext5Min =
    (5 - (now.getMinutes() % 5)) * 60 * 1000 -
    (now.getSeconds() * 1000 + now.getMilliseconds());

  const secs = (msToNext5Min / 1000).toFixed(1);
  log(`⏳ Waiting ${secs}s for next 5-min candle...`);

  setTimeout(() => {
    waitingNextCandle = false;
    fetchCandles();
  }, msToNext5Min + 1500);
}
