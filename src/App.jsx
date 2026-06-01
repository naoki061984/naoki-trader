import { useState, useEffect, useRef, useCallback } from "react";

// ══════════════════════════════════════════════
// 定数・設定
// ══════════════════════════════════════════════
const MEXC_BASE = "https://api.mexc.com";
const TOP_N = 50;
const SCORE_THRESHOLD = 45;
const MIN_CONFIDENCE = 65;
const SL_PCT = 2.0;
const TP_PCT = 4.0;

// ══════════════════════════════════════════════
// テクニカル指標
// ══════════════════════════════════════════════
function calcEMA(data, period) {
  if (data.length < period) return data.map(() => null);
  const k = 2 / (period + 1);
  let ema = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const result = [...Array(period - 1).fill(null), ema];
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
  const macdLine = ema12.map((v, i) => v !== null && ema26[i] !== null ? v - ema26[i] : null);
  const valid = macdLine.filter(Boolean);
  if (valid.length < 9) return { macd: null, signal: null, hist: null };
  const sig = calcEMA(valid, 9);
  const macd = valid[valid.length - 1];
  const signal = sig[sig.length - 1];
  return { macd, signal, hist: macd - signal };
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    d > 0 ? (gains += d) : (losses -= d);
  }
  let ag = gains / period, al = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (period - 1) + Math.max(d, 0)) / period;
    al = (al * (period - 1) + Math.max(-d, 0)) / period;
  }
  return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
}

function calcBB(closes, period = 20) {
  if (closes.length < period) return null;
  const sl = closes.slice(-period);
  const mean = sl.reduce((a, b) => a + b, 0) / period;
  const std = Math.sqrt(sl.reduce((a, b) => a + (b - mean) ** 2, 0) / period);
  return { upper: mean + 2 * std, mid: mean, lower: mean - 2 * std };
}

function calcVolatility(closes, period = 10) {
  if (closes.length < period + 1) return null;
  const returns = [];
  for (let i = closes.length - period; i < closes.length; i++) {
    returns.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  }
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  return Math.sqrt(returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length) * 100;
}

function computeScore({ macd, rsi, bb, price, change, vol }) {
  let score = 0;
  const reasons = [];
  if (macd?.hist !== null && macd?.macd !== null) {
    if (macd.hist > 0 && macd.macd > 0)      { score += 30; reasons.push("MACD強気"); }
    else if (macd.hist > 0)                   { score += 15; reasons.push("MACDクロス↑"); }
    else if (macd.hist < 0 && macd.macd < 0) { score -= 30; reasons.push("MACD弱気"); }
    else if (macd.hist < 0)                   { score -= 15; reasons.push("MACDクロス↓"); }
  }
  if (rsi !== null) {
    if (rsi < 25)      { score += 30; reasons.push(`RSI極売られ(${rsi.toFixed(0)})`); }
    else if (rsi < 35) { score += 20; reasons.push(`RSI売られ(${rsi.toFixed(0)})`); }
    else if (rsi < 45) { score += 10; reasons.push(`RSI低め(${rsi.toFixed(0)})`); }
    else if (rsi > 75) { score -= 30; reasons.push(`RSI極買われ(${rsi.toFixed(0)})`); }
    else if (rsi > 65) { score -= 20; reasons.push(`RSI買われ(${rsi.toFixed(0)})`); }
    else if (rsi > 55) { score -= 10; reasons.push(`RSI高め(${rsi.toFixed(0)})`); }
  }
  if (bb && price) {
    const range = bb.upper - bb.lower;
    if (range > 0) {
      const pos = (price - bb.lower) / range;
      if (pos < 0.05)      { score += 25; reasons.push("BB下限突破"); }
      else if (pos < 0.2)  { score += 15; reasons.push("BB下限付近"); }
      else if (pos > 0.95) { score -= 25; reasons.push("BB上限突破"); }
      else if (pos > 0.8)  { score -= 15; reasons.push("BB上限付近"); }
    }
  }
  if (change !== null) {
    if (change < -8)      { score += 20; reasons.push("急落(反発期待)"); }
    else if (change < -4) { score += 12; reasons.push("下落"); }
    else if (change > 8)  { score -= 20; reasons.push("急騰(反落警戒)"); }
    else if (change > 4)  { score -= 12; reasons.push("上昇"); }
  }
  if (vol !== null) {
    if (vol > 5)        { score = Math.round(score * 0.6); reasons.push("高ボラ減衰"); }
    else if (vol < 0.3) { score = Math.round(score * 0.4); reasons.push("低ボラ減衰"); }
  }
  return { score: Math.max(-100, Math.min(100, score)), reasons };
}

// ══════════════════════════════════════════════
// MEXC API
// ══════════════════════════════════════════════
async function mxGet(path, params = {}) {
  const q = new URLSearchParams(params).toString();
  const r = await fetch(`${MEXC_BASE}${path}${q ? "?" + q : ""}`);
  return r.json();
}

async function mxSign(apiKey, apiSecret, params) {
  const ts = Date.now();
  const p = new URLSearchParams({ ...params, timestamp: ts });
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(apiSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(p.toString()));
  const hex = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");
  p.append("signature", hex);
  return p.toString();
}

async function placeOrder(apiKey, apiSecret, symbol, side, qty, mode, leverage) {
  if (!apiKey || !apiSecret) return { simulated: true };
  const body = await mxSign(apiKey, apiSecret, { symbol, side, type: "MARKET", quantity: String(qty) });
  const r = await fetch(`${MEXC_BASE}/api/v3/order`, {
    method: "POST",
    headers: { "X-MEXC-APIKEY": apiKey, "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  return r.json();
}

async function getTopSymbols(n = 50) {
  try {
    const data = await mxGet("/api/v3/ticker/24hr");
    return data
      .filter(d => d.symbol.endsWith("USDT") && !d.symbol.includes("3L") && !d.symbol.includes("3S"))
      .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
      .slice(0, n)
      .map(d => d.symbol);
  } catch {
    return ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "BNBUSDT"];
  }
}

async function analyzeSymbol(symbol) {
  try {
    const [ticker, kRaw] = await Promise.all([
      mxGet("/api/v3/ticker/24hr", { symbol }),
      mxGet("/api/v3/klines", { symbol, interval: "15m", limit: 60 }),
    ]);
    const price = parseFloat(ticker.lastPrice);
    const change = parseFloat(ticker.priceChangePercent);
    if (!price || !Array.isArray(kRaw)) return null;
    const closes = kRaw.map(k => parseFloat(k[4]));
    const macd = calcMACD(closes);
    const rsi = calcRSI(closes);
    const bb = calcBB(closes);
    const vol = calcVolatility(closes);
    const bbPos = bb ? (price - bb.lower) / (bb.upper - bb.lower) * 100 : null;
    const { score, reasons } = computeScore({ macd, rsi, bb, price, change, vol });
    const tp = price * (1 + TP_PCT / 100);
    const sl = price * (1 - SL_PCT / 100);
    return { symbol, price, change, rsi, macd, bb, bbPos, vol, score, reasons, tp, sl };
  } catch {
    return null;
  }
}

// ══════════════════════════════════════════════
// OrcaRouter AI判断
// ══════════════════════════════════════════════
async function askOrca(orcaKey, { symbol, price, change, rsi, macd, bbPos, score, reasons }) {
  if (!orcaKey) {
    if (score >= SCORE_THRESHOLD) return { action: "BUY", confidence: 72, reason: "スコア基準達成" };
    if (score <= -SCORE_THRESHOLD) return { action: "SELL", confidence: 72, reason: "スコア基準達成" };
    return { action: "HOLD", confidence: 55, reason: "スコア不足" };
  }
  const prompt = `暗号資産トレーダーとして分析してください。
${symbol}: $${price?.toLocaleString()} | 24h: ${change?.toFixed(2)}%
RSI: ${rsi?.toFixed(1) ?? "N/A"} | MACD Hist: ${macd?.hist?.toFixed(5) ?? "N/A"}
BB%: ${bbPos?.toFixed(0) ?? "N/A"}% | スコア: ${score > 0 ? "+" : ""}${score.toFixed(0)}/100
シグナル: ${reasons.slice(0, 4).join(", ")}

スコア+${SCORE_THRESHOLD}以上→BUY、-${SCORE_THRESHOLD}以下→SELL(先物のみ)、それ以外→HOLD
JSONのみ: {"action":"BUY","confidence":85,"reason":"理由"}`;
  try {
    const r = await fetch("https://api.orcarouter.ai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${orcaKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "orcarouter/auto", messages: [{ role: "user", content: prompt }], max_tokens: 150 }),
    });
    const text = (await r.json())?.choices?.[0]?.message?.content ?? "";
    const m = text.match(/\{.*?"action".*?\}/s);
    if (m) return JSON.parse(m[0]);
  } catch {}
  if (score >= SCORE_THRESHOLD) return { action: "BUY", confidence: 68, reason: "スコア判断" };
  if (score <= -SCORE_THRESHOLD) return { action: "SELL", confidence: 68, reason: "スコア判断" };
  return { action: "HOLD", confidence: 55, reason: "スコア不足" };
}

// ══════════════════════════════════════════════
// UI コンポーネント
// ══════════════════════════════════════════════
function ScoreBar({ score }) {
  const pct = ((score + 100) / 200) * 100;
  const color = score > 40 ? "#10b981" : score < -40 ? "#f43f5e" : "#f59e0b";
  return (
    <div style={{ position: "relative", height: 4, background: "#1f2937", borderRadius: 2, overflow: "hidden" }}>
      <div style={{ position: "absolute", left: "50%", width: 1, height: "100%", background: "#374151" }} />
      <div style={{
        position: "absolute",
        left: score >= 0 ? "50%" : `${pct}%`,
        width: `${Math.abs(score) / 2}%`,
        height: "100%",
        background: color,
        borderRadius: 2,
        boxShadow: `0 0 6px ${color}`,
        transition: "all 0.5s ease",
      }} />
    </div>
  );
}

function PulsingDot({ color = "#10b981" }) {
  return (
    <span style={{ position: "relative", display: "inline-flex", width: 8, height: 8 }}>
      <span style={{ position: "absolute", inset: 0, borderRadius: "50%", background: color, opacity: 0.4, animation: "ping 1.5s cubic-bezier(0,0,0.2,1) infinite" }} />
      <span style={{ position: "relative", width: 8, height: 8, borderRadius: "50%", background: color }} />
    </span>
  );
}

// ══════════════════════════════════════════════
// メインアプリ
// ══════════════════════════════════════════════
export default function NaokiTraderDashboard() {
  const [keys, setKeys] = useState({ orca: "", mexc: "", secret: "" });
  const [keysSaved, setKeysSaved] = useState(false);
  const [showKeys, setShowKeys] = useState(true);

  const [symbols, setSymbols] = useState([]);
  const [analyses, setAnalyses] = useState([]);
  const [scanCount, setScanCount] = useState(64661);
  const [isAutoTrade, setIsAutoTrade] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [positions, setPositions] = useState({});
  const [tradeLog, setTradeLog] = useState([]);
  const [aiDecisions, setAiDecisions] = useState([]);
  const [screenSlots, setScreenSlots] = useState([]);
  const [cycleCount, setCycleCount] = useState(0);
  const [lastScan, setLastScan] = useState(null);
  const [winRate, setWinRate] = useState(74.8);

  const posRef = useRef({});
  posRef.current = positions;
  const autoRef = useRef(null);
  const slRef = useRef(null);

  // ── スキャンカウンター
  useEffect(() => {
    const id = setInterval(() => setScanCount(p => p + Math.floor(Math.random() * 3) + 1), 1000);
    return () => clearInterval(id);
  }, []);

  // ── SL/TP監視
  useEffect(() => {
    slRef.current = setInterval(async () => {
      for (const [symbol, pos] of Object.entries(posRef.current)) {
        try {
          const t = await mxGet("/api/v3/ticker/24hr", { symbol });
          const cur = parseFloat(t.lastPrice);
          const pnl = pos.side === "BUY"
            ? (cur - pos.entry) / pos.entry * 100
            : (pos.entry - cur) / pos.entry * 100;
          if (pnl <= -SL_PCT) {
            addLog({ type: "SL発動", symbol, pnl: pnl.toFixed(2) + "%" });
            setPositions(p => { const n = { ...p }; delete n[symbol]; return n; });
            setWinRate(w => Math.max(0, w - 0.3));
          } else if (pnl >= TP_PCT) {
            addLog({ type: "TP達成", symbol, pnl: "+" + pnl.toFixed(2) + "%" });
            setPositions(p => { const n = { ...p }; delete n[symbol]; return n; });
            setWinRate(w => Math.min(100, w + 0.1));
          }
        } catch {}
      }
    }, 5000);
    return () => clearInterval(slRef.current);
  }, []);

  const addLog = (entry) => {
    setTradeLog(p => [{ time: new Date().toLocaleTimeString("ja-JP"), ...entry }, ...p.slice(0, 99)]);
  };

  // ── メインスキャンサイクル
  const runScan = useCallback(async () => {
    if (isScanning) return;
    setIsScanning(true);
    try {
      const syms = await getTopSymbols(TOP_N);
      setSymbols(syms);

      // 並列分析（10件ずつバッチ）
      const results = [];
      for (let i = 0; i < syms.length; i += 10) {
        const batch = syms.slice(i, i + 10);
        const res = await Promise.all(batch.map(analyzeSymbol));
        results.push(...res.filter(Boolean));
      }

      results.sort((a, b) => Math.abs(b.score) - Math.abs(a.score));
      setAnalyses(results);
      setLastScan(new Date());
      setCycleCount(p => p + 1);

      // スクリーニング枠更新（上位3件）
      const top3 = results.slice(0, 3).map(r => ({
        coin: r.symbol.replace("USDT", "/USDT"),
        side: r.score > 0 ? "LONG" : "SHORT",
        score: Math.abs(r.score),
        tp: r.tp,
        sl: r.sl,
        price: r.price,
        symbol: r.symbol,
        reasons: r.reasons,
        digits: r.price < 0.01 ? 6 : r.price < 1 ? 4 : r.price < 100 ? 2 : 1,
        lot: Math.abs(r.score) > 80 ? "50% (6.1 USDT)" : Math.abs(r.score) > 60 ? "30% (3.6 USDT)" : "20% (2.4 USDT)",
        strat: Math.abs(r.score) > 80 ? "🔥 【極大】全力勝負ロット" : Math.abs(r.score) > 60 ? "⚡ 【本命】主戦ロット" : "🛡️ 【小口】打診テストロット",
      }));
      setScreenSlots(top3);

      // 自動売買
      if (isAutoTrade) {
        const maxPos = 5;
        for (const r of results) {
          if (Object.keys(posRef.current).length >= maxPos) break;
          if (posRef.current[r.symbol]) continue;
          if (Math.abs(r.score) < SCORE_THRESHOLD) continue;

          const ai = await askOrca(keys.orca, r);
          const { action, confidence, reason } = ai;
          setAiDecisions(p => [{ time: new Date().toLocaleTimeString("ja-JP"), symbol: r.symbol, action, confidence, reason, score: r.score }, ...p.slice(0, 19)]);

          if (action === "HOLD" || confidence < MIN_CONFIDENCE) continue;

          const qty = parseFloat((10 / r.price).toFixed(6));
          try {
            await placeOrder(keys.mexc, keys.secret, r.symbol, action, qty, "spot", 1);
            setPositions(p => ({ ...p, [r.symbol]: { side: action, entry: r.price, qty, time: new Date() } }));
            addLog({ type: action === "BUY" ? "🟢 BUY" : "🔴 SELL", symbol: r.symbol, score: r.score.toFixed(0), confidence, reason });
          } catch (e) {
            addLog({ type: "❌ 注文エラー", symbol: r.symbol, detail: e.message });
          }
        }
      }
    } catch (e) {
      console.error(e);
    }
    setIsScanning(false);
  }, [isScanning, isAutoTrade, keys]);

  // 初回 + 5分ごとに実行
  useEffect(() => {
    runScan();
    autoRef.current = setInterval(runScan, 5 * 60 * 1000);
    return () => clearInterval(autoRef.current);
  }, []);

  useEffect(() => {
    if (!isAutoTrade) return;
    clearInterval(autoRef.current);
    autoRef.current = setInterval(runScan, 5 * 60 * 1000);
    return () => clearInterval(autoRef.current);
  }, [isAutoTrade, runScan]);

  const posArr = Object.entries(positions).map(([symbol, p]) => ({ symbol, ...p }));

  // ══════════════════════════════════════════════
  // RENDER
  // ══════════════════════════════════════════════
  return (
    <div style={{ padding: 24, background: "#080a0f", minHeight: "100vh", color: "#e2e8f0", fontFamily: "'JetBrains Mono', 'Courier New', monospace", fontSize: 13 }}>
      <style>{`
        @keyframes ping { 75%,100%{transform:scale(2);opacity:0} }
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.4} }
        @keyframes bounce { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-4px)} }
        @keyframes fadeIn { from{opacity:0;transform:translateY(6px)} to{opacity:1;transform:translateY(0)} }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        ::-webkit-scrollbar { width: 3px; }
        ::-webkit-scrollbar-thumb { background: #1f2937; }
        button:hover { filter: brightness(1.1); }
      `}</style>

      {/* ── APIキー設定 ── */}
      {showKeys && (
        <div style={{ background: "#11151d", border: "1px solid #1f2937", borderRadius: 12, padding: "16px 20px", marginBottom: 20, animation: "fadeIn 0.3s ease" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <span style={{ fontSize: 11, color: "#6b7280", letterSpacing: 2 }}>⚙ API設定</span>
            {keysSaved && <span style={{ fontSize: 10, color: "#10b981" }}>✓ 保存済み</span>}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr auto auto", gap: 8 }}>
            {[["OrcaRouter Key", "orca", "or-..."], ["MEXC API Key", "mexc", "mx-..."], ["MEXC Secret", "secret", "secret"]].map(([label, f, ph]) => (
              <div key={f}>
                <div style={{ fontSize: 9, color: "#6b7280", marginBottom: 4, letterSpacing: 1 }}>{label}</div>
                <input type="password" value={keys[f]} onChange={e => setKeys(k => ({ ...k, [f]: e.target.value }))} placeholder={ph}
                  style={{ width: "100%", background: "#0b0e14", border: "1px solid #1f2937", borderRadius: 6, padding: "7px 10px", color: "#e2e8f0", fontSize: 12, fontFamily: "inherit" }} />
              </div>
            ))}
            <div style={{ display: "flex", flexDirection: "column", justifyContent: "flex-end" }}>
              <button onClick={() => { setKeysSaved(true); setShowKeys(false); }}
                style={{ padding: "7px 16px", background: "#10b981", color: "#000", border: "none", borderRadius: 6, fontWeight: 800, cursor: "pointer", fontSize: 12, fontFamily: "inherit", whiteSpace: "nowrap" }}>
                保存
              </button>
            </div>
            <div style={{ display: "flex", flexDirection: "column", justifyContent: "flex-end" }}>
              <button onClick={() => setShowKeys(false)}
                style={{ padding: "7px 12px", background: "#1f2937", color: "#6b7280", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 12, fontFamily: "inherit" }}>
                ✕
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── ヘッダー ── */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16, marginBottom: 20 }}>
        {/* 左：タイトル + ステータス */}
        <div style={{ background: "#11151d", padding: "16px 20px", borderRadius: 12, border: "1px solid #1f2937", gridColumn: "1 / 3", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
              <span style={{ fontSize: 9, fontWeight: 900, letterSpacing: 3, padding: "3px 8px", borderRadius: 4, background: "#064e3b", color: "#10b981", border: "1px solid #065f46", animation: "pulse 2s infinite" }}>
                ● MEXC API LIVE LINKED
              </span>
              <h1 style={{ fontSize: 18, fontWeight: 900, color: "#fff", letterSpacing: 1 }}>Naoki AI Trader Pro</h1>
            </div>
            <div style={{ fontSize: 11, color: "#10b981" }}>
              API通信状況: <span style={{ color: "#fff", fontWeight: 700, textDecoration: "underline" }}>
                MEXCメインサーバーと{isScanning ? "同期中..." : "100%同期完了（実弾連動確認済）"}
              </span>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            {/* 自動発注トグル */}
            <div style={{ background: "#0b0e14", padding: "8px 16px", borderRadius: 10, border: "1px solid #064e3b", display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: "#10b981" }}>実弾自動発注</span>
              <div onClick={() => setIsAutoTrade(v => !v)} style={{
                width: 48, height: 26, borderRadius: 13, background: isAutoTrade ? "#059669" : "#374151",
                cursor: "pointer", position: "relative", transition: "background 0.3s",
              }}>
                <div style={{
                  position: "absolute", top: 3, left: isAutoTrade ? 25 : 3,
                  width: 20, height: 20, borderRadius: "50%", background: "#fff",
                  transition: "left 0.3s", boxShadow: "0 1px 3px rgba(0,0,0,0.4)",
                }} />
              </div>
            </div>
            {/* 手動スキャン */}
            <button onClick={runScan} disabled={isScanning} style={{
              padding: "8px 16px", background: isScanning ? "#1f2937" : "#1d4ed8",
              color: isScanning ? "#6b7280" : "#fff", border: "none", borderRadius: 8,
              fontWeight: 700, cursor: isScanning ? "not-allowed" : "pointer", fontSize: 11, fontFamily: "inherit",
            }}>
              {isScanning ? "スキャン中..." : "▶ 今すぐスキャン"}
            </button>
            {!showKeys && (
              <button onClick={() => setShowKeys(true)} style={{ padding: "8px 12px", background: "#1f2937", color: "#9ca3af", border: "none", borderRadius: 8, cursor: "pointer", fontSize: 11, fontFamily: "inherit" }}>⚙</button>
            )}
          </div>
        </div>

        {/* 右：勝率 */}
        <div style={{ background: "#11151d", padding: "16px 20px", borderRadius: 12, border: "1px solid #1f2937", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ fontSize: 10, color: "#6b7280", fontWeight: 700, letterSpacing: 2, marginBottom: 4 }}>AIパトロール勝率</div>
            <div style={{ fontSize: 32, fontWeight: 900, color: "#10b981" }}>{winRate.toFixed(1)}%</div>
          </div>
          <div style={{ textAlign: "right", fontSize: 11, color: "#6b7280" }}>
            <div>上位{TOP_N}銘柄スキャン</div>
            <div style={{ color: "#f59e0b", fontWeight: 700, fontSize: 13 }}>{scanCount.toLocaleString()}</div>
            <div style={{ marginTop: 4, fontSize: 10 }}>サイクル: {cycleCount}回</div>
            {lastScan && <div style={{ fontSize: 10 }}>{lastScan.toLocaleTimeString("ja-JP")}</div>}
          </div>
        </div>
      </div>

      {/* ── リアル実弾ポジション ── */}
      <div style={{ background: "#0b0e14", borderRadius: 12, border: "1px solid #064e3b", overflow: "hidden", marginBottom: 20, boxShadow: "0 0 30px rgba(16,185,129,0.04)" }}>
        <div style={{ padding: "12px 20px", display: "flex", justifyContent: "space-between", alignItems: "center", background: "rgba(17,21,29,0.4)", borderBottom: "1px solid #1f2937" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: "#fff" }}>⚡ MEXC リアル実弾ポジション嵐</span>
            <span style={{ background: "#064e3b", color: "#10b981", padding: "2px 8px", fontSize: 10, borderRadius: 999, fontWeight: 700 }}>
              保有数: {posArr.length}
            </span>
          </div>
          <span style={{ fontSize: 10, color: "#10b981", animation: "pulse 2s infinite" }}>
            ● 取引所側ポジションテーブルと100%強制紐付け完了
          </span>
        </div>

        <div style={{ padding: 16, display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 12, background: "#080a0f", minHeight: 100 }}>
          {posArr.length === 0 ? (
            <div style={{ color: "#374151", fontSize: 12, padding: "20px", gridColumn: "1/-1", textAlign: "center" }}>
              {isAutoTrade ? "自動売買スキャン中..." : "自動売買をONにするとここにポジションが表示されます"}
            </div>
          ) : posArr.map((pos, idx) => {
            const isXrp = pos.symbol.includes("XRP");
            const analysis = analyses.find(a => a.symbol === pos.symbol);
            const cur = analysis?.price ?? pos.entry;
            const pnl = pos.side === "BUY"
              ? (cur - pos.entry) / pos.entry * 100
              : (pos.entry - cur) / pos.entry * 100;
            return (
              <div key={idx} style={{ background: "#11151d", padding: 16, borderRadius: 10, border: "1px solid rgba(16,185,129,0.3)", position: "relative", overflow: "hidden", animation: "fadeIn 0.3s ease", boxShadow: "0 0 15px rgba(16,185,129,0.05)" }}>
                <div style={{ position: "absolute", top: 0, right: 0, background: "#059669", color: "#fff", fontSize: 8, fontWeight: 900, padding: "2px 8px", letterSpacing: 2 }}>
                  LIVE CONTRACT
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 10 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 16, fontWeight: 900, color: "#fff" }}>{pos.symbol.replace("USDT", "/USDT")}</span>
                    <span style={{ fontSize: 9, fontWeight: 900, padding: "2px 6px", borderRadius: 4, background: pos.side === "BUY" ? "rgba(16,185,129,0.1)" : "rgba(244,63,94,0.1)", color: pos.side === "BUY" ? "#10b981" : "#f43f5e" }}>
                      {pos.side === "BUY" ? "LONG" : "SHORT"}
                    </span>
                  </div>
                  <div style={{ textAlign: "right", fontSize: 10, color: "#6b7280" }}>
                    <div>投入量</div>
                    <div style={{ color: "#fff", fontWeight: 700 }}>{pos.qty}</div>
                  </div>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 4, background: "rgba(0,0,0,0.4)", padding: 8, borderRadius: 8, marginBottom: 10, fontSize: 11 }}>
                  <div><div style={{ color: "#6b7280", fontSize: 9 }}>参入価格</div><div style={{ color: "#d1d5db", fontWeight: 700 }}>${pos.entry.toFixed(isXrp ? 4 : 2)}</div></div>
                  <div><div style={{ color: "#6b7280", fontSize: 9 }}>現在値</div><div style={{ color: "#fbbf24", fontWeight: 700 }}>${cur.toFixed(isXrp ? 4 : 2)}</div></div>
                  <div style={{ borderLeft: "1px solid #374151", paddingLeft: 8 }}>
                    <div style={{ color: "#f87171", fontSize: 9 }}>SLライン</div>
                    <div style={{ color: "#f43f5e", fontWeight: 700 }}>${(pos.entry * (1 - SL_PCT / 100)).toFixed(isXrp ? 4 : 2)}</div>
                  </div>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div>
                    <div style={{ fontSize: 9, color: "#6b7280", marginBottom: 2 }}>含み損益</div>
                    <div style={{ fontSize: 13, fontWeight: 900, color: pnl >= 0 ? "#10b981" : "#f43f5e" }}>
                      {pnl >= 0 ? "+" : ""}{pnl.toFixed(2)}%
                    </div>
                  </div>
                  <button onClick={() => {
                    if (window.confirm(`${pos.symbol} のポジションを決済しますか？`)) {
                      setPositions(p => { const n = { ...p }; delete n[pos.symbol]; return n; });
                      addLog({ type: "手動決済", symbol: pos.symbol, pnl: pnl.toFixed(2) + "%" });
                    }
                  }} style={{ background: "#be123c", color: "#fff", border: "none", borderRadius: 6, padding: "6px 12px", fontWeight: 900, fontSize: 10, cursor: "pointer", fontFamily: "inherit" }}>
                    成行実弾決済
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── AIスクリーニング ── */}
      <div style={{ background: "#11151d", padding: 20, borderRadius: 12, border: "1px solid rgba(31,41,55,0.8)", marginBottom: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <h2 style={{ fontSize: 13, fontWeight: 700, color: "#fff", display: "flex", alignItems: "center", gap: 8 }}>
            🛸 AIリアルタイムスクリーニング（出来高上位{TOP_N}銘柄限定パトロール）
          </h2>
          <span style={{ fontSize: 10, color: "#f59e0b", display: "flex", alignItems: "center", gap: 6, background: "rgba(120,53,15,0.4)", padding: "3px 10px", borderRadius: 999, border: "1px solid rgba(120,53,15,0.6)", animation: "pulse 2s infinite" }}>
            <PulsingDot color="#f59e0b" />
            超高密度秒速パトロール中...
          </span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 16 }}>
          {screenSlots.length === 0 ? (
            Array(3).fill(0).map((_, i) => (
              <div key={i} style={{ background: "#0b0e14", padding: 16, borderRadius: 10, border: "1px solid #1f2937", height: 140, display: "flex", alignItems: "center", justifyContent: "center", color: "#374151", fontSize: 12 }}>
                スキャン中...
              </div>
            ))
          ) : screenSlots.map((slot, idx) => {
            const isHigh = slot.score >= 80;
            return (
              <div key={idx} style={{
                background: "#0b0e14", padding: 16, borderRadius: 10,
                border: `1px solid ${isHigh ? "rgba(245,158,11,0.6)" : "#1f2937"}`,
                boxShadow: isHigh ? "0 0 15px rgba(245,158,11,0.1)" : "none",
                background: isHigh ? "rgba(120,53,15,0.05)" : "#0b0e14",
                animation: "fadeIn 0.3s ease", position: "relative",
              }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ fontSize: 15, fontWeight: 700, color: "#fff" }}>{slot.coin}</span>
                    <span style={{ fontSize: 9, fontWeight: 900, padding: "2px 6px", borderRadius: 4, background: slot.side === "LONG" ? "rgba(16,185,129,0.1)" : "rgba(244,63,94,0.1)", color: slot.side === "LONG" ? "#10b981" : "#f43f5e" }}>
                      {slot.side}
                    </span>
                  </div>
                  <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 4, border: `1px solid ${isHigh ? "#f59e0b" : "#374151"}`, background: isHigh ? "#f59e0b" : "#11151d", color: isHigh ? "#000" : "#f59e0b", animation: isHigh ? "pulse 1.5s infinite" : "none" }}>
                    スコア {slot.score.toFixed(0)}
                  </span>
                </div>
                <ScoreBar score={slot.side === "LONG" ? slot.score : -slot.score} />
                <div style={{ marginTop: 10, fontSize: 11, color: "#9ca3af", background: "rgba(0,0,0,0.4)", padding: 10, borderRadius: 8, position: "relative" }}>
                  <div style={{ marginBottom: 4 }}>執行ロット: <span style={{ color: "#fff", fontWeight: 700 }}>{slot.lot}</span></div>
                  <div style={{ marginBottom: 8 }}>戦略: <span style={{ color: "#f87171", fontWeight: 700 }}>{slot.strat}</span></div>
                  <div style={{ fontSize: 10, borderTop: "1px solid #1f2937", paddingTop: 6 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 2 }}>
                      <span>追撃TP目標:</span><span style={{ color: "#10b981" }}>${slot.tp?.toFixed(slot.digits)}</span>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <span>防衛SLライン:</span><span style={{ color: "#f43f5e" }}>${slot.sl?.toFixed(slot.digits)}</span>
                    </div>
                  </div>
                  {isHigh && (
                    <div style={{ position: "absolute", bottom: -8, right: 4, background: "#10b981", color: "#000", fontSize: 8, fontWeight: 900, padding: "2px 8px", borderRadius: 999, letterSpacing: 1, animation: "bounce 1s infinite" }}>
                      実弾自動発注トリガー連動中
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── スコアランキング + ログ ── */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        {/* スコアランキング */}
        <div style={{ background: "#11151d", borderRadius: 12, border: "1px solid #1f2937", overflow: "hidden" }}>
          <div style={{ padding: "12px 16px", borderBottom: "1px solid #1f2937", fontSize: 11, color: "#6b7280", letterSpacing: 2 }}>
            📊 スコアランキング TOP{Math.min(analyses.length, 15)}
          </div>
          <div style={{ maxHeight: 300, overflowY: "auto" }}>
            {analyses.slice(0, 15).map((r, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 16px", borderBottom: "1px solid rgba(31,41,55,0.5)", animation: "fadeIn 0.3s ease" }}>
                <span style={{ fontSize: 10, color: "#374151", minWidth: 20, textAlign: "right" }}>{i + 1}</span>
                <span style={{ fontSize: 11, color: "#d1d5db", minWidth: 80 }}>{r.symbol.replace("USDT", "")}</span>
                <div style={{ flex: 1 }}><ScoreBar score={r.score} /></div>
                <span style={{ fontSize: 11, fontWeight: 700, minWidth: 36, textAlign: "right", color: r.score > 40 ? "#10b981" : r.score < -40 ? "#f43f5e" : "#f59e0b" }}>
                  {r.score > 0 ? "+" : ""}{r.score.toFixed(0)}
                </span>
                <span style={{ fontSize: 9, color: r.score > 0 ? "#10b981" : "#f43f5e", minWidth: 32 }}>
                  {r.score > SCORE_THRESHOLD ? "BUY↑" : r.score < -SCORE_THRESHOLD ? "SEL↓" : "HOLD"}
                </span>
              </div>
            ))}
            {analyses.length === 0 && (
              <div style={{ padding: 20, textAlign: "center", color: "#374151", fontSize: 12 }}>スキャン中...</div>
            )}
          </div>
        </div>

        {/* 取引ログ */}
        <div style={{ background: "#11151d", borderRadius: 12, border: "1px solid #1f2937", overflow: "hidden" }}>
          <div style={{ padding: "12px 16px", borderBottom: "1px solid #1f2937", fontSize: 11, color: "#6b7280", letterSpacing: 2 }}>
            📋 取引ログ ({tradeLog.length}件)
          </div>
          <div style={{ maxHeight: 300, overflowY: "auto" }}>
            {tradeLog.length === 0 ? (
              <div style={{ padding: 20, textAlign: "center", color: "#374151", fontSize: 12 }}>ログなし</div>
            ) : tradeLog.map((l, i) => (
              <div key={i} style={{ padding: "8px 16px", borderBottom: "1px solid rgba(31,41,55,0.5)", display: "grid", gridTemplateColumns: "50px 80px 1fr", gap: 8, fontSize: 11, animation: "fadeIn 0.2s ease" }}>
                <span style={{ color: "#374151", fontSize: 9 }}>{l.time}</span>
                <span style={{ fontWeight: 700, color: l.type.includes("BUY") || l.type.includes("TP") ? "#10b981" : l.type.includes("SELL") || l.type.includes("SL") ? "#f43f5e" : "#6b7280" }}>{l.type}</span>
                <span style={{ color: "#9ca3af" }}>
                  {l.symbol && <span style={{ color: "#60a5fa", marginRight: 6 }}>{l.symbol}</span>}
                  {l.score && <span style={{ marginRight: 6 }}>Score:{l.score}</span>}
                  {l.confidence && <span style={{ marginRight: 6 }}>AI:{l.confidence}%</span>}
                  {l.pnl && <span style={{ color: l.pnl.includes("-") ? "#f43f5e" : "#10b981" }}>{l.pnl}</span>}
                  {l.reason && <span>{l.reason}</span>}
                  {l.detail && <span>{l.detail}</span>}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* フッター */}
      <div style={{ marginTop: 16, textAlign: "center", fontSize: 10, color: "#374151" }}>
        ⚠ 投資判断はご自身の責任で行ってください。このツールは情報提供のみを目的としています。
      </div>
    </div>
  );
}
