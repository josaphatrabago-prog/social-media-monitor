/**
 * Email alerts. Templates are inline-styled HTML because every mail client
 * strips <style> blocks to some degree, and a crisis alert has to be readable
 * on a phone lock screen preview as much as in a desktop client.
 */
import { sendMail } from './smtp.js';
import { createLogger } from '../log.js';

const log = createLogger('email');

const SENTIMENT_COLOR = {
  positive: '#10b981',
  neutral: '#64748b',
  negative: '#e11d48'
};

const SEVERITY_COLOR = {
  elevated: '#f59e0b',
  high: '#f97316',
  critical: '#dc2626'
};

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatTime(value) {
  return new Date(value).toLocaleString('en-PH', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Manila'
  });
}

function shell(title, accent, bodyHtml) {
  return `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f1f5f9;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0f172a;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0;">
    <tr><td style="background:${accent};padding:18px 24px;color:#ffffff;font-size:17px;font-weight:700;">${escapeHtml(title)}</td></tr>
    <tr><td style="padding:24px;">${bodyHtml}</td></tr>
    <tr><td style="padding:14px 24px;background:#f8fafc;border-top:1px solid #e2e8f0;font-size:12px;color:#64748b;">
      Sent by Social Media Monitor. Adjust thresholds and recipients in <code>config.json</code>.
    </td></tr>
  </table>
</body></html>`;
}

function mentionCard(mention) {
  const color = SENTIMENT_COLOR[mention.sentiment];
  const brands = (mention.companies || []).map((entry) => entry.companyName).join(', ');

  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"
    style="border:1px solid #e2e8f0;border-left:4px solid ${color};border-radius:8px;margin-bottom:14px;">
    <tr><td style="padding:14px 16px;">
      <div style="font-size:12px;color:#64748b;margin-bottom:6px;">
        <strong style="color:#0f172a;">${escapeHtml(mention.platform)}</strong>
        &nbsp;·&nbsp;${escapeHtml(mention.kind)}
        &nbsp;·&nbsp;${escapeHtml(formatTime(mention.timestamp))}
      </div>
      <div style="font-size:13px;font-weight:600;margin-bottom:8px;">
        ${escapeHtml(mention.author?.name || 'Unknown')}
        ${mention.author?.handle ? `<span style="color:#94a3b8;font-weight:400;"> · ${escapeHtml(mention.author.handle)}</span>` : ''}
      </div>
      <div style="font-size:14px;line-height:1.55;margin-bottom:10px;">${escapeHtml(mention.text)}</div>
      <div style="font-size:12px;color:#475569;">
        <span style="display:inline-block;padding:2px 8px;border-radius:99px;background:${color};color:#fff;font-weight:600;">
          ${escapeHtml(mention.sentiment)} ${mention.sentimentScore}
        </span>
        ${brands ? `&nbsp; Brand: <strong>${escapeHtml(brands)}</strong>` : ''}
        ${(mention.matchedTerms || []).length ? `&nbsp; Matched: ${escapeHtml(mention.matchedTerms.join(', '))}` : ''}
      </div>
      ${mention.url ? `<div style="margin-top:10px;"><a href="${escapeHtml(mention.url)}" style="color:#4f46e5;font-size:13px;font-weight:600;">Open the post &rarr;</a></div>` : ''}
    </td></tr>
  </table>`;
}

export function buildMentionEmail(mention) {
  const subject = `[${mention.sentiment.toUpperCase()}] ${mention.platform} mention — ` +
    `${(mention.companies || []).map((entry) => entry.companyName).join(', ') || 'brand'}`;

  const html = shell(
    `${mention.sentiment === 'negative' ? '🚨' : '📡'} New ${mention.sentiment} mention`,
    SENTIMENT_COLOR[mention.sentiment],
    mentionCard(mention)
  );

  return { subject, html };
}

export function buildCrisisEmail(event) {
  const accent = SEVERITY_COLOR[event.severity] || SEVERITY_COLOR.high;

  const facts = [
    ['Negative mentions', `${event.negativeCount} in the last ${event.windowMinutes} minutes`],
    ['Alert threshold', String(event.threshold)],
    ['Recent baseline', `${event.baseline} per ${event.windowMinutes}-minute window`],
    ['Rules fired', event.rules.join(' + ')],
    ['Brands affected', event.companies.map((c) => `${c.companyName} (${c.count})`).join(', ') || '—'],
    ['Platforms', event.platforms.map((p) => `${p.platform} (${p.count})`).join(', ') || '—'],
    ['Detected at', formatTime(event.triggeredAt)]
  ];

  const factRows = facts.map(([label, value]) => `
    <tr>
      <td style="padding:6px 12px 6px 0;font-size:13px;color:#64748b;white-space:nowrap;">${escapeHtml(label)}</td>
      <td style="padding:6px 0;font-size:13px;font-weight:600;">${escapeHtml(value)}</td>
    </tr>`).join('');

  const html = shell(
    `🔥 CRISIS ALERT — ${event.severity.toUpperCase()}`,
    accent,
    `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;">
       <strong>${event.negativeCount} negative mentions</strong> were detected within a
       ${event.windowMinutes}-minute sliding window${event.escalated ? ', and the count is still climbing' : ''}.
     </p>
     <table role="presentation" cellpadding="0" cellspacing="0" style="margin-bottom:20px;">${factRows}</table>
     <h3 style="font-size:14px;margin:0 0 10px;text-transform:uppercase;letter-spacing:.04em;color:#64748b;">
       Most negative mentions
     </h3>
     ${event.samples.map((sample) => mentionCard({
       ...sample,
       kind: 'mention',
       sentiment: 'negative',
       timestamp: event.triggeredAt,
       author: { name: sample.author },
       companies: [],
       matchedTerms: []
     })).join('')}`
  );

  return {
    subject: `🔥 CRISIS (${event.severity}): ${event.negativeCount} negative mentions in ${event.windowMinutes}m`,
    html
  };
}

/**
 * Sends one alert email.
 * @returns {Promise<{ok: boolean, recipients?: number, error?: string}>}
 */
export async function deliverEmail(emailConfig, kind, data) {
  const { subject, html } = kind === 'crisis'
    ? buildCrisisEmail(data)
    : buildMentionEmail(data);

  const from = emailConfig.from || emailConfig.smtp?.user;

  try {
    const result = await sendMail({
      host: emailConfig.smtp.host,
      port: Number(emailConfig.smtp.port) || 465,
      secure: emailConfig.smtp.secure !== false,
      user: emailConfig.smtp.user,
      pass: emailConfig.smtp.pass,
      from,
      to: emailConfig.to,
      subject,
      html
    });

    return { ok: true, recipients: result.accepted.length };
  } catch (error) {
    log.error(`email delivery failed: ${error.message}`);
    return { ok: false, error: error.message };
  }
}
