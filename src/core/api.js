// The app's API, shared by the desktop window (over IPC) and by phone access
// (over HTTP). handle(method, path, body) -> { status, body }.

import * as discovery from './discovery.js';
import { EcpClient, EcpError } from './ecp.js';
import { KEEPALIVE_KEYS, SCHEDULE_ACTIONS, ValidationError } from './store.js';

const DEVICE_COMMANDS = new Set([
  'ping', 'refresh', 'power_on', 'power_on_launch', 'power_off',
  'launch_target', 'home', 'input_hdmi1', 'input_hdmi2', 'input_hdmi3', 'input_hdmi4',
]);

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
      settings,
      devices: store.devices().map((d) => deviceView(d, settings)),
      schedules: store.schedules(),
      log: engine.recentLog(),
      app: appInfo(),
      options: { keepalive_keys: KEEPALIVE_KEYS, schedule_actions: SCHEDULE_ACTIONS },
    };
  });

  route('PUT', '/api/settings', (body) => store.updateSettings(body));

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
    const allowed = Object.fromEntries(['name', 'keepawake_enabled', 'interval_minutes'].filter((k) => k in body).map((k) => [k, body[k]]));
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
    try {
      return { message: await engine.runCommand(device, body.command) };
    } catch (e) {
      if (e instanceof EcpError) throw new ApiError(502, e.message);
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
