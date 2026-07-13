// ============================================================
//  CEX-DEX + CEX-CEX Scanner (verified list, chain-matched)
//
//  FIXES the wrong-price problem two ways:
//   1. DEX pool must be on the token's KNOWN chain AND its
//      baseToken address must equal the contract (kills the
//      same-address-different-chain collisions)
//   2. Sanity filter: gaps beyond MAX_SANE_GAP_PCT are almost
//      always two different tokens, not a real gap -> skipped
//
//  Paste your generated WATCHLIST below.
// ============================================================

const TELEGRAM_TOKEN   = process.env.TELEGRAM_TOKEN   || "YOUR_BOT_TOKEN";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "1501079802";

const MIN_DEX_GAP_PCT   = 1;
const MIN_CEX_GAP_PCT   = 0.5;
const MAX_SANE_GAP_PCT  = 40;    // gaps bigger than this = almost certainly wrong-token; skip
const SCAN_INTERVAL_MS  = 60000;
const MIN_LIQUIDITY_USD = 50000;
const ALERT_COOLDOWN_MS = 30 * 60 * 1000;

// ── PASTE YOUR GENERATED WATCHLIST HERE ──────────────────────
const WATCHLIST = [
  { symbol: "EL",   contract: "0x2781246fe707bb15cee3e5ea354e2154a2877b16", chain: "ethereum" },
  { symbol: "BTR",  contract: "0x6c76de483f1752ac8473e2b4983a873991e70da7", chain: "ethereum" },
  { symbol: "HPP",  contract: "0xe33fa57582a02888b0542387a8686edd43d16256", chain: "ethereum" },
];

const recentDexAlerts = new Map();
const recentCexAlerts = new Map();

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

async function getAllCexPrices(symbol) {
  const sources = [
    { name: "Binance", url: `https://api.binance.com/api/v3/ticker/price?symbol=${symbol}USDT`, parse: j => parseFloat(j.price) },
    { name: "KuCoin",  url: `https://api.kucoin.com/api/v1/market/orderbook/level1?symbol=${symbol}-USDT`, parse: j => parseFloat(j?.data?.price) },
    { name: "Gate",    url: `https://api.gateio.ws/api/v4/spot/tickers?currency_pair=${symbol}_USDT`, parse: j => Array.isArray(j)&&j[0]?parseFloat(j[0].last):null },
    { name: "MEXC",    url: `https://api.mexc.com/api/v3/ticker/price?symbol=${symbol}USDT`, parse: j => parseFloat(j.price) },
    { name: "Kraken",  url: `https://api.kraken.com/0/public/Ticker?pair=${symbol}USD`, parse: j => { const k=Object.keys(j.result||{})[0]; return k?parseFloat(j.result[k].c[0]):null; } },
  ];
  const prices = {};
  await Promise.all(sources.map(async s => {
    try {
      const res = await fetch(s.url);
      if (!res.ok) return;
      const j = await res.json();
      const p = s.parse(j);
      if (p && !isNaN(p) && p > 0) prices[s.name] = p;
    } catch (_) {}
  }));
  return prices;
}

// Chain-matched DEX lookup — this is the core fix
async function getDexPrice(contract, expectedChain) {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${contract}`);
    if (!res.ok) return null;
    const j = await res.json();
    const pairs = (j.pairs || []).filter(p =>
      p.liquidity?.usd > MIN_LIQUIDITY_USD &&
      p.chainId === expectedChain &&
      p.baseToken?.address?.toLowerCase() === contract.toLowerCase()
    );
    if (pairs.length === 0) return null;
    const best = pairs.sort((a,b)=>(b.liquidity?.usd||0)-(a.liquidity?.usd||0))[0];
    return { price: parseFloat(best.priceUsd), url: best.url, liquidity: best.liquidity.usd, chain: best.chainId };
  } catch (_) { return null; }
}

async function scanCycle() {
  const t = new Date().toISOString();
  let dexFlags = 0, cexFlags = 0;

  for (const token of WATCHLIST) {
    const cexPrices = await getAllCexPrices(token.symbol);
    const exchanges = Object.keys(cexPrices);
    if (exchanges.length === 0) { await new Promise(r=>setTimeout(r,300)); continue; }

    let lowEx = exchanges[0], highEx = exchanges[0];
    for (const ex of exchanges) {
      if (cexPrices[ex] < cexPrices[lowEx])  lowEx  = ex;
      if (cexPrices[ex] > cexPrices[highEx]) highEx = ex;
    }
    const cheapCex = cexPrices[lowEx];

    // ── CEX-CEX ──
    if (exchanges.length >= 2) {
      const cexGap = ((cexPrices[highEx] - cexPrices[lowEx]) / cexPrices[lowEx]) * 100;
      const last = recentCexAlerts.get(token.symbol);
      const cooled = !last || Date.now() - last > ALERT_COOLDOWN_MS;
      // sanity: skip absurd gaps (wrong-token / stale listing)
      if (cexGap >= MIN_CEX_GAP_PCT && cexGap <= MAX_SANE_GAP_PCT && cooled) {
        cexFlags++;
        recentCexAlerts.set(token.symbol, Date.now());
        await sendTelegram([
          `💱 *CEX-CEX gap — ${token.symbol}*`,
          `Buy on ${lowEx}: $${cexPrices[lowEx].toPrecision(6)}`,
          `Sell on ${highEx}: $${cexPrices[highEx].toPrecision(6)}`,
          `Gap: +${cexGap.toFixed(1)}%`,
          ``,
          `⚠️ Verify withdrawals are OPEN on ${lowEx} before acting`,
        ].join("\n"));
        console.log(`  CEX-CEX ${token.symbol}: ${cexGap.toFixed(1)}%`);
      }
    }

    // ── CEX-DEX (chain-matched) ──
    const dex = await getDexPrice(token.contract, token.chain);
    if (dex && dex.price > 0) {
      const dexGap = ((dex.price - cheapCex) / cheapCex) * 100;
      const absGap = Math.abs(dexGap);
      const last = recentDexAlerts.get(token.contract);
      const cooled = !last || Date.now() - last > ALERT_COOLDOWN_MS;
      // sanity: skip absurd gaps -> almost always mismatched token
      if (absGap >= MIN_DEX_GAP_PCT && absGap <= MAX_SANE_GAP_PCT && cooled) {
        dexFlags++;
        recentDexAlerts.set(token.contract, Date.now());
        const higher = dexGap > 0 ? "DEX" : "CEX";
        await sendTelegram([
          `🎯 *CEX-DEX gap — ${token.symbol}*`,
          `${lowEx} (CEX): $${cheapCex.toPrecision(6)}`,
          `DEX (${dex.chain}): $${dex.price.toPrecision(6)}`,
          `Gap: ${dexGap>0?"+":""}${dexGap.toFixed(1)}% (${higher} higher)`,
          `DEX liquidity: $${Math.round(dex.liquidity).toLocaleString()}`,
          ``,
          `[DexScreener](${dex.url})`,
        ].join("\n"));
        console.log(`  CEX-DEX ${token.symbol}: ${dexGap.toFixed(1)}%`);
      }
    }

    await new Promise(r => setTimeout(r, 300));
  }

  console.log(`[${t}] cycle done — ${WATCHLIST.length} tokens | CEX-DEX: ${dexFlags} | CEX-CEX: ${cexFlags}`);
}

async function main() {
  console.log(`Scanner started — ${WATCHLIST.length} tokens`);
  console.log(`CEX-DEX: ${MIN_DEX_GAP_PCT}% | CEX-CEX: ${MIN_CEX_GAP_PCT}% | sanity cap: ${MAX_SANE_GAP_PCT}%`);
  await scanCycle();
  setInterval(scanCycle, SCAN_INTERVAL_MS);
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
