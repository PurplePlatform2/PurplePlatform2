import TradingChart from './chart.js';
import { xAuth, yAuth , initYAuth} from './sockets.js';
import{ showToast} from './f.js';
import HistoryModel from './historyModel.js'

const chart = new TradingChart('chart', xAuth, { symbol: 'stpRNG' });
window.chartView= chart;
window.addEventListener('beforeunload', () => chart.destroy());

// UI Elements
const $ = (id) => document.getElementById(id);
const fab = $('main-fab'), fabIcon = $('fabIcon');
const buyBtn = $('buy-btn'), sellBtn = $('sell-btn'), risk = $('risk-entry');
const toast = $('toast'), themeToggle = $('themeToggle');

// FAB Toggle
fab.onclick = () => {
    if(!yAuth){
        showToast("Trading Not Allowed,");
        $('login-card').classList.remove('hidden');
  
        
        return;}
  const open = !buyBtn.classList.contains('hidden');
  [buyBtn, sellBtn, risk].forEach(el => {
    el.classList.toggle('hidden');
    setTimeout(() => el.classList.toggle('visible', !open), 10);
  });
  fabIcon.textContent = open ? 'add' : 'remove';
};


// HISTORY BUTTON

document.addEventListener("DOMContentLoaded", () => {
  const historyBtn = document.getElementById("his-but");
  const historyContainer = document.getElementById("his-con");
  const closeHistoryBtn = document.createElement("div");

  closeHistoryBtn.className = "close-btn";
  closeHistoryBtn.innerHTML = "X";
  closeHistoryBtn.onclick = () => {
    historyContainer.classList.remove("graceful-entry");
    historyContainer.classList.add("graceful-exit");
    fullScreen(historyContainer, false);
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
      fullScreen(historyContainer, true);
      HistoryModel.init();
    }, 10);
  });
});




// Theme Switcher
themeToggle.onclick = () => {
  document.body.classList.toggle('light-theme');
  chart.toggleTheme();
};
