// === CONFIG ===
const APP_ID = 85077; // Your real Deriv App ID
const API_TOKEN = process.argv[2] || 'JklMzewtX7Da9mT'; // Your real Deriv API token
const SYMBOL = 'stpRNG'; // ⚠️ Ensure this is a valid Deriv symbol, e.g., 'R_100'
const BASE_STAKE = 0.35; // Base stake amount
const CONTRACT_DURATION = 1; // in minutes
const MAX_MARTINGALE_LEVELS = 4; // Stop after this many consecutive losses

// === Environment Detection ===
const isNode = (typeof process !== 'undefined') && process.release?.name === 'node';
const WS = isNode ? require('ws') : WebSocket;

// === State ===
let ws;
let stopped = false;

let lastPrice = null;
let streakCount = 0;
let streakDirection = null; // 'up' or 'down'

let tradeInProgress = false;   // true once a contract is bought until it settles
let proposalPending = false;   // true between sending proposal and receiving it
let lastContractId = null;     // most recent opened contract id
let lastTradeDirection = null; // 'CALL' or 'PUT' for the last placed trade
let reverseTradePending = false; // set true when we want to reverse the last direction after a loss

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
    if (stopped) return;
    console.log('🔄 Reconnecting in 3s...');
    setTimeout(connect, 3000);
  };
}

// === Utility: Forget all tick subscriptions (avoid dups on reconnect) ===
function forgetAllTicks() {
  ws.send(JSON.stringify({ forget_all: 'ticks' }));
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
  // prevent duplicate subscriptions across reconnects
  forgetAllTicks();
  ws.send(JSON.stringify({ ticks: SYMBOL }));
}

// === Authorize (done right before trading) ===
function authorize() {
  ws.send(JSON.stringify({ authorize: API_TOKEN }));
}

// === Send Proposal (then we'll Buy in the proposal handler) ===
function sendProposal(contractType) {
  proposalPending = true;
  console.log(`📝 Requesting proposal for ${contractType} @ stake ${currentStake}`);

  ws.send(JSON.stringify({
    proposal: 1,
    amount: currentStake,
    basis: 'stake',
    contract_type: contractType, // 'CALL' or 'PUT'
    currency: 'USD',
    duration: CONTRACT_DURATION,
    duration_unit: 'm',
    symbol: SYMBOL
  }));
}

// === Buy using proposal id ===
function buyFromProposal(proposalId) {
  console.log(`🛒 Buying contract from proposal id: ${proposalId}`);
  ws.send(JSON.stringify({
    buy: proposalId,
    price: currentStake // Max price you're willing to pay (stake for basis: 'stake')
  }));
}

// === Subscribe to Contract Updates ===
function subscribeToContract(contractId) {
  ws.send(JSON.stringify({ proposal_open_contract: 1, contract_id: contractId }));
}

// === Decide and Place Trade ===
function placeTrade() {
  if (stopped || tradeInProgress || proposalPending) return;

  // If we're reversing after a loss, invert the previous trade direction
  let contractType;
  if (reverseTradePending && lastTradeDirection) {
    contractType = lastTradeDirection === 'CALL' ? 'PUT' : 'CALL';
    reverseTradePending = false;
  } else {
    // Original logic: trade opposite of the streak direction (reversion idea)
    // If streak is 'down' (many reds), place 'CALL'; if 'up', place 'PUT'
    contractType = (streakDirection === 'down') ? 'CALL' : 'PUT';
  }

  lastTradeDirection = contractType;
  sendProposal(contractType);
}

// === Handle Incoming Messages ===
function handleMessage(data) {
  if (data.error) {
    console.error(`⚠️ API Error: ${data.error.code} - ${data.error.message}`);
    proposalPending = false;
    return;
  }

  switch (data.msg_type) {
    case 'history':
      if (!data.history?.prices?.length) {
        console.error('⚠️ No history returned for symbol. Check SYMBOL.');
        return;
      }
      initFromHistory(data.history.prices);
      subscribeTicks();
      break;

    case 'tick':
      handleTick(data.tick);
      break;

    case 'authorize':
      console.log('🔑 Authorized');
      placeTrade();
      break;

    case 'proposal':
      proposalPending = false;
      if (!data.proposal?.id) {
        console.error('⚠️ Proposal returned without id.');
        return;
      }
      buyFromProposal(data.proposal.id);
      break;

    case 'buy':
      if (!data.buy?.contract_id) {
        console.error('⚠️ Buy response without contract_id.');
        return;
      }
      console.log(`✅ Trade opened: ${data.buy.contract_id}`);
      lastContractId = data.buy.contract_id;
      tradeInProgress = true;
      subscribeToContract(lastContractId);
      break;

    case 'proposal_open_contract': {
      const poc = data.proposal_open_contract;
      if (!poc) return;

      if (poc.is_sold) {
        // Contract settled
        tradeInProgress = false;
        const profit = poc.profit;
        console.log(`📊 Trade settled. Profit: ${profit}`);

        if (profit < 0) {
          martingaleLevel++;
          if (martingaleLevel > MAX_MARTINGALE_LEVELS) {
            console.log(`🛑 Max martingale level (${MAX_MARTINGALE_LEVELS}) reached. Stopping bot.`);
            stopped = true;
            if (isNode) process.exit(0);
            return;
          }
          console.log(`🔄 Loss — reversing direction and doubling stake (Level ${martingaleLevel})`);
          reverseTradePending = true;
          currentStake *= 2;

          // Immediately prepare next trade (requires auth)
          authorize();
        } else {
          // Win: reset martingale
          currentStake = BASE_STAKE;
          martingaleLevel = 0;
          // Optional: wait for a fresh streak trigger rather than instant re-entry
          console.log('✅ Win — martingale reset. Waiting for next streak signal.');
        }
      }
      break;
    }

    default:
      // Other message types (ping, time, etc.) can be ignored or logged
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

  console.log(`📈 Initial streak: ${streakCount} ${streakDirection}`);
}

// === Handle Live Tick Updates ===
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

    // Trigger only when not in an active trade or proposal, and streak is strong
    if (!tradeInProgress && !proposalPending && streakCount >= 8) {
      console.log(`🔥 ${streakCount} ${streakDirection === 'up' ? 'Green' : 'Red'} in a row — preparing trade`);
      authorize();
    }
  }
  lastPrice = tick.quote;
}

// === Start Bot ===
connect();
