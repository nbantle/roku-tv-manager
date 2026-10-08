// Persistent configuration: settings, known TVs and schedules (one JSON file).

import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const JELLYFIN_APP_ID = '592369';

export const DEFAULT_SETTINGS = {
  status_poll_seconds: 15,
  discovery_subnet: '',
  target_app: { id: JELLYFIN_APP_ID, name: 'Jellyfin' },
  keepawake: {
    enabled: true,
    interval_minutes: 30,
    keys: ['VolumeDown', 'VolumeUp'],
    only_when: 'any', // "any": every TV that's on; "target_app": only while the target app is open
    when_off: 'leave_off', // "leave_off" | "power_on" | "power_on_launch"
    when_other_app: 'leave', // "leave" | "launch_target"
  },
  app: {
    prevent_sleep: true, // keep this computer from sleeping so pings keep going
    remote_access: false, // let phones/other computers open the dashboard in a browser
    remote_port: 8765,
  },
};

// Remote buttons allowed in the keep-awake sequence. Power and Home are left
// out on purpose: a keep-awake press must never change what the TV is doing.
export const KEEPALIVE_KEYS = [
  'Back', 'Backspace', 'ChannelDown', 'ChannelUp', 'Down', 'Enter', 'Fwd', 'Info',
  'InstantReplay', 'Left', 'Play', 'Rev', 'Right', 'Search', 'Select', 'Up',
  'VolumeDown', 'VolumeMute', 'VolumeUp',
];

// TV inputs the app can switch to (ECP key names).
export const INPUTS = {
  hdmi1: { key: 'InputHDMI1', label: 'HDMI 1' },
  hdmi2: { key: 'InputHDMI2', label: 'HDMI 2' },
  hdmi3: { key: 'InputHDMI3', label: 'HDMI 3' },
  hdmi4: { key: 'InputHDMI4', label: 'HDMI 4' },
  av1: { key: 'InputAV1', label: 'AV' },
  tuner: { key: 'InputTuner', label: 'Live TV (antenna)' },
};

export const SCHEDULE_ACTIONS = {
  power_on: 'Turn on',
  power_off: 'Turn off',
  open_app: 'Open an app',
  input: 'Switch input',
  home: 'Go to Home screen',
};

// What a "Turn on" schedule does once the TV is on.
export const SCHEDULE_THEN = {
  nothing: 'Nothing (whatever was showing last)',
  app: 'Open an app',
  input: 'Switch to an input',
  home: 'Go to Home screen',
};

/** One-line description, e.g. "Turn on, then open Jellyfin". */
export function describeSchedule(s) {
  const step = (kind) => ({
    app: `open ${s.app?.name || s.app?.id}`,
    input: `switch to ${INPUTS[s.input]?.label ?? s.input}`,
    home: 'go to the Home screen',
  }[kind]);
  switch (s.action) {
    case 'power_on': return s.then && s.then !== 'nothing' ? `Turn on, then ${step(s.then)}` : 'Turn on';
    case 'power_off': return 'Turn off';
    case 'open_app': return `Open ${s.app?.name || s.app?.id}`;
    case 'input': return `Switch to ${INPUTS[s.input]?.label ?? s.input}`;
    case 'home': return 'Go to the Home screen';
    default: return s.action;
  }
}

/** Convert schedules saved by version 1.0 to the current format. */
export function migrateSchedule(s, targetApp) {
  const target = { id: targetApp.id, name: targetApp.name };
  if (s.action === 'power_on_launch') return { ...s, action: 'power_on', then: 'app', app: target };
  if (s.action === 'launch_target') return { ...s, action: 'open_app', app: target };
  if (/^input_hdmi[1-4]$/.test(s.action)) return { ...s, action: 'input', input: s.action.slice(6) };
  return s;
}

export class ValidationError extends Error {}

const clone = (v) => structuredClone(v);

function choice(value, options, field) {
  if (!options.includes(value)) throw new ValidationError(`${field} must be one of: ${options.join(', ')}`);
  return value;
}

function int(value, lo, hi, field) {
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new ValidationError(`${field} must be a whole number`);
  if (value < lo || value > hi) throw new ValidationError(`${field} must be between ${lo} and ${hi}`);
  return value;
}

function str(value, field, maxLen = 100) {
  if (typeof value !== 'string') throw new ValidationError(`${field} must be text`);
  const v = value.trim();
  if (v.length > maxLen) throw new ValidationError(`${field} is too long`);
  return v;
}

function bool(value, field) {
  if (typeof value !== 'boolean') throw new ValidationError(`${field} must be true or false`);
  return value;
}

function obj(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError(`${field} must be an object`);
  return value;
}

/** Merge a partial settings update into current settings, validating it. */
export function validateSettings(current, patch) {
  const s = clone(current);
  obj(patch, 'Settings');
  if ('status_poll_seconds' in patch) s.status_poll_seconds = int(patch.status_poll_seconds, 5, 3600, 'Status refresh');
  if ('discovery_subnet' in patch) s.discovery_subnet = str(patch.discovery_subnet, 'Discovery subnet', 50);
  if ('target_app' in patch) {
    const t = obj(patch.target_app, 'target_app');
    const id = str(t.id ?? '', 'Target app ID', 50);
    if (!id) throw new ValidationError('Target app ID is required');
    s.target_app = { id, name: str(t.name ?? '', 'Target app name') || id };
  }
  if ('keepawake' in patch) {
    const k = s.keepawake;
    const kp = obj(patch.keepawake, 'keepawake');
    if ('enabled' in kp) k.enabled = bool(kp.enabled, 'Keep-awake enabled');
    if ('interval_minutes' in kp) k.interval_minutes = int(kp.interval_minutes, 1, 1440, 'Ping interval');
    if ('keys' in kp) {
      if (!Array.isArray(kp.keys) || kp.keys.length < 1 || kp.keys.length > 6) {
        throw new ValidationError('Keep-awake keys must be a list of 1 to 6 buttons');
      }
      kp.keys.forEach((key) => choice(key, KEEPALIVE_KEYS, 'Keep-awake key'));
      k.keys = [...kp.keys];
    }
    if ('only_when' in kp) k.only_when = choice(kp.only_when, ['any', 'target_app'], 'only_when');
    if ('when_off' in kp) k.when_off = choice(kp.when_off, ['leave_off', 'power_on', 'power_on_launch'], 'when_off');
    if ('when_other_app' in kp) k.when_other_app = choice(kp.when_other_app, ['leave', 'launch_target'], 'when_other_app');
  }
  if ('app' in patch) {
    const a = s.app;
    const ap = obj(patch.app, 'app');
    if ('prevent_sleep' in ap) a.prevent_sleep = bool(ap.prevent_sleep, 'Keep computer awake');
    if ('remote_access' in ap) a.remote_access = bool(ap.remote_access, 'Phone access');
    if ('remote_port' in ap) a.remote_port = int(ap.remote_port, 1024, 65535, 'Phone access port');
  }
  return s;
}

export function validateSchedule(data, deviceIds) {
  obj(data, 'Schedule');
  const time = str(data.time ?? '', 'Time', 5);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new ValidationError('Time must be HH:MM (24-hour)');
  const days = data.days;
  if (!Array.isArray(days) || !days.length || days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
    throw new ValidationError('Pick at least one day');
  }
  const devices = data.devices ?? 'all';
  if (devices !== 'all') {
    if (!Array.isArray(devices) || !devices.length) throw new ValidationError('Pick at least one TV, or all TVs');
    const unknown = devices.find((d) => !deviceIds.has(d));
    if (unknown !== undefined) throw new ValidationError(`Unknown TV: ${unknown}`);
  }
  const action = choice(data.action, Object.keys(SCHEDULE_ACTIONS), 'Action');
  const then = action === 'power_on' ? choice(data.then ?? 'nothing', Object.keys(SCHEDULE_THEN), 'Then') : 'nothing';
  const sched = {
    name: '',
    enabled: bool(data.enabled ?? true, 'Enabled'),
    time,
    days: [...new Set(days)].sort((a, b) => a - b), // 0 = Monday ... 6 = Sunday
    devices: devices === 'all' ? 'all' : [...devices],
    action,
    then,
    app: null,
    input: null,
  };
  if (action === 'open_app' || then === 'app') {
    const app = obj(data.app, 'App');
    const id = str(app.id ?? '', 'App', 50);
    if (!id) throw new ValidationError('Pick an app');
    sched.app = { id, name: str(app.name ?? '', 'App name') || id };
  }
  if (action === 'input' || then === 'input') sched.input = choice(data.input, Object.keys(INPUTS), 'Input');
  sched.name = str(data.name ?? '', 'Name') || describeSchedule(sched);
  return sched;
}

function deepMerge(base, extra) {
  const out = clone(base);
  for (const [key, value] of Object.entries(extra || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value) && out[key] && typeof out[key] === 'object' && !Array.isArray(out[key])) {
      out[key] = deepMerge(out[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Emits "change" (with the section name) whenever something is saved. */
export class Store extends EventEmitter {
  constructor(file) {
    super();
    this.file = file;
    this.data = { settings: clone(DEFAULT_SETTINGS), devices: [], schedules: [] };
    if (fs.existsSync(file)) {
      try {
        const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
        this.data.settings = deepMerge(DEFAULT_SETTINGS, saved.settings);
        this.data.devices = saved.devices || [];
        this.data.schedules = (saved.schedules || []).map((sc) => migrateSchedule(sc, this.data.settings.target_app));
      } catch (e) {
        // Keep a copy of an unreadable file rather than silently overwriting it.
        fs.copyFileSync(file, file + '.unreadable');
      }
    }
  }

  save(section) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
    this.emit('change', section);
  }

  // Settings
  settings() {
    return clone(this.data.settings);
  }

  updateSettings(patch) {
    this.data.settings = validateSettings(this.data.settings, patch);
    this.save('settings');
    return this.settings();
  }

  // Devices
  devices() {
    return clone(this.data.devices);
  }

  device(id) {
    const d = this.data.devices.find((x) => x.id === id);
    return d ? clone(d) : null;
  }

  /** Add a newly found TV, or refresh the address of one we already know. */
  upsertDeviceFromInfo(host, info) {
    const id = info['serial-number'] || info['device-id'] || host;
    const existing = this.data.devices.find((d) => d.id === id);
    if (existing) {
      existing.host = host;
      existing.model = info['model-name'] || existing.model || '';
      this.save('devices');
      return { device: clone(existing), created: false };
    }
    const device = {
      id,
      name: info['user-device-name'] || info['friendly-device-name'] || info['default-device-name'] || `Roku ${host}`,
      host,
      model: info['model-name'] || '',
      is_tv: String(info['is-tv'] || '').toLowerCase() === 'true',
      keepawake_enabled: true,
      interval_minutes: null, // null = use the global interval
      held_off: false,
    };
    this.data.devices.push(device);
    this.save('devices');
    return { device: clone(device), created: true };
  }

  updateDevice(id, patch) {
    const d = this.data.devices.find((x) => x.id === id);
    if (!d) return null;
    const next = { ...d };
    if ('name' in patch) {
      next.name = str(patch.name, 'Name');
      if (!next.name) throw new ValidationError("Name can't be empty");
    }
    if ('keepawake_enabled' in patch) next.keepawake_enabled = bool(patch.keepawake_enabled, 'Keep-awake');
    if ('interval_minutes' in patch) {
      next.interval_minutes = patch.interval_minutes === null ? null : int(patch.interval_minutes, 1, 1440, 'Ping interval');
    }
    if ('held_off' in patch) next.held_off = bool(patch.held_off, 'held_off');
    Object.assign(d, next);
    this.save('devices');
    return clone(d);
  }

  removeDevice(id) {
    const before = this.data.devices.length;
    this.data.devices = this.data.devices.filter((d) => d.id !== id);
    for (const s of this.data.schedules) {
      if (Array.isArray(s.devices)) s.devices = s.devices.filter((d) => d !== id);
    }
    // A schedule whose TVs have all been removed would otherwise be invalid.
    this.data.schedules = this.data.schedules.filter((s) => s.devices === 'all' || s.devices.length);
    this.save('devices');
    return this.data.devices.length !== before;
  }

  // Schedules
  schedules() {
    return clone(this.data.schedules);
  }

  schedule(id) {
    const s = this.data.schedules.find((x) => x.id === id);
    return s ? clone(s) : null;
  }

  deviceIds() {
    return new Set(this.data.devices.map((d) => d.id));
  }

  addSchedule(data) {
    const sched = { id: crypto.randomBytes(6).toString('hex'), ...validateSchedule(data, this.deviceIds()) };
    this.data.schedules.push(sched);
    this.save('schedules');
    return clone(sched);
  }

  updateSchedule(id, data) {
    const i = this.data.schedules.findIndex((s) => s.id === id);
    if (i < 0) return null;
    const sched = { id, ...validateSchedule({ ...this.data.schedules[i], ...data }, this.deviceIds()) };
    this.data.schedules[i] = sched;
    this.save('schedules');
    return clone(sched);
  }

  removeSchedule(id) {
    const before = this.data.schedules.length;
    this.data.schedules = this.data.schedules.filter((s) => s.id !== id);
    this.save('schedules');
    return this.data.schedules.length !== before;
  }
}
