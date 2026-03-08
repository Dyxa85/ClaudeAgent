import { useState, useEffect, useCallback } from "react";

// ─── Simulated agent state for demo ──────────────────────────────────────────
const generatePortfolioHistory = () => {
  let value = 10000;
  const history = [];
  const now = Date.now();
  for (let i = 200; i >= 0; i--) {
    value += (Math.random() - 0.46) * 120;
    value = Math.max(8000, value);
    history.push({ timestamp: new Date(now - i * 60000).toISOString(), value: parseFloat(value.toFixed(2)) });
  }
  return history;
};

const INITIAL_STATE = {
  running: true,
  mode: "paper",
  tradeCount: 47,
  strategy: "Momentum + RSI Divergence v4",
  uptime: 3847,
  portfolio: {
    cashBalance: 3241.87,
    positionsValue: 8124.33,
    totalValue: 11366.20,
    totalReturnPct: 13.66,
    positions: [
      { symbol: "BTC-USD", quantity: 0.04821, avgPrice: 64200, currentPrice: 65847, currentValue: 3173.04, unrealizedPnL: 79.40, unrealizedPnLPct: 2.57 },
      { symbol: "ETH-USD", quantity: 1.2340, avgPrice: 3150, currentPrice: 3287, currentValue: 4056.08, unrealizedPnL: 169.07, unrealizedPnLPct: 4.35 },
      { symbol: "SOL-USD", quantity: 5.920, avgPrice: 148.20, currentPrice: 151.68, currentValue: 897.94, unrealizedPnL: 20.62, unrealizedPnLPct: 2.35 }
    ]
  },
  performance: { win_rate: 62.5, avg_profit: 18.44, max_drawdown: 4.21, sharpe_ratio: 1.87 },
  history: generatePortfolioHistory()
};

const TRADES = [
  { id: 1, action: "BUY",  symbol: "BTC-USD", amount_usd: 1500, price: 65412, confidence: 0.81, reason: "RSI oversold + MACD bullish cross", timestamp: new Date(Date.now() - 12 * 60000).toISOString(), pnl: null },
  { id: 2, action: "SELL", symbol: "ETH-USD", amount_usd: 800,  price: 3310,  confidence: 0.74, reason: "Take profit: +8.2% from entry, BB upper band", timestamp: new Date(Date.now() - 28 * 60000).toISOString(), pnl: 60.8 },
  { id: 3, action: "BUY",  symbol: "SOL-USD", amount_usd: 900,  price: 148.20, confidence: 0.68, reason: "Breakout above 20-day high with volume surge", timestamp: new Date(Date.now() - 55 * 60000).toISOString(), pnl: null },
  { id: 4, action: "SELL", symbol: "BTC-USD", amount_usd: 2100, price: 66200,  confidence: 0.77, reason: "Resistance at ATH, momentum fading", timestamp: new Date(Date.now() - 89 * 60000).toISOString(), pnl: 142.5 },
  { id: 5, action: "BUY",  symbol: "ETH-USD", amount_usd: 1200, price: 3150,   confidence: 0.72, reason: "Support bounce + positive funding rate", timestamp: new Date(Date.now() - 142 * 60000).toISOString(), pnl: null },
  { id: 6, action: "SELL", symbol: "SOL-USD", amount_usd: 450,  price: 143.5,  confidence: 0.55, reason: "Stop loss hit: -2.1%", timestamp: new Date(Date.now() - 210 * 60000).toISOString(), pnl: -9.8 },
];

const LOGS = [
  { level: "INFO",  timestamp: new Date(Date.now() - 2000).toISOString(),  message: "⚡ Running trading cycle..." },
  { level: "INFO",  timestamp: new Date(Date.now() - 5000).toISOString(),  message: "🤖 AI decisions received: 2 actions" },
  { level: "TRADE", timestamp: new Date(Date.now() - 8000).toISOString(),  message: "🟢 BUY BTC-USD $1500.00 @ $65412.00 (conf: 81%)" },
  { level: "INFO",  timestamp: new Date(Date.now() - 12000).toISOString(), message: "📊 HOLD ETH-USD - Awaiting confirmation signal" },
  { level: "INFO",  timestamp: new Date(Date.now() - 65000).toISOString(), message: "🧠 Running self-improvement cycle..." },
  { level: "INFO",  timestamp: new Date(Date.now() - 68000).toISOString(), message: "✅ Strategy improved: Momentum + RSI Divergence v4" },
  { level: "INFO",  timestamp: new Date(Date.now() - 70000).toISOString(), message: "📈 Improvement: Tightened entry on low-confidence signals" },
];

// ─── Sparkline SVG ────────────────────────────────────────────────────────────
function Sparkline({ data, color = "#00ff88", height = 40, width = 120 }) {
  if (!data || data.length < 2) return null;
  const values = data.map(d => d.value || d);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * width;
    const y = height - ((v - min) / range) * height;
    return `${x},${y}`;
  }).join(" ");
  const fillPts = `0,${height} ${pts} ${width},${height}`;

  return (
    <svg width={width} height={height} style={{ overflow: "visible" }}>
      <defs>
        <linearGradient id={`sg-${color.replace("#","")}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.3" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={fillPts} fill={`url(#sg-${color.replace("#","")})`} />
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ─── Portfolio Chart ──────────────────────────────────────────────────────────
function PortfolioChart({ data }) {
  if (!data || data.length < 2) return null;
  const W = 560, H = 140;
  const pad = { t: 10, r: 10, b: 20, l: 50 };
  const cW = W - pad.l - pad.r, cH = H - pad.t - pad.b;
  const values = data.map(d => d.value);
  const min = Math.min(...values) * 0.998;
  const max = Math.max(...values) * 1.002;
  const range = max - min;

  const toX = i => (i / (data.length - 1)) * cW;
  const toY = v => cH - ((v - min) / range) * cH;

  const pts = values.map((v, i) => `${toX(i)},${toY(v)}`).join(" ");
  const fillPts = `0,${cH} ${pts} ${cW},${cH}`;
  const isGain = values[values.length - 1] >= values[0];
  const lineColor = isGain ? "#00ff88" : "#ff4466";

  const ticks = [min, (min + max) / 2, max].map(v => ({
    value: v,
    y: toY(v),
    label: `$${v.toFixed(0)}`
  }));

  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ overflow: "visible" }}>
      <defs>
        <linearGradient id="chartFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={lineColor} stopOpacity="0.25" />
          <stop offset="100%" stopColor={lineColor} stopOpacity="0" />
        </linearGradient>
      </defs>
      <g transform={`translate(${pad.l},${pad.t})`}>
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={0} y1={t.y} x2={cW} y2={t.y} stroke="#ffffff08" strokeWidth="1" />
            <text x={-6} y={t.y + 4} textAnchor="end" fill="#666" fontSize="9" fontFamily="monospace">{t.label}</text>
          </g>
        ))}
        <polygon points={fillPts} fill="url(#chartFill)" />
        <polyline points={pts} fill="none" stroke={lineColor} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx={toX(values.length - 1)} cy={toY(values[values.length - 1])} r="3" fill={lineColor} />
      </g>
    </svg>
  );
}

// ─── Main Dashboard ───────────────────────────────────────────────────────────
export default function TradingDashboard() {
  const [state, setState] = useState(INITIAL_STATE);
  const [tab, setTab] = useState("overview");
  const [logs, setLogs] = useState(LOGS);
  const [trades, setTrades] = useState(TRADES);
  const [tick, setTick] = useState(0);

  // Simulate live updates
  useEffect(() => {
    const interval = setInterval(() => {
      setTick(t => t + 1);
      setState(s => {
        const noise = (Math.random() - 0.49) * 80;
        const newVal = Math.max(9000, s.portfolio.totalValue + noise);
        const newHistory = [...s.history.slice(-199), { timestamp: new Date().toISOString(), value: parseFloat(newVal.toFixed(2)) }];
        return {
          ...s,
          tradeCount: s.tradeCount + (Math.random() > 0.97 ? 1 : 0),
          uptime: s.uptime + 3,
          portfolio: {
            ...s.portfolio,
            totalValue: parseFloat(newVal.toFixed(2)),
            totalReturnPct: parseFloat(((newVal - 10000) / 10000 * 100).toFixed(2)),
          },
          history: newHistory
        };
      });
    }, 3000);
    return () => clearInterval(interval);
  }, []);

  const fmtTime = iso => {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };
  const fmtUSD = v => `$${parseFloat(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const fmtPct = v => `${v > 0 ? '+' : ''}${parseFloat(v).toFixed(2)}%`;

  const gain = state.portfolio.totalReturnPct >= 0;

  return (
    <div style={{
      background: "#080c10",
      minHeight: "100vh",
      color: "#e0e6ed",
      fontFamily: "'IBM Plex Mono', 'Fira Code', monospace",
      fontSize: "13px"
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@300;400;500;600&display=swap');
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: #0d1117; }
        ::-webkit-scrollbar-thumb { background: #30363d; border-radius: 2px; }
        .tab-btn { background: none; border: none; cursor: pointer; padding: 8px 16px; border-bottom: 2px solid transparent; transition: all 0.15s; color: #666; font-family: inherit; font-size: 12px; letter-spacing: 0.05em; text-transform: uppercase; }
        .tab-btn:hover { color: #aaa; }
        .tab-btn.active { color: #00ff88; border-bottom-color: #00ff88; }
        .card { background: #0d1117; border: 1px solid #1c2128; border-radius: 8px; padding: 16px; }
        .metric-card { background: #0d1117; border: 1px solid #1c2128; border-radius: 8px; padding: 16px 20px; }
        .trade-row:hover { background: #111820; }
        .pulse { animation: pulse 2s ease-in-out infinite; }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
        .blink { animation: blink 1s step-end infinite; }
        @keyframes blink { 50% { opacity: 0; } }
        .scroll-area { max-height: 320px; overflow-y: auto; }
      `}</style>

      {/* Header */}
      <div style={{ borderBottom: "1px solid #1c2128", padding: "12px 24px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 18 }}>🤖</span>
            <span style={{ fontWeight: 600, fontSize: 14, color: "#fff", letterSpacing: "0.1em" }}>TRADING AI AGENT</span>
          </div>
          <div style={{ background: "#00ff8815", border: "1px solid #00ff8830", borderRadius: 4, padding: "2px 8px", display: "flex", alignItems: "center", gap: 6 }}>
            <span className="pulse" style={{ width: 6, height: 6, borderRadius: "50%", background: "#00ff88", display: "inline-block" }} />
            <span style={{ color: "#00ff88", fontSize: 11, letterSpacing: "0.1em" }}>{state.mode.toUpperCase()} MODE</span>
          </div>
          <span style={{ color: "#444", fontSize: 11 }}>v{state.strategy.split("v")[1] || "4"}</span>
        </div>
        <div style={{ display: "flex", gap: 24, alignItems: "center" }}>
          <div style={{ textAlign: "right" }}>
            <div style={{ color: "#555", fontSize: 10, letterSpacing: "0.05em" }}>PORTFOLIO VALUE</div>
            <div style={{ color: "#fff", fontSize: 18, fontWeight: 600 }}>{fmtUSD(state.portfolio.totalValue)}</div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ color: "#555", fontSize: 10 }}>RETURN</div>
            <div style={{ color: gain ? "#00ff88" : "#ff4466", fontSize: 16, fontWeight: 600 }}>{fmtPct(state.portfolio.totalReturnPct)}</div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ color: "#555", fontSize: 10 }}>TRADES</div>
            <div style={{ color: "#7aa2f7", fontSize: 16, fontWeight: 600 }}>{state.tradeCount}</div>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div style={{ borderBottom: "1px solid #1c2128", padding: "0 24px", display: "flex" }}>
        {["overview", "positions", "trades", "strategy", "logs"].map(t => (
          <button key={t} className={`tab-btn ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>{t}</button>
        ))}
      </div>

      <div style={{ padding: "20px 24px" }}>

        {/* OVERVIEW TAB */}
        {tab === "overview" && (
          <div style={{ display: "grid", gap: 16 }}>
            {/* Metrics row */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
              {[
                { label: "WIN RATE", value: `${state.performance.win_rate}%`, color: "#00ff88", sub: `${state.tradeCount} total trades` },
                { label: "SHARPE RATIO", value: state.performance.sharpe_ratio, color: "#7aa2f7", sub: "annualized" },
                { label: "AVG PROFIT", value: fmtUSD(state.performance.avg_profit), color: "#e6c274", sub: "per closed trade" },
                { label: "MAX DRAWDOWN", value: `-${state.performance.max_drawdown}%`, color: "#ff4466", sub: "from peak" },
              ].map((m, i) => (
                <div key={i} className="metric-card">
                  <div style={{ color: "#555", fontSize: 10, letterSpacing: "0.08em", marginBottom: 6 }}>{m.label}</div>
                  <div style={{ color: m.color, fontSize: 22, fontWeight: 600 }}>{m.value}</div>
                  <div style={{ color: "#444", fontSize: 10, marginTop: 4 }}>{m.sub}</div>
                </div>
              ))}
            </div>

            {/* Chart */}
            <div className="card">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                <span style={{ color: "#888", fontSize: 11, letterSpacing: "0.08em" }}>PORTFOLIO PERFORMANCE</span>
                <span style={{ color: gain ? "#00ff88" : "#ff4466", fontSize: 11 }}>{fmtPct(state.portfolio.totalReturnPct)} since start</span>
              </div>
              <PortfolioChart data={state.history} />
            </div>

            {/* Bottom row */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              {/* Allocation */}
              <div className="card">
                <div style={{ color: "#888", fontSize: 11, letterSpacing: "0.08em", marginBottom: 12 }}>ALLOCATION</div>
                <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
                  {[
                    { label: "CASH", value: state.portfolio.cashBalance / state.portfolio.totalValue * 100, color: "#444" },
                    { label: "BTC", value: state.portfolio.positions[0]?.currentValue / state.portfolio.totalValue * 100 || 0, color: "#f7931a" },
                    { label: "ETH", value: state.portfolio.positions[1]?.currentValue / state.portfolio.totalValue * 100 || 0, color: "#627eea" },
                    { label: "SOL", value: state.portfolio.positions[2]?.currentValue / state.portfolio.totalValue * 100 || 0, color: "#9945ff" },
                  ].map((a, i) => (
                    <div key={i} style={{ flex: a.value, background: a.color, height: 8, borderRadius: 2, minWidth: a.value > 1 ? 4 : 0 }} title={`${a.label}: ${a.value.toFixed(1)}%`} />
                  ))}
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                  {state.portfolio.positions.map((p, i) => (
                    <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", borderBottom: "1px solid #1c2128" }}>
                      <span style={{ color: "#aaa" }}>{p.symbol.split("-")[0]}</span>
                      <span style={{ color: p.unrealizedPnL >= 0 ? "#00ff88" : "#ff4466" }}>{fmtPct(p.unrealizedPnLPct)}</span>
                    </div>
                  ))}
                  <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0" }}>
                    <span style={{ color: "#555" }}>CASH</span>
                    <span style={{ color: "#555" }}>{(state.portfolio.cashBalance / state.portfolio.totalValue * 100).toFixed(1)}%</span>
                  </div>
                </div>
              </div>

              {/* Agent Status */}
              <div className="card">
                <div style={{ color: "#888", fontSize: 11, letterSpacing: "0.08em", marginBottom: 12 }}>AGENT STATUS</div>
                {[
                  { label: "Status", value: "Running", color: "#00ff88" },
                  { label: "Strategy", value: state.strategy, color: "#7aa2f7" },
                  { label: "Uptime", value: `${Math.floor(state.uptime / 60)}m ${state.uptime % 60}s`, color: "#e0e6ed" },
                  { label: "Next decision", value: "~45s", color: "#e6c274" },
                  { label: "Cash reserve", value: fmtUSD(state.portfolio.cashBalance), color: "#e0e6ed" },
                ].map((row, i) => (
                  <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "5px 0", borderBottom: "1px solid #1c2128" }}>
                    <span style={{ color: "#555" }}>{row.label}</span>
                    <span style={{ color: row.color, maxWidth: 180, textAlign: "right", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.value}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* POSITIONS TAB */}
        {tab === "positions" && (
          <div style={{ display: "grid", gap: 12 }}>
            <div className="card">
              <div style={{ color: "#888", fontSize: 11, letterSpacing: "0.08em", marginBottom: 16 }}>OPEN POSITIONS</div>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid #1c2128" }}>
                    {["SYMBOL", "QTY", "AVG ENTRY", "CURRENT", "VALUE", "PNL", "PNL %"].map(h => (
                      <th key={h} style={{ textAlign: "left", padding: "6px 8px", color: "#444", fontSize: 10, letterSpacing: "0.08em", fontWeight: 400 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {state.portfolio.positions.map((p, i) => (
                    <tr key={i} className="trade-row" style={{ borderBottom: "1px solid #0d1117" }}>
                      <td style={{ padding: "10px 8px", color: "#fff", fontWeight: 600 }}>{p.symbol}</td>
                      <td style={{ padding: "10px 8px", color: "#888" }}>{p.quantity.toFixed(6)}</td>
                      <td style={{ padding: "10px 8px", color: "#888" }}>{fmtUSD(p.avgPrice)}</td>
                      <td style={{ padding: "10px 8px", color: "#e0e6ed" }}>{fmtUSD(p.currentPrice)}</td>
                      <td style={{ padding: "10px 8px", color: "#e0e6ed" }}>{fmtUSD(p.currentValue)}</td>
                      <td style={{ padding: "10px 8px", color: p.unrealizedPnL >= 0 ? "#00ff88" : "#ff4466" }}>{p.unrealizedPnL >= 0 ? "+" : ""}{fmtUSD(p.unrealizedPnL)}</td>
                      <td style={{ padding: "10px 8px", color: p.unrealizedPnLPct >= 0 ? "#00ff88" : "#ff4466", fontWeight: 600 }}>{fmtPct(p.unrealizedPnLPct)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div style={{ marginTop: 16, paddingTop: 12, borderTop: "1px solid #1c2128", display: "flex", justifyContent: "space-between" }}>
                <span style={{ color: "#555" }}>Cash Balance</span>
                <span style={{ color: "#e0e6ed" }}>{fmtUSD(state.portfolio.cashBalance)}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6 }}>
                <span style={{ color: "#555" }}>Total Portfolio</span>
                <span style={{ color: "#fff", fontWeight: 600 }}>{fmtUSD(state.portfolio.totalValue)}</span>
              </div>
            </div>
          </div>
        )}

        {/* TRADES TAB */}
        {tab === "trades" && (
          <div className="card">
            <div style={{ color: "#888", fontSize: 11, letterSpacing: "0.08em", marginBottom: 16 }}>RECENT TRADES</div>
            <div className="scroll-area" style={{ maxHeight: 420 }}>
              {trades.map((t, i) => (
                <div key={i} className="trade-row" style={{ display: "grid", gridTemplateColumns: "60px 80px 80px 80px 80px 1fr 60px", gap: 8, alignItems: "center", padding: "10px 8px", borderBottom: "1px solid #0d1117" }}>
                  <span style={{ color: t.action === "BUY" ? "#00ff88" : "#ff4466", fontWeight: 600, fontSize: 12 }}>{t.action}</span>
                  <span style={{ color: "#e0e6ed" }}>{t.symbol.split("-")[0]}</span>
                  <span style={{ color: "#888" }}>{fmtUSD(t.amount_usd)}</span>
                  <span style={{ color: "#666", fontSize: 11 }}>@ {fmtUSD(t.price)}</span>
                  <span style={{ color: t.pnl === null ? "#555" : t.pnl >= 0 ? "#00ff88" : "#ff4466" }}>
                    {t.pnl === null ? "open" : `${t.pnl >= 0 ? "+" : ""}${fmtUSD(t.pnl)}`}
                  </span>
                  <span style={{ color: "#444", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.reason}</span>
                  <span style={{ color: "#333", fontSize: 10 }}>{fmtTime(t.timestamp)}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* STRATEGY TAB */}
        {tab === "strategy" && (
          <div style={{ display: "grid", gap: 12 }}>
            <div className="card">
              <div style={{ color: "#888", fontSize: 11, letterSpacing: "0.08em", marginBottom: 12 }}>CURRENT STRATEGY</div>
              <div style={{ color: "#7aa2f7", fontSize: 16, fontWeight: 600, marginBottom: 8 }}>{state.strategy}</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginTop: 16 }}>
                <div>
                  <div style={{ color: "#555", fontSize: 10, letterSpacing: "0.08em", marginBottom: 8 }}>ENTRY CONDITIONS</div>
                  {["RSI < 35 (oversold confirmation)", "MACD bullish crossover", "Price above EMA-20", "Volume > 1.5x average"].map((c, i) => (
                    <div key={i} style={{ padding: "4px 0", color: "#888", borderBottom: "1px solid #111" }}>
                      <span style={{ color: "#00ff88", marginRight: 8 }}>→</span>{c}
                    </div>
                  ))}
                </div>
                <div>
                  <div style={{ color: "#555", fontSize: 10, letterSpacing: "0.08em", marginBottom: 8 }}>EXIT CONDITIONS</div>
                  {["Take profit: +8-12%", "Stop loss: -3% (trailing)", "RSI > 72 (overbought)", "MACD bearish cross + BB upper"].map((c, i) => (
                    <div key={i} style={{ padding: "4px 0", color: "#888", borderBottom: "1px solid #111" }}>
                      <span style={{ color: "#ff4466", marginRight: 8 }}>←</span>{c}
                    </div>
                  ))}
                </div>
              </div>
            </div>
            <div className="card">
              <div style={{ color: "#888", fontSize: 11, letterSpacing: "0.08em", marginBottom: 12 }}>SELF-IMPROVEMENT LOG</div>
              {[
                { v: "v4", change: "Tightened entry: skip signals with confidence < 0.65", result: "+4.2% win rate" },
                { v: "v3", change: "Added volume confirmation filter to avoid false breakouts", result: "-1.8% drawdown" },
                { v: "v2", change: "Increased position sizing on high-confidence trades (>0.80)", result: "+$32 avg profit" },
                { v: "v1", change: "Initial strategy: basic RSI + MACD momentum", result: "baseline" },
              ].map((s, i) => (
                <div key={i} style={{ display: "grid", gridTemplateColumns: "40px 1fr 120px", gap: 12, padding: "8px 0", borderBottom: "1px solid #111" }}>
                  <span style={{ color: "#7aa2f7", fontWeight: 600 }}>{s.v}</span>
                  <span style={{ color: "#888" }}>{s.change}</span>
                  <span style={{ color: "#00ff88", fontSize: 11 }}>{s.result}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* LOGS TAB */}
        {tab === "logs" && (
          <div className="card">
            <div style={{ color: "#888", fontSize: 11, letterSpacing: "0.08em", marginBottom: 12, display: "flex", justifyContent: "space-between" }}>
              <span>AGENT LOGS</span>
              <span style={{ color: "#333" }}><span className="blink">■</span> LIVE</span>
            </div>
            <div className="scroll-area" style={{ fontFamily: "monospace", fontSize: 11, lineHeight: "1.6" }}>
              {logs.map((log, i) => (
                <div key={i} style={{ padding: "3px 0", borderBottom: "1px solid #0a0e12", display: "flex", gap: 12 }}>
                  <span style={{ color: "#333", flexShrink: 0 }}>{fmtTime(log.timestamp)}</span>
                  <span style={{ color: log.level === "TRADE" ? "#e6c274" : log.level === "ERROR" ? "#ff4466" : log.level === "WARN" ? "#ff9500" : "#555", flexShrink: 0, width: 36 }}>{log.level.slice(0,4)}</span>
                  <span style={{ color: "#888" }}>{log.message}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
