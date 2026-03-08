/**
 * Persistence Layer — SQLite
 *
 * Speichert den kompletten Agent-State in /opt/trading-agent/data/agent.db
 * Überlebt Neustarts, Crashes und Server-Reboots.
 *
 * Tabellen:
 *   wallet_state     — cashBalance, initialBalance, positions (JSON)
 *   trades           — jeder einzelne Trade als eigene Zeile
 *   strategies       — alle KI-Strategie-Versionen
 *   performance_snapshots — Portfolio-Wert im Zeitverlauf (für Chart)
 *   agent_meta       — tradeCount und sonstige Metadaten
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_DIR  = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DB_DIR, 'agent.db');

class Persistence {
  constructor() {
    // Verzeichnis anlegen falls nicht vorhanden
    if (!fs.existsSync(DB_DIR)) {
      fs.mkdirSync(DB_DIR, { recursive: true });
    }

    this.db = new Database(DB_PATH);
    this._applyPragmas();
    this._createTables();
    this._prepareStatements();

    console.log(`💾 Datenbank geladen: ${DB_PATH}`);
  }

  // ─── Setup ──────────────────────────────────────────────────────────────────

  _applyPragmas() {
    // WAL-Modus: schnellere Writes, kein Locking beim gleichzeitigen Lesen
    this.db.pragma('journal_mode = WAL');
    // Synchronous NORMAL: gut balanciert zwischen Sicherheit und Speed
    this.db.pragma('synchronous = NORMAL');
    // Fremdschlüssel aktivieren
    this.db.pragma('foreign_keys = ON');
  }

  _createTables() {
    this.db.exec(`
      -- Wallet: Cash + Positionen als JSON-Blob
      CREATE TABLE IF NOT EXISTS wallet_state (
        id              INTEGER PRIMARY KEY CHECK (id = 1),  -- immer nur 1 Zeile
        initial_balance REAL    NOT NULL,
        cash_balance    REAL    NOT NULL,
        positions       TEXT    NOT NULL DEFAULT '{}',       -- JSON
        updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
      );

      -- Trades: eine Zeile pro Trade
      CREATE TABLE IF NOT EXISTS trades (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        trade_id        TEXT    UNIQUE NOT NULL,             -- z.B. "trade_1712345678"
        action          TEXT    NOT NULL,                    -- BUY | SELL
        symbol          TEXT    NOT NULL,
        amount_usd      REAL,
        quantity        REAL,
        price           REAL,
        confidence      REAL,
        reason          TEXT,
        realized_pnl    REAL,
        pnl_pct         REAL,
        stop_loss       REAL,
        take_profit     REAL,
        portfolio_value REAL,
        timestamp       TEXT    NOT NULL
      );

      CREATE INDEX IF NOT EXISTS trades_symbol   ON trades(symbol);
      CREATE INDEX IF NOT EXISTS trades_action   ON trades(action);
      CREATE INDEX IF NOT EXISTS trades_timestamp ON trades(timestamp);

      -- Strategien: alle KI-generierten Versionen
      CREATE TABLE IF NOT EXISTS strategies (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        version         INTEGER NOT NULL,
        name            TEXT    NOT NULL,
        rules           TEXT    NOT NULL DEFAULT '{}',       -- JSON
        improvement_summary  TEXT,
        expected_improvement TEXT,
        trade_count_at_save  INTEGER DEFAULT 0,
        saved_at        TEXT    NOT NULL DEFAULT (datetime('now'))
      );

      -- Performance-Snapshots: Portfolio-Wert über Zeit (für Chart)
      CREATE TABLE IF NOT EXISTS performance_snapshots (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        value     REAL    NOT NULL,
        timestamp TEXT    NOT NULL DEFAULT (datetime('now'))
      );

      -- Ältere Snapshots automatisch bereinigen (nur letzte 10.000 behalten)
      CREATE TRIGGER IF NOT EXISTS trim_snapshots
        AFTER INSERT ON performance_snapshots
        WHEN (SELECT COUNT(*) FROM performance_snapshots) > 10000
      BEGIN
        DELETE FROM performance_snapshots
        WHERE id IN (
          SELECT id FROM performance_snapshots
          ORDER BY id ASC
          LIMIT 100
        );
      END;

      -- Agent-Metadaten: tradeCount etc.
      CREATE TABLE IF NOT EXISTS agent_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  _prepareStatements() {
    // Prepared Statements: einmal kompiliert, viele Male schnell ausgeführt
    this.stmts = {
      // Wallet
      upsertWallet: this.db.prepare(`
        INSERT INTO wallet_state (id, initial_balance, cash_balance, positions, updated_at)
        VALUES (1, ?, ?, ?, datetime('now'))
        ON CONFLICT(id) DO UPDATE SET
          cash_balance = excluded.cash_balance,
          positions    = excluded.positions,
          updated_at   = excluded.updated_at
      `),
      selectWallet: this.db.prepare(`
        SELECT * FROM wallet_state WHERE id = 1
      `),

      // Trades
      insertTrade: this.db.prepare(`
        INSERT OR IGNORE INTO trades
          (trade_id, action, symbol, amount_usd, quantity, price, confidence,
           reason, realized_pnl, pnl_pct, stop_loss, take_profit, portfolio_value, timestamp)
        VALUES
          (@trade_id, @action, @symbol, @amount_usd, @quantity, @price, @confidence,
           @reason, @realized_pnl, @pnl_pct, @stop_loss, @take_profit, @portfolio_value, @timestamp)
      `),
      selectRecentTrades: this.db.prepare(`
        SELECT * FROM trades ORDER BY timestamp DESC LIMIT ?
      `),
      selectAllTrades: this.db.prepare(`
        SELECT * FROM trades ORDER BY timestamp ASC
      `),
      countTrades: this.db.prepare(`
        SELECT COUNT(*) as count FROM trades
      `),

      // Strategien
      insertStrategy: this.db.prepare(`
        INSERT INTO strategies
          (version, name, rules, improvement_summary, expected_improvement, trade_count_at_save)
        VALUES
          (@version, @name, @rules, @improvement_summary, @expected_improvement, @trade_count_at_save)
      `),
      selectAllStrategies: this.db.prepare(`
        SELECT * FROM strategies ORDER BY version ASC
      `),
      selectLatestStrategy: this.db.prepare(`
        SELECT * FROM strategies ORDER BY version DESC LIMIT 1
      `),

      // Snapshots
      insertSnapshot: this.db.prepare(`
        INSERT INTO performance_snapshots (value, timestamp)
        VALUES (?, datetime('now'))
      `),
      selectSnapshots: this.db.prepare(`
        SELECT timestamp, value FROM performance_snapshots
        ORDER BY id DESC LIMIT ?
      `),

      // Meta
      upsertMeta: this.db.prepare(`
        INSERT INTO agent_meta (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `),
      selectMeta: this.db.prepare(`
        SELECT value FROM agent_meta WHERE key = ?
      `),
    };
  }

  // ─── Wallet ─────────────────────────────────────────────────────────────────

  saveWallet(initialBalance, cashBalance, positions) {
    this.stmts.upsertWallet.run(
      initialBalance,
      cashBalance,
      JSON.stringify(positions)
    );
  }

  loadWallet() {
    const row = this.stmts.selectWallet.get();
    if (!row) return null;
    return {
      initialBalance: row.initial_balance,
      cashBalance:    row.cash_balance,
      positions:      JSON.parse(row.positions),
      updatedAt:      row.updated_at,
    };
  }

  // ─── Trades ─────────────────────────────────────────────────────────────────

  saveTrade(trade) {
    this.stmts.insertTrade.run({
      trade_id:        trade.id || `trade_${Date.now()}`,
      action:          trade.action,
      symbol:          trade.symbol,
      amount_usd:      trade.amount_usd   ?? null,
      quantity:        trade.quantity     ?? null,
      price:           trade.price        ?? null,
      confidence:      trade.confidence   ?? null,
      reason:          trade.reason       ?? null,
      realized_pnl:    trade.realizedPnL  ?? null,
      pnl_pct:         trade.pnlPct       ?? null,
      stop_loss:       trade.stop_loss    ?? null,
      take_profit:     trade.take_profit  ?? null,
      portfolio_value: trade.portfolio_value ?? null,
      timestamp:       trade.timestamp || new Date().toISOString(),
    });
  }

  // Gibt die letzten n Trades zurück (neueste zuerst → älteste zuerst umkehren)
  loadRecentTrades(n = 50) {
    return this.stmts.selectRecentTrades.all(n).reverse();
  }

  loadAllTrades() {
    return this.stmts.selectAllTrades.all();
  }

  getTradeCount() {
    return this.stmts.countTrades.get().count;
  }

  // ─── Strategien ─────────────────────────────────────────────────────────────

  saveStrategy(strategy, tradeCount = 0) {
    this.stmts.insertStrategy.run({
      version:              strategy.version || 1,
      name:                 strategy.name,
      rules:                JSON.stringify(strategy.rules || {}),
      improvement_summary:  strategy.improvement_summary || null,
      expected_improvement: strategy.expected_improvement || null,
      trade_count_at_save:  tradeCount,
    });
  }

  loadAllStrategies() {
    return this.stmts.selectAllStrategies.all().map(row => ({
      ...row,
      rules: JSON.parse(row.rules),
    }));
  }

  loadLatestStrategy() {
    const row = this.stmts.selectLatestStrategy.get();
    if (!row) return null;
    return { ...row, rules: JSON.parse(row.rules) };
  }

  getStrategyVersion() {
    const latest = this.stmts.selectLatestStrategy.get();
    return latest ? latest.version : 0;
  }

  // ─── Performance Snapshots ──────────────────────────────────────────────────

  saveSnapshot(value) {
    this.stmts.insertSnapshot.run(value);
  }

  // Gibt Snapshots in chronologischer Reihenfolge zurück (älteste zuerst)
  loadSnapshots(limit = 500) {
    return this.stmts.selectSnapshots.all(limit).reverse();
  }

  // ─── Agent Meta ─────────────────────────────────────────────────────────────

  setMeta(key, value) {
    this.stmts.upsertMeta.run(key, String(value));
  }

  getMeta(key, defaultValue = null) {
    const row = this.stmts.selectMeta.get(key);
    return row ? row.value : defaultValue;
  }

  // ─── Transaktionen für atomare Writes ────────────────────────────────────────
  // Wallet + Snapshot in einem einzigen Commit (kein halbgespeicherter Zustand)

  saveTradeWithState(trade, cashBalance, positions, snapshotValue) {
    const txn = this.db.transaction(() => {
      this.saveTrade(trade);
      this.saveWallet(
        parseFloat(this.getMeta('initial_balance', '10000')),
        cashBalance,
        positions
      );
      this.saveSnapshot(snapshotValue);
    });
    txn();
  }

  // ─── Diagnose ────────────────────────────────────────────────────────────────

  getStats() {
    return {
      dbPath:        DB_PATH,
      trades:        this.getTradeCount(),
      strategies:    this.stmts.selectAllStrategies.all().length,
      snapshots:     this.db.prepare('SELECT COUNT(*) as c FROM performance_snapshots').get().c,
      dbSizeKB:      Math.round(fs.statSync(DB_PATH).size / 1024),
    };
  }

  close() {
    this.db.close();
  }
}

// Singleton — überall dieselbe Instanz
let instance = null;
function getPersistence() {
  if (!instance) instance = new Persistence();
  return instance;
}

module.exports = { Persistence, getPersistence };
