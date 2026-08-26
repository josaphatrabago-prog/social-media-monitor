/**
 * Webhook delivery for Slack, Discord, Microsoft Teams and generic JSON.
 *
 * This runs server-side on purpose. Posting to an incoming webhook from the
 * browser fails: Slack's hooks.slack.com does not send CORS headers, so the
 * fetch is blocked before it leaves the page, and doing it client-side would
 * also mean shipping the webhook URL - a bearer credential - to every visitor.
 */
import { postJson } from '../util/http.js';
import { createLogger } from '../log.js';

const log = createLogger('webhook');

const SENTIMENT_HEX = {
  positive: '#10b981',
  neutral: '#94a3b8',
  negative: '#f43f5e'
};

const SEVERITY_HEX = {
  elevated: '#f59e0b',
  high: '#f97316',
  critical: '#dc2626'
};

const PLATFORM_ICON = {
  Facebook: '📘',
  YouTube: '📺',
  TikTok: '🎵',
  Instagram: '📸'
};

const SENTIMENT_ICON = {
  positive: '🟢',
  neutral: '⚪',
  negative: '🔴'
};

const MAX_TEXT_LENGTH = 900;

function hexToInt(hex) {
  return parseInt(hex.replace('#', ''), 16);
}

function truncate(text, max = MAX_TEXT_LENGTH) {
  const clean = String(text || '').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

function companyNames(mention) {
  return (mention.companies || []).map((entry) => entry.companyName).join(', ') || 'unknown';
}

/* ------------------------------------------------------------------- Slack */

function slackMention(mention) {
  const icon = PLATFORM_ICON[mention.platform] || '📡';

  return {
    text: `${icon} ${mention.sentiment === 'negative' ? '🚨 Negative' : 'New'} mention on ${mention.platform}`,
    attachments: [
      {
        color: SENTIMENT_HEX[mention.sentiment],
        fallback: truncate(mention.text, 200),
        author_name: `${mention.author?.name || 'Unknown'}${mention.author?.handle ? ` · ${mention.author.handle}` : ''}`,
        title: `${companyNames(mention)} — ${mention.platform} ${mention.kind}`,
        title_link: mention.url || undefined,
        text: truncate(mention.text),
        fields: [
          {
            title: 'Sentiment',
            value: `${SENTIMENT_ICON[mention.sentiment]} ${mention.sentiment} (${mention.sentimentScore})`,
            short: true
          },
          { title: 'Matched', value: (mention.matchedTerms || []).join(', ') || '—', short: true }
        ],
        footer: 'Social Media Monitor',
        ts: Math.floor(new Date(mention.timestamp).getTime() / 1000)
      }
    ]
  };
}

function slackCrisis(event) {
  const lines = event.samples.map(
    (sample) => `• *${sample.platform}* — ${truncate(sample.text, 180)}${sample.url ? ` <${sample.url}|(open)>` : ''}`
  );

  return {
    text: `🔥 CRISIS ALERT (${event.severity.toUpperCase()}): ${event.negativeCount} negative mentions in ${event.windowMinutes} minutes`,
    attachments: [
      {
        color: SEVERITY_HEX[event.severity] || SEVERITY_HEX.high,
        fallback: `Crisis: ${event.negativeCount} negative mentions in ${event.windowMinutes}m`,
        title: 'Negative mention spike detected',
        text: lines.join('\n') || '_no samples available_',
        fields: [
          { title: 'Negative mentions', value: String(event.negativeCount), short: true },
          { title: 'Threshold', value: String(event.threshold), short: true },
          { title: 'Baseline / window', value: String(event.baseline), short: true },
          { title: 'Rules fired', value: event.rules.join(' + '), short: true },
          {
            title: 'Brands affected',
            value: event.companies.map((c) => `${c.companyName} (${c.count})`).join(', ') || '—',
            short: false
          },
          {
            title: 'Platforms',
            value: event.platforms.map((p) => `${p.platform} (${p.count})`).join(', ') || '—',
            short: false
          }
        ],
        footer: event.escalated ? 'Escalation — count grew during cooldown' : 'Social Media Monitor',
        ts: Math.floor(new Date(event.triggeredAt).getTime() / 1000)
      }
    ]
  };
}

/* ----------------------------------------------------------------- Discord */

function discordMention(mention) {
  const icon = PLATFORM_ICON[mention.platform] || '📡';

  return {
    username: 'Social Media Monitor',
    content: mention.sentiment === 'negative'
      ? `🚨 **Negative mention** on ${mention.platform}`
      : `${icon} New mention on ${mention.platform}`,
    embeds: [
      {
        title: truncate(`${companyNames(mention)} — ${mention.platform} ${mention.kind}`, 250),
        url: mention.url || undefined,
        description: truncate(mention.text, 2000),
        color: hexToInt(SENTIMENT_HEX[mention.sentiment]),
        author: {
          name: truncate(mention.author?.name || 'Unknown', 250),
          url: mention.author?.url || undefined
        },
        fields: [
          {
            name: 'Sentiment',
            value: `${SENTIMENT_ICON[mention.sentiment]} ${mention.sentiment} (${mention.sentimentScore})`,
            inline: true
          },
          { name: 'Matched', value: (mention.matchedTerms || []).join(', ') || '—', inline: true }
        ],
        footer: { text: 'Social Media Monitor' },
        timestamp: mention.timestamp
      }
    ]
  };
}

function discordCrisis(event) {
  return {
    username: 'Social Media Monitor',
    content: `🔥 **CRISIS ALERT — ${event.severity.toUpperCase()}**`,
    embeds: [
      {
        title: `${event.negativeCount} negative mentions in ${event.windowMinutes} minutes`,
        description: event.samples
          .map((sample) => `**${sample.platform}** — ${truncate(sample.text, 300)}`)
          .join('\n\n') || 'No samples available',
        color: hexToInt(SEVERITY_HEX[event.severity] || SEVERITY_HEX.high),
        fields: [
          { name: 'Threshold', value: String(event.threshold), inline: true },
          { name: 'Baseline', value: String(event.baseline), inline: true },
          { name: 'Rules', value: event.rules.join(' + '), inline: true },
          {
            name: 'Brands',
            value: event.companies.map((c) => `${c.companyName} (${c.count})`).join('\n') || '—',
            inline: false
          },
          {
            name: 'Platforms',
            value: event.platforms.map((p) => `${p.platform} (${p.count})`).join(', ') || '—',
            inline: false
          }
        ],
        footer: { text: event.escalated ? 'Escalation during cooldown' : 'Social Media Monitor' },
        timestamp: event.triggeredAt
      }
    ]
  };
}

/* ------------------------------------------------------------------- Teams */

/**
 * MessageCard rather than an Adaptive Card: it is what classic Office 365
 * "Incoming Webhook" connectors render. Teams workflows created through Power
 * Automate expect an Adaptive Card instead - use type "generic" and shape the
 * payload in the flow for those.
 */
function teamsMention(mention) {
  return {
    '@type': 'MessageCard',
    '@context': 'https://schema.org/extensions',
    themeColor: SENTIMENT_HEX[mention.sentiment].replace('#', ''),
    summary: `New ${mention.sentiment} mention on ${mention.platform}`,
    title: `${SENTIMENT_ICON[mention.sentiment]} ${mention.sentiment.toUpperCase()} mention on ${mention.platform}`,
    sections: [
      {
        activityTitle: mention.author?.name || 'Unknown',
        activitySubtitle: `${mention.author?.handle || ''} · ${new Date(mention.timestamp).toUTCString()}`,
        text: truncate(mention.text),
        facts: [
          { name: 'Brand', value: companyNames(mention) },
          { name: 'Matched', value: (mention.matchedTerms || []).join(', ') || '—' },
          { name: 'Score', value: String(mention.sentimentScore) },
          { name: 'Type', value: `${mention.platform} ${mention.kind}` }
        ]
      }
    ],
    potentialAction: mention.url
      ? [{ '@type': 'OpenUri', name: 'Open post', targets: [{ os: 'default', uri: mention.url }] }]
      : []
  };
}

function teamsCrisis(event) {
  return {
    '@type': 'MessageCard',
    '@context': 'https://schema.org/extensions',
    themeColor: (SEVERITY_HEX[event.severity] || SEVERITY_HEX.high).replace('#', ''),
    summary: `Crisis: ${event.negativeCount} negative mentions in ${event.windowMinutes}m`,
    title: `🔥 CRISIS ALERT — ${event.severity.toUpperCase()}`,
    sections: [
      {
        activityTitle: `${event.negativeCount} negative mentions in ${event.windowMinutes} minutes`,
        facts: [
          { name: 'Threshold', value: String(event.threshold) },
          { name: 'Baseline / window', value: String(event.baseline) },
          { name: 'Rules fired', value: event.rules.join(' + ') },
          {
            name: 'Brands',
            value: event.companies.map((c) => `${c.companyName} (${c.count})`).join(', ') || '—'
          },
          {
            name: 'Platforms',
            value: event.platforms.map((p) => `${p.platform} (${p.count})`).join(', ') || '—'
          }
        ],
        text: event.samples.map((sample) => `- **${sample.platform}**: ${truncate(sample.text, 250)}`).join('\n\n')
      }
    ]
  };
}

/* ----------------------------------------------------------------- generic */

function genericPayload(kind, data) {
  return {
    event: kind,
    source: 'social-media-monitor',
    sentAt: new Date().toISOString(),
    data
  };
}

const FORMATTERS = {
  slack: { mention: slackMention, crisis: slackCrisis },
  discord: { mention: discordMention, crisis: discordCrisis },
  teams: { mention: teamsMention, crisis: teamsCrisis },
  generic: {
    mention: (mention) => genericPayload('mention', mention),
    crisis: (event) => genericPayload('crisis', event)
  }
};

/**
 * Builds the provider-specific body for one event.
 * @param {'slack'|'discord'|'teams'|'generic'} type
 * @param {'mention'|'crisis'} kind
 */
export function formatPayload(type, kind, data) {
  const formatter = FORMATTERS[type] || FORMATTERS.generic;
  return (formatter[kind] || FORMATTERS.generic[kind])(data);
}

/**
 * Posts one event to one configured webhook.
 * @returns {Promise<{ok: boolean, name: string, status?: number, error?: string}>}
 */
export async function deliverWebhook(hook, kind, data) {
  const payload = formatPayload(hook.type, kind, data);

  try {
    await postJson(hook.url, payload, { retries: 1, timeoutMs: 10000 });
    log.info(`delivered ${kind} to ${hook.name || hook.type}`);
    return { ok: true, name: hook.name || hook.type };
  } catch (error) {
    log.error(`delivery to ${hook.name || hook.type} failed: ${error.message}`);
    return {
      ok: false,
      name: hook.name || hook.type,
      status: error.status,
      error: error.message
    };
  }
}
