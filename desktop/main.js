'use strict';
/**
 * Streamline desktop app: a normal window (own taskbar icon, pinnable) around the same local server the browser version uses.
 * Closing the window quits, unless programs started with Play are still running; then it stays in the tray.
 */
const { app, BrowserWindow, Tray, Menu, shell, nativeImage } = require('electron');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

let PORT = Number(process.env.PORT) || 4545;
// 127.0.0.1, not "localhost": a project server listening on IPv6 (::1) can never be mistaken for Streamline.
let ORIGIN = `http://127.0.0.1:${PORT}`;
const SMOKE = process.argv.includes('--smoke-test');
const ICON = path.join(__dirname, 'icon.png');
let win = null, tray = null, quitting = false;

const portOpen = port => new Promise(resolve => {
  const s = net.connect({ port, host: '127.0.0.1' });
  s.once('connect', () => { s.destroy(); resolve(true); });
  s.once('error', () => resolve(false));
  s.setTimeout(800, () => { s.destroy(); resolve(false); });
});
const sleep = ms => new Promise(r => setTimeout(r, ms));
const get = p => new Promise((resolve, reject) => {
  http.get(ORIGIN + p, { headers: { Host: `127.0.0.1:${PORT}`, 'X-Streamline': '1' } }, res => { let b = ''; res.on('data', d => { b += d; }); res.on('end', () => resolve({ status: res.statusCode, body: b })); }).on('error', reject);
});

// Brings over projects/settings from a browser-version install (its data folder) the first time this app runs.
function importOldData(dataDir) {
  if (fs.existsSync(path.join(dataDir, 'projects.json'))) return;
  const bases = [process.env.STREAMLINE_IMPORT_FROM, ...['Downloads', 'Documents', 'Desktop', ''].map(d => path.join(os.homedir(), d))].filter(Boolean);
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 4 || found.length) return;
    let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (!e.isDirectory() || /^(node_modules|\.git|AppData|\.[^/\\]*)$/.test(e.name)) continue;
      const full = path.join(dir, e.name);
      if (/^github-bridge$/i.test(e.name) && fs.existsSync(path.join(full, 'data', 'projects.json'))) { found.push(path.join(full, 'data')); return; }
      walk(full, depth + 1);
    }
  };
  for (const b of bases) { if (b && fs.existsSync(path.join(b, 'projects.json'))) { found.push(b); break; } if (b) walk(b, 0); if (found.length) break; }
  if (!found.length) return;
  fs.mkdirSync(dataDir, { recursive: true });
  for (const f of ['projects.json', 'settings.json', 'custom-plays.json', 'health.json']) {
    try { if (fs.existsSync(path.join(found[0], f))) fs.copyFileSync(path.join(found[0], f), path.join(dataDir, f)); } catch { /* skip */ }
  }
}

const isStreamline = port => new Promise(resolve => {
  const req = http.get({ host: '127.0.0.1', port, path: '/api/ping', headers: { Host: `127.0.0.1:${port}` }, timeout: 1500 }, res => {
    let b = ''; res.on('data', d => { b += d; }); res.on('end', () => { try { resolve(JSON.parse(b).app === 'streamline'); } catch { resolve(false); } });
  });
  req.on('error', () => resolve(false)); req.on('timeout', () => { req.destroy(); resolve(false); });
});

async function ensureServer() {
  // Reuse a Streamline that is already running (for example from Start-Streamline.vbs), but never some other
  // program that happens to sit on the port: then Streamline moves to the next free port.
  for (let tries = 0; await portOpen(PORT); tries++) {
    if (await isStreamline(PORT)) { ORIGIN = `http://127.0.0.1:${PORT}`; return; }
    if (tries >= 30) throw new Error('Could not find a free port for Streamline.');
    PORT += 1;
  }
  ORIGIN = `http://127.0.0.1:${PORT}`;
  const dataDir = path.join(app.getPath('userData'), 'data');
  process.env.STREAMLINE_DATA = dataDir;
  process.env.PORT = String(PORT);
  if (!SMOKE) importOldData(dataDir);
  require('./server/server.js');
  for (let i = 0; i < 60; i++) { if (await portOpen(PORT)) return; await sleep(250); }
  throw new Error('The Streamline server did not start.');
}

const liveJobs = () => { try { return require('./server/lib/jobs').list().filter(j => j.status === 'running' || j.live); } catch { return []; } };
function stopEverythingAndQuit() {
  quitting = true;
  try {
    require('./server/lib/proc').setSyncKill(true); // finish every kill before the app exits
    const jobs = require('./server/lib/jobs'); for (const j of liveJobs()) jobs.cancel(j.id);
  } catch { /* nothing to stop */ }
  setTimeout(() => app.quit(), 600);
}

function showWindow() { if (!win) return createWindow(); if (win.isMinimized()) win.restore(); win.show(); win.focus(); }

function createWindow() {
  win = new BrowserWindow({
    width: 1240, height: 900, minWidth: 900, minHeight: 600, title: 'Streamline', icon: ICON,
    autoHideMenuBar: true, backgroundColor: '#f5f6f8',
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false }
  });
  win.setMenu(null);
  win.loadURL(ORIGIN + '/');
  const external = url => { try { return new URL(url).origin !== ORIGIN; } catch { return true; } };
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (external(url)) { e.preventDefault(); if (/^https?:/i.test(url)) shell.openExternal(url); } });
  win.webContents.on('did-fail-load', (e, code, desc, url, isMain) => { if (isMain && code !== -3) setTimeout(() => win && win.loadURL(ORIGIN + '/'), 1500); });
  win.on('close', e => {
    if (quitting) return;
    if (liveJobs().length) { e.preventDefault(); win.hide(); if (tray) tray.displayBalloon && tray.displayBalloon({ title: 'Streamline is still running', content: 'Programs you started are still running. Click the tray icon to reopen, or quit from its menu.' }); }
  });
  win.on('closed', () => { win = null; if (!liveJobs().length) { quitting = true; app.quit(); } });
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
  tray.setToolTip('Streamline');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Streamline', click: showWindow },
    { type: 'separator' },
    { label: 'Quit (stops programs started with Play)', click: stopEverythingAndQuit }
  ]));
  tray.on('click', showWindow);
}

async function smokeTest() {
  const results = [];
  const check = (name, ok, extra) => { results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' ' + extra : ''}`); return ok; };
  let ok = true;
  const page = await get('/'); ok = check('serves the app page', page.status === 200 && /Streamline/.test(page.body)) && ok;
  const css = await get('/style.css'); ok = check('serves styles', css.status === 200) && ok;
  const st = await get('/api/state'); let json = null; try { json = JSON.parse(st.body); } catch { /* fails below */ }
  ok = check('api/state responds', st.status === 200 && json && Array.isArray(json.projects), `(status ${st.status})`) && ok;
  console.log(results.join('\n'));
  return ok;
}

if (!SMOKE && !app.requestSingleInstanceLock()) { app.quit(); }
else {
  app.on('second-instance', showWindow);
  app.on('before-quit', () => { quitting = true; });
  app.on('window-all-closed', () => { if (quitting || !liveJobs().length) app.quit(); });
  app.whenReady().then(async () => {
    try { await ensureServer(); }
    catch (e) { console.error(e.message); if (SMOKE) return app.exit(1); require('electron').dialog.showErrorBox('Streamline could not start', e.message); return app.exit(1); }
    if (SMOKE) {
      try { const ok = await Promise.race([smokeTest(), sleep(25000).then(() => false)]); app.exit(ok ? 0 : 1); } catch (e) { console.error(e.message); app.exit(1); }
      return;
    }
    createTray();
    createWindow();
  });
}
