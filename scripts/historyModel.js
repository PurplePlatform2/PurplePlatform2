import { yAuth } from './Sockets.js';

const $ = id => document.getElementById(id);

const HistoryModel = (() => {
  const listContainer = $('history-list');
  const startInput = $('startDate');
  const endInput = $('endDate');
  const applyBtn = $('applyBtn');

  const show = html => listContainer.innerHTML = html;
  const showLoading = () => show("<p>Loading history...</p>");
  const showError = msg => show(`<p style="color:red;">❌ ${msg}</p>`);

  const formatDate = ts => new Date(ts * 1000).toLocaleString();

  const render = txns => {
    if (!txns.length) return show("<p>No trades found in this period.</p>");
    const cards = txns.map(tx => `
      <div class="history-card">
        <div class="history-info">
          <div class="history-title">${tx.description}</div>
          <div class="history-desc">Contract ID: ${tx.contract_id || 'N/A'}</div>
        </div>
        <div class="history-meta">
          <div>${formatDate(tx.transaction_time || tx.date)}</div>
          <div style="color:${tx.amount < 0 ? '#d32f2f' : '#388e3c'}">
            ${tx.amount < 0 ? '-' : '+'} $${Math.abs(tx.amount).toFixed(2)}
          </div>
        </div>
      </div>
    `).join('');
    show(cards);
  };

  const fetchStatement = (from, to) => new Promise((resolve, reject) => {
    if (!yAuth || yAuth.readyState !== 1)
      return reject("WebSocket not authorized or not ready.");

    const req = {
      statement: 1,
      limit: 100,
      offset: 0,
      date_from: from,
      date_to: to,
      description: 1
    };

    const listener = ({ data }) => {
      const res = JSON.parse(data);
      if (res.msg_type === 'statement') {
        yAuth.removeEventListener('message', listener);
        resolve(res.statement.transactions || []);
      } else if (res.error) {
        yAuth.removeEventListener('message', listener);
        reject(res.error.message);
      }
    };

    yAuth.addEventListener('message', listener);
    yAuth.send(JSON.stringify(req));
  });

  const load = async (fromDate, toDate) => {
    showLoading();
    const from = Math.floor(new Date(fromDate).getTime() / 1000);
    const to = Math.floor(new Date(toDate).getTime() / 1000);
    try {
      const data = await fetchStatement(from, to);
      render(data);
    } catch (err) {
      showError(err);
    }
  };

  const loadLastWeek = () => {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const weekAgo = new Date();
  weekAgo.setDate(tomorrow.getDate() - 7); // 7 days before tomorrow
  const fromStr = weekAgo.toISOString().split("T")[0];
  const toStr = tomorrow.toISOString().split("T")[0];
  startInput.value = fromStr;
  endInput.value = toStr;
  load(fromStr, toStr);
};


  const attachHandlers = () => {
    applyBtn?.addEventListener("click", () => {
      const from = startInput.value;
      const to = endInput.value;
      if (!from || !to || new Date(from) > new Date(to)) {
        showError("⚠️ Invalid date range.");
      } else {
        load(from, to);
      }
    });
  };

  return {
    init: () => {
      attachHandlers();
      const waitUntilAuth = setInterval(() => {
        if (yAuth && yAuth.readyState === 1) {
          clearInterval(waitUntilAuth);
          loadLastWeek();
        }
      }, 500);
    },
    load,
    loadLastWeek
  };
})();

export default HistoryModel;
