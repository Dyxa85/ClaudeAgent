/**
 * Trading Agent — Main Entry Point
 * Node.js + Coinbase + Claude AI + Telegram
 */

require('dotenv').config();

const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { TradingAgent } = require('./src/agent');
const { TelegramBot }  = require('./src/telegram-bot');

// ─── Session Auth (replaces nginx basic auth — works on iOS Safari) ──────────

const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || 'trader';
const sessions           = new Map(); // sessionId → expiresAt

function _createSession() {
  const id = crypto.randomBytes(16).toString('hex');
  sessions.set(id, Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
  return id;
}

function _isAuthenticated(req) {
  const cookie = req.headers.cookie || '';
  const match  = cookie.match(/sid=([a-f0-9]{32})/);
  if (!match) return false;
  const expiry = sessions.get(match[1]);
  if (!expiry || expiry < Date.now()) { sessions.delete(match && match[1]); return false; }
  return true;
}

function _parsePOSTBody(req) {
  return new Promise(resolve => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end',  ()    => { resolve(Object.fromEntries(new URLSearchParams(body))); });
  });
}

const LOGIN_HTML = `<!DOCTYPE html><html lang="de">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Trading Agent — Login</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#0f1117;display:flex;align-items:center;justify-content:center;min-height:100vh;font-family:-apple-system,sans-serif}
  .card{background:#1a1d27;border:1px solid #2a2d3a;border-radius:16px;padding:40px;width:100%;max-width:360px;text-align:center}
  h1{color:#fff;font-size:1.4rem;margin-bottom:8px}
  p{color:#888;font-size:.85rem;margin-bottom:28px}
  input{width:100%;background:#0f1117;border:1px solid #2a2d3a;border-radius:8px;color:#fff;font-size:1rem;padding:12px 14px;outline:none;margin-bottom:16px;transition:border .2s}
  input:focus{border-color:#3b82f6}
  button{width:100%;background:#3b82f6;border:none;border-radius:8px;color:#fff;cursor:pointer;font-size:1rem;font-weight:600;padding:12px;transition:background .2s}
  button:hover{background:#2563eb}
  .err{color:#ef4444;font-size:.85rem;margin-top:12px;display:none}
  .err.show{display:block}
</style></head>
<body><div class="card">
  <h1>📊 Trading Agent</h1>
  <p>Passwort eingeben um fortzufahren</p>
  <form method="POST" action="/login">
    <input type="password" name="password" placeholder="Passwort" autofocus autocomplete="current-password">
    <button type="submit">Einloggen</button>
    <div class="err" id="err">__ERR__</div>
  </form>
</div></body></html>`;

const CONFIG = {
  mode:                  process.env.TRADING_MODE    || 'paper',
  symbols:               (process.env.SYMBOLS        || 'BTC-USD,ETH-USD,SOL-USD').split(','),
  initialBalance:        parseFloat(process.env.INITIAL_BALANCE        || '10000'),
  maxPositionSize:       parseFloat(process.env.MAX_POSITION_SIZE      || '0.15'),
  riskPerTrade:          parseFloat(process.env.RISK_PER_TRADE         || '0.02'),
  improvementCycle:      parseInt(process.env.IMPROVEMENT_CYCLE        || '10'),
  decisionInterval:      parseInt(process.env.DECISION_INTERVAL        || '60000'),
  circuitBreakerDrawdown:parseFloat(process.env.CIRCUIT_BREAKER_DRAWDOWN || '20'),
  dashboardPort:         parseInt(process.env.DASHBOARD_PORT           || '3000'),
  coinbaseApiKey:        process.env.COINBASE_API_KEY,
  coinbaseApiSecret:     process.env.COINBASE_API_SECRET,
};

const telegram = new TelegramBot({
  token:          process.env.TELEGRAM_BOT_TOKEN,
  chatId:         process.env.TELEGRAM_CHAT_ID,
  dailyReportTime:process.env.DAILY_REPORT_TIME || '08:00',
});

const agent = new TradingAgent(CONFIG);

// ─── Telegram Hooks ─────────────────────────────────────────────────────────

const _exec = agent.executeDecision.bind(agent);
agent.executeDecision = async (decision, marketData) => {
  const result = await _exec(decision, marketData);
  if (decision.action !== 'HOLD' && result?.success) {
    const trade = agent.memory.getRecentTrades(1)[0];
    if (trade) await telegram.alertTrade({ ...trade, ...decision });
  }
  return result;
};

const _improve = agent.selfImprove.bind(agent);
agent.selfImprove = async () => {
  await _improve();
  if (agent.currentStrategy) await telegram.alertStrategyImproved(agent.currentStrategy);
};

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

agent.onCircuitBreaker = async (drawdownPct, portfolioValue) => {
  const eur = portfolioValue * _eurUSD;
  await telegram.send(`🚨 <b>CIRCUIT BREAKER ausgelöst!</b>

📉 Drawdown: <b>${drawdownPct.toFixed(2)}%</b> (Limit: ${CONFIG.circuitBreakerDrawdown}%)
💼 Portfolio: €${eur.toFixed(2)}

⏸️ <b>Trading wurde automatisch pausiert.</b>
Sende /resume um fortzufahren — oder prüfe zuerst die Marktlage!`);
};

// ─── EUR/USD Rate Cache ──────────────────────────────────────────────────────

let _eurUSD = parseFloat(agent.db.getMeta('eur_usd_rate', '0.92'));

async function _refreshEURRate() {
  try {
    const rate = await agent.coinbase.getEURUSDRate();
    if (rate > 0) {
      _eurUSD = rate;
      agent.db.setMeta('eur_usd_rate', rate.toString());
    }
  } catch { /* keep cached value */ }
}

// ─── Coinbase Portfolio Sync ─────────────────────────────────────────────────

async function syncCoinbasePortfolio() {
  try {
    const portfolios = await agent.coinbase.getPortfolios();
    if (!portfolios.length) return;

    // Priorisiere "Trading Bot" Portfolio, sonst erstes
    const target = portfolios.find(p =>
      p.name?.toLowerCase().includes('trading') || p.name?.toLowerCase().includes('bot')
    ) || portfolios[0];

    if (!target) return;

    const breakdown = await agent.coinbase.getPortfolioBreakdown(target.uuid);
    const balances  = breakdown?.portfolio_balances;
    if (!balances) return;

    const totalUSD = parseFloat(balances.total_balance?.value || 0);
    const totalEUR = totalUSD * _eurUSD;

    // Erkenne welche Crypto-Assets im Portfolio vorhanden sind
    const holdings = await agent.coinbase.getCryptoHoldings(target.uuid);
    const symbols  = holdings.map(h => h.symbol);

    agent.db.setMeta('coinbase_portfolio_id',      target.uuid);
    agent.db.setMeta('coinbase_portfolio_name',    target.name);
    agent.db.setMeta('coinbase_portfolio_usd',     totalUSD.toFixed(4));
    agent.db.setMeta('coinbase_portfolio_eur',     totalEUR.toFixed(4));
    agent.db.setMeta('coinbase_portfolio_ts',      new Date().toISOString());
    agent.db.setMeta('coinbase_holdings_json',     JSON.stringify(holdings));

    if (symbols.length > 0) {
      agent.db.setMeta('coinbase_symbols', JSON.stringify(symbols));
      // Agent sofort auf echte Symbole umstellen
      agent.config.symbols = symbols;
      console.log(`🔍 Symbole aus Coinbase Portfolio: ${symbols.join(', ')}`);
    }

    console.log(`💼 Coinbase Portfolio "${target.name}": $${totalUSD.toFixed(2)} | €${totalEUR.toFixed(2)} | Assets: ${symbols.join(', ') || 'nur Cash'}`);
  } catch (err) {
    console.warn(`⚠️  Coinbase Portfolio Sync: ${err.message}`);
  }
}

// ─── Dashboard HTTP Server ───────────────────────────────────────────────────

const PUBLIC_DIR = path.join(__dirname, 'public');

const server = http.createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

  // ── Auth: /api/health is always public ───────────────────────────────────
  const isHealthCheck = req.url === '/api/health';
  if (!isHealthCheck) {

    // ── Login page ──────────────────────────────────────────────────────────
    if (req.url === '/login' && req.method === 'GET') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(LOGIN_HTML.replace('__ERR__', ''));
      return;
    }

    if (req.url === '/login' && req.method === 'POST') {
      const body = await _parsePOSTBody(req);
      if (body.password === DASHBOARD_PASSWORD) {
        const sid = _createSession();
        res.setHeader('Set-Cookie', `sid=${sid}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${7*24*3600}`);
        res.setHeader('Location', '/');
        res.statusCode = 302;
        res.end();
      } else {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(LOGIN_HTML.replace('style="display:none"', '').replace('__ERR__', 'Falsches Passwort'));
      }
      return;
    }

    // ── Redirect to login if not authenticated ──────────────────────────────
    if (!_isAuthenticated(req)) {
      res.setHeader('Location', '/login');
      res.statusCode = 302;
      res.end();
      return;
    }
  }

  // ── Static File Serving ──────────────────────────────────────────────────
  if (!req.url.startsWith('/api/')) {
    const filePath = path.join(PUBLIC_DIR, req.url === '/' ? 'index.html' : req.url);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath);
      const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
                     '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
      res.setHeader('Content-Type', mime[ext] || 'text/plain');
      res.end(fs.readFileSync(filePath));
    } else {
      res.setHeader('Content-Type', 'text/html');
      res.end(fs.readFileSync(path.join(PUBLIC_DIR, 'index.html')));
    }
    return;
  }

  // ── API Routes ────────────────────────────────────────────────────────────
  res.setHeader('Content-Type', 'application/json');

  // POST /api/sync-wallet → Paper Wallet auf Coinbase Portfolio zurücksetzen + neue Epoche
  if (req.method === 'POST' && req.url === '/api/sync-wallet') {
    syncWalletToCoinbase()
      .then(result => res.end(JSON.stringify(result)))
      .catch(err   => { res.statusCode = 500; res.end(JSON.stringify({ error: err.message })); });
    return;
  }

  // POST /api/new-epoch — Neue Daten-Epoche starten (alte bleibt als Archiv erhalten)
  if (req.method === 'POST' && req.url === '/api/new-epoch') {
    (async () => {
      try {
        const body   = await _parsePOSTBody(req);
        const reason = body.reason || 'manual';
        const label  = body.label  || null;
        const newId  = agent.db.startNewEpoch({
          reason,
          label: label || `Epoche — ${new Date().toISOString().substring(0, 10)}`,
          initialBalance: agent.wallet.initialBalance,
        });
        // Strategie-Versionsstring nicht resetten — läuft weiter;
        // aber tradeCount und performanceHistory neu laden
        agent.tradeCount         = agent.db.getTradeCount();
        agent.performanceHistory = agent.db.loadSnapshots(500);
        console.log(`🆕 API: Neue Epoche ${newId} gestartet (${reason})`);
        res.end(JSON.stringify({ ok: true, epoch_id: newId, reason }));
      } catch (err) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: err.message }));
      }
    })();
    return;
  }

  const routes = {
    '/api/status': () => {
      const epoch = agent.db.getCurrentEpoch();
      return {
        running:     agent.isRunning,
        paused:      agent.isPaused,
        mode:        CONFIG.mode,
        initialBalance: agent.wallet.initialBalance,
        tradeCount:  agent.tradeCount,
        strategy:    agent.currentStrategy?.name || 'Default',
        uptime:      Math.floor(process.uptime()),
        telegram:    telegram.enabled,
        circuitBreaker: { drawdownLimit: CONFIG.circuitBreakerDrawdown },
        fee: {
          taker:       agent.wallet.feeRate,
          taker_pct:   (agent.wallet.feeRate * 100).toFixed(2) + '%',
          total_paid:  agent.wallet.totalFeePaid,
          tier:        agent.db.getMeta('fee_tier',    'unknown'),
          source:      agent.db.getMeta('fee_source',  'unknown'),
        },
        epoch: {
          id:      agent.db.getCurrentEpochId(),
          started: epoch?.started_at || null,
          reason:  epoch?.reason     || null,
          label:   epoch?.label      || null,
        },
      };
    },

    '/api/portfolio':          () => agent.wallet.getState(),
    '/api/performance':        () => agent.getPerformanceMetrics(),
    '/api/trades':             () => agent.memory.getRecentTrades(50),
    '/api/logs':               () => agent.logger.getRecent(100),
    '/api/strategy':           () => ({ current: agent.currentStrategy, history: agent.memory.strategies, version: agent.memory.getStrategyVersion() }),
    '/api/history':            () => agent.db.loadSnapshots(200),
    '/api/health':             () => ({ ok: true, ts: Date.now() }),
    '/api/db-stats':           () => agent.db.getStats(),
    '/api/epochs':             () => agent.db.getAllEpochs(),

    '/api/rates': () => ({
      eur_usd:  _eurUSD,
      usd_eur:  parseFloat((1 / _eurUSD).toFixed(6)),
      ts:       Date.now(),
    }),

    '/api/coinbase-portfolio': () => ({
      id:       agent.db.getMeta('coinbase_portfolio_id'),
      name:     agent.db.getMeta('coinbase_portfolio_name', 'Trading Bot'),
      usd:      parseFloat(agent.db.getMeta('coinbase_portfolio_usd', '0')),
      eur:      parseFloat(agent.db.getMeta('coinbase_portfolio_eur', '0')),
      updated:  agent.db.getMeta('coinbase_portfolio_ts'),
      holdings: JSON.parse(agent.db.getMeta('coinbase_holdings_json', '[]')),
      symbols:  JSON.parse(agent.db.getMeta('coinbase_symbols', '[]')),
    }),
  };

  const handler = routes[req.url];
  if (handler) {
    res.end(JSON.stringify(handler()));
  } else {
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'Not found' }));
  }
});

// ─── Wallet Reset auf Coinbase Portfolio-Wert ────────────────────────────────

async function syncWalletToCoinbase() {
  await _refreshEURRate();
  await syncCoinbasePortfolio();

  const totalUSD = parseFloat(agent.db.getMeta('coinbase_portfolio_usd', '0'));
  if (totalUSD <= 0) {
    throw new Error('Kein Coinbase Portfolio-Wert verfügbar. API-Key prüfen.');
  }

  const portfolioId = agent.db.getMeta('coinbase_portfolio_id');
  const holdingsRaw = agent.db.getMeta('coinbase_holdings_json', '[]');
  const holdings    = JSON.parse(holdingsRaw);

  // ── Echte Asset-Positionen für Paper Wallet aufbauen ──────────────────────
  const paperPositions = {};
  let   investedUSD    = 0;

  for (const holding of holdings) {
    if (holding.quantity <= 0) continue;
    // Aktuellen Preis holen für korrekte Bewertung
    let currentPrice = holding.avg_price; // Fallback
    try {
      const ticker  = await agent.coinbase.getTicker(holding.symbol);
      currentPrice  = ticker.price;
    } catch { /* weiter mit avg_price als Fallback */ }

    const currentValue = holding.quantity * currentPrice;
    paperPositions[holding.symbol] = {
      quantity:       holding.quantity,
      avg_price:      holding.avg_price || currentPrice,
      cost_basis:     holding.avg_price > 0
                        ? holding.quantity * holding.avg_price
                        : currentValue,
      current_price:  currentPrice,
      current_value:  currentValue,
      unrealized_pnl: holding.avg_price > 0
                        ? currentValue - (holding.quantity * holding.avg_price)
                        : 0,
    };
    investedUSD += currentValue;
  }

  const cashUSD = Math.max(0, totalUSD - investedUSD);

  // ── Neue Epoche starten (alte Daten bleiben als Archiv erhalten) ─────────
  const newEpochId = agent.db.startNewEpoch({
    reason:         'sync_basis',
    label:          `Sync ${new Date().toISOString().substring(0, 10)} — ${Object.keys(paperPositions).join(', ') || 'Cash'}`,
    initialBalance: totalUSD,
  });
  agent.tradeCount         = 0;   // frischer Start
  agent.performanceHistory = [];

  // ── Paper Wallet atomisch zurücksetzen ────────────────────────────────────
  agent.wallet.resetToPortfolio(totalUSD, cashUSD, paperPositions);
  agent.db.setMeta('coinbase_synced', new Date().toISOString());

  const totalEUR  = totalUSD  * _eurUSD;
  const cashEUR   = cashUSD   * _eurUSD;
  const posNames  = Object.keys(paperPositions).map(s => s.split('-')[0]).join(', ') || 'nur Cash';

  console.log(`✅ Wallet Sync (Epoche ${newEpochId}): $${totalUSD.toFixed(2)} (€${totalEUR.toFixed(2)}) | Cash: $${cashUSD.toFixed(2)} | Positionen: ${posNames}`);

  await telegram.send(
    `🔄 <b>Paper Wallet synchronisiert — Epoche ${newEpochId}</b>\n` +
    `💼 Basis: €${totalEUR.toFixed(2)}\n` +
    `💵 Cash: €${cashEUR.toFixed(2)}\n` +
    `📦 Assets: ${posNames}\n` +
    `🗂️ Alte Daten archiviert, neuer Clean-Start\n` +
    `(Coinbase: "${agent.db.getMeta('coinbase_portfolio_name', 'Trading Bot')}")`
  );

  return {
    success:    true,
    epoch_id:   newEpochId,
    usd:        totalUSD,
    eur:        totalEUR,
    cash_usd:   cashUSD,
    positions:  posNames,
    ts:         new Date().toISOString(),
  };
}

// ─── Start ───────────────────────────────────────────────────────────────────

server.listen(CONFIG.dashboardPort, () => {
  console.log(`📊 Dashboard: http://localhost:${CONFIG.dashboardPort}`);
});

async function main() {
  // EUR-Rate + Coinbase Portfolio beim Start holen
  await _refreshEURRate();
  await syncCoinbasePortfolio();

  // EUR-Rate alle 30 Minuten aktualisieren
  setInterval(_refreshEURRate, 30 * 60 * 1000);
  // Coinbase Portfolio alle 5 Minuten aktualisieren
  setInterval(syncCoinbasePortfolio, 5 * 60 * 1000);

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
  const eur   = state.totalValue * _eurUSD;
  await telegram.send(`🛑 <b>Agent gestoppt</b>\n💼 €${eur.toFixed(2)} | ${state.totalReturnPct > 0 ? '+' : ''}${state.totalReturnPct}%`);
  server.close(() => process.exit(0));
}

process.on('SIGINT',  shutdown);
process.on('SIGTERM', shutdown);
main();
