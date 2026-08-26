/**
 * Minimal SMTP client built on node:net / node:tls.
 *
 * Written rather than pulled in as a dependency because the whole project is
 * dependency-free, and sending an alert email needs only a small slice of the
 * protocol: EHLO, optional STARTTLS, AUTH PLAIN or LOGIN, MAIL FROM, RCPT TO,
 * DATA, QUIT.
 *
 * Supported:
 *   - implicit TLS on port 465 (secure: true) and STARTTLS on 587
 *   - AUTH PLAIN and AUTH LOGIN, chosen from the EHLO capability list
 *   - UTF-8 subjects (RFC 2047) and base64 bodies, which sidesteps both line
 *     length limits and dot-stuffing
 *
 * Not supported: OAuth2/XOAUTH2, attachments, connection pooling. For Gmail,
 * use an App Password.
 */
import net from 'node:net';
import tls from 'node:tls';
import { createLogger } from '../log.js';

const log = createLogger('smtp');

const DEFAULT_TIMEOUT_MS = 20000;
const CRLF = '\r\n';

/** One SMTP reply: a status code plus its (possibly multi-line) text. */
class Reply {
  constructor(code, lines) {
    this.code = code;
    this.lines = lines;
    this.text = lines.join(' ');
  }

  get isPositive() {
    return this.code >= 200 && this.code < 400;
  }
}

class SmtpError extends Error {
  constructor(message, reply) {
    super(reply ? `${message}: ${reply.code} ${reply.text}` : message);
    this.name = 'SmtpError';
    this.code = reply?.code;
  }
}

/**
 * Wraps a socket with line-buffered reply reading. SMTP replies can arrive
 * split across packets or several at a time, so a buffer is required - reading
 * one 'data' event per reply is the classic bug here.
 */
class SmtpConnection {
  constructor(socket, timeoutMs) {
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    this.buffer = '';
    this.pending = [];
    this.closed = false;

    socket.setEncoding('utf8');
    socket.on('data', (chunk) => this.#onData(chunk));
    socket.on('error', (error) => this.#fail(error));
    socket.on('close', () => {
      this.closed = true;
      this.#fail(new SmtpError('connection closed by server'));
    });
  }

  #onData(chunk) {
    this.buffer += chunk;

    let newlineIndex = this.buffer.indexOf('\n');
    const lines = [];

    while (newlineIndex !== -1) {
      lines.push(this.buffer.slice(0, newlineIndex).replace(/\r$/, ''));
      this.buffer = this.buffer.slice(newlineIndex + 1);
      newlineIndex = this.buffer.indexOf('\n');
    }

    for (const line of lines) this.#onLine(line);
  }

  #onLine(line) {
    if (!this.currentLines) this.currentLines = [];
    this.currentLines.push(line.slice(4));

    // "250-" means more lines follow; "250 " ends the reply.
    const isFinal = /^\d{3}\s/.test(line) || line.length <= 3;
    if (!isFinal) return;

    const code = Number.parseInt(line.slice(0, 3), 10);
    const reply = new Reply(code, this.currentLines);
    this.currentLines = null;

    const waiter = this.pending.shift();
    if (waiter) waiter.resolve(reply);
  }

  #fail(error) {
    while (this.pending.length) {
      this.pending.shift().reject(error);
    }
  }

  /** Resolves with the next reply from the server. */
  readReply() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new SmtpError(`timed out after ${this.timeoutMs}ms waiting for a reply`));
      }, this.timeoutMs);

      this.pending.push({
        resolve: (reply) => { clearTimeout(timer); resolve(reply); },
        reject: (error) => { clearTimeout(timer); reject(error); }
      });
    });
  }

  /** Sends a command and returns the reply, asserting an expected status. */
  async command(line, expectedCodes, { redact = false } = {}) {
    log.debug(`> ${redact ? '<credentials>' : line}`);
    this.socket.write(line + CRLF);

    const reply = await this.readReply();
    log.debug(`< ${reply.code} ${reply.text.slice(0, 120)}`);

    if (expectedCodes && !expectedCodes.includes(reply.code)) {
      throw new SmtpError(`unexpected reply to ${redact ? 'AUTH' : line.split(' ')[0]}`, reply);
    }

    return reply;
  }

  write(data) {
    this.socket.write(data);
  }

  /** Replaces the plain socket with a TLS one after STARTTLS. */
  upgradeToTls(options) {
    return new Promise((resolve, reject) => {
      this.socket.removeAllListeners('data');
      this.socket.removeAllListeners('error');
      this.socket.removeAllListeners('close');

      const secureSocket = tls.connect(
        { socket: this.socket, servername: options.host, rejectUnauthorized: options.rejectUnauthorized !== false },
        () => {
          this.buffer = '';
          this.currentLines = null;
          this.socket = secureSocket;
          secureSocket.setEncoding('utf8');
          secureSocket.on('data', (chunk) => this.#onData(chunk));
          secureSocket.on('error', (error) => this.#fail(error));
          resolve();
        }
      );

      secureSocket.once('error', reject);
    });
  }

  end() {
    try {
      this.socket.end();
    } catch {
      // Nothing useful to do if the socket is already gone.
    }
  }
}

function connectSocket({ host, port, secure, timeoutMs, rejectUnauthorized }) {
  return new Promise((resolve, reject) => {
    const socket = secure
      ? tls.connect({ host, port, servername: host, rejectUnauthorized: rejectUnauthorized !== false })
      : net.connect({ host, port });

    const onReady = () => {
      socket.setTimeout(0);
      resolve(socket);
    };

    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      reject(new SmtpError(`connection to ${host}:${port} timed out`));
    });

    socket.once(secure ? 'secureConnect' : 'connect', onReady);
    socket.once('error', reject);
  });
}

/** RFC 2047 encoded-word, needed for non-ASCII subjects. */
function encodeHeaderValue(value) {
  const text = String(value);
  // eslint-disable-next-line no-control-regex
  if (!/[^\x00-\x7F]/.test(text)) return text;
  return `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`;
}

/** Base64 body in 76-character lines, per RFC 2045. */
function encodeBody(body) {
  return (Buffer.from(body, 'utf8').toString('base64').match(/.{1,76}/g) || []).join(CRLF);
}

function formatAddressList(addresses) {
  return (Array.isArray(addresses) ? addresses : [addresses]).filter(Boolean).join(', ');
}

/**
 * Sends one message.
 *
 * @param {Object} options
 * @param {string} options.host
 * @param {number} options.port
 * @param {boolean} options.secure       true for implicit TLS (465)
 * @param {string} [options.user]
 * @param {string} [options.pass]
 * @param {string} options.from
 * @param {string[]} options.to
 * @param {string} options.subject
 * @param {string} options.html
 * @param {string} [options.text]        plain-text alternative
 * @returns {Promise<{accepted: string[], response: string}>}
 */
export async function sendMail(options) {
  const {
    host, port = 465, secure = port === 465, user, pass,
    from, to, subject, html, text,
    timeoutMs = DEFAULT_TIMEOUT_MS, rejectUnauthorized = true
  } = options;

  if (!host) throw new SmtpError('SMTP host is not configured');

  const recipients = (Array.isArray(to) ? to : [to]).filter(Boolean);
  if (recipients.length === 0) throw new SmtpError('no recipients');

  const socket = await connectSocket({ host, port, secure, timeoutMs, rejectUnauthorized });
  const connection = new SmtpConnection(socket, timeoutMs);

  try {
    const greeting = await connection.readReply();
    if (!greeting.isPositive) throw new SmtpError('bad greeting', greeting);

    const clientName = 'social-media-monitor';
    let capabilities = await connection.command(`EHLO ${clientName}`, [250]);

    // Upgrade an unencrypted connection when the server offers STARTTLS.
    if (!secure && capabilities.lines.some((line) => /STARTTLS/i.test(line))) {
      await connection.command('STARTTLS', [220]);
      await connection.upgradeToTls({ host, rejectUnauthorized });
      capabilities = await connection.command(`EHLO ${clientName}`, [250]);
    }

    if (user && pass) {
      await authenticate(connection, capabilities, user, pass);
    }

    await connection.command(`MAIL FROM:<${from}>`, [250]);
    for (const recipient of recipients) {
      await connection.command(`RCPT TO:<${recipient}>`, [250, 251]);
    }

    await connection.command('DATA', [354]);

    const message = buildMessage({ from, recipients, subject, html, text });
    connection.write(`${message}${CRLF}.${CRLF}`);

    const stored = await connection.readReply();
    if (!stored.isPositive) throw new SmtpError('message rejected', stored);

    await connection.command('QUIT', null).catch(() => {});

    log.info(`sent "${subject}" to ${recipients.length} recipient(s)`);
    return { accepted: recipients, response: stored.text };
  } finally {
    connection.end();
  }
}

async function authenticate(connection, capabilities, user, pass) {
  const authLine = capabilities.lines.find((line) => /^AUTH\s/i.test(line)) || '';
  const mechanisms = authLine.toUpperCase();

  if (mechanisms.includes('PLAIN') || !mechanisms) {
    // RFC 4616: authzid NUL authcid NUL passwd. The separators are NUL
    // bytes, written as escapes so this file stays plain ASCII.
    const credentials = Buffer
      .from(`\u0000${user}\u0000${pass}`, 'utf8')
      .toString('base64');
    await connection.command(`AUTH PLAIN ${credentials}`, [235], { redact: true });
    return;
  }

  if (mechanisms.includes('LOGIN')) {
    await connection.command('AUTH LOGIN', [334]);
    await connection.command(Buffer.from(user, 'utf8').toString('base64'), [334], { redact: true });
    await connection.command(Buffer.from(pass, 'utf8').toString('base64'), [235], { redact: true });
    return;
  }

  throw new SmtpError(`server advertises no supported AUTH mechanism (${authLine || 'none'})`);
}

/** Builds a multipart/alternative message with base64 parts. */
function buildMessage({ from, recipients, subject, html, text }) {
  const boundary = `smm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  const plain = text || html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

  const headers = [
    `From: ${from}`,
    `To: ${formatAddressList(recipients)}`,
    `Subject: ${encodeHeaderValue(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${boundary}@social-media-monitor>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    'X-Mailer: social-media-monitor'
  ];

  const parts = [
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    encodeBody(plain),
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    encodeBody(html),
    `--${boundary}--`
  ];

  return [...headers, '', ...parts].join(CRLF);
}

export { SmtpError, encodeHeaderValue, buildMessage };
