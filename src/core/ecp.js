// Minimal client for Roku's External Control Protocol (ECP).
//
// Every Roku device on the LAN exposes a small HTTP API on port 8060:
//   GET  /query/device-info   power state, model, serial number, ...
//   GET  /query/active-app    what is in the foreground (app, HDMI input, home)
//   GET  /query/media-player  playback state of the foreground app
//   GET  /query/apps          installed channels
//   POST /keypress/<key>      simulate a remote button press
//   POST /launch/<app-id>     open a channel

import http from 'node:http';

export const ECP_PORT = 8060;

export const FORBIDDEN_HINT =
  'The TV refused the request (HTTP 403). On the TV go to Settings > System > ' +
  'Advanced system settings > Control by mobile apps and set Network access ' +
  'to Default or Permissive.';

export class EcpError extends Error {
  constructor(message, status = null) {
    super(message);
    this.status = status;
  }
}

// ---------- tiny XML helpers (ECP responses are small and flat) ----------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decode(text) {
  return text.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e] ?? m;
  });
}

function attrs(text = '') {
  const out = {};
  for (const [, name, value] of text.matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)) out[name] = decode(value);
  return out;
}

/** Leaf elements like <tag a="b">text</tag> or <tag a="b"/> with the given name (or any name). */
export function elements(xml, name = '[\\w-]+') {
  const re = new RegExp(`<(${name})((?:\\s[^>]*?)?)(?:/>|>([^<]*)</\\1>)`, 'g');
  return [...xml.matchAll(re)].map(([, tag, a, text]) => ({ tag, attrs: attrs(a), text: decode((text ?? '').trim()) }));
}

function rootAttrs(xml, name) {
  const m = xml.match(new RegExp(`<${name}((?:\\s[^>]*?)?)/?>`));
  return m ? attrs(m[1]) : null;
}

// ---------- client ----------

export class EcpClient {
  constructor(host, port = ECP_PORT, timeoutMs = 3000) {
    this.host = host;
    this.port = port;
    this.timeoutMs = timeoutMs;
  }

  request(method, path) {
    return new Promise((resolve, reject) => {
      const req = http.request(
        { host: this.host, port: this.port, method, path, timeout: this.timeoutMs, headers: method === 'POST' ? { 'Content-Length': 0 } : {} },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            if (res.statusCode === 403) return reject(new EcpError(FORBIDDEN_HINT, 403));
            if (res.statusCode >= 400) return reject(new EcpError(`TV returned HTTP ${res.statusCode} for ${path}`, res.statusCode));
            resolve(Buffer.concat(chunks).toString('utf8'));
          });
          res.on('error', (e) => reject(new EcpError(`Could not reach ${this.host}: ${e.message}`)));
        },
      );
      req.on('timeout', () => req.destroy(new Error('timed out')));
      req.on('error', (e) => reject(new EcpError(`Could not reach ${this.host}: ${e.code || e.message}`)));
      req.end();
    });
  }

  async deviceInfo() {
    const xml = await this.request('GET', '/query/device-info');
    if (!xml.includes('<device-info')) throw new EcpError(`Unreadable response from ${this.host}`);
    return Object.fromEntries(elements(xml).map((e) => [e.tag, e.text]));
  }

  async activeApp() {
    const xml = await this.request('GET', '/query/active-app');
    const app = elements(xml, 'app')[0];
    const saver = elements(xml, 'screensaver')[0];
    return {
      id: app?.attrs.id ?? null,
      name: app?.text ?? null,
      type: app?.attrs.type ?? null,
      screensaver: saver ? { id: saver.attrs.id ?? null, name: saver.text } : null,
    };
  }

  async mediaPlayer() {
    const xml = await this.request('GET', '/query/media-player');
    return { state: rootAttrs(xml, 'player')?.state ?? null };
  }

  async apps() {
    const xml = await this.request('GET', '/query/apps');
    return elements(xml, 'app').map((a) => ({ id: a.attrs.id, name: a.text, type: a.attrs.type }));
  }

  keypress(key) {
    return this.request('POST', '/keypress/' + encodeURIComponent(key));
  }

  launch(appId) {
    return this.request('POST', '/launch/' + encodeURIComponent(appId));
  }
}
