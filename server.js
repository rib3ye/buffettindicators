const http  = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

// Load .env.local then .env (later files don't overwrite earlier ones)
for (const envFile of [".env.local", ".env"]) {
  try {
    const lines = fs.readFileSync(path.join(__dirname, envFile), "utf8").split("\n");
    for (const line of lines) {
      const match = line.match(/^\s*([^#][^=]*?)\s*=\s*(.*)\s*$/);
      if (match && !(match[1] in process.env)) {
        process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
      }
    }
  } catch { /* file doesn't exist, skip */ }
}

const port = Number(process.env.PORT) || 3443;
const rootDir = __dirname;
const FRED_API_KEY = process.env.FRED_API_KEY;
if (!FRED_API_KEY) {
  console.error("ERROR: FRED_API_KEY environment variable is not set.");
  process.exit(1);
}

const ALLOWED_FRED_SERIES = new Set([
  'WILL5000INDFC', 'GDP', 'GDPA', 'DDDM01USA156NWDB',
  'GS10', 'CPIAUCSL', 'UNRATE', 'FEDFUNDS',
  'NCBEILQ027S', 'SP500', 'CP',
]);

let tlsOptions = null;
try {
  tlsOptions = {
    key: fs.readFileSync(path.join(rootDir, "localhost+2-key.pem")),
    cert: fs.readFileSync(path.join(rootDir, "localhost+2.pem")),
  };
} catch {
  if (process.env.NODE_ENV !== "production") {
    console.warn("WARNING: TLS certificate not found — running over plain HTTP.\n  To enable HTTPS locally: mkcert localhost 127.0.0.1 ::1");
  }
}

// ── TTLs ──────────────────────────────────────────────────────────────────────

const ONE_HOUR_MS  = 60 * 60 * 1000;
const SIX_HOURS_MS = 6 * ONE_HOUR_MS;
const ONE_DAY_MS   = 24 * ONE_HOUR_MS;

const FRED_TTL_MS = {
  SP500:              ONE_HOUR_MS,
  GDPA:               ONE_DAY_MS,
  GDP:                ONE_DAY_MS,
  NCBEILQ027S:        ONE_DAY_MS,
  CP:                 ONE_DAY_MS,
  DDDM01USA156NWDB:   ONE_DAY_MS,
};

function fredTtl(seriesId) {
  return FRED_TTL_MS[seriesId] ?? SIX_HOURS_MS;
}

// ── In-memory cache ───────────────────────────────────────────────────────────
// Each entry: { body: Buffer, statusCode: number, storedAt: number, ttlMs: number }

const CACHE_MAX_SIZE = 200;
const cache = new Map();

function cacheKey(seriesId, observationStart, frequency) {
  return `${seriesId}|${observationStart ?? ''}|${frequency ?? ''}`;
}

function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.storedAt > entry.ttlMs) {
    cache.delete(key);
    return null;
  }
  return entry;
}

// Fix 5: Cap the cache key space at CACHE_MAX_SIZE.
// Map preserves insertion order, so .keys().next().value is always the oldest entry.
function storeInCache(key, body, statusCode, ttlMs) {
  if (cache.size >= CACHE_MAX_SIZE && !cache.has(key)) {
    const oldestKey = cache.keys().next().value;
    cache.delete(oldestKey);
  }
  cache.set(key, { body, statusCode, storedAt: Date.now(), ttlMs });
}

// ── In-flight request coalescing ──────────────────────────────────────────────
// Fix 1: Prevents thundering-herd cache misses from triggering N upstream calls.
// Maps a cache key to the Promise of the in-progress upstream fetch.

const inFlight = new Map();

// ── Rate limiter ──────────────────────────────────────────────────────────────
// Sliding window via per-IP timestamps and a global counter.

const RATE_WINDOW_MS     = 60 * 1000; // 1 minute
const PER_IP_MAX         = 10;
const GLOBAL_MAX         = 80;

// Map<ip, number[]> — stores request timestamps per IP
const ipWindows = new Map();
// number[] — global request timestamps
const globalWindow = [];

function pruneWindow(timestamps) {
  const cutoff = Date.now() - RATE_WINDOW_MS;
  let i = 0;
  while (i < timestamps.length && timestamps[i] < cutoff) i++;
  timestamps.splice(0, i);
}

// Fix 4: Evict stale ipWindows entries every 5 minutes to prevent unbounded Map growth.
setInterval(() => {
  for (const [ip, timestamps] of ipWindows) {
    pruneWindow(timestamps);
    if (timestamps.length === 0) ipWindows.delete(ip);
  }
}, 5 * 60 * 1000).unref();

function checkRateLimit(ip) {
  const now = Date.now();

  // Prune and check global window
  pruneWindow(globalWindow);
  if (globalWindow.length >= GLOBAL_MAX) {
    return { allowed: false, retryAfter: Math.ceil(RATE_WINDOW_MS / 1000) };
  }

  // Prune and check per-IP window
  if (!ipWindows.has(ip)) ipWindows.set(ip, []);
  const ipTs = ipWindows.get(ip);
  pruneWindow(ipTs);
  if (ipTs.length >= PER_IP_MAX) {
    const oldestTs = ipTs[0];
    const retryAfter = Math.ceil((oldestTs + RATE_WINDOW_MS - now) / 1000);
    return { allowed: false, retryAfter: Math.max(1, retryAfter) };
  }

  // Record the request
  ipTs.push(now);
  globalWindow.push(now);
  return { allowed: true };
}

// ── Static file helpers ───────────────────────────────────────────────────────

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js":   "text/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif":  "image/gif",
  ".svg":  "image/svg+xml",
  ".ico":  "image/x-icon",
  ".txt":  "text/plain; charset=utf-8",
  ".woff": "font/woff",
  ".woff2":"font/woff2",
};

function resolveFile(requestPath) {
  const cleaned = decodeURIComponent(requestPath.split("?")[0]);
  const filePath = cleaned === "/" ? "/index.html" : cleaned;
  const absolutePath = path.normalize(path.join(rootDir, filePath));

  if (!absolutePath.startsWith(rootDir + path.sep) && absolutePath !== rootDir) {
    return null;
  }
  return absolutePath;
}

// ── Request handlers ──────────────────────────────────────────────────────────

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) return forwarded.split(",")[0].trim();
  return req.socket?.remoteAddress ?? "unknown";
}

function handleFredRequest(req, res, parsedUrl, securityHeaders) {
  if (req.method !== "GET") {
    res.writeHead(405, { Allow: "GET", "Content-Type": "text/plain", ...securityHeaders });
    res.end("Method Not Allowed");
    return;
  }

  const ip = getClientIp(req);
  const { allowed, retryAfter } = checkRateLimit(ip);
  if (!allowed) {
    res.writeHead(429, {
      "Content-Type": "text/plain",
      "Retry-After": String(retryAfter),
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

  const key = cacheKey(seriesId, observationStart, frequency);
  const cached = getCached(key);
  if (cached) {
    res.writeHead(cached.statusCode, {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
      ...securityHeaders,
    });
    res.end(cached.body);
    return;
  }

  const fredParams = new URLSearchParams();
  fredParams.set("series_id", seriesId);
  if (observationStart && /^\d{4}-\d{2}-\d{2}$/.test(observationStart)) {
    fredParams.set("observation_start", observationStart);
  }
  if (frequency && ['d', 'w', 'bw', 'm', 'q', 'sa', 'a'].includes(frequency)) {
    fredParams.set("frequency", frequency);
  }
  fredParams.set("file_type", "json");
  fredParams.set("api_key", FRED_API_KEY);

  const fredUrl = `https://api.stlouisfed.org/fred/series/observations?${fredParams.toString()}`;

  // Fix 1: Coalesce concurrent cache misses for the same key into one upstream call.
  if (inFlight.has(key)) {
    inFlight.get(key).then(({ body, statusCode }) => {
      res.writeHead(statusCode, {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
        ...securityHeaders,
      });
      res.end(body);
    }).catch(() => {
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "text/plain", ...securityHeaders });
        res.end("Upstream error");
      }
    });
    return;
  }

  const fetchPromise = new Promise((resolve, reject) => {
    const fredReq = https.get(fredUrl, (fredRes) => {
      const chunks = [];
      fredRes.on("data", (chunk) => chunks.push(chunk));
      fredRes.on("end", () => {
        const body = Buffer.concat(chunks);
        storeInCache(key, body, fredRes.statusCode, fredTtl(seriesId));
        resolve({ body, statusCode: fredRes.statusCode });
      });
    });

    fredReq.setTimeout(8000, () => {
      fredReq.destroy();
      reject(new Error("Gateway Timeout"));
    });

    fredReq.on("error", (err) => {
      if (err.code !== "ECONNRESET") console.error("FRED proxy error:", err);
      reject(err);
    });
  });

  inFlight.set(key, fetchPromise);
  fetchPromise.finally(() => inFlight.delete(key));

  fetchPromise.then(({ body, statusCode }) => {
    res.writeHead(statusCode, {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
      ...securityHeaders,
    });
    res.end(body);
  }).catch((err) => {
    if (!res.headersSent) {
      const isTimeout = err.message === "Gateway Timeout";
      res.writeHead(isTimeout ? 504 : 502, { "Content-Type": "text/plain", ...securityHeaders });
      res.end(isTimeout ? "Gateway Timeout" : "Upstream error");
    }
  });
}

const SHILLER_URL = "https://posix4e.github.io/shiller_wrapper_data/data/stock_market_data.json";
const SHILLER_CACHE_KEY = "shiller";

function handleShillerRequest(req, res, securityHeaders) {
  if (req.method !== "GET") {
    res.writeHead(405, { Allow: "GET", "Content-Type": "text/plain", ...securityHeaders });
    res.end("Method Not Allowed");
    return;
  }

  const cached = getCached(SHILLER_CACHE_KEY);
  if (cached) {
    res.writeHead(cached.statusCode, {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
      ...securityHeaders,
    });
    res.end(cached.body);
    return;
  }

  // Fix 1: Coalesce concurrent cache misses into one upstream call.
  if (inFlight.has(SHILLER_CACHE_KEY)) {
    inFlight.get(SHILLER_CACHE_KEY).then(({ body, statusCode }) => {
      res.writeHead(statusCode, {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
        ...securityHeaders,
      });
      res.end(body);
    }).catch(() => {
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "text/plain", ...securityHeaders });
        res.end("Upstream error");
      }
    });
    return;
  }

  const fetchPromise = new Promise((resolve, reject) => {
    // Fix 2: Apply the same 8-second timeout pattern used for FRED.
    const shillerReq = https.get(SHILLER_URL, (upstream) => {
      const chunks = [];
      upstream.on("data", (chunk) => chunks.push(chunk));
      upstream.on("end", () => {
        const body = Buffer.concat(chunks);
        storeInCache(SHILLER_CACHE_KEY, body, upstream.statusCode, ONE_DAY_MS);
        resolve({ body, statusCode: upstream.statusCode });
      });
    });

    shillerReq.setTimeout(8000, () => {
      shillerReq.destroy();
      reject(new Error("Gateway Timeout"));
    });

    shillerReq.on("error", (err) => {
      if (err.code !== "ECONNRESET") console.error("Shiller proxy error:", err);
      reject(err);
    });
  });

  inFlight.set(SHILLER_CACHE_KEY, fetchPromise);
  fetchPromise.finally(() => inFlight.delete(SHILLER_CACHE_KEY));

  fetchPromise.then(({ body, statusCode }) => {
    res.writeHead(statusCode, {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
      ...securityHeaders,
    });
    res.end(body);
  }).catch((err) => {
    if (!res.headersSent) {
      const isTimeout = err.message === "Gateway Timeout";
      res.writeHead(isTimeout ? 504 : 502, { "Content-Type": "text/plain", ...securityHeaders });
      res.end(isTimeout ? "Gateway Timeout" : "Upstream error");
    }
  });
}

function staticCacheHeaders(isHtml) {
  // Fix 7: index.html must always revalidate; other assets are content-addressed and immutable.
  if (isHtml) return { "Cache-Control": "no-cache" };
  return { "Cache-Control": "public, max-age=31536000, immutable" };
}

function handleStaticFile(req, res, securityHeaders) {
  const targetPath = resolveFile(req.url || "/");
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

    const ext = path.extname(targetPath).toLowerCase();
    const contentType = contentTypes[ext] || "application/octet-stream";
    const isHtml = ext === ".html";

    // Fix 7: Derive a lightweight ETag from the file's last-modified time.
    const etag = `"${stats.mtime.getTime().toString(16)}"`;
    const ifNoneMatch = req.headers["if-none-match"];
    if (ifNoneMatch === etag) {
      res.writeHead(304, { ETag: etag, ...staticCacheHeaders(isHtml), ...securityHeaders });
      res.end();
      return;
    }

    const stream = fs.createReadStream(targetPath);

    // Fix 3: Handle stream errors before piping to avoid unhandled error events.
    stream.on("error", (streamErr) => {
      console.error("Static file stream error:", streamErr);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8", ...securityHeaders });
        res.end("Internal Server Error");
      }
    });

    res.writeHead(200, {
      "Content-Type": contentType,
      ETag: etag,
      ...staticCacheHeaders(isHtml),
      ...securityHeaders,
    });
    stream.pipe(res);
  });
}

// ── Server ────────────────────────────────────────────────────────────────────

const requestHandler = (req, res) => {
  const parsedUrl = new URL(req.url || "/", `https://localhost:${port}`);
  // Fix 8: Skip per-request logging in production to avoid log noise and I/O overhead.
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

  if (parsedUrl.pathname === "/api/fred") {
    handleFredRequest(req, res, parsedUrl, securityHeaders);
    return;
  }

  if (parsedUrl.pathname === "/api/shiller") {
    handleShillerRequest(req, res, securityHeaders);
    return;
  }

  handleStaticFile(req, res, securityHeaders);
};

const server = tlsOptions
  ? https.createServer(tlsOptions, requestHandler)
  : http.createServer(requestHandler);

server.on("error", (err) => { console.error("Server error:", err); });

const protocol = tlsOptions ? "https" : "http";
server.listen(port, () => {
  console.log(`BuffettIndex server running at ${protocol}://localhost:${port}`);
});
