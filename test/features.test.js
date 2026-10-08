// Tests for: card colors, groups and bulk actions, one-time schedules, the mini
// remote, "Monitor only" mode, alerts, Jellyfin, other-copy detection and
// update checks.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { createApi } from '../src/core/api.js';
import { EcpClient } from '../src/core/ecp.js';
import { Engine } from '../src/core/engine.js';
import { hostOf, nowPlaying, sessionForHost } from '../src/core/jellyfin.js';
import { Presence } from '../src/core/presence.js';
import { Store, ValidationError } from '../src/core/store.js';
import { checkForUpdate, compareVersions } from '../src/core/updates.js';
import { FakeJellyfin } from './fake-jellyfin.js';
import { FakeRoku } from './fake-roku.js';

let tmp, store, rokus, clock, now, engine, api, alerts;

// Each fake TV listens on its own port; the app reaches it by "host" name tv0, tv1...
const portFor = (host) => rokus[Number(host.slice(2))].port;

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'roku-feat-'));
  store = new Store(path.join(tmp, 'config.json'));
  rokus = await Promise.all(['Lobby TV', 'Cafe TV', 'Kids TV'].map((name, i) => new FakeRoku({ serial: `S${i}`, name }).ready));
  clock = { t: 1_000_000 };
  now = new Date(2026, 11, 24, 15, 0); // Thursday 24 Dec 2026, 3:00 PM
  engine = new Engine(store, {
    clientFactory: (host) => new EcpClient('127.0.0.1', portFor(host), 2000),
    clock: () => clock.t,
    localNow: () => now,
    sleep: async () => {},
  });
  alerts = [];
  engine.on('alert', (a) => alerts.push(a));
  for (const [i, r] of rokus.entries()) {
    store.upsertDeviceFromInfo(`tv${i}`, await new EcpClient('127.0.0.1', r.port).deviceInfo());
  }
  api = createApi(store, engine, { discover: async () => [], makeClient: (host) => new EcpClient('127.0.0.1', portFor(host)) });
});

afterEach(async () => {
  await engine.idle();
  engine.stop();
  await Promise.all(rokus.map((r) => r.close()));
  fs.rmSync(tmp, { recursive: true, force: true });
});

const presses = () => rokus.map((r) => r.presses);
const step = async (seconds = 0) => {
  clock.t += seconds;
  engine.tick();
  await engine.idle();
};

describe('card colors and groups', () => {
  test('saved per TV, and validated', async () => {
    assert.equal((await api('PATCH', '/api/devices/S0', { color: 'red', group: ' Lobby ' })).body.color, 'red');
    assert.equal(store.device('S0').group, 'Lobby');
    assert.equal((await api('PATCH', '/api/devices/S0', { color: 'plaid' })).status, 400);
    await api('PATCH', '/api/devices/S0', { color: null, group: '' });
    assert.deepEqual([store.device('S0').color, store.device('S0').group], [null, null]);
  });

  test('state lists the groups in use', async () => {
    store.updateDevice('S0', { group: 'Lobby' });
    store.updateDevice('S1', { group: 'Lobby' });
    store.updateDevice('S2', { group: 'Kids' });
    assert.deepEqual((await api('GET', '/api/state')).body.groups, ['Kids', 'Lobby']);
  });

  test('TVs saved by older versions get no color or group', () => {
    const file = path.join(tmp, 'old.json');
    fs.writeFileSync(file, JSON.stringify({ devices: [{ id: 'A', name: 'Old', host: 'x' }], schedules: [{ id: 's', name: 'n', time: '08:00', days: [1], devices: 'all', action: 'power_on' }] }));
    const old = new Store(file);
    assert.deepEqual([old.device('A').color, old.device('A').group], [null, null]);
    assert.deepEqual([old.schedules()[0].repeat, old.schedules()[0].groups], ['weekly', []]);
    assert.ok(old.instanceId);
  });
});

describe('bulk buttons', () => {
  test('run one command on several TVs and report failures', async () => {
    rokus[2].forbidden = true;
    const r = await api('POST', '/api/bulk', { command: 'power_off', device_ids: ['S0', 'S1', 'S2'] });
    assert.equal(r.body.ok, 2);
    assert.equal(r.body.failed[0].name, 'Kids TV');
    assert.deepEqual(presses(), [['PowerOff'], ['PowerOff'], []]);
  });

  test('only safe commands', async () => {
    assert.equal((await api('POST', '/api/bulk', { command: 'key', device_ids: ['S0'] })).status, 400);
    assert.equal((await api('POST', '/api/bulk', { command: 'ping', device_ids: [] })).status, 400);
  });
});

describe('schedules: groups and one-time dates', () => {
  test('a group schedule covers TVs added to the group later', async () => {
    store.updateDevice('S0', { group: 'Lobby' });
    const s = store.addSchedule({ time: '15:00', days: [3], action: 'power_off', devices: [], groups: ['Lobby'] });
    store.updateDevice('S2', { group: 'Lobby' });
    assert.deepEqual(store.scheduleTargets(s).map((d) => d.id), ['S0', 'S2']);
    engine.checkSchedules();
    await engine.idle();
    assert.deepEqual(presses(), [['PowerOff'], [], ['PowerOff']]);
  });

  test('group schedules survive removing a TV', () => {
    store.addSchedule({ time: '15:00', days: [3], action: 'power_off', devices: ['S1'], groups: ['Lobby'] });
    store.removeDevice('S1');
    assert.equal(store.schedules().length, 1);
  });

  test('a one-time schedule runs on its date only, then switches itself off', async () => {
    const other = store.addSchedule({ time: '15:00', repeat: 'once', date: '2026-12-25', action: 'power_on' });
    const today = store.addSchedule({ time: '15:00', repeat: 'once', date: '2026-12-24', action: 'power_off', devices: ['S0'] });
    engine.checkSchedules();
    await engine.idle();
    assert.deepEqual(presses(), [['PowerOff'], [], []]);
    assert.equal(store.schedule(today.id).enabled, false);
    assert.equal(store.schedule(other.id).enabled, true);
  });

  test('validation', () => {
    assert.throws(() => store.addSchedule({ time: '15:00', repeat: 'once', date: '2026-02-30', action: 'power_on' }), ValidationError);
    assert.throws(() => store.addSchedule({ time: '15:00', days: [1], action: 'power_on', devices: [], groups: [] }), ValidationError);
  });
});

describe('mini remote', () => {
  test('sends the button without writing to the activity log', async () => {
    const before = engine.log.length;
    const r = await api('POST', '/api/devices/S0/command', { command: 'key', key: 'Up' });
    assert.equal(r.status, 200);
    assert.deepEqual(rokus[0].presses, ['Up']);
    assert.equal(engine.log.filter((e) => /Up/.test(e.message)).length, 0);
    assert.ok(engine.log.length >= before);
  });

  test('rejects buttons that are not on the remote', async () => {
    assert.equal((await api('POST', '/api/devices/S0/command', { command: 'key', key: 'PowerOff' })).status, 400);
    assert.deepEqual(rokus[0].presses, []);
  });
});

describe('"Monitor only" mode', () => {
  test('no pings and no schedules, but status still updates', async () => {
    store.updateSettings({ app: { role: 'monitor' } });
    store.addSchedule({ time: '15:00', days: [3], action: 'power_off' });
    await step(0);
    await step(STARTUP_SECONDS + 5);
    assert.deepEqual(presses(), [[], [], []]);
    assert.ok(engine.statusOf('S0'));
    assert.equal(engine.nextPingAt(store.device('S0'), store.settings()), null);
    assert.equal((await api('GET', '/api/state')).body.in_charge, false);
  });

  test('manual buttons still work', async () => {
    store.updateSettings({ app: { role: 'monitor' } });
    await api('POST', '/api/devices/S0/command', { command: 'home' });
    assert.deepEqual(rokus[0].presses, ['Home']);
  });
});
const STARTUP_SECONDS = 15;

describe('alerts', () => {
  test('"not responding" after two missed checks, then "responding again"', async () => {
    const d = store.device('S0');
    await engine.pollDevice(d);
    rokus[0].forbidden = true;
    await engine.pollDevice(d);
    assert.equal(alerts.length, 0); // one miss could be a blip
    await engine.pollDevice(d);
    await engine.pollDevice(d);
    assert.deepEqual(alerts.map((a) => a.kind), ['offline']);
    rokus[0].forbidden = false;
    await engine.pollDevice(d);
    assert.deepEqual(alerts.map((a) => a.kind), ['offline', 'online']);
  });

  test('turned off / switched away, but not when the app did it', async () => {
    store.updateSettings({ alerts: { turned_off: true, left_target: true } });
    const d = store.device('S0');
    await engine.pollDevice(d);
    rokus[0].app = ['tvinput.hdmi1', 'HDMI 1', 'tvin'];
    await engine.pollDevice(d);
    rokus[0].powerMode = 'DisplayOff';
    await engine.pollDevice(d);
    assert.deepEqual(alerts.map((a) => a.kind), ['left_target', 'turned_off']);
    assert.match(alerts[0].message, /Lobby TV switched from Jellyfin to HDMI 1/);

    // Now the app turns it on and off itself: no alerts.
    alerts.length = 0;
    await engine.runCommand(d, 'power_on');
    await engine.pollDevice(d);
    await engine.runCommand(d, 'power_off');
    await engine.pollDevice(d);
    assert.deepEqual(alerts, []);
  });

  test('each alert can be turned off', async () => {
    store.updateSettings({ alerts: { offline: false } });
    rokus[0].forbidden = true;
    for (let i = 0; i < 3; i++) await engine.pollDevice(store.device('S0'));
    assert.deepEqual(alerts, []);
    assert.ok(engine.log.some((e) => e.level === 'error' || e.message.includes('Not responding')));
  });
});

describe('Jellyfin', () => {
  let jf;
  beforeEach(async () => {
    jf = await new FakeJellyfin().ready;
  });
  afterEach(() => jf.close());

  const connect = () => store.updateSettings({ jellyfin: { url: jf.url, api_key: 'secret-key' } });

  test('the API key is never sent to the page, and a blank field keeps it', async () => {
    connect();
    const state = (await api('GET', '/api/state')).body;
    assert.equal(state.settings.jellyfin.has_api_key, true);
    assert.equal(JSON.stringify(state).includes('secret-key'), false);
    await api('PUT', '/api/settings', { jellyfin: { url: jf.url, api_key: '' } });
    assert.equal(store.settings().jellyfin.api_key, 'secret-key');
    await api('PUT', '/api/settings', { jellyfin: { api_key: null } });
    assert.equal(store.settings().jellyfin.api_key, '');
  });

  test('test connection lists the TVs Jellyfin can see', async () => {
    connect();
    jf.addSession('tv1');
    const r = await api('POST', '/api/jellyfin/test');
    assert.deepEqual([r.body.name, r.body.version, r.body.tvs], ['Church Media', '10.10.7', ['Cafe TV']]);
  });

  test('wrong key is explained', async () => {
    store.updateSettings({ jellyfin: { url: jf.url, api_key: 'nope' } });
    const r = await api('POST', '/api/jellyfin/test');
    assert.equal(r.status, 502);
    assert.match(r.body.error, /API key/);
  });

  test('search', async () => {
    connect();
    const r = await api('POST', '/api/jellyfin/search', { q: 'kids' });
    assert.deepEqual(r.body.items.map((i) => i.name), ['Kids Church – Pilot']);
  });

  test('play on a TV that already has Jellyfin open', async () => {
    connect();
    jf.addSession('tv0', { id: 'A1' });
    const r = await api('POST', '/api/devices/S0/command', { command: 'jellyfin_play', item: { id: 'pl1', name: 'Walk-In Loop' } });
    assert.equal(r.body.message, 'Playing “Walk-In Loop” from Jellyfin');
    assert.deepEqual(jf.plays, [{ sessionId: 'A1', itemIds: 'pl1', command: 'PlayNow' }]);
    assert.deepEqual(rokus[0].launches, []);
  });

  test('opens Jellyfin first when it isn’t open, then plays', async () => {
    connect();
    rokus[1].app = ['tvinput.hdmi1', 'HDMI 1', 'tvin'];
    rokus[1].onLaunch = (id) => { if (id === '592369') jf.addSession('tv1', { id: 'B1' }); };
    await api('POST', '/api/devices/S1/command', { command: 'jellyfin_play', item: { id: 'mv1', name: 'Countdown' } });
    assert.deepEqual(rokus[1].launches, ['592369']);
    assert.deepEqual(jf.plays.map((p) => p.sessionId), ['B1']);
  });

  test('clear error when the TV never connects', async () => {
    connect();
    const r = await api('POST', '/api/devices/S2/command', { command: 'jellyfin_play', item: { id: 'pl1', name: 'Loop' } });
    assert.equal(r.status, 502);
    assert.match(r.body.error, /never connected/);
  });

  test('schedule: turn on, then play from Jellyfin', async () => {
    connect();
    rokus[0].powerMode = 'DisplayOff';
    rokus[0].onLaunch = () => jf.addSession('tv0', { id: 'C1' });
    rokus[0].app = [null, 'Roku', null];
    const s = store.addSchedule({ time: '15:00', repeat: 'once', date: '2026-12-24', devices: ['S0'], action: 'power_on', then: 'jellyfin', item: { id: 'mv1', name: 'Christmas Eve Countdown' } });
    assert.equal(s.name, 'Turn on, then play “Christmas Eve Countdown” from Jellyfin');
    engine.checkSchedules();
    await engine.idle();
    assert.deepEqual(rokus[0].presses, ['PowerOn']);
    assert.deepEqual(jf.plays.map((p) => p.itemIds), ['mv1']);
  });

  test('card shows what Jellyfin is playing', async () => {
    connect();
    jf.addSession('tv0', { nowPlaying: 'Walk-In Loop' });
    await engine.refreshJellyfin();
    const st = await engine.pollDevice(store.device('S0'));
    assert.deepEqual(st.jellyfin, { title: 'Walk-In Loop', paused: false });
  });

  test('session matching helpers', () => {
    assert.equal(hostOf('::ffff:192.168.1.5'), '192.168.1.5');
    assert.equal(hostOf('192.168.1.5:51234'), '192.168.1.5');
    const sessions = [{ Id: 'x', RemoteEndPoint: '10.0.0.2', LastActivityDate: '2026-01-01' }, { Id: 'y', RemoteEndPoint: '10.0.0.2', LastActivityDate: '2026-02-01' }];
    assert.equal(sessionForHost(sessions, '10.0.0.2').Id, 'y');
    assert.equal(nowPlaying({ NowPlayingItem: { Name: 'Pilot', SeriesName: 'Kids' }, PlayState: { IsPaused: true } }).title, 'Kids – Pilot');
  });
});

describe('other copies on the network', () => {
  test('two copies see each other, notice role changes and say goodbye', async () => {
    const roles = { a: 'control', b: 'control' };
    let a, b;
    const make = (id, port, peerPort) => new Presence({
      instanceId: id, name: `PC-${id}`, version: '1.2.0', getRole: () => roles[id],
      port, targets: () => [{ host: '127.0.0.1', port: peerPort }], intervalMs: 60_000,
    });
    // Pick two free ports.
    const free = async () => { const s = (await import('node:net')).createServer(); await new Promise((r) => s.listen(0, '127.0.0.1', r)); const p = s.address().port; s.close(); return p; };
    const [pa, pb] = [await free(), await free()];
    a = make('a', pa, pb);
    b = make('b', pb, pa);
    try {
      await a.start();
      await b.start();
      a.announce();
      await new Promise((r) => setTimeout(r, 150));
      assert.deepEqual(a.peers().map((p) => [p.name, p.role]), [['PC-b', 'control']]);
      assert.deepEqual(b.peers().map((p) => p.name), ['PC-a']);

      roles.b = 'monitor';
      b.announce();
      await new Promise((r) => setTimeout(r, 150));
      assert.equal(a.peers()[0].role, 'monitor');

      b.stop();
      await new Promise((r) => setTimeout(r, 150));
      assert.deepEqual(a.peers(), []);
    } finally {
      a.stop();
      b.stop();
    }
  });

  test('copies that go quiet are forgotten', () => {
    let t = 0;
    const p = new Presence({ instanceId: 'me', name: 'me', version: '1', getRole: () => 'control', clock: () => t, ttlMs: 1000 });
    p.receive(Buffer.from(JSON.stringify({ app: 'roku-tv-manager', id: 'x', name: 'X', role: 'control' })), { address: '10.0.0.9' });
    p.receive(Buffer.from('not json'), { address: '10.0.0.9' });
    p.receive(Buffer.from(JSON.stringify({ app: 'roku-tv-manager', id: 'me', name: 'me' })), { address: '10.0.0.1' }); // our own echo
    assert.equal(p.peers().length, 1);
    t = 5000;
    assert.equal(p.peers().length, 0);
  });
});

describe('update check', () => {
  test('version comparison', () => {
    assert.equal(compareVersions('v1.10.0', '1.9.3'), 1);
    assert.equal(compareVersions('1.2.0', '1.2'), 0);
    assert.equal(compareVersions('1.1.9', 'v1.2.0'), -1);
  });

  test('reports only newer, published releases', async () => {
    const release = { tag_name: 'v1.3.0', html_url: 'https://github.com/x/releases/v1.3.0' };
    assert.deepEqual(await checkForUpdate('1.2.0', async () => release), { version: '1.3.0', url: release.html_url });
    assert.equal(await checkForUpdate('1.3.0', async () => release), null);
    assert.equal(await checkForUpdate('1.2.0', async () => ({ ...release, prerelease: true })), null);
  });
});
