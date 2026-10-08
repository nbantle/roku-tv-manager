import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { createApi } from '../src/core/api.js';
import { parseCidr, parseSsdpLocation } from '../src/core/discovery.js';
import { EcpClient, EcpError } from '../src/core/ecp.js';
import { Engine, describeStatus } from '../src/core/engine.js';
import { createRemoteServer } from '../src/core/remote.js';
import { Store, ValidationError, describeSchedule, migrateSchedule } from '../src/core/store.js';
import { FakeRoku } from './fake-roku.js';

let tmp, store, roku, clock, now, engine, device;

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'roku-test-'));
  store = new Store(path.join(tmp, 'config.json'));
  roku = await new FakeRoku().ready;
  clock = { t: 1_000_000 };
  now = new Date(2026, 9, 11, 8, 0); // Sunday 8:00
  engine = new Engine(store, {
    clientFactory: () => new EcpClient('127.0.0.1', roku.port, 2000),
    clock: () => clock.t,
    localNow: () => now,
    sleep: async () => {},
  });
  const info = await new EcpClient('127.0.0.1', roku.port).deviceInfo();
  device = store.upsertDeviceFromInfo('127.0.0.1', info).device;
});

afterEach(async () => {
  await engine.idle();
  engine.stop();
  await roku.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('ECP client', () => {
  test('reads device info, active app and player', async () => {
    const c = new EcpClient('127.0.0.1', roku.port);
    assert.equal((await c.deviceInfo())['serial-number'], 'X001');
    assert.equal((await c.activeApp()).id, '592369');
    assert.equal((await c.mediaPlayer()).state, 'play');
    assert.deepEqual((await c.apps()).map((a) => a.id), ['592369', 'tvinput.hdmi1']);
  });

  test('home screen has no app id', async () => {
    roku.app = [null, 'Roku', null];
    const app = await new EcpClient('127.0.0.1', roku.port).activeApp();
    assert.equal(app.id, null);
    assert.equal(app.name, 'Roku');
  });

  test('403 explains the TV setting to change', async () => {
    roku.forbidden = true;
    await assert.rejects(new EcpClient('127.0.0.1', roku.port).deviceInfo(), (e) => e instanceof EcpError && e.status === 403 && /Control by mobile apps/.test(e.message));
  });

  test('unreachable TV is an EcpError', async () => {
    await assert.rejects(new EcpClient('127.0.0.1', 1, 500).deviceInfo(), EcpError);
  });
});

describe('discovery helpers', () => {
  test('SSDP location', () => {
    const packet = Buffer.from('HTTP/1.1 200 OK\r\nST: roku:ecp\r\nLOCATION: http://192.168.1.50:8060/\r\nUSN: uuid:roku:ecp:X\r\n\r\n');
    assert.deepEqual(parseSsdpLocation(packet), { host: '192.168.1.50', port: 8060 });
  });

  test('subnet parsing', () => {
    const hosts = parseCidr('192.168.1.77/24');
    assert.equal(hosts.length, 254);
    assert.equal(hosts[0], '192.168.1.1');
    assert.equal(hosts.at(-1), '192.168.1.254');
    assert.throws(() => parseCidr('10.0.0.0/8'), /too large/);
    assert.throws(() => parseCidr('nonsense'), /isn't a subnet/);
  });
});

describe('status descriptions', () => {
  const on = { 'power-mode': 'PowerOn' };
  test('HDMI', () => assert.equal(describeStatus(on, { id: 'tvinput.hdmi1', name: 'HDMI 1' }, null, '592369').activity, 'HDMI 1'));
  test('renamed HDMI', () => assert.equal(describeStatus(on, { id: 'tvinput.hdmi2', name: 'Xbox' }, null, '592369').activity, 'HDMI 2 (Xbox)'));
  test('standby', () => assert.equal(describeStatus({ 'power-mode': 'DisplayOff' }, null, null, '592369').power, 'standby'));
  test('target playing', () => {
    const s = describeStatus(on, { id: '592369', name: 'Jellyfin' }, { state: 'play' }, '592369');
    assert.ok(s.on_target);
    assert.equal(s.playback, 'Playing');
  });
  test('screensaver over home', () => {
    const s = describeStatus(on, { id: null, name: 'Roku', screensaver: { id: '1', name: 'City' } }, null, '592369');
    assert.equal(s.activity, 'Screensaver over Home screen');
  });
});

describe('keep-awake', () => {
  test('pings a TV that is on', async () => {
    const result = await engine.keepAwake(device);
    assert.deepEqual(roku.presses, ['VolumeDown', 'VolumeUp']);
    assert.match(result, /^Pinged/);
  });

  test('never wakes a TV that is off (default)', async () => {
    roku.powerMode = 'DisplayOff';
    assert.match(await engine.keepAwake(device), /Left off/);
    assert.deepEqual(roku.presses, []);
  });

  test('"Ping now" never wakes a TV, even in turn-back-on mode', async () => {
    store.updateSettings({ keepawake: { when_off: 'power_on' } });
    roku.powerMode = 'Ready';
    await engine.runCommand(device, 'ping');
    assert.deepEqual(roku.presses, []);
  });

  test('turn back on and open target app', async () => {
    store.updateSettings({ keepawake: { when_off: 'power_on_launch' } });
    roku.powerMode = 'DisplayOff';
    await engine.keepAwake(device);
    assert.deepEqual(roku.presses, ['PowerOn']);
    assert.deepEqual(roku.launches, ['592369']);
  });

  test('turn-back-on mode respects a deliberate power-off', async () => {
    store.updateSettings({ keepawake: { when_off: 'power_on' } });
    await engine.runCommand(device, 'power_off');
    roku.presses.length = 0;
    await engine.keepAwake(device);
    assert.deepEqual(roku.presses, []);
    await engine.runCommand(device, 'power_on');
    assert.equal(store.device(device.id).held_off, false);
  });

  test('only when target app is open', async () => {
    store.updateSettings({ keepawake: { only_when: 'target_app' } });
    roku.app = ['tvinput.hdmi1', 'HDMI 1', 'tvin'];
    assert.match(await engine.keepAwake(device), /isn't open/);
    assert.deepEqual(roku.presses, []);
  });

  test('switch back to target app', async () => {
    store.updateSettings({ keepawake: { when_other_app: 'launch_target' } });
    roku.app = ['tvinput.hdmi1', 'HDMI 1', 'tvin'];
    await engine.keepAwake(device);
    assert.deepEqual(roku.launches, ['592369']);
  });

  test('interval timing', async () => {
    const step = async (seconds) => {
      clock.t += seconds;
      engine.tick();
      await engine.idle();
    };
    await step(0);
    assert.equal(roku.presses.length, 0); // startup grace period
    await step(20);
    assert.equal(roku.presses.length, 2);
    await step(29 * 60);
    assert.equal(roku.presses.length, 2); // not due yet
    await step(61);
    assert.equal(roku.presses.length, 4);
  });

  test('per-TV interval and disable', () => {
    store.updateDevice(device.id, { interval_minutes: 5 });
    engine.markPinged(device.id, clock.t);
    assert.equal(engine.nextPingAt(store.device(device.id), store.settings()), clock.t + 300);
    store.updateDevice(device.id, { keepawake_enabled: false });
    assert.equal(engine.nextPingAt(store.device(device.id), store.settings()), null);
  });
});

describe('schedules', () => {
  test('fires once in its minute', async () => {
    roku.powerMode = 'DisplayOff';
    store.addSchedule({ time: '08:00', days: [6], action: 'power_on', devices: 'all' });
    engine.checkSchedules(store.devices());
    engine.checkSchedules(store.devices());
    await engine.idle();
    assert.deepEqual(roku.presses, ['PowerOn']);
  });

  test('skips other days', async () => {
    store.addSchedule({ time: '08:00', days: [0, 1], action: 'power_off' });
    engine.checkSchedules(store.devices());
    await engine.idle();
    assert.deepEqual(roku.presses, []);
  });

  test('validation', () => {
    assert.throws(() => store.addSchedule({ time: '25:00', days: [1], action: 'power_on' }), ValidationError);
    assert.throws(() => store.addSchedule({ time: '08:00', days: [], action: 'power_on' }), ValidationError);
    assert.throws(() => store.addSchedule({ time: '08:00', days: [1], action: 'power_on', devices: ['nope'] }), ValidationError);
  });

  test('turn on, then switch to an input', async () => {
    roku.powerMode = 'DisplayOff';
    roku.app = ['592369', 'Jellyfin', 'appl'];
    const s = store.addSchedule({ time: '08:00', days: [6], action: 'power_on', then: 'input', input: 'hdmi2' });
    assert.equal(s.name, 'Turn on, then switch to HDMI 2');
    engine.runSchedule(s);
    await engine.idle();
    assert.deepEqual(roku.presses, ['PowerOn', 'InputHDMI2']);
    assert.equal(store.device(device.id).held_off, false);
  });

  test('turn on, then open a chosen app', async () => {
    roku.powerMode = 'Ready';
    const s = store.addSchedule({ time: '08:00', days: [6], action: 'power_on', then: 'app', app: { id: '12', name: 'Netflix' } });
    engine.runSchedule(s);
    await engine.idle();
    assert.deepEqual(roku.presses, ['PowerOn']);
    assert.deepEqual(roku.launches, ['12']);
  });

  test('switch input and open app on their own', async () => {
    engine.runSchedule(store.addSchedule({ time: '08:00', days: [6], action: 'input', input: 'tuner' }));
    engine.runSchedule(store.addSchedule({ time: '09:00', days: [6], action: 'open_app', app: { id: '592369', name: 'Jellyfin' } }));
    await engine.idle();
    assert.deepEqual(roku.presses, ['InputTuner']);
    assert.deepEqual(roku.launches, ['592369']);
  });

  test('follow-up step needs its app or input', () => {
    assert.throws(() => store.addSchedule({ time: '08:00', days: [1], action: 'power_on', then: 'app' }), ValidationError);
    assert.throws(() => store.addSchedule({ time: '08:00', days: [1], action: 'input', input: 'hdmi9' }), ValidationError);
    // "then" is ignored for anything but Turn on
    assert.equal(store.addSchedule({ time: '08:00', days: [1], action: 'power_off', then: 'home' }).then, 'nothing');
  });

  test('version 1.0 schedules are converted', () => {
    const target = { id: '592369', name: 'Jellyfin' };
    const a = migrateSchedule({ action: 'power_on_launch' }, target);
    assert.deepEqual([a.action, a.then, a.app], ['power_on', 'app', target]);
    assert.equal(describeSchedule(migrateSchedule({ action: 'input_hdmi3' }, target)), 'Switch to HDMI 3');
    assert.equal(describeSchedule(migrateSchedule({ action: 'launch_target' }, target)), 'Open Jellyfin');
  });

  test('removing a TV cleans up its schedules', () => {
    store.addSchedule({ time: '08:00', days: [1], action: 'power_on', devices: [device.id] });
    store.removeDevice(device.id);
    assert.deepEqual(store.schedules(), []);
  });
});

describe('settings', () => {
  test('power keys are not allowed as keep-awake buttons', () => {
    assert.throws(() => store.updateSettings({ keepawake: { keys: ['PowerOff'] } }), ValidationError);
  });

  test('saved to disk', () => {
    store.updateSettings({ keepawake: { interval_minutes: 45 } });
    const again = new Store(store.file);
    assert.equal(again.settings().keepawake.interval_minutes, 45);
    assert.equal(again.devices().length, 1);
  });
});

describe('API', () => {
  let api;
  beforeEach(() => {
    api = createApi(store, engine, { discover: async () => [], makeClient: () => new EcpClient('127.0.0.1', roku.port) });
  });

  test('state', async () => {
    const r = await api('GET', '/api/state');
    assert.equal(r.status, 200);
    assert.equal(r.body.devices[0].name, 'Lobby TV');
  });

  test('command', async () => {
    const r = await api('POST', `/api/devices/${device.id}/command`, { command: 'input_hdmi1' });
    assert.deepEqual([r.status, r.body.message], [200, 'Switched to HDMI 1']);
    assert.deepEqual(roku.presses, ['InputHDMI1']);
  });

  test('apps list combines TVs and puts the target app first', async () => {
    store.updateSettings({ target_app: { id: '999', name: 'Zeta' } });
    const r = await api('GET', '/api/apps');
    assert.deepEqual(r.body.apps.map((a) => a.id), ['999', '592369']);
  });

  test('extra inputs from the card menu', async () => {
    const r = await api('POST', `/api/devices/${device.id}/command`, { command: 'input_av1' });
    assert.equal(r.body.message, 'Switched to AV');
  });

  test('bad settings', async () => {
    const r = await api('PUT', '/api/settings', { keepawake: { interval_minutes: 0 } });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /between/);
  });

  test('schedule create, update, delete', async () => {
    const s = (await api('POST', '/api/schedules', { time: '13:00', days: [6], action: 'power_off' })).body;
    assert.equal((await api('PUT', `/api/schedules/${s.id}`, { enabled: false })).body.enabled, false);
    assert.equal((await api('DELETE', `/api/schedules/${s.id}`)).status, 200);
    assert.deepEqual(store.schedules(), []);
  });

  test('phone access server rejects non-JSON posts', async () => {
    const server = createRemoteServer(api, new URL('../index.html', import.meta.url).pathname);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const page = await fetch(base + '/');
      assert.match(await page.text(), /Roku TV Manager/);
      const bad = await fetch(`${base}/api/devices/${device.id}/command`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{"command":"power_off"}' });
      assert.equal(bad.status, 415);
      const ok = await fetch(`${base}/api/devices/${device.id}/command`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"command":"home"}' });
      assert.equal(ok.status, 200);
      assert.deepEqual(roku.presses, ['Home']);
    } finally {
      server.close();
    }
  });
});
