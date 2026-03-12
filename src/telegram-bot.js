/**
 * Telegram Bot — Trading Agent Notifications + Remote Control
 * Sends alerts to iPhone, accepts commands to monitor/control agent
 */

class TelegramBot {
  constructor(config = {}) {
    this.token = config.token || process.env.TELEGRAM_BOT_TOKEN;
    this.chatId = config.chatId || process.env.TELEGRAM_CHAT_ID;
    this.agent = null; // set via setAgent()
    this.baseUrl = `https://api.telegram.org/bot${this.token}`;
    this.lastUpdateId = 0;
    this.isPolling = false;
    this.enabled = !!(this.token && this.chatId);

    // Daily report scheduler
    this.dailyReportTime = config.dailyReportTime || '08:00'; // 08:00 Uhr
    this.lastDailyReport = null;
  }

  setAgent(agent) {
    this.agent = agent;
  }

  // ─── Send Messages ────────────────────────────────────────────────────────

  async send(text, options = {}) {
    if (!this.enabled) return;
    try {
      await fetch(`${this.baseUrl}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.chatId,
          text,
          parse_mode: 'HTML',
          ...options
        })
      });
    } catch (err) {
      console.error('Telegram send error:', err.message);
    }
  }

  // ─── Trading Alerts ───────────────────────────────────────────────────────

  async alertTrade(trade) {
    const emoji = trade.action === 'BUY' ? '🟢' : '🔴';
    const confBar = this._confidenceBar(trade.confidence);

    const msg = `${emoji} <b>${trade.action} ${trade.symbol}</b>

💵 <b>Betrag:</b> $${trade.amount_usd.toFixed(2)}
📈 <b>Preis:</b> $${trade.price.toLocaleString('de-DE', {minimumFractionDigits: 2})}
🎯 <b>Konfidenz:</b> ${confBar} ${(trade.confidence * 100).toFixed(0)}%
💡 <b>Grund:</b> <i>${trade.reason}</i>

🔒 Stop-Loss: $${trade.stop_loss?.toFixed(2) || 'N/A'}
✅ Take-Profit: $${trade.take_profit?.toFixed(2) || 'N/A'}
💼 Portfolio: $${trade.portfolio_value?.toFixed(2)}`;

    await this.send(msg);
  }

  async alertSellResult(trade) {
    const pnl = trade.realizedPnL || 0;
    const emoji = pnl >= 0 ? '💰' : '📉';
    const sign = pnl >= 0 ? '+' : '';

    await this.send(`${emoji} <b>SELL abgeschlossen — ${trade.symbol}</b>

${pnl >= 0 ? '✅' : '❌'} <b>P&L:</b> ${sign}$${pnl.toFixed(2)} (${sign}${trade.pnlPct}%)
💵 Erlös: $${trade.amountUSD.toFixed(2)} @ $${trade.price.toFixed(2)}`);
  }

  async alertStrategyImproved(strategy) {
    await this.send(`🧠 <b>Strategie verbessert!</b>

📌 <b>Version:</b> ${strategy.name}
📊 <b>Änderung:</b> ${strategy.improvement_summary}
🎯 <b>Erwartung:</b> ${strategy.expected_improvement}`);
  }

  async alertDrawdown(currentPct, portfolioValue) {
    await this.send(`⚠️ <b>DRAWDOWN ALARM</b>

📉 Aktueller Drawdown: <b>${currentPct.toFixed(2)}%</b>
💼 Portfolio-Wert: $${portfolioValue.toFixed(2)}

Agent läuft weiter — Position wird beobachtet.`);
  }

  async alertAgentStarted(config) {
    await this.send(`🚀 <b>Trading Agent gestartet</b>

⚙️ Modus: <b>${config.mode.toUpperCase()}</b>
💰 Startkapital: $${config.initialBalance.toFixed(2)}
📊 Symbole: ${config.symbols.join(', ')}
⏱️ Intervall: ${config.decisionInterval / 1000}s
🧠 Strategie: ${config.strategy || 'wird generiert...'}

Schreibe /status für aktuellen Stand.`);
  }

  async alertAgentError(error) {
    await this.send(`🔴 <b>Agent Fehler</b>

❌ ${error}

Agent versucht automatischen Neustart...`);
  }

  async sendDailyReport(agent) {
    const state = agent.wallet.getState();
    const perf = agent.getPerformanceMetrics();
    const todayTrades = agent.memory.getRecentTrades(50)
      .filter(t => new Date(t.timestamp).toDateString() === new Date().toDateString());

    const returnSign = state.totalReturnPct >= 0 ? '+' : '';
    const returnEmoji = state.totalReturnPct >= 0 ? '📈' : '📉';

    await this.send(`📊 <b>Tagesbericht — ${new Date().toLocaleDateString('de-DE')}</b>

${returnEmoji} <b>Portfolio:</b> $${state.totalValue.toFixed(2)} (${returnSign}${state.totalReturnPct}%)
💵 Cash: $${state.cashBalance.toFixed(2)}
📦 Positionen: ${state.positions.length} offen

<b>Performance:</b>
✅ Win Rate: ${perf.win_rate}%
📊 Sharpe Ratio: ${perf.sharpe_ratio}
💹 Ø Profit/Trade: $${perf.avg_profit_per_trade}
📉 Max Drawdown: ${perf.max_drawdown}%

<b>Heute:</b>
🔢 Trades: ${todayTrades.length}
🧠 Strategie: ${agent.currentStrategy?.name || 'Standard'}

/status /positionen /trades`);
  }

  // ─── Command Handler ──────────────────────────────────────────────────────

  async handleCommand(command, agent) {
    switch (command.toLowerCase().split(' ')[0]) {
      case '/status':
        await this._sendStatus(agent);
        break;
      case '/positionen':
      case '/positions':
        await this._sendPositions(agent);
        break;
      case '/trades':
        await this._sendRecentTrades(agent);
        break;
      case '/performance':
        await this._sendPerformance(agent);
        break;
      case '/strategie':
      case '/strategy':
        await this._sendStrategy(agent);
        break;
      case '/pause':
        agent.pause();
        await this.send('⏸️ <b>Agent pausiert.</b>\n\n/resume zum Fortsetzen.');
        break;
      case '/resume':
        agent.resume();
        await this.send('▶️ <b>Agent läuft wieder.</b>');
        break;
      case '/hilfe':
      case '/help':
        await this._sendHelp();
        break;
      default:
        await this.send(`❓ Unbekannter Befehl: ${command}\n\nTippe /hilfe für alle Befehle.`);
    }
  }

  async _sendStatus(agent) {
    const state = agent.wallet.getState();
    const perf = agent.getPerformanceMetrics();
    const uptime = Math.floor(agent.uptime / 60);
    const returnSign = state.totalReturnPct >= 0 ? '+' : '';

    const stateEmoji = !agent.isRunning ? '🔴 Gestoppt' : agent.isPaused ? '⏸️ Pausiert' : '🟢 Läuft';
    await this.send(`📡 <b>Agent Status</b>

${stateEmoji} | Modus: <b>${agent.config.mode.toUpperCase()}</b>
⏱ Uptime: ${uptime}m | Trades: ${agent.tradeCount}

💼 <b>Portfolio:</b> $${state.totalValue.toFixed(2)}
📊 Return: <b>${returnSign}${state.totalReturnPct}%</b>
💵 Cash: $${state.cashBalance.toFixed(2)} (${(state.cashBalance/state.totalValue*100).toFixed(1)}%)

🧠 Strategie: ${agent.currentStrategy?.name || 'Standard v1'}
🎯 Win Rate: ${perf.win_rate}%`);
  }

  async _sendPositions(agent) {
    const state = agent.wallet.getState();
    if (state.positions.length === 0) {
      await this.send('📦 Keine offenen Positionen.\n\n💵 Alles in Cash: $' + state.cashBalance.toFixed(2));
      return;
    }

    let msg = '📦 <b>Offene Positionen</b>\n\n';
    for (const p of state.positions) {
      const pnlSign = p.unrealizedPnL >= 0 ? '+' : '';
      const emoji = p.unrealizedPnL >= 0 ? '🟢' : '🔴';
      msg += `${emoji} <b>${p.symbol}</b>
  💵 $${p.currentValue.toFixed(2)} | ${pnlSign}$${p.unrealizedPnL.toFixed(2)} (${pnlSign}${p.unrealizedPnLPct}%)
  📊 ${p.quantity.toFixed(6)} @ ⌀$${p.avgPrice.toFixed(2)}\n\n`;
    }
    msg += `💵 Cash: $${state.cashBalance.toFixed(2)}`;
    await this.send(msg);
  }

  async _sendRecentTrades(agent) {
    const trades = agent.memory.getRecentTrades(5);
    if (trades.length === 0) {
      await this.send('📋 Noch keine Trades.');
      return;
    }

    let msg = '📋 <b>Letzte 5 Trades</b>\n\n';
    for (const t of trades.reverse()) {
      const emoji = t.action === 'BUY' ? '🟢' : '🔴';
      const time = new Date(t.timestamp).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
      msg += `${emoji} ${t.action} ${t.symbol} $${t.amount_usd?.toFixed(0)} @ $${t.price?.toFixed(2)} [${time}]\n`;
    }
    await this.send(msg);
  }

  async _sendPerformance(agent) {
    const perf = agent.getPerformanceMetrics();
    await this.send(`📊 <b>Performance Metriken</b>

🏆 Win Rate: <b>${perf.win_rate}%</b>
📈 Sharpe Ratio: <b>${perf.sharpe_ratio}</b>
💹 Ø Profit/Trade: <b>$${perf.avg_profit_per_trade}</b>
📉 Max Drawdown: <b>${perf.max_drawdown}%</b>
🔢 Gesamt Trades: <b>${perf.total_trades}</b>
💰 Portfolio: <b>$${perf.current_portfolio_value}</b>`);
  }

  async _sendStrategy(agent) {
    const s = agent.currentStrategy;
    if (!s) {
      await this.send('🧠 Noch keine optimierte Strategie.\nAgent generiert nach ' + agent.config.improvementCycle + ' Trades eine.');
      return;
    }
    await this.send(`🧠 <b>${s.name}</b>

📝 ${s.improvement_summary || 'Initiale Strategie'}
🎯 Erwartung: ${s.expected_improvement || 'Baseline'}

Version ${s.version} | ${agent.memory.strategies.length} Iterationen total`);
  }

  async _sendHelp() {
    await this.send(`🤖 <b>Trading Agent — Befehle</b>

📡 /status — Übersicht & Portfolio
📦 /positionen — Offene Positionen
📋 /trades — Letzte Trades
📊 /performance — Win Rate, Sharpe etc.
🧠 /strategie — Aktuelle Strategie

⏸️ /pause — Agent pausieren
▶️ /resume — Agent fortsetzen
❓ /hilfe — Diese Hilfe`);
  }

  // ─── Polling (empfängt Befehle vom iPhone) ────────────────────────────────

  async startPolling(agent) {
    if (!this.enabled) {
      console.log('⚠️  Telegram nicht konfiguriert (TELEGRAM_BOT_TOKEN fehlt)');
      return;
    }

    this.isPolling = true;
    console.log('📱 Telegram Bot polling gestartet...');

    while (this.isPolling) {
      try {
        const res = await fetch(
          `${this.baseUrl}/getUpdates?offset=${this.lastUpdateId + 1}&timeout=30`
        );
        const data = await res.json();

        if (data.ok && data.result.length > 0) {
          for (const update of data.result) {
            this.lastUpdateId = update.update_id;
            const text = update.message?.text;
            if (text?.startsWith('/')) {
              await this.handleCommand(text, agent);
            }
          }
        }

        // Check for daily report
        await this._checkDailyReport(agent);

      } catch (err) {
        // Silently retry on network errors
        await this._sleep(5000);
      }
    }
  }

  async _checkDailyReport(agent) {
    const now = new Date();
    const timeStr = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
    const today = now.toDateString();

    if (timeStr === this.dailyReportTime && this.lastDailyReport !== today) {
      this.lastDailyReport = today;
      await this.sendDailyReport(agent);
    }
  }

  stopPolling() {
    this.isPolling = false;
  }

  _confidenceBar(confidence) {
    const filled = Math.round(confidence * 5);
    return '█'.repeat(filled) + '░'.repeat(5 - filled);
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = { TelegramBot };
