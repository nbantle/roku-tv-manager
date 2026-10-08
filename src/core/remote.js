// Optional "phone access": serves the same dashboard over HTTP so phones and
// other computers on the network can open it in a browser.

import fs from 'node:fs';
import http from 'node:http';

const MAX_BODY = 64 * 1024;

export function createRemoteServer(handle, indexHtmlPath) {
  return http.createServer(async (req, res) => {
    const send = (status, payload, type = 'application/json; charset=utf-8') => {
      const data = Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload));
      res.writeHead(status, { 'Content-Type': type, 'Content-Length': data.length, 'Cache-Control': 'no-store' });
      res.end(data);
    };
    const path = (req.url || '/').split('?')[0];

    if (req.method === 'GET' && !path.startsWith('/api/')) {
      if (path !== '/' && path !== '/index.html') return send(404, { error: 'Not found' });
      return send(200, fs.readFileSync(indexHtmlPath), 'text/html; charset=utf-8');
    }

    // Requiring a JSON content type means another web page can't trick a
    // browser into sending commands here (it would need a CORS preflight).
    if (req.method !== 'GET' && !(req.headers['content-type'] || '').startsWith('application/json')) {
      return send(415, { error: 'Send requests as application/json' });
    }

    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) return send(413, { error: 'Request too large' });
      chunks.push(chunk);
    }
    let body = {};
    if (size) {
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return send(400, { error: 'Invalid JSON' });
      }
    }
    const result = await handle(req.method, path, body);
    send(result.status, result.body);
  });
}
