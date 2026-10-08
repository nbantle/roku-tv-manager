// The app's API, shared by the desktop window (over IPC) and by phone access
// (over HTTP). handle(method, path, body) -> { status, body }.

import * as discovery from './discovery.js';
import { EcpClient, EcpError } from './ecp.js';
import { JellyfinError } from './jellyfin.js';
import {
  CARD_COLORS, INPUTS, KEEPALIVE_KEYS, REMOTE_KEYS, SCHEDULE_ACTIONS, SCHEDULE_THEN, ValidationError, describeSchedule,
} from './store.js';

const DEVICE_COMMANDS = new Set([
  'ping', 'refresh', 'power_on', 'power_on_launch', 'power_off', 'launch_target', 'home', 'key', 'jellyfin_play',
  ...Object.keys(INPUTS).map((k) => `input_${k}`),
]);
// Commands the "all TVs" buttons can send.
const BULK_COMMANDS = new Set(['ping', 'power_on', 'power_off', 'launch_target', 'home', ...Object.keys(INPUTS).map((k) => `input_${k}`)]);

/** Settings as shown to the page: the Jellyfin API key never leaves this computer. */
function publicSettings(settings) {
  const { api_key: key, ...jellyfin } = settings.jellyfin;
  return { ...settings, jellyfin: { ...jellyfin, has_api_key: !!key } };
}

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function createApi(store, engine, { discover = discovery.discover, appInfo = () => ({}), makeClient = (h) => new EcpClient(h) } = {}) {
  const routes = [];
  const route = (method, pattern, fn) => routes.push({ method, re: new RegExp(`^${pattern}$`), fn });

  const deviceOr404 = (id) => {
    const d = store.device(id);
    if (!d) throw new ApiError(404, 'TV not found');
    return d;
  };

  const deviceView = (d, settings) => ({
    ...d,
    status: engine.statusOf(d.id),
    ping: engine.pingInfo(d.id),
    next_ping_at: engine.nextPingAt(d, settings),
    effective_interval_minutes: d.interval_minutes || settings.keepawake.interval_minutes,
  });

  route('GET', '/api/state', () => {
    const settings = store.settings();
    return {
      server_time: engine.clock(),
      settings: publicSettings(settings),
      in_charge: engine.inCharge(settings),
      groups: store.groups(),
      jellyfin: { configured: !!engine.jellyfinClient(settings), error: engine.jf.error },
      devices: store.devices().map((d) => deviceView(d, settings)),
      schedules: store.schedules().map((s) => ({ ...s, summary: describeSchedule(s) })),
      log: engine.recentLog(),
      app: appInfo(),
      options: {
        keepalive_keys: KEEPALIVE_KEYS,
        schedule_actions: SCHEDULE_ACTIONS,
        schedule_then: SCHEDULE_THEN,
        inputs: Object.fromEntries(Object.entries(INPUTS).map(([k, v]) => [k, v.label])),
        remote_keys: REMOTE_KEYS,
        card_colors: CARD_COLORS,
      },
    };
  });

  route('PUT', '/api/settings', (body) => {
    // An empty key field means "leave the saved key alone" (the page never sees it).
    if (body.jellyfin && body.jellyfin.api_key === '') {
      const { api_key: _, ...rest } = body.jellyfin;
      body = { ...body, jellyfin: rest };
    }
    return publicSettings(store.updateSettings(body));
  });

  route('POST', '/api/discover', async (body) => {
    const method = body.method ?? 'ssdp';
    if (!['ssdp', 'scan'].includes(method)) throw new ApiError(400, 'method must be ssdp or scan');
    let found;
    try {
      found = await discover(method, body.subnet || store.settings().discovery_subnet);
    } catch (e) {
      throw new ApiError(400, `Discovery failed: ${e.message}`);
    }
    const added = [];
    for (const { host, info } of found) {
      const { device, created } = store.upsertDeviceFromInfo(host, info);
      if (created) {
        added.push(device.name);
        engine.addLog('info', `Discovered at ${host}`, device);
      }
      engine.submit(`poll:${device.id}`, () => engine.pollDevice(device));
    }
    return { found: found.length, added };
  });

  route('POST', '/api/devices', async (body) => {
    const host = String(body.host ?? '').trim();
    if (!/^[A-Za-z0-9.-]{1,253}$/.test(host)) throw new ApiError(400, "Enter the TV's IP address, e.g. 192.168.1.50");
    let info;
    try {
      info = await makeClient(host).deviceInfo();
    } catch (e) {
      throw new ApiError(400, e.message);
    }
    const { device, created } = store.upsertDeviceFromInfo(host, info);
    engine.addLog('info', created ? `Added manually at ${host}` : `Address updated to ${host}`, device);
    engine.submit(`poll:${device.id}`, () => engine.pollDevice(device));
    return device;
  });

  route('PATCH', '/api/devices/([^/]+)', (body, m) => {
    deviceOr404(m[1]);
    const allowed = Object.fromEntries(['name', 'keepawake_enabled', 'interval_minutes', 'color', 'group'].filter((k) => k in body).map((k) => [k, body[k]]));
    return store.updateDevice(m[1], allowed);
  });

  route('DELETE', '/api/devices/([^/]+)', (body, m) => {
    const device = deviceOr404(m[1]);
    store.removeDevice(m[1]);
    engine.addLog('info', 'Removed from the app', device);
    return { ok: true };
  });

  route('POST', '/api/devices/([^/]+)/command', async (body, m) => {
    const device = deviceOr404(m[1]);
    if (!DEVICE_COMMANDS.has(body.command)) throw new ApiError(400, 'Unknown command');
    if (body.command === 'key' && !REMOTE_KEYS.includes(body.key)) throw new ApiError(400, 'Unknown remote button');
    if (body.command === 'jellyfin_play' && !(body.item && typeof body.item.id === 'string' && body.item.id)) {
      throw new ApiError(400, 'Choose something to play');
    }
    const opts = { key: body.key, item: body.item ? { id: body.item.id, name: String(body.item.name ?? '') } : undefined };
    try {
      return { message: await engine.runCommand(device, body.command, 'Manual', opts) };
    } catch (e) {
      if (e instanceof EcpError || e instanceof JellyfinError) throw new ApiError(502, e.message);
      throw e;
    }
  });

  // The "all TVs" / group buttons: run one command on several TVs at once.
  route('POST', '/api/bulk', async (body) => {
    if (!BULK_COMMANDS.has(body.command)) throw new ApiError(400, 'Unknown command');
    if (!Array.isArray(body.device_ids) || !body.device_ids.length) throw new ApiError(400, 'No TVs chosen');
    const devices = body.device_ids.map((id) => store.device(id)).filter(Boolean);
    const results = await Promise.all(devices.map((d) => engine.runCommand(d, body.command, 'All TVs')
      .then(() => null)
      .catch((e) => ({ name: d.name, error: e.message }))));
    const failed = results.filter(Boolean);
    return { ok: devices.length - failed.length, failed };
  });

  route('POST', '/api/jellyfin/test', async () => {
    const jf = engine.jellyfinClient();
    if (!jf) throw new ApiError(400, 'Enter the Jellyfin address and API key first.');
    try {
      const info = await jf.info();
      const sessions = (await jf.sessions()) || [];
      const tvs = store.devices().filter((d) => engine.jellyfinSession(d, sessions)).map((d) => d.name);
      return { ...info, tvs };
    } catch (e) {
      if (e instanceof JellyfinError) throw new ApiError(502, e.message);
      throw e;
    }
  });

  route('POST', '/api/jellyfin/search', async (body) => {
    const jf = engine.jellyfinClient();
    if (!jf) throw new ApiError(400, 'Set up Jellyfin in Settings first.');
    const q = String(body.q ?? '').trim();
    if (!q) return { items: [] };
    try {
      return { items: await jf.search(q.slice(0, 100)) };
    } catch (e) {
      if (e instanceof JellyfinError) throw new ApiError(502, e.message);
      throw e;
    }
  });

  route('GET', '/api/devices/([^/]+)/apps', async (body, m) => {
    const device = deviceOr404(m[1]);
    try {
      return { apps: (await makeClient(device.host).apps()).filter((a) => a.type === 'appl') };
    } catch (e) {
      throw new ApiError(502, e.message);
    }
  });

  // Apps installed on the TVs (combined), for choosing what a schedule opens.
  route('GET', '/api/apps', async () => {
    const target = store.settings().target_app;
    const lists = await Promise.all(store.devices().map((d) => makeClient(d.host).apps().catch(() => [])));
    const apps = new Map([[target.id, { id: target.id, name: target.name }]]);
    for (const a of lists.flat()) if (a.type === 'appl' && !apps.has(a.id)) apps.set(a.id, { id: a.id, name: a.name });
    const [first, ...rest] = apps.values();
    return { apps: [first, ...rest.sort((a, b) => a.name.localeCompare(b.name))], target_id: target.id };
  });

  route('POST', '/api/schedules', (body) => store.addSchedule(body));

  route('PUT', '/api/schedules/([^/]+)', (body, m) => {
    const s = store.updateSchedule(m[1], body);
    if (!s) throw new ApiError(404, 'Schedule not found');
    return s;
  });

  route('DELETE', '/api/schedules/([^/]+)', (body, m) => {
    if (!store.removeSchedule(m[1])) throw new ApiError(404, 'Schedule not found');
    return { ok: true };
  });

  route('POST', '/api/schedules/([^/]+)/run', (body, m) => {
    const s = store.schedule(m[1]);
    if (!s) throw new ApiError(404, 'Schedule not found');
    return { tvs: engine.runSchedule(s) };
  });

  return async function handle(method, path, body = {}) {
    try {
      if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, 'Expected a JSON object');
      for (const r of routes) {
        const m = r.method === method && path.match(r.re);
        if (m) return { status: 200, body: await r.fn(body, m.map((x) => (x === undefined ? x : decodeURIComponent(x)))) };
      }
      throw new ApiError(404, 'Not found');
    } catch (e) {
      if (e instanceof ApiError) return { status: e.status, body: { error: e.message } };
      if (e instanceof ValidationError) return { status: 400, body: { error: e.message } };
      engine.addLog('error', `Unexpected error: ${e.message}`);
      return { status: 500, body: { error: 'Something went wrong. See the Activity tab.' } };
    }
  };
}
