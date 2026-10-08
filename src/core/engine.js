// Background work: status polling, keep-awake pings and scheduled actions.

import { EventEmitter } from 'node:events';
import { EcpClient, EcpError } from './ecp.js';
import { INPUTS, describeSchedule } from './store.js';

export const STARTUP_GRACE_SECONDS = 15;
const KEY_GAP_MS = 400;
const POWER_ON_WAIT_TRIES = 20; // check once a second for up to 20 s
const SETTLE_AFTER_POWER_ON_MS = 3000; // a TV that just woke up needs a moment before it takes an app/input change
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
            await this.waitUntilOn(client, true);
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

  /** After PowerOn, wait until the TV reports it's on (and give it a moment to settle). */
  async waitUntilOn(client, wasOff) {
    for (let i = 0; i < POWER_ON_WAIT_TRIES; i++) {
      const info = await client.deviceInfo().catch(() => null);
      if (info && (info['power-mode'] || 'PowerOn') === 'PowerOn') break;
      await this.sleep(1000);
    }
    if (wasOff) await this.sleep(SETTLE_AFTER_POWER_ON_MS);
  }

  async isOn(client) {
    return client.deviceInfo().then((i) => (i['power-mode'] || 'PowerOn') === 'PowerOn').catch(() => false);
  }

  /**
   * Commands: ping, refresh, power_on, power_on_launch, power_off, home,
   * launch_target, open_app (opts.app = {id, name}), input_<hdmi1|...|tuner>.
   */
  async runCommand(device, command, source = 'Manual', opts = {}) {
    const target = this.store.settings().target_app;
    const client = this.clientFactory(device.host);

    if (command === 'ping') return this.keepAwake(device, true);
    if (command === 'refresh') return (await this.pollDevice(device)).activity;

    const openApp = async (app) => {
      await client.launch(app.id);
      return `Opened ${app.name || app.id}`;
    };

    let message;
    try {
      if (command === 'power_on' || command === 'power_on_launch') {
        const wasOn = command === 'power_on_launch' && await this.isOn(client);
        await client.keypress('PowerOn');
        message = 'Turned on';
        if (command === 'power_on_launch') {
          await this.waitUntilOn(client, !wasOn);
          message += ` and opened ${target.name}`;
          await client.launch(target.id);
        }
      } else if (command === 'power_off') {
        await client.keypress('PowerOff');
        message = 'Turned off';
      } else if (command === 'launch_target') {
        message = await openApp(target);
      } else if (command === 'open_app') {
        if (!opts.app?.id) throw new Error('No app chosen');
        message = await openApp(opts.app);
      } else if (command === 'home') {
        await client.keypress('Home');
        message = 'Went to Home screen';
      } else if (command.startsWith('input_') && INPUTS[command.slice(6)]) {
        const input = INPUTS[command.slice(6)];
        await client.keypress(input.key);
        message = `Switched to ${input.label}`;
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

  /** Carry out one schedule on one TV. */
  async runScheduleOn(device, sched, source) {
    const client = this.clientFactory(device.host);
    const followUp = sched.action === 'power_on' && sched.then && sched.then !== 'nothing';
    const wasOn = followUp && await this.isOn(client);
    const first = { power_on: 'power_on', power_off: 'power_off', open_app: 'open_app', input: `input_${sched.input}`, home: 'home' }[sched.action];

    await this.runCommand(device, first, source, { app: sched.app });

    if (followUp) {
      await this.waitUntilOn(client, !wasOn);
      const next = { app: 'open_app', input: `input_${sched.input}`, home: 'home' }[sched.then];
      await this.runCommand(device, next, source, { app: sched.app });
    }
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
    this.addLog('info', `${source} running: ${describeSchedule(sched)} on ${targets.length} TV(s)`);
    for (const d of targets) {
      this.submit(`schedule:${sched.id}:${d.id}`, () => this.runScheduleOn(d, sched, source).catch((e) => {
        if (!(e instanceof EcpError)) throw e; // ECP errors are already logged
      }));
    }
    return targets.length;
  }
}
