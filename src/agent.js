/**
 * Trading AI Agent - Core Engine
 * Autonomous crypto trading with Coinbase MCP + Claude AI
 */

const { AnthropicClient } = require('./anthropic-client');
const { PaperWallet, StrategyMemory, Logger } = require('./paper-wallet');
const { MarketAnalyzer } = require('./market-analyzer');
const { CoinbaseClient } = require('./coinbase-client');
const { getPersistence } = require('./persistence');

class TradingAgent {
  constructor(config = {}) {
    this.config = {
      mode: config.mode || 'paper',          // 'paper' | 'live'
      symbols: config.symbols || ['BTC-USD', 'ETH-USD', 'SOL-USD'],
      initialBalance: config.initialBalance || 10000,
      maxPositionSize: config.maxPositionSize || 0.15,       // 15% per position
      riskPerTrade: config.riskPerTrade || 0.02,             // 2% risk per trade
      improvementCycle: config.improvementCycle || 10,       // Improve after N trades
      decisionInterval: config.decisionInterval || 60000,    // 1 min
      circuitBreakerDrawdown: config.circuitBreakerDrawdown || 20, // Pause bei 20% Drawdown
      ...config
    };

    this.db       = getPersistence();

    // Einziger Coinbase Client — Paper und Live nutzen denselben
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

    this.isRunning       = false;
    this.isPaused        = false;
    this.currentStrategy = null;
    this.onCircuitBreaker = null; // Callback: (drawdownPct, portfolioValue) => void

    // tradeCount und performanceHistory aus DB wiederherstellen
    this.tradeCount         = this.db.getTradeCount();
    this.performanceHistory = this.db.loadSnapshots(500);
  }

  get uptime() { return Math.floor(process.uptime()); }

  async start() {
    this.isRunning = true;
    this.logger.info('🚀 Trading Agent starting...', { mode: this.config.mode });

    // Symbole aus DB laden falls Coinbase-Sync bereits lief (index.js setzt sie)
    const savedSymbols = this.db.getMeta('coinbase_symbols');
    if (savedSymbols) {
      try {
        const parsed = JSON.parse(savedSymbols);
        if (Array.isArray(parsed) && parsed.length > 0) {
          this.config.symbols = parsed;
          this.logger.info(`🔍 Symbole aus Coinbase Portfolio: ${parsed.join(', ')}`);
        }
      } catch { /* behalte Default-Symbole */ }
    }

    // Fee-Rate von Coinbase API holen (live oder bekannter Tier-Schedule)
    await this._updateFeeRate();

    // Kompletten Zustand aus DB laden
    await this.memory.load();
    this.currentStrategy    = await this.memory.getBestStrategy();
    this.tradeCount         = this.db.getTradeCount();
    this.performanceHistory = this.db.loadSnapshots(500);

    this.logger.info(`📊 Wiederhergestellt: ${this.tradeCount} Trades | Strategie: ${this.currentStrategy?.name || 'Default'}`);

    // Main trading loop
    while (this.isRunning) {
      // Pause-Check: warten bis resume() aufgerufen wird
      if (this.isPaused) {
        await this.sleep(5000);
        continue;
      }

      try {
        await this.tradingCycle();

        // Fee-Rate täglich neu von API holen (Volumen-Tier kann sich ändern)
        this._cycleCount = (this._cycleCount || 0) + 1;
        const cyclesPerDay = Math.floor(86400000 / this.config.decisionInterval);
        if (this._cycleCount % cyclesPerDay === 0) {
          await this._updateFeeRate();
        }

        await this.sleep(this.config.decisionInterval);
      } catch (err) {
        this.logger.error('Trading cycle error:', err.message);
        await this.sleep(5000);
      }
    }
  }

  async tradingCycle() {
    this.logger.info('⚡ Running trading cycle...');

    // 1. Gather market data for all symbols
    const marketData = await this.gatherMarketData();
    
    // 1b. Warn if simulated data is being used
    const simulated = Object.values(marketData).filter(d => d._source === 'simulated_fallback');
    if (simulated.length > 0) {
      this.logger.warn(`⚠️  Simulierte Daten für: ${simulated.map(d => d.symbol).join(', ')} — Coinbase API nicht erreichbar`);
    }

    // 2. Get portfolio state
    const portfolioState = this.wallet.getState();
    
    // 3. Get performance metrics
    const performance = this.getPerformanceMetrics();

    // 3b. Circuit Breaker: Trading pausieren bei zu hohem Drawdown
    const drawdownPct = parseFloat(performance.max_drawdown || 0);
    if (drawdownPct >= this.config.circuitBreakerDrawdown) {
      this.isPaused = true;
      this.logger.warn(`🚨 CIRCUIT BREAKER! Drawdown ${drawdownPct}% >= ${this.config.circuitBreakerDrawdown}% — Trading pausiert. /resume zum Fortsetzen.`);
      if (typeof this.onCircuitBreaker === 'function') {
        this.onCircuitBreaker(drawdownPct, this.wallet.getState().totalValue);
      }
      return;
    }

    // 4. Ask AI for trading decisions
    const decisions = await this.getAIDecisions(marketData, portfolioState, performance);

    // 5. Execute decisions in parallel (unabhängige Orders für verschiedene Symbole)
    await Promise.all(decisions.map(d => this.executeDecision(d, marketData)));

    // 6. Self-improvement cycle
    if (this.tradeCount > 0 && this.tradeCount % this.config.improvementCycle === 0) {
      await this.selfImprove();
    }

    // 7. Log performance snapshot
    this.recordPerformanceSnapshot();
  }

  async gatherMarketData() {
    const data = {};
    for (const symbol of this.config.symbols) {
      data[symbol] = await this.analyzer.getMarketData(symbol);
    }
    return data;
  }

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
      this.logger.warn('Failed to parse AI response, skipping cycle');
      return [];
    }
  }

  buildSystemPrompt() {
    const strategyContext = this.currentStrategy
      ? `Current best strategy: ${this.currentStrategy.name}\nRules: ${JSON.stringify(this.currentStrategy.rules)}`
      : 'No prior strategy - develop one based on market conditions';

    // Echtes Coinbase Portfolio als Kontext
    const cbPortfolioUSD = parseFloat(this.db.getMeta('coinbase_portfolio_usd', '0'));
    const cbHoldings     = JSON.parse(this.db.getMeta('coinbase_holdings_json', '[]'));
    const cbPortfolioCtx = cbPortfolioUSD > 0
      ? `\nREAL COINBASE PORTFOLIO (reference, read-only):\n` +
        `- Total: $${cbPortfolioUSD.toFixed(2)}\n` +
        cbHoldings.map(h => `- ${h.asset}: ${h.quantity.toFixed(6)} units @ avg $${h.avg_price.toFixed(2)} = $${h.value_usd.toFixed(2)}`).join('\n') +
        `\nThis paper trading session SIMULATES performance on these exact holdings.\n` +
        `Only trade symbols that match the real portfolio: ${this.config.symbols.join(', ')}`
      : '';

    // Aktuell Epoche — AI soll nur Daten dieser Epoche berücksichtigen
    const epoch      = this.db.getCurrentEpoch();
    const epochId    = this.db.getCurrentEpochId();
    const epochStart = epoch ? epoch.started_at.replace('T', ' ').substring(0, 16) : 'unknown';
    const epochCtx   = `\nDATA EPOCH: #${epochId} (started ${epochStart} UTC, reason: ${epoch?.reason || 'initial'})` +
      `\nIMPORTANT: All trade history, performance metrics, and strategy data shown to you belongs to this epoch only.` +
      `\nDo NOT reference or infer from previous epochs — they used different symbols or capital bases.\n`;

    return `You are an autonomous crypto trading AI agent operating in ${this.config.mode.toUpperCase()} mode.

MISSION: Maximize risk-adjusted returns while protecting capital.

CONSTRAINTS:
- Tradeable symbols: ${this.config.symbols.join(', ')}
- Max position size: ${(this.config.maxPositionSize * 100).toFixed(0)}% of portfolio
- Max risk per trade: ${(this.config.riskPerTrade * 100).toFixed(0)}% of portfolio
- Always maintain at least 20% cash reserve (enforced in code — never suggest orders that breach this)
- Never chase losses - stick to the strategy
${cbPortfolioCtx}
${epochCtx}
${strategyContext}

RESPONSE FORMAT: Always respond with valid JSON only:
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
  "strategy_notes": "any observations to improve strategy"
}`;
  }

  buildDecisionPrompt(marketData, portfolioState, performance) {
    return `CURRENT MARKET DATA:
${JSON.stringify(marketData, null, 2)}

PORTFOLIO STATE:
${JSON.stringify(portfolioState, null, 2)}

PERFORMANCE METRICS:
${JSON.stringify(performance, null, 2)}

RECENT TRADE HISTORY:
${JSON.stringify(this.memory.getRecentTrades(10), null, 2)}

Analyze the market and make trading decisions. Consider:
1. Current price trends and momentum
2. Portfolio balance and risk exposure
3. Recent trade performance (learn from wins/losses)
4. Market volatility and sentiment indicators

Make decisive, well-reasoned trades. If market conditions are unclear, HOLD is valid.`;
  }

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

    // Validate decision
    if (confidence < 0.5) {
      this.logger.info(`⏸️ Skipping ${action} ${symbol} - confidence too low (${confidence})`);
      return;
    }

    const portfolioState = this.wallet.getState();
    const maxAllowed     = portfolioState.totalValue * this.config.maxPositionSize;
    let   safeAmount     = Math.min(amount_usd, maxAllowed);

    // 20% Cash Reserve Enforcement — BUY darf diese Grenze nicht unterschreiten
    if (action === 'BUY') {
      const minCashReserve  = portfolioState.totalValue * 0.20;
      const cashAfterBuy    = portfolioState.cashBalance - safeAmount;
      if (cashAfterBuy < minCashReserve) {
        safeAmount = Math.max(0, portfolioState.cashBalance - minCashReserve);
        if (safeAmount < 10) {
          this.logger.warn(
            `⚠️ BUY ${symbol} übersprungen: 20% Cash Reserve würde unterschritten` +
            ` ($${portfolioState.cashBalance.toFixed(2)} verfügbar, Reserve: $${minCashReserve.toFixed(2)})`
          );
          return;
        }
        this.logger.info(`📉 BUY-Betrag auf $${safeAmount.toFixed(2)} reduziert (20% Cash Reserve Schutz)`);
      }
    }

    let tradeResult;
    try {
      // Echte Order via Coinbase API (Paper: simuliert, Live: real)
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

        // Trade mit allen Coinbase-Details (Fee, Slippage, Fill-Preis) speichern
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
          price: orderResult.avg_fill_price,
          fee: orderResult.fee,
          slippage: orderResult.slippage_pct,
          confidence, reason,
        });
      }
    } catch (err) {
      this.logger.error(`Order fehlgeschlagen ${action} ${symbol}:`, err.message);
    }
    return tradeResult;
  }

  async selfImprove() {
    this.logger.info('🧠 Running self-improvement cycle...');
    
    const recentTrades = this.memory.getRecentTrades(this.config.improvementCycle);
    const performance = this.getPerformanceMetrics();
    
    const improvementPrompt = `Analyze these ${recentTrades.length} trades and improve the trading strategy.

RECENT TRADES:
${JSON.stringify(recentTrades, null, 2)}

PERFORMANCE METRICS:
${JSON.stringify(performance, null, 2)}

CURRENT STRATEGY:
${JSON.stringify(this.currentStrategy, null, 2)}

Identify:
1. What patterns led to winning trades?
2. What caused losing trades?
3. Are there better entry/exit timing signals?
4. Should position sizing be adjusted?
5. Are there untapped opportunities?

Respond with improved strategy as JSON:
{
  "name": "Strategy v${(this.memory.getStrategyVersion() + 1)}",
  "version": ${this.memory.getStrategyVersion() + 1},
  "improvement_summary": "what changed and why",
  "rules": {
    "entry_conditions": [],
    "exit_conditions": [],
    "position_sizing": {},
    "risk_rules": []
  },
  "expected_improvement": "predicted impact on performance"
}`;

    const response = await this.ai.complete({
      system: 'You are a quantitative trading strategy optimizer. Always respond with valid JSON only.',
      messages: [{ role: 'user', content: improvementPrompt }],
      responseFormat: 'json'
    });

    try {
      const newStrategy = JSON.parse(response);
      if (!this._validateStrategy(newStrategy)) {
        this.logger.warn('⚠️ Improved strategy failed schema validation, keeping current strategy');
        return;
      }
      await this.memory.saveStrategy(newStrategy);
      this.currentStrategy = newStrategy;

      this.logger.info('✅ Strategy improved:', newStrategy.name);
      this.logger.info('📈 Improvement summary:', newStrategy.improvement_summary);
    } catch {
      this.logger.warn('Failed to parse improved strategy');
    }
  }

  getPerformanceMetrics() {
    const state = this.wallet.getState();
    const initialBalance = this.wallet.initialBalance;
    
    return {
      total_return_pct: ((state.totalValue - initialBalance) / initialBalance * 100).toFixed(2),
      total_trades: this.tradeCount,
      win_rate: this.memory.getWinRate(),
      avg_profit_per_trade: this.memory.getAvgProfit(),
      max_drawdown: this.memory.getMaxDrawdown(),
      sharpe_ratio: this.memory.getSharpeRatio(),
      current_portfolio_value: state.totalValue,
      cash_balance: state.cashBalance,
      positions: state.positions
    };
  }

  recordPerformanceSnapshot() {
    const value = this.wallet.getState().totalValue;
    const entry = { timestamp: new Date().toISOString(), value };

    // In-Memory für den API-Endpunkt
    this.performanceHistory.push(entry);
    if (this.performanceHistory.length > 1000) this.performanceHistory.shift();

    // In DB persistieren (handled by updatePrices alle 10 Zyklen,
    // aber hier auch direkt nach jedem Zyklus)
    this.db.saveSnapshot(value);
  }

  async _updateFeeRate() {
    try {
      const coinbase = this.coinbase;
      if (typeof coinbase.getFeeRate === 'function') {
        const fee = await coinbase.getFeeRate();
        this.wallet.setFeeRate(fee.taker);
        this.logger.info(
          `💸 Fee-Rate: ${(fee.taker * 100).toFixed(2)}% Taker / ${(fee.maker * 100).toFixed(2)}% Maker` +
          ` (${fee.tier} — Quelle: ${fee.source})`
        );
        // Fee-Tier in DB speichern für Logs
        this.db.setMeta('fee_taker', fee.taker.toString());
        this.db.setMeta('fee_maker', fee.maker.toString());
        this.db.setMeta('fee_tier',  fee.tier);
        this.db.setMeta('fee_source', fee.source);
      }
    } catch (err) {
      this.logger.warn('Fee-Rate konnte nicht geladen werden:', err.message);
    }
  }

  pause() {
    this.isPaused = true;
    this.logger.info('⏸️ Agent pausiert (manuell)');
  }

  resume() {
    this.isPaused = false;
    this.logger.info('▶️ Agent fortgesetzt');
  }

  stop() {
    this.isRunning = false;
    this.logger.info('🛑 Trading Agent stopped');
  }

  /**
   * Validiert die JSON-Antwort von Claude für Trading-Entscheidungen.
   * Verhindert, dass fehlerhafte AI-Responses zu falschen Orders führen.
   */
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

  /**
   * Validiert das JSON-Objekt einer neuen Strategie von Claude.
   */
  _validateStrategy(strategy) {
    if (!strategy || typeof strategy !== 'object') return false;
    if (typeof strategy.name !== 'string' || !strategy.name) return false;
    if (typeof strategy.version !== 'number') return false;
    if (!strategy.rules || typeof strategy.rules !== 'object') return false;
    return true;
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = { TradingAgent };
