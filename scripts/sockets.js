import { showToast } from "./f.js";

const $ = id => document.getElementById(id),
      loginBtn = $("login-btn"),
      apiKeyInput = $("api-key");

export const xAuth = new WebSocket("wss://ws.derivws.com/websockets/v3?app_id=1089");
export let yAuth = null;
export let transactions = [];

let loadingInterval;

const startLoading = (btn, text = "Authorizing") => {
  let dots = "";
  loadingInterval = setInterval(() => {
    btn.textContent = text + (dots = dots.length < 3 ? dots + "." : "");
  }, 300);
};

const stopLoading = (btn, text = "Login") => {
  clearInterval(loadingInterval);
  btn.textContent = text;
  btn.classList.remove("loading");
};

const getCurrencySymbol = code => ({
  USD: "$", EUR: "€", GBP: "£", JPY: "¥", NGN: "₦"
}[code] || code);

export const initYAuth = (token, appId, button) => {
  if (yAuth && yAuth.readyState !== WebSocket.CLOSED) {
    yAuth.close(); // Reset old socket
  }

  yAuth = new WebSocket(`wss://ws.derivws.com/websockets/v3?app_id=${appId}`);

  yAuth.onopen = () =>
    yAuth.send(JSON.stringify({ authorize: token }));

  yAuth.onmessage = ({ data }) => {
    const res = JSON.parse(data);
    const type = res.msg_type;

    if (res.error) return stopLoading(button, "Retry"), showToast("❌ Auth Error:", res.error.message),yAuth.close(),yAuth=null;

    if (type === "authorize") {
      stopLoading(button, "✔ Success");
      setDetails(res.authorize);
      yAuth.send(JSON.stringify({ balance: 1, subscribe: 1 }));
      yAuth.send(JSON.stringify({ transaction: 1, subscribe: 1 }));
    }

    if (type === "balance") {
      const el = $("acct-bal");
      if (el) {
        const { balance, currency } = res.balance;
        const symbol = getCurrencySymbol(currency);
        el.innerHTML = `${symbol}${(+balance).toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
      }
    }

    if (type === "transaction") {
      transactions.unshift(res.transaction);
      if (transactions.length > 100) transactions.pop();
    }
    
    if (type === 'proposal') {
      ws.send(JSON.stringify({
        buy: res.proposal.id,
        price: 1
      }));
    }
  };

  yAuth.onerror = () => stopLoading(button, "Retry");
  yAuth.onclose = () => console.warn("[yAuth] Closed. Will reconnect on next login.");
};

loginBtn.onclick = () => {
  const token = apiKeyInput.value.trim();
  if (!token) return showToast("Please enter your API key.");
  loginBtn.classList.add("loading");
  startLoading(loginBtn);
  initYAuth(token, 1089, loginBtn);
};

export function setDetails(details) {
  const $q = sel => document.querySelector(sel);

  const nameEl = $q(".user-name");
  if (nameEl) nameEl.innerHTML = details.fullname || "Unnamed User";
  const emailEl = $q(".user-email");
  if (emailEl) emailEl.innerHTML = details.email || "No Email";
  const idEl = $q(".user-id");
  if (idEl) idEl.innerHTML = `Account: ${details.loginid}`;
  const balanceEl = $q("#acct-bal");
  if (balanceEl) {
    const symbol = getCurrencySymbol(details.currency);
    balanceEl.innerHTML = `${symbol}${(+details.balance).toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
  }
}


