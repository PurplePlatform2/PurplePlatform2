import { yAuth } from './Sockets.js';

const $ = id => document.getElementById(id);

// Setup CSS color variables for consistent styling
const setupColorVariables = () => {
  const style = document.createElement('style');
  style.textContent = `
    :root {
      /* Red Colors */
      --indianred: #CD5C5C; --lightcoral: #F08080; --salmon: #FA8072; 
      --darksalmon: #E9967A; --crimson: #DC143C; --red: #FF0000;

      /* Green Colors */
      --limegreen: #32CD32; --forestgreen: #228B22; --green: #008000;
      --darkgreen: #006400; --seagreen: #2E8B57; --mediumseagreen: #3CB371;

      /* Additional colors omitted for brevity */
    }

    .negative { color: var(--crimson) !important; }
    .positive { color: var(--limegreen) !important; }
    .aggregated { border-left: 3px solid var(--royalblue); }
  `;
  document.head.appendChild(style);
};

const HistoryModel = (() => {
  setupColorVariables();

  const listContainer = $('history-list');
  const startInput = $('startDate');
  const endInput = $('endDate');
  const applyBtn = $('applyBtn');

  // DOM helpers
  const show = html => listContainer.innerHTML = html;
  const showLoading = () => show('<div class="loading-spinner"></div>');
  const showError = msg => show(`<p class="error">❌ ${msg}</p>`);

  const formatDate = ts => new Date(ts * 1000).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });

  const processTransactions = (txns) => {
    const contractMap = new Map();
    const singles = [];

    txns.forEach(tx => {
      if (!tx.contract_id) {
        singles.push(tx);
        return;
      }

      if (contractMap.has(tx.contract_id)) {
        const existing = contractMap.get(tx.contract_id);
        existing.amount += tx.amount;
        existing.count += 1;
        if (tx.transaction_time > existing.transaction_time) {
          existing.transaction_time = tx.transaction_time;
        }
      } else {
        contractMap.set(tx.contract_id, {
          ...tx,
          count: 1,
          original_description: tx.description
        });
      }
    });

    return [
      ...singles,
      ...Array.from(contractMap.values()).map(item => ({
        ...item,
        description: item.count > 1 
          ? `${item.original_description} (${item.count} trades)` 
          : item.description
      }))
    ];
  };

  const render = txns => {
    if (!txns.length) {
      return show('<p class="empty">No trades found in this period.</p>');
    }

    const processedTxns = processTransactions(txns);
    const cards = processedTxns.map(tx => {
      const isAggregated = tx.count > 1;

      // Corrected description logic
      const description = tx.shortcode.toLowerCase().includes("call") ? "Buy" :
              tx.shortcode.toLowerCase().includes("put") ? "Sell" :
              tx.shortcode;
              

      const contractId = tx.contract_id || 'N/A';
      const timestamp = tx.transaction_time || tx.date || Date.now() / 1000;

      return `
        <div class="history-card ${isAggregated ? 'aggregated' : ''}">
          <div class="history-info">
            <div class="history-title">${description}</div>
            <div class="history-desc">
              Contract ID: ${contractId}
              ${isAggregated ? `<br><small>Aggregated ${tx.count} trades</small>` : ''}
            </div>
          </div>
          <div class="history-meta">
            <div>${formatDate(timestamp)}</div>
            <div class="${tx.amount < 0 ? 'negative' : 'positive'}">
              ${tx.amount < 0 ? '-' : '+'} $${Math.abs(tx.amount).toFixed(2)}
            </div>
          </div>
        </div>
      `;
    }).join('');

    show(cards);
  };

  const fetchStatement = (from, to) => new Promise((resolve, reject) => {
    if (!yAuth || yAuth.readyState !== WebSocket.OPEN) {
      return reject("Connection not available");
    }

    const request = {
      statement: 1,
      limit: 100,
      offset: 0,
      date_from: from,
      date_to: to,
      description: 1
    };

    const handleMessage = ({ data }) => {
      try {
        const res = JSON.parse(data);

        if (res.msg_type === 'statement') {
          yAuth.removeEventListener('message', handleMessage);
          resolve(res.statement?.transactions || []);
        } else if (res.error) {
          yAuth.removeEventListener('message', handleMessage);
          reject(res.error.message || "Unknown error");
        }
      } catch (e) {
        reject("Invalid response format");
      }
    };

    yAuth.addEventListener('message', handleMessage);
    yAuth.send(JSON.stringify(request));

    setTimeout(() => {
      yAuth.removeEventListener('message', handleMessage);
      reject("Request timed out");
    }, 10000);
  });

  const validateDates = (from, to) => {
    const fromDate = new Date(from);
    const toDate = new Date(to);
    return fromDate instanceof Date && 
           toDate instanceof Date && 
           fromDate <= toDate;
  };

  const load = async (fromDate, toDate) => {
    showLoading();

    try {
      if (!validateDates(fromDate, toDate)) {
        throw new Error("Invalid date range");
      }

      const from = Math.floor(new Date(fromDate).getTime() / 1000);
      const to = Math.ceil(new Date(toDate).getTime() / 1000) + 86399;

      const data = await fetchStatement(from, to);
      render(data);
    } catch (err) {
      showError(typeof err === 'string' ? err : err.message);
    }
  };

  const loadLastWeek = () => {
    const today = new Date();
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const weekAgo = new Date(today);
    weekAgo.setDate(weekAgo.getDate() - 6);

    const format = d => d.toISOString().split('T')[0];

    startInput.value = format(weekAgo);
    endInput.value = format(tomorrow);

    load(startInput.value, endInput.value);
  };

  const attachHandlers = () => {
    if (!applyBtn) return;

    applyBtn.addEventListener("click", () => {
      const from = startInput.value;
      const to = endInput.value;

      if (!from || !to) {
        showError("Please select both dates");
        return;
      }

      load(from, to);
    });
  };

  const keepAlive = () => {
    if (!yAuth || yAuth.readyState !== WebSocket.OPEN) return;

    setInterval(() => {
      yAuth.send(JSON.stringify({ ping: 1 }));
    }, 30000);
  };

  const initConnection = () => {
    let retries = 0;
    const maxRetries = 5;

    const tryInit = () => {
      if (yAuth && yAuth.readyState === WebSocket.OPEN) {
        keepAlive();
        loadLastWeek();
      } else if (retries < maxRetries) {
        retries++;
        setTimeout(tryInit, 1000);
      } else {
        showError("Failed to connect to server");
      }
    };

    tryInit();
  };

  return {
    init: () => {
      attachHandlers();
      initConnection();
    },
    refresh: loadLastWeek
  };
})();

export default HistoryModel;
