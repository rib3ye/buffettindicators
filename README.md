# BuffettIndex

A single-page dashboard that tracks four independent gauges of US stock market valuation, updated continuously from primary sources. No frontend framework, no build step — a Node.js server proxies FRED API calls to keep the API key server-side, serves static files, and caches responses in SQLite.

---

## The Four Gauges

| Gauge | What it measures |
|---|---|
| **Buffett Indicator** | Total US equity market cap (Fed Z.1 Flow of Funds) as a percentage of GDP. Buffett's preferred single measure of aggregate market valuation. |
| **Shiller CAPE** | Cyclically Adjusted P/E ratio — price divided by the 10-year average of inflation-adjusted earnings. Developed by Nobel laureate Robert Shiller. |
| **Fed Model** | Earnings yield (inverse of CAPE) versus the 10-year Treasury yield. Measures the relative attractiveness of equities vs. bonds. |
| **Corporate Profits / GDP** | After-tax corporate profits as a share of GDP. Profit margins are mean-reverting; this tracks how far the current cycle has stretched them. |

---

## Local Setup

### Prerequisites

- Node.js 22+
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

### Install and run

```bash
npm install
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
Browser  →  GET /api/fred?series_id=NCBEILQ027S  →  Node server
                                                       │
                                            SQLite cache hit? ─┤
                                                       │ miss
                                                       ↓
                                            FRED API (api.stlouisfed.org)
                                            API key injected server-side
```

**Why a Node proxy instead of calling FRED directly from the browser?**
FRED requires an API key. Putting a key in client-side JS exposes it to anyone who opens DevTools. The proxy keeps the key in the server process environment, validates every request against an allowlist of permitted series IDs, and never forwards it to the client.

**Two-layer cache.** Responses from FRED and the Shiller data source are stored in both an in-memory `Map` (fast reads) and a SQLite database (persistence). Reads always come from memory — no disk I/O on the hot path. Writes go to both layers immediately, so the database is always current. On startup the Map is populated from SQLite, giving a warm cache from the very first request after a deploy or restart.

Cache TTLs vary by series: SP500 expires after 1 hour, GDP and other quarterly series after 24 hours, everything else after 6 hours. The in-memory cache is capped at 200 entries (LRU eviction). The SQLite database is cleaned via the same LRU eviction path.

**Stale-on-error.** If a FRED upstream fetch fails (timeout, outage), the server falls back to the most recent cached response for that series regardless of its TTL — so users never see a broken page due to a temporary FRED outage. Entries with non-200 status codes are never served as stale.

**Request coalescing.** If multiple requests arrive for the same cache key while an upstream fetch is in flight, they all wait on the same `Promise` rather than triggering duplicate FRED calls.

**Rate limiting.** 10 requests per IP per minute, 80 requests globally per minute, enforced with a sliding window. Stale per-IP windows are pruned every 5 minutes.

**Static files.** `index.html` is served with `Cache-Control: no-cache` so browsers always revalidate. All other assets (including `styles.css`) get `max-age=31536000, immutable`. ETags are derived from `mtime`.

---

## Deployment (VPS / systemd behind a reverse proxy)

The app runs as a plain-HTTP Node process bound to loopback; a front-end reverse proxy (Caddy, nginx, …) terminates TLS and forwards by hostname. This is how it's deployed on the production VPS.

**Environment** — set via the systemd `EnvironmentFile` (e.g. `/etc/buffettindicators.env`, root-owned, `chmod 600`):

```
NODE_ENV=production
HOST=127.0.0.1                       # bind loopback only — reachable solely via the proxy
PORT=3002
CACHE_DIR=/srv/buffettindicators/data
FRED_API_KEY=your_key_here
```

`HOST` defaults to `0.0.0.0` when unset (local dev). `NODE_ENV=production` suppresses the TLS-not-found warning and per-request logging. The reverse proxy must pass `X-Forwarded-For` (used for the per-IP rate limiter).

**systemd unit** (`/etc/systemd/system/buffettindicators.service`) runs `node server.js` from `/srv/buffettindicators` as a non-root user, with `ReadWritePaths=/srv/buffettindicators/data` so the SQLite cache survives restarts and redeploys.

**Deploy:** `./deploy.sh` rsyncs the repo to `/srv/buffettindicators`, runs `npm ci --omit=dev`, and restarts the service.

The server creates `cache.db` inside `CACHE_DIR` on first boot and reloads it on every subsequent start. All writes happen immediately — no data is lost if the process is killed hard. No build step; the start command is `node server.js` (via `npm start`).

---

## Data Sources

| Source | Series / Endpoint |
|---|---|
| [FRED (St. Louis Fed)](https://fred.stlouisfed.org) | `NCBEILQ027S` (total equity market cap, Fed Z.1), `GDP`, `GDPA`, `SP500`, `GS10` (10-yr Treasury), `CPIAUCSL` (CPI), `FEDFUNDS`, `CP` (corporate profits), `DDDM01USA156NWDB` (market cap / GDP fallback) |
| [Shiller Data (via posix4e GitHub mirror)](https://posix4e.github.io/shiller_wrapper_data/data/stock_market_data.json) | CAPE ratio historical series |
