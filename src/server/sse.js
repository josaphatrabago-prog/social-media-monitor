/**
 * Server-Sent Events hub.
 *
 * SSE rather than WebSocket: the dashboard only ever needs server-to-client
 * push, and SSE gives that over plain HTTP with automatic browser reconnection
 * and no dependency. A WebSocket library would add a package to carry traffic
 * in a direction it does not need.
 */
import { createLogger } from '../log.js';

const log = createLogger('sse');

/** Comment frames keep proxies from closing an idle connection. */
const HEARTBEAT_MS = 25000;

/** Replayed to a client that reconnects with Last-Event-ID. */
const REPLAY_BUFFER_SIZE = 50;

export class EventHub {
  constructor() {
    this.clients = new Set();
    this.nextId = 1;
    this.recent = [];

    this.heartbeat = setInterval(() => this.#sendHeartbeat(), HEARTBEAT_MS);
    if (typeof this.heartbeat.unref === 'function') this.heartbeat.unref();
  }

  get clientCount() {
    return this.clients.size;
  }

  /** Registers one response stream as a subscriber. */
  addClient(request, response) {
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Tells nginx not to buffer the stream, which would defeat the point.
      'x-accel-buffering': 'no'
    });

    const client = { response, id: this.nextId++ };
    this.clients.add(client);

    response.write(`retry: 3000\n\n`);
    this.#writeTo(client, 'hello', {
      clientId: client.id,
      connectedAt: new Date().toISOString()
    });

    // Replay anything the client missed across a dropped connection.
    const lastEventId = Number(request.headers['last-event-id']);
    if (Number.isFinite(lastEventId)) {
      for (const frame of this.recent.filter((entry) => entry.id > lastEventId)) {
        client.response.write(frame.payload);
      }
    }

    const cleanup = () => {
      this.clients.delete(client);
      log.debug(`client ${client.id} disconnected (${this.clients.size} remaining)`);
    };

    request.on('close', cleanup);
    request.on('error', cleanup);
    response.on('error', cleanup);

    log.debug(`client ${client.id} connected (${this.clients.size} total)`);
    return client;
  }

  #writeTo(client, event, data) {
    try {
      client.response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch (error) {
      this.clients.delete(client);
      log.debug(`dropping client ${client.id}: ${error.message}`);
    }
  }

  #sendHeartbeat() {
    for (const client of this.clients) {
      try {
        client.response.write(': ping\n\n');
      } catch {
        this.clients.delete(client);
      }
    }
  }

  /**
   * Pushes one event to every connected dashboard.
   * @param {string} event e.g. "mention", "crisis", "status"
   */
  broadcast(event, data) {
    if (this.clients.size === 0) return 0;

    const id = this.nextId++;
    const payload = `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

    this.recent.push({ id, payload });
    if (this.recent.length > REPLAY_BUFFER_SIZE) this.recent.shift();

    let delivered = 0;
    for (const client of [...this.clients]) {
      try {
        client.response.write(payload);
        delivered += 1;
      } catch (error) {
        this.clients.delete(client);
        log.debug(`dropping client ${client.id}: ${error.message}`);
      }
    }

    return delivered;
  }

  close() {
    clearInterval(this.heartbeat);
    for (const client of this.clients) {
      try {
        client.response.end();
      } catch {
        // Already gone.
      }
    }
    this.clients.clear();
  }
}

export function createEventHub() {
  return new EventHub();
}
