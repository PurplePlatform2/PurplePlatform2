// === CONFIG ===
const APP_ID = 85077; // Your real Deriv App ID
const SYMBOL = 'stpRNG'; // ⚠️ Ensure this is a valid Deriv symbol, e.g., 'R_100'
const BASE_STAKE = 0.7; // Base stake amount

// === Environment Detection ===
const isNode = (typeof process !== 'undefined') && process.release?.name === 'node';
const WS = isNode ? require('ws') : WebSocket;
const API_TOKEN = isNode ? process.argv[2] : 'JklMzewtX7Da9mT'; 

// === State ===
let ws;
let stopped = false;
let hasAuthorized = false;

let lastPrice = null;
let streakCount = 0;
let streakDirection = null; // 'up' or 'down'

let tradeInProgress = false;   
let proposalPending = false;   
let lastContractId = null;     
let lastTradeDirection = null; 

// === Connect WebSocket ===
function connect() {
  ws = new WS(`wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`);

  ws.onopen = () => {
    console.log('✅ Connected to Deriv'); 
    getInitialTicks(); 
  };

  ws.onmessage = (msg) => {
    const data = JSON.parse(msg.data);
    handleMessage(data);
  };

  ws.onerror = (err) => console.error('❌ WebSocket error', err);

  ws.onclose = () => {
    if (stopped) return;
    console.log('🔄 Reconnecting in 3s...');
    setTimeout(connect, 3000);
  };
}

// === Forget ===
function forgetAllTicks() {
  ws.send(JSON.stringify({ forget_all: 'ticks' }));
}

function forgetContracts() {
  ws.send(JSON.stringify({ forget_all: 'proposal_open_contract' }));
}

// === Ticks ===
function getInitialTicks() {
  ws.send(JSON.stringify({
    ticks_history: SYMBOL,
    count: 8,
    end: 'latest',
    style: 'ticks'
  }));
}

function subscribeTicks() {
  forgetAllTicks();
  ws.send(JSON.stringify({ ticks: SYMBOL }));
}

// === Authorize once ===
function authorize() {
  ws.send(JSON.stringify({ authorize: API_TOKEN }));
}

// === Proposals ===
function sendProposal(contractType) {
  proposalPending = true;
  console.log(`📝 Requesting proposal for ${contractType} @ stake ${BASE_STAKE.toFixed(2)}`);

  ws.send(JSON.stringify({
    proposal: 1,
    amount: BASE_STAKE,
    basis: 'stake',
    contract_type: contractType, 
    currency: 'USD',
    duration: 1,
    duration_unit: 't',
    symbol: SYMBOL
  }));
}

function buyFromProposal(proposalId) {
  console.log(`🛒 Buying contract id: ${proposalId}`);
  ws.send(JSON.stringify({
    buy: proposalId,
    price: BASE_STAKE 
  }));
}

function subscribeToContract(contractId) {
  ws.send(JSON.stringify({ proposal_open_contract: 1, contract_id: contractId, subscribe: 1 }));
}

// === Trading Logic ===
function placeTrade() {
  if (stopped || tradeInProgress || proposalPending) return;

  let contractType = (streakDirection === 'down') ? 'CALL' : 'PUT';
  lastTradeDirection = contractType;
  sendProposal(contractType);
}

// === Handle Messages ===
function handleMessage(data) {
  if (data.error) {
    console.error(`⚠️ API Error: ${data.error.code} - ${data.error.message}`);
    proposalPending = false;
    return;
  }

  const poc = data.proposal_open_contract;
  if (poc) {
    if (poc.is_sold) {
      tradeInProgress = false;
      const profit = parseFloat(poc.profit);
      const result = profit >= 0 ? 'WON ✅' : 'LOST ❌';

      console.log(`📊 Contract ${poc.contract_id} settled → ${result} | P/L: ${profit.toFixed(2)} | Stake: ${BASE_STAKE.toFixed(2)}`);

      forgetContracts(); // stop listening to closed contracts
    } else {
      console.log(`📡 Contract update: ${poc.contract_id} status → ${poc.status}`);
    }
    return;
  }

  switch (data.msg_type) {
    case 'history':
      initFromHistory(data.history.prices);
      subscribeTicks();
      break;

    case 'tick':
      handleTick(data.tick);
      break;

    case 'authorize':
      console.log('🔑 Authorized');
      hasAuthorized = true;
      placeTrade();
      break;

    case 'proposal':
      proposalPending = false;
      if (!data.proposal?.id) {
        console.error('⚠️ Proposal missing id.');
        return;
      }
      buyFromProposal(data.proposal.id);
      break;

    case 'buy':
      if (!data.buy?.contract_id) {
        console.error('⚠️ Buy missing contract_id.');
        return;
      }
      lastContractId = data.buy.contract_id;
      tradeInProgress = true;
      console.log(`✅ Trade opened: ${lastContractId} | Direction: ${lastTradeDirection} | Stake: ${BASE_STAKE.toFixed(2)}`);
      subscribeToContract(lastContractId);
      break;
  }
}

// === Init streak ===
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

  console.log(`📈 Initial streak: ${streakCount} ${streakDirection}`);
}

// === Tick updates ===
function handleTick(tick) {
  if (stopped) return;

  if (lastPrice !== null) {
    if (tick.quote > lastPrice) {
      if (streakDirection === 'up') streakCount++;
      else { streakDirection = 'up'; streakCount = 1; }
    } else if (tick.quote < lastPrice) {
      if (streakDirection === 'down') streakCount++;
      else { streakDirection = 'down'; streakCount = 1; }
    }

    if (!tradeInProgress && !proposalPending && streakCount >= 8){
      console.log(`🔥 ${streakCount} ${streakDirection === 'up' ? 'Green' : 'Red'} in a row → placing trade`);
      if (hasAuthorized) placeTrade(); else authorize();
    }
  }
  lastPrice = tick.quote;
}

// === Start Bot ===
connect();
