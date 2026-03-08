/**
 * Trading Agent — Main Entry Point
 * Node.js + Coinbase + Claude AI + Telegram
 */

require('dotenv').config();

const http = require('http');
const { TradingAgent } = require('./src/agent');
const { TelegramBot } = require('./src/telegram-bot');

const CONFIG = {
  mode: process.env.TRADING_MODE || 'paper',
  symbols: (process.env.SYMBOLS || 'BTC-USD,ETH-USD,SOL-USD').split(','),
  initialBalance: parseFloat(process.env.INITIAL_BALANCE || '10000'),
  maxPositionSize: parseFloat(process.env.MAX_POSITION_SIZE || '0.15'),
  riskPerTrade: parseFloat(process.env.RISK_PER_TRADE || '0.02'),
  improvementCycle: parseInt(process.env.IMPROVEMENT_CYCLE || '10'),
  decisionInterval: parseInt(process.env.DECISION_INTERVAL || '60000'),
  dashboardPort: parseInt(process.env.DASHBOARD_PORT || '3000'),
  coinbaseApiKey: process.env.COINBASE_API_KEY,
  coinbaseApiSecret: process.env.COINBASE_API_SECRET,
};

const telegram = new TelegramBot({
  token: process.env.TELEGRAM_BOT_TOKEN,
  chatId: process.env.TELEGRAM_CHAT_ID,
  dailyReportTime: process.env.DAILY_REPORT_TIME || '08:00',
});

const agent = new TradingAgent(CONFIG);

// Patch agent to send Telegram alerts on trades
const _exec = agent.executeDecision.bind(agent);
agent.executeDecision = async (decision, marketData) => {
  const result = await _exec(decision, marketData);
  if (decision.action !== 'HOLD' && result?.success) {
    const trade = agent.memory.getRecentTrades(1)[0];
    if (trade) await telegram.alertTrade({ ...trade, ...decision });
  }
  return result;
};

// Patch self-improvement
const _improve = agent.selfImprove.bind(agent);
agent.selfImprove = async () => {
  await _improve();
  if (agent.currentStrategy) await telegram.alertStrategyImproved(agent.currentStrategy);
};

// Drawdown monitoring
let lastDDAlert = 0;
const _snapshot = agent.recordPerformanceSnapshot.bind(agent);
agent.recordPerformanceSnapshot = () => {
  _snapshot();
  const dd = parseFloat(agent.getPerformanceMetrics().max_drawdown);
  if (dd > 5 && Date.now() - lastDDAlert > 3600000) {
    lastDDAlert = Date.now();
    telegram.alertDrawdown(dd, agent.wallet.getState().totalValue);
  }
};

// Dashboard API
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-cache');

  const routes = {
    '/api/status': () => ({ running: agent.isRunning, mode: CONFIG.mode, tradeCount: agent.tradeCount, strategy: agent.currentStrategy?.name || 'Default', uptime: Math.floor(process.uptime()), telegram: telegram.enabled }),
    '/api/portfolio': () => agent.wallet.getState(),
    '/api/performance': () => agent.getPerformanceMetrics(),
    '/api/trades': () => agent.memory.getRecentTrades(50),
    '/api/logs': () => agent.logger.getRecent(100),
    '/api/strategy': () => ({ current: agent.currentStrategy, history: agent.memory.strategies, version: agent.memory.getStrategyVersion() }),
    '/api/history': () => agent.db.loadSnapshots(200),
    '/api/health':   () => ({ ok: true, ts: Date.now() }),
    '/api/db-stats': () => agent.db.getStats(),
  };

  const handler = routes[req.url];
  if (handler) res.end(JSON.stringify(handler()));
  else { res.statusCode = 404; res.end(JSON.stringify({ error: 'Not found' })); }
});

server.listen(CONFIG.dashboardPort, () => {
  console.log(`📊 Dashboard API: http://localhost:${CONFIG.dashboardPort}`);
});

async function main() {
  await telegram.alertAgentStarted({ ...CONFIG, strategy: agent.currentStrategy?.name });
  telegram.startPolling(agent).catch(console.error);
  agent.start().catch(async (err) => {
    await telegram.alertAgentError(err.message);
    process.exit(1);
  });
}

async function shutdown() {
  agent.stop();
  telegram.stopPolling();
  const state = agent.wallet.getState();
  await telegram.send(`🛑 <b>Agent gestoppt</b>\n💼 $${state.totalValue.toFixed(2)} | ${state.totalReturnPct > 0 ? '+' : ''}${state.totalReturnPct}%`);
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
main();
