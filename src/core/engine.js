// Background work: status polling, keep-awake pings and scheduled actions.

import { EventEmitter } from 'node:events';
import { EcpClient, EcpError } from './ecp.js';
import { JellyfinClient, JellyfinError, nowPlaying, sessionForHost } from './jellyfin.js';
import { INPUTS, JELLYFIN_APP_ID, REMOTE_KEYS, describeSchedule, localDate } from './store.js';

export const STARTUP_GRACE_SECONDS = 15;
const KEY_GAP_MS = 400;
const POWER_ON_WAIT_TRIES = 20; // check once a second for up to 20 s
const SETTLE_AFTER_POWER_ON_MS = 3000; // a TV that just woke up needs a moment before it takes an app/input change
const PLAYBACK = { play: 'Playing', pause: 'Paused', buffer: 'Buffering' };
const OFFLINE_ALERT_AFTER = 2; // missed status checks in a row before "not responding" alerts
const OWN_CHANGE_SECONDS = 90; // changes this soon after the app sent a command are the app's own doing
const JELLYFIN_SESSION_TRIES = 30; // wait up to ~60 s for the TV's Jellyfin app to connect

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
    jellyfinFactory = (url, key) => new JellyfinClient(url, key),
    clock = () => Date.now() / 1000,
    localNow = () => new Date(),
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = {}) {
    super();
    this.store = store;
    this.clientFactory = clientFactory;
    this.jellyfinFactory = jellyfinFactory;
    this.clock = clock;
    this.localNow = localNow;
    this.sleep = sleep;
    this.startedAt = clock();
    this.log = [];
    this.status = new Map(); // device id -> status
    this.pings = new Map(); // device id -> { last_at, last_result }
    this.fired = new Map(); // schedule id -> "YYYY-MM-DD HH:MM" it last fired
    this.inflight = new Map(); // task key -> promise
    this.failures = new Map(); // device id -> missed status checks in a row
    this.lastCommandAt = new Map(); // device id -> when the app last changed this TV
    this.offlineAlerted = new Set(); // device ids we've sent a "not responding" alert for
    this.jf = { client: null, key: null, sessions: [], error: null };
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

  /** False when this copy is set to "Monitor only" (another computer is in charge). */
  inCharge(settings = this.store.settings()) {
    return settings.app.role !== 'monitor';
  }

  nextPingAt(device, settings) {
    if (!this.inCharge(settings) || !settings.keepawake.enabled || !device.keepawake_enabled) return null;
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
      this.submit('jellyfin:sessions', () => this.refreshJellyfin());
      for (const d of devices) this.submit(`poll:${d.id}`, () => this.pollDevice(d));
    }
    if (!this.inCharge(settings)) return; // monitor only: no pings, no schedules

    for (const d of devices) {
      const due = this.nextPingAt(d, settings);
      if (due !== null && now >= due) {
        this.markPinged(d.id, now); // claim it so the next tick doesn't re-submit
        this.submit(`keepawake:${d.id}`, () => this.keepAwake(d));
      }
    }

    this.checkSchedules();
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

  // ---------- Jellyfin ----------

  /** A client for the Jellyfin server in Settings, or null if it isn't set up. */
  jellyfinClient(settings = this.store.settings()) {
    const { url, api_key: key } = settings.jellyfin;
    if (!url || !key) return null;
    if (this.jf.key !== `${url}|${key}`) Object.assign(this.jf, { client: this.jellyfinFactory(url, key), key: `${url}|${key}`, error: null });
    return this.jf.client;
  }

  async refreshJellyfin() {
    const jf = this.jellyfinClient();
    if (!jf) return Object.assign(this.jf, { sessions: [], error: null });
    try {
      const sessions = await jf.sessions();
      if (this.jf.error) this.addLog('info', 'Jellyfin: connected again');
      Object.assign(this.jf, { sessions: sessions || [], error: null });
    } catch (e) {
      if (!(e instanceof JellyfinError)) throw e;
      if (this.jf.error !== e.message) this.addLog('error', `Jellyfin: ${e.message}`);
      Object.assign(this.jf, { sessions: [], error: e.message });
    }
  }

  /** The TV's Jellyfin session: matched by IP address, or by name if Jellyfin sits behind a proxy. */
  jellyfinSession(device, sessions = this.jf.sessions) {
    return sessionForHost(sessions, device.host)
      ?? sessions.find((x) => String(x.DeviceName || '').toLowerCase() === device.name.toLowerCase() && /roku/i.test(String(x.Client || ''))) ?? null;
  }

  // ---------- alerts ----------

  alert(kind, message, device) {
    this.addLog('warn', message, device);
    this.emit('alert', { kind, message, device: device.name });
  }

  ownChange(device) {
    return this.clock() - (this.lastCommandAt.get(device.id) ?? -Infinity) < OWN_CHANGE_SECONDS;
  }

  checkAlerts(device, previous, status) {
    const alerts = this.store.settings().alerts;
    const fails = status.reachable ? 0 : (this.failures.get(device.id) ?? 0) + 1;
    this.failures.set(device.id, fails);

    if (fails >= OFFLINE_ALERT_AFTER && !this.offlineAlerted.has(device.id)) {
      this.offlineAlerted.add(device.id);
      if (alerts.offline) this.alert('offline', `${device.name} isn\u2019t responding`, device);
    } else if (status.reachable && this.offlineAlerted.delete(device.id) && alerts.offline) {
      this.alert('online', `${device.name} is responding again`, device);
    }
    if (!previous || this.ownChange(device)) return;
    if (alerts.turned_off && previous.power === 'on' && status.power === 'standby') {
      this.alert('turned_off', `${device.name} was turned off`, device);
    }
    if (alerts.left_target && previous.on_target && status.power === 'on' && !status.on_target) {
      this.alert('left_target', `${device.name} switched from ${previous.activity} to ${status.activity}`, device);
    }
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
      if (status.power === 'on' && status.app_id === JELLYFIN_APP_ID) {
        status.jellyfin = nowPlaying(this.jellyfinSession(device));
      }
    } catch (e) {
      if (!(e instanceof EcpError)) throw e;
      status = offlineStatus(e);
    }
    status.checked_at = this.clock();

    const previous = this.status.get(device.id);
    this.status.set(device.id, status);
    this.checkAlerts(device, previous, status);
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
          this.lastCommandAt.set(device.id, this.clock());
          await client.keypress('PowerOn');
          result = 'TV was off — turned it on';
          if (ka.when_off === 'power_on_launch') {
            await this.waitUntilOn(client, true);
            await client.launch(target.id);
            result += ` and opened ${target.name}`;
          }
        }
      } else if (!status.on_target && ka.when_other_app === 'launch_target' && !manual) {
        this.lastCommandAt.set(device.id, this.clock());
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
    this.lastCommandAt.set(device.id, this.clock());

    if (command === 'key') {
      // Mini remote: no log line per button press.
      if (!REMOTE_KEYS.includes(opts.key)) throw new Error('Unknown remote button');
      await client.keypress(opts.key);
      this.submit(`poll:${device.id}`, async () => {
        await this.sleep(1000);
        return this.pollDevice(device);
      });
      return opts.key;
    }

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
      } else if (command === 'jellyfin_play') {
        message = await this.playFromJellyfin(device, client, opts.item);
      } else if (command.startsWith('input_') && INPUTS[command.slice(6)]) {
        const input = INPUTS[command.slice(6)];
        await client.keypress(input.key);
        message = `Switched to ${input.label}`;
      } else {
        throw new Error(`Unknown command: ${command}`);
      }
    } catch (e) {
      if (e instanceof EcpError || e instanceof JellyfinError) this.addLog('error', `${source}: ${command} failed: ${e.message}`, device);
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

  /** Open Jellyfin on the TV if needed, wait for it to connect, then play `item`. */
  async playFromJellyfin(device, client, item) {
    if (!item?.id) throw new Error('Nothing chosen to play');
    const jf = this.jellyfinClient();
    if (!jf) throw new JellyfinError('Set up the Jellyfin server in Settings first.');
    let session = this.jellyfinSession(device, await jf.sessions());
    if (!session) {
      await client.launch(JELLYFIN_APP_ID);
      for (let i = 0; i < JELLYFIN_SESSION_TRIES && !session; i++) {
        await this.sleep(2000);
        session = this.jellyfinSession(device, await jf.sessions());
      }
      if (!session) throw new JellyfinError(`Jellyfin opened on ${device.name}, but it never connected to the server. Is it signed in?`);
    }
    await jf.play(session.Id, item.id);
    return `Playing \u201c${item.name || item.id}\u201d from Jellyfin`;
  }

  /** Carry out one schedule on one TV. */
  async runScheduleOn(device, sched, source) {
    const client = this.clientFactory(device.host);
    const followUp = sched.action === 'power_on' && sched.then && sched.then !== 'nothing';
    const wasOn = followUp && await this.isOn(client);
    const commandFor = (kind) => ({
      power_on: 'power_on', power_off: 'power_off', open_app: 'open_app', app: 'open_app',
      input: `input_${sched.input}`, home: 'home', jellyfin: 'jellyfin_play',
    }[kind]);
    const opts = { app: sched.app, item: sched.item };

    await this.runCommand(device, commandFor(sched.action), source, opts);
    if (followUp) {
      await this.waitUntilOn(client, !wasOn);
      await this.runCommand(device, commandFor(sched.then), source, opts);
    }
  }

  // ---------- scheduler ----------

  checkSchedules() {
    const now = this.localNow();
    const pad = (n) => String(n).padStart(2, '0');
    const hhmm = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
    const today = localDate(now);
    const weekday = (now.getDay() + 6) % 7; // 0 = Monday
    for (const sched of this.store.schedules()) {
      if (!sched.enabled || sched.time !== hhmm) continue;
      const due = sched.repeat === 'once' ? sched.date === today : sched.days.includes(weekday);
      if (!due || this.fired.get(sched.id) === `${today} ${hhmm}`) continue;
      this.fired.set(sched.id, `${today} ${hhmm}`);
      this.runSchedule(sched);
      this.store.finishOnce(sched.id);
    }
  }

  runSchedule(sched) {
    const targets = this.store.scheduleTargets(sched);
    const source = `Schedule \u201c${sched.name}\u201d`;
    this.addLog('info', `${source} running: ${describeSchedule(sched)} on ${targets.length} TV(s)`);
    for (const d of targets) {
      this.submit(`schedule:${sched.id}:${d.id}`, () => this.runScheduleOn(d, sched, source).catch((e) => {
        if (!(e instanceof EcpError) && !(e instanceof JellyfinError)) throw e; // those are already logged
      }));
    }
    return targets.length;
  }
}
