/**
 * Trading AI Agent - Core Engine
 * Autonomous crypto trading with Coinbase MCP + Claude AI
 *
 * Improvements vs. previous version:
 *  - Quality gate: selfImprove() only fires after 30+ SELLs in current epoch
 *  - Strategic AI: selfImprove() uses Sonnet (completeStrategic) for deeper analysis
 *  - Total position cap: max 80% portfolio in one asset (BUY guard)
 *  - Stop-loss monitor: background loop checks open positions every 30 s
 *  - Risk profiles: Conservative / Balanced / Aggressive per strategy
 *  - Compact prompt: no raw JSON.stringify for market data (saves tokens ~40%)
 *  - Exponential backoff on cycle errors (5 → 10 → 30 → 60 s, reset on success)
 */

const { AnthropicClient } = require('./anthropic-client');
const { PaperWallet, StrategyMemory, Logger } = require('./paper-wallet');
const { MarketAnalyzer } = require('./market-analyzer');
const { CoinbaseClient } = require('./coinbase-client');
const { getPersistence } = require('./persistence');

// ─────────────────────────────────────────────────────────────────────────────
// Risk Profiles — mapped per strategy type keyword
// ─────────────────────────────────────────────────────────────────────────────
const RISK_PROFILES = {
  conservative: {
    maxPositionSize:    0.10,   // max 10% portfolio per single trade
    maxAssetExposure:   0.50,   // max 50% of portfolio in one asset
    cashReserveMin:     0.30,   // maintain 30% cash
    confidenceMin:      0.65,
    label: 'Conservative',
  },
  balanced: {
    maxPositionSize:    0.15,
    maxAssetExposure:   0.70,
    cashReserveMin:     0.20,
    confidenceMin:      0.55,
    label: 'Balanced',
  },
  aggressive: {
    maxPositionSize:    0.25,
    maxAssetExposure:   0.80,
    cashReserveMin:     0.15,
    confidenceMin:      0.50,
    label: 'Aggressive',
  },
};

function _resolveRiskProfile(strategy) {
  if (!strategy) return RISK_PROFILES.balanced;
  const src = (strategy.name + ' ' + JSON.stringify(strategy.rules || {})).toLowerCase();
  if (src.includes('conservative') || src.includes('low risk') || src.includes('safe')) {
    return RISK_PROFILES.conservative;
  }
  if (src.includes('aggressive') || src.includes('high risk') || src.includes('momentum')) {
    return RISK_PROFILES.aggressive;
  }
  return RISK_PROFILES.balanced;
}

// ─────────────────────────────────────────────────────────────────────────────
class TradingAgent {
  constructor(config = {}) {
    this.config = {
      mode: config.mode || 'paper',          // 'paper' | 'live'
      symbols: config.symbols || ['BTC-USD', 'ETH-USD', 'SOL-USD'],
      initialBalance: config.initialBalance || 10000,
      maxPositionSize: config.maxPositionSize || 0.15,       // per-trade cap (overridden by risk profile)
      riskPerTrade: config.riskPerTrade || 0.02,             // 2% risk per trade
      improvementCycle: config.improvementCycle || 30,       // trigger selfImprove after N trades
      decisionInterval: config.decisionInterval || 300000,   // 5 min
      stopLossCheckInterval: config.stopLossCheckInterval || 30000, // 30 s
      circuitBreakerDrawdown: config.circuitBreakerDrawdown || 20,
      ...config
    };

    this.db       = getPersistence();

    this.coinbase = new CoinbaseClient({
      apiKey:    this.config.coinbaseApiKey    || process.env.COINBASE_API_KEY,
      apiSecret: this.config.coinbaseApiSecret || process.env.COINBASE_API_SECRET,
      isPaper:   this.config.mode !== 'live',
    });

    this.wallet   = new PaperWallet(this.config.initialBalance);
    this.memory   = new StrategyMemory();
    this.analyzer = new MarketAnalyzer({ client: this.coinbase });
    this.ai       = new AnthropicClient();
    this.logger   = new Logger();

    this.isRunning        = false;
    this.isPaused         = false;
    this.currentStrategy  = null;
    this.riskProfile      = RISK_PROFILES.balanced;
    this.onCircuitBreaker = null; // Callback: (drawdownPct, portfolioValue) => void

    // Exponential backoff state
    this._errorBackoffMs  = 5000;
    this._stopLossTimer   = null;

    // Trade count + performance history from DB
    this.tradeCount         = this.db.getTradeCount();
    this.performanceHistory = this.db.loadSnapshots(500);
  }

  get uptime() { return Math.floor(process.uptime()); }

  // ───────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ───────────────────────────────────────────────────────────────────────────

  async start() {
    this.isRunning = true;
    this.logger.info('🚀 Trading Agent starting...', { mode: this.config.mode });

    // Symbols from last Coinbase sync (set by index.js)
    const savedSymbols = this.db.getMeta('coinbase_symbols');
    if (savedSymbols) {
      try {
        const parsed = JSON.parse(savedSymbols);
        if (Array.isArray(parsed) && parsed.length > 0) {
          this.config.symbols = parsed;
          this.logger.info(`🔍 Symbole aus Coinbase Portfolio: ${parsed.join(', ')}`);
        }
      } catch { /* keep defaults */ }
    }

    await this._updateFeeRate();
    await this.memory.load();
    this.currentStrategy    = await this.memory.getBestStrategy();
    this.riskProfile        = _resolveRiskProfile(this.currentStrategy);
    this.tradeCount         = this.db.getTradeCount();
    this.performanceHistory = this.db.loadSnapshots(500);

    this.logger.info(
      `📊 Wiederhergestellt: ${this.tradeCount} Trades | ` +
      `Strategie: ${this.currentStrategy?.name || 'Default'} | ` +
      `Risikoprofil: ${this.riskProfile.label}`
    );

    // Start stop-loss background monitor
    this._startStopLossMonitor();

    // Main trading loop
    while (this.isRunning) {
      if (this.isPaused) {
        await this.sleep(5000);
        continue;
      }

      try {
        await this.tradingCycle();
        this._errorBackoffMs = 5000; // reset on success

        // Daily fee-rate refresh
        this._cycleCount = (this._cycleCount || 0) + 1;
        const cyclesPerDay = Math.floor(86400000 / this.config.decisionInterval);
        if (this._cycleCount % cyclesPerDay === 0) {
          await this._updateFeeRate();
        }

        await this.sleep(this.config.decisionInterval);
      } catch (err) {
        this.logger.error('Trading cycle error:', err.message);
        await this.sleep(this._errorBackoffMs);
        // Exponential backoff: 5 → 10 → 30 → 60 s (cap at 60 s)
        this._errorBackoffMs = Math.min(this._errorBackoffMs * 2, 60000);
      }
    }

    // Cleanup
    if (this._stopLossTimer) clearInterval(this._stopLossTimer);
  }

  pause()  { this.isPaused = true;  this.logger.info('⏸️ Agent pausiert (manuell)'); }
  resume() { this.isPaused = false; this.logger.info('▶️ Agent fortgesetzt'); }

  stop() {
    this.isRunning = false;
    if (this._stopLossTimer) clearInterval(this._stopLossTimer);
    this.logger.info('🛑 Trading Agent stopped');
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Core trading cycle
  // ───────────────────────────────────────────────────────────────────────────

  async tradingCycle() {
    this.logger.info('⚡ Running trading cycle...');

    const marketData = await this.gatherMarketData();

    const simulated = Object.values(marketData).filter(d => d._source === 'simulated_fallback');
    if (simulated.length > 0) {
      this.logger.warn(`⚠️  Simulierte Daten für: ${simulated.map(d => d.symbol).join(', ')} — Coinbase API nicht erreichbar`);
    }

    const portfolioState = this.wallet.getState();
    const performance    = this.getPerformanceMetrics();

    // Circuit Breaker
    const drawdownPct = parseFloat(performance.max_drawdown || 0);
    if (drawdownPct >= this.config.circuitBreakerDrawdown) {
      this.isPaused = true;
      this.logger.warn(
        `🚨 CIRCUIT BREAKER! Drawdown ${drawdownPct}% >= ${this.config.circuitBreakerDrawdown}%` +
        ` — Trading pausiert. /resume zum Fortsetzen.`
      );
      if (typeof this.onCircuitBreaker === 'function') {
        this.onCircuitBreaker(drawdownPct, this.wallet.getState().totalValue);
      }
      return;
    }

    const decisions = await this.getAIDecisions(marketData, portfolioState, performance);
    await Promise.all(decisions.map(d => this.executeDecision(d, marketData)));

    // Quality-gated self-improvement — normal cycle
    if (this.tradeCount > 0 && this.tradeCount % this.config.improvementCycle === 0) {
      await this.selfImprove();
    } else {
      // Emergency improvement: only fires when RECENT trades (not epoch-wide contaminated history)
      // show persistent failure AND the current strategy is old enough to justify a redo
      const sells = this.memory.getRecentTrades(50).filter(t => t.action === 'SELL');
      if (sells.length >= 5 && !this._lastEmergencyImprove) {
        // Skip if strategy was recently improved (< 6h) — avoids Sonnet overuse on bad epoch stats
        const stratAgeHrs = this.currentStrategy?.saved_at
          ? (Date.now() - new Date(this.currentStrategy.saved_at).getTime()) / 3600000
          : 99;

        if (stratAgeHrs >= 6) {
          // Judge performance on last 8 SELLs only — not epoch-wide (which may include old carryovers)
          const recent8    = sells.slice(-8);
          const recentWins = recent8.filter(t => (t.realized_pnl || 0) > 0).length;
          const recentWR   = recent8.length >= 3 ? recentWins / recent8.length : null;
          const sharpe     = parseFloat(this.getPerformanceMetrics().sharpe_ratio) || 0;

          if (recentWR !== null && (recentWR === 0 || (recentWR < 0.25 && sharpe < -3))) {
            this.logger.warn(`🚨 Emergency selfImprove: recent WR=${(recentWR*100).toFixed(0)}% (${recent8.length} SELLs) sharpe=${sharpe.toFixed(1)} stratAge=${stratAgeHrs.toFixed(1)}h`);
            this._lastEmergencyImprove = Date.now();
            await this.selfImprove();
          }
        }
      }
      // Cooldown 6 hours (was 2h — was burning Sonnet tokens on contaminated epoch stats)
      if (this._lastEmergencyImprove && Date.now() - this._lastEmergencyImprove > 21600000) {
        this._lastEmergencyImprove = null;
      }
    }

    this.recordPerformanceSnapshot();
  }

  async gatherMarketData() {
    const data = {};
    for (const symbol of this.config.symbols) {
      data[symbol] = await this.analyzer.getMarketData(symbol);
    }
    return data;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // AI Decision layer
  // ───────────────────────────────────────────────────────────────────────────

  async getAIDecisions(marketData, portfolioState, performance) {
    const prompt = this.buildDecisionPrompt(marketData, portfolioState, performance);

    const response = await this.ai.complete({
      system: this.buildSystemPrompt(),
      messages: [{ role: 'user', content: prompt }],
      responseFormat: 'json'
    });

    try {
      const parsed = JSON.parse(response);
      if (!this._validateDecisionResponse(parsed)) {
        this.logger.warn('⚠️ AI response failed schema validation, skipping cycle');
        return [];
      }
      this.logger.info('🤖 AI decisions received:', parsed.decisions.length, 'actions');
      return parsed.decisions;
    } catch {
      // Log first 300 chars of response to diagnose what model returned
      const preview = (response || '').substring(0, 300).replace(/\n/g, ' ');
      this.logger.warn(`Failed to parse AI response (${(response || '').length} chars): ${preview}`);
      return [];
    }
  }

  buildSystemPrompt() {
    const strategyContext = this.currentStrategy
      ? `Active strategy: ${this.currentStrategy.name} (v${this.currentStrategy.version})\nRules: ${JSON.stringify(this.currentStrategy.rules)}`
      : 'No prior strategy — develop one based on market conditions';

    // Inject hard overrides that supersede ANY strategy rule
    const strategyOverrides = `
HARD OVERRIDES (supersede all strategy rules):
- Crypto markets are 24/7. NEVER apply time-of-day or day-of-week restrictions.
- Circuit breakers / "halt trading" rules: advisory only. Maximum effective halt = 30 minutes.
- "Consecutive loss stops" are advisory. Clear technical signals (RSI<30 + bullish MACD crossover, or RSI>70 + bearish crossover) justify re-entry regardless of loss streak.
- If win_rate=0% but portfolio is intact (100% cash), this means NO capital was destroyed — just missed opportunities. Cautious re-entry is appropriate.
- Volume requirements like "2x spike required" are preferred but NOT mandatory. Normal volume is acceptable for smaller position sizes.
- Position sizes: $2 minimum, scale up to risk profile maximum. Never below $2 per trade.`;

    const cbPortfolioUSD = parseFloat(this.db.getMeta('coinbase_portfolio_usd', '0'));
    const cbHoldings     = JSON.parse(this.db.getMeta('coinbase_holdings_json', '[]'));
    const cbCtx = cbPortfolioUSD > 0
      ? `\nREAL COINBASE PORTFOLIO (reference, read-only):\n` +
        `- Total: $${cbPortfolioUSD.toFixed(2)}\n` +
        cbHoldings.map(h =>
          `- ${h.asset}: ${h.quantity.toFixed(6)} @ avg $${h.avg_price.toFixed(2)} = $${h.value_usd.toFixed(2)}`
        ).join('\n') +
        `\nThis paper session simulates performance on these holdings.\n` +
        `Only trade: ${this.config.symbols.join(', ')}`
      : '';

    const epoch    = this.db.getCurrentEpoch();
    const epochId  = this.db.getCurrentEpochId();
    const epochCtx = `\nEPOCH: #${epochId} (started ${(epoch?.started_at || '').substring(0, 16)} UTC, reason: ${epoch?.reason || 'initial'})\n` +
      `All metrics shown belong to this epoch only. Do NOT infer from prior epochs.\n`;

    const rp = this.riskProfile;
    return `You are an autonomous crypto trading AI in ${this.config.mode.toUpperCase()} mode.

MISSION: Maximize risk-adjusted returns while protecting capital.

RISK PROFILE: ${rp.label}
- Max per-trade size: ${(rp.maxPositionSize * 100).toFixed(0)}% of portfolio
- Max asset concentration: ${(rp.maxAssetExposure * 100).toFixed(0)}% per symbol
- Minimum cash reserve: ${(rp.cashReserveMin * 100).toFixed(0)}%
- Minimum decision confidence: ${rp.confidenceMin}

CONSTRAINTS:
- Tradeable symbols: ${this.config.symbols.join(', ')}
- Max risk per trade: ${(this.config.riskPerTrade * 100).toFixed(0)}% of portfolio
- Cash reserve enforced in code — never suggest orders that breach it
- Never chase losses — stick to the strategy
${cbCtx}
${epochCtx}
${strategyContext}
${strategyOverrides}

RESPONSE FORMAT — valid JSON only:
{
  "analysis": "brief market analysis",
  "decisions": [
    {
      "action": "BUY|SELL|HOLD",
      "symbol": "SOL-USD",
      "amount_usd": 50,
      "reason": "reasoning",
      "confidence": 0.75,
      "stop_loss_pct": 0.05,
      "take_profit_pct": 0.10
    }
  ],
  "strategy_notes": "observations to improve strategy"
}`;
  }

  buildDecisionPrompt(marketData, portfolioState, performance) {
    // Compact market data — saves ~40% tokens vs raw JSON.stringify
    const mkLines = Object.entries(marketData).map(([sym, d]) => {
      const i1h = d.indicators_1h || {};
      const i4h = d.indicators_4h || {};
      const macd1h = i1h.macd || {};
      const bb1h   = i1h.bb   || {};
      const atr1h  = i1h.atr  || {};
      return [
        `${sym}: $${d.price?.toFixed(2) || 'n/a'}`,
        `  change24h=${d.price_change_24h?.toFixed(2) ?? 'n/a'}%  vol=$${d.volume_24h ? (d.volume_24h / 1e6).toFixed(1) : 'n/a'}M`,
        `  spread=${d.spread_pct?.toFixed(3) ?? 'n/a'}%  regime=${d.regime || 'n/a'}`,
        `  1h: rsi=${i1h.rsi_14?.toFixed(1) ?? 'n/a'}  ema_cross=${i1h.ema_cross || 'n/a'}  vol_ratio=${i1h.volume_ratio?.toFixed(2) ?? 'n/a'}`,
        `  1h macd=${macd1h.macd?.toFixed(4) ?? 'n/a'}/sig=${macd1h.signal?.toFixed(4) ?? 'n/a'} (${macd1h.crossover || macd1h.trend || 'n/a'})`,
        `  1h bb_pos=${bb1h.position?.toFixed(2) ?? 'n/a'}  squeeze=${bb1h.squeeze ?? 'n/a'}  breakout=${bb1h.breakout || 'none'}`,
        `  1h atr=${atr1h.pct?.toFixed(2) ?? 'n/a'}%  4h rsi=${i4h.rsi_14?.toFixed(1) ?? 'n/a'}  ema_cross=${i4h.ema_cross || 'n/a'}`,
        `  levels: support=$${d.levels?.support?.toFixed(2) ?? 'n/a'}  resist=$${d.levels?.resistance?.toFixed(2) ?? 'n/a'}`,
      ].join('\n');
    });

    // Compact portfolio
    const posLines = Object.entries(portfolioState.positions || {}).map(([sym, p]) =>
      `  ${sym}: qty=${p.quantity?.toFixed(6)} cost=$${p.avg_price?.toFixed(2)} cur=$${p.current_price?.toFixed(2)} pnl=${p.unrealized_pnl_pct?.toFixed(1)}% sl=$${p.stop_loss?.toFixed(2) || 'n/a'} tp=$${p.take_profit?.toFixed(2) || 'n/a'}`
    );

    // Compact recent trades
    const recentTrades = this.memory.getRecentTrades(8);
    const tradeLines = recentTrades.map(t =>
      `  ${t.action} ${t.symbol} $${t.amount_usd?.toFixed(2)} @ $${t.price?.toFixed(2)} pnl=${t.realized_pnl?.toFixed(2) || '-'} ${t.reason?.substring(0, 40) || ''}`
    );

    return `MARKET DATA (${new Date().toUTCString()}):
${mkLines.join('\n\n')}

PORTFOLIO: total=$${portfolioState.totalValue?.toFixed(2)} cash=$${portfolioState.cashBalance?.toFixed(2)} (${((portfolioState.cashBalance / portfolioState.totalValue) * 100).toFixed(0)}%)
POSITIONS:
${posLines.length ? posLines.join('\n') : '  (none)'}

PERFORMANCE: return=${performance.total_return_pct}% trades=${performance.total_trades} wins=${performance.win_rate} sharpe=${performance.sharpe_ratio} drawdown=${performance.max_drawdown}%

RECENT TRADES (last ${recentTrades.length}):
${tradeLines.length ? tradeLines.join('\n') : '  (none)'}

Make trading decisions. HOLD is valid when conditions are unclear.`;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Execute a single AI decision
  // ───────────────────────────────────────────────────────────────────────────

  async executeDecision(decision, marketData) {
    if (!decision.action || decision.action === 'HOLD') {
      this.logger.info(`📊 HOLD ${decision.symbol} - ${decision.reason}`);
      return;
    }

    const { action, symbol, amount_usd, reason, confidence, stop_loss_pct, take_profit_pct } = decision;
    const currentPrice = marketData[symbol]?.price;

    if (!currentPrice) {
      this.logger.warn(`No price data for ${symbol}, skipping`);
      return;
    }

    const rp = this.riskProfile;

    // Confidence gate (risk-profile aware)
    if (confidence < rp.confidenceMin) {
      this.logger.info(`⏸️ Skip ${action} ${symbol} — confidence ${confidence} < ${rp.confidenceMin} (${rp.label})`);
      return;
    }

    const portfolioState = this.wallet.getState();
    const maxTrade       = portfolioState.totalValue * rp.maxPositionSize;
    let   safeAmount     = Math.min(amount_usd, maxTrade);

    if (action === 'BUY') {
      // ── Guard 1: Total asset concentration cap ────────────────────────────
      const currentPos      = portfolioState.positions[symbol];
      const currentExposure = currentPos
        ? (currentPos.current_value || currentPos.quantity * currentPrice) / portfolioState.totalValue
        : 0;
      if (currentExposure >= rp.maxAssetExposure) {
        this.logger.warn(
          `⚠️ BUY ${symbol} übersprungen: Konzentration ${(currentExposure * 100).toFixed(1)}%` +
          ` ≥ ${(rp.maxAssetExposure * 100).toFixed(0)}% Cap (${rp.label})`
        );
        return;
      }

      // ── Guard 2: Cash reserve ─────────────────────────────────────────────
      const minCash    = portfolioState.totalValue * rp.cashReserveMin;
      const cashAfter  = portfolioState.cashBalance - safeAmount;
      if (cashAfter < minCash) {
        safeAmount = Math.max(0, portfolioState.cashBalance - minCash);
        if (safeAmount < 10) {
          this.logger.warn(
            `⚠️ BUY ${symbol} übersprungen: Cash Reserve (${(rp.cashReserveMin * 100).toFixed(0)}%)` +
            ` würde unterschritten ($${portfolioState.cashBalance.toFixed(2)} verfügbar)`
          );
          return;
        }
        this.logger.info(`📉 BUY-Betrag auf $${safeAmount.toFixed(2)} reduziert (${rp.label} Cash-Reserve Schutz)`);
      }
    }

    let tradeResult;
    try {
      const orderResult = await this.coinbase.executeMarketOrder({
        productId: symbol,
        side:      action,
        quoteSize: safeAmount,
        feeRate:   this.wallet.feeRate,
      });

      if (action === 'BUY') {
        tradeResult = this.wallet.buy(symbol, safeAmount, orderResult);
      } else if (action === 'SELL') {
        tradeResult = this.wallet.sell(symbol, safeAmount, orderResult);
      }

      if (tradeResult?.success) {
        this.tradeCount++;

        const trade = {
          ...tradeResult.trade,
          confidence,
          reason,
          stop_loss:   orderResult.avg_fill_price * (1 - (stop_loss_pct  || 0.05)),
          take_profit: orderResult.avg_fill_price * (1 + (take_profit_pct || 0.10)),
        };

        await this.memory.recordTrade(trade);
        this.logger.trade(action, {
          symbol, amount: safeAmount,
          price:      orderResult.avg_fill_price,
          fee:        orderResult.fee,
          slippage:   orderResult.slippage_pct,
          confidence, reason,
        });
      }
    } catch (err) {
      this.logger.error(`Order fehlgeschlagen ${action} ${symbol}:`, err.message);
    }
    return tradeResult;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Stop-Loss / Take-Profit background monitor (runs every 30 s)
  // ───────────────────────────────────────────────────────────────────────────

  _startStopLossMonitor() {
    if (this._stopLossTimer) clearInterval(this._stopLossTimer);

    this._stopLossTimer = setInterval(async () => {
      if (!this.isRunning || this.isPaused) return;

      const portfolioState = this.wallet.getState();
      const positions      = portfolioState.positions || {};

      for (const [symbol, pos] of Object.entries(positions)) {
        if (!pos.quantity || pos.quantity <= 0) continue;

        let currentPrice;
        try {
          const md = await this.analyzer.getMarketData(symbol);
          currentPrice = md?.price;
        } catch { continue; }

        if (!currentPrice) continue;

        const sl = pos.stop_loss;
        const tp = pos.take_profit;
        let   reason = null;

        if (sl && currentPrice <= sl) {
          reason = `Stop-Loss ausgelöst: $${currentPrice.toFixed(2)} ≤ $${sl.toFixed(2)}`;
        } else if (tp && currentPrice >= tp) {
          reason = `Take-Profit ausgelöst: $${currentPrice.toFixed(2)} ≥ $${tp.toFixed(2)}`;
        }

        if (reason) {
          this.logger.warn(`🔴 ${symbol}: ${reason} — automatischer SELL`);
          try {
            // Sell the full position value
            const posValue = pos.quantity * currentPrice;
            const orderResult = await this.coinbase.executeMarketOrder({
              productId: symbol,
              side:      'SELL',
              quoteSize: posValue,
              feeRate:   this.wallet.feeRate,
            });

            const tradeResult = this.wallet.sell(symbol, posValue, orderResult);
            if (tradeResult?.success) {
              this.tradeCount++;
              const trade = { ...tradeResult.trade, confidence: 1.0, reason };
              await this.memory.recordTrade(trade);
              this.logger.trade('SELL', {
                symbol, amount: posValue,
                price:    orderResult.avg_fill_price,
                fee:      orderResult.fee,
                slippage: orderResult.slippage_pct,
                confidence: 1.0, reason,
              });
            }
          } catch (err) {
            this.logger.error(`Stop/TP Sell fehlgeschlagen ${symbol}:`, err.message);
          }
        }
      }
    }, this.config.stopLossCheckInterval);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Self-improvement (quality-gated, uses Sonnet for deeper analysis)
  // ───────────────────────────────────────────────────────────────────────────

  async selfImprove() {
    // Quality gate: minimum 5 SELLs for any improvement
    const sells = this.memory.getRecentTrades(200).filter(t => t.action === 'SELL');
    if (sells.length < 5) {
      this.logger.info(`⏸️ Strategie-Optimierung übersprungen: nur ${sells.length}/5 Sells in Epoche`);
      return;
    }

    const performance = this.getPerformanceMetrics();

    // Emergency switch: terrible performance after sufficient data
    const winRate = parseFloat(performance.win_rate) || 0;
    const sharpe  = parseFloat(performance.sharpe_ratio) || 0;
    const isEmergency = winRate === 0 || (winRate < 0.35 && sharpe < -1.0);

    if (isEmergency) {
      this.logger.warn(
        `🚨 Notfall-Strategiewechsel: WinRate=${(winRate * 100).toFixed(1)}% Sharpe=${sharpe.toFixed(2)}` +
        ` (Schwellen: 40% / -0.5) — Sonnet analysiert...`
      );
    } else {
      this.logger.info(`🧠 Strategie-Optimierung mit Sonnet (${sells.length} Sells, WinRate=${(winRate * 100).toFixed(1)}%)...`);
    }

    const recentTrades = this.memory.getRecentTrades(this.config.improvementCycle);
    const nextVersion  = this.memory.getStrategyVersion() + 1;

    const improvementPrompt = `Analyze ${recentTrades.length} trades and optimize the trading strategy.

SELLS ANALYSED: ${sells.length}
WIN RATE: ${(winRate * 100).toFixed(1)}%  SHARPE: ${sharpe.toFixed(2)}  MAX DRAWDOWN: ${performance.max_drawdown}%
EMERGENCY MODE: ${isEmergency}

RECENT TRADES (compact):
${recentTrades.map(t =>
  `${t.action} ${t.symbol} $${t.amount_usd?.toFixed(2)} @ $${t.price?.toFixed(2)} ` +
  `pnl=${t.realized_pnl?.toFixed(2) || '-'} conf=${t.confidence || '-'} reason="${(t.reason || '').substring(0, 60)}"`
).join('\n')}

CURRENT STRATEGY: ${JSON.stringify(this.currentStrategy?.rules || {})}

Tasks:
1. What patterns characterise winning vs. losing trades?
2. Are entry/exit timing signals optimal?
3. Should position sizing or risk parameters change?
4. If EMERGENCY MODE: propose a significantly different approach.

MANDATORY CONSTRAINTS for the new strategy:
- NO time-of-day or day-of-week restrictions. Crypto is 24/7.
- Circuit breakers must reset after max 30 minutes (not 2 hours).
- Consecutive loss limits: max 5 in a row, then 30-min wait only.
- Volume confirmation: preferred, but NOT a hard blocker. Use "preferred" language.
- Position sizes: $5–$25 per trade. Never $0.50 or $1 (too small, fee erosion).
- Do NOT create rules that result in 100% HOLD for extended periods.

Respond with improved strategy JSON only:
{
  "name": "Strategy v${nextVersion}",
  "version": ${nextVersion},
  "risk_profile": "conservative|balanced|aggressive",
  "improvement_summary": "what changed and why (max 200 chars)",
  "rules": {
    "entry_conditions": [],
    "exit_conditions": [],
    "position_sizing": {},
    "risk_rules": []
  },
  "expected_improvement": "predicted impact (max 100 chars)"
}`;

    // Always use Sonnet (completeStrategic) for strategy optimisation
    const response = await this.ai.completeStrategic({
      system: 'You are a quantitative trading strategy optimizer. Always respond with valid JSON only.',
      messages: [{ role: 'user', content: improvementPrompt }],
      responseFormat: 'json'
    });

    try {
      const newStrategy = JSON.parse(response);
      if (!this._validateStrategy(newStrategy)) {
        this.logger.warn('⚠️ Improved strategy failed schema validation — keeping current');
        return;
      }

      await this.memory.saveStrategy(newStrategy);
      this.currentStrategy = newStrategy;

      // Update risk profile to match new strategy
      this.riskProfile = _resolveRiskProfile(newStrategy);

      this.logger.info(`✅ Strategy improved: ${newStrategy.name} | Risk: ${this.riskProfile.label}`);
      this.logger.info(`📈 ${newStrategy.improvement_summary}`);
    } catch {
      this.logger.warn('Failed to parse improved strategy — keeping current');
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Performance & snapshot
  // ───────────────────────────────────────────────────────────────────────────

  getPerformanceMetrics() {
    const state          = this.wallet.getState();
    const initialBalance = this.wallet.initialBalance;

    return {
      total_return_pct:       ((state.totalValue - initialBalance) / initialBalance * 100).toFixed(2),
      total_trades:           this.tradeCount,
      win_rate:               this.memory.getWinRate(),
      avg_profit_per_trade:   this.memory.getAvgProfit(),
      max_drawdown:           this.memory.getMaxDrawdown(),
      sharpe_ratio:           this.memory.getSharpeRatio(),
      current_portfolio_value: state.totalValue,
      cash_balance:           state.cashBalance,
      positions:              state.positions
    };
  }

  recordPerformanceSnapshot() {
    const value = this.wallet.getState().totalValue;
    const entry = { timestamp: new Date().toISOString(), value };

    this.performanceHistory.push(entry);
    if (this.performanceHistory.length > 1000) this.performanceHistory.shift();

    this.db.saveSnapshot(value);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Fee rate update
  // ───────────────────────────────────────────────────────────────────────────

  async _updateFeeRate() {
    try {
      if (typeof this.coinbase.getFeeRate === 'function') {
        const fee = await this.coinbase.getFeeRate();
        this.wallet.setFeeRate(fee.taker);
        this.logger.info(
          `💸 Fee-Rate: ${(fee.taker * 100).toFixed(2)}% Taker / ${(fee.maker * 100).toFixed(2)}% Maker` +
          ` (${fee.tier} — Quelle: ${fee.source})`
        );
        this.db.setMeta('fee_taker',  fee.taker.toString());
        this.db.setMeta('fee_maker',  fee.maker.toString());
        this.db.setMeta('fee_tier',   fee.tier);
        this.db.setMeta('fee_source', fee.source);
      }
    } catch (err) {
      this.logger.warn('Fee-Rate konnte nicht geladen werden:', err.message);
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Schema validators
  // ───────────────────────────────────────────────────────────────────────────

  _validateDecisionResponse(parsed) {
    if (!parsed || typeof parsed !== 'object') return false;
    if (!Array.isArray(parsed.decisions)) return false;
    for (const d of parsed.decisions) {
      if (!['BUY', 'SELL', 'HOLD'].includes(d.action)) return false;
      if (typeof d.symbol !== 'string' || !d.symbol) return false;
      if (d.action !== 'HOLD') {
        if (typeof d.amount_usd !== 'number' || d.amount_usd <= 0) return false;
      }
      if (typeof d.confidence !== 'number' || d.confidence < 0 || d.confidence > 1) return false;
    }
    return true;
  }

  _validateStrategy(strategy) {
    if (!strategy || typeof strategy !== 'object') return false;
    if (typeof strategy.name !== 'string' || !strategy.name) return false;
    if (typeof strategy.version !== 'number') return false;
    if (!strategy.rules || typeof strategy.rules !== 'object') return false;
    return true;
  }

  sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
}

module.exports = { TradingAgent };
