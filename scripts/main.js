import TradingChart from './chart.js';
import { xAuth, yAuth, initYAuth } from './sockets.js';
import { showToast } from './f.js';
import HistoryModel from './historyModel.js';

const chart = new TradingChart('chart', xAuth, { symbol: 'stpRNG' });
window.chartView = chart;
window.addEventListener('beforeunload', () => chart.destroy());

const $ = (id) => document.getElementById(id);
const fab = $('main-fab');
const fabIcon = $('fabIcon');
const buyBtn = $('buy-btn');
const sellBtn = $('sell-btn');
const risk = $('risk-entry');
const toast = $('toast');
const themeToggle = $('themeToggle');

// FAB Toggle
if (fab) {
  fab.onclick = () => {
    if (!yAuth || yAuth.readystate) {
      showToast("⚠️ Trading Not Allowed (Not Authorized)");
      const loginCard = $('login-card');
      if (loginCard) loginCard.classList.remove('hidden');
      return;
    }

    const open = !buyBtn.classList.contains('hidden');
    [buyBtn, sellBtn, risk].forEach(el => {
      el.classList.toggle('hidden');
      setTimeout(() => el.classList.toggle('visible', !open), 10);
    });
    fabIcon.textContent = open ? 'add' : 'remove';
  };
}

// BUY → CALL contract
if (buyBtn) {
  buyBtn.onclick = () => {
    if (!yAuth || yAuth.readyState !== 1) return showToast("🔒 Not Authorized");

    const proposal = {
      buy: 1,
      price: 1,
      parameters: {
        amount: 1,
        basis: "stake",
        contract_type: "CALL",
        currency: "USD",
        duration: 1,
        duration_unit: "m",
        symbol: "stpRNG"
      }
    };

    yAuth.send(JSON.stringify(proposal));
    showToast("📈 CALL trade placed");
  };
}

// SELL → PUT contract
if (sellBtn) {
  sellBtn.onclick = () => {
    if (!yAuth || yAuth.readyState !== 1) return showToast("🔒 Not Authorized");

    const proposal = {
      buy: 1,
      price: 1,
      parameters: {
        amount: 1,
        basis: "stake",
        contract_type: "PUT",
        currency: "USD",
        duration: 1,
        duration_unit: "m",
        symbol: "stpRNG"
      }
    };

    yAuth.send(JSON.stringify(proposal));
    showToast("📉 PUT trade placed");
  };
}

// HISTORY PANEL
document.addEventListener("DOMContentLoaded", () => {
  const historyBtn = $("his-but");
  const historyContainer = $("his-con");

  if (!historyBtn || !historyContainer) return;

  const closeHistoryBtn = document.createElement("div");
  closeHistoryBtn.className = "close-btn";
  closeHistoryBtn.innerHTML = "X";
  closeHistoryBtn.onclick = () => {
    exitSoftFullscreen();
    historyContainer.classList.remove("graceful-entry");
    historyContainer.classList.add("graceful-exit");
    setTimeout(() => {
      historyContainer.classList.add("hidden");
      historyContainer.classList.remove("graceful-exit");
    }, 600);
  };
  historyContainer.prepend(closeHistoryBtn);

  historyBtn.addEventListener("click", () => {
    historyContainer.classList.remove("hidden", "graceful-exit");
    historyContainer.classList.add("graceful-entry");
    setTimeout(() => {
      enterSoftFullscreen(historyContainer);
      HistoryModel.init?.();
    }, 10);
  });
});

// SOFT FULLSCREEN HANDLER
function enterSoftFullscreen(el) {
  el.setAttribute('data-soft-fullscreen', 'true');

  for (const child of document.body.children) {
    if (child !== el && child.id !== 'bottomMenu') {
      child.classList.add('hidden');
    }
  }
}

function exitSoftFullscreen() {
  const active = document.querySelector('[data-soft-fullscreen="true"]');
  if (active) active.removeAttribute('data-soft-fullscreen');

  document.querySelectorAll('.hidden').forEach(el => {
    el.classList.remove('hidden');
  });
}

// THEME TOGGLE
if (themeToggle) {
  themeToggle.onclick = () => {
    document.body.classList.toggle('light-theme');
    chart.toggleTheme?.();
  };
}
