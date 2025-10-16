// ==============================
// Trading Platform - Combined JS
// ==============================

// Global variables and utilities
const $ = id => document.getElementById(id);
let yAuth = null;
let xAuth = new WebSocket("wss://ws.derivws.com/websockets/v3?app_id=1089");
let transactions = [];
let loadingInterval;

// Utility functions
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

// Trading functions (from f.js)
function sendProposal({ symbol, amount, contract_type }) {
  if (!yAuth || yAuth.readyState !== 1) return console.warn('yAuth not ready');

  const proposal = {
    proposal: 1,
    amount,
    basis: 'stake',
    contract_type,
    currency: 'USD',
    duration: 1,
    duration_unit: 't',
    symbol,
  };

  yAuth.send(JSON.stringify(proposal));
}

function buyContract(proposalId, price = 1) {
  if (!yAuth || yAuth.readyState !== 1) return;

  yAuth.send(JSON.stringify({
    buy: proposalId,
    price,
  }));
}

function sellContract(contractId) {
  if (!yAuth || yAuth.readyState !== 1) return;

  yAuth.send(JSON.stringify({
    sell: contractId,
    price: 0, // will auto-calculate market price
  }));
}

function getPortfolio() {
  if (!yAuth || yAuth.readyState !== 1) return;

  yAuth.send(JSON.stringify({ portfolio: 1 }));
}

function cancelAll() {
  if (!yAuth || yAuth.readyState !== 1) return;

  yAuth.send(JSON.stringify({ sell_expired: 1 }));
}

function fullScreen(el, toggle = null, iconEl = null) {
  const isActive = el.dataset.fullscreen === "true";

  // Auto-detect if toggle isn't specified
  toggle = toggle ?? !isActive;

  // Create/reuse overlay
  let overlay = document.getElementById("fullscreen-overlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "fullscreen-overlay";
    Object.assign(overlay.style, {
      position: "fixed",
      top: 0, left: 0,
      width: "100vw",
      height: "100vh",
      background: "rgba(0,0,0,0.6)",
      opacity: 0,
      zIndex: 9998,
      transition: "opacity 0.4s ease",
      pointerEvents: "none"
    });
    document.body.appendChild(overlay);
  }

  if (toggle) {
    // Save original style
    const r = el.getBoundingClientRect();
    el.dataset.fullscreen = "true";
    el.dataset.originalStyle = el.getAttribute("style") || "";

    // Hide all other UI except footer
    document.querySelectorAll("header, section.user-header, .risk-entry, .login-card, .toast, .fab-bar ~ *:not(footer)")
      .forEach(e => e.classList.add("hidden"));

    // Apply initial transform state
    Object.assign(el.style, {
      transition: "all 0.4s ease",
      transform: "scale(1)",
      position: "fixed",
      top: `${r.top}px`,
      left: `${r.left}px`,
      width: `${r.width}px`,
      height: `${r.height}px`,
      zIndex: 9999,
      background: "#000",
      boxShadow: "0 0 40px rgba(0,0,0,0.6)"
    });

    requestAnimationFrame(() => {
      Object.assign(el.style, {
        top: "0",
        left: "0",
        width: "100vw",
        height: "100vh",
        transform: "scale(1.01)"
      });
      overlay.style.opacity = "1";
    });

    // Update icon (if provided)
    if (iconEl) iconEl.textContent = "fullscreen_exit";

  } else {
    el.dataset.fullscreen = "false";
    el.style.transition = "all 0.4s ease";
    el.style.transform = "scale(0.98)";
    overlay.style.opacity = "0";

    // Restore original size then revert style
    setTimeout(() => {
      const original = el.dataset.originalStyle || "";
      el.removeAttribute("style");
      if (original) el.setAttribute("style", original);

      document.querySelectorAll(".hidden").forEach(e => e.classList.remove("hidden"));
    }, 400);

    if (iconEl) iconEl.textContent = "fullscreen";
  }
}

const showToast = (msg) => {
  const toast = $('toast');
  if (toast) {
    toast.textContent = msg;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 3000);
  }
};

// Socket functions (from sockets.js)
const loginBtn = $("login-btn");
const apiKeyInput = $("api-key");

const initYAuth = (token, appId, button) => {
  if (yAuth && yAuth.readyState !== WebSocket.CLOSED) {
    yAuth.close(); // Reset old socket
  }

  yAuth = new WebSocket(`wss://ws.derivws.com/websockets/v3?app_id=${appId}`);

  yAuth.onopen = () =>
    yAuth.send(JSON.stringify({ authorize: token }));

  yAuth.onmessage = ({ data }) => {
    const res = JSON.parse(data);
    const type = res.msg_type;

    if (res.error) {
      stopLoading(button, "Retry");
      showToast("❌ Auth Error: " + res.error.message);
      yAuth.close();
      yAuth = null;
      return;
    }

    if (type === "authorize") {
      stopLoading(button, "✔ Success");
      setDetails(res.authorize);

      // Subscribe to balance + transactions
      yAuth.send(JSON.stringify({ balance: 1, subscribe: 1 }));
      yAuth.send(JSON.stringify({ transaction: 1, subscribe: 1 }));

      // After 1s reload with ?key=APIKEY
      setTimeout(() => {
        const APIKey = token;
        const url = new URL(window.location.href);
        if (url.searchParams.get("key") !== APIKey) {
          window.location.href = `${window.location.origin}${window.location.pathname}?key=${APIKey}`;
        }
      }, 1000);
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

    if (type === "proposal") {
      yAuth.send(JSON.stringify({
        buy: res.proposal.id,
        price: 1
      }));
    }
  };

  yAuth.onerror = () => stopLoading(button, "Retry");
  yAuth.onclose = () => console.warn("[yAuth] Closed. Will reconnect on next login.");
};

function setDetails(details) {
  const nameEl = document.querySelector(".user-name");
  if (nameEl) nameEl.innerHTML = details.fullname || "Unnamed User";
  const emailEl = document.querySelector(".user-email");
  if (emailEl) emailEl.innerHTML = details.email || "No Email";
  const idEl = document.querySelector(".user-id");
  if (idEl) idEl.innerHTML = `Account: ${details.loginid}`;
  const balanceEl = document.querySelector("#acct-bal");
  if (balanceEl) {
    const symbol = getCurrencySymbol(details.currency);
    balanceEl.innerHTML = `${symbol}${(+details.balance).toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
  }
}

// TradingChart class (from chart.js)
class TradingChart {
  // Private class fields
  #socket;
  #chart;
  #candleSeries;
  #indicatorSeries;
  #ghostSeries;
  #symbol;
  #loaderElement;
  #chartElement;
  #ghostCandle = null;

  #data = [];
  #indicatorData = [];
  #earliestTime = Math.floor(Date.now() / 1000);
  #isLoading = false;
  #isHistoryFullyLoaded = false;
  #rangeDebounceTimer = null;
  #subscriptionId = null;
  #currentTheme = 'dark';
  
  // Markov prediction properties
  #markovCounts = {};
  #lastCandles = [];
  #markovTrained = false;

  // Configuration
  static CONFIG = {
    maxCandles: 5000,
    requestCooldown: 500,
    granularity: 60,
    indicatorPeriod: 20,
    volatilityThreshold: 0.015,
    momentumThreshold: 0.008,
    ghostCandleOptions: {
      upColor: 'rgba(100, 184, 255, 0.4)',
      downColor: 'rgba(100, 184, 255, 0.4)',
      wickUpColor: 'rgba(100, 184, 255, 0.7)',
      wickDownColor: 'rgba(100, 184, 255, 0.7)',
      borderUpColor: 'rgba(100, 184, 255, 0.7)',
      borderDownColor: 'rgba(100, 184, 255, 0.7)',
    },
    themes: {
      dark: {
        chartOptions: { 
          layout: { background: { color: 'transparent' }, textColor: '#EEE' },
          grid: { vertLines: { color: '#2c2c3c' }, horzLines: { color: '#2c2c3c' } },
          timeScale: { timeVisible: true, secondsVisible: false },
          crossHair: { mode: 0 }
        },
        seriesOptions: {
          wickUpColor: '#10B981',
          upColor: '#10B981',
          wickDownColor: '#EF4444',
          downColor: '#EF4444',
          borderVisible: false
        },
        indicatorColors: {
          bullishStrong: '#10B981',
          bullishNeutral: '#059669',
          bullishWeak: '#065F46',
          bearishStrong: '#EF4444',
          bearishNeutral: '#DC2626',
          bearishWeak: '#7F1D1D',
          neutral: '#4B5563'
        }
      },
      light: {
        chartOptions: {
          layout: { 
            background: { 
              type: 'vertical-gradient',
              topColor: '#F9FAFB',
              bottomColor: 'rgba(249, 250, 251, 0.3)',
            },
            textColor: '#1F2937',
            fontSize: 12,
            fontFamily: 'Roboto, sans-serif'
          },
          grid: {
            horzLines: { color: '#E5E7EB', style: 2 },
            vertLines: { visible: false }
          },
          priceScale: { 
            autoScale: true,
            borderColor: '#D1D5DB',
            mode: LightweightCharts.PriceScaleMode.Normal
          },
          timeScale: {
            borderColor: '#D1D5DB',
            rightBarStaysOnScroll: true
          },
          crosshair: {
            mode: LightweightCharts.CrosshairMode.MagnetOHLC,
            vertLine: { 
              width: 1,
              color: '#6B728066',
              labelBackgroundColor: '#E5E7EB'
            },
            horzLine: { labelVisible: false }
          },
          watermark: {
            visible: true,
            text: `StepIndex • MTW Indicator`,
            fontSize: 14,
            color: 'rgba(100, 110, 140, 0.5)',
            horzAlign: 'right'
          }
        },
        seriesOptions: {
          wickUpColor: '#059669',
          upColor: '#059669',
          wickDownColor: '#DC2626',
          downColor: '#DC2626',
          borderVisible: false
        },
        indicatorColors: {
          bullishStrong: '#059669',
          bullishNeutral: '#047857',
          bullishWeak: '#065F46',
          bearishStrong: '#DC2626',
          bearishNeutral: '#B91C1C',
          bearishWeak: '#7F1D1D',
          neutral: '#6B7280'
        }
      }
    }
  };

  constructor(chartElementId, socket, options = {}) {
    this.#chartElement = document.getElementById(chartElementId);
    if (!this.#chartElement) {
      throw new Error(`Chart container element with ID "${chartElementId}" not found.`);
    }

    this.#socket = socket;
    this.options = { ...TradingChart.CONFIG, ...options };
    this.#symbol = this.options.symbol;

    if (!this.#symbol) {
      throw new Error('The "symbol" option is required for the TradingChart.');
    }

    this.#createLoader();
    this.#initializeChart();
    this.#attachHandlers();

    new ResizeObserver(() => this.#chart.timeScale().fitContent()).observe(this.#chartElement);
  }

  // Private Methods
  #createLoader() {
    this.#loaderElement = document.createElement('div');
    this.#loaderElement.id = `${this.#chartElement.id}-loader`;
    this.#loaderElement.style.cssText = `
      position: absolute; top: 50%; left: 50%;
      transform: translate(-50%, -50%);
      border: 4px solid rgba(156, 163, 175, 0.3);
      border-top: 4px solid #6B7280;
      border-radius: 50%;
      width: 40px; height: 40px;
      animation: spin 1s linear infinite; z-index: 10;
      display: none;
    `;
    this.#chartElement.style.position = 'relative';
    this.#chartElement.appendChild(this.#loaderElement);

    const spinnerStyleId = 'trading-chart-spinner-style';
    if (!document.getElementById(spinnerStyleId)) {
      const style = document.createElement('style');
      style.id = spinnerStyleId;
      style.innerHTML = `@keyframes spin {
        0% { transform: translate(-50%, -50%) rotate(0deg); }
        100% { transform: translate(-50%, -50%) rotate(360deg); }
      }`;
      document.head.appendChild(style);
    }
  }

  #initializeChart() {
    const theme = this.options.themes.dark;
    this.#chart = LightweightCharts.createChart(this.#chartElement, theme.chartOptions);
    this.#candleSeries = this.#chart.addCandlestickSeries(theme.seriesOptions);
    this.#indicatorSeries = this.#chart.addLineSeries({
      color: 'transparent',
      lineWidth: 2,
      lastValueVisible: false,
      priceLineVisible: false,
      crosshairMarkerVisible: true,
    });
    this.#ghostSeries = this.#chart.addCandlestickSeries(TradingChart.CONFIG.ghostCandleOptions);
    this.setTheme('dark');
  }

  #attachHandlers() {
    this.#socket.onmessage = this.#handleMessage;
    this.#socket.onopen = this.#handleOpen;
    this.#socket.onclose = this.#handleClose;
    this.#socket.onerror = this.#handleError;
    this.#chart.timeScale().subscribeVisibleTimeRangeChange(this.#handleTimeRangeChange);
  }

  // Event Handlers
  #handleOpen = () => {
    this.#loadHistory();
    this.#subscribeToTicks();
  };

  #handleClose = () => this.#setLoadingState(false);
  #handleError = (err) => {
    console.error('WebSocket Error:', err);
    this.#setLoadingState(false);
  };

  #handleMessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg?.error) {
        console.error('API Error:', msg.error.message);
        this.#setLoadingState(false);
        return;
      }

      switch (msg?.msg_type) {
        case 'candles': this.#processCandles(msg.candles, msg.subscription?.id); break;
        case 'tick': if (msg.tick?.symbol === this.#symbol) this.#updateWithTick(msg.tick); break;
      }
    } catch (error) {
      console.error('Failed to parse incoming JSON:', error);
      this.#setLoadingState(false);
    }
  };

  #handleTimeRangeChange = () => {
    if (this.#isLoading || this.#isHistoryFullyLoaded) return;
    const visibleRange = this.#chart.timeScale().getVisibleLogicalRange();
    if (visibleRange !== null && visibleRange.from < 50) {
      clearTimeout(this.#rangeDebounceTimer);
      this.#rangeDebounceTimer = setTimeout(
        () => this.#loadHistory(this.#earliestTime),
        this.options.requestCooldown
      );
    }
  };

  // Markov Prediction Methods
  #getCandleShape(candle) {
    if (candle.close > candle.open) return "G"; // Bullish
    if (candle.close < candle.open) return "R"; // Bearish
    return "D"; // Doji
  }

  #analyzeCandles(candles) {
    for (let i = 0; i < candles.length - 5; i++) {
      const seq = [
        this.#getCandleShape(candles[i]),
        this.#getCandleShape(candles[i + 1]),
        this.#getCandleShape(candles[i + 2]),
        this.#getCandleShape(candles[i + 3]),
        this.#getCandleShape(candles[i + 4]),
      ].join("");
      const nextC = this.#getCandleShape(candles[i + 5]);

      if (!this.#markovCounts[seq]) this.#markovCounts[seq] = { G: 0, R: 0, D: 0 };
      this.#markovCounts[seq][nextC]++;

      this.#lastCandles = seq.split("");
    }
    
    if (Object.keys(this.#markovCounts).length > 0) {
      this.#markovTrained = true;
      console.log("Markov model trained with", Object.keys(this.#markovCounts).length, "patterns");
    }
  }

  #predictNext() {
    if (this.#lastCandles.length !== 5 || !this.#markovTrained) return null;
    const seq = this.#lastCandles.join("");
    const counts = this.#markovCounts[seq];
    if (!counts) return null; // unseen sequence

    // pick the color with highest probability
    const prediction = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
    console.log(`Markov prediction: Sequence ${seq} → ${prediction}`);
    return prediction;
  }

  // Data Processing
  #processCandles = (candles, subscriptionId) => {
    if (!candles || !candles.length) {
      this.#isHistoryFullyLoaded = true;
      this.#setLoadingState(false);
      return;
    }

    this.#earliestTime = Math.min(this.#earliestTime, candles[0].epoch);
    const candleMap = new Map(this.#data.map(c => [c.time, c]));
    candles.forEach(c => candleMap.set(c.epoch, { time: c.epoch, ...c }));

    this.#data = Array.from(candleMap.values()).sort((a, b) => a.time - b.time);
    if (this.#data.length > this.options.maxCandles) {
      this.#data = this.#data.slice(-this.options.maxCandles);
    }

    // Train Markov model with historical data
    this.#analyzeCandles(this.#data);

    this.#candleSeries.setData(this.#data);
    this.#calculateIndicator(true);
    this.#updateGhostCandle();

    if (subscriptionId) this.#subscriptionId = subscriptionId;
    this.#setLoadingState(false);
  };

  #updateWithTick = (tick) => {
    if (typeof tick.quote !== 'number' || !this.#data.length) return;

    const time = Math.floor(tick.epoch / this.options.granularity) * this.options.granularity;
    let lastCandle = this.#data[this.#data.length - 1];

    if (lastCandle?.time === time) {
      lastCandle.high = Math.max(lastCandle.high, tick.quote);
      lastCandle.low = Math.min(lastCandle.low, tick.quote);
      lastCandle.close = tick.quote;
      this.#candleSeries.update(lastCandle);
    } else {
      const newCandle = {
        time,
        open: lastCandle ? lastCandle.close : tick.quote,
        high: tick.quote,
        low: tick.quote,
        close: tick.quote,
      };
      this.#data.push(newCandle);
      this.#candleSeries.update(newCandle);

      // Update Markov sequence with new candle
      if (this.#data.length >= 5) {
        const newShape = this.#getCandleShape(newCandle);
        if (this.#lastCandles.length === 5) {
          this.#lastCandles.shift();
          this.#lastCandles.push(newShape);
        } else if (this.#data.length >= 5) {
          // Build initial sequence if we have enough data
          this.#lastCandles = this.#data.slice(-5).map(c => this.#getCandleShape(c));
        }
      }

      if (this.#data.length > this.options.maxCandles) {
        this.#data.shift();
        this.#indicatorData.shift();
      }
    }
    this.#calculateIndicator();
    this.#updateGhostCandle();
  };

  // Indicator Calculation
  #calculateIndicator(fullRecalculate = false) {
    const period = this.options.indicatorPeriod;
    if (this.#data.length < period) return;

    if (fullRecalculate) {
      this.#indicatorData = new Array(this.#data.length);
    }

    const processPoint = (i) => {
      if (i < period - 1) return null;
      const slice = this.#data.slice(i - period + 1, i + 1);
      const closes = slice.map(c => c.close);
      const sma = closes.reduce((sum, val) => sum + val, 0) / period;
      
      const roc = (closes[period - 1] - closes[0]) / closes[0];
      const momentum = Math.abs(roc) > this.options.momentumThreshold 
        ? (roc > 0 ? 'strong' : 'weak') 
        : 'neutral';

      const mean = sma;
      const variance = closes.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / period;
      const stdDev = Math.sqrt(variance);
      const volatility = stdDev / mean > this.options.volatilityThreshold ? 'high' : 'low';

      let trend = 'neutral';
      if (i >= period) {
        const prevSlice = this.#data.slice(i - period, i);
        const prevSma = prevSlice.reduce((sum, c) => sum + c.close, 0) / period;
        trend = sma > prevSma ? 'bullish' : 'bearish';
      }

      const lineWidth = volatility === 'high' ? 3 : 1;
      let color;
      
      switch (`${trend}-${momentum}`) {
        case 'bullish-strong': color = '#4ade80'; break;
        case 'bullish-neutral': color = '#22c55e'; break;
        case 'bullish-weak': color = '#14532d'; break;
        case 'bearish-strong': color = '#f87171'; break;
        case 'bearish-neutral': color = '#ef4444'; break;
        case 'bearish-weak': color = '#7f1d1d'; break;
        default: color = '#94a3b8';
      }

      return { 
        time: this.#data[i].time, 
        value: sma,
        color,
        lineWidth
      };
    };

    if (fullRecalculate) {
      for (let i = period - 1; i < this.#data.length; i++) {
        const point = processPoint(i);
        if (point) this.#indicatorData[i] = point;
      }
      this.#indicatorSeries.setData(this.#indicatorData.filter(p => p));
    } else {
      const i = this.#data.length - 1;
      if (i >= period - 1) {
        const point = processPoint(i);
        if (point) {
          this.#indicatorData[i] = point;
          this.#indicatorSeries.update(point);
        }
      }
    }
  }

  // Ghost Candle
  async #updateGhostCandle() {
    if (!this.#data.length) return;
    
    try {
      const lastCandle = this.#data[this.#data.length - 1];
      const prediction = this.#predictNext();
      
      let open, high, low, close;
      
      // Default values if no prediction available
      open = (lastCandle.high + lastCandle.low) / 2;
      high = lastCandle.high + 0.3;
      low = lastCandle.low - 0.3;
      close = lastCandle.close;
      
      // Use Markov prediction if available
      if (prediction) {
        const priceRange = lastCandle.high - lastCandle.low;
        const midPrice = (lastCandle.high + lastCandle.low) / 2;
        
        switch (prediction) {
          case 'G': // Bullish
            open = lastCandle.close;
            close = lastCandle.open+0.5 ; // 0.5% increase
            high = lastCandle.high+ 0.4 ; // Additional 0.25% for wick
            low = lastCandle.open -0.2 ; // 0.25% lower wick
            break;
          case 'R': // Bearish
            open = lastCandle.close;
            close = lastCandle.open-0.5; // 0.5% decrease
            high = lastCandle.high-0.4; // 0.25% higher wick
            low = lastCandle.open-0.2; // Additional 0.25% for lower wick
            break;
          case 'D': // Doji
            open = lastCandle.close;
            close = lastCandle.open;
            high = lastCandle.open * 1.005; // 0.5% higher
            low = lastCandle.open * 0.995; // 0.5% lower
            break;
        }
      }
      
      this.#ghostCandle = {
        time: lastCandle.time + this.options.granularity,
        open: open,
        high: high,
        low: low,
        close: close
      };
      
      this.#ghostSeries.setData([this.#ghostCandle]);
    } catch (error) {
      console.error('Ghost candle update failed:', error);
    }
  }

  // API Communication
  #subscribeToTicks = () => {
    if (this.#socket.readyState === WebSocket.OPEN) {
      this.#socket.send(JSON.stringify({ ticks: this.#symbol, subscribe: 1 }));
    }
  };

  #unsubscribeFromTicks = () => {
    if (this.#subscriptionId && this.#socket.readyState === WebSocket.OPEN) {
      this.#socket.send(JSON.stringify({ forget: this.#subscriptionId }));
    }
    this.#subscriptionId = null;
  };

  #loadHistory = (end = 'latest') => {
    if (this.#isLoading || this.#socket.readyState !== WebSocket.OPEN) return;
    this.#setLoadingState(true);

    this.#socket.send(JSON.stringify({
      ticks_history: this.#symbol,
      style: 'candles',
      adjust_start_time: 1,
      count: 500,
      granularity: this.options.granularity,
      end: end,
    }));
  };

  #setLoadingState = (isLoading) => {
    this.#isLoading = isLoading;
    this.#loaderElement.style.display = isLoading ? 'block' : 'none';
  };

  // Public API
  setTimeframe(newGranularity) {
    if (this.#isLoading || this.options.granularity === newGranularity) return;

    this.#setLoadingState(true);
    this.#unsubscribeFromTicks();

    this.options.granularity = newGranularity;
    this.#data = [];
    this.#indicatorData = [];
    this.#candleSeries.setData([]);
    this.#indicatorSeries.setData([]);
    this.#ghostSeries.setData([]);
    this.#ghostCandle = null;
    this.#earliestTime = Math.floor(Date.now() / 1000);
    this.#isHistoryFullyLoaded = false;
    
    // Reset Markov model
    this.#markovCounts = {};
    this.#lastCandles = [];
    this.#markovTrained = false;

    this.#loadHistory();
    this.#subscribeToTicks();
  }
  
  setTheme(themeName) {
    const theme = this.options.themes[themeName];
    if (!theme) {
      console.error(`Theme "${themeName}" not found.`);
      return;
    }
    this.#chart.applyOptions(theme.chartOptions);
    this.#candleSeries.applyOptions(theme.seriesOptions);
    this.#ghostSeries.applyOptions(TradingChart.CONFIG.ghostCandleOptions);
    this.#currentTheme = themeName;
  }

  toggleTheme() {
    this.setTheme(this.#currentTheme === 'dark' ? 'light' : 'dark');
  }

  getChart() {
    return this.#chart;
  }

  destroy() {
    this.#unsubscribeFromTicks();
    clearTimeout(this.#rangeDebounceTimer);
    
    this.#socket.onmessage = null;
    this.#socket.onopen = null;
    this.#socket.onerror = null;
    this.#socket.onclose = null;
    
    this.#chart.timeScale().unsubscribeVisibleTimeRangeChange(this.#handleTimeRangeChange);
    this.#chart.remove();
    this.#loaderElement.remove();

    this.#data = [];
    this.#indicatorData = [];
    this.#ghostCandle = null;
    
    // Clean up Markov data
    this.#markovCounts = {};
    this.#lastCandles = [];
    this.#markovTrained = false;

    const spinnerStyle = document.getElementById('trading-chart-spinner-style');
    if (spinnerStyle) spinnerStyle.remove();
  }
}

// HistoryModel (from historyModel.js)
const HistoryModel = (() => {
  // Setup CSS styles with glassmorphism and profit/loss highlights
  const setupStyles = () => {
    const style = document.createElement('style');
    style.textContent = `
      :root {
        --crimson: #ff6b6b;
        --limegreen: #51cf66;
        --royalblue: #339af0;
      }

      .history-container {
        width: 100%;
        max-width: 1000px;
        margin: 20px auto;
        padding: 0 15px;
      }

      .history-controls {
        display: flex;
        gap: 15px;
        margin-bottom: 20px;
        flex-wrap: wrap;
        align-items: center;
      }

      .date-input {
        padding: 10px 15px;
        border: none;
        border-radius: 8px;
        background: rgba(255, 255, 255, 0.1);
        backdrop-filter: blur(10px);
        color: #fff;
        font-size: 0.9rem;
      }

      .apply-btn {
        padding: 10px 20px;
        background: linear-gradient(90deg, #4facfe, #00f2fe);
        border: none;
        border-radius: 8px;
        color: white;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.3s ease;
      }

      .apply-btn:hover {
        transform: translateY(-2px);
        box-shadow: 0 6px 12px rgba(0, 0, 0, 0.15);
      }

      .history-summary {
        background: var(--glass-bg);
        backdrop-filter: blur(10px);
        border: 1px solid var(--glass-border);
        color: white;
        padding: 15px;
        margin-bottom: 20px;
        border-radius: 12px;
        text-align: left;
        font-size: 0.95rem;
        font-weight: 500;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.1);
      }

      .history-card {
        background: var(--glass-bg);
        backdrop-filter: blur(10px);
        border: 1px solid var(--glass-border);
        border-radius: 12px;
        margin: 15px 0;
        padding: 20px;
        display: flex;
        justify-content: space-between;
        align-items: center;
        transition: all 0.3s ease;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.1);
      }

      .history-card:hover {
        transform: translateY(-5px);
        box-shadow: 0 12px 36px rgba(0, 0, 0, 0.15);
      }

      .history-title {
        font-weight: 600;
        font-size: 1.1rem;
        color: white;
        margin-bottom: 8px;
      }

      .history-desc {
        font-size: 0.9rem;
        color: rgba(255, 255, 255, 0.8);
        line-height: 1.5;
      }

      .profit-positive {
        color: var(--limegreen);
        font-weight: bold;
        font-size: 1.2rem;
        text-shadow: 0 0 6px rgba(81, 207, 102, 0.5);
      }

      .profit-negative {
        color: var(--crimson);
        font-weight: bold;
        font-size: 1.2rem;
        text-shadow: 0 0 6px rgba(255, 107, 107, 0.5);
      }

      .empty, .error {
        padding: 20px;
        text-align: center;
        color: rgba(255, 255, 255, 0.7);
        background: var(--glass-bg);
        backdrop-filter: blur(10px);
        border-radius: 12px;
        margin: 20px 0;
      }

      .loading-spinner {
        margin: 30px auto;
        border: 4px solid rgba(255, 255, 255, 0.1);
        border-top: 4px solid var(--royalblue);
        border-radius: 50%;
        width: 40px;
        height: 40px;
        animation: spin 1s linear infinite;
      }

      @keyframes spin {
        0% { transform: rotate(0deg); }
        100% { transform: rotate(360deg); }
      }

      .stats-highlight {
        background: linear-gradient(90deg, #4facfe, #00f2fe);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
        font-weight: 700;
      }

      .last-updated {
        text-align: left;
        color: rgba(255, 255, 255, 0.6);
        font-size: 0.85rem;
        margin-top: 10px;
      }
    `;
    document.head.appendChild(style);
  };

  setupStyles();

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

  const render = txns => {
    if (!txns.length) {
      return show('<p class="empty">No trades found in this period.</p>');
    }

    let totalProfit = 0;
    let wins = 0, losses = 0;

    const cards = txns.map(tx => {
      const entry = parseFloat(tx.buy_price) || 0;
      const exit = tx.sell_price ? parseFloat(tx.sell_price) : null;

      // If no sell_price → treat as losing trade
      const profit = exit !== null ? (exit - entry) : -Math.abs(entry);

      totalProfit += profit;
      if (profit >= 0) wins++; else losses++;

      const description = tx.contract_type || tx.shortcode || "Trade";
      const timestamp = tx.purchase_time || tx.transaction_time || Date.now() / 1000;

      return `
        <div class="history-card">
          <div>
            <div class="history-title">${description}</div>
            <div class="history-desc">
              Contract ID: ${tx.contract_id || 'N/A'}<br>
              Date: ${formatDate(timestamp)}
            </div>
          </div>
          <div class="${profit >= 0 ? 'profit-positive' : 'profit-negative'}">
            ${profit >= 0 ? '+' : ''}${profit.toFixed(2)}
          </div>
        </div>
      `;
    }).join('');

    const totalTrades = wins + losses;
    const winRate = totalTrades > 0 ? ((wins / totalTrades) * 100).toFixed(1) : 0;
    const lastUpdated = new Date().toLocaleTimeString();

    const summary = `
      <div class="history-summary">
        <span class="stats-highlight">📊 Trading Performance</span><br><br>
        Total Trades: <span class="stats-highlight">${totalTrades}</span> |
        Wins: <span class="stats-highlight">${wins}</span> |
        Losses: <span class="stats-highlight">${losses}</span> |
        Win Rate: <span class="stats-highlight">${winRate}%</span> |
        Net Profit: <span style="color:${totalProfit >= 0 ? '#51cf66' : '#ff6b6b'}">
          ${totalProfit >= 0 ? '+' : ''}${totalProfit.toFixed(2)}
        </span>
      </div>
      <div class="last-updated">Last updated: ${lastUpdated}</div>
    `;

    show(summary + cards);
  };

  const fetchHistory = (from, to) => new Promise((resolve, reject) => {
    if (!yAuth || yAuth.readyState !== WebSocket.OPEN) {
      return reject("Connection not available");
    }

    const request = {
      profit_table: 1,
      limit: 100,
      date_from: from,
      date_to: to,
      description: 1
    };

    const handleMessage = ({ data }) => {
      try {
        const res = JSON.parse(data);

        if (res.msg_type === 'profit_table') {
          yAuth.removeEventListener('message', handleMessage);
          resolve(res.profit_table?.transactions || []);
        } else if (res.error) {
          yAuth.removeEventListener('message', handleMessage);
          reject(res.error.message || "Unknown error");
        }
      } catch {
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
    return !isNaN(fromDate) && !isNaN(toDate) && fromDate <= toDate;
  };

  const load = async (fromDate, toDate) => {
    showLoading();

    try {
      if (!validateDates(fromDate, toDate)) {
        throw new Error("Invalid date range");
      }

      const from = Math.floor(new Date(fromDate).getTime() / 1000);
      const to = Math.ceil(new Date(toDate).getTime() / 1000) + 86399;

      const data = await fetchHistory(from, to);
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

// Main application code (from main.js)
let chart;

document.addEventListener("DOMContentLoaded", () => {
  // Initialize chart
  chart = new TradingChart('chart', xAuth, { symbol: 'stpRNG' });
  window.chartView = chart;
  window.addEventListener('beforeunload', () => chart.destroy());

  const fab = $('main-fab');
  const fabIcon = $('fabIcon');
  const buyBtn = $('buy-btn');
  const sellBtn = $('sell-btn');
  const risk = $('risk-entry');
  const themeToggle = $('themeToggle');

  // FAB Toggle
  if (fab) {
    fab.onclick = () => {
      if (!yAuth) {
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
      else return showToast("Not Permitted by Admin");

      const proposal = {
        buy: 0,
        price: 0,
        parameters: {
          amount: 1,
          basis: "stake",
          contract_type: "CALL",
          currency: "USD",
          duration: 15,
          duration_unit: "s",
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
      else return showToast("Not Permitted by Admin");

      const proposal = {
        buy: 0,
        price: 0,
        parameters: {
          amount: 1,
          basis: "stake",
          contract_type: "PUT",
          currency: "USD",
          duration: 15,
          duration_unit: "s",
          symbol: "stpRNG"
        }
      };

      yAuth.send(JSON.stringify(proposal));
      showToast("📉 PUT trade placed");
    };
  }

  // HISTORY PANEL
  const historyBtn = $("his-but");
  const historyContainer = $("his-con");

  if (historyBtn && historyContainer) {
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
        HistoryModel.init();
      }, 10);
    });
  }

  // THEME TOGGLE
  if (themeToggle) {
    themeToggle.onclick = () => {
      document.body.classList.toggle('light-theme');
      chart.toggleTheme();
    };
  }

  // Socket connection and login handling
  if (loginBtn) {
    loginBtn.onclick = () => {
      const token = apiKeyInput.value.trim();
      if (!token) return showToast("Please enter your API key.");
      loginBtn.classList.add("loading");
      startLoading(loginBtn);
      initYAuth(token, 1089, loginBtn);
    };
  }

  // Auto-login on page load if ?key=APIKEY is in URL
  const url = new URL(window.location.href);
  const key = url.searchParams.get("key");
  if (key && loginBtn) {
    loginBtn.classList.add("loading");
    startLoading(loginBtn);
    initYAuth(key, 1089, loginBtn);
  }
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
