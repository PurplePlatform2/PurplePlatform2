/**
 * Advanced real-time financial chart with combined momentum/trend indicator
 */
class TradingChart {
    // Private class fields
    #socket;
    #chart;
    #candleSeries;
    #indicatorSeries;
    #symbol;
    #loaderElement;
    #chartElement;

    #data = [];
    #indicatorData = [];
    #earliestTime = Math.floor(Date.now() / 1000);
    #isLoading = false;
    #isHistoryFullyLoaded = false;
    #rangeDebounceTimer = null;
    #subscriptionId = null;

//configuration
static CONFIG = {
    maxCandles: 5000,
    requestCooldown: 500,
    granularity: 60,
    indicatorPeriod: 20,
    volatilityThreshold: 0.015,
    momentumThreshold: 0.008,
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




    /* ExConfiguration
    static CONFIG = {
        maxCandles: 5000,
        requestCooldown: 500,
        granularity: 60,
        indicatorPeriod: 20,
        volatilityThreshold: 0.015,
        momentumThreshold: 0.008,
        themes: {
            dark: {
                chartOptions: {
                    layout: { backgroundColor: '#000000', textColor: '#D1D5DB' },
                    grid: { vertLines: { color: '#374151' }, horzLines: { color: '#374151' } },
                    timeScale: { borderColor: '#374151' },
                },
                seriesOptions: {
                    wickUpColor: '#22c55e',
                    upColor: '#22c55e',
                    wickDownColor: '#ef4444',
                    downColor: '#ef4444',
                    borderVisible: false,
                },
            },
            light: {
                chartOptions: {
                    layout: { backgroundColor: '#FFFFFF', textColor: '#1F2937' },
                    grid: { vertLines: { color: '#E5E7EB' }, horzLines: { color: '#E5E7EB' } },
                    timeScale: { borderColor: '#E5E7EB' },
                },
                seriesOptions: {
                    wickUpColor: '#16a34a',
                    upColor: '#16a34a',
                    wickDownColor: '#dc2626',
                    downColor: '#dc2626',
                    borderVisible: false,
                },
            },
        },
        chartOptions: {
            timeScale: { timeVisible: true, secondsVisible: false },
            crosshair: { mode: 0 },
        },
    };*/

    constructor(chartElementId, socket, options = {}) {
        this.#chartElement = document.getElementById(chartElementId);
        if (!this.#chartElement) {
            const error = new Error(`Chart container element with ID "${chartElementId}" not found.`);
            console.error(error.message);
            throw error;
        }

        this.#socket = socket;
        this.options = { ...TradingChart.CONFIG, ...options };
        this.#symbol = this.options.symbol;

        if (!this.#symbol) {
            const error = new Error('The "symbol" option is required for the TradingChart.');
            console.error(error.message);
            throw error;
        }

        this.#createLoader();
        this.#initializeChart();
        this.#attachHandlers();

        new ResizeObserver(() => this.#chart.timeScale().fitContent()).observe(this.#chartElement);
    }

    // --- Private Methods ---
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
        this.#chart = LightweightCharts.createChart(this.#chartElement);
        this.#candleSeries = this.#chart.addCandlestickSeries(theme.seriesOptions);
        
        // Momentum-Trend Wave Indicator
        this.#indicatorSeries = this.#chart.addLineSeries({
            color: 'transparent', // Handled per-point
            lineWidth: 2,
            lastValueVisible: false,
            priceLineVisible: false,
            crosshairMarkerVisible: true,
        });
        this.setTheme('dark');
    }

    #attachHandlers() {
        this.#socket.onmessage = this.#handleMessage;
        this.#socket.onopen = this.#handleOpen;
        this.#socket.onclose = this.#handleClose;
        this.#socket.onerror = this.#handleError;

        this.#chart.timeScale().subscribeVisibleTimeRangeChange(this.#handleTimeRangeChange);
    }

    // --- Event Handlers ---
    #handleOpen = () => {
        console.log('WebSocket connection established.');
        this.#loadHistory();
        this.#subscribeToTicks();
    };

    #handleClose = () => {
        console.warn('WebSocket connection closed.');
        this.#setLoadingState(false);
    };

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
                case 'candles':
                    this.#processCandles(msg.candles, msg.subscription?.id);
                    break;
                case 'tick':
                    if (msg.tick?.symbol === this.#symbol) {
                        this.#updateWithTick(msg.tick);
                    }
                    break;
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

    // --- Data Processing ---
    #processCandles = (candles, subscriptionId) => {
        if (!candles || candles.length === 0) {
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

        this.#candleSeries.setData(this.#data);
        this.#calculateIndicator(true);

        if (subscriptionId) {
            this.#subscriptionId = subscriptionId;
        }
        this.#setLoadingState(false);
    };

    #updateWithTick = (tick) => {
        if (typeof tick.quote !== 'number' || this.#data.length === 0) return;

        const time = Math.floor(tick.epoch / this.options.granularity) * this.options.granularity;
        let lastCandle = this.#data[this.#data.length - 1];

        if (lastCandle && lastCandle.time === time) {
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

            if (this.#data.length > this.options.maxCandles) {
                this.#data.shift();
                this.#indicatorData.shift();
            }
        }
        this.#calculateIndicator();
    };

    // --- Momentum-Trend Wave Indicator ---
    #calculateIndicator(fullRecalculate = false) {
        const period = this.options.indicatorPeriod;
        const volatilityThreshold = this.options.volatilityThreshold;
        const momentumThreshold = this.options.momentumThreshold;
        
        if (this.#data.length < period) return;

        // Initialize indicator data array
        if (fullRecalculate) {
            this.#indicatorData = new Array(this.#data.length);
        }

        const processPoint = (i) => {
            if (i < period - 1) return null;

            const slice = this.#data.slice(i - period + 1, i + 1);
            const closes = slice.map(c => c.close);
            const sma = closes.reduce((sum, val) => sum + val, 0) / period;
            
            // Calculate momentum (ROC)
            const roc = (closes[period - 1] - closes[0]) / closes[0];
            const momentum = Math.abs(roc) > momentumThreshold 
                ? (roc > 0 ? 'strong' : 'weak') 
                : 'neutral';

            // Calculate volatility
            const mean = sma;
            const variance = closes.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / period;
            const stdDev = Math.sqrt(variance);
            const volatility = stdDev / mean > volatilityThreshold ? 'high' : 'low';

            // Determine trend direction
            let trend = 'neutral';
            if (i >= period) {
                const prevSlice = this.#data.slice(i - period, i);
                const prevSma = prevSlice.reduce((sum, c) => sum + c.close, 0) / period;
                trend = sma > prevSma ? 'bullish' : 'bearish';
            }

            // Generate visual properties
            const lineWidth = volatility === 'high' ? 3 : 1;
            let color;
            
            switch (`${trend}-${momentum}`) {
                case 'bullish-strong': color = '#4ade80'; break;  // Bright green
                case 'bullish-neutral': color = '#22c55e'; break; // Green
                case 'bullish-weak': color = '#14532d'; break;   // Dark green
                case 'bearish-strong': color = '#f87171'; break; // Bright red
                case 'bearish-neutral': color = '#ef4444'; break; // Red
                case 'bearish-weak': color = '#7f1d1d'; break;   // Dark red
                default: color = '#94a3b8';                       // Neutral gray
            }

            return { 
                time: this.#data[i].time, 
                value: sma,
                color,
                lineWidth
            };
        };

        if (fullRecalculate) {
            // Full recalculation
            for (let i = period - 1; i < this.#data.length; i++) {
                const point = processPoint(i);
                if (point) this.#indicatorData[i] = point;
            }
            const validPoints = this.#indicatorData.filter(p => p);
            this.#indicatorSeries.setData(validPoints);
        } else {
            // Incremental update (last point only)
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

    // --- API Communication ---
    #subscribeToTicks = () => {
        if (this.#socket.readyState !== WebSocket.OPEN) return;
        this.#socket.send(JSON.stringify({ ticks: this.#symbol, subscribe: 1 }));
    };

    #unsubscribeFromTicks = () => {
        if (this.#subscriptionId && this.#socket.readyState === WebSocket.OPEN) {
            this.#socket.send(JSON.stringify({ forget: this.#subscriptionId }));
            console.log(`Unsubscribed from ${this.#symbol}`);
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

    // --- Public API ---
    setTimeframe(newGranularity) {
        if (this.#isLoading || this.options.granularity === newGranularity) return;

        console.log(`Changing timeframe to ${newGranularity} seconds.`);
        this.#setLoadingState(true);
        this.#unsubscribeFromTicks();

        // Reset state
        this.options.granularity = newGranularity;
        this.#data = [];
        this.#indicatorData = [];
        this.#candleSeries.setData([]);
        this.#indicatorSeries.setData([]);
        this.#earliestTime = Math.floor(Date.now() / 1000);
        this.#isHistoryFullyLoaded = false;

        this.#loadHistory();
        this.#subscribeToTicks();
    }
    
   #currentTheme = 'dark'; 
setTheme(themeName) {
    const theme = this.options.themes[themeName];
    if (!theme) {
        console.error(`Theme "${themeName}" not found.`);
        return;
    }
    const chartOptions = { ...theme.chartOptions, ...TradingChart.CONFIG.chartOptions };
    this.#chart.applyOptions(chartOptions);
    this.#candleSeries.applyOptions(theme.seriesOptions);
    this.#currentTheme = themeName;
}

    
  toggleTheme() {
    const newTheme = this.currentTheme === 'dark' ? 'light' : 'dark';
    this.setTheme(newTheme);
}

getChart(){
    return this.#chart;
    }
    destroy() {
        console.log(`Destroying chart for symbol ${this.#symbol}`);
        this.#unsubscribeFromTicks();

        // Clear timers and listeners
        clearTimeout(this.#rangeDebounceTimer);
        this.#socket.onmessage = null;
        this.#socket.onopen = null;
        this.#socket.onerror = null;
        this.#socket.onclose = null;
        this.#chart.timeScale().unsubscribeVisibleTimeRangeChange(this.#handleTimeRangeChange);

        // Remove elements
        this.#chart.remove();
        this.#loaderElement.remove();

        // Clear data
        this.#data = [];
        this.#indicatorData = [];
        
        // Remove global styles
        const spinnerStyle = document.getElementById('trading-chart-spinner-style');
        if (spinnerStyle) spinnerStyle.remove();
    }
}

export default TradingChart;
