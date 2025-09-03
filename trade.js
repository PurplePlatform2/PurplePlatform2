// deriv-martingale-regression.js
// Node.js + Browser compatible
// Entry: Linear Regression slope of last 100 ticks
// Trade: CALL or PUT
// Martingale: Stake × 2 on loss, reset on win
// Stop trading after $10 daily profit

/* === CONFIG === */
const APP_ID = 1089;                  // Replace with your App ID
const TOKEN = "tUgDTQ6ZclOuNBl";      // Replace with your API token
const SYMBOL = "stpRNG";              // Market symbol
const BASE_STAKE = 0.35;              // Initial stake in USD
const MULTIPLIER = 1;                 // Martingale multiplier
const DURATION = 1;                   // Duration in ticks
const MAX_DAILY_PROFIT = 5;          // Daily target in USD

/* === STATE === */
let currentStake = BASE_STAKE;
let lastContractId = null;
let tradeDirection = null;
let lastProposalId = null;
let dailyProfit = 0;

/* === WEBSOCKET === */
let connection;
if (typeof WebSocket !== "undefined") {
    // Browser
    connection = new WebSocket(`wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`);
} else {
    // Node.js
    const WebSocket = require("ws");
    connection = new WebSocket(`wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`);
}

/* === HELPERS === */
function send(msg) {
    if (connection.readyState === 1) {
        connection.send(JSON.stringify(msg));
    } else {
        setTimeout(() => send(msg), 200);
    }
}

function authorize() {
    send({ authorize: TOKEN });
}

function toNum(arr) {
    return arr.map(v => +v);
}

/* === REGRESSION ENTRY === */
function fetchTicks() {
    if (dailyProfit >= MAX_DAILY_PROFIT) {
        console.log(`🏆 Daily profit target reached: $${dailyProfit.toFixed(2)}. Stopping bot.`);
        connection.close();
        return;
    }

    send({
        ticks_history: SYMBOL,
        style: "ticks",
        count: 100,
        end: "latest",
    });
}

function handleTicks(pricesRaw) {
    const prices = toNum(pricesRaw);
    const n = prices.length;
    if (n < 2) return;

    const xMean = (n - 1) / 2;
    const yMean = prices.reduce((a, b) => a + b, 0) / n;
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) {
        const dx = i - xMean;
        num += dx * (prices[i] - yMean);
        den += dx * dx;
    }
    const slope = num / den;
    console.log("📊 Regression slope:", slope);

    if (slope > 0) {
        tradeDirection = "CALL";
        requestProposal(currentStake, tradeDirection);
    } else if (slope < 0) {
        tradeDirection = "PUT";
        requestProposal(currentStake, tradeDirection);
    } else {
        console.log("❌ No clear slope, retrying.");
        setTimeout(fetchTicks, 2000);
    }
}

/* === PROPOSAL REQUEST === */
function requestProposal(amount, direction) {
    console.log(`📥 Requesting proposal | Stake: ${amount} | ${direction}`);

    send({
        proposal: 1,
        amount: amount,
        basis: "stake",
        contract_type: direction,
        currency: "USD",
        duration: DURATION,
        duration_unit: "t",
        symbol: SYMBOL,
    });
}

/* === PLACE TRADE === */
function buyContract(proposalId) {
    console.log(`📈 Buying ${tradeDirection} | Stake: ${currentStake}`);
    send({ buy: proposalId, price: currentStake });
}

/* === CONTRACT MANAGEMENT === */
function handlePOC(data) {
    const poc = data.proposal_open_contract;
    if (!poc) return;

    if (poc.contract_id !== lastContractId) return;

    if (poc.is_sold) {
        console.log("📉 Contract Closed | Profit:", poc.profit);

        dailyProfit += poc.profit;
        console.log(`💰 Daily Profit: $${dailyProfit.toFixed(2)}`);

        if (dailyProfit >= MAX_DAILY_PROFIT) {
            console.log(`🏆 Target reached ($${dailyProfit.toFixed(2)}). Stopping bot.`);
            connection.close();
            return;
        }

        if (poc.profit > 0) {
            console.log("✅ WIN → Reset stake");
            currentStake = BASE_STAKE;
        } else {
            console.log("❌ LOSS → Martingale ×", MULTIPLIER);
            currentStake *= MULTIPLIER;
        }

        // Enter next trade with regression check
        setTimeout(fetchTicks, 2000);
    } else {
        console.log(`⏱ Ongoing | Profit: ${poc.profit}`);
    }
}

/* === MAIN FLOW === */
connection.onopen = () => {
    console.log("✅ WebSocket connected");
    authorize();
};

connection.onmessage = (e) => {
    const data = JSON.parse(e.data);

    if (data.error) {
        console.error("❌ Error:", data.error.message);
        return;
    }

    switch (data.msg_type) {
        case "authorize":
            console.log("🔑 Authorized");
            fetchTicks();
            break;

        case "history":
            if (data.history?.prices) handleTicks(data.history.prices);
            break;

        case "proposal":
            if (data.proposal?.id) {
                lastProposalId = data.proposal.id;
                buyContract(lastProposalId);
            }
            break;

        case "buy":
            lastContractId = data.buy.contract_id;
            console.log("🎯 Bought contract:", lastContractId);
            send({ proposal_open_contract: 1, contract_id: lastContractId, subscribe: 1 });
            break;

        case "proposal_open_contract":
            handlePOC(data);
            break;
    }
};

connection.onclose = () => {
    console.log("🔌 WebSocket closed");
};
