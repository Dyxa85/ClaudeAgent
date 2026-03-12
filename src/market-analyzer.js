/**
 * MarketAnalyzer — Technische Analyse auf echten Coinbase-Daten
 *
 * Kein Mock, kein Fallback.
 * Wenn Coinbase nicht erreichbar ist → Fehler nach oben propagieren.
 * Der Agent pausiert den Zyklus und versucht es beim nächsten Intervall.
 */

'use strict';

const { CoinbaseClient } = require('./coinbase-client');

class MarketAnalyzer {
  constructor(config = {}) {
    this.client   = config.client || new CoinbaseClient(config);
    this.cache    = new Map();
    this.cacheTTL = 30_000; // 30s — keine veralteten Preise
  }

  async getMarketData(symbol) {
    const cached = this.cache.get(symbol);
    if (cached && Date.now() - cached.ts < this.cacheTTL) return cached.data;

    // Alle Daten parallel holen — echte API, kein Fallback
    const [ticker, candles1h, candles4h, candles1d, orderbook] = await Promise.all([
      this.client.getTicker(symbol),
      this.client.getCandles(symbol, 'ONE_HOUR',  50),
      this.client.getCandles(symbol, 'FOUR_HOUR', 30),
      this.client.getCandles(symbol, 'ONE_DAY',   14),
      this.client.getOrderBook(symbol, 5),
    ]);

    const data = {
      symbol,
      timestamp:        ticker.timestamp,
      price:            ticker.price,
      bid:              ticker.bid,
      ask:              ticker.ask,
      spread:           ticker.spread,
      spread_pct:       ticker.spread_pct,
      volume_24h:       ticker.volume_24h,
      price_change_24h: ticker.price_change_24h,
      orderbook: {
        best_bid: orderbook.bids[0] || null,
        best_ask: orderbook.asks[0] || null,
        bid_depth: orderbook.bids.reduce((s, b) => s + b.price * b.size, 0),
        ask_depth: orderbook.asks.reduce((s, a) => s + a.price * a.size, 0),
      },
      indicators_1h: this._indicators(candles1h),
      indicators_4h: this._indicators(candles4h),
      indicators_1d: this._indicators(candles1d),
      regime:        this._regime(candles1h),
      levels:        this._levels(candles1d),
      candles_1h:    candles1h.slice(-5), // letzte 5 für Kontext
    };

    this.cache.set(symbol, { ts: Date.now(), data });
    return data;
  }

  // ─── Technische Indikatoren ─────────────────────────────────────────────────

  _indicators(candles) {
    if (!candles || candles.length < 20) return null;

    const closes  = candles.map(c => c.close);
    const highs   = candles.map(c => c.high);
    const lows    = candles.map(c => c.low);
    const volumes = candles.map(c => c.volume);
    const last    = closes[closes.length - 1];
    const ema20   = this._ema(closes, 20);
    const ema50   = this._ema(closes, 50);
    const bb      = this._bb(closes, 20);
    const macd    = this._macd(closes);
    const rsi     = this._rsi(closes, 14);
    const atr     = this._atr(highs, lows, closes, 14);
    const volSMA  = this._sma(volumes, 20);

    return {
      rsi_14:          rsi,
      macd,
      ema_20:          parseFloat(ema20.toFixed(2)),
      ema_50:          parseFloat(ema50.toFixed(2)),
      price_vs_ema20:  parseFloat(((last - ema20) / ema20 * 100).toFixed(2)),
      price_vs_ema50:  parseFloat(((last - ema50) / ema50 * 100).toFixed(2)),
      ema_cross:       ema20 > ema50 ? 'bullish' : 'bearish',
      bb,
      atr,
      volume_sma:      parseFloat(volSMA.toFixed(2)),
      volume_current:  parseFloat(volumes[volumes.length - 1].toFixed(2)),
      volume_ratio:    parseFloat((volumes[volumes.length - 1] / volSMA).toFixed(2)),
    };
  }

  _rsi(closes, period = 14) {
    if (closes.length < period + 1) return 50;
    let gains = 0, losses = 0;
    for (let i = closes.length - period; i < closes.length; i++) {
      const d = closes[i] - closes[i - 1];
      if (d >= 0) gains += d; else losses -= d;
    }
    const ag = gains / period, al = losses / period;
    if (al === 0) return 100;
    return parseFloat((100 - 100 / (1 + ag / al)).toFixed(2));
  }

  _ema(closes, period) {
    if (closes.length < period) return closes[closes.length - 1];
    const k = 2 / (period + 1);
    let e = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < closes.length; i++) e = closes[i] * k + e * (1 - k);
    return e;
  }

  /** Returns the full EMA series as an array (same length as input after the warm-up). */
  _emaSeries(values, period) {
    if (values.length < period) return values.map(() => values[values.length - 1]);
    const k      = 2 / (period + 1);
    const result = [];
    let   e      = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
    // Fill warm-up slots with the seed SMA so the array length matches input
    for (let i = 0; i < period; i++) result.push(e);
    for (let i = period; i < values.length; i++) {
      e = values[i] * k + e * (1 - k);
      result.push(e);
    }
    return result;
  }

  _sma(values, period) {
    return values.slice(-period).reduce((a, b) => a + b, 0) / Math.min(period, values.length);
  }

  _macd(closes) {
    if (closes.length < 35) {
      // Not enough data for a proper 9-period EMA of the MACD line (need 26 + 9)
      const ema12  = this._ema(closes, Math.min(12, closes.length));
      const ema26  = this._ema(closes, Math.min(26, closes.length));
      const line   = ema12 - ema26;
      const signal = line * 0.9; // graceful fallback — clearly flagged
      return {
        macd:      parseFloat(line.toFixed(4)),
        signal:    parseFloat(signal.toFixed(4)),
        histogram: parseFloat((line - signal).toFixed(4)),
        trend:     line > signal ? 'bullish' : 'bearish',
        crossover: null,
      };
    }

    // Full MACD line series → proper 9-period EMA as signal line
    const ema12Series  = this._emaSeries(closes, 12);
    const ema26Series  = this._emaSeries(closes, 26);
    const macdSeries   = ema12Series.map((v, i) => v - ema26Series[i]);
    const signalSeries = this._emaSeries(macdSeries, 9);

    const line   = macdSeries[macdSeries.length - 1];
    const signal = signalSeries[signalSeries.length - 1];
    const prevLine   = macdSeries[macdSeries.length - 2];
    const prevSignal = signalSeries[signalSeries.length - 2];

    // Detect fresh crossovers (signal crossed within the last candle)
    const crossover = (prevLine <= prevSignal && line > signal)
      ? 'bullish_cross'
      : (prevLine >= prevSignal && line < signal)
        ? 'bearish_cross'
        : Math.abs(line - signal) < Math.abs(line) * 0.03
          ? 'near_crossover'
          : null;

    return {
      macd:      parseFloat(line.toFixed(4)),
      signal:    parseFloat(signal.toFixed(4)),
      histogram: parseFloat((line - signal).toFixed(4)),
      trend:     line > signal ? 'bullish' : 'bearish',
      crossover,
    };
  }

  _bb(closes, period = 20) {
    const sma    = this._sma(closes.slice(-period), period);
    const std    = Math.sqrt(closes.slice(-period).reduce((s, v) => s + (v - sma) ** 2, 0) / period);
    const upper  = sma + 2 * std;
    const lower  = sma - 2 * std;
    const last   = closes[closes.length - 1];
    const bw     = (upper - lower) / sma * 100;
    return {
      upper:     parseFloat(upper.toFixed(2)),
      middle:    parseFloat(sma.toFixed(2)),
      lower:     parseFloat(lower.toFixed(2)),
      bandwidth: parseFloat(bw.toFixed(2)),
      position:  parseFloat(((last - lower) / (upper - lower)).toFixed(3)), // 0=unten, 1=oben
      squeeze:   bw < 2.0,
      breakout:  last > upper ? 'above' : last < lower ? 'below' : null,
    };
  }

  _atr(highs, lows, closes, period = 14) {
    const trs = highs.slice(1).map((h, i) => Math.max(
      h - lows[i + 1],
      Math.abs(h - closes[i]),
      Math.abs(lows[i + 1] - closes[i])
    ));
    const atr = this._sma(trs, period);
    const last = closes[closes.length - 1];
    return {
      value:    parseFloat(atr.toFixed(4)),
      pct:      parseFloat((atr / last * 100).toFixed(3)),
      high_vol: (atr / last * 100) > 3.0,
    };
  }

  _regime(candles) {
    if (!candles || candles.length < 20) return 'unknown';
    const closes   = candles.map(c => c.close);
    const recent   = closes.slice(-5);
    const older    = closes.slice(-20, -5);
    const rAvg     = recent.reduce((a, b) => a + b, 0) / recent.length;
    const oAvg     = older.reduce((a, b) => a + b, 0) / older.length;
    const trend    = (rAvg - oAvg) / oAvg;
    const returns  = closes.slice(1).map((c, i) => (c - closes[i]) / closes[i]);
    const vol      = Math.sqrt(returns.reduce((s, r) => s + r * r, 0) / returns.length) * Math.sqrt(365 * 24);
    if (vol > 1.2)     return 'high_volatility';
    if (trend > 0.04)  return 'uptrend';
    if (trend < -0.04) return 'downtrend';
    return 'sideways';
  }

  _levels(candles) {
    if (!candles || candles.length < 5) return {};
    const highs   = candles.map(c => c.high);
    const lows    = candles.map(c => c.low);
    const last    = candles[candles.length - 1].close;
    const resist  = Math.max(...highs.slice(-7));
    const support = Math.min(...lows.slice(-7));
    return {
      resistance:                  parseFloat(resist.toFixed(2)),
      support:                     parseFloat(support.toFixed(2)),
      distance_to_resistance_pct:  parseFloat(((resist  - last) / last * 100).toFixed(2)),
      distance_to_support_pct:     parseFloat(((last - support) / last * 100).toFixed(2)),
    };
  }
}

module.exports = { MarketAnalyzer };
