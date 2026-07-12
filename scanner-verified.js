// ============================================================
//  CEX-DEX Scanner (verified list) — no symbol collisions
//
//  Matches by CONTRACT ADDRESS, not ticker, so you never
//  compare two unrelated tokens that share a symbol.
//
//  Each entry: verified ticker + verified contract address.
//  The scanner pulls the CEX price by ticker and the DEX price
//  by the exact contract, so both refer to the SAME asset.
//
//  ── HOW TO ADD MORE TOKENS ──
//  Add an entry to the WATCHLIST array below:
//    { symbol: "TICKER", contract: "0x...", chain: "ethereum" }
//  - symbol   = the ticker as listed on the CEX (e.g. "EL")
//  - contract = the token's contract address (lowercase)
//  - chain    = ethereum | bsc | base | arbitrum | polygon
//  Find the contract on DexScreener (Info tab) or Etherscan.
//  Verify the symbol matches the CEX listing before adding.
// ============================================================

const TELEGRAM_TOKEN   = process.env.TELEGRAM_TOKEN   || "YOUR_BOT_TOKEN";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "1501079802";

const MIN_GAP_PCT       = 5;
const SCAN_INTERVAL_MS  = 60000; // 1 minute (small list, can scan often)
const MIN_LIQUIDITY_USD = 20000; // ignore illiquid pools (BDX-style traps)
const ALERT_COOLDOWN_MS = 30 * 60 * 1000;

// ── YOUR VERIFIED WATCHLIST ──────────────────────────────────
// Tokens we confirmed contracts for this week. Add more below.
const WATCHLIST = [
  { symbol: "EL",   contract: "0x2781246fe707bb15cee3e5ea354e2154a2877b16", chain: "ethereum" },
  { symbol: "BTR",  contract: "0x6c76de483f1752ac8473e2b4983a873991e70da7", chain: "ethereum" },
  { symbol: "HPP",  contract: "0xe33fa57582a02888b0542387a8686edd43d16256", chain: "ethereum" },
  { symbol: "SYND", contract: "0x1bab804803159ad84b8854581aa53ac72455614e", chain: "ethereum" },
  { symbol: "VTHO", contract: "0x0000000000b3f879cb30fe243b4dfee438691c04", chain: "ethereum" },
  // Add more here — one line each:
  // { symbol: "XXX", contract: "0x...", chain: "ethereum" },
];

const recentAlerts = new Map();

async function sendTelegram(text) {
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID, text,
        parse_mode: "Markdown", disable_web_page_preview: true,
      }),
    });
  } catch (e) { console.error("Telegram:", e.message); }
}

// CEX price by ticker — tries several exchanges, first hit wins
async function getCexPrice(symbol) {
  const sources = [
    { name: "Binance", url: `https://api.binance.com/api/v3/ticker/price?symbol=${symbol}USDT`, parse: j => parseFloat(j.price) },
    { name: "KuCoin",  url: `https://api.kucoin.com/api/v1/market/orderbook/level1?symbol=${symbol}-USDT`, parse: j => parseFloat(j?.data?.price) },
    { name: "Gate",    url: `https://api.gateio.ws/api/v4/spot/tickers?currency_pair=${symbol}_USDT`, parse: j => Array.isArray(j)&&j[0]?parseFloat(j[0].last):null },
    { name: "MEXC",    url: `https://api.mexc.com/api/v3/ticker/price?symbol=${symbol}USDT`, parse: j => parseFloat(j.price) },
  ];
  for (const s of sources) {
    try {
      const res = await fetch(s.url);
      if (!res.ok) continue;
      const j = await res.json();
      const p = s.parse(j);
      if (p && !isNaN(p) && p > 0) return { price: p, source: s.name };
    } catch (_) {}
  }
  return null;
}

// DEX price by EXACT contract address — this is the collision fix
async function getDexPrice(contract) {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${contract}`);
    if (!res.ok) return null;
    const j = await res.json();
    const pairs = (j.pairs || []).filter(p => p.liquidity?.usd > MIN_LIQUIDITY_USD);
    if (pairs.length === 0) return null;
    const best = pairs.sort((a,b)=>(b.liquidity?.usd||0)-(a.liquidity?.usd||0))[0];
    return { price: parseFloat(best.priceUsd), url: best.url, liquidity: best.liquidity.usd, chain: best.chainId };
  } catch (_) { return null; }
}

async function scanCycle() {
  const t = new Date().toISOString();
  let flagged = 0;

  for (const token of WATCHLIST) {
    const last = recentAlerts.get(token.contract);
    if (last && Date.now() - last < ALERT_COOLDOWN_MS) continue;

    const [cex, dex] = await Promise.all([
      getCexPrice(token.symbol),
      getDexPrice(token.contract),
    ]);

    if (cex && dex && dex.price > 0) {
      const gapPct = ((dex.price - cex.price) / cex.price) * 100;
      if (Math.abs(gapPct) >= MIN_GAP_PCT) {
        flagged++;
        recentAlerts.set(token.contract, Date.now());
        const higher = gapPct > 0 ? "DEX" : "CEX";
        await sendTelegram([
          `🎯 *CEX-DEX gap — ${token.symbol}*`,
          `${cex.source} (CEX): $${cex.price.toPrecision(6)}`,
          `DEX (${dex.chain}): $${dex.price.toPrecision(6)}`,
          `Gap: ${gapPct>0?"+":""}${gapPct.toFixed(1)}% (${higher} higher)`,
          `DEX liquidity: $${Math.round(dex.liquidity).toLocaleString()}`,
          ``,
          `[DexScreener](${dex.url})`,
        ].join("\n"));
        console.log(`  FLAG ${token.symbol}: ${gapPct.toFixed(1)}%`);
      }
    }
    await new Promise(r => setTimeout(r, 300));
  }

  console.log(`[${t}] cycle done — ${WATCHLIST.length} tokens, ${flagged} flagged`);
}

async function main() {
  console.log(`CEX-DEX verified scanner started — ${WATCHLIST.length} tokens, ${MIN_GAP_PCT}% threshold`);
  await scanCycle();
  setInterval(scanCycle, SCAN_INTERVAL_MS);
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
