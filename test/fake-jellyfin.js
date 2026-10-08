// A tiny stand-in for a Jellyfin server, for tests and demos.

import http from 'node:http';

export class FakeJellyfin {
  constructor({ apiKey = 'secret-key', host = '127.0.0.1', port = 0 } = {}) {
    this.apiKey = apiKey;
    this.sessions = [];
    this.plays = []; // [{ sessionId, itemIds }]
    this.items = [
      { Id: 'pl1', Name: 'Walk-In Loop', Type: 'Playlist' },
      { Id: 'mv1', Name: 'Christmas Eve Countdown', Type: 'Video', ProductionYear: 2026 },
      { Id: 'ep1', Name: 'Pilot', SeriesName: 'Kids Church', Type: 'Episode' },
    ];
    this.server = http.createServer((req, res) => this.handle(req, res));
    this.ready = new Promise((resolve) => this.server.listen(port, host, () => {
      this.port = this.server.address().port;
      this.url = `http://${host}:${this.port}`;
      resolve(this);
    }));
  }

  close() {
    return new Promise((r) => this.server.close(r));
  }

  /** Pretend the Jellyfin app on the TV at `host` is connected. */
  addSession(host, { id = `sess-${host}`, nowPlaying = null, deviceName = 'Roku' } = {}) {
    this.sessions.push({
      Id: id, Client: 'Roku', DeviceName: deviceName, RemoteEndPoint: host, SupportsRemoteControl: true,
      LastActivityDate: new Date().toISOString(),
      ...(nowPlaying ? { NowPlayingItem: { Name: nowPlaying }, PlayState: { IsPaused: false } } : {}),
    });
  }

  handle(req, res) {
    const send = (status, body) => {
      const data = body === undefined ? '' : JSON.stringify(body);
      res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) });
      res.end(data);
    };
    if (req.headers['x-emby-token'] !== this.apiKey) return send(401, { error: 'unauthorized' });
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && url.pathname === '/System/Info') return send(200, { ServerName: 'Church Media', Version: '10.10.7' });
    if (req.method === 'GET' && url.pathname === '/Sessions') return send(200, this.sessions);
    if (req.method === 'GET' && url.pathname === '/Users') return send(200, [{ Id: 'u1', Name: 'admin', Policy: { IsAdministrator: true } }]);
    if (req.method === 'GET' && url.pathname === '/Items') {
      const q = (url.searchParams.get('searchTerm') || '').toLowerCase();
      return send(200, { Items: this.items.filter((i) => `${i.SeriesName ?? ''} ${i.Name}`.toLowerCase().includes(q)) });
    }
    const play = url.pathname.match(/^\/Sessions\/([^/]+)\/Playing$/);
    if (req.method === 'POST' && play) {
      this.plays.push({ sessionId: decodeURIComponent(play[1]), itemIds: url.searchParams.get('itemIds'), command: url.searchParams.get('playCommand') });
      return send(204);
    }
    send(404, { error: 'not found' });
  }
}
