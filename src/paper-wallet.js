/**
 * Paper Wallet — mit vollständiger SQLite-Persistenz
 */

const { getPersistence } = require('./persistence');

class PaperWallet {
  constructor(initialBalance = 10000) {
    this.db = getPersistence();
    this.initialBalance = initialBalance;

    const saved = this.db.loadWallet();

    if (saved) {
      this.initialBalance = saved.initialBalance;
      this.cashBalance    = saved.cashBalance;
      this.positions      = saved.positions;
      console.log(`💾 Wallet wiederhergestellt: $${this.cashBalance.toFixed(2)} Cash, ${Object.keys(this.positions).length} Positionen`);
    } else {
      this.cashBalance = initialBalance;
      this.positions   = {};
      this.db.saveWallet(initialBalance, this.cashBalance, this.positions);
      this.db.setMeta('initial_balance', initialBalance);
      console.log(`💾 Neues Wallet angelegt: $${initialBalance.toFixed(2)}`);
    }
  }

  buy(symbol, amountUSD, currentPrice) {
    if (amountUSD > this.cashBalance) {
      return { success: false, reason: 'Insufficient cash balance' };
    }
    const quantity = amountUSD / currentPrice;
    if (this.positions[symbol]) {
      const existing  = this.positions[symbol];
      const totalQty  = existing.quantity + quantity;
      const totalCost = existing.quantity * existing.avgPrice + quantity * currentPrice;
      this.positions[symbol] = {
        quantity: totalQty, avgPrice: totalCost / totalQty,
        currentPrice, currentValue: totalQty * currentPrice,
        unrealizedPnL: totalQty * (currentPrice - totalCost / totalQty),
      };
    } else {
      this.positions[symbol] = {
        quantity, avgPrice: currentPrice, currentPrice,
        currentValue: amountUSD, unrealizedPnL: 0,
      };
    }
    this.cashBalance -= amountUSD;
    const trade = {
      id: `trade_${Date.now()}`, action: 'BUY', symbol, quantity,
      price: currentPrice, amount_usd: amountUSD,
      timestamp: new Date().toISOString(),
      portfolio_value: this.getState().totalValue,
    };
    this.db.saveTradeWithState(trade, this.cashBalance, this.positions, this.getState().totalValue);
    return { success: true, trade };
  }

  sell(symbol, amountUSD, currentPrice) {
    const position = this.positions[symbol];
    if (!position) return { success: false, reason: `No position in ${symbol}` };

    const quantityToSell = Math.min(amountUSD / currentPrice, position.quantity);
    const proceeds       = quantityToSell * currentPrice;
    const costBasis      = quantityToSell * position.avgPrice;
    const realizedPnL    = proceeds - costBasis;
    const pnlPct         = ((realizedPnL / costBasis) * 100).toFixed(2);

    position.quantity -= quantityToSell;
    if (position.quantity < 0.000001) {
      delete this.positions[symbol];
    } else {
      position.currentPrice  = currentPrice;
      position.currentValue  = position.quantity * currentPrice;
      position.unrealizedPnL = position.quantity * (currentPrice - position.avgPrice);
    }
    this.cashBalance += proceeds;

    const trade = {
      id: `trade_${Date.now()}`, action: 'SELL', symbol,
      quantity: quantityToSell, price: currentPrice, amount_usd: proceeds,
      realizedPnL, pnlPct,
      timestamp: new Date().toISOString(),
      portfolio_value: this.getState().totalValue,
    };
    this.db.saveTradeWithState(trade, this.cashBalance, this.positions, this.getState().totalValue);
    return { success: true, trade };
  }

  updatePrices(priceMap) {
    for (const [symbol, price] of Object.entries(priceMap)) {
      if (this.positions[symbol]) {
        const p = this.positions[symbol];
        p.currentPrice = price; p.currentValue = p.quantity * price;
        p.unrealizedPnL = p.quantity * (price - p.avgPrice);
      }
    }
    this._priceUpdateCount = (this._priceUpdateCount || 0) + 1;
    if (this._priceUpdateCount % 10 === 0) {
      this.db.saveSnapshot(this.getState().totalValue);
    }
  }

  getState() {
    const positionsValue = Object.values(this.positions).reduce((sum, p) => sum + p.currentValue, 0);
    const totalValue     = this.cashBalance + positionsValue;
    const totalReturn    = ((totalValue - this.initialBalance) / this.initialBalance * 100).toFixed(2);
    return {
      cashBalance:    parseFloat(this.cashBalance.toFixed(2)),
      positionsValue: parseFloat(positionsValue.toFixed(2)),
      totalValue:     parseFloat(totalValue.toFixed(2)),
      totalReturnPct: parseFloat(totalReturn),
      positions: Object.entries(this.positions).map(([symbol, p]) => ({
        symbol,
        quantity:         parseFloat(p.quantity.toFixed(8)),
        avgPrice:         parseFloat(p.avgPrice.toFixed(2)),
        currentPrice:     parseFloat((p.currentPrice || p.avgPrice).toFixed(2)),
        currentValue:     parseFloat(p.currentValue.toFixed(2)),
        unrealizedPnL:    parseFloat((p.unrealizedPnL || 0).toFixed(2)),
        unrealizedPnLPct: parseFloat(((p.unrealizedPnL || 0) / (p.quantity * p.avgPrice) * 100).toFixed(2)),
      })),
      tradeCount: this.db.getTradeCount(),
    };
  }
}

class StrategyMemory {
  constructor() {
    this.db = getPersistence();
    this._trades     = [];
    this._strategies = [];
    this.maxTrades   = 1000;
  }

  async load() {
    this._trades     = this.db.loadAllTrades();
    this._strategies = this.db.loadAllStrategies();
    const version    = this.db.getStrategyVersion();
    console.log(`💾 Memory geladen: ${this._trades.length} Trades, ${this._strategies.length} Strategien, Version ${version}`);
  }

  async recordTrade(trade) {
    this._trades.push(trade);
    if (this._trades.length > this.maxTrades) this._trades.shift();
  }

  async saveStrategy(strategy) {
    this.db.saveStrategy(strategy, this.db.getTradeCount());
    this._strategies.push(strategy);
    console.log(`💾 Strategie gespeichert: ${strategy.name}`);
  }

  async getBestStrategy() { return this.db.loadLatestStrategy(); }
  getStrategyVersion()    { return this.db.getStrategyVersion(); }
  getRecentTrades(n = 20) { return this.db.loadRecentTrades(n); }
  get strategies()        { return this._strategies; }

  getWinRate() {
    const sells = this._trades.filter(t => t.action === 'SELL' && t.realized_pnl != null);
    if (!sells.length) return 'N/A';
    return parseFloat((sells.filter(t => t.realized_pnl > 0).length / sells.length * 100).toFixed(1));
  }

  getAvgProfit() {
    const sells = this._trades.filter(t => t.action === 'SELL' && t.realized_pnl != null);
    if (!sells.length) return 0;
    return parseFloat((sells.reduce((s, t) => s + t.realized_pnl, 0) / sells.length).toFixed(2));
  }

  getMaxDrawdown() {
    const vals = this._trades.map(t => t.portfolio_value).filter(Boolean);
    if (vals.length < 2) return 0;
    let maxDD = 0, peak = vals[0];
    for (const v of vals) {
      if (v > peak) peak = v;
      const dd = (peak - v) / peak * 100;
      if (dd > maxDD) maxDD = dd;
    }
    return parseFloat(maxDD.toFixed(2));
  }

  getSharpeRatio() {
    const sells = this._trades.filter(t => t.action === 'SELL' && t.realized_pnl != null);
    if (sells.length < 3) return 'N/A';
    const returns  = sells.map(t => t.realized_pnl / (t.amount_usd || 1));
    const avg      = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((s, r) => s + (r - avg) ** 2, 0) / returns.length;
    const std      = Math.sqrt(variance);
    if (std === 0) return 'N/A';
    return parseFloat((avg / std * Math.sqrt(252)).toFixed(2));
  }
}

class Logger {
  constructor() { this.logs = []; }

  _log(level, emoji, fn, message, args) {
    const entry = { level, timestamp: new Date().toISOString(), message, data: args };
    this.logs.push(entry);
    if (this.logs.length > 500) this.logs.shift();
    fn(`[${entry.timestamp}] ${emoji} ${message}`, ...args);
  }

  info(msg, ...a)  { this._log('INFO',  'ℹ️ ',  console.log,   msg, a); }
  warn(msg, ...a)  { this._log('WARN',  '⚠️ ',  console.warn,  msg, a); }
  error(msg, ...a) { this._log('ERROR', '❌',   console.error, msg, a); }

  trade(action, d) {
    const emoji = action === 'BUY' ? '🟢' : action === 'SELL' ? '🔴' : '⚪';
    const entry = { level: 'TRADE', timestamp: new Date().toISOString(), action, details: d };
    this.logs.push(entry);
    if (this.logs.length > 500) this.logs.shift();
    console.log(`[${entry.timestamp}] ${emoji} ${action} ${d.symbol} $${d.amount?.toFixed(2)} @ $${d.price?.toFixed(2)} (conf: ${((d.confidence||0)*100).toFixed(0)}%)`);
  }

  getRecent(n = 50) { return this.logs.slice(-n); }
}

module.exports = { PaperWallet, StrategyMemory, Logger };
