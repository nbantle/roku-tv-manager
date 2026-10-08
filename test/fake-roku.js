// A tiny stand-in for a Roku TV's ECP server, for tests and demos.

import http from 'node:http';

export class FakeRoku {
  constructor({ serial = 'X001', name = 'Lobby TV', host = '127.0.0.1', port = 0 } = {}) {
    Object.assign(this, { serial, name, host });
    this.powerMode = 'PowerOn';
    this.app = ['592369', 'Jellyfin', 'appl']; // [id, name, type]; id null = home screen
    this.playerState = 'play';
    this.forbidden = false;
    this.presses = [];
    this.launches = [];
    this.onLaunch = null; // optional callback(appId), e.g. to make a fake Jellyfin session appear
    this.server = http.createServer((req, res) => this.handle(req, res));
    this.ready = new Promise((resolve) => this.server.listen(port, host, () => {
      this.port = this.server.address().port;
      resolve(this);
    }));
  }

  close() {
    return new Promise((r) => this.server.close(r));
  }

  handle(req, res) {
    const reply = (status, body = '') => {
      res.writeHead(status, { 'Content-Length': Buffer.byteLength(body) });
      res.end(body);
    };
    if (this.forbidden) return reply(403);
    if (req.method === 'GET') {
      const [id, name, type] = this.app;
      const xml = {
        '/query/device-info':
          `<?xml version="1.0" encoding="UTF-8" ?><device-info><serial-number>${this.serial}</serial-number>` +
          `<user-device-name>${this.name}</user-device-name><model-name>TCL 55S455</model-name>` +
          `<is-tv>true</is-tv><power-mode>${this.powerMode}</power-mode></device-info>`,
        '/query/active-app': id
          ? `<active-app><app id="${id}" type="${type}" version="1">${name}</app></active-app>`
          : '<active-app><app>Roku</app></active-app>',
        '/query/media-player': `<player error="false" state="${this.playerState}"><plugin id="592369" name="Jellyfin"/></player>`,
        '/query/apps': '<apps><app id="592369" type="appl" version="2">Jellyfin</app><app id="tvinput.hdmi1" type="tvin" version="1">HDMI 1</app></apps>',
      }[req.url];
      return xml ? reply(200, xml) : reply(404);
    }
    const [, kind, arg] = req.url.split('/');
    const key = decodeURIComponent(arg || '');
    if (kind === 'keypress') {
      this.presses.push(key);
      if (key === 'PowerOn') this.powerMode = 'PowerOn';
      else if (key === 'PowerOff') this.powerMode = 'DisplayOff';
      else if (key.startsWith('InputHDMI')) this.app = [`tvinput.hdmi${key.slice(-1)}`, `HDMI ${key.slice(-1)}`, 'tvin'];
      else if (key === 'Home') this.app = [null, 'Roku', null];
    } else if (kind === 'launch') {
      this.launches.push(key);
      this.onLaunch?.(key);
      this.app = [key, key === '592369' ? 'Jellyfin' : key, 'appl'];
    } else {
      return reply(404);
    }
    reply(200);
  }
}
