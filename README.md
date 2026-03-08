# 🤖 Trading AI Agent

Autonomer Krypto-Trading-Agent mit Claude AI + Coinbase API — Paper Trading → Live Trading.

## Architektur

```
┌─────────────────────────────────────────────────┐
│              Trading AI Agent                   │
├─────────────┬───────────────┬───────────────────┤
│ Claude AI   │ Coinbase API  │ Strategy Memory   │
│ (Decisions) │ (Market Data) │ (Self-Improve)    │
├─────────────┴───────────────┴───────────────────┤
│              Paper Wallet / Live Wallet          │
├─────────────────────────────────────────────────┤
│         Dashboard API (Port 3000)               │
└─────────────────────────────────────────────────┘
```

## Phase 1: Paper Trading (Start hier!)

### 1. Installation
```bash
npm install
cp .env.example .env
```

### 2. .env konfigurieren
```
TRADING_MODE=paper
INITIAL_BALANCE=10000
SYMBOLS=BTC-USD,ETH-USD,SOL-USD
DECISION_INTERVAL=60000
```

### 3. Agent starten
```bash
npm run paper
```

Dashboard API läuft auf: `http://localhost:3000`

### 4. Dashboard öffnen
Öffne `index.html` im Browser — zeigt Live-Portfolio, Trades, Logs.

---

## Phase 2: Live Trading mit Coinbase

### Coinbase API Key erstellen
1. Gehe zu: https://www.coinbase.com/settings/api
2. Klicke **+ New API Key**
3. Wähle **Advanced Trade** Scope
4. Permissions: `wallet:accounts:read`, `wallet:buys:create`, `wallet:sells:create`
5. Speichere `API Key Name` und `Private Key (EC)`

### Coinbase MCP Server (optional)
Coinbase bietet einen offiziellen MCP Server für Claude Desktop:
```bash
# In Claude Desktop config (~/Library/Application Support/Claude/claude_desktop_config.json):
{
  "mcpServers": {
    "coinbase": {
      "command": "npx",
      "args": ["-y", "@coinbase/mcp-server-coinbase"],
      "env": {
        "COINBASE_API_KEY_NAME": "your_key_name",
        "COINBASE_API_KEY_PRIVATE_KEY": "your_private_key"
      }
    }
  }
}
```

### .env für Live Trading
```
TRADING_MODE=live
COINBASE_API_KEY=organizations/your-org-id/apiKeys/your-key-id
COINBASE_API_SECRET=-----BEGIN EC PRIVATE KEY-----
your_ec_private_key_here
-----END EC PRIVATE KEY-----
```

### Live Trading starten
```bash
npm run live
```

⚠️ **WARNUNG**: Nur starten nach mindestens 2-4 Wochen Paper Trading!

---

## Self-Improvement System

Der Agent verbessert sich automatisch nach jedem `IMPROVEMENT_CYCLE` (Standard: 10 Trades):

1. **Analyse**: Wertet gewonnene vs. verlorene Trades aus
2. **Mustererkennung**: Findet welche Indikatoren funktioniert haben
3. **Strategie-Update**: Claude generiert verbesserte Handelsregeln
4. **Versionierung**: Jede Strategy-Version wird gespeichert

```
v1: RSI + MACD Basis-Strategie
v2: Volume-Filter hinzugefügt (+2.1% Win Rate)
v3: Confidence-Threshold erhöht (-1.8% Drawdown)
v4: Position Sizing optimiert (+$18 avg profit)
...
```

---

## API Endpoints (Dashboard)

| Endpoint | Beschreibung |
|----------|-------------|
| `GET /api/status` | Agent-Status, Mode, Uptime |
| `GET /api/portfolio` | Positionen, Balance, Returns |
| `GET /api/performance` | Win Rate, Sharpe, Drawdown |
| `GET /api/trades` | Letzte 50 Trades |
| `GET /api/logs` | Agent-Logs (100 Einträge) |
| `GET /api/strategy` | Aktuelle + History aller Strategien |
| `GET /api/history` | Portfolio-Wert-Historie |

---

## Risiko-Parameter

| Parameter | Standard | Beschreibung |
|-----------|---------|-------------|
| `MAX_POSITION_SIZE` | 15% | Max. Anteil pro Position |
| `RISK_PER_TRADE` | 2% | Max. Verlust pro Trade |
| Cash Reserve | 20% | Immer mindestens 20% Cash |
| Min. Confidence | 50% | KI muss > 50% sicher sein |

---

## Technische Indikatoren

Der Agent berechnet für jedes Symbol auf 3 Timeframes (1h, 4h, 1D):
- **RSI** (14 Perioden) — Überkauft/Überverkauft
- **MACD** — Trend + Momentum
- **EMA** (20/50) — Trend-Richtung
- **Bollinger Bands** — Volatilität + Ausbrüche
- **ATR** — Volatilität für Position Sizing
- **Market Regime** — Uptrend / Downtrend / Sideways

---

## Empfohlene Vorgehensweise

```
Woche 1-2:  Paper Trading, Agent beobachten
Woche 2-4:  Strategie-Evolution verfolgen, Parameter tweaken
Monat 2:    Wenn Win Rate > 55% und Sharpe > 1.5 → Live-Test mit 100€
Monat 3+:   Schrittweise Live-Position erhöhen
```

**Niemals mehr riskieren als du bereit bist zu verlieren!**
