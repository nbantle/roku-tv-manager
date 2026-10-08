// Roku TV Manager (Electron) main process: window, tray icon, settings file,
// the background engine, and optional phone access. All TV work runs here, so
// it keeps going while the window is closed.
import { app, BrowserWindow, Menu, Notification, Tray, ipcMain, nativeImage, nativeTheme, net, powerSaveBlocker, shell } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createApi } from './src/core/api.js';
import { localAddresses } from './src/core/discovery.js';
import { Engine } from './src/core/engine.js';
import { Presence } from './src/core/presence.js';
import { createRemoteServer } from './src/core/remote.js';
import { Store } from './src/core/store.js';
import { checkForUpdate } from './src/core/updates.js';

const UPDATE_CHECK_HOURS = 12;

const here = path.dirname(fileURLToPath(import.meta.url));
const isMac = process.platform === 'darwin';
const isWindows = process.platform === 'win32';
const INDEX_HTML = path.join(here, 'index.html');

let store, engine, api;
let win = null;
let tray = null;
let quitting = false;
let sleepBlocker = null;
let remote = { server: null, port: null, error: null };
let trayHintShown = false;
let presence = null;
let update = null; // { version, url } when a newer release exists
let updateCheckedAt = null; // when the last update check succeeded (seconds)
let lastRole = null;
let lastCheckUpdates = null;
let warnedPeers = new Set(); // other in-charge copies we've already logged

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.whenReady().then(start);
}

// ---------------------------------------------------------------- startup

function start() {
  const dataDir = app.getPath('userData');
  store = new Store(path.join(dataDir, 'config.json'));
  engine = new Engine(store);
  api = createApi(store, engine, { appInfo });

  const logFile = path.join(dataDir, 'activity.log');
  engine.on('log', (e) => appendLog(logFile, e));
  engine.addLog('info', `Roku TV Manager ${app.getVersion()} started`);
  engine.start();

  engine.on('alert', notify);

  presence = new Presence({
    instanceId: store.instanceId,
    name: os.hostname(),
    version: app.getVersion(),
    getRole: () => store.settings().app.role,
  });
  presence.on('change', onPeersChanged);
  presence.start();

  store.on('change', applyAppSettings);
  applyAppSettings();

  setTimeout(checkUpdates, 10_000);
  setInterval(checkUpdates, UPDATE_CHECK_HOURS * 3600_000);

  ipcMain.handle('api', (event, method, apiPath, body) => {
    if (!event.senderFrame?.url.startsWith('file://')) return { status: 403, body: { error: 'Forbidden' } };
    return handle(method, apiPath, body ?? {});
  });

  setMenu();
  createTray();
  const openedHidden = process.argv.includes('--hidden') || (isMac && app.getLoginItemSettings().wasOpenedAtLogin);
  createWindow(!openedHidden);
  setInterval(updateTray, 5000);
}

/** Desktop-only routes, then the shared API. */
async function handle(method, apiPath, body) {
  if (method === 'PUT' && apiPath === '/api/app/login') {
    setOpenAtLogin(body.open_at_login === true);
    return { status: 200, body: { open_at_login: openAtLogin() } };
  }
  return api(method, apiPath, body);
}

function appInfo() {
  const port = store.settings().app.remote_port;
  return {
    desktop: true,
    version: app.getVersion(),
    platform: process.platform,
    open_at_login: openAtLogin(),
    data_folder: app.getPath('userData'),
    remote_running: !!remote.server,
    remote_error: remote.error,
    remote_urls: remote.server ? localAddresses().map((a) => `http://${a.address}:${port}`) : [],
    computer_name: os.hostname(),
    peers: presence ? presence.peers() : [],
    presence_error: presence?.error ?? null,
    conflict: conflictingPeers().map((p) => p.name),
    update,
    update_checked_at: updateCheckedAt,
    notifications_supported: Notification.isSupported(),
  };
}

// ---------------------------------------------------------------- other copies, alerts, updates

/** Other computers that are also "in charge" while this one is. */
function conflictingPeers() {
  if (!presence || store.settings().app.role === 'monitor') return [];
  return presence.peers().filter((p) => p.role === 'control');
}

function onPeersChanged() {
  for (const p of conflictingPeers()) {
    if (warnedPeers.has(p.id)) continue;
    warnedPeers.add(p.id);
    engine.addLog('warn', `Another computer (${p.name}) is also in charge of the TVs. Set one of them to \u201cMonitor only\u201d in Settings \u2192 This computer.`);
  }
  updateTray();
}

function notify({ message }) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title: 'Roku TV Manager', body: message });
  n.on('click', showWindow);
  n.show();
}

async function checkUpdates() {
  if (!store.settings().app.check_updates) return;
  try {
    const found = await checkForUpdate(app.getVersion(), async (url) => {
      const r = await net.fetch(url, { headers: { Accept: 'application/vnd.github+json' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    });
    if (found && found.version !== update?.version) engine.addLog('info', `Version ${found.version} is available. Download it from Settings \u2192 This computer.`);
    update = found;
    updateCheckedAt = Date.now() / 1000;
    updateTray();
  } catch {
    // Offline or GitHub unreachable: try again next time.
  }
}

function appendLog(file, e) {
  const line = `${new Date(e.at * 1000).toISOString()} ${e.level.toUpperCase()} ${e.device ? `[${e.device}] ` : ''}${e.message}\n`;
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > 1_000_000) fs.renameSync(file, file + '.old');
    fs.appendFileSync(file, line);
  } catch { /* logging must never stop the app */ }
}

// ---------------------------------------------------------------- settings that affect the computer

function applyAppSettings() {
  const s = store.settings();

  // Tell other copies right away when this one switches between "in charge" and "monitor only".
  if (lastRole !== null && lastRole !== s.app.role) {
    presence?.announce();
    warnedPeers = new Set();
    engine.addLog('info', s.app.role === 'monitor' ? 'This computer is now Monitor only: no pings or schedules from here.' : 'This computer is now in charge of pings and schedules.');
  }
  lastRole = s.app.role;
  // Check right away when update checks are switched back on.
  if (s.app.check_updates && lastCheckUpdates === false) setTimeout(checkUpdates, 1000);
  if (!s.app.check_updates) update = null;
  lastCheckUpdates = s.app.check_updates;

  // Pings stop if this computer goes to sleep, so keep it awake while keep-awake is on.
  const wantAwake = s.app.prevent_sleep && s.keepawake.enabled;
  if (wantAwake && sleepBlocker === null) sleepBlocker = powerSaveBlocker.start('prevent-app-suspension');
  if (!wantAwake && sleepBlocker !== null) {
    powerSaveBlocker.stop(sleepBlocker);
    sleepBlocker = null;
  }

  // Phone access.
  const wantRemote = s.app.remote_access;
  if (remote.server && (!wantRemote || remote.port !== s.app.remote_port)) {
    remote.server.close();
    remote = { server: null, port: null, error: null };
  }
  if (wantRemote && !remote.server) startRemote(s.app.remote_port);
  if (!wantRemote) remote.error = null;
  updateTray();
}

function startRemote(port) {
  const server = createRemoteServer(api, INDEX_HTML);
  remote = { server: null, port, error: null };
  server.once('error', (e) => {
    remote = {
      server: null,
      port,
      error: e.code === 'EADDRINUSE' ? `Port ${port} is already in use on this computer. Pick another port.` : e.message,
    };
    engine.addLog('error', `Phone access couldn't start: ${remote.error}`);
  });
  server.listen(port, '0.0.0.0', () => {
    remote = { server, port, error: null };
    engine.addLog('info', `Phone access on: ${localAddresses().map((a) => `http://${a.address}:${port}`).join(', ')}`);
  });
}

function openAtLogin() {
  return app.getLoginItemSettings(isWindows ? { args: ['--hidden'] } : {}).openAtLogin;
}

function setOpenAtLogin(on) {
  app.setLoginItemSettings(isWindows ? { openAtLogin: on, args: ['--hidden'] } : { openAtLogin: on });
}

// ---------------------------------------------------------------- window

function createWindow(show = true) {
  win = new BrowserWindow({
    width: 1120,
    height: 820,
    minWidth: 420,
    minHeight: 400,
    show: false,
    title: 'Roku TV Manager',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#121419' : '#f4f5f7',
    icon: path.join(here, 'assets', isWindows ? 'icon.ico' : 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  win.loadFile(INDEX_HTML);
  if (show) win.once('ready-to-show', () => win.show());

  // Links open in the normal browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  // Closing the window keeps the app (and keep-awake) running in the tray / menu bar.
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
    if (isWindows && !trayHintShown && tray) {
      trayHintShown = true;
      tray.displayBalloon({
        title: 'Roku TV Manager is still running',
        content: 'Keep-awake and schedules keep working. Open or quit it from this tray icon.',
        iconType: 'info',
      });
    }
  });
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function quit() {
  quitting = true;
  app.quit();
}

app.on('before-quit', () => {
  quitting = true;
  presence?.stop();
});
app.on('activate', showWindow);
app.on('window-all-closed', () => { /* stay running in the tray */ });

function setMenu() {
  if (!isMac) return Menu.setApplicationMenu(null);
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    { role: 'editMenu' },
    { label: 'View', submenu: [{ role: 'reload' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { role: 'windowMenu' },
  ]));
}

// ---------------------------------------------------------------- tray / menu bar

function createTray() {
  const image = nativeImage.createFromPath(path.join(here, 'assets', isMac ? 'trayTemplate.png' : 'tray.png'));
  if (isMac) image.setTemplateImage(true);
  tray = new Tray(image);
  tray.setToolTip('Roku TV Manager');
  if (!isMac) tray.on('click', showWindow);
  updateTray();
}

function updateTray() {
  if (!tray || !store) return;
  const s = store.settings();
  const counts = { on: 0, standby: 0, offline: 0 };
  for (const d of store.devices()) counts[engine.statusOf(d.id)?.power ?? 'offline']++;
  const total = counts.on + counts.standby + counts.offline;
  const summary = total
    ? `${total} TV${total === 1 ? '' : 's'}: ${counts.on} on, ${counts.standby} off${counts.offline ? `, ${counts.offline} not responding` : ''}`
    : 'No TVs added yet';
  tray.setToolTip(`Roku TV Manager\n${summary}`);
  const conflict = conflictingPeers();
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Roku TV Manager', click: showWindow },
    ...(update ? [{ label: `Download version ${update.version}\u2026`, click: () => shell.openExternal(update.url) }] : []),
    { type: 'separator' },
    { label: summary, enabled: false },
    ...(s.app.role === 'monitor' ? [{ label: 'Monitor only (another computer is in charge)', enabled: false }] : []),
    ...(conflict.length ? [{ label: `\u26a0 ${conflict.join(', ')} is also in charge`, click: showWindow }] : []),
    {
      label: 'Keep-awake pings',
      type: 'checkbox',
      checked: s.keepawake.enabled,
      click: (item) => store.updateSettings({ keepawake: { enabled: item.checked } }),
    },
    { type: 'separator' },
    { label: 'Quit Roku TV Manager', click: quit },
  ]));
}
