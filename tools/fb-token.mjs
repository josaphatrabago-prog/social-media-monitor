/**
 * Turns a short-lived Facebook token into what this app actually needs.
 *
 * Graph API Explorer hands you a user token that dies in an hour or two. What
 * the monitor needs is a *Page* token that does not expire, which only exists
 * if you derive it from a long-lived user token. Doing that by hand is three
 * curl calls and the usual cause of "it worked yesterday".
 *
 * This does the exchange, lists the Pages you have a role on, reports each
 * token's real expiry via /debug_token, and optionally writes the GitHub
 * secrets so the token never has to be pasted anywhere else.
 *
 *   node tools/fb-token.mjs --token <short-lived> --secret <app-secret>
 *   node tools/fb-token.mjs --token <short-lived> --secret <app-secret> --set-secrets
 *
 * The app secret is only ever sent to graph.facebook.com and is never printed.
 */
import { execFileSync } from 'node:child_process';

const DEFAULT_APP_ID = '28631043609827008';
const API = 'https://graph.facebook.com/v21.0';

function parseArgs(argv) {
  const args = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;

    const [key, inline] = token.slice(2).split('=');
    if (inline !== undefined) {
      args[key] = inline;
      continue;
    }

    const next = argv[index + 1];
    args[key] = next && !next.startsWith('--') ? (index += 1, next) : true;
  }

  return args;
}

const args = parseArgs(process.argv.slice(2));
const appId = args['app-id'] || DEFAULT_APP_ID;
const shortLived = args.token;
const appSecret = args.secret;

if (!shortLived || !appSecret) {
  process.stdout.write(
    'Usage:\n' +
    '  node tools/fb-token.mjs --token <short-lived-user-token> --secret <app-secret>\n' +
    '                          [--app-id <id>] [--set-secrets]\n\n' +
    '  --token         from Graph API Explorer -> Generate Access Token\n' +
    '  --secret        App settings -> Basic -> App secret\n' +
    '  --set-secrets   also run `gh secret set` for you\n\n'
  );
  process.exit(1);
}

/** Graph errors arrive as 200-with-error-body as often as not. */
async function graph(path, params) {
  const url = new URL(`${API}/${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  const response = await fetch(url, { signal: AbortSignal.timeout(25000) });
  const payload = await response.json();

  if (payload.error) {
    const error = new Error(`${payload.error.type || 'GraphError'}: ${payload.error.message}`);
    error.code = payload.error.code;
    throw error;
  }

  return payload;
}

function describeExpiry(seconds) {
  if (seconds === 0) return 'never expires';
  if (!seconds) return 'unknown';

  const remaining = seconds * 1000 - Date.now();
  if (remaining <= 0) return 'ALREADY EXPIRED';

  const days = Math.floor(remaining / 86400000);
  const hours = Math.round((remaining % 86400000) / 3600000);
  return days > 0 ? `${days}d ${hours}h` : `${hours}h`;
}

try {
  /* --- 1. short-lived user token -> long-lived (about 60 days) ----------- */

  process.stdout.write('\n[1] exchanging for a long-lived user token\n');

  const exchanged = await graph('oauth/access_token', {
    grant_type: 'fb_exchange_token',
    client_id: appId,
    client_secret: appSecret,
    fb_exchange_token: shortLived
  });

  const longLived = exchanged.access_token;
  if (!longLived) throw new Error('no access_token in the exchange response');

  const appToken = `${appId}|${appSecret}`;
  const userDebug = await graph('debug_token', { input_token: longLived, access_token: appToken });

  process.stdout.write(`    user token expires: ${describeExpiry(userDebug.data?.expires_at)}\n`);
  process.stdout.write(`    scopes: ${(userDebug.data?.scopes || []).join(', ') || '(none)'}\n`);

  const required = ['pages_show_list', 'pages_read_engagement', 'pages_read_user_content'];
  const missing = required.filter((scope) => !(userDebug.data?.scopes || []).includes(scope));

  if (missing.length) {
    process.stdout.write(
      `\n    WARNING: missing ${missing.join(', ')}\n` +
      '    Add them in Graph API Explorer and generate a new token, or the\n' +
      '    monitor will not be able to read Page posts or follower comments.\n'
    );
  }

  /* --- 2. the Pages this account has a role on -------------------------- */

  process.stdout.write('\n[2] Pages you have a role on\n');

  const accounts = await graph('me/accounts', {
    fields: 'id,name,access_token,tasks',
    limit: '100',
    access_token: longLived
  });

  const pages = accounts.data || [];

  if (pages.length === 0) {
    process.stdout.write(
      '    none.\n\n' +
      '    This is the answer to whether you can monitor these Pages: you cannot\n' +
      '    read a Page you have no role on, at any price. Ask whoever owns the\n' +
      '    Ritehomes / Roven Technic Pages to add your account under\n' +
      '    Page settings -> Page access. "Analyst" is enough for read-only.\n\n'
    );
    process.exit(2);
  }

  const pageIds = [];
  let bestToken = null;

  for (const page of pages) {
    const debug = await graph('debug_token', {
      input_token: page.access_token,
      access_token: appToken
    }).catch(() => null);

    const expiry = describeExpiry(debug?.data?.expires_at);
    const canRead = (page.tasks || []).length > 0;

    process.stdout.write(
      `    ${page.name}\n` +
      `      id      : ${page.id}\n` +
      `      expiry  : ${expiry}\n` +
      `      tasks   : ${(page.tasks || []).join(', ') || '(none)'}\n`
    );

    pageIds.push(page.id);
    // Prefer a token that genuinely never expires.
    if (!bestToken || expiry === 'never expires') bestToken = page.access_token;
  }

  /* --- 3. what to do with it ------------------------------------------- */

  process.stdout.write('\n[3] next\n');

  if (args['set-secrets']) {
    // --repo explicitly, so the secrets cannot land in a different repository
    // just because the script was run from the wrong directory.
    const repo = args.repo || 'josaphatrabago-prog/social-media-monitor';

    for (const [name, value] of [
      ['FB_ACCESS_TOKEN', bestToken],
      ['FB_PAGE_IDS', pageIds.join(',')]
    ]) {
      try {
        execFileSync('gh', ['secret', 'set', name, '--repo', repo, '--body', value], {
          stdio: ['ignore', 'inherit', 'inherit']
        });
        process.stdout.write(`    set ${name}\n`);
      } catch (ghError) {
        process.stdout.write(
          `\n    COULD NOT SET ${name}: ${ghError.message.split('\n')[0]}\n` +
          '    Is the GitHub CLI installed and logged in? Check with `gh auth status`.\n' +
          '    You can set it by hand instead:\n\n' +
          `      gh secret set ${name} --repo ${repo}\n\n`
        );
        process.exitCode = 1;
      }
    }

    if (process.exitCode !== 1) {
      process.stdout.write(`\n    SUCCESS - both secrets written to ${repo}.\n    Tell Claude to redeploy.\n\n`);
    }
  } else {
    process.stdout.write(
      '    Run these (or re-run this script with --set-secrets):\n\n' +
      `      gh secret set FB_PAGE_IDS --body "${pageIds.join(',')}"\n` +
      '      gh secret set FB_ACCESS_TOKEN --body "<the Page token above>"\n\n' +
      '    The Page token is a credential. Prefer --set-secrets so it never\n' +
      '    lands in your shell history.\n\n'
    );
  }
} catch (error) {
  process.stdout.write(`\n  FAILED: ${error.message}\n`);

  // Graph overloads its numeric codes - code 1 covers both "try again" and
  // "your secret is wrong" - so the message is the more reliable signal.
  const message = error.message.toLowerCase();

  if (message.includes('client secret')) {
    process.stdout.write(
      '  The app secret is wrong. Copy it from App settings -> Basic -> App secret\n' +
      '  (click Show), for app id ' + appId + '.\n'
    );
  } else if (message.includes('session has expired') || error.code === 190) {
    process.stdout.write(
      '  The user token is expired or invalid. Graph API Explorer tokens last\n' +
      '  1-2 hours, so generate a fresh one and re-run this straight away.\n'
    );
  } else if (message.includes('cannot be loaded') || message.includes('does not exist')) {
    process.stdout.write(`  Check the app id (${appId}) matches the app the token came from.\n`);
  } else if (error.code === 2) {
    process.stdout.write('  A transient Graph error; try again in a moment.\n');
  }

  process.stdout.write('\n');
  process.exit(1);
}
