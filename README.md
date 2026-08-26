# Pulse Brand Monitor

Real-time social media monitoring and alerting for **CEBU RITEHOMES DEVELOPMENT &
REALTY CORP.** and **ROVEN TECHNIC CONSTRUCTION** across Facebook, YouTube,
TikTok and Instagram.

Polls each platform on its own schedule, matches brand names and aliases, scores
sentiment, detects negative-mention spikes, and pushes alerts to the browser,
Slack/Discord/Teams and email — with a live dashboard for triage and export.

**Zero runtime dependencies.** Node 18.17+ and nothing else: no `npm install`,
no build step, no database.

```bash
node server.js --mock      # runs immediately with synthetic data
```

Then open <http://127.0.0.1:3000>.

---

## Table of contents

- [Quick start](#quick-start)
- [What it monitors](#what-it-monitors)
- [Monitoring frequency](#monitoring-frequency)
- [Sentiment analysis](#sentiment-analysis)
- [Crisis detection](#crisis-detection)
- [Notifications](#notifications)
- [Dashboard](#dashboard)
- [Configuration](#configuration)
- [Platform setup](#platform-setup)
- [Architecture](#architecture)
- [HTTP API](#http-api)
- [Deployment](#deployment)
- [Infrastructure files](#infrastructure-files)
- [Tests](#tests)
- [Known limitations](#known-limitations)

---

## Quick start

### 1. Demo mode (no credentials)

```bash
node server.js --mock
```

Mock mode generates realistic Cebu property/construction chatter in English,
Tagalog and Bisaya, running it through the same pipeline as live data. Every
mention is tagged `demo` in the feed and links to `example.invalid`, so
synthetic data can never be mistaken for real.

Use **Simulate crisis spike** on the demo banner to fire the full crisis path.

### 2. Live mode

```bash
cp .env.example .env      # then fill in the keys you have
node server.js
```

Any platform without credentials is skipped and says so in the dashboard's
**Platform status** panel — it never silently returns nothing. With no
credentials at all, `mockMode: "auto"` falls back to synthetic data rather than
showing an empty screen.

### Commands

| Command | What it does |
| --- | --- |
| `npm start` | Start the dashboard and poll continuously |
| `npm run demo` | Same, forcing synthetic data |
| `npm run once` | Poll every platform once, print a summary, exit (for cron) |
| `npm test` | Run the test suite |
| `node server.js --help` | All flags |

Flags: `--mock`, `--once`, `--no-server`, `--port <n>`, `--host <addr>`,
`--frequency <spec>`, `--config <path>`, `--log-level debug|info|warn|error`.

CLI flags are **session-only** — they never get written into `config.json`, even
when something else persists a change during the run.

---

## What it monitors

| Platform | Covered | How |
| --- | --- | --- |
| **Facebook** | Page posts, comments, tagged posts, group posts, attachment/video descriptions | Graph API on Pages you hold a token for |
| **YouTube** | Video titles, descriptions, top comments | Data API v3 `search.list` + `commentThreads.list` |
| **TikTok** | Video captions, hashtags, top comments | Research API, Apify or RapidAPI |
| **Instagram** | Post and Reel captions, hashtag media, tagged mentions, comments | Graph API hashtag search + `/tags` |

Two coverage limits are structural, not oversights — see
[Known limitations](#known-limitations) for the full picture:

- **Facebook has no public post search.** The endpoint was removed in Graph API
  v2.0 (2015). No token searches "all of Facebook". You get the Pages and groups
  you have access to, plus anything an aggregator can reach.
- **YouTube transcripts need OAuth.** `captions.download` requires a token from
  the channel that uploaded the video, so an API key cannot read third-party
  transcripts. Titles, descriptions and comments are fully covered.

### Matching

Every company name, alias, hashtag and handle is compiled into a tolerant,
boundary-anchored pattern:

| Configured | Also matches | Does not match |
| --- | --- | --- |
| `CEBU RITEHOMES DEVELOPMENT & REALTY CORP.` | `...DEVELOPMENT and REALTY CORP` (no period, "and" for "&") | — |
| `Cebu Rite Homes` | `Cebu Rite-Homes`, `Cebu.Rite.Homes` | — |
| `Ritehomes` | `ritehomes`, `RITEHOMES` | `Ritehomesomething` |
| `#Ritehomes` | `#ritehomes` | `ritehomes` (bare) |

The longest term wins, so a full-name hit is not double-counted as an alias hit.
Per-company `exclude` terms suppress that brand only — `"ritehomes fan page"`
drops Ritehomes while still recording a Roven Technic mention in the same post.

The server returns exact character ranges for each match, and the dashboard
highlights those — the browser never re-implements matching.

---

## Monitoring frequency

Set globally, per platform, or changed live from the dashboard header.

| Form | Examples |
| --- | --- |
| Preset | `realtime` (30s), `1m`, `5m`, `15m`, `1h`, `12h` |
| Duration | `45s`, `90s`, `30m`, `2h`, `1d` |
| Bare seconds | `90`, `600` |
| Cron (5-field) | `cron:*/10 * * * *`, `cron:0 9 * * MON-FRI` |

Minimum interval is **10 seconds**. Anything faster burns API quota without
producing fresher data.

Per-platform overrides matter because the platforms do not tolerate one cadence:

```json
"monitoring": {
  "frequency": "5m",
  "perPlatform": { "youtube": "15m", "tiktok": "1h" }
}
```

> **YouTube quota.** `search.list` costs 100 units per call against a default
> 10,000/day quota. Polling one term every 5 minutes is 28,800 units/day — over
> quota. Use 15 minutes or slower when tracking several terms.

Each platform is timed independently with chained timeouts, so a slow poll never
stacks up behind itself, and `since` is computed from the last *successful* poll
so a failure cannot silently skip a window. Repeated failures back off
exponentially, up to 8x.

---

## Sentiment analysis

Lexicon-based, deliberately explainable: every mention carries the terms that
produced its score, visible on hover in the dashboard and included in exports.

Tuned for this data set in three ways a generic English word list gets wrong:

1. **Trilingual.** Comments mix English, Tagalog and Bisaya
   (`nindot kaayo`, `walang update`, `hindi pa tapos`).
2. **Industry phrases.** `delayed turnover`, `no permit`, `poor workmanship`,
   `structural issues` carry the real signal; the individual words often do not.
3. **Bisaya word order.** Intensifiers follow the adjective (`nindot kaayo`), so
   both sides of a match are checked.

Negation is handled with sentence barriers, so a negator cannot leak into the
next sentence:

| Text | Result |
| --- | --- |
| `This is not good` | negative |
| `The unit is not bad` | positive |
| `Do not recommend. Demand refund now.` | negative — "not" does **not** flip "demand refund" |

Output per mention: `sentiment` (`positive`/`neutral`/`negative`), a saturated
display `sentimentScore` in −1…1, the raw weighted sum, and the matched terms.

Thresholds and extra vocabulary are configurable:

```json
"sentiment": {
  "positiveThreshold": 1,
  "negativeThreshold": -1,
  "extraNegative": ["brownout", { "term": "no water", "weight": -3 }],
  "extraPositive": ["turnover complete"]
}
```

---

## Crisis detection

Two independent rules over a sliding window, because either alone misses real
incidents:

- **Absolute** — negatives in the window reach `negativeThreshold`. Catches a
  cold-start pile-on.
- **Relative** — negatives run at `baselineMultiplier` times the recent baseline
  (mean of the previous 8 windows). Catches a spike on an account that always
  carries background complaints, where the absolute threshold is met every
  window and would never look unusual.

```json
"crisis": {
  "windowMinutes": 15,
  "negativeThreshold": 5,
  "baselineMultiplier": 3,
  "cooldownMinutes": 30
}
```

Severity scales with volume: `elevated` at the threshold, `high` at 2x,
`critical` at 3x.

A cooldown stops one incident paging the on-call every poll — but an
**escalation** (50%+ more negatives than when it last fired) breaks through,
because going quiet while a crisis grows is worse than a duplicate alert.
**Acknowledge** on the dashboard banner clears the cooldown.

---

## Notifications

| Channel | Delivery | Notes |
| --- | --- | --- |
| Browser desktop | Web Notifications via service worker, pushed over SSE | Needs permission; crises use `requireInteraction` |
| Audio | WebAudio tones | Rising chime for positive, falling for negative, 3-pulse alarm for crisis |
| Slack | Incoming webhook | Coloured attachment with sentiment, brand, matched terms |
| Discord | Webhook | Rich embed |
| Teams | Incoming webhook | MessageCard with an "Open post" action |
| Generic | Webhook | Plain JSON envelope, for Zapier/n8n/custom |
| Email | SMTP | HTML alert; implicit TLS (465) or STARTTLS (587), AUTH PLAIN/LOGIN |

Each channel subscribes to the events it wants, so ops Slack can take every
negative while marketing Discord takes crises only:

```json
"webhooks": [
  { "name": "Ops Slack", "type": "slack", "url": "env:SLACK_WEBHOOK_URL",
    "enabled": true, "events": ["mention.negative", "crisis"] }
]
```

Events: `mention.any`, `mention.positive`, `mention.neutral`,
`mention.negative`, `crisis`.

Three protections that matter more than the delivery code:

- **Rate limiting** — a shared token bucket (`rateLimit.maxPerMinute`). Without
  it a 40-comment pile-on posts 40 Slack messages and a human mutes the channel,
  which is exactly when alerting stops working. **Crises bypass the limit.**
- **Isolation** — channels dispatch concurrently and independently, so a dead
  webhook never blocks the email that would have woken someone up.
- **De-duplication before notifying** — a post re-appearing in the next poll
  cannot alert twice.

Webhook and email delivery run **server-side** on purpose: Slack's endpoint
sends no CORS headers so a browser POST is blocked outright, and a webhook URL
is a credential that should never be shipped to a visitor. Use **Test mention
alert** / **Test crisis alert** in the sidebar to prove the plumbing before an
incident.

---

## Dashboard

- **Live mention stream** over SSE — new mentions appear without polling the UI,
  with matched terms highlighted and the sentiment scoring visible on hover.
- **Filters** by brand, platform, sentiment and full-text search. Filters apply
  server-side, so they cover all stored history, not just the loaded page.
- **Analytics** — sentiment donut, platform share, and a volume chart built from
  **real clock-aligned time buckets** (selectable 2h / 6h / 24h / 3d range).
- **Crisis banner** with severity, affected brands, jump-to-negatives and
  acknowledge.
- **Platform status** — per platform: live API / aggregator / synthetic / not
  configured, its frequency, last successful poll, mentions stored, and the last
  error if any.
- **Alert channel status** — which channels are ready and, when not, exactly
  what is missing.
- **Export** to CSV or JSON, honouring the active filters. CSV is Excel-safe:
  BOM, CRLF, formula-injection guarded — while leaving numeric scores numeric.
- **Live controls** — frequency, pause/resume, poll now, crisis thresholds,
  sentiment thresholds, brand/alias editing, channel toggles.

Config changes apply live where they can. Changing `enabledPlatforms` or
`mockMode` needs a restart, and the dashboard says so rather than pretending.

---

## Configuration

Everything non-secret lives in `config.json`; secrets live in `.env` and are
referenced as `env:VAR_NAME`.

The two are kept apart deliberately. The config store holds the raw file with
placeholders intact and resolves them only in memory, so **saving `config.json`
can never bake a credential into a file you might commit**. The dashboard is
served a redacted copy, and channel toggles go through a dedicated endpoint that
rebuilds the patch from raw config — a masked URL can never be round-tripped
back over a real placeholder.

```json
{
  "companies": [
    {
      "id": "cebu-ritehomes",
      "name": "CEBU RITEHOMES DEVELOPMENT & REALTY CORP.",
      "aliases": ["CEBU RITEHOMES", "Cebu Rite Homes", "Ritehomes Realty", "Ritehomes"],
      "hashtags": ["#Ritehomes", "#CebuRitehomes"],
      "handles": ["@ritehomes"],
      "exclude": []
    }
  ],
  "monitoring": {
    "frequency": "5m",
    "perPlatform": { "youtube": "15m" },
    "enabledPlatforms": ["facebook", "youtube", "tiktok", "instagram"],
    "lookbackMinutes": 120,
    "maxItemsPerPoll": 50,
    "mockMode": "auto",
    "startPaused": false
  },
  "storage": { "dataDir": "./data", "maxMentions": 20000, "retentionDays": 90 },
  "server": { "host": "127.0.0.1", "port": 3000 }
}
```

`mockMode`: `auto` (real where credentials exist, synthetic if none do) ·
`on` (always synthetic) · `off` (never synthetic; unconfigured platforms are
skipped).

Invalid config is rejected with a specific message. A live update that fails
validation **rolls back**, so a bad API call cannot break a running monitor.
Missing secrets are warnings, not errors — the app still starts and tells you
what is unconfigured.

---

## Platform setup

### YouTube — easiest, start here

1. [Google Cloud Console](https://console.cloud.google.com) → new project.
2. Enable **YouTube Data API v3**.
3. Credentials → Create credentials → API key.
4. `YOUTUBE_API_KEY=...` in `.env`.

### Facebook / Instagram (Meta Graph API)

1. [developers.facebook.com](https://developers.facebook.com) → create a
   Business app.
2. Add **Facebook Login** and **Instagram Graph API**.
3. Permissions: `pages_read_engagement`, `pages_read_user_content`,
   `instagram_basic`, `instagram_manage_comments`.
4. Generate a Page access token and exchange it for a long-lived one.
5. Fill in `FB_ACCESS_TOKEN`, `IG_ACCESS_TOKEN`, `IG_BUSINESS_ACCOUNT_ID`, and
   list your Page IDs under `platforms.facebook.pageIds`.

> Instagram allows **30 unique hashtag queries per rolling 7 days** per user. A
> typo in `hashtags` burns a slot for a week.
>
> Instagram withholds third-party usernames on hashtag media, so those mentions
> are attributed to the hashtag with a link to the post rather than an invented
> author name.

### TikTok — pick a provider

TikTok has no general public keyword-search API, so `platforms.tiktok.provider`
must be one of:

| Provider | Credential | Trade-off |
| --- | --- | --- |
| `tiktok-research` | `TIKTOK_RESEARCH_TOKEN` | First-party and accurate, but access requires an approved application, mostly granted to academic/non-profit researchers |
| `apify` | `APIFY_TOKEN` | No approval needed, costs per run, depends on the actor tracking TikTok's markup |
| `rapidapi` | `RAPIDAPI_KEY` | Cheapest to start, least stable — hosts and response shapes change often |

Comments are supported on `rapidapi` and `tiktok-research`. Apify needs a
separate comments actor; the connector logs that rather than silently skipping.

### Aggregator (optional) — filling the gaps

For public Facebook search, YouTube transcripts, or TikTok without Research API
access, point `platforms.aggregator` at any Apify actor or RapidAPI endpoint.
Field mapping is configuration, not code, so no vendor's response shape is
hard-coded:

```json
"aggregator": {
  "enabled": true,
  "provider": "apify",
  "apifyToken": "env:APIFY_TOKEN",
  "actors": {
    "facebook": {
      "actor": "apify~facebook-posts-scraper",
      "termsField": "searchQueries",
      "map": { "id": "postId", "text": "text", "url": "url",
               "timestamp": "time", "authorName": "user.name" }
    }
  }
}
```

Anything `map` omits falls back to common field names, so a well-behaved actor
often needs no map at all. When a native connector is unconfigured and an
aggregator actor exists for that platform, the aggregator takes over
automatically.

> Scraping may conflict with a platform's terms of service. That is your call to
> make for your jurisdiction and use case.

---

## Architecture

```text
                      ┌──────────────┐
   config.json ──────►│ ConfigStore  │  raw (env: placeholders) + resolved
   .env       ──────► │              │  validate · rollback · redact
                      └──────┬───────┘
                             │
        ┌────────────────────┼─────────────────────┐
        ▼                    ▼                     ▼
  ┌───────────┐      ┌──────────────┐      ┌──────────────┐
  │ Matcher   │      │  Connectors  │      │  Scheduler   │
  │ Sentiment │      │  fb yt tt ig │◄─────│ per-platform │
  └─────┬─────┘      │  aggregator  │      │ interval/cron│
        │            │  mock        │      │ backoff      │
        │            └──────┬───────┘      └──────────────┘
        │                   │ raw items
        │                   ▼
        │            ┌──────────────────────────────────┐
        └───────────►│            Pipeline              │
                     │ normalise → match → sentiment →  │
                     │ de-dup → store → notify → crisis │
                     └───┬──────────┬─────────────┬─────┘
                         ▼          ▼             ▼
                  ┌──────────┐ ┌─────────┐ ┌────────────┐
                  │  Store   │ │ Crisis  │ │ Dispatcher │
                  │ JSONL +  │ │ sliding │ │ route ·    │
                  │ memory   │ │ window  │ │ rate-limit │
                  └────┬─────┘ └────┬────┘ └──────┬─────┘
                       │            │             │
                       ▼            ▼             ▼
                  ┌──────────────────────────────────────┐
                  │  HTTP API  +  SSE  ──►  Dashboard    │
                  └──────────────────────────────────────┘
                                                  │
                              webhooks · email · desktop push
```

```text
server.js               entry point, wiring, live rebuild, shutdown
config.json  .env       configuration and secrets
src/
  config.js             load, validate, resolve env:, redact, session overrides
  log.js                levelled logger with a ring buffer the API can read
  core/
    matcher.js          alias/hashtag matching, highlight ranges
    sentiment.js        trilingual lexicon scoring with negation barriers
    crisis.js           sliding-window spike detection
    store.js            JSONL-backed store, queries, real time buckets
    pipeline.js         one ingestion path for every platform
    scheduler.js        per-platform timing, cron, failure backoff
  platforms/
    base.js             connector contract and shared helpers
    facebook.js  youtube.js  tiktok.js  instagram.js
    aggregator.js       generic Apify/RapidAPI with configurable mapping
    mock.js             synthetic data for demos and tests
    index.js            registry: native / aggregator / mock / skipped
  notify/
    index.js            routing, rate limiting, isolation
    webhook.js          Slack, Discord, Teams, generic formatters
    email.js  smtp.js   HTML alerts over a hand-rolled SMTP client
  server/
    http.js  api.js  sse.js
index.html  css/  js/   dashboard (vanilla ES modules, no build step)
sw.js                   service worker, notifications only
tests/                  169 tests, zero-dependency runner
data/                   runtime JSONL (gitignored)
```

**Why JSONL and not a database?** The working set is tens of thousands of rows.
Reads are served from an in-memory index; every accepted mention is appended to
disk, so a restart resumes with full history *and* de-duplication intact. No
native module to compile, no schema to migrate.

**Why SSE and not WebSocket?** The dashboard only needs server-to-client push.
SSE gives that over plain HTTP with automatic browser reconnection and
`Last-Event-ID` replay, with no dependency.

---

## HTTP API

Set `MONITOR_TOKEN` to require `X-Monitor-Token` (or `?token=`) on `/api/*`.
The dashboard picks the token out of the URL on first load, moves it to
`sessionStorage`, and strips it from the address bar.

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Liveness, version, uptime |
| `GET` | `/api/status` | Scheduler, crisis window, platform modes, channel readiness |
| `GET` | `/api/mentions` | Filtered, paginated mentions |
| `GET` | `/api/stats` | Sentiment / platform / company breakdown |
| `GET` | `/api/timeline` | Clock-aligned volume buckets |
| `GET` | `/api/alerts` | Recent crisis and delivery records |
| `GET` | `/api/logs` | Recent server log lines |
| `GET` | `/api/config` | Redacted configuration |
| `GET` | `/api/export` | `format=csv\|json` download, honours filters |
| `GET` | `/api/events` | SSE stream |
| `POST` | `/api/control/pause` · `/resume` · `/poll` | Scheduler control |
| `POST` | `/api/control/frequency` | Change frequency (`platform`, `persist` optional) |
| `PATCH` | `/api/config` | Live config patch, validated and rolled back on error |
| `POST` | `/api/channels/toggle` | Enable/disable one channel safely |
| `POST` | `/api/notify/test` | Send a test alert to every channel |
| `POST` | `/api/crisis/acknowledge` | Clear the crisis cooldown |
| `POST` | `/api/simulate/crisis` | Queue synthetic negatives (mock mode only) |
| `DELETE` | `/api/mentions` | Clear stored mentions (alerts are kept) |

Filters accepted by `mentions`, `stats` and `export`: `platform`, `company`,
`sentiment`, `search`, `since`, `until`, `limit`, `offset`, `order`. Platform,
company and sentiment accept comma-separated lists.

SSE events: `hello`, `mention`, `crisis`, `desktop`, `notification`, `ingest`,
`scheduler`, `poll-error`, `cleared`.

```bash
curl localhost:3000/api/status
curl "localhost:3000/api/mentions?sentiment=negative&platform=TikTok&limit=20"
curl -X POST -H 'content-type: application/json' \
     -d '{"frequency":"cron:*/10 * * * *","persist":true}' \
     localhost:3000/api/control/frequency
```

---

## Deployment

### Long-running service

```bash
MONITOR_TOKEN=$(openssl rand -hex 16) HOST=0.0.0.0 node server.js
```

Put it behind a reverse proxy with TLS. Service workers and the Notification API
need a secure context — `https`, or `http` on `localhost`.

For nginx, disable proxy buffering on the SSE endpoint (the server already sends
`X-Accel-Buffering: no`):

```nginx
location /api/events {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Connection '';
    proxy_buffering off;
    proxy_read_timeout 24h;
}
```

### Live droplet (already provisioned)

Running at **<http://188.166.220.167:8080/>** — token-gated, so the bare URL
shows nothing. Open `http://188.166.220.167:8080/?token=<TOKEN>` once; nginx
exchanges the token for a cookie, after which the plain URL works in that
browser. The token is the `MONITOR_TOKEN` GitHub Actions secret.

> This is plain HTTP on a bare IP. Let's Encrypt cannot issue a certificate for
> an IP address, so the token travels unencrypted. Point a domain at the droplet
> and `infra/nginx.conf` can move to 443 with a real certificate.

The box is **shared with matchpoint-academy**, so everything is namespaced:

| | matchpoint-academy | social-media-monitor |
| --- | --- | --- |
| App root | `/opt/matchpoint-academy` | `/opt/social-media-monitor` |
| Service user | `matchpoint` | `smmonitor` |
| Node port | `3000` | `3100` (loopback only) |
| Public port | `80` / `443` (nginx `default_server`) | `8080` |
| nginx config | `sites-available/matchpoint` | `sites-available/social-media-monitor` |
| systemd unit | `matchpoint.service` | `social-media-monitor.service` |

The separate nginx file is not cosmetic: matchpoint's own CI rewrites
`sites-available/matchpoint` on every one of its deploys, so anything for this
app placed there would be silently deleted the next time the tennis site
shipped.

`nginx` terminates the access gate and injects `X-Monitor-Token` upstream, which
is the same header the app checks — so the edge gate covers browsers and the app
gate still holds if anything reaches port 3100 directly.

### CI/CD

`.github/workflows/deploy.yml` runs on every push to `main`: syntax-checks every
module and runs the test suite, then rsyncs to the droplet, writes `.env` from
secrets, installs the systemd unit and nginx config, and smoke-tests the result
— including that the token gate actually refuses an anonymous request.

The nginx config is staged as `.new` and rolled back if `nginx -t` fails, so a
bad config can never take down matchpoint alongside it. Provisioning
(`infra/bootstrap.sh`) is idempotent and version-controlled, so a rebuilt
droplet needs no remembered manual steps.

Secrets are set with `gh secret set <NAME>`. Only `DEPLOY_SSH_KEY` and
`MONITOR_TOKEN` are required — the deploy fails closed if the token is empty.
Every platform credential is optional, and with none set the deploy still
succeeds and the dashboard runs on synthetic data, which is the intended way to
demo it.

### Operating it

```bash
ssh root@188.166.220.167
systemctl status social-media-monitor
journalctl -u social-media-monitor -f
```

### Cron-driven (no long-running process)

```cron
*/15 * * * * cd /opt/social-media-monitor && /usr/bin/node server.js --once >> monitor.log 2>&1
```

`--once` polls every configured platform, stores and alerts, then exits. State
and de-duplication persist in `data/`, so runs pick up where the last left off.

---

## Infrastructure files

| File | Purpose |
| --- | --- |
| `infra/bootstrap.sh` | Idempotent droplet provisioning |
| `infra/social-media-monitor.service` | systemd unit (`ExecStart=node server.js`, loopback, `.env`) |
| `infra/nginx.conf` | Public listener on 8080, token gate, SSE-safe `/api` proxy |
| `.github/workflows/deploy.yml` | Test, rsync, install, smoke-test on push to `main` |

`infra/nginx.conf` also blocks `/.env`, `/config.json`, `/src/`, `/infra/`,
`/tests/` and `/data/` at the edge — matching the server's own static allowlist,
so neither layer alone is load-bearing.

---

## Tests

```bash
npm test                    # all 169
node tests/run.js analysis  # one file
LOG_LEVEL=debug npm test    # with application logs
```

Covers matching tolerance and boundaries, sentiment negation and barriers,
multilingual scoring, store persistence and de-duplication, real time bucketing,
crisis rules/cooldown/escalation, config redaction and rollback, CLI-override
isolation, CSV escaping, cron and frequency parsing, notification routing and
rate limiting, webhook payload shapes for all four providers, SMTP message
construction, connector normalisation, API routes, scheduler timing, and SSE
replay.

---

## Known limitations

Stated plainly, because each one changes what the numbers mean:

1. **Facebook coverage is bounded by access.** No public post search exists.
   Without an aggregator you see the Pages and groups you hold a token for, so
   the Facebook figures are not a measure of all Facebook chatter.
2. **YouTube transcripts are not fetched.** `captions.download` needs OAuth from
   the uploading channel. Titles, descriptions and comments are covered.
3. **Facebook video captions** have the same ownership constraint — readable only
   for videos on a Page you control. Post text and comments are read regardless.
4. **TikTok always goes through a provider**, each with its own accuracy and
   stability trade-off. Apify comments need a separate actor.
5. **Instagram hashtag queries are capped** at 30 unique tags per 7 days, and
   third-party usernames are withheld by Meta.
6. **Sentiment is lexicon-based**, not a model. It is fast, free, offline and
   explainable, and it will miss sarcasm and unusual phrasing. Every score ships
   with the terms behind it so you can audit and extend the lexicon.
7. **Desktop notifications need the dashboard open** in a browser that has been
   granted permission. Webhooks and email are the channels that reach you when
   it is closed.
8. **No authentication beyond a shared token.** `MONITOR_TOKEN` is a bearer
   secret, not user accounts. Do not expose the dashboard publicly without a
   proxy that adds real auth.
9. **`--once` mode cannot detect a spike faster than its cron interval**, since
   the sliding window is only evaluated while the process is alive.

---

## License

MIT
