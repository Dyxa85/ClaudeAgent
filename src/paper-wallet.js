/**
 * PaperWallet — Virtuelles Wallet mit realistischer Order-Simulation
 *
 * Alle Preise, Fees und Slippage kommen von der echten Coinbase API
 * über CoinbaseClient._simulatePaperOrder().
 *
 * Was simuliert wird (identisch zu Live):
 *   - Echter Bid/Ask Spread (BUY zum Ask, SELL zum Bid)
 *   - Slippage basierend auf echter Orderbuch-Tiefe
 *   - Echte Taker-Fee vom Account-Tier
 *   - Minimale Ordergröße ($1 Quote-Minimum)
 *
 * Was NICHT simuliert wird (bewusst vereinfacht):
 *   - Partial fills bei sehr großen Orders
 *   - Network latency / order rejection
 *   - Funding rates (nur bei Futures relevant)
 */

'use strict';

const { getPersistence } = require('./persistence');

class PaperWallet {
  constructor(initialBalance = 10000) {
    this.db           = getPersistence();
    this.feeRate      = 0.006; // Tier 1 Default — wird von agent.js überschrieben
    this.totalFeePaid = 0;

    const saved = this.db.loadWallet();
    if (saved) {
      this.initialBalance = saved.initialBalance;
      this.cashBalance    = saved.cashBalance;
      this.positions      = saved.positions;
      this.totalFeePaid   = parseFloat(this.db.getMeta('total_fee_paid', '0'));
      console.log(
        `💾 Wallet wiederhergestellt: $${this.cashBalance.toFixed(2)} Cash,` +
        ` ${Object.keys(this.positions).length} Positionen,` +
        ` $${this.totalFeePaid.toFixed(4)} Gebühren gesamt`
      );
    } else {
      this.initialBalance = initialBalance;
      this.cashBalance    = initialBalance;
      this.positions      = {};
      this.db.saveWallet(initialBalance, this.cashBalance, this.positions);
      this.db.setMeta('initial_balance', initialBalance.toString());
      this.db.setMeta('total_fee_paid',  '0');
      console.log(`💾 Neues Wallet angelegt: $${initialBalance.toFixed(2)}`);
    }
  }

  /** Wird von agent.js nach getFeeRate() gesetzt */
  setFeeRate(rate) {
    if (this.feeRate !== rate) {
      console.log(`💸 Fee-Rate: ${(this.feeRate * 100).toFixed(2)}% → ${(rate * 100).toFixed(2)}%`);
      this.feeRate = rate;
    }
  }

  // ─── BUY ────────────────────────────────────────────────────────────────────
  /**
   * @param {string} symbol
   * @param {number} amountUSD   Brutto-Betrag in USD (inkl. Fee)
   * @param {object} orderResult Ergebnis von CoinbaseClient.executeMarketOrder()
   */
  buy(symbol, amountUSD, orderResult) {
    const fee        = orderResult.fee        ?? amountUSD * this.feeRate;
    const netAmount  = amountUSD - fee;
    const fillPrice  = orderResult.avg_fill_price;
    const quantity   = orderResult.filled_base ?? (netAmount / fillPrice);
    const slippage   = orderResult.slippage_pct ?? 0;

    if (amountUSD > this.cashBalance) {
      return { success: false, reason: `Insufficient cash: need $${amountUSD.toFixed(2)}, have $${this.cashBalance.toFixed(2)}` };
    }

    if (this.positions[symbol]) {
      const p          = this.positions[symbol];
      const totalQty   = p.quantity + quantity;
      const totalCost  = p.cost_basis + amountUSD; // Gesamteinstand inkl. Fee
      this.positions[symbol] = {
        quantity:      totalQty,
        avg_price:     totalCost / totalQty,        // echter Durchschnittspreis inkl. Fee
        cost_basis:    totalCost,
        current_price: fillPrice,
        current_value: totalQty * fillPrice,
        unrealized_pnl: totalQty * fillPrice - totalCost,
      };
    } else {
      this.positions[symbol] = {
        quantity:       quantity,
        avg_price:      amountUSD / quantity,        // Einstandspreis inkl. Fee
        cost_basis:     amountUSD,
        current_price:  fillPrice,
        current_value:  quantity * fillPrice,
        unrealized_pnl: -fee,                        // Fee ist sofortiger Verlust
      };
    }

    this.cashBalance  -= amountUSD;
    this.totalFeePaid += fee;
    this.db.setMeta('total_fee_paid', this.totalFeePaid.toString());

    const trade = {
      id:              orderResult.order_id,
      action:          'BUY',
      symbol,
      quantity:        parseFloat(quantity.toFixed(8)),
      price:           fillPrice,
      amount_usd:      parseFloat(amountUSD.toFixed(2)),
      fee:             parseFloat(fee.toFixed(6)),
      net_amount:      parseFloat(netAmount.toFixed(2)),
      slippage_pct:    slippage,
      timestamp:       orderResult.created_at || new Date().toISOString(),
      portfolio_value: this.getState().totalValue,
    };

    this.db.saveTradeWithState(trade, this.cashBalance, this.positions, trade.portfolio_value);
    console.log(`  🟢 BUY  ${symbol}: ${quantity.toFixed(6)} @ $${fillPrice.toFixed(2)} | Fee: $${fee.toFixed(4)} | Slippage: ${slippage}%`);
    return { success: true, trade };
  }

  // ─── SELL ───────────────────────────────────────────────────────────────────

  sell(symbol, amountUSD, orderResult) {
    const position = this.positions[symbol];
    if (!position) return { success: false, reason: `No position in ${symbol}` };

    const fillPrice      = orderResult.avg_fill_price;
    const quantityToSell = Math.min(orderResult.filled_base ?? (amountUSD / fillPrice), position.quantity);
    const grossProceeds  = quantityToSell * fillPrice;
    const fee            = orderResult.fee ?? (grossProceeds * this.feeRate);
    const netProceeds    = grossProceeds - fee;
    const slippage       = orderResult.slippage_pct ?? 0;

    // P&L berechnen: Netto-Erlös minus anteiliger Einstandspreis
    const costBasisSold = position.cost_basis * (quantityToSell / position.quantity);
    const realizedPnL   = netProceeds - costBasisSold;
    const pnlPct        = parseFloat((realizedPnL / costBasisSold * 100).toFixed(2));

    position.quantity  -= quantityToSell;
    if (position.quantity < 0.0000001) {
      delete this.positions[symbol];
    } else {
      position.cost_basis    -= costBasisSold;
      position.current_price  = fillPrice;
      position.current_value  = position.quantity * fillPrice;
      position.unrealized_pnl = position.quantity * fillPrice - position.cost_basis;
    }

    this.cashBalance  += netProceeds;
    this.totalFeePaid += fee;
    this.db.setMeta('total_fee_paid', this.totalFeePaid.toString());

    const trade = {
      id:              orderResult.order_id,
      action:          'SELL',
      symbol,
      quantity:        parseFloat(quantityToSell.toFixed(8)),
      price:           fillPrice,
      amount_usd:      parseFloat(netProceeds.toFixed(2)),
      gross_proceeds:  parseFloat(grossProceeds.toFixed(2)),
      fee:             parseFloat(fee.toFixed(6)),
      realized_pnl:    parseFloat(realizedPnL.toFixed(2)),
      pnl_pct:         pnlPct,
      slippage_pct:    slippage,
      timestamp:       orderResult.created_at || new Date().toISOString(),
      portfolio_value: this.getState().totalValue,
    };

    this.db.saveTradeWithState(trade, this.cashBalance, this.positions, trade.portfolio_value);
    const pnlStr = realizedPnL >= 0 ? `+$${realizedPnL.toFixed(2)}` : `-$${Math.abs(realizedPnL).toFixed(2)}`;
    console.log(`  🔴 SELL ${symbol}: ${quantityToSell.toFixed(6)} @ $${fillPrice.toFixed(2)} | Fee: $${fee.toFixed(4)} | P&L: ${pnlStr} (${pnlPct}%)`);
    return { success: true, trade };
  }

  // ─── Preise aktualisieren (ohne Trade) ─────────────────────────────────────

  updatePrices(priceMap) {
    for (const [symbol, price] of Object.entries(priceMap)) {
      const p = this.positions[symbol];
      if (p) {
        p.current_price  = price;
        p.current_value  = p.quantity * price;
        p.unrealized_pnl = p.quantity * price - p.cost_basis;
      }
    }
    // Periodischer Snapshot ohne Trade
    this._priceUpdateCount = (this._priceUpdateCount || 0) + 1;
    if (this._priceUpdateCount % 10 === 0) {
      this.db.saveSnapshot(this.getState().totalValue);
    }
  }

  // ─── State für Dashboard + AI ──────────────────────────────────────────────

  getState() {
    const posValue   = Object.values(this.positions).reduce((s, p) => s + p.current_value, 0);
    const totalValue = this.cashBalance + posValue;
    const totalReturn = (totalValue - this.initialBalance) / this.initialBalance * 100;

    return {
      cashBalance:     parseFloat(this.cashBalance.toFixed(2)),
      positionsValue:  parseFloat(posValue.toFixed(2)),
      totalValue:      parseFloat(totalValue.toFixed(2)),
      totalReturnPct:  parseFloat(totalReturn.toFixed(2)),
      totalFeePaid:    parseFloat(this.totalFeePaid.toFixed(4)),
      feeRate:         this.feeRate,
      positions: Object.entries(this.positions).map(([symbol, p]) => ({
        symbol,
        quantity:         parseFloat(p.quantity.toFixed(8)),
        avg_price:        parseFloat(p.avg_price.toFixed(2)),
        current_price:    parseFloat(p.current_price.toFixed(2)),
        current_value:    parseFloat(p.current_value.toFixed(2)),
        cost_basis:       parseFloat(p.cost_basis.toFixed(2)),
        unrealized_pnl:   parseFloat(p.unrealized_pnl.toFixed(2)),
        unrealized_pnl_pct: parseFloat((p.unrealized_pnl / p.cost_basis * 100).toFixed(2)),
      })),
      tradeCount: this.db.getTradeCount(),
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────

class StrategyMemory {
  constructor() {
    this.db          = getPersistence();
    this._trades     = [];
    this._strategies = [];
  }

  async load() {
    this._trades     = this.db.loadAllTrades();
    this._strategies = this.db.loadAllStrategies();
    console.log(`💾 Memory: ${this._trades.length} Trades, ${this._strategies.length} Strategien, Version ${this.db.getStrategyVersion()}`);
  }

  async recordTrade(trade) {
    this._trades.push(trade);
    if (this._trades.length > 1000) this._trades.shift();
  }

  async saveStrategy(strategy) {
    this.db.saveStrategy(strategy, this.db.getTradeCount());
    this._strategies.push(strategy);
    console.log(`💾 Neue Strategie: ${strategy.name} v${strategy.version}`);
  }

  async getBestStrategy()   { return this.db.loadLatestStrategy(); }
  getStrategyVersion()      { return this.db.getStrategyVersion(); }
  getRecentTrades(n = 20)   { return this.db.loadRecentTrades(n); }
  get strategies()          { return this._strategies; }

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
    const std      = Math.sqrt(returns.reduce((s, r) => s + (r - avg) ** 2, 0) / returns.length);
    if (std === 0) return 'N/A';
    return parseFloat((avg / std * Math.sqrt(252)).toFixed(2));
  }
}

// ─────────────────────────────────────────────────────────────────────────────

class Logger {
  constructor() { this.logs = []; }

  _push(entry) {
    this.logs.push(entry);
    if (this.logs.length > 500) this.logs.shift();
  }

  info(msg, ...a)  { const e = { level:'INFO',  ts: new Date().toISOString(), msg, data: a }; this._push(e); console.log( `[${e.ts}] ℹ️  ${msg}`, ...a); }
  warn(msg, ...a)  { const e = { level:'WARN',  ts: new Date().toISOString(), msg, data: a }; this._push(e); console.warn(`[${e.ts}] ⚠️  ${msg}`, ...a); }
  error(msg, ...a) { const e = { level:'ERROR', ts: new Date().toISOString(), msg, data: a }; this._push(e); console.error(`[${e.ts}] ❌  ${msg}`, ...a); }

  trade(action, d) {
    const e = { level:'TRADE', ts: new Date().toISOString(), action, details: d };
    this._push(e);
  }

  getRecent(n = 50) { return this.logs.slice(-n); }
}

module.exports = { PaperWallet, StrategyMemory, Logger };
