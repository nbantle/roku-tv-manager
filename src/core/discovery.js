// Find Roku devices on the local network.
//
//   * SSDP: the standard multicast search Roku devices answer ("roku:ecp"),
//     sent out of every network adapter on this computer.
//   * Subnet scan: a fallback that probes port 8060 on every address in a
//     subnet, for networks where multicast is blocked.

import dgram from 'node:dgram';
import net from 'node:net';
import os from 'node:os';
import { ECP_PORT, EcpClient } from './ecp.js';

const SSDP_HOST = '239.255.255.250';
const SSDP_PORT = 1900;
const SSDP_REQUEST = Buffer.from(
  'M-SEARCH * HTTP/1.1\r\n' +
  `Host: ${SSDP_HOST}:${SSDP_PORT}\r\n` +
  'Man: "ssdp:discover"\r\n' +
  'ST: roku:ecp\r\n' +
  'MX: 2\r\n' +
  '\r\n',
);
const MAX_SCAN_HOSTS = 1024;

export function parseSsdpLocation(packet) {
  for (const line of packet.toString('utf8').split('\r\n')) {
    const i = line.indexOf(':');
    if (i > 0 && line.slice(0, i).trim().toLowerCase() === 'location') {
      try {
        const url = new URL(line.slice(i + 1).trim());
        return { host: url.hostname, port: Number(url.port) || ECP_PORT };
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** Non-internal IPv4 addresses of this computer, with their netmasks. */
export function localAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal) out.push({ address: a.address, netmask: a.netmask });
    }
  }
  return out;
}

const toInt = (ip) => ip.split('.').reduce((n, part) => (n << 8) + Number(part), 0) >>> 0;
const toIp = (n) => [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.');

/** The /24 subnets this computer is on, e.g. ["192.168.1.0/24"]. */
export function localSubnets() {
  const subnets = new Set(localAddresses().map(({ address }) => toIp(toInt(address) & 0xffffff00) + '/24'));
  return [...subnets];
}

export function parseCidr(cidr) {
  const m = String(cidr).trim().match(/^(\d{1,3}(?:\.\d{1,3}){3})(?:\/(\d{1,2}))?$/);
  if (!m || m[1].split('.').some((p) => Number(p) > 255)) throw new Error(`"${cidr}" isn't a subnet like 192.168.1.0/24`);
  const prefix = m[2] === undefined ? 24 : Number(m[2]);
  if (prefix > 32) throw new Error(`"${cidr}" isn't a subnet like 192.168.1.0/24`);
  const size = 2 ** (32 - prefix);
  if (size > MAX_SCAN_HOSTS) throw new Error(`Subnet ${cidr} is too large to scan (max ${MAX_SCAN_HOSTS} addresses)`);
  const base = (toInt(m[1]) & (prefix === 0 ? 0 : (~0 << (32 - prefix)))) >>> 0;
  if (size <= 2) return Array.from({ length: size }, (_, i) => toIp(base + i));
  return Array.from({ length: size - 2 }, (_, i) => toIp(base + i + 1));
}

export function ssdpDiscover(timeoutMs = 3000) {
  const addresses = localAddresses();
  const found = new Map();
  const sockets = [];
  return new Promise((resolve) => {
    const finish = () => {
      for (const s of sockets) try { s.close(); } catch { /* already closed */ }
      resolve([...found.values()]);
    };
    // One socket per adapter, so the search goes out on the TV network even
    // when this computer also has a VPN or virtual adapter.
    for (const { address } of addresses.length ? addresses : [{ address: undefined }]) {
      const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      sockets.push(sock);
      sock.on('error', () => { /* adapter unusable; others may still work */ });
      sock.on('message', (msg) => {
        const loc = parseSsdpLocation(msg);
        if (loc) found.set(`${loc.host}:${loc.port}`, loc);
      });
      sock.bind({ address, port: 0 }, () => {
        try {
          sock.setMulticastTTL(2);
          if (address) sock.setMulticastInterface(address);
        } catch { /* best effort */ }
        const send = () => sock.send(SSDP_REQUEST, SSDP_PORT, SSDP_HOST, () => {});
        send();
        setTimeout(send, 300);
      });
    }
    setTimeout(finish, timeoutMs);
  });
}

function probe(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port, timeout: timeoutMs });
    const done = (ok) => { sock.destroy(); resolve(ok); };
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export async function scanSubnet(cidr, { port = ECP_PORT, timeoutMs = 500 } = {}) {
  const hosts = cidr ? parseCidr(cidr) : localSubnets().flatMap(parseCidr);
  const open = await pool(hosts, 64, (h) => probe(h, port, timeoutMs));
  return hosts.filter((_, i) => open[i]).map((host) => ({ host, port }));
}

/** device-info for host if it is a Roku, else null. */
export async function identify(host, port = ECP_PORT) {
  try {
    const info = await new EcpClient(host, port).deviceInfo();
    return info['serial-number'] || info['device-id'] ? info : null;
  } catch {
    return null;
  }
}

/** Rokus found on the network, as [{host, info}]. */
export async function discover(method = 'ssdp', subnet = '') {
  const candidates = method === 'ssdp' ? await ssdpDiscover() : await scanSubnet(subnet || null);
  const infos = await pool(candidates, 16, (c) => identify(c.host, c.port));
  return candidates.map((c, i) => ({ host: c.host, info: infos[i] })).filter((r) => r.info);
}
