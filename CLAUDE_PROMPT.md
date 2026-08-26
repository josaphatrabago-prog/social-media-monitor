# Prompt for Claude: Social Media Brand Monitoring System

Copy and paste the prompt below into Claude:

```markdown
Role: You are an expert Full-Stack Software Engineer and Data Integration Specialist.

Objective: Design and implement a real-time Social Media Monitoring & Alerting System to track mentions for two specific companies across four major social platforms: Facebook, YouTube, TikTok, and Instagram.

---

### Target Companies & Keyword Aliases to Monitor:
1. **Company #1**: `CEBU RITEHOMES DEVELOPMENT & REALTY CORP.`
   - *Aliases & Variations*: `CEBU RITEHOMES`, `Cebu Rite Homes`, `Ritehomes Realty`, `Ritehomes`
2. **Company #2**: `ROVEN TECHNIC CONSTRUCTION`
   - *Aliases & Variations*: `ROVEN TECHNIC`, `Roven Technic Construction`, `Roven Construction`

---

### Required Platforms:
- **Facebook**: Posts, Page Comments, Group Discussions, and Public Video Captions
- **YouTube**: Video Titles, Descriptions, Transcripts, and Top Comments
- **TikTok**: Video Captions, Hashtags (#Ritehomes, #CebuRitehomes, #RovenTechnic), and Top Comments
- **Instagram**: Post Captions, Reels Captions, Hashtags, and Account Tagged Mentions

---

### Key Requirements:

1. **Customizable Monitoring Frequency**:
   - Provide a configuration setting allowing the user to select or change the check frequency dynamically (e.g., `Real-Time / 1 min`, `5 mins`, `15 mins`, `1 hour`, `12 hours`, or a custom `Cron Schedule` / interval in seconds).

2. **Automated Sentiment & Keyword Analysis**:
   - Evaluate all incoming mentions for sentiment (`Positive`, `Neutral`, `Negative`).
   - Highlight matched company names and aliases.
   - Detect **Crisis Spikes** (e.g., trigger an emergency alert if negative mentions exceed a threshold within a sliding 15-minute window).

3. **Multi-Channel Notification System**:
   - **Browser Desktop Push Notifications** (Web Push API)
   - **Slack / Discord / Teams Webhooks** with formatted rich card previews
   - **Email Alerts** for high-priority or negative mention spikes

4. **Dashboard & Data Controls**:
   - Display real-time mention stream with filters by Platform, Company, and Sentiment.
   - Interactive Analytics (Sentiment Breakdown %, Platform Share, Volume over time).
   - CSV / JSON export functionality.

---

### Technical Deliverables Expected:
1. A modular backend architecture script (Node.js or Python) demonstrating how to connect to platform APIs (Facebook Graph API, YouTube Data API v3, TikTok API, Instagram Graph API, or Webhook/Scraper aggregators like Apify/RapidAPI).
2. A clean configuration file (`config.json` or `.env`) for API keys, keywords, check frequency, and webhook URLs.
3. A web-based interactive dashboard with real-time UI updates, audio alerts, and export options.
```
