# BuffettIndex

A single-page dashboard that tracks four independent gauges of US stock market valuation, updated continuously from primary sources. No frameworks, no build step — a Node.js server proxies FRED API calls to keep the API key server-side, serves static files, and caches responses in memory.

---

## The Four Gauges

| Gauge | What it measures |
|---|---|
| **Buffett Indicator** | Wilshire 5000 total market cap as a percentage of GDP. Buffett's preferred single measure of aggregate market valuation. |
| **Shiller CAPE** | Cyclically Adjusted P/E ratio — price divided by the 10-year average of inflation-adjusted earnings. Developed by Nobel laureate Robert Shiller. |
| **Fed Model** | Earnings yield (inverse of CAPE) versus the 10-year Treasury yield. Measures the relative attractiveness of equities vs. bonds. |
| **Corporate Profits / GDP** | After-tax corporate profits as a share of GDP. Profit margins are mean-reverting; this tracks how far the current cycle has stretched them. |

---

## Local Setup

### Prerequisites

- Node.js 18+ (no npm dependencies — the server uses only Node built-ins)
- A FRED API key (free, takes 30 seconds)

### Get a FRED API key

1. Create a free account at [fred.stlouisfed.org](https://fred.stlouisfed.org)
2. Go to **My Account → API Keys → Request API Key**
3. Copy the key

### Configure environment

```bash
cp .env.example .env.local
# Edit .env.local and set your key:
# FRED_API_KEY=your_key_here
```

The server loads `.env.local` first, then `.env`. Values in earlier files are never overwritten, so `.env.local` is safe for local secrets.

### Run

```bash
node server.js
# or
npm start
```

The server starts on port 3443 by default. Override with `PORT=8080 node server.js`.

**Optional HTTPS locally:** The server detects `localhost+2.pem` / `localhost+2-key.pem` in the project root and upgrades to HTTPS automatically. Generate them with [mkcert](https://github.com/FiloSottile/mkcert):

```bash
mkcert localhost 127.0.0.1 ::1
```

Without the certificates the server falls back to plain HTTP — fine for local development.

---

## Architecture

```
Browser  →  GET /api/fred?series_id=WILL5000INDFC  →  Node server
                                                         │
                                              cache hit? ─┤
                                                         │ miss
                                                         ↓
                                              FRED API (api.stlouisfed.org)
                                              API key injected server-side
```

**Why a Node proxy instead of calling FRED directly from the browser?**
FRED requires an API key. Putting a key in client-side JS exposes it to anyone who opens DevTools. The proxy keeps the key in the server process environment, validates every request against an allowlist of permitted series IDs, and never forwards it to the client.

**In-memory cache.** Responses from FRED and the Shiller data source are cached in a `Map` keyed by `seriesId|observation_start|frequency`. TTLs vary by series — SP500 data expires after 1 hour, GDP and other quarterly series after 24 hours, everything else after 6 hours. The cache is capped at 200 entries (LRU eviction on the oldest key). There is no persistence; the cache resets on restart.

**Request coalescing.** If multiple requests arrive for the same cache key while an upstream fetch is in flight, they all wait on the same `Promise` rather than triggering duplicate FRED calls.

**Rate limiting.** 10 requests per IP per minute, 80 requests globally per minute, enforced with a sliding window. Stale per-IP windows are pruned every 5 minutes.

**Static files.** `index.html` is served with `Cache-Control: no-cache` so browsers always revalidate. All other assets get `max-age=31536000, immutable`. ETags are derived from `mtime`.

---

## Deployment (Railway)

1. Create a new Railway project and connect the repo.
2. Set the `FRED_API_KEY` environment variable in the Railway dashboard.
3. Optionally set `PORT` (Railway injects this automatically) and `NODE_ENV=production`.
4. Deploy. Railway terminates TLS at the edge — the Node process runs plain HTTP behind it, which is correct. The server suppresses the TLS-not-found warning when `NODE_ENV=production`.

No build step. The start command is `node server.js`.

---

## Data Sources

| Source | Series / Endpoint |
|---|---|
| [FRED (St. Louis Fed)](https://fred.stlouisfed.org) | `WILL5000INDFC` (Wilshire 5000), `GDP`, `GDPA`, `SP500`, `GS10` (10-yr Treasury), `CPIAUCSL` (CPI), `FEDFUNDS`, `NCBEILQ027S` (corporate profits), `CP`, `DDDM01USA156NWDB` (market cap / GDP ratio) |
| [Shiller Data (via posix4e GitHub mirror)](https://posix4e.github.io/shiller_wrapper_data/data/stock_market_data.json) | CAPE ratio historical series |
