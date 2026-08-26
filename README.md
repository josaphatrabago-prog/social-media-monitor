# Social Media Monitor

Real-time brand mention monitoring and alerting for **CEBU RITEHOMES DEVELOPMENT
& REALTY CORP.** and **ROVEN TECHNIC CONSTRUCTION** across Facebook, YouTube,
TikTok and Instagram.

Node backend polls the platform APIs on a configurable schedule, scores each
mention for sentiment (English, Tagalog and Cebuano), detects negative-mention
spikes, and pushes alerts to Slack / Discord / Teams / email. A browser
dashboard shows the live feed, analytics and CSV/JSON export.

## Running locally

```bash
npm start          # normal run
npm run demo       # synthetic mentions, no API keys needed
npm run once       # a single poll cycle, then exit
```

Copy `.env.example` to `.env` and fill in whichever platform credentials you
have. Every key is optional — a platform with no credentials is skipped, or
served from the mock generator when mock mode is on. Non-secret settings
(companies, aliases, poll frequency, thresholds, webhooks) live in
`config.json`, which references secrets as `env:VAR_NAME`.

## Deployment

Live at **http://188.166.220.167:8080/** — access is token-gated, so the URL
alone shows nothing. Open it as `http://188.166.220.167:8080/?token=<TOKEN>`
once and the token is exchanged for a cookie; after that the bare URL works in
that browser. The token is the `MONITOR_TOKEN` GitHub Actions secret.

> This is plain HTTP on a bare IP. Let's Encrypt cannot issue a certificate for
> an IP address, so the token travels unencrypted. Point a domain at the droplet
> and the nginx config can be switched to 443 with a real certificate.

### The droplet

The box at `188.166.220.167` is **shared with matchpoint-academy**. Everything
here is namespaced so the two never collide:

| | matchpoint-academy | social-media-monitor |
|---|---|---|
| App root | `/opt/matchpoint-academy` | `/opt/social-media-monitor` |
| Service user | `matchpoint` | `smmonitor` |
| Node port | `3000` | `3100` (loopback only) |
| Public port | `80` / `443` (nginx `default_server`) | `8080` |
| nginx config | `sites-available/matchpoint` | `sites-available/social-media-monitor` |
| systemd unit | `matchpoint.service` | `social-media-monitor.service` |

**The separate nginx file is not cosmetic.** matchpoint's own CI rewrites
`sites-available/matchpoint` on every one of its deploys, so anything for this
app placed in that file would be silently deleted the next time the tennis site
shipped.

### CI/CD

`.github/workflows/deploy.yml` runs on every push to `main`: syntax-checks every
module and runs the test suite, then rsyncs to the droplet, writes `.env` from
secrets, installs the systemd unit and nginx config, and smoke-tests the result
— including that the token gate actually refuses an anonymous request.

The nginx config is staged as `.new` and rolled back if `nginx -t` fails, so a
bad config can never take down matchpoint alongside it.

Provisioning (`infra/bootstrap.sh`) is idempotent and version-controlled: a
rebuilt droplet needs no remembered manual steps.

### Secrets

Set with `gh secret set <NAME>`. Only the first two are required.

| Secret | Purpose |
|---|---|
| `DEPLOY_SSH_KEY` | Private half of the droplet deploy key |
| `MONITOR_TOKEN` | Dashboard access token; deploy fails closed if empty |
| `FB_ACCESS_TOKEN`, `IG_ACCESS_TOKEN`, `IG_BUSINESS_ACCOUNT_ID` | Meta Graph API |
| `YOUTUBE_API_KEY` | YouTube Data API v3 |
| `APIFY_TOKEN`, `RAPIDAPI_KEY`, `TIKTOK_RESEARCH_TOKEN` | TikTok (no public search API — pick a provider) |
| `SLACK_WEBHOOK_URL`, `DISCORD_WEBHOOK_URL`, `TEAMS_WEBHOOK_URL` | Alert channels |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, `ALERT_EMAIL_TO` | Email alerts |

With no platform credentials set the deploy still succeeds and the dashboard
runs on synthetic data, which is the intended way to demo it.

### Operating it

```bash
ssh root@188.166.220.167
systemctl status social-media-monitor
journalctl -u social-media-monitor -f
```
