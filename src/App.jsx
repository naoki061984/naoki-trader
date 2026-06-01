import { useState, useEffect, useRef, useCallback } from "react";

// ══════════════════════════════════════════════
// カラーパレット
// ══════════════════════════════════════════════
const C = {
  bg:     "#060810",
  panel:  "#0a0d14",
  card:   "#0e1220",
  border: "#161e2e",
  b2:     "#1e2a3a",
  accent: "#00ffe0",
  blue:   "#3d8eff",
  green:  "#00ff88",
  red:    "#ff3355",
  yellow: "#ffcc00",
  purple: "#9b6dff",
  text:   "#d0dcea",
  dim:    "#4a6070",
  muted:  "#131b28",
};

// ══════════════════════════════════════════════
// テクニカル指標計算
// ══════════════════════════════════════════════
function calcEMA(data, period) {
  const k = 2 / (period + 1);
  let ema = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const result = new Array(period - 1).fill(null);
  result.push(ema);
  for (let i = period; i < data.length; i++) {
    ema = data[i] * k + ema * (1 - k);
    result.push(ema);
  }
  return result;
}

function calcMACD(closes) {
  if (closes.length < 26) return { macd: null, signal: null, hist: null };
  const ema12 = calcEMA(closes, 12);
  const ema26 = calcEMA(closes, 26);
  const macdLine = ema12.map((v, i) => (v !== null && ema26[i] !== null) ? v - ema26[i] : null);
  const validMacd = macdLine.filter(v => v !== null);
  if (validMacd.length < 9) return { macd: null, signal: null, hist: null };
  const signalLine = calcEMA(validMacd, 9);
  const lastMacd   = validMacd[validMacd.length - 1];
  const lastSignal = signalLine[signalLine.length - 1];
  return {
    macd:   lastMacd,
    signal: lastSignal,
    hist:   lastMacd - lastSignal,
    macdLine, signalLine,
  };
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function calcBB(closes, period = 20) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const mean  = slice.reduce((a, b) => a + b, 0) / period;
  const std   = Math.sqrt(slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period);
  return { upper: mean + 2 * std, mid: mean, lower: mean - 2 * std };
}

function calcVolatility(closes, period = 10) {
  if (closes.length < period + 1) return null;
  const returns = [];
  for (let i = closes.length - period; i < closes.length; i++) {
    returns.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  }
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length;
  return Math.sqrt(variance) * 100;
}

// ══════════════════════════════════════════════
// スコアリング（-100 〜 +100）
// ══════════════════════════════════════════════
function computeScore({ macd, rsi, bb, price, change, vol }) {
  let score = 0;
  const reasons = [];

  // MACD
  if (macd?.hist !== null && macd?.macd !== null) {
    if (macd.hist > 0 && macd.macd > 0)       { score += 30; reasons.push("MACD強気"); }
    else if (macd.hist > 0 && macd.macd < 0)  { score += 15; reasons.push("MACDクロス上昇"); }
    else if (macd.hist < 0 && macd.macd < 0)  { score -= 30; reasons.push("MACD弱気"); }
    else if (macd.hist < 0 && macd.macd > 0)  { score -= 15; reasons.push("MACDクロス下降"); }
  }

  // RSI
  if (rsi !== null) {
    if (rsi < 30)       { score += 25; reasons.push(`RSI売られ過ぎ(${rsi.toFixed(1)})`); }
    else if (rsi < 45)  { score += 10; reasons.push(`RSI低め(${rsi.toFixed(1)})`); }
    else if (rsi > 70)  { score -= 25; reasons.push(`RSI買われ過ぎ(${rsi.toFixed(1)})`); }
    else if (rsi > 55)  { score -= 10; reasons.push(`RSI高め(${rsi.toFixed(1)})`); }
  }

  // ボリンジャーバンド
  if (bb && price) {
    const pos = (price - bb.lower) / (bb.upper - bb.lower);
    if (pos < 0.1)      { score += 20; reasons.push("BB下限タッチ"); }
    else if (pos < 0.3) { score += 10; reasons.push("BB下半分"); }
    else if (pos > 0.9) { score -= 20; reasons.push("BB上限タッチ"); }
    else if (pos > 0.7) { score -= 10; reasons.push("BB上半分"); }
  }

  // 価格変動率
  if (change !== null) {
    if (change < -5)      { score += 15; reasons.push("急落(反発期待)"); }
    else if (change < -2) { score += 8;  reasons.push("下落"); }
    else if (change > 5)  { score -= 15; reasons.push("急騰(反落警戒)"); }
    else if (change > 2)  { score -= 8;  reasons.push("上昇"); }
  }

  // ボラティリティ
  if (vol !== null) {
    if (vol > 3)        { score = score * 0.7; reasons.push("高ボラ(スコア減衰)"); }
    else if (vol < 0.5) { score = score * 0.5; reasons.push("低ボラ(様子見)"); }
  }

  return { score: Math.max(-100, Math.min(100, score)), reasons };
}

// ══════════════════════════════════════════════
// MEXC API
// ══════════════════════════════════════════════
const MEXC = "https://api.mexc.com";

async function mxGet(path, params = {}) {
  const q = new URLSearchParams(params).toString();
  const r = await fetch(`${MEXC}${path}${q ? "?" + q : ""}`, { timeout: 10000 });
  return r.json();
}

async function mxSign(apiKey, apiSecret, params) {
  const ts = Date.now();
  const p  = new URLSearchParams({ ...params, timestamp: ts });
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(apiSecret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(p.toString()));
  const hex = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");
  p.append("signature", hex);
  return { headers: { "X-MEXC-APIKEY": apiKey, "Content-Type": "application/x-www-form-urlencoded" }, body: p.toString() };
}

async function placeSpotOrder({ apiKey, apiSecret, symbol, side, qty }) {
  const { headers, body } = await mxSign(apiKey, apiSecret, { symbol, side, type: "MARKET", quantity: String(qty) });
  const r = await fetch(`${MEXC}/api/v3/order`, { method: "POST", headers, body });
  return r.json();
}

async function placeFuturesOrder({ apiKey, apiSecret, symbol, side, qty, leverage = 5 }) {
  // レバレッジ設定
  await (async () => {
    const { headers, body } = await mxSign(apiKey, apiSecret, { symbol, leverage });
    await fetch(`${MEXC}/api/v1/private/position/change_leverage`, { method: "POST", headers, body });
  })().catch(() => {});
  const { headers, body } = await mxSign(apiKey, apiSecret, {
    symbol, side, openType: "isolated", type: 5,
    vol: String(qty), leverage
  });
  const r = await fetch(`${MEXC}/api/v1/private/order/submit`, { method: "POST", headers, body });
  return r.json();
}

// ══════════════════════════════════════════════
// OrcaRouter AI判断
// ══════════════════════════════════════════════
async function askOrca({ orcaKey, symbol, price, change, rsi, macdHist, bbPos, score, reasons, mode }) {
  const prompt = `あなたはプロの暗号資産トレーダーです。以下のデータを基に売買判断してください。

## ${symbol} リアルタイム分析
- 現在値: $${price?.toLocaleString()}
- 24h変動: ${change?.toFixed(2)}%
- RSI(14): ${rsi?.toFixed(1) ?? "N/A"}
- MACDヒスト: ${macdHist?.toFixed(4) ?? "N/A"}
- BBポジション: ${bbPos !== null ? (bbPos * 100).toFixed(0) + "%" : "N/A"}
- テクニカルスコア: ${score?.toFixed(0)} / 100（正=買い方向、負=売り方向）
- シグナル理由: ${reasons?.join(", ")}
- 取引モード: ${mode === "futures" ? "先物" : "現物"}

判断ルール：
- スコア+40以上 → BUY検討
- スコア-40以下 → SELL検討（先物のみ）
- それ以外 → HOLD

必ず最後に以下のJSONのみを出力してください（他の形式不可）：
{"action":"BUY","confidence":85,"reason":"RSI売られ過ぎ＋MACD上昇"}
または
{"action":"SELL","confidence":72,"reason":"RSI買われ過ぎ＋BB上限"}
または
{"action":"HOLD","confidence":60,"reason":"シグナル不明瞭"}`;

  const res = await fetch("https://api.orcarouter.ai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${orcaKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "orcarouter/auto",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 200,
    }),
  });
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content ?? "";
  const m = text.match(/\{.*?"action".*?\}/s);
  if (m) {
    try { return JSON.parse(m[0]); } catch {}
  }
  return { action: "HOLD", confidence: 0, reason: "AI解析失敗" };
}

// ══════════════════════════════════════════════
// ミニチャート
// ══════════════════════════════════════════════
function Sparkline({ data, color, height = 40, width = 140 }) {
  if (!data || data.length < 2) return null;
  const valid = data.filter(v => v !== null && !isNaN(v));
  if (valid.length < 2) return null;
  const min = Math.min(...valid), max = Math.max(...valid);
  const range = max - min || 1;
  const pts = valid.map((v, i) =>
    `${(i / (valid.length - 1)) * width},${height - ((v - min) / range) * (height - 4) - 2}`
  ).join(" ");
  return (
    <svg width={width} height={height} style={{ display: "block" }}>
      <defs>
        <linearGradient id={`g${color.replace("#","")}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.3" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

// ══════════════════════════════════════════════
// スコアゲージ
// ══════════════════════════════════════════════
function ScoreGauge({ score }) {
  const pct   = ((score + 100) / 200) * 100;
  const color = score > 40 ? C.green : score < -40 ? C.red : C.yellow;
  return (
    <div style={{ position: "relative", height: 6, background: C.muted, borderRadius: 3, overflow: "hidden" }}>
      <div style={{ position: "absolute", left: "50%", width: "1px", height: "100%", background: C.border, zIndex: 1 }} />
      <div style={{
        position: "absolute",
        left: score >= 0 ? "50%" : `${pct}%`,
        width: `${Math.abs(score) / 2}%`,
        height: "100%",
        background: color,
        borderRadius: 3,
        transition: "all 0.4s ease",
        boxShadow: `0 0 6px ${color}`,
      }} />
    </div>
  );
}

// ══════════════════════════════════════════════
// メインアプリ
// ══════════════════════════════════════════════
const PAIRS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "BNBUSDT"];

export default function App() {
  // Keys
  const [keys, setKeys] = useState({ orca: "", mexc: "", secret: "" });
  const [keySaved, setKeySaved] = useState(false);
  const [activeTab, setActiveTab] = useState("dashboard");

  // Market data
  const [market, setMarket]   = useState({});
  const [klines, setKlines]   = useState({});
  const [indicators, setIndicators] = useState({});
  const [scores, setScores]   = useState({});
  const [selected, setSelected] = useState("BTCUSDT");
  const [lastTick, setLastTick] = useState(null);

  // Auto-trade config
  const [config, setConfig] = useState({
    enabled:    false,
    mode:       "spot",       // spot | futures
    pair:       "BTCUSDT",
    qty:        "0.001",
    leverage:   5,
    interval:   5,            // 分
    scoreThreshold: 40,       // この値以上でBUY/SELL
    minConfidence: 60,        // AI信頼度下限
    stopLoss:   2.0,          // %
    takeProfit: 4.0,          // %
  });

  // Trade log & positions
  const [log, setLog]       = useState([]);
  const [position, setPosition] = useState(null); // 現在ポジション
  const [aiDecisions, setAiDecisions] = useState([]);

  // Auto-trade refs
  const autoRef = useRef(null);
  const posRef  = useRef(null);
  posRef.current = position;

  // ── 価格取得
  const fetchMarket = useCallback(async () => {
    const results = {};
    await Promise.all(PAIRS.map(async p => {
      try {
        const t = await mxGet("/api/v3/ticker/24hr", { symbol: p });
        results[p] = {
          price:  parseFloat(t.lastPrice),
          change: parseFloat(t.priceChangePercent),
          high:   parseFloat(t.highPrice),
          low:    parseFloat(t.lowPrice),
          vol:    parseFloat(t.quoteVolume),
        };
      } catch {}
    }));
    setMarket(results);
    setLastTick(new Date());
  }, []);

  // ── ローソク足 + 指標計算
  const fetchKlinesAndCalc = useCallback(async (pair) => {
    try {
      const raw = await mxGet("/api/v3/klines", { symbol: pair, interval: "15m", limit: 60 });
      if (!Array.isArray(raw)) return;
      const closes = raw.map(k => parseFloat(k[4]));
      setKlines(prev => ({ ...prev, [pair]: closes }));

      const macd  = calcMACD(closes);
      const rsi   = calcRSI(closes);
      const bb    = calcBB(closes);
      const vol   = calcVolatility(closes);
      const price = closes[closes.length - 1];
      const bbPos = bb ? (price - bb.lower) / (bb.upper - bb.lower) : null;

      setIndicators(prev => ({ ...prev, [pair]: { macd, rsi, bb, vol, bbPos } }));

      const mkt    = market[pair];
      const change = mkt?.change ?? null;
      const { score, reasons } = computeScore({ macd, rsi, bb, price, change, vol });
      setScores(prev => ({ ...prev, [pair]: { score, reasons } }));
    } catch (e) { console.error("klines error", pair, e); }
  }, [market]);

  useEffect(() => {
    fetchMarket();
    const id = setInterval(fetchMarket, 10000);
    return () => clearInterval(id);
  }, [fetchMarket]);

  useEffect(() => {
    PAIRS.forEach(p => fetchKlinesAndCalc(p));
    const id = setInterval(() => PAIRS.forEach(p => fetchKlinesAndCalc(p)), 60000);
    return () => clearInterval(id);
  }, [fetchKlinesAndCalc]);

  // ── SL/TP監視
  useEffect(() => {
    if (!position) return;
    const id = setInterval(() => {
      const cur = market[position.symbol]?.price;
      if (!cur) return;
      const entryPrice = position.entry;
      const side       = position.side;
      const pnlPct     = side === "BUY"
        ? (cur - entryPrice) / entryPrice * 100
        : (entryPrice - cur) / entryPrice * 100;

      if (pnlPct <= -config.stopLoss) {
        addLog({ type: "SL発動", symbol: position.symbol, side: position.side === "BUY" ? "SELL" : "BUY", pnl: pnlPct.toFixed(2) + "%" });
        setPosition(null);
      } else if (pnlPct >= config.takeProfit) {
        addLog({ type: "TP達成", symbol: position.symbol, side: position.side === "BUY" ? "SELL" : "BUY", pnl: "+" + pnlPct.toFixed(2) + "%" });
        setPosition(null);
      }
    }, 5000);
    return () => clearInterval(id);
  }, [position, market, config.stopLoss, config.takeProfit]);

  // ── 自動売買ループ
  const runAutoTrade = useCallback(async () => {
    if (!keys.orca) return;
    const pair   = config.pair;
    const ind    = indicators[pair];
    const sc     = scores[pair];
    const mkt    = market[pair];
    if (!ind || !sc || !mkt) return;

    const bbPos = ind.bbPos;

    // ポジション中はスキップ
    if (posRef.current) {
      addLog({ type: "スキップ", symbol: pair, detail: "ポジション保有中" });
      return;
    }

    // OrcaRouter AI判断
    let aiResult;
    try {
      aiResult = await askOrca({
        orcaKey: keys.orca,
        symbol: pair,
        price:   mkt.price,
        change:  mkt.change,
        rsi:     ind.rsi,
        macdHist: ind.macd?.hist,
        bbPos,
        score:   sc.score,
        reasons: sc.reasons,
        mode:    config.mode,
      });
    } catch (e) {
      addLog({ type: "AIエラー", detail: e.message });
      return;
    }

    setAiDecisions(prev => [{ time: new Date().toLocaleTimeString("ja-JP"), pair, ...aiResult, score: sc.score }, ...prev.slice(0, 19)]);

    // 条件チェック
    const absScore  = Math.abs(sc.score);
    const meetsScore = absScore >= config.scoreThreshold;
    const meetsConf  = aiResult.confidence >= config.minConfidence;

    if (!meetsScore || !meetsConf || aiResult.action === "HOLD") {
      addLog({ type: "HOLD", symbol: pair, detail: `スコア${sc.score.toFixed(0)} AI:${aiResult.action}(${aiResult.confidence}%)` });
      return;
    }

    // 注文実行
    if (!keys.mexc || !keys.secret) {
      addLog({ type: "注文スキップ", detail: "MEXCキー未設定" });
      return;
    }

    try {
      let result;
      if (config.mode === "spot") {
        result = await placeSpotOrder({ apiKey: keys.mexc, apiSecret: keys.secret, symbol: pair, side: aiResult.action, qty: parseFloat(config.qty) });
      } else {
        result = await placeFuturesOrder({ apiKey: keys.mexc, apiSecret: keys.secret, symbol: pair, side: aiResult.action, qty: parseFloat(config.qty), leverage: config.leverage });
      }
      setPosition({ symbol: pair, side: aiResult.action, entry: mkt.price, qty: config.qty, time: new Date() });
      addLog({ type: config.mode === "spot" ? "現物注文" : "先物注文", symbol: pair, side: aiResult.action, qty: config.qty, score: sc.score.toFixed(0), confidence: aiResult.confidence, reason: aiResult.reason, result: JSON.stringify(result).slice(0, 60) });
    } catch (e) {
      addLog({ type: "注文エラー", detail: e.message });
    }
  }, [keys, config, indicators, scores, market]);

  useEffect(() => {
    clearInterval(autoRef.current);
    if (!config.enabled) return;
    runAutoTrade();
    autoRef.current = setInterval(runAutoTrade, config.interval * 60 * 1000);
    return () => clearInterval(autoRef.current);
  }, [config.enabled, config.interval, runAutoTrade]);

  const addLog = (entry) => setLog(prev => [{ time: new Date().toLocaleTimeString("ja-JP"), ...entry }, ...prev.slice(0, 99)]);

  // ══════════════════════════════
  // ヘルパーUI
  // ══════════════════════════════
  const Label = ({ children }) => (
    <div style={{ fontSize: 9, color: C.dim, letterSpacing: 2, marginBottom: 5, textTransform: "uppercase" }}>{children}</div>
  );

  const Input = ({ value, onChange, type = "text", placeholder = "" }) => (
    <input type={type} value={value} onChange={onChange} placeholder={placeholder}
      style={{ width: "100%", background: C.muted, border: `1px solid ${C.border}`, borderRadius: 5, padding: "7px 10px", color: C.text, fontSize: 12, fontFamily: "inherit" }}
    />
  );

  const Btn = ({ onClick, color, children, disabled, small }) => (
    <button onClick={onClick} disabled={disabled} style={{
      background: disabled ? C.muted : color, color: color === C.muted ? C.dim : "#000",
      border: "none", borderRadius: 5, padding: small ? "5px 12px" : "8px 16px",
      fontWeight: 800, cursor: disabled ? "not-allowed" : "pointer", fontSize: small ? 11 : 12,
      fontFamily: "inherit", transition: "all 0.15s", whiteSpace: "nowrap",
    }}>{children}</button>
  );

  const Tab = ({ id, children }) => (
    <button onClick={() => setActiveTab(id)} style={{
      background: activeTab === id ? C.accent : "transparent",
      color: activeTab === id ? "#000" : C.dim,
      border: "none", padding: "6px 14px", borderRadius: 5,
      fontWeight: 800, fontSize: 11, cursor: "pointer", fontFamily: "inherit", letterSpacing: 1,
    }}>{children}</button>
  );

  const sel = market[selected];
  const selInd = indicators[selected];
  const selSc  = scores[selected];

  // ══════════════════════════════════════════════
  // RENDER
  // ══════════════════════════════════════════════
  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: C.text, fontFamily: "'Courier New', monospace", fontSize: 13 }}>
      <style>{`
        * { box-sizing: border-box; margin: 0; padding: 0; }
        ::-webkit-scrollbar { width: 3px; height: 3px; }
        ::-webkit-scrollbar-thumb { background: ${C.b2}; }
        input:focus, select:focus { outline: none; border-color: ${C.accent} !important; }
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }
        @keyframes fadeUp { from{opacity:0;transform:translateY(8px)} to{opacity:1;transform:translateY(0)} }
        .row-in { animation: fadeUp 0.25s ease; }
        button:not(:disabled):hover { filter: brightness(1.1); }
      `}</style>

      {/* ─────── ヘッダー ─────── */}
      <div style={{ background: C.panel, borderBottom: `1px solid ${C.border}`, padding: "12px 18px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 32, height: 32, borderRadius: 8, background: `linear-gradient(135deg, ${C.accent}, ${C.blue})`, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 900, color: "#000", fontSize: 14 }}>N</div>
          <div>
            <div style={{ fontWeight: 900, fontSize: 14, letterSpacing: 1.5 }}>NAOKI AUTO TRADER</div>
            <div style={{ fontSize: 9, color: C.dim, letterSpacing: 3 }}>MACD · RSI · BB · ORCA AI</div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          {config.enabled && (
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10, color: C.green }}>
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: C.green, display: "inline-block", animation: "pulse 1.2s infinite" }} />
              AUTO ON · {config.pair} · {config.mode.toUpperCase()}
            </div>
          )}
          {position && (
            <div style={{ fontSize: 10, color: C.yellow, border: `1px solid ${C.yellow}44`, borderRadius: 4, padding: "3px 8px" }}>
              ⚡ {position.side} {position.symbol} @ ${position.entry?.toLocaleString()}
            </div>
          )}
          <div style={{ fontSize: 10, color: C.dim }}>{lastTick?.toLocaleTimeString("ja-JP") ?? "--"}</div>
        </div>
      </div>

      {/* ─────── ティッカー ─────── */}
      <div style={{ display: "flex", borderBottom: `1px solid ${C.border}`, overflowX: "auto" }}>
        {PAIRS.map(p => {
          const d  = market[p];
          const sc = scores[p];
          const up = d?.change >= 0;
          const isSel = p === selected;
          return (
            <div key={p} onClick={() => setSelected(p)} style={{
              flex: "1 0 130px", padding: "10px 14px", cursor: "pointer",
              borderRight: `1px solid ${C.border}`,
              background: isSel ? `${C.accent}0c` : "transparent",
              borderBottom: `2px solid ${isSel ? C.accent : "transparent"}`,
            }}>
              <div style={{ fontSize: 9, color: C.dim, letterSpacing: 2, marginBottom: 3 }}>{p.replace("USDT", "/USDT")}</div>
              <div style={{ fontSize: 15, fontWeight: 700 }}>{d ? `$${d.price.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : "--"}</div>
              <div style={{ fontSize: 10, color: d ? (up ? C.green : C.red) : C.dim }}>
                {d ? `${up ? "▲" : "▼"}${Math.abs(d.change).toFixed(2)}%` : "--"}
              </div>
              {sc && <ScoreGauge score={sc.score} />}
            </div>
          );
        })}
      </div>

      {/* ─────── メインレイアウト ─────── */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 300px", height: "calc(100vh - 130px)" }}>

        {/* ── 左メイン ── */}
        <div style={{ display: "flex", flexDirection: "column", borderRight: `1px solid ${C.border}`, overflow: "hidden" }}>

          {/* タブ */}
          <div style={{ display: "flex", gap: 4, padding: "8px 14px", borderBottom: `1px solid ${C.border}`, background: C.panel }}>
            <Tab id="dashboard">DASHBOARD</Tab>
            <Tab id="analysis">ANALYSIS</Tab>
            <Tab id="config">CONFIG</Tab>
            <Tab id="log">LOG {log.length > 0 && `(${log.length})`}</Tab>
          </div>

          {/* ── ダッシュボード ── */}
          {activeTab === "dashboard" && (
            <div style={{ flex: 1, overflow: "auto", padding: 16 }}>
              {/* 選択ペア詳細 */}
              <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: "14px 18px", marginBottom: 14 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 14 }}>
                  <div>
                    <div style={{ fontSize: 9, color: C.dim, letterSpacing: 3, marginBottom: 4 }}>{selected.replace("USDT", "/USDT")} · 15分足</div>
                    <div style={{ fontSize: 26, fontWeight: 900, letterSpacing: -1 }}>
                      {sel ? `$${sel.price.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : "--"}
                    </div>
                  </div>
                  {selSc && (
                    <div style={{ textAlign: "right" }}>
                      <div style={{ fontSize: 9, color: C.dim, letterSpacing: 2, marginBottom: 4 }}>SCORE</div>
                      <div style={{ fontSize: 28, fontWeight: 900, color: selSc.score > 40 ? C.green : selSc.score < -40 ? C.red : C.yellow }}>
                        {selSc.score > 0 ? "+" : ""}{selSc.score.toFixed(0)}
                      </div>
                    </div>
                  )}
                </div>

                {/* スパークライン */}
                <Sparkline data={klines[selected]} color={sel?.change >= 0 ? C.green : C.red} width={400} height={50} />

                {/* 指標グリッド */}
                {selInd && (
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, marginTop: 14 }}>
                    {[
                      ["RSI", selInd.rsi?.toFixed(1) ?? "--", selInd.rsi < 30 ? C.green : selInd.rsi > 70 ? C.red : C.text],
                      ["MACD", selInd.macd?.macd?.toFixed(4) ?? "--", selInd.macd?.hist > 0 ? C.green : C.red],
                      ["MACD Hist", selInd.macd?.hist?.toFixed(4) ?? "--", selInd.macd?.hist > 0 ? C.green : C.red],
                      ["BB%", selInd.bbPos !== null ? (selInd.bbPos * 100).toFixed(0) + "%" : "--", selInd.bbPos < 0.2 ? C.green : selInd.bbPos > 0.8 ? C.red : C.text],
                      ["ボラ", selInd.vol?.toFixed(2) + "%" ?? "--", selInd.vol > 3 ? C.red : selInd.vol < 0.5 ? C.yellow : C.text],
                      ["BB上限", selInd.bb?.upper?.toFixed(2) ?? "--", C.text],
                      ["BB中央", selInd.bb?.mid?.toFixed(2) ?? "--", C.text],
                      ["BB下限", selInd.bb?.lower?.toFixed(2) ?? "--", C.text],
                    ].map(([k, v, color]) => (
                      <div key={k} style={{ background: C.muted, borderRadius: 6, padding: "8px 10px" }}>
                        <div style={{ fontSize: 9, color: C.dim, marginBottom: 3, letterSpacing: 1 }}>{k}</div>
                        <div style={{ fontSize: 14, fontWeight: 700, color }}>{v}</div>
                      </div>
                    ))}
                  </div>
                )}

                {/* シグナル理由 */}
                {selSc?.reasons?.length > 0 && (
                  <div style={{ marginTop: 12, display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {selSc.reasons.map((r, i) => (
                      <span key={i} style={{ fontSize: 10, padding: "3px 8px", borderRadius: 4, background: C.muted, color: C.dim, border: `1px solid ${C.border}` }}>{r}</span>
                    ))}
                  </div>
                )}
              </div>

              {/* AI判断履歴 */}
              <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: "14px 18px" }}>
                <Label>AI判断履歴（直近）</Label>
                {aiDecisions.length === 0 ? (
                  <div style={{ color: C.dim, fontSize: 12, padding: "12px 0" }}>自動売買を開始するとここにAI判断が表示されます</div>
                ) : aiDecisions.map((d, i) => (
                  <div key={i} className="row-in" style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 0", borderBottom: `1px solid ${C.border}` }}>
                    <span style={{ fontSize: 9, color: C.dim, minWidth: 55 }}>{d.time}</span>
                    <span style={{ fontSize: 10, fontWeight: 700, color: d.action === "BUY" ? C.green : d.action === "SELL" ? C.red : C.yellow, minWidth: 36 }}>{d.action}</span>
                    <span style={{ fontSize: 10, color: C.dim }}>{d.pair}</span>
                    <span style={{ fontSize: 10, color: C.text }}>信頼度 {d.confidence}%</span>
                    <span style={{ fontSize: 10, color: C.dim, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.reason}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── 分析タブ ── */}
          {activeTab === "analysis" && (
            <div style={{ flex: 1, overflow: "auto", padding: 16 }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                {PAIRS.map(p => {
                  const d  = market[p];
                  const sc = scores[p];
                  const ind = indicators[p];
                  const kl  = klines[p];
                  if (!d || !sc) return null;
                  return (
                    <div key={p} style={{ background: C.card, border: `1px solid ${selected === p ? C.accent : C.border}`, borderRadius: 10, padding: "12px 14px", cursor: "pointer" }} onClick={() => setSelected(p)}>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                        <span style={{ fontSize: 10, fontWeight: 800, color: C.text }}>{p.replace("USDT", "/USDT")}</span>
                        <span style={{ fontSize: 11, fontWeight: 900, color: sc.score > 40 ? C.green : sc.score < -40 ? C.red : C.yellow }}>
                          {sc.score > 0 ? "+" : ""}{sc.score.toFixed(0)}
                        </span>
                      </div>
                      <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 6 }}>${d.price.toLocaleString(undefined, { maximumFractionDigits: 2 })}</div>
                      <ScoreGauge score={sc.score} />
                      <Sparkline data={kl} color={d.change >= 0 ? C.green : C.red} width={220} height={36} />
                      {ind && (
                        <div style={{ display: "flex", gap: 10, marginTop: 6 }}>
                          <span style={{ fontSize: 9, color: ind.rsi < 30 ? C.green : ind.rsi > 70 ? C.red : C.dim }}>RSI {ind.rsi?.toFixed(0) ?? "--"}</span>
                          <span style={{ fontSize: 9, color: ind.macd?.hist > 0 ? C.green : C.red }}>MACD {ind.macd?.hist > 0 ? "↑" : "↓"}</span>
                          <span style={{ fontSize: 9, color: C.dim }}>BB {ind.bbPos !== null ? (ind.bbPos * 100).toFixed(0) + "%" : "--"}</span>
                        </div>
                      )}
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 6 }}>
                        {sc.reasons?.slice(0, 3).map((r, i) => (
                          <span key={i} style={{ fontSize: 9, padding: "2px 6px", background: C.muted, borderRadius: 3, color: C.dim }}>{r}</span>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* ── 設定タブ ── */}
          {activeTab === "config" && (
            <div style={{ flex: 1, overflow: "auto", padding: 16 }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                {/* 基本設定 */}
                <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: "14px 16px" }}>
                  <Label>基本設定</Label>
                  <div style={{ display: "grid", gap: 10 }}>
                    <div>
                      <Label>対象ペア</Label>
                      <select value={config.pair} onChange={e => setConfig(c => ({ ...c, pair: e.target.value }))}
                        style={{ width: "100%", background: C.muted, border: `1px solid ${C.border}`, borderRadius: 5, padding: "7px 10px", color: C.text, fontSize: 12, fontFamily: "inherit" }}>
                        {PAIRS.map(p => <option key={p} value={p}>{p}</option>)}
                      </select>
                    </div>
                    <div>
                      <Label>取引モード</Label>
                      <div style={{ display: "flex", gap: 6 }}>
                        {[["spot", "現物"], ["futures", "先物"]].map(([v, l]) => (
                          <button key={v} onClick={() => setConfig(c => ({ ...c, mode: v }))} style={{
                            flex: 1, padding: "7px", borderRadius: 5,
                            border: `1px solid ${config.mode === v ? C.accent : C.border}`,
                            background: config.mode === v ? `${C.accent}18` : C.muted,
                            color: config.mode === v ? C.accent : C.dim,
                            fontWeight: 700, cursor: "pointer", fontSize: 12, fontFamily: "inherit",
                          }}>{l}</button>
                        ))}
                      </div>
                    </div>
                    <div>
                      <Label>注文数量</Label>
                      <Input value={config.qty} onChange={e => setConfig(c => ({ ...c, qty: e.target.value }))} />
                    </div>
                    {config.mode === "futures" && (
                      <div>
                        <Label>レバレッジ</Label>
                        <Input value={config.leverage} onChange={e => setConfig(c => ({ ...c, leverage: +e.target.value }))} type="number" />
                      </div>
                    )}
                    <div>
                      <Label>実行間隔（分）</Label>
                      <Input value={config.interval} onChange={e => setConfig(c => ({ ...c, interval: +e.target.value }))} type="number" />
                    </div>
                  </div>
                </div>

                {/* リスク管理 */}
                <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: "14px 16px" }}>
                  <Label>リスク管理 · 閾値</Label>
                  <div style={{ display: "grid", gap: 10 }}>
                    <div>
                      <Label>スコア閾値（BUY/SELL発火）</Label>
                      <Input value={config.scoreThreshold} onChange={e => setConfig(c => ({ ...c, scoreThreshold: +e.target.value }))} type="number" />
                      <div style={{ fontSize: 9, color: C.dim, marginTop: 3 }}>スコア ±{config.scoreThreshold}以上で注文</div>
                    </div>
                    <div>
                      <Label>AI信頼度下限（%）</Label>
                      <Input value={config.minConfidence} onChange={e => setConfig(c => ({ ...c, minConfidence: +e.target.value }))} type="number" />
                    </div>
                    <div>
                      <Label>ストップロス（%）</Label>
                      <Input value={config.stopLoss} onChange={e => setConfig(c => ({ ...c, stopLoss: +e.target.value }))} type="number" />
                    </div>
                    <div>
                      <Label>テイクプロフィット（%）</Label>
                      <Input value={config.takeProfit} onChange={e => setConfig(c => ({ ...c, takeProfit: +e.target.value }))} type="number" />
                    </div>
                  </div>
                </div>
              </div>

              {/* 起動/停止 */}
              <div style={{ marginTop: 14 }}>
                <button onClick={() => setConfig(c => ({ ...c, enabled: !c.enabled }))} style={{
                  width: "100%", padding: "14px",
                  background: config.enabled ? C.red : C.green, color: "#000",
                  border: "none", borderRadius: 8, fontWeight: 900, cursor: "pointer", fontSize: 15,
                  fontFamily: "inherit", letterSpacing: 1,
                  boxShadow: config.enabled ? `0 0 20px ${C.red}55` : `0 0 20px ${C.green}55`,
                  transition: "all 0.2s",
                }}>
                  {config.enabled ? "⏹  自動売買を停止" : "▶  自動売買を開始"}
                </button>
                <div style={{ marginTop: 8, fontSize: 10, color: C.dim, textAlign: "center" }}>
                  {config.enabled
                    ? `${config.interval}分ごとに ${config.pair} を分析 · スコア±${config.scoreThreshold} · AI信頼度${config.minConfidence}%以上で発注`
                    : "OrcaRouter APIキーとMEXC APIキーを設定してから起動してください"}
                </div>
              </div>
            </div>
          )}

          {/* ── ログタブ ── */}
          {activeTab === "log" && (
            <div style={{ flex: 1, overflow: "auto", padding: 16 }}>
              {log.length === 0 ? (
                <div style={{ color: C.dim, textAlign: "center", paddingTop: 40, fontSize: 12 }}>ログなし</div>
              ) : log.map((l, i) => {
                const typeColor = l.type.includes("注文") ? C.accent : l.type.includes("エラー") ? C.red : l.type === "TP達成" ? C.green : l.type === "SL発動" ? C.red : C.dim;
                return (
                  <div key={i} className="row-in" style={{ borderBottom: `1px solid ${C.border}`, padding: "8px 0", display: "grid", gridTemplateColumns: "55px 80px 1fr", gap: 8, alignItems: "center" }}>
                    <span style={{ fontSize: 9, color: C.dim }}>{l.time}</span>
                    <span style={{ fontSize: 10, fontWeight: 800, color: typeColor }}>{l.type}</span>
                    <div style={{ fontSize: 11, color: C.text }}>
                      {l.symbol && <span style={{ color: C.blue, marginRight: 6 }}>{l.symbol}</span>}
                      {l.side && <span style={{ color: l.side === "BUY" ? C.green : C.red, marginRight: 6 }}>{l.side}</span>}
                      {l.qty && <span style={{ marginRight: 6 }}>{l.qty}</span>}
                      {l.score !== undefined && <span style={{ color: C.dim, marginRight: 6 }}>Score:{l.score}</span>}
                      {l.confidence && <span style={{ color: C.dim, marginRight: 6 }}>AI:{l.confidence}%</span>}
                      {l.pnl && <span style={{ color: l.pnl.includes("-") ? C.red : C.green }}>{l.pnl}</span>}
                      {l.reason && <span style={{ color: C.dim }}>{l.reason}</span>}
                      {l.detail && <span style={{ color: C.dim }}>{l.detail}</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* ── 右サイドバー ── */}
        <div style={{ background: C.panel, overflowY: "auto", display: "flex", flexDirection: "column", gap: 0 }}>

          {/* APIキー */}
          <div style={{ padding: "14px 16px", borderBottom: `1px solid ${C.border}` }}>
            <Label>API設定</Label>
            {[
              ["OrcaRouter Key", "orca", "or-..."],
              ["MEXC API Key", "mexc", "mx-..."],
              ["MEXC Secret", "secret", "secret"],
            ].map(([label, field, ph]) => (
              <div key={field} style={{ marginBottom: 8 }}>
                <Label>{label}</Label>
                <input type="password" value={keys[field]} onChange={e => setKeys(k => ({ ...k, [field]: e.target.value }))} placeholder={ph}
                  style={{ width: "100%", background: C.muted, border: `1px solid ${C.border}`, borderRadius: 5, padding: "7px 10px", color: C.text, fontSize: 12, fontFamily: "inherit" }}
                />
              </div>
            ))}
            <button onClick={() => setKeySaved(true)} style={{
              width: "100%", padding: "7px", background: keySaved ? `${C.green}22` : C.accent,
              color: keySaved ? C.green : "#000", border: keySaved ? `1px solid ${C.green}` : "none",
              borderRadius: 5, fontWeight: 800, cursor: "pointer", fontSize: 11, fontFamily: "inherit",
            }}>{keySaved ? "✓ 保存済み" : "保存"}</button>
          </div>

          {/* ポジション */}
          <div style={{ padding: "14px 16px", borderBottom: `1px solid ${C.border}` }}>
            <Label>現在ポジション</Label>
            {position ? (
              <div style={{ background: C.card, border: `1px solid ${C.yellow}55`, borderRadius: 8, padding: "10px 12px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                  <span style={{ color: position.side === "BUY" ? C.green : C.red, fontWeight: 800 }}>{position.side}</span>
                  <span style={{ color: C.yellow, fontSize: 10 }}>{position.symbol}</span>
                </div>
                <div style={{ fontSize: 12 }}>エントリー: ${position.entry?.toLocaleString()}</div>
                <div style={{ fontSize: 11, color: C.dim, marginTop: 4 }}>数量: {position.qty}</div>
                {market[position.symbol] && (() => {
                  const cur = market[position.symbol].price;
                  const pnl = position.side === "BUY"
                    ? (cur - position.entry) / position.entry * 100
                    : (position.entry - cur) / position.entry * 100;
                  return (
                    <div style={{ marginTop: 6, fontSize: 12, fontWeight: 700, color: pnl >= 0 ? C.green : C.red }}>
                      PnL: {pnl >= 0 ? "+" : ""}{pnl.toFixed(2)}%
                    </div>
                  );
                })()}
                <button onClick={() => setPosition(null)} style={{
                  marginTop: 8, width: "100%", padding: "5px", background: C.red, color: "#000",
                  border: "none", borderRadius: 4, fontWeight: 800, cursor: "pointer", fontSize: 10, fontFamily: "inherit",
                }}>ポジションをクリア</button>
              </div>
            ) : (
              <div style={{ color: C.dim, fontSize: 11, padding: "8px 0" }}>ポジションなし</div>
            )}
          </div>

          {/* 全ペアスコア一覧 */}
          <div style={{ padding: "14px 16px", borderBottom: `1px solid ${C.border}` }}>
            <Label>スコア一覧</Label>
            {PAIRS.map(p => {
              const sc = scores[p];
              const d  = market[p];
              if (!sc || !d) return null;
              const color = sc.score > 40 ? C.green : sc.score < -40 ? C.red : C.yellow;
              return (
                <div key={p} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", borderBottom: `1px solid ${C.border}` }}>
                  <span style={{ fontSize: 10, flex: 1, color: C.text }}>{p.replace("USDT", "")}</span>
                  <div style={{ flex: 2 }}><ScoreGauge score={sc.score} /></div>
                  <span style={{ fontSize: 11, fontWeight: 800, color, minWidth: 30, textAlign: "right" }}>
                    {sc.score > 0 ? "+" : ""}{sc.score.toFixed(0)}
                  </span>
                </div>
              );
            })}
          </div>

          {/* 注意書き */}
          <div style={{ padding: "12px 16px", marginTop: "auto" }}>
            <div style={{ fontSize: 9, color: C.dim, lineHeight: 1.7 }}>
              ⚠ このツールは情報提供のみです。<br />
              自動売買の損益はご自身の責任です。<br />
              本番運用前に少額でテストしてください。
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
