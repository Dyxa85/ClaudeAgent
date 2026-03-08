/**
 * Market Analyzer
 * Technical indicators + market data from Coinbase
 */

const { CoinbasePaperClient } = require('./coinbase-client');

class MarketAnalyzer {
  constructor(config = {}) {
    this.client = config.liveMode 
      ? new (require('./coinbase-client').CoinbaseMCPClient)(config)
      : new CoinbasePaperClient(config);
    
    this.cache = new Map();
    this.cacheTTL = 30000; // 30 second cache
  }

  async getMarketData(symbol) {
    const cacheKey = symbol;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.cacheTTL) {
      return cached.data;
    }

    try {
      const [ticker, candles1h, candles4h, candles1d] = await Promise.all([
        this.client.getProductTicker(symbol),
        this.client.getCandles(symbol, 'ONE_HOUR', 50),
        this.client.getCandles(symbol, 'FOUR_HOUR', 30),
        this.client.getCandles(symbol, 'ONE_DAY', 14)
      ]);

      const analysis = {
        symbol,
        timestamp: new Date().toISOString(),
        price: ticker.price,
        bid: ticker.bid,
        ask: ticker.ask,
        spread_pct: ((ticker.ask - ticker.bid) / ticker.price * 100).toFixed(4),
        volume_24h: ticker.volume_24h,
        price_change_24h: ticker.price_change_24h,
        
        // Technical indicators (1h)
        indicators_1h: this.calculateIndicators(candles1h),
        
        // Technical indicators (4h)
        indicators_4h: this.calculateIndicators(candles4h),
        
        // Daily trend
        indicators_1d: this.calculateIndicators(candles1d),
        
        // Market regime
        regime: this.detectMarketRegime(candles1h),
        
        // Support/Resistance levels
        levels: this.findKeyLevels(candles1d)
      };

      this.cache.set(cacheKey, { timestamp: Date.now(), data: analysis });
      return analysis;

    } catch (err) {
      // Fallback to simulated data for testing
      return this.getSimulatedMarketData(symbol);
    }
  }

  calculateIndicators(candles) {
    if (!candles || candles.length < 20) return null;
    
    const closes = candles.map(c => c.close);
    const highs = candles.map(c => c.high);
    const lows = candles.map(c => c.low);
    const volumes = candles.map(c => c.volume);

    return {
      rsi_14: this.calculateRSI(closes, 14),
      macd: this.calculateMACD(closes),
      ema_20: this.calculateEMA(closes, 20),
      ema_50: this.calculateEMA(closes, 50),
      bb: this.calculateBollingerBands(closes, 20),
      atr_14: this.calculateATR(highs, lows, closes, 14),
      volume_sma: this.calculateSMA(volumes, 20),
      current_volume: volumes[volumes.length - 1],
      price_vs_ema20: ((closes[closes.length - 1] - this.calculateEMA(closes, 20)) / this.calculateEMA(closes, 20) * 100).toFixed(2)
    };
  }

  calculateRSI(closes, period = 14) {
    if (closes.length < period + 1) return 50;
    
    let gains = 0, losses = 0;
    for (let i = closes.length - period; i < closes.length; i++) {
      const diff = closes[i] - closes[i - 1];
      if (diff >= 0) gains += diff;
      else losses += Math.abs(diff);
    }
    
    const avgGain = gains / period;
    const avgLoss = losses / period;
    if (avgLoss === 0) return 100;
    
    const rs = avgGain / avgLoss;
    return parseFloat((100 - (100 / (1 + rs))).toFixed(2));
  }

  calculateEMA(closes, period) {
    if (closes.length < period) return closes[closes.length - 1];
    
    const multiplier = 2 / (period + 1);
    let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
    
    for (let i = period; i < closes.length; i++) {
      ema = (closes[i] - ema) * multiplier + ema;
    }
    return parseFloat(ema.toFixed(2));
  }

  calculateSMA(values, period) {
    if (values.length < period) return values[values.length - 1];
    const slice = values.slice(-period);
    return parseFloat((slice.reduce((a, b) => a + b, 0) / period).toFixed(2));
  }

  calculateMACD(closes) {
    const ema12 = this.calculateEMA(closes, 12);
    const ema26 = this.calculateEMA(closes, 26);
    const macdLine = ema12 - ema26;
    
    // Signal line (9-period EMA of MACD) - simplified
    const signal = macdLine * 0.85; // Approximation
    const histogram = macdLine - signal;
    
    return {
      macd: parseFloat(macdLine.toFixed(4)),
      signal: parseFloat(signal.toFixed(4)),
      histogram: parseFloat(histogram.toFixed(4)),
      trend: macdLine > 0 ? 'bullish' : 'bearish',
      crossover: histogram > 0 ? 'above_signal' : 'below_signal'
    };
  }

  calculateBollingerBands(closes, period = 20) {
    const sma = this.calculateSMA(closes, period);
    const slice = closes.slice(-period);
    const variance = slice.reduce((sum, v) => sum + Math.pow(v - sma, 2), 0) / period;
    const std = Math.sqrt(variance);
    
    const upper = sma + (2 * std);
    const lower = sma - (2 * std);
    const current = closes[closes.length - 1];
    const bandwidth = ((upper - lower) / sma * 100).toFixed(2);
    const position = ((current - lower) / (upper - lower)).toFixed(2); // 0=lower band, 1=upper band
    
    return {
      upper: parseFloat(upper.toFixed(2)),
      middle: parseFloat(sma.toFixed(2)),
      lower: parseFloat(lower.toFixed(2)),
      bandwidth: parseFloat(bandwidth),
      position: parseFloat(position), // 0.0 to 1.0
      squeeze: parseFloat(bandwidth) < 2 ? true : false
    };
  }

  calculateATR(highs, lows, closes, period = 14) {
    const trs = [];
    for (let i = 1; i < highs.length; i++) {
      const tr = Math.max(
        highs[i] - lows[i],
        Math.abs(highs[i] - closes[i - 1]),
        Math.abs(lows[i] - closes[i - 1])
      );
      trs.push(tr);
    }
    
    const atr = this.calculateSMA(trs, period);
    const currentPrice = closes[closes.length - 1];
    
    return {
      value: parseFloat(atr.toFixed(4)),
      pct: parseFloat((atr / currentPrice * 100).toFixed(2)) // ATR as % of price
    };
  }

  detectMarketRegime(candles) {
    if (!candles || candles.length < 20) return 'unknown';
    
    const closes = candles.map(c => c.close);
    const recent = closes.slice(-10);
    const older = closes.slice(-20, -10);
    
    const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
    const olderAvg = older.reduce((a, b) => a + b, 0) / older.length;
    
    const trend = (recentAvg - olderAvg) / olderAvg;
    
    // Volatility
    const returns = closes.slice(-20).map((c, i, arr) => i > 0 ? (c - arr[i-1]) / arr[i-1] : 0).slice(1);
    const variance = returns.reduce((sum, r) => sum + r * r, 0) / returns.length;
    const volatility = Math.sqrt(variance) * Math.sqrt(252); // Annualized
    
    if (volatility > 1.0) return 'high_volatility';
    if (trend > 0.03) return 'uptrend';
    if (trend < -0.03) return 'downtrend';
    return 'sideways';
  }

  findKeyLevels(candles) {
    if (!candles || candles.length < 5) return {};
    
    const highs = candles.map(c => c.high);
    const lows = candles.map(c => c.low);
    const current = candles[candles.length - 1].close;
    
    return {
      resistance: parseFloat(Math.max(...highs).toFixed(2)),
      support: parseFloat(Math.min(...lows).toFixed(2)),
      recent_high: parseFloat(Math.max(...highs.slice(-5)).toFixed(2)),
      recent_low: parseFloat(Math.min(...lows.slice(-5)).toFixed(2)),
      distance_to_resistance_pct: parseFloat(((Math.max(...highs.slice(-5)) - current) / current * 100).toFixed(2)),
      distance_to_support_pct: parseFloat(((current - Math.min(...lows.slice(-5))) / current * 100).toFixed(2))
    };
  }

  // Simulated market data for testing without API
  getSimulatedMarketData(symbol) {
    const basePrices = { 'BTC-USD': 65000, 'ETH-USD': 3200, 'SOL-USD': 145 };
    const base = basePrices[symbol] || 100;
    const noise = (Math.random() - 0.5) * 0.02;
    const price = base * (1 + noise);

    return {
      symbol,
      timestamp: new Date().toISOString(),
      price,
      bid: price * 0.9995,
      ask: price * 1.0005,
      spread_pct: '0.1000',
      volume_24h: Math.random() * 1000000,
      price_change_24h: ((Math.random() - 0.5) * 10).toFixed(2),
      indicators_1h: {
        rsi_14: 30 + Math.random() * 40,
        macd: { trend: Math.random() > 0.5 ? 'bullish' : 'bearish', histogram: (Math.random() - 0.5) * 100 },
        ema_20: price * (1 + (Math.random() - 0.5) * 0.01),
        bb: { position: Math.random(), squeeze: Math.random() > 0.8 },
        atr_14: { pct: 1 + Math.random() * 3 }
      },
      regime: ['uptrend', 'downtrend', 'sideways'][Math.floor(Math.random() * 3)],
      levels: {
        resistance: price * 1.05,
        support: price * 0.95,
        distance_to_resistance_pct: 5,
        distance_to_support_pct: 5
      },
      _simulated: true
    };
  }
}

module.exports = { MarketAnalyzer };
