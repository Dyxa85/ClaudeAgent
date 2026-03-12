/**
 * Persistence Layer — SQLite
 *
 * Speichert den kompletten Agent-State in /opt/trading-agent/data/agent.db
 * Überlebt Neustarts, Crashes und Server-Reboots.
 *
 * Tabellen:
 *   epochs               — isolierte Datenphasen (z.B. nach Strategy-Reset)
 *   wallet_state         — cashBalance, initialBalance, positions (JSON)
 *   trades               — jeder einzelne Trade (mit epoch_id)
 *   strategies           — alle KI-Strategie-Versionen
 *   performance_snapshots — Portfolio-Wert im Zeitverlauf (mit epoch_id)
 *   agent_meta           — aktuelle Metadaten (current_epoch_id, tradeCount, …)
 *
 * Epoch-Konzept:
 *   Jede "Datenphase" hat ihre eigene epoch_id. Trades und Snapshots aus
 *   früheren Epochen bleiben erhalten (Archiv / §23-EStG-Dokumentation),
 *   beeinflussen aber weder die KI-Lernschleife noch die Performance-Metriken
 *   der aktuellen Epoche. Eine neue Epoche wird gestartet bei:
 *     • SYNC BASIS (Wallet-Reset auf Coinbase-Portfolio)
 *     • Manuellem Reset über die Dashboard-API
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_DIR  = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DB_DIR, 'agent.db');

class Persistence {
  constructor() {
    if (!fs.existsSync(DB_DIR)) {
      fs.mkdirSync(DB_DIR, { recursive: true });
    }

    this.db = new Database(DB_PATH);
    this._applyPragmas();
    this._createTables();
    this._migrate();
    this._prepareStatements();

    // Aktuelle Epoche cachen
    this._currentEpochId = parseInt(this.getMeta('current_epoch_id', '1'), 10);

    console.log(`💾 Datenbank geladen: ${DB_PATH} (Epoche ${this._currentEpochId})`);
  }

  // ─── Setup ──────────────────────────────────────────────────────────────────

  _applyPragmas() {
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
  }

  _createTables() {
    this.db.exec(`
      -- Epochen: isolierte Datenphasen
      CREATE TABLE IF NOT EXISTS epochs (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at      TEXT    NOT NULL DEFAULT (datetime('now')),
        reason          TEXT,          -- 'initial'|'sync_basis'|'strategy_reset'|'manual'
        initial_balance REAL,          -- Startkapital dieser Epoche
        label           TEXT,          -- optionaler Freitext-Titel
        archived_at     TEXT           -- NULL = aktiv; gesetzt = archiviert
      );

      -- Wallet: Cash + Positionen als JSON-Blob
      CREATE TABLE IF NOT EXISTS wallet_state (
        id              INTEGER PRIMARY KEY CHECK (id = 1),
        initial_balance REAL    NOT NULL,
        cash_balance    REAL    NOT NULL,
        positions       TEXT    NOT NULL DEFAULT '{}',
        updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
      );

      -- Trades: eine Zeile pro Trade (epoch_id ab v2)
      CREATE TABLE IF NOT EXISTS trades (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        epoch_id        INTEGER NOT NULL DEFAULT 1,
        trade_id        TEXT    UNIQUE NOT NULL,
        action          TEXT    NOT NULL,
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

      CREATE INDEX IF NOT EXISTS trades_epoch     ON trades(epoch_id);
      CREATE INDEX IF NOT EXISTS trades_symbol    ON trades(symbol);
      CREATE INDEX IF NOT EXISTS trades_action    ON trades(action);
      CREATE INDEX IF NOT EXISTS trades_timestamp ON trades(timestamp);

      -- Strategien: alle KI-generierten Versionen
      CREATE TABLE IF NOT EXISTS strategies (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        epoch_id             INTEGER NOT NULL DEFAULT 1,
        version              INTEGER NOT NULL,
        name                 TEXT    NOT NULL,
        rules                TEXT    NOT NULL DEFAULT '{}',
        improvement_summary  TEXT,
        expected_improvement TEXT,
        trade_count_at_save  INTEGER DEFAULT 0,
        saved_at             TEXT    NOT NULL DEFAULT (datetime('now'))
      );

      -- Performance-Snapshots: Portfolio-Wert über Zeit (epoch_id ab v2)
      CREATE TABLE IF NOT EXISTS performance_snapshots (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        epoch_id  INTEGER NOT NULL DEFAULT 1,
        value     REAL    NOT NULL,
        timestamp TEXT    NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS snapshots_epoch ON performance_snapshots(epoch_id);

      -- Ältere Snapshots automatisch bereinigen (nur letzte 50.000 gesamt)
      CREATE TRIGGER IF NOT EXISTS trim_snapshots
        AFTER INSERT ON performance_snapshots
        WHEN (SELECT COUNT(*) FROM performance_snapshots) > 50000
      BEGIN
        DELETE FROM performance_snapshots
        WHERE id IN (
          SELECT id FROM performance_snapshots
          ORDER BY id ASC LIMIT 500
        );
      END;

      -- Agent-Metadaten
      CREATE TABLE IF NOT EXISTS agent_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  /**
   * Migration: bestehende DBs ohne epoch_id / epochs-Tabelle upgraden.
   * Alle Altdaten bekommen epoch_id=1, dann starten wir Epoche 2 als clean slate.
   */
  _migrate() {
    const txn = this.db.transaction(() => {
      // Spalten ergänzen falls nötig (SQLite hat kein IF NOT EXISTS für ALTER COLUMN)
      const tradeCols    = this.db.prepare("PRAGMA table_info(trades)").all().map(c => c.name);
      const snapshotCols = this.db.prepare("PRAGMA table_info(performance_snapshots)").all().map(c => c.name);
      const stratCols    = this.db.prepare("PRAGMA table_info(strategies)").all().map(c => c.name);

      if (!tradeCols.includes('epoch_id')) {
        this.db.exec("ALTER TABLE trades ADD COLUMN epoch_id INTEGER NOT NULL DEFAULT 1");
      }
      if (!snapshotCols.includes('epoch_id')) {
        this.db.exec("ALTER TABLE performance_snapshots ADD COLUMN epoch_id INTEGER NOT NULL DEFAULT 1");
      }
      if (!stratCols.includes('epoch_id')) {
        this.db.exec("ALTER TABLE strategies ADD COLUMN epoch_id INTEGER NOT NULL DEFAULT 1");
      }

      // Epoche 1 eintragen falls noch keine Epochen vorhanden
      const epochCount = this.db.prepare("SELECT COUNT(*) as c FROM epochs").get().c;
      if (epochCount === 0) {
        const tradeCount = this.db.prepare("SELECT COUNT(*) as c FROM trades").get().c;
        if (tradeCount > 0) {
          // Altdaten existieren → als "legacy" Epoche 0 markieren, dann neue starten
          this.db.prepare(`
            INSERT INTO epochs (id, started_at, reason, label, initial_balance)
            VALUES (1, datetime('now'), 'legacy', 'Legacy (vor Epoch-System)', NULL)
          `).run();
          console.log('🗂️  Legacy-Daten als Epoche 1 archiviert');
        } else {
          // Frische DB → direkt Epoche 1 als aktiv starten
          this.db.prepare(`
            INSERT INTO epochs (id, started_at, reason, label)
            VALUES (1, datetime('now'), 'initial', 'Epoche 1 — Start')
          `).run();
          this.db.prepare("INSERT OR IGNORE INTO agent_meta (key,value) VALUES ('current_epoch_id','1')").run();
        }
      }

      // Sicherstellen, dass current_epoch_id gesetzt ist
      const epochMeta = this.db.prepare("SELECT value FROM agent_meta WHERE key='current_epoch_id'").get();
      if (!epochMeta) {
        const maxEpoch = this.db.prepare("SELECT MAX(id) as m FROM epochs").get().m || 1;
        this.db.prepare("INSERT OR IGNORE INTO agent_meta (key,value) VALUES ('current_epoch_id',?)").run(String(maxEpoch));
      }
    });
    txn();
  }

  _prepareStatements() {
    this.stmts = {
      // Wallet
      upsertWallet: this.db.prepare(`
        INSERT INTO wallet_state (id, initial_balance, cash_balance, positions, updated_at)
        VALUES (1, ?, ?, ?, datetime('now'))
        ON CONFLICT(id) DO UPDATE SET
          initial_balance = excluded.initial_balance,
          cash_balance    = excluded.cash_balance,
          positions       = excluded.positions,
          updated_at      = excluded.updated_at
      `),
      selectWallet: this.db.prepare(`SELECT * FROM wallet_state WHERE id = 1`),

      // Trades
      insertTrade: this.db.prepare(`
        INSERT OR IGNORE INTO trades
          (epoch_id, trade_id, action, symbol, amount_usd, quantity, price, confidence,
           reason, realized_pnl, pnl_pct, stop_loss, take_profit, portfolio_value, timestamp)
        VALUES
          (@epoch_id, @trade_id, @action, @symbol, @amount_usd, @quantity, @price, @confidence,
           @reason, @realized_pnl, @pnl_pct, @stop_loss, @take_profit, @portfolio_value, @timestamp)
      `),
      selectRecentTradesForEpoch: this.db.prepare(`
        SELECT * FROM trades WHERE epoch_id = ? ORDER BY timestamp DESC LIMIT ?
      `),
      selectAllTradesForEpoch: this.db.prepare(`
        SELECT * FROM trades WHERE epoch_id = ? ORDER BY timestamp ASC
      `),
      countTradesForEpoch: this.db.prepare(`
        SELECT COUNT(*) as count FROM trades WHERE epoch_id = ?
      `),

      // Strategien
      insertStrategy: this.db.prepare(`
        INSERT INTO strategies
          (epoch_id, version, name, rules, improvement_summary, expected_improvement, trade_count_at_save)
        VALUES
          (@epoch_id, @version, @name, @rules, @improvement_summary, @expected_improvement, @trade_count_at_save)
      `),
      selectAllStrategies: this.db.prepare(`SELECT * FROM strategies ORDER BY version ASC`),
      selectLatestStrategyForEpoch: this.db.prepare(`
        SELECT * FROM strategies WHERE epoch_id = ? ORDER BY version DESC LIMIT 1
      `),
      selectLatestStrategyGlobal: this.db.prepare(`
        SELECT * FROM strategies ORDER BY version DESC LIMIT 1
      `),

      // Snapshots
      insertSnapshot: this.db.prepare(`
        INSERT INTO performance_snapshots (epoch_id, value, timestamp)
        VALUES (?, ?, datetime('now'))
      `),
      selectSnapshotsForEpoch: this.db.prepare(`
        SELECT timestamp, value FROM performance_snapshots
        WHERE epoch_id = ?
        ORDER BY id DESC LIMIT ?
      `),

      // Epochen
      insertEpoch: this.db.prepare(`
        INSERT INTO epochs (started_at, reason, initial_balance, label)
        VALUES (datetime('now'), ?, ?, ?)
      `),
      selectAllEpochs: this.db.prepare(`
        SELECT e.*,
          (SELECT COUNT(*) FROM trades           WHERE epoch_id = e.id) as trade_count,
          (SELECT COUNT(*) FROM performance_snapshots WHERE epoch_id = e.id) as snapshot_count,
          (SELECT MIN(timestamp) FROM trades WHERE epoch_id = e.id) as first_trade,
          (SELECT MAX(timestamp) FROM trades WHERE epoch_id = e.id) as last_trade
        FROM epochs e ORDER BY e.id ASC
      `),
      selectEpoch: this.db.prepare(`SELECT * FROM epochs WHERE id = ?`),

      // Meta
      upsertMeta: this.db.prepare(`
        INSERT INTO agent_meta (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `),
      selectMeta: this.db.prepare(`SELECT value FROM agent_meta WHERE key = ?`),
    };
  }

  // ─── Aktuelle Epoche ─────────────────────────────────────────────────────────

  getCurrentEpochId() {
    return this._currentEpochId;
  }

  getCurrentEpoch() {
    return this.stmts.selectEpoch.get(this._currentEpochId);
  }

  getAllEpochs() {
    return this.stmts.selectAllEpochs.all();
  }

  /**
   * Neue Epoche starten.
   * Alle aktiven Trades/Snapshots bleiben erhalten, gehören aber zur alten Epoche.
   * Die KI sieht ab sofort nur noch Daten aus der neuen Epoche.
   *
   * @param {object} options
   * @param {string} options.reason   - 'sync_basis' | 'strategy_reset' | 'manual'
   * @param {string} [options.label]  - optionaler Freitextname
   * @param {number} [options.initialBalance] - Startkapital der neuen Epoche
   * @returns {number} neue epoch_id
   */
  startNewEpoch({ reason = 'manual', label = null, initialBalance = null } = {}) {
    const txn = this.db.transaction(() => {
      // Alte Epoche als archiviert markieren
      const oldId = this._currentEpochId;
      this.db.prepare(`UPDATE epochs SET archived_at = datetime('now') WHERE id = ?`).run(oldId);

      // Neue Epoche anlegen
      const info = this.stmts.insertEpoch.run(reason, initialBalance, label);
      const newId = info.lastInsertRowid;

      // Meta aktualisieren
      this.stmts.upsertMeta.run('current_epoch_id', String(newId));
      this._currentEpochId = newId;

      return newId;
    });
    const newId = txn();
    console.log(`🆕 Neue Epoche ${newId} gestartet (${reason})`);
    return newId;
  }

  // ─── Wallet ─────────────────────────────────────────────────────────────────

  saveWallet(initialBalance, cashBalance, positions) {
    this.stmts.upsertWallet.run(initialBalance, cashBalance, JSON.stringify(positions));
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
      epoch_id:        this._currentEpochId,
      trade_id:        trade.id || `trade_${Date.now()}`,
      action:          trade.action,
      symbol:          trade.symbol,
      amount_usd:      trade.amount_usd      ?? null,
      quantity:        trade.quantity        ?? null,
      price:           trade.price           ?? null,
      confidence:      trade.confidence      ?? null,
      reason:          trade.reason          ?? null,
      realized_pnl:    trade.realized_pnl    ?? trade.realizedPnL ?? null,
      pnl_pct:         trade.pnl_pct         ?? trade.pnlPct      ?? null,
      stop_loss:       trade.stop_loss       ?? null,
      take_profit:     trade.take_profit     ?? null,
      portfolio_value: trade.portfolio_value ?? null,
      timestamp:       trade.timestamp       || new Date().toISOString(),
    });
  }

  loadRecentTrades(n = 50) {
    return this.stmts.selectRecentTradesForEpoch.all(this._currentEpochId, n).reverse();
  }

  loadAllTrades() {
    return this.stmts.selectAllTradesForEpoch.all(this._currentEpochId);
  }

  loadTradesForEpoch(epochId, n = null) {
    if (n) return this.stmts.selectRecentTradesForEpoch.all(epochId, n).reverse();
    return this.stmts.selectAllTradesForEpoch.all(epochId);
  }

  getTradeCount() {
    return this.stmts.countTradesForEpoch.get(this._currentEpochId).count;
  }

  // ─── Strategien ─────────────────────────────────────────────────────────────

  saveStrategy(strategy, tradeCount = 0) {
    this.stmts.insertStrategy.run({
      epoch_id:             this._currentEpochId,
      version:              strategy.version || 1,
      name:                 strategy.name,
      rules:                JSON.stringify(strategy.rules || {}),
      improvement_summary:  strategy.improvement_summary  || null,
      expected_improvement: strategy.expected_improvement || null,
      trade_count_at_save:  tradeCount,
    });
  }

  loadAllStrategies() {
    return this.stmts.selectAllStrategies.all().map(row => ({
      ...row, rules: JSON.parse(row.rules),
    }));
  }

  loadLatestStrategy() {
    // Erst aktuelle Epoche, dann global als Fallback (damit Agent nie strategie-los startet)
    const row = this.stmts.selectLatestStrategyForEpoch.get(this._currentEpochId)
             || this.stmts.selectLatestStrategyGlobal.get();
    if (!row) return null;
    return { ...row, rules: JSON.parse(row.rules) };
  }

  getStrategyVersion() {
    const latest = this.stmts.selectLatestStrategyForEpoch.get(this._currentEpochId)
                || this.stmts.selectLatestStrategyGlobal.get();
    return latest ? latest.version : 0;
  }

  // ─── Performance Snapshots ──────────────────────────────────────────────────

  saveSnapshot(value) {
    this.stmts.insertSnapshot.run(this._currentEpochId, value);
  }

  loadSnapshots(limit = 500) {
    return this.stmts.selectSnapshotsForEpoch.all(this._currentEpochId, limit).reverse();
  }

  loadSnapshotsForEpoch(epochId, limit = 500) {
    return this.stmts.selectSnapshotsForEpoch.all(epochId, limit).reverse();
  }

  // ─── Agent Meta ─────────────────────────────────────────────────────────────

  setMeta(key, value) {
    this.stmts.upsertMeta.run(key, String(value));
  }

  getMeta(key, defaultValue = null) {
    const row = this.stmts.selectMeta.get(key);
    return row ? row.value : defaultValue;
  }

  // ─── Atomare Writes ──────────────────────────────────────────────────────────

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
    const epoch = this.getCurrentEpoch();
    return {
      dbPath:        DB_PATH,
      currentEpoch:  this._currentEpochId,
      epochStarted:  epoch ? epoch.started_at : null,
      epochReason:   epoch ? epoch.reason      : null,
      trades:        this.getTradeCount(),
      strategies:    this.stmts.selectAllStrategies.all().length,
      snapshots:     this.db.prepare('SELECT COUNT(*) as c FROM performance_snapshots WHERE epoch_id = ?').get(this._currentEpochId).c,
      dbSizeKB:      Math.round(fs.statSync(DB_PATH).size / 1024),
    };
  }

  close() {
    this.db.close();
  }
}

// Singleton
let instance = null;
function getPersistence() {
  if (!instance) instance = new Persistence();
  return instance;
}

module.exports = { Persistence, getPersistence };
