# BuffettIndex SEO Strategy

**Last updated:** 2026-04-01
**Status:** Active

---

## Implemented (this session)

### Technical SEO — completed in code

| Fix | File | Impact |
|---|---|---|
| Title tag rewrite — now covers all four gauges | `index.html` | High |
| Meta description (160 chars, keyword-rich) | `index.html` | High |
| Meta keywords tag | `index.html` | Low (still useful for Bing) |
| Canonical URL tag | `index.html` | High |
| Open Graph tags (title, description, url, image, type, locale) | `index.html` | High — required for Twitter/LinkedIn/Facebook previews |
| Twitter Card tags (summary_large_image) | `index.html` | High |
| JSON-LD structured data: WebSite, WebApplication, FAQPage | `index.html` | High — FAQ schema can generate rich results in Google |
| Fixed heading hierarchy — indicator sections demoted from `<h1>` to `<h2>` | `index.html` | High |
| Semantic HTML landmarks — `<main>`, `<section>`, `<footer>`, `<nav>`, `aria-label` | `index.html` | Medium |
| `aria-hidden` on decorative elements (section numbers, dots, rule) | `index.html` | Medium |
| Anchor IDs on all four sections (`#buffett-indicator`, `#shiller-cape`, `#fed-model`, `#corporate-profits`) | `index.html` | Medium — enables deep linking and in-page nav |
| Footer with section nav links and data source attribution | `index.html` | Medium |
| `<noscript>` fallback with descriptive content | `index.html` | Low-Medium |
| `robots.txt` | `robots.txt` | Critical — was missing entirely |
| `sitemap.xml` | `sitemap.xml` | High |
| `favicon.svg` | `favicon.svg` | Medium — browser tab, brand recall |
| `site.webmanifest` (PWA manifest) | `site.webmanifest` | Medium — mobile SEO signal |
| `theme-color` meta tag | `index.html` | Low |
| `.webmanifest` and `.xml` MIME types in server | `server.js` | Required for manifest to work |
| Canonical host redirect (301) via `CANONICAL_HOST` env var | `server.js` | High — prevents duplicate content across www/non-www |
| `rel="noopener noreferrer"` on external footer links | `index.html` | Low |

---

## Remaining work — requires decisions or external setup

### Priority 1: Critical (do these first)

**1. Create the OG image (`/og-image.png`, 1200x630)**
The OG/Twitter tags reference `https://buffettindex.info/og-image.png`. Without it, social shares show a blank card, destroying click-through rates from Twitter, LinkedIn, and Reddit. This is the single highest-ROI remaining item.

Recommended design: dark `#06070D` background, "BuffettIndex" in large Cormorant typeface, amber accent, four gauge names listed, tagline "Live US Market Valuation". Export at 1200x630.

**2. Deploy `robots.txt` and `sitemap.xml` to production**
Both files now exist in the repo. Verify they are accessible at `https://buffettindex.info/robots.txt` and `https://buffettindex.info/sitemap.xml` after the next deploy. Then submit the sitemap URL in Google Search Console.

**3. Google Search Console setup**
- Verify ownership of `buffettindex.info`
- Submit sitemap
- Monitor for indexing errors and Core Web Vitals
- Watch for rich result eligibility (FAQ schema)

**4. Set `CANONICAL_HOST` environment variable in Railway**
The server now supports a 301 redirect from any non-canonical hostname. In the Railway dashboard, set `CANONICAL_HOST=buffettindex.info` (or whichever is the preferred canonical domain — no `www` prefix unless that's the preferred form). This prevents duplicate indexing if the site is accessible under multiple hostnames.

---

### Priority 2: High impact

**5. Create `apple-touch-icon.png` (180x180)**
Referenced in `<link rel="apple-touch-icon">`. Without it, iOS devices use a screenshot as the home screen icon. A proper 180x180 PNG with the amber "B" on dark background is needed.

**6. Create `favicon.ico`**
The SVG favicon works in modern browsers. For legacy browser coverage and compatibility with some SEO crawlers, also generate a multi-resolution `.ico` (16x16, 32x32, 48x48) from the SVG.

**7. Page speed audit — font loading optimization**
The page loads three Google Fonts families (Cormorant Garant, JetBrains Mono, DM Sans) on every request. Consider:
- Adding `<link rel="preload">` for the primary font (Cormorant Garant is used for the hero and section headings)
- Hosting fonts locally to eliminate the external DNS lookup and reduce render-blocking risk
- Setting `font-display: swap` (currently handled by Google's `display=swap` param — confirm it is present in the Google Fonts URL)

**8. Add `fetchpriority="high"` to Chart.js script**
Chart.js is the largest JS payload on the page. Marking it with `fetchpriority="high"` helps the browser prioritize it in the preload scanner.

**9. Structured data — add `dateModified` dynamically**
The JSON-LD WebSite schema would benefit from a `dateModified` property reflecting the last data update. This is dynamic (FRED data updates daily/quarterly), so it would need to be injected server-side. Consider a small server-side template replacement in `handleStaticFile` that substitutes a `{{LAST_MODIFIED}}` token in `index.html` at serve time.

---

### Priority 3: Content SEO (requires content creation)

**10. Target these high-value keyword clusters**

| Cluster | Monthly searches (est.) | Current page coverage |
|---|---|---|
| "buffett indicator 2025" / "buffett indicator 2026" | 2,000–5,000 | Partial — title doesn't include year |
| "shiller cape ratio 2025" | 1,000–3,000 | Good — section text covers it |
| "is the stock market overvalued" | 5,000–15,000 | Partial — FAQ schema helps |
| "market cap to gdp ratio" | 1,000–2,000 | Partial |
| "cyclically adjusted pe ratio" | 500–1,000 | Good |
| "stock market valuation dashboard" | 200–500 | Good — in meta description |
| "shiller cape ratio history" | 500–1,500 | Partial |
| "buffett indicator history" | 500–1,500 | Partial |

The single page covers all four indicators well. Consider adding a brief static text block below the hero (above the first chart) that names all four indicators with their full formal names — this gives Google more keyword density on the initial HTML payload without relying on JS-rendered content.

**11. Add a text-based "Current Readings" summary in static HTML**
Google can and does render JavaScript, but a static HTML summary visible in the page source (e.g., a brief paragraph with the indicator descriptions and historical ranges) improves guaranteed crawlability. The current descriptive blurbs in `section-blurb` paragraphs are excellent and already present in the static DOM — this is a significant advantage over competitors like Gurufocus.

**12. Build out inbound link targets**
Create linkable content formats:
- "Buffett Indicator Historical Chart" — a standalone deep-link URL (`/#buffett-indicator`) to share
- A regularly updated "Market Pulse" summary paragraph (manually updated, or auto-generated server-side) that gives journalists/bloggers a quick-stats snapshot they can cite and link to

---

### Priority 4: Off-page SEO

**13. Submit to finance data directories**
- Finviz, StockAnalysis, Macrotrends — most do not accept competitor submissions, but some aggregators do
- Product Hunt — "BuffettIndex" as a free finance tool

**14. Outreach targets for backlinks**
High-DR domains in the value investing / macro space likely to feature or link to BuffettIndex:
- SeekingAlpha (author submission or tool mention)
- The Irrelevant Investor (Michael Batnick)
- A Wealth of Common Sense (Ben Carlson)
- r/ValueInvesting wiki resources
- Collaborative Fund blog

**15. Social meta tag for current readings (dynamic OG)**
Advanced: serve dynamically generated OG images that include the current Buffett Indicator reading (e.g., "Buffett Indicator: 187% — Significantly Overvalued"). This requires a server-side image generation step (e.g., `@vercel/og` or a canvas-based approach). Very high CTR impact when shared on Twitter.

---

## SEO competitive landscape

| Competitor | Domain | Key gap vs. BuffettIndex |
|---|---|---|
| multpl.com | Shows Shiller CAPE only, one metric at a time | BuffettIndex shows all four on one page |
| gurufocus.com/buffett-indicator | Single indicator, login wall for history | BuffettIndex is free, no login, four indicators |
| longtermtrends.net | Multiple charts but sparse descriptions | BuffettIndex has richer explanatory text |
| FRED direct | Raw data only, no interpretation | BuffettIndex adds trend analysis, SD bands, context |

**Key differentiation to lead with in SEO content:** "four valuation gauges in one view, free, no login, live FRED data, with historical context."

---

## Measurement

Track these metrics monthly in Google Search Console and Cloudflare Analytics:

| Metric | Baseline | Target (90 days) |
|---|---|---|
| Indexed pages | 0 (not yet verified) | 1 |
| Organic impressions | 0 | 1,000+ |
| Organic clicks | 0 | 100+ |
| Average position for "buffett indicator" | Unranked | Top 20 |
| Average position for "shiller cape ratio" | Unranked | Top 30 |
| Core Web Vitals — LCP | TBD | < 2.5s |
| Core Web Vitals — CLS | TBD | < 0.1 |
