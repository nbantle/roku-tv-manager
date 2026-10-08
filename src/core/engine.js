// Background work: status polling, keep-awake pings and scheduled actions.

import { EventEmitter } from 'node:events';
import { EcpClient, EcpError } from './ecp.js';
import { SCHEDULE_ACTIONS } from './store.js';

export const STARTUP_GRACE_SECONDS = 15;
const KEY_GAP_MS = 400;
const LAUNCH_AFTER_POWER_ON_MS = 6000;

const INPUT_KEYS = { input_hdmi1: 'InputHDMI1', input_hdmi2: 'InputHDMI2', input_hdmi3: 'InputHDMI3', input_hdmi4: 'InputHDMI4' };
const PLAYBACK = { play: 'Playing', pause: 'Paused', buffer: 'Buffering' };

/** Turn raw ECP query results into a status the UI can show. */
export function describeStatus(info, app, player, targetAppId) {
  const powerMode = info['power-mode'] || 'PowerOn';
  const status = {
    reachable: true,
    power: powerMode === 'PowerOn' ? 'on' : 'standby',
    power_mode: powerMode,
    app_id: null,
    app_name: null,
    activity_kind: 'off',
    activity: 'Off (standby)',
    on_target: false,
    playback: null,
    error: null,
  };
  if (status.power !== 'on') return status;
  if (!app) return { ...status, activity_kind: 'unknown', activity: 'On' };

  const id = app.id;
  const name = app.name || '';
  status.app_id = id;
  status.app_name = name;
  if (!id) {
    Object.assign(status, { activity_kind: 'home', activity: 'Home screen' });
  } else if (id.startsWith('tvinput.')) {
    const source = id.slice('tvinput.'.length);
    const fallback = source.startsWith('hdmi') ? `HDMI ${source.slice(4)}` : ({ dtv: 'Live TV', cvbs: 'AV' }[source] ?? source);
    const label = !name || name === fallback ? fallback : `${fallback} (${name})`;
    Object.assign(status, { activity_kind: 'input', activity: label });
  } else {
    Object.assign(status, { activity_kind: 'app', activity: name || id, on_target: id === targetAppId });
    if (player && PLAYBACK[player.state]) status.playback = PLAYBACK[player.state];
  }
  if (app.screensaver) {
    status.activity_kind = 'screensaver';
    status.activity = `Screensaver over ${status.activity}`;
  }
  return status;
}

export function offlineStatus(error) {
  return {
    reachable: false,
    power: 'offline',
    power_mode: null,
    app_id: null,
    app_name: null,
    activity_kind: 'offline',
    activity: 'Not responding',
    on_target: false,
    playback: null,
    error: String(error?.message ?? error),
  };
}

/** Emits "log" (entry) for each activity-log line. */
export class Engine extends EventEmitter {
  constructor(store, {
    clientFactory = (host) => new EcpClient(host),
    clock = () => Date.now() / 1000,
    localNow = () => new Date(),
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = {}) {
    super();
    this.store = store;
    this.clientFactory = clientFactory;
    this.clock = clock;
    this.localNow = localNow;
    this.sleep = sleep;
    this.startedAt = clock();
    this.log = [];
    this.status = new Map(); // device id -> status
    this.pings = new Map(); // device id -> { last_at, last_result }
    this.fired = new Map(); // schedule id -> "YYYY-MM-DD HH:MM" it last fired
    this.inflight = new Map(); // task key -> promise
    this.nextPoll = 0;
    this.timer = null;
  }

  // ---------- lifecycle ----------

  start() {
    this.timer = setInterval(() => {
      try {
        this.tick();
      } catch (e) {
        this.addLog('error', `Engine error: ${e.message}`);
      }
    }, 1000);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  submit(key, fn) {
    if (this.inflight.has(key)) return this.inflight.get(key);
    const p = (async () => {
      try {
        return await fn();
      } catch (e) {
        this.addLog('error', `${key.split(':')[0]} failed: ${e.message}`);
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, p);
    return p;
  }

  /** Resolves when all background work has finished (used by tests). */
  async idle() {
    while (this.inflight.size) await Promise.all([...this.inflight.values()]);
  }

  // ---------- log ----------

  addLog(level, message, device = null) {
    const entry = { at: this.clock(), level, device: device ? device.name : null, message };
    this.log.push(entry);
    if (this.log.length > 300) this.log.splice(0, this.log.length - 300);
    this.emit('log', entry);
    return entry;
  }

  recentLog(limit = 150) {
    return this.log.slice(-limit).reverse();
  }

  // ---------- the 1-second tick ----------

  intervalSeconds(device, settings) {
    return (device.interval_minutes || settings.keepawake.interval_minutes) * 60;
  }

  nextPingAt(device, settings) {
    if (!settings.keepawake.enabled || !device.keepawake_enabled) return null;
    const last = this.pings.get(device.id)?.last_at ?? null;
    if (last === null) return this.startedAt + STARTUP_GRACE_SECONDS;
    return last + this.intervalSeconds(device, settings);
  }

  tick() {
    const now = this.clock();
    const settings = this.store.settings();
    const devices = this.store.devices();

    if (now >= this.nextPoll) {
      this.nextPoll = now + settings.status_poll_seconds;
      for (const d of devices) this.submit(`poll:${d.id}`, () => this.pollDevice(d));
    }

    for (const d of devices) {
      const due = this.nextPingAt(d, settings);
      if (due !== null && now >= due) {
        this.markPinged(d.id, now); // claim it so the next tick doesn't re-submit
        this.submit(`keepawake:${d.id}`, () => this.keepAwake(d));
      }
    }

    this.checkSchedules(devices);
  }

  markPinged(id, at, result) {
    const entry = this.pings.get(id) ?? { last_at: null, last_result: null };
    entry.last_at = at;
    if (result !== undefined) entry.last_result = result;
    this.pings.set(id, entry);
  }

  pingInfo(id) {
    return { ...(this.pings.get(id) ?? { last_at: null, last_result: null }) };
  }

  statusOf(id) {
    return this.status.get(id) ?? null;
  }

  // ---------- status ----------

  async pollDevice(device) {
    const settings = this.store.settings();
    const client = this.clientFactory(device.host);
    let status;
    try {
      const info = await client.deviceInfo();
      let app = null;
      let player = null;
      if ((info['power-mode'] || 'PowerOn') === 'PowerOn') {
        app = await client.activeApp().catch(() => null);
        if (app?.id && !app.id.startsWith('tvinput.')) player = await client.mediaPlayer().catch(() => null);
      }
      status = describeStatus(info, app, player, settings.target_app.id);
    } catch (e) {
      if (!(e instanceof EcpError)) throw e;
      status = offlineStatus(e);
    }
    status.checked_at = this.clock();

    const previous = this.status.get(device.id);
    this.status.set(device.id, status);
    if (!previous) {
      this.addLog('info', `Status: ${status.activity}`, device);
    } else if (previous.power !== status.power || previous.activity !== status.activity) {
      this.addLog('info', `${previous.activity} → ${status.activity}`, device);
    }
    return status;
  }

  // ---------- keep-awake ----------

  /** Decide what to do for one TV and do it. Returns a short description. */
  async keepAwake(device, manual = false) {
    const settings = this.store.settings();
    const ka = settings.keepawake;
    const target = settings.target_app;
    device = this.store.device(device.id) ?? device;
    const status = await this.pollDevice(device); // always act on fresh state
    const client = this.clientFactory(device.host);

    let result;
    try {
      if (!status.reachable) {
        result = 'Skipped: TV not responding';
      } else if (status.power !== 'on') {
        if (manual || ka.when_off === 'leave_off') {
          result = 'Left off (TV is off)';
        } else if (device.held_off) {
          result = 'Left off (turned off by schedule or by hand)';
        } else {
          await client.keypress('PowerOn');
          result = 'TV was off — turned it on';
          if (ka.when_off === 'power_on_launch') {
            await this.sleep(LAUNCH_AFTER_POWER_ON_MS);
            await client.launch(target.id);
            result += ` and opened ${target.name}`;
          }
        }
      } else if (!status.on_target && ka.when_other_app === 'launch_target' && !manual) {
        await client.launch(target.id);
        result = `Switched from ${status.activity} to ${target.name}`;
      } else if (!status.on_target && ka.only_when === 'target_app' && !manual) {
        result = `Skipped: ${target.name} isn't open (${status.activity})`;
      } else {
        for (const [i, key] of ka.keys.entries()) {
          if (i) await this.sleep(KEY_GAP_MS);
          await client.keypress(key);
        }
        result = `Pinged (${ka.keys.join(', ')})`;
      }
    } catch (e) {
      if (!(e instanceof EcpError)) throw e;
      result = `Failed: ${e.message}`;
    }

    this.markPinged(device.id, this.clock(), result);
    this.addLog(result.startsWith('Failed') ? 'error' : 'info', (manual ? 'Ping now: ' : 'Keep-awake: ') + result, device);
    return result;
  }

  // ---------- commands ----------

  async runCommand(device, command, source = 'Manual') {
    const target = this.store.settings().target_app;
    const client = this.clientFactory(device.host);

    if (command === 'ping') return this.keepAwake(device, true);
    if (command === 'refresh') return (await this.pollDevice(device)).activity;

    let message;
    try {
      if (command === 'power_on') {
        await client.keypress('PowerOn');
        message = 'Turned on';
      } else if (command === 'power_on_launch') {
        await client.keypress('PowerOn');
        await this.sleep(LAUNCH_AFTER_POWER_ON_MS);
        await client.launch(target.id);
        message = `Turned on and opened ${target.name}`;
      } else if (command === 'power_off') {
        await client.keypress('PowerOff');
        message = 'Turned off';
      } else if (command === 'launch_target') {
        await client.launch(target.id);
        message = `Opened ${target.name}`;
      } else if (command === 'home') {
        await client.keypress('Home');
        message = 'Went to Home screen';
      } else if (INPUT_KEYS[command]) {
        await client.keypress(INPUT_KEYS[command]);
        message = `Switched to HDMI ${command.slice(-1)}`;
      } else {
        throw new Error(`Unknown command: ${command}`);
      }
    } catch (e) {
      if (e instanceof EcpError) this.addLog('error', `${source}: ${command} failed: ${e.message}`, device);
      throw e;
    }

    // Remember deliberate power changes so "turn back on" keep-awake mode
    // doesn't undo a scheduled or manual power-off.
    if (command === 'power_off') this.store.updateDevice(device.id, { held_off: true });
    else if (command === 'power_on' || command === 'power_on_launch') this.store.updateDevice(device.id, { held_off: false });

    this.addLog('info', `${source}: ${message}`, device);
    this.submit(`poll:${device.id}`, async () => {
      await this.sleep(2000);
      return this.pollDevice(device);
    });
    return message;
  }

  // ---------- scheduler ----------

  checkSchedules(devices) {
    const now = this.localNow();
    const pad = (n) => String(n).padStart(2, '0');
    const hhmm = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
    const minute = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${hhmm}`;
    const weekday = (now.getDay() + 6) % 7; // 0 = Monday
    for (const sched of this.store.schedules()) {
      if (!sched.enabled || sched.time !== hhmm || !sched.days.includes(weekday)) continue;
      if (this.fired.get(sched.id) === minute) continue;
      this.fired.set(sched.id, minute);
      this.runSchedule(sched, devices);
    }
  }

  runSchedule(sched, devices = this.store.devices()) {
    const targets = devices.filter((d) => sched.devices === 'all' || sched.devices.includes(d.id));
    const source = `Schedule “${sched.name}”`;
    this.addLog('info', `${source} running: ${SCHEDULE_ACTIONS[sched.action]} on ${targets.length} TV(s)`);
    for (const d of targets) {
      this.submit(`schedule:${sched.id}:${d.id}`, () => this.runCommand(d, sched.action, source).catch((e) => {
        if (!(e instanceof EcpError)) throw e; // ECP errors are already logged
      }));
    }
    return targets.length;
  }
}
