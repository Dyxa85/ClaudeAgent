/**
 * Trading AI Agent - Core Engine
 * Autonomous crypto trading with Coinbase MCP + Claude AI
 */

const { AnthropicClient } = require('./anthropic-client');
const { PaperWallet, StrategyMemory, Logger } = require('./paper-wallet');
const { MarketAnalyzer } = require('./market-analyzer');
const { getPersistence } = require('./persistence');

class TradingAgent {
  constructor(config = {}) {
    this.config = {
      mode: config.mode || 'paper',          // 'paper' | 'live'
      symbols: config.symbols || ['BTC-USD', 'ETH-USD', 'SOL-USD'],
      initialBalance: config.initialBalance || 10000,
      maxPositionSize: config.maxPositionSize || 0.15, // 15% per position
      riskPerTrade: config.riskPerTrade || 0.02,       // 2% risk per trade
      improvementCycle: config.improvementCycle || 10, // Improve after N trades
      decisionInterval: config.decisionInterval || 60000, // 1 min
      ...config
    };

    this.db       = getPersistence();
    this.wallet   = new PaperWallet(this.config.initialBalance);
    this.memory   = new StrategyMemory();
    this.analyzer = new MarketAnalyzer();
    this.ai       = new AnthropicClient();
    this.logger   = new Logger();

    this.isRunning       = false;
    this.currentStrategy = null;

    // tradeCount und performanceHistory aus DB wiederherstellen
    this.tradeCount         = this.db.getTradeCount();
    this.performanceHistory = this.db.loadSnapshots(500);
  }

  get uptime() { return Math.floor(process.uptime()); }

  async start() {
    this.isRunning = true;
    this.logger.info('🚀 Trading Agent starting...', { mode: this.config.mode });

    // Kompletten Zustand aus DB laden
    await this.memory.load();
    this.currentStrategy    = await this.memory.getBestStrategy();
    this.tradeCount         = this.db.getTradeCount();
    this.performanceHistory = this.db.loadSnapshots(500);

    this.logger.info(`📊 Wiederhergestellt: ${this.tradeCount} Trades | Strategie: ${this.currentStrategy?.name || 'Default'}`);

    // Main trading loop
    while (this.isRunning) {
      try {
        await this.tradingCycle();
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
    
    // 2. Get portfolio state
    const portfolioState = this.wallet.getState();
    
    // 3. Get performance metrics
    const performance = this.getPerformanceMetrics();

    // 4. Ask AI for trading decisions
    const decisions = await this.getAIDecisions(marketData, portfolioState, performance);

    // 5. Execute decisions
    for (const decision of decisions) {
      await this.executeDecision(decision, marketData);
    }

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
      this.logger.info('🤖 AI decisions received:', parsed.decisions?.length || 0, 'actions');
      return parsed.decisions || [];
    } catch {
      this.logger.warn('Failed to parse AI response, skipping cycle');
      return [];
    }
  }

  buildSystemPrompt() {
    const strategyContext = this.currentStrategy 
      ? `Current best strategy: ${this.currentStrategy.name}\nRules: ${JSON.stringify(this.currentStrategy.rules)}`
      : 'No prior strategy - develop one based on market conditions';

    return `You are an autonomous crypto trading AI agent operating in ${this.config.mode.toUpperCase()} mode.

MISSION: Maximize risk-adjusted returns while protecting capital.

CONSTRAINTS:
- Max position size: ${(this.config.maxPositionSize * 100).toFixed(0)}% of portfolio
- Max risk per trade: ${(this.config.riskPerTrade * 100).toFixed(0)}% of portfolio
- Always maintain at least 20% cash reserve
- Never chase losses - stick to the strategy

${strategyContext}

RESPONSE FORMAT: Always respond with valid JSON only:
{
  "analysis": "brief market analysis",
  "decisions": [
    {
      "action": "BUY|SELL|HOLD",
      "symbol": "BTC-USD",
      "amount_usd": 500,
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
    const maxAllowed = portfolioState.totalValue * this.config.maxPositionSize;
    const safeAmount = Math.min(amount_usd, maxAllowed);

    try {
      let tradeResult;
      
      if (action === 'BUY') {
        tradeResult = this.wallet.buy(symbol, safeAmount, currentPrice);
      } else if (action === 'SELL') {
        tradeResult = this.wallet.sell(symbol, safeAmount, currentPrice);
      }

      if (tradeResult?.success) {
        this.tradeCount++;
        const trade = {
          id: `trade_${Date.now()}`,
          timestamp: new Date().toISOString(),
          action,
          symbol,
          amount_usd: safeAmount,
          price: currentPrice,
          confidence,
          reason,
          stop_loss: currentPrice * (1 - (stop_loss_pct || 0.05)),
          take_profit: currentPrice * (1 + (take_profit_pct || 0.10)),
          portfolio_value: this.wallet.getState().totalValue
        };

        await this.memory.recordTrade(trade);
        
        this.logger.trade(action, {
          symbol,
          amount: safeAmount,
          price: currentPrice,
          confidence,
          reason
        });
      }
    } catch (err) {
      this.logger.error(`Failed to execute ${action} ${symbol}:`, err.message);
    }
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
    const initialBalance = this.config.initialBalance;
    
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

  stop() {
    this.isRunning = false;
    this.logger.info('🛑 Trading Agent stopped');
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = { TradingAgent };
