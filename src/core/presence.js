// Lets copies of the app on the same network see each other, so two
// computers don't both ping the TVs and run schedules.
//
// Every copy broadcasts a small UDP message every 15 seconds and listens for
// the others. Emits "change" whenever the list of other copies changes.

import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import os from 'node:os';

export const PRESENCE_PORT = 41237;
const APP_TAG = 'roku-tv-manager';

const toInt = (ip) => ip.split('.').reduce((n, p) => (n << 8) + Number(p), 0) >>> 0;
const toIp = (n) => [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.');

/** The broadcast address of every network this computer is on. */
export function broadcastTargets(port = PRESENCE_PORT) {
  const out = new Set();
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal && a.netmask) {
        out.add(toIp((toInt(a.address) | (~toInt(a.netmask) >>> 0)) >>> 0));
      }
    }
  }
  return [...out].map((host) => ({ host, port }));
}

export class Presence extends EventEmitter {
  constructor({
    instanceId, name, version, getRole,
    port = PRESENCE_PORT, targets = () => broadcastTargets(port),
    intervalMs = 15000, ttlMs = 50000, clock = () => Date.now(),
  }) {
    super();
    Object.assign(this, { instanceId, name, version, getRole, port, targets, intervalMs, ttlMs, clock });
    this.others = new Map();
    this.socket = null;
    this.timer = null;
    this.error = null;
  }

  start() {
    return new Promise((resolve) => {
      const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      this.socket = sock;
      sock.on('message', (msg, rinfo) => this.receive(msg, rinfo));
      sock.once('error', (e) => {
        this.error = `Couldn’t listen for other copies of the app (${e.code || e.message}).`;
        this.emit('change');
        resolve(false);
      });
      sock.bind(this.port, () => {
        try { sock.setBroadcast(true); } catch { /* best effort */ }
        this.announce();
        this.timer = setInterval(() => {
          this.announce();
          this.prune();
        }, this.intervalMs);
        resolve(true);
      });
    });
  }

  stop() {
    clearInterval(this.timer);
    if (this.socket) {
      this.announce(true);
      const sock = this.socket;
      this.socket = null;
      setTimeout(() => { try { sock.close(); } catch { /* closed */ } }, 50);
    }
  }

  message(bye = false) {
    return Buffer.from(JSON.stringify({ app: APP_TAG, v: 1, id: this.instanceId, name: this.name, role: this.getRole(), version: this.version, bye }));
  }

  /** Send our heartbeat now (also call this when our role changes). */
  announce(bye = false) {
    if (!this.socket) return;
    const msg = this.message(bye);
    for (const { host, port } of this.targets()) this.socket.send(msg, port, host, () => {});
  }

  receive(msg, rinfo) {
    let m;
    try {
      m = JSON.parse(msg.toString('utf8'));
    } catch {
      return;
    }
    if (m?.app !== APP_TAG || !m.id || m.id === this.instanceId) return;
    const before = this.others.get(m.id);
    if (m.bye) {
      if (this.others.delete(m.id)) this.emit('change');
      return;
    }
    const peer = { id: m.id, name: String(m.name || rinfo.address).slice(0, 80), role: m.role === 'monitor' ? 'monitor' : 'control', version: String(m.version || ''), address: rinfo.address, seen: this.clock() };
    this.others.set(m.id, peer);
    if (!before || before.role !== peer.role || before.name !== peer.name) this.emit('change');
  }

  prune() {
    const now = this.clock();
    let changed = false;
    for (const [id, p] of this.others) {
      if (now - p.seen > this.ttlMs) {
        this.others.delete(id);
        changed = true;
      }
    }
    if (changed) this.emit('change');
  }

  /** Other copies seen recently. */
  peers() {
    this.prune();
    return [...this.others.values()].map(({ id, name, role, version, address }) => ({ id, name, role, version, address }));
  }
}
