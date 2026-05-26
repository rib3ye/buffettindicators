const http     = require("http");
const https    = require("https");
const fs       = require("fs");
const path     = require("path");
const { URL }  = require("url");
const Database = require("better-sqlite3");

// ── Environment ───────────────────────────────────────────────────────────────
// Load .env.local first, then .env. Earlier files win — variables already set
// in the environment are never overwritten.

for (const envFile of [".env.local", ".env"]) {
  try {
    const lines = fs.readFileSync(path.join(__dirname, envFile), "utf8").split("\n");
    for (const line of lines) {
      const match = line.match(/^\s*([^#][^=]*?)\s*=\s*(.*)\s*$/);
      if (match && !(match[1] in process.env)) {
        process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
      }
    }
  } catch { /* file doesn't exist — skip it */ }
}

const port        = Number(process.env.PORT) || 3443;
const rootDir     = __dirname;
const FRED_API_KEY = process.env.FRED_API_KEY;

if (!FRED_API_KEY) {
  console.error("ERROR: FRED_API_KEY environment variable is not set.");
  process.exit(1);
}

// ── TLS ───────────────────────────────────────────────────────────────────────
// Use HTTPS locally when mkcert certificates are present; fall back to HTTP.
// In production the platform (Railway) terminates TLS upstream.

let tlsOptions = null;
try {
  tlsOptions = {
    key:  fs.readFileSync(path.join(rootDir, "localhost+2-key.pem")),
    cert: fs.readFileSync(path.join(rootDir, "localhost+2.pem")),
  };
} catch {
  if (process.env.NODE_ENV !== "production") {
    console.warn(
      "WARNING: TLS certificate not found — running over plain HTTP.\n" +
      "  To enable HTTPS locally: mkcert localhost 127.0.0.1 ::1"
    );
  }
}

// ── Allowlist ─────────────────────────────────────────────────────────────────
// Only these FRED series IDs may be requested through the proxy. Any request
// for a series not on this list gets a 400 immediately, before touching FRED.

const ALLOWED_FRED_SERIES = new Set([
  "WILL5000INDFC", "GDP", "GDPA", "DDDM01USA156NWDB",
  "GS10", "CPIAUCSL", "UNRATE", "FEDFUNDS",
  "NCBEILQ027S", "SP500", "CP",
]);

// ── Cache TTLs ────────────────────────────────────────────────────────────────
// Series that update infrequently get a full-day TTL. Everything else defaults
// to six hours so near-real-time series (e.g. SP500) stay reasonably fresh.

const ONE_HOUR_MS  = 60 * 60 * 1000;
const SIX_HOURS_MS = 6 * ONE_HOUR_MS;
const ONE_DAY_MS   = 24 * ONE_HOUR_MS;

const SERIES_TTL_OVERRIDES = {
  SP500:            ONE_HOUR_MS,
  GDPA:             ONE_DAY_MS,
  GDP:              ONE_DAY_MS,
  NCBEILQ027S:      ONE_DAY_MS,
  CP:               ONE_DAY_MS,
  DDDM01USA156NWDB: ONE_DAY_MS,
};

function getTtlForSeries(seriesId) {
  return SERIES_TTL_OVERRIDES[seriesId] ?? SIX_HOURS_MS;
}

// ── Cache ─────────────────────────────────────────────────────────────────────
// Two-layer cache: a fast in-memory Map (L1) backed by a SQLite database (L2).
//
// Reads always come from the in-memory Map — no disk I/O on the hot path.
// Writes go to both layers immediately, so the database is always up to date.
// On startup the Map is populated from the database, giving persistence across
// both process restarts and new Railway deploys (when a Volume is mounted).
//
// The database file lives in CACHE_DIR, which should be set to the Railway
// Volume mount path (e.g. /data) in production. Falls back to the project
// directory for local development.
//
// Each cache entry: { body: Buffer, statusCode: number, storedAt: number, ttlMs: number }

const CACHE_MAX_ENTRIES = 200;

const CACHE_DIR = process.env.CACHE_DIR || __dirname;
fs.mkdirSync(CACHE_DIR, { recursive: true });
const db = new Database(path.join(CACHE_DIR, "cache.db"));

db.exec(`
  CREATE TABLE IF NOT EXISTS cache (
    key          TEXT    PRIMARY KEY,
    body         BLOB    NOT NULL,
    status_code  INTEGER NOT NULL,
    stored_at    INTEGER NOT NULL,
    ttl_ms       INTEGER NOT NULL
  )
`);

const dbUpsert = db.prepare(
  "INSERT OR REPLACE INTO cache (key, body, status_code, stored_at, ttl_ms) VALUES (?, ?, ?, ?, ?)"
);
const dbDelete = db.prepare("DELETE FROM cache WHERE key = ?");

const cache = new Map();

// Populate the in-memory Map from the database on startup.
// Skips non-200 entries so we never resurrect a cached error response.
function loadCacheFromDatabase() {
  const rows = db.prepare("SELECT * FROM cache WHERE status_code = 200").all();
  for (const row of rows) {
    cache.set(row.key, {
      body:       row.body,         // better-sqlite3 returns BLOBs as Buffers
      statusCode: row.status_code,
      storedAt:   row.stored_at,
      ttlMs:      row.ttl_ms,
    });
  }
  if (cache.size > 0) console.log(`Cache loaded: ${cache.size} entries restored from database`);
}

function buildCacheKey(seriesId, observationStart, frequency) {
  return `${seriesId}|${observationStart ?? ""}|${frequency ?? ""}`;
}

function getFromCache(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  const isStale = Date.now() - entry.storedAt > entry.ttlMs;
  return { ...entry, isStale };
}

function storeInCache(key, body, statusCode, ttlMs) {
  if (cache.size >= CACHE_MAX_ENTRIES && !cache.has(key)) {
    const oldestKey = cache.keys().next().value;
    cache.delete(oldestKey);
    dbDelete.run(oldestKey);
  }
  const storedAt = Date.now();
  cache.set(key, { body, statusCode, storedAt, ttlMs });
  dbUpsert.run(key, body, statusCode, storedAt, ttlMs);
}

// ── In-flight request coalescing ──────────────────────────────────────────────
// When multiple requests arrive for the same uncached resource at once, only
// one upstream fetch is made. All callers await the same Promise, preventing
// a thundering-herd of duplicate upstream calls.
//
// Maps a cache key → Promise<{ body: Buffer, statusCode: number }>

const inFlightRequests = new Map();

// ── Rate limiter ──────────────────────────────────────────────────────────────
// Sliding-window rate limiter. Timestamps for each IP (and globally) are kept
// in arrays; old entries are pruned before each check.

const RATE_LIMIT = {
  windowMs:   60 * 1000, // 1-minute window
  perIpMax:   10,        // requests per IP per window
  globalMax:  80,        // total requests across all IPs per window
};

const requestTimestampsByIp = new Map(); // Map<ip, number[]>
const globalRequestTimestamps = [];      // number[]

function pruneOldTimestamps(timestamps) {
  const cutoff = Date.now() - RATE_LIMIT.windowMs;
  let countToRemove = 0;
  while (countToRemove < timestamps.length && timestamps[countToRemove] < cutoff) {
    countToRemove++;
  }
  timestamps.splice(0, countToRemove);
}

// Evict IPs with no recent requests every 5 minutes to prevent unbounded Map growth.
setInterval(() => {
  for (const [ip, timestamps] of requestTimestampsByIp) {
    pruneOldTimestamps(timestamps);
    if (timestamps.length === 0) requestTimestampsByIp.delete(ip);
  }
}, 5 * 60 * 1000).unref();

function checkRateLimit(ip) {
  const now = Date.now();

  pruneOldTimestamps(globalRequestTimestamps);
  if (globalRequestTimestamps.length >= RATE_LIMIT.globalMax) {
    return { allowed: false, retryAfterSeconds: Math.ceil(RATE_LIMIT.windowMs / 1000) };
  }

  if (!requestTimestampsByIp.has(ip)) requestTimestampsByIp.set(ip, []);
  const ipTimestamps = requestTimestampsByIp.get(ip);
  pruneOldTimestamps(ipTimestamps);

  if (ipTimestamps.length >= RATE_LIMIT.perIpMax) {
    const windowResetAt = ipTimestamps[0] + RATE_LIMIT.windowMs;
    const retryAfterSeconds = Math.max(1, Math.ceil((windowResetAt - now) / 1000));
    return { allowed: false, retryAfterSeconds };
  }

  ipTimestamps.push(now);
  globalRequestTimestamps.push(now);
  return { allowed: true };
}

// ── Static file helpers ───────────────────────────────────────────────────────

const CONTENT_TYPE_BY_EXTENSION = {
  ".html":        "text/html; charset=utf-8",
  ".js":          "text/javascript; charset=utf-8",
  ".css":         "text/css; charset=utf-8",
  ".json":        "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".xml":         "application/xml; charset=utf-8",
  ".png":         "image/png",
  ".jpg":         "image/jpeg",
  ".jpeg":        "image/jpeg",
  ".gif":         "image/gif",
  ".svg":         "image/svg+xml",
  ".ico":         "image/x-icon",
  ".txt":         "text/plain; charset=utf-8",
  ".woff":        "font/woff",
  ".woff2":       "font/woff2",
};

// Resolve a URL path to an absolute filesystem path, rejecting anything that
// tries to escape the root directory (path traversal protection).
function resolveStaticFilePath(requestPath) {
  const cleaned = decodeURIComponent(requestPath.split("?")[0]);
  const relativePath = cleaned === "/" ? "/index.html" : cleaned;
  const absolutePath = path.normalize(path.join(rootDir, relativePath));

  const isInsideRoot = absolutePath.startsWith(rootDir + path.sep) || absolutePath === rootDir;
  if (!isInsideRoot) return null;

  return absolutePath;
}

function staticCacheHeaders(ext) {
  // HTML must always revalidate so users get the latest version immediately.
  if (ext === ".html") return { "Cache-Control": "no-cache" };
  // CSS and JS are not content-hashed, so use a short TTL with revalidation.
  if (ext === ".css" || ext === ".js") return { "Cache-Control": "public, max-age=300, must-revalidate" };
  // Images and other assets change rarely — cache for a long time.
  return { "Cache-Control": "public, max-age=31536000, immutable" };
}

// ── Request handlers ──────────────────────────────────────────────────────────

function getClientIp(req) {
  const forwardedFor = req.headers["x-forwarded-for"];
  if (forwardedFor) return forwardedFor.split(",")[0].trim();
  return req.socket?.remoteAddress ?? "unknown";
}

// Shared response writer for both FRED and Shiller proxy handlers.
function sendJsonResponse(res, statusCode, body, securityHeaders) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
    ...securityHeaders,
  });
  res.end(body);
}

// Shared upstream fetcher used by both FRED and Shiller proxy handlers.
// Fetches `url`, stores the result in `cacheKey`, and returns a Promise that
// resolves to `{ body: Buffer, statusCode: number }`.
function fetchUpstream(url, cacheKey, ttlMs) {
  const fetchPromise = new Promise((resolve, reject) => {
    const upstreamReq = https.get(url, (upstreamRes) => {
      const chunks = [];
      upstreamRes.on("data", (chunk) => chunks.push(chunk));
      upstreamRes.on("end", () => {
        const body = Buffer.concat(chunks);
        // Only cache successful responses — never overwrite good data with errors.
        if (upstreamRes.statusCode >= 200 && upstreamRes.statusCode < 300) {
          storeInCache(cacheKey, body, upstreamRes.statusCode, ttlMs);
        }
        resolve({ body, statusCode: upstreamRes.statusCode });
      });
    });

    upstreamReq.setTimeout(8000, () => {
      upstreamReq.destroy();
      reject(new Error("Gateway Timeout"));
    });

    upstreamReq.on("error", (err) => {
      if (err.code !== "ECONNRESET") console.error("Upstream proxy error:", err);
      reject(err);
    });
  });

  inFlightRequests.set(cacheKey, fetchPromise);
  fetchPromise.finally(() => inFlightRequests.delete(cacheKey));

  return fetchPromise;
}

// Send an error response, choosing 504 for timeouts and 502 for all other failures.
function sendUpstreamErrorResponse(res, err, securityHeaders) {
  if (res.headersSent) return;
  const isTimeout = err.message === "Gateway Timeout";
  res.writeHead(isTimeout ? 504 : 502, { "Content-Type": "text/plain", ...securityHeaders });
  res.end(isTimeout ? "Gateway Timeout" : "Upstream error");
}

function handleFredRequest(req, res, parsedUrl, securityHeaders) {
  if (req.method !== "GET") {
    res.writeHead(405, { Allow: "GET", "Content-Type": "text/plain", ...securityHeaders });
    res.end("Method Not Allowed");
    return;
  }

  const ip = getClientIp(req);
  const { allowed, retryAfterSeconds } = checkRateLimit(ip);
  if (!allowed) {
    res.writeHead(429, {
      "Content-Type": "text/plain",
      "Retry-After": String(retryAfterSeconds),
      ...securityHeaders,
    });
    res.end("Too Many Requests");
    return;
  }

  const seriesId = parsedUrl.searchParams.get("series_id");
  if (!seriesId || !ALLOWED_FRED_SERIES.has(seriesId)) {
    res.writeHead(400, { "Content-Type": "text/plain", ...securityHeaders });
    res.end("Bad Request");
    return;
  }

  const observationStart = parsedUrl.searchParams.get("observation_start");
  const frequency        = parsedUrl.searchParams.get("frequency");
  const cacheKey = buildCacheKey(seriesId, observationStart, frequency);

  const cached = getFromCache(cacheKey);
  if (cached && !cached.isStale) {
    sendJsonResponse(res, cached.statusCode, cached.body, securityHeaders);
    return;
  }

  // On upstream failure, serve the stale entry (if one exists with a good status)
  // so users never see a broken page just because FRED is temporarily down.
  const serveStaleOnFailure = (err) => {
    if (cached && cached.statusCode === 200) {
      sendJsonResponse(res, cached.statusCode, cached.body, securityHeaders);
    } else {
      sendUpstreamErrorResponse(res, err, securityHeaders);
    }
  };

  // If an identical request is already in-flight, attach to its Promise instead
  // of making a second upstream call.
  if (inFlightRequests.has(cacheKey)) {
    inFlightRequests.get(cacheKey)
      .then(({ body, statusCode }) => sendJsonResponse(res, statusCode, body, securityHeaders))
      .catch(serveStaleOnFailure);
    return;
  }

  // Build the upstream FRED URL, sanitizing each optional parameter before use.
  const fredParams = new URLSearchParams();
  fredParams.set("series_id", seriesId);
  if (observationStart && /^\d{4}-\d{2}-\d{2}$/.test(observationStart)) {
    fredParams.set("observation_start", observationStart);
  }
  if (frequency && ["d", "w", "bw", "m", "q", "sa", "a"].includes(frequency)) {
    fredParams.set("frequency", frequency);
  }
  fredParams.set("file_type", "json");
  fredParams.set("api_key", FRED_API_KEY);

  const fredUrl = `https://api.stlouisfed.org/fred/series/observations?${fredParams.toString()}`;

  fetchUpstream(fredUrl, cacheKey, getTtlForSeries(seriesId))
    .then(({ body, statusCode }) => {
      // If upstream returned an error (e.g. 429) but we have stale good data, prefer the stale data.
      if (statusCode >= 400 && cached && cached.statusCode === 200) {
        sendJsonResponse(res, cached.statusCode, cached.body, securityHeaders);
      } else {
        sendJsonResponse(res, statusCode, body, securityHeaders);
      }
    })
    .catch(serveStaleOnFailure);
}

const SHILLER_DATA_URL   = "https://posix4e.github.io/shiller_wrapper_data/data/stock_market_data.json";
const SHILLER_CACHE_KEY  = "shiller";

function handleShillerRequest(req, res, securityHeaders) {
  if (req.method !== "GET") {
    res.writeHead(405, { Allow: "GET", "Content-Type": "text/plain", ...securityHeaders });
    res.end("Method Not Allowed");
    return;
  }

  const cached = getFromCache(SHILLER_CACHE_KEY);
  if (cached && !cached.isStale) {
    sendJsonResponse(res, cached.statusCode, cached.body, securityHeaders);
    return;
  }

  const serveStaleOnFailure = (err) => {
    if (cached && cached.statusCode === 200) {
      sendJsonResponse(res, cached.statusCode, cached.body, securityHeaders);
    } else {
      sendUpstreamErrorResponse(res, err, securityHeaders);
    }
  };

  if (inFlightRequests.has(SHILLER_CACHE_KEY)) {
    inFlightRequests.get(SHILLER_CACHE_KEY)
      .then(({ body, statusCode }) => sendJsonResponse(res, statusCode, body, securityHeaders))
      .catch(serveStaleOnFailure);
    return;
  }

  fetchUpstream(SHILLER_DATA_URL, SHILLER_CACHE_KEY, ONE_DAY_MS)
    .then(({ body, statusCode }) => {
      if (statusCode >= 400 && cached && cached.statusCode === 200) {
        sendJsonResponse(res, cached.statusCode, cached.body, securityHeaders);
      } else {
        sendJsonResponse(res, statusCode, body, securityHeaders);
      }
    })
    .catch(serveStaleOnFailure);
}

function handleStaticFileRequest(req, res, securityHeaders) {
  const targetPath = resolveStaticFilePath(req.url || "/");
  if (!targetPath) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8", ...securityHeaders });
    res.end("Forbidden");
    return;
  }

  fs.stat(targetPath, (statErr, stats) => {
    if (statErr || !stats.isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", ...securityHeaders });
      res.end("Not Found");
      return;
    }

    const extension  = path.extname(targetPath).toLowerCase();
    const contentType = CONTENT_TYPE_BY_EXTENSION[extension] || "application/octet-stream";

    // Lightweight ETag derived from last-modified time. Lets browsers skip
    // downloading unchanged files without needing a full content hash.
    const etag = `"${stats.mtime.getTime().toString(16)}"`;
    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304, { ETag: etag, ...staticCacheHeaders(extension), ...securityHeaders });
      res.end();
      return;
    }

    const fileStream = fs.createReadStream(targetPath);

    // Attach the error handler before piping to guarantee it's caught.
    fileStream.on("error", (streamErr) => {
      console.error("Static file stream error:", streamErr);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8", ...securityHeaders });
        res.end("Internal Server Error");
      }
    });

    res.writeHead(200, {
      "Content-Type": contentType,
      ETag: etag,
      ...staticCacheHeaders(extension),
      ...securityHeaders,
    });
    fileStream.pipe(res);
  });
}

// ── Server ────────────────────────────────────────────────────────────────────

const requestHandler = (req, res) => {
  const parsedUrl = new URL(req.url || "/", `https://localhost:${port}`);

  // Skip per-request logging in production to avoid log noise.
  if (process.env.NODE_ENV !== "production") {
    console.log(`${req.method} ${parsedUrl.pathname}`);
  }

  const securityHeaders = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "geolocation=(), camera=(), microphone=()",
    "Content-Security-Policy": [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://static.cloudflareinsights.com",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src https://fonts.gstatic.com",
      "img-src 'self' data:",
      "connect-src 'self' https://cdn.jsdelivr.net https://cloudflareinsights.com",
    ].join("; "),
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  };

  // In production, redirect www → non-www (or adjust to match the preferred canonical host).
  if (process.env.NODE_ENV === "production" && process.env.CANONICAL_HOST) {
    const host = (req.headers["x-forwarded-host"] || req.headers["host"] || "").toLowerCase();
    if (host && host !== process.env.CANONICAL_HOST) {
      const redirectTarget = `https://${process.env.CANONICAL_HOST}${req.url || "/"}`;
      res.writeHead(301, { Location: redirectTarget, ...securityHeaders });
      res.end();
      return;
    }
  }

  if (parsedUrl.pathname === "/api/fred") {
    handleFredRequest(req, res, parsedUrl, securityHeaders);
    return;
  }

  if (parsedUrl.pathname === "/api/shiller") {
    handleShillerRequest(req, res, securityHeaders);
    return;
  }

  handleStaticFileRequest(req, res, securityHeaders);
};

loadCacheFromDatabase();

const server = tlsOptions
  ? https.createServer(tlsOptions, requestHandler)
  : http.createServer(requestHandler);

server.on("error", (err) => { console.error("Server error:", err); });

// Close the database cleanly on shutdown so SQLite's WAL is fully checkpointed.
// Railway sends SIGTERM before killing the process; SIGINT handles Ctrl-C locally.
function shutdown() {
  db.close();
  server.close(() => process.exit(0));
}
process.on("SIGTERM", shutdown);
process.on("SIGINT",  shutdown);

const protocol = tlsOptions ? "https" : "http";
// Bind address. Defaults to all interfaces (Railway/local). Set HOST=127.0.0.1
// in production behind a reverse proxy so the port isn't publicly reachable.
const host = process.env.HOST || "0.0.0.0";
server.listen(port, host, () => {
  console.log(`BuffettIndex server running at ${protocol}://${host}:${port}`);
});
