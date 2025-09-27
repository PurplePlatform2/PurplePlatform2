// === 15s CALL/PUT Bot (Browser + Node.js) ===
// Smart Strategy + Logs + Reconnects + History Init
// Places CALL and PUT simultaneously

// CONFIG
const APP_ID = 1089;
const TOKEN = "tUgDTQ6ZclOuNBl"; // replace with your Deriv token
const SYMBOL = "stpRNG";
const BASE_STAKE = 1, DURATION = 15, UNIT = "s", CURRENCY = "USD";
const MAJOR_WINDOW = 40, MINOR_WINDOW = 5;
const BACKOFF_MS = 5000, PING_MS = 30000;

// WebSocket ctor
let WebSocketCtor = typeof window === "undefined" ? require("ws") : window.WebSocket;

// State
let ws, keepalive, authorized = false, backoff = false, waitingRecoil = false;
let tick_history = [], activeContracts = {};

// === Helpers ===
const send = o => ws?.readyState === WebSocketCtor.OPEN && ws.send(JSON.stringify(o));
const lastN = n => tick_history.slice(-n);

function slope(vals) {
  let n = vals.length, sx = 0, sy = 0, sxy = 0, sxx = 0;
  if (n < 2) return 0;
  for (let i = 0; i < n; i++) sx += i, sy += vals[i], sxy += i * vals[i], sxx += i * i;
  return (n * sxy - sx * sy) / (n * sxx - sx * sx || 1);
}

// === Strategy ===
function majorTrend() {
  const arr = lastN(MAJOR_WINDOW);
  if (arr.length < MAJOR_WINDOW / 2) return "NEUTRAL";
  const s = slope(arr), mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const std = Math.sqrt(arr.reduce((a, v) => a + (v - mean) ** 2, 0) / arr.length);
  const t = std * 0.001;
  return s > t ? "UP" : s < -t ? "DOWN" : "NEUTRAL";
}
function volThresh() {
  const arr = lastN(20);
  if (arr.length < 5) return 0.4;
  const diffs = arr.slice(1).map((v, i) => Math.abs(v - arr[i]));
  return Math.max(0.2, diffs.reduce((a, b) => a + b, 0) / diffs.length * 2);
}
function minorCounter() {
  const arr = lastN(MINOR_WINDOW + 1);
  if (arr.length < MINOR_WINDOW) return { found: false };
  let up = 0, down = 0;
  for (let i = arr.length - MINOR_WINDOW; i < arr.length; i++) {
    if (arr[i] > arr[i - 1]) up++; else if (arr[i] < arr[i - 1]) down++;
  }
  const mag = Math.abs(arr.at(-1) - arr.at(-MINOR_WINDOW - 1));
  if (down === MINOR_WINDOW && mag >= volThresh()) return { found: true, direction: "DOWN", mag };
  if (up === MINOR_WINDOW && mag >= volThresh()) return { found: true, direction: "UP", mag };
  return { found: false };
}

function onTick(p) {
  tick_history.push(p); if (tick_history.length > 2000) tick_history = tick_history.slice(-1000);
  console.log(`📈 Tick: ${p}`);
  if (backoff) return;
  const major = majorTrend(), minor = minorCounter();
  console.log(`Trend=${major}, Counter=${minor.found ? minor.direction + " mag=" + minor.mag.toFixed(3) : "none"}`);
  if (minor.found && ((major === "UP" && minor.direction === "DOWN") || (major === "DOWN" && minor.direction === "UP")))
    waitRecoil(major);
}
function waitRecoil(dir) {
  if (waitingRecoil) return; waitingRecoil = true;
  console.log(`⏳ Waiting recoil for ${dir}`);
  let confirms = 0;
  const orig = onTick;
  onTick = p => { orig(p); if (waitingRecoil) {
    const [a, b] = tick_history.slice(-2);
    if ((dir === "UP" && b > a) || (dir === "DOWN" && b < a)) confirms++; else confirms = 0;
    if (confirms >= 2) { waitingRecoil = false; placeBoth(); }
  }};
  setTimeout(() => waitingRecoil = false, 3000);
}

// === Trading ===
function placeTrade(type) {
  if (!authorized || backoff) return;
  console.log(`🚀 Trade: ${type} ${DURATION}${UNIT}, stake ${BASE_STAKE}${CURRENCY}`);
  send({ buy: 1, price: BASE_STAKE, parameters: { amount: BASE_STAKE, basis: "stake", contract_type: type,
    currency: CURRENCY, duration: DURATION, duration_unit: UNIT, symbol: SYMBOL } });
}
function placeBoth() {
  console.log("🚀 Placing BOTH CALL & PUT");
  ["CALL", "PUT"].forEach(type => placeTrade(type));
}

// === WS Connection ===
function connect() {
  ws = new WebSocketCtor(`wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`);
  ws.onopen = () => { console.log("🔌 WS open, authorizing..."); send({ authorize: TOKEN });
    clearInterval(keepalive); keepalive = setInterval(() => send({ ping: 1 }), PING_MS); };
  ws.onclose = () => { console.warn("⚠️ WS closed — reconnecting..."); authorized = waitingRecoil = false; setTimeout(connect, 2000); };
  ws.onerror = e => console.error("❌ WS error", e?.message);
  ws.onmessage = e => {
    let d; try { d = JSON.parse(e.data); } catch { return; }
    if(d.error)console.log(JSON.stringify(d.error));
    if (d.authorize && !d.error) { authorized = true; console.log("✅ Authorized"); 
      send({ ticks_history: SYMBOL, style: "ticks", end: "latest", count: Math.max(MAJOR_WINDOW, 100) });
      send({ ticks: SYMBOL, subscribe: 1 }); }
    if (d.history) { tick_history = d.history.prices.map(Number); console.log(`📜 Init history: ${tick_history.length} ticks`); }
    if (d.tick?.quote) onTick(Number(d.tick.quote));
    if (d.buy?.contract_id) { 
      activeContracts[d.buy.contract_id] = { id: d.buy.contract_id };
      console.log(`✅ Bought contract ${d.buy.contract_id}`); 
    }
    if (d.contract?.contract_id && (d.contract.is_sold || d.contract.status === "sold")) {
      console.log(`🏁 Contract ${d.contract.contract_id} finished, profit=${d.contract.profit}`);
      delete activeContracts[d.contract.contract_id];
      if (Object.keys(activeContracts).length === 0) backoffFn();
    }
  };
}
function backoffFn() {
  if (backoff) return; backoff = true;
  console.log(`⏸ Backoff ${BACKOFF_MS}ms`); setTimeout(() => { backoff = false; console.log("▶ Resumed"); }, BACKOFF_MS);
}

// Start
connect();
if (typeof process !== "undefined" && process.on)
  process.on("SIGINT", () => { console.log("👋 Exit"); clearInterval(keepalive); ws?.close(); process.exit(); });
  
