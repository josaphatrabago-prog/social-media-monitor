/**
 * HTTP layer: static file serving, JSON routing, SSE endpoint and optional
 * token auth. Built on node:http - no framework, because routing a dozen
 * endpoints does not need one.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../log.js';
import { createApi } from './api.js';

const log = createLogger('http');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8'
};

const MAX_BODY_BYTES = 1_000_000;

/** Files the dashboard is allowed to load, as directories or exact names. */
const STATIC_ALLOWLIST = ['css', 'js', 'index.html', 'sw.js', 'favicon.ico', 'manifest.webmanifest'];

function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store'
  });
  response.end(body);
}

function sendText(response, statusCode, text) {
  response.writeHead(statusCode, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store'
  });
  response.end(text);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('request body too large'), { statusCode: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });

    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve(null);
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error('body is not valid JSON'), { statusCode: 400 }));
      }
    });

    request.on('error', reject);
  });
}

/**
 * Resolves a URL path to a file inside the project root, or null when the path
 * escapes the root or is not allow-listed.
 */
function resolveStaticPath(root, urlPath) {
  const relative = decodeURIComponent(urlPath).replace(/^\/+/, '');
  const candidate = relative === '' ? 'index.html' : relative;

  const resolved = path.resolve(root, candidate);
  const rootWithSep = path.resolve(root) + path.sep;

  // Path traversal guard: the resolved file must sit under the root.
  if (!resolved.startsWith(rootWithSep)) return null;

  const topSegment = candidate.split('/')[0];
  if (!STATIC_ALLOWLIST.includes(topSegment)) return null;

  return resolved;
}

export function createServer(context) {
  const { configStore, hub, staticRoot, authToken } = context;
  const routes = createApi(context);

  /** True when the request may proceed. */
  function isAuthorised(request, url) {
    if (!authToken) return true;

    const provided = request.headers['x-monitor-token'] || url.searchParams.get('token');
    return provided === authToken;
  }

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    const routeKey = `${request.method} ${url.pathname}`;

    try {
      // --- real-time stream
      if (routeKey === 'GET /api/events') {
        if (!isAuthorised(request, url)) return sendJson(response, 401, { error: 'unauthorised' });
        hub.addClient(request, response);
        return undefined;
      }

      // --- JSON API
      if (url.pathname.startsWith('/api/')) {
        if (!isAuthorised(request, url)) return sendJson(response, 401, { error: 'unauthorised' });

        const handler = routes[routeKey];
        if (!handler) {
          return sendJson(response, 404, {
            error: `no route for ${routeKey}`,
            available: Object.keys(routes).sort()
          });
        }

        const body = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(request.method)
          ? await readBody(request)
          : null;

        const result = await handler({ query: url.searchParams, body, request });

        // A `raw` result is a file download (CSV / JSON export).
        if (result && result.raw) {
          const { contentType, filename, body: fileBody } = result.raw;
          response.writeHead(200, {
            'content-type': contentType,
            'content-disposition': `attachment; filename="${filename}"`,
            'content-length': Buffer.byteLength(fileBody),
            'cache-control': 'no-store'
          });
          response.end(fileBody);
          return undefined;
        }

        return sendJson(response, 200, result ?? { ok: true });
      }

      // --- static assets
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return sendText(response, 405, 'Method Not Allowed');
      }

      const filePath = resolveStaticPath(staticRoot, url.pathname);
      if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        return sendText(response, 404, 'Not Found');
      }

      const extension = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[extension] || 'application/octet-stream';
      const contents = fs.readFileSync(filePath);

      response.writeHead(200, {
        'content-type': contentType,
        'content-length': contents.length,
        // The dashboard is served from disk and changes during development;
        // revalidating every time avoids stale-asset confusion.
        'cache-control': 'no-cache',
        // A service worker may only control scopes at or below its own path.
        ...(path.basename(filePath) === 'sw.js' ? { 'service-worker-allowed': '/' } : {})
      });

      response.end(request.method === 'HEAD' ? undefined : contents);
      return undefined;
    } catch (error) {
      const statusCode = error.statusCode || 500;
      if (statusCode >= 500) {
        log.error(`${routeKey} failed`, error);
      } else {
        log.warn(`${routeKey}: ${error.message}`);
      }

      if (!response.headersSent) {
        return sendJson(response, statusCode, { error: error.message });
      }

      response.end();
      return undefined;
    }
  });

  server.on('clientError', (error, socket) => {
    if (!socket.writableEnded) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  return {
    server,

    listen() {
      const { host, port } = configStore.get().server;

      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.removeListener('error', reject);
          const suffix = authToken ? `?token=${authToken}` : '';
          log.info(`dashboard on http://${host}:${port}/${suffix}`);
          resolve({ host, port });
        });
      });
    },

    close() {
      hub.close();
      return new Promise((resolve) => server.close(resolve));
    }
  };
}
