// ============================================================
//  Bulk CEX-DEX Divergence Scanner
//
//  Runs independently of the discovery stream. Every cycle it:
//    1. Pulls ALL-ticker price dumps from multiple CEXs in bulk
//       (a few calls return thousands of prices)
//    2. Cross-references symbols that appear on a CEX against
//       DEX prices (via DexScreener) for the same asset
//    3. Flags any gap >= MIN_GAP_PCT to Telegram
//
//  It auto-discovers which coins exist on both sides — no
//  manual token list to maintain.
//
//  Setup:
//    npm install node-fetch dotenv   (Node 18+ has fetch built in)
//    node bulk-scanner.js
//
//  Fill in TELEGRAM_TOKEN and TELEGRAM_CHAT_ID below.
// ============================================================

const TELEGRAM_TOKEN   = process.env.TELEGRAM_TOKEN   || "YOUR_BOT_TOKEN";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "1501079802";

const MIN_GAP_PCT      = 5;      // only alert on gaps this size or bigger
const SCAN_INTERVAL_MS = 120000; // scan every 2 minutes
const MIN_CEX_PRICE    = 0.0000001; // ignore dust/garbage tickers
const ALERT_COOLDOWN_MS = 30 * 60 * 1000; // don't repeat same token within 30 min

// Track recently-alerted tokens so we don't spam the same gap
const recentAlerts = new Map();

// ── Telegram ─────────────────────────────────────────────────
async function sendTelegram(text) {
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: "Markdown",
        disable_web_page_preview: true,
      }),
    });
  } catch (e) { console.error("Telegram error:", e.message); }
}

// ── CEX bulk price fetchers (one call = thousands of prices) ──
// Each returns a Map of SYMBOL -> price (USD/USDT quoted)

async function getBinancePrices() {
  const map = new Map();
  try {
    const res = await fetch("https://api.binance.com/api/v3/ticker/price");
    const arr = await res.json();
    for (const t of arr) {
      if (t.symbol.endsWith("USDT")) {
        const sym = t.symbol.slice(0, -4);
        map.set(sym, parseFloat(t.price));
      }
    }
  } catch (e) { console.error("Binance:", e.message); }
  return map;
}

async function getKucoinPrices() {
  const map = new Map();
  try {
    const res = await fetch("https://api.kucoin.com/api/v1/market/allTickers");
    const j = await res.json();
    for (const t of (j.data?.ticker || [])) {
      if (t.symbol.endsWith("-USDT")) {
        const sym = t.symbol.replace("-USDT", "");
        if (t.last) map.set(sym, parseFloat(t.last));
      }
    }
  } catch (e) { console.error("KuCoin:", e.message); }
  return map;
}

async function getGatePrices() {
  const map = new Map();
  try {
    const res = await fetch("https://api.gateio.ws/api/v4/spot/tickers");
    const arr = await res.json();
    for (const t of arr) {
      if (t.currency_pair.endsWith("_USDT")) {
        const sym = t.currency_pair.replace("_USDT", "");
        if (t.last) map.set(sym, parseFloat(t.last));
      }
    }
  } catch (e) { console.error("Gate:", e.message); }
  return map;
}

async function getMexcPrices() {
  const map = new Map();
  try {
    const res = await fetch("https://api.mexc.com/api/v3/ticker/price");
    const arr = await res.json();
    for (const t of arr) {
      if (t.symbol.endsWith("USDT")) {
        const sym = t.symbol.slice(0, -4);
        map.set(sym, parseFloat(t.price));
      }
    }
  } catch (e) { console.error("MEXC:", e.message); }
  return map;
}

// ── DEX price for a symbol via DexScreener search ────────────
// Returns { priceUsd, chain, url, liquidity } for the deepest pool
async function getDexData(symbol) {
  try {
    const res = await fetch(
      `https://api.dexscreener.com/latest/dex/search?q=${symbol}`
    );
    if (!res.ok) return null;
    const j = await res.json();
    const pairs = (j.pairs || []).filter(p =>
      p.baseToken?.symbol?.toUpperCase() === symbol.toUpperCase() &&
      p.liquidity?.usd > 20000 // ignore illiquid pools (avoids BDX-style traps)
    );
    if (pairs.length === 0) return null;
    const best = pairs.sort((a, b) => (b.liquidity?.usd||0) - (a.liquidity?.usd||0))[0];
    return {
      priceUsd: parseFloat(best.priceUsd),
      chain: best.chainId,
      url: best.url,
      liquidity: best.liquidity.usd,
    };
  } catch (_) { return null; }
}

// ── one scan cycle ───────────────────────────────────────────
async function scanCycle() {
  const startedAt = new Date().toISOString();

  // 1. Pull all CEX prices in bulk (a handful of calls)
  const [binance, kucoin, gate, mexc] = await Promise.all([
    getBinancePrices(),
    getKucoinPrices(),
    getGatePrices(),
    getMexcPrices(),
  ]);

  // 2. Build a combined symbol -> {price, source} reference.
  //    Prefer the exchange with the most listings (Binance) but
  //    fall back through the others so obscure tokens are covered.
  const cexRef = new Map();
  const addAll = (map, name) => {
    for (const [sym, price] of map) {
      if (price > MIN_CEX_PRICE && !cexRef.has(sym)) {
        cexRef.set(sym, { price, source: name });
      }
    }
  };
  addAll(binance, "Binance");
  addAll(kucoin, "KuCoin");
  addAll(gate, "Gate");
  addAll(mexc, "MEXC");

  console.log(`[${startedAt}] CEX symbols to check: ${cexRef.size}`);

  // 3. For each CEX symbol, check DEX price. Throttle to respect
  //    DexScreener limits (~300/min => ~5/sec). We go a bit under.
  let checked = 0, flagged = 0;
  const symbols = [...cexRef.keys()];

  for (const sym of symbols) {
    // cooldown check
    const last = recentAlerts.get(sym);
    if (last && Date.now() - last < ALERT_COOLDOWN_MS) continue;

    const dex = await getDexData(sym);
    checked++;

    if (dex && dex.priceUsd > 0) {
      const cex = cexRef.get(sym);
      const gapPct = ((dex.priceUsd - cex.price) / cex.price) * 100;
      const absGap = Math.abs(gapPct);

      if (absGap >= MIN_GAP_PCT) {
        flagged++;
        recentAlerts.set(sym, Date.now());
        const higher = gapPct > 0 ? "DEX" : "CEX";
        await sendTelegram([
          `🎯 *CEX-DEX gap — ${sym}*`,
          `${cex.source} (CEX): $${cex.price.toPrecision(6)}`,
          `DEX (${dex.chain}): $${dex.priceUsd.toPrecision(6)}`,
          `Gap: ${gapPct > 0 ? "+" : ""}${gapPct.toFixed(1)}% (${higher} higher)`,
          `DEX liquidity: $${Math.round(dex.liquidity).toLocaleString()}`,
          ``,
          `[DexScreener](${dex.url})`,
        ].join("\n"));
        console.log(`  FLAG ${sym}: ${gapPct.toFixed(1)}% (${cex.source} vs ${dex.chain})`);
      }
    }

    // throttle ~5 checks/sec to stay under DexScreener rate limit
    await new Promise(r => setTimeout(r, 200));
  }

  console.log(`[${new Date().toISOString()}] cycle done — checked ${checked}, flagged ${flagged}`);
}

// ── main loop ────────────────────────────────────────────────
async function main() {
  console.log("Bulk CEX-DEX scanner started");
  console.log(`Gap threshold: ${MIN_GAP_PCT}% | Scan every ${SCAN_INTERVAL_MS/1000}s`);
  await scanCycle();
  setInterval(scanCycle, SCAN_INTERVAL_MS);
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
