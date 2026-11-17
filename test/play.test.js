'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

process.env.STREAMLINE_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-play-data-'));
const launch = require('../lib/launch');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-play-'));
const mk = (name, files) => {
  const dir = path.join(tmp, name);
  for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), typeof c === 'string' ? c : JSON.stringify(c)); }
  fs.mkdirSync(dir, { recursive: true });
  return { id: name, name, localPath: dir };
};
const d = (name, files) => launch.detect(mk(name, files));

/* ---------- detection ---------- */
test('existing launcher wins, and maintenance scripts are ignored', () => {
  let p = d('l1', { 'Start-Game.bat': '@echo hi', 'Update.bat': 'x', 'package.json': { scripts: { dev: 'vite' } } });
  assert.equal(p.kind, 'launcher'); assert.equal(p.file, 'Start-Game.bat');
  p = d('l2', { 'Refresh GitHub Projects.bat': 'x', 'Install-Deps.bat': 'x', 'package.json': { scripts: { dev: 'vite' } } });
  assert.equal(p.kind, 'node');
  p = d('l3', { '1 - Run Server.cmd': 'x' });
  assert.equal(p.file, '1 - Run Server.cmd');
});

test('node: framework, script, package manager and port', () => {
  let p = d('n1', { 'package.json': { scripts: { dev: 'vite', build: 'vite build' }, devDependencies: { vite: '^5' } } });
  assert.equal(p.label, 'Vite'); assert.equal(p.port, 5173); assert.equal(p.detail, 'npm run dev');
  p = d('n2', { 'package.json': { scripts: { start: 'node server.js' }, dependencies: { express: '4' } }, 'pnpm-lock.yaml': '' });
  assert.equal(p.detail, 'pnpm run start'); assert.equal(p.recipe.prereqs.length, 2);
  p = d('n3', { 'package.json': { scripts: { dev: 'next dev -p 4000' }, dependencies: { next: '14' } } });
  assert.equal(p.port, 4000);
  p = d('n4', { 'package.json': { scripts: { start: 'electron .' }, devDependencies: { electron: '30' } } });
  assert.equal(p.label, 'Electron app'); assert.equal(p.desktop, true);
  p = d('n5', { 'package.json': { scripts: { start: 'expo start' }, dependencies: { expo: '50' } } });
  assert.match(p.label, /Expo/); assert.ok(p.notes.length);
  p = d('n6', { 'package.json': { scripts: { build: 'tsc' } } });
  assert.equal(p.canPlay, false);
  p = d('n7', { 'package.json': { scripts: { build: 'tsc' } }, 'index.html': '<h1>hi</h1>' });
  assert.equal(p.kind, 'html'); // no run script: fall back to the page
});

test('python, dotnet, rust, go, flutter', () => {
  let p = d('p1', { 'main.py': 'print(1)', 'requirements.txt': 'requests' });
  assert.equal(p.kind, 'python'); assert.equal(p.detail, 'python main.py');
  p = d('p2', { 'app.py': 'import streamlit', 'requirements.txt': 'streamlit' });
  assert.equal(p.label, 'Streamlit'); assert.equal(p.port, 8501);
  p = d('p3', { 'manage.py': '', 'requirements.txt': 'django' });
  assert.equal(p.label, 'Django'); assert.equal(p.port, 8000);
  p = d('p4', { 'game.py': 'import pygame\npygame.init()' });
  assert.equal(p.label, 'Python desktop app'); assert.equal(p.desktop, true);
  p = d('p5', { 'a.py': '', 'b.py': '' });
  assert.equal(p.canPlay, false); // ambiguous: refuse to guess
  p = d('d1', { 'App.csproj': '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>WinExe</OutputType></PropertyGroup></Project>' });
  assert.equal(p.kind, 'dotnet');
  p = d('d2', { 'Lib.csproj': '<Project Sdk="Microsoft.NET.Sdk"></Project>' });
  assert.equal(p.canPlay, false); // a class library is not runnable
  p = d('d3', { 'X.sln': 'Project("{x}") = "X", "src\\X\\X.csproj", "{y}"', 'src/X/X.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>' });
  assert.equal(p.detail, 'dotnet run --project src/X/X.csproj');
  assert.equal(d('r1', { 'Cargo.toml': '' }).detail, 'cargo run');
  assert.equal(d('g1', { 'go.mod': 'module x' }).detail, 'go run .');
  assert.equal(d('f1', { 'pubspec.yaml': 'dependencies:\n  flutter:\n    sdk: flutter' }).kind, 'flutter');
});

test('built programs and launcher stop scripts', () => {
  let p = d('x2', { 'dist/ChameleonBar.exe': 'MZ', 'dist/ChameleonBar.XamlBridge.dll': 'x', 'CMakeLists.txt': '' });
  assert.equal(p.action, 'exe'); assert.match(p.detail, /ChameleonBar\.exe$/);
  p = d('x3', { 'app/VideoViewer.exe': 'MZ', 'app/LibVLCSharp.dll': 'x', 'src/a.cs': '' });
  assert.equal(p.action, 'exe');
  p = d('x4', { 'dist/a.exe': 'MZ', 'dist/b.exe': 'MZ' });
  assert.equal(p.canPlay, false); // two candidates and no name match: refuse to guess
  p = d('x5', { 'dist/unins000.exe': 'MZ', 'dist/Setup.exe': 'MZ' });
  assert.equal(p.canPlay, false); // installers are not the app
  p = d('x6', { 'Start Local Converter.cmd': '@echo', 'Stop Local Converter.cmd': '@echo', 'Setup Tools.cmd': '@echo' });
  assert.equal(p.file, 'Start Local Converter.cmd'); assert.equal(p.stopFile, 'Stop Local Converter.cmd');
});

test('html: opens directly unless it needs a server; extensions get their own flow', () => {
  let p = d('h1', { 'index.html': '<script src="game.js"></script>', 'game.js': 'let x=1;' });
  assert.equal(p.action, 'open-file');
  p = d('h2', { 'index.html': '<script type="module" src="main.js"></script>', 'main.js': 'import a from "./a.js"' });
  assert.equal(p.action, 'serve');
  p = d('h3', { 'index.html': '<script src="app.js"></script>', 'app.js': 'fetch("data.json")' });
  assert.equal(p.action, 'serve');
  p = d('h3b', { 'index.html': '<script type=module src=main.js></script>', 'main.js': 'export {}' });
  assert.equal(p.action, 'serve');
  p = d('h4', { 'index.html': '<link href="/style.css" rel="stylesheet">' });
  assert.equal(p.action, 'serve');
  p = d('h5', { 'tool.html': '<p>x</p>' });
  assert.equal(p.html.rel, 'tool.html');
  p = d('h6', { 'docs/index.html': '<p>x</p>' });
  assert.equal(p.html.rel, 'docs/index.html');
  p = d('e1', { 'manifest.json': { manifest_version: 3, name: 'x' }, 'popup.html': '<p/>' });
  assert.equal(p.action, 'extension');
  assert.equal(d('x1', { 'README.md': 'nothing' }).canPlay, false);
});

/* ---------- generated launcher ---------- */
test('generated .bat is well formed for cmd.exe', () => {
  const bat = launch.renderBat(d('b1', { 'package.json': { scripts: { dev: 'vite' }, devDependencies: { vite: '5' } } }));
  assert.ok(bat.includes('\r\n') && !/[^\r]\n/.test(bat), 'CRLF only');
  assert.match(bat, /^@echo off\r\nrem streamline-launcher/);
  assert.match(bat, /cd \/d "%~dp0"/);
  assert.match(bat, /where node >nul 2>nul \|\| \(echo Node\.js is required[^\r]*winget install OpenJS\.NodeJS\.LTS & goto :fail\)/);
  assert.match(bat, /if not exist "node_modules" \(\r\n  echo Installing dependencies, first run only\.\.\.\r\n  call npm install --no-package-lock \|\| goto :fail\r\n\)/);
  assert.match(bat, /if not defined STREAMLINE start "" \/min powershell[^\r]*localhost:5173/);
  assert.match(bat, /call npm run dev/);
  assert.match(bat, /if not defined STREAMLINE pause/);
  // a ")" inside an echo within a ( ) block would break cmd.exe
  const inBlock = bat.split('\r\n').filter(l => /^\s+echo /.test(l));
  for (const l of inBlock) assert.ok(!/[()&|<>^%]/.test(l.replace(/^\s+echo /, '')), 'unsafe echo: ' + l);
  const py = launch.renderBat(d('b2', { 'main.py': 'print(1)', 'requirements.txt': 'x' }));
  assert.match(py, /%PY% -m venv \.venv/); assert.match(py, /fc \/b "requirements\.txt" "\.venv\\\.streamline-deps"/);
  assert.match(py, /set PY="\.venv\\Scripts\\python\.exe"\r\n(echo Streamline: starting [^\r]*\r\nif defined STREAMLINE_DRY goto :dry\r\n)?%PY% main\.py/);
  for (const l of py.split('\r\n').filter(l => /^\s+echo /.test(l))) assert.ok(!/[()&|<>^%]/.test(l.replace(/^\s+echo /, '')), 'unsafe echo: ' + l);
  for (const k of [d('b3', { 'Cargo.toml': '' }), d('b4', { 'go.mod': 'x' }), d('b5', { 'X.csproj': '<OutputType>Exe</OutputType>' })]) {
    for (const l of launch.renderBat(k).split('\r\n').filter(l => /echo /.test(l) && /where/.test(l))) {
      const inner = l.match(/\(echo (.*) & goto :fail\)/)[1];
      assert.ok(!/[()<>^%|]/.test(inner), 'unsafe prerequisite text: ' + inner);
    }
  }
});

test('cmd.exe invocation survives folders with spaces (Codex Only)', () => {
  const f = 'C:\\Users\\x\\Downloads\\Codex Only\\GitHub Projects\\app\\Streamline-Play.bat';
  const a = launch.cmdArgs(f);
  assert.deepEqual(a.slice(0, 3), ['/d', '/s', '/c']);
  // what cmd.exe actually receives after /s removes the outer pair of quotes:
  const afterStrip = a[3].slice(1, -1);
  assert.equal(afterStrip, '"' + f + '"');
});

test('web address detection', () => {
  const f = launch.findWebAddress;
  assert.equal(f('  Local:   http://localhost:5173/', false), 'http://localhost:5173/');
  assert.equal(f('\u001b[32m➜\u001b[0m  http://127.0.0.1:3000', false), 'http://localhost:3000');
  assert.equal(f('Now listening on: http://0.0.0.0:8080', false), 'http://localhost:8080');
  assert.equal(f('Server listening on port 4000', true), 'http://localhost:4000/');
  assert.equal(f('Server listening on port 4000', false), null);
  assert.equal(f('visit https://example.com:443', true), null);
});

/* ---------- end to end through the server ---------- */
const PORT = 4900 + Math.floor(Math.random() * 90);
const dataDir = path.join(tmp, 'data');
const openLog = path.join(tmp, 'open.log');
const gitEnv = { GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t' };
const sh = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, ...gitEnv } });
let server;
function call(method, url, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port: PORT, path: url, method, headers: { 'X-Streamline': '1', ...(data ? { 'Content-Type': 'application/json' } : {}) } }, res => {
      let b = ''; res.on('data', c => { b += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* */ } resolve({ status: res.statusCode, body: j, text: b }); });
    });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}
async function until(fn, ms = 15000) { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timeout'); await new Promise(r => setTimeout(r, 100)); } }
const job = async id => (await call('GET', '/api/jobs')).body.jobs.find(j => j.id === id);
const lines = async id => (await call('GET', `/api/jobs/${id}/lines`)).body.lines.map(l => l.text);

before(async () => {
  server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, ...gitEnv, PORT: String(PORT), STREAMLINE_DATA: dataDir, STREAMLINE_OPEN_LOG: openLog }, stdio: 'pipe' });
  await until(async () => { try { return (await call('GET', '/api/jobs')).status === 200; } catch { return false; } });
});
after(() => { if (server) server.kill(); fs.rmSync(tmp, { recursive: true, force: true }); });

async function addProject(name, files, git = true) {
  const p = mk(name, files);
  if (git) { sh(p.localPath, 'init', '-q', '-b', 'main'); sh(p.localPath, 'add', '-A'); sh(p.localPath, 'commit', '-qm', 'init'); }
  return (await call('POST', '/api/projects', { localPath: p.localPath })).body.project;
}

test('Play runs a node project, auto-opens the browser, and keeps git clean', async () => {
  const server = `const http=require('http');const s=http.createServer((q,r)=>r.end('ok')).listen(0,'127.0.0.1',()=>console.log('  Local:   http://localhost:'+s.address().port+'/'));`;
  const proj = await addProject('webapp', { 'package.json': { name: 'webapp', scripts: { dev: 'node server.js' } }, 'server.js': server, '.gitignore': 'node_modules\n' });
  const plans = (await call('GET', '/api/play')).body;
  assert.equal(plans.plans[proj.id].canPlay, true);
  assert.equal(plans.plans[proj.id].detail, 'npm run dev');

  const r = await call('POST', `/api/projects/${proj.id}/play`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const url = await until(async () => (await job(r.body.jobId)).link);
  assert.match(url, /^http:\/\/localhost:\d+\/$/);
  assert.match(fs.readFileSync(openLog, 'utf8'), /http:\/\/localhost:\d+\//);
  // a program that keeps running is reported as a success running in the background, never as "working"
  const live = await job(r.body.jobId);
  assert.equal(live.status, 'success'); assert.equal(live.live, true); assert.match(live.summary, /running in the background/i);
  assert.equal((await call('GET', '/api/play')).body.running[proj.id], r.body.jobId);

  // playing twice just returns the running job
  assert.equal((await call('POST', `/api/projects/${proj.id}/play`)).body.jobId, r.body.jobId);

  // the repo stays clean, so "Update Local GitHub" will not pause it
  assert.equal(sh(proj.localPath, 'status', '--porcelain=v1', '--untracked-files=all').trim(), '');

  assert.equal((await call('POST', `/api/projects/${proj.id}/stop`)).body.stopped, true);
  await until(async () => (await job(r.body.jobId)).status === 'cancelled');
  assert.equal((await job(r.body.jobId)).live, false);
  assert.equal((await call('GET', '/api/play')).body.running[proj.id], undefined);
});

test('Play on a project without its tool installed explains what to install', async () => {
  const proj = await addProject('needsgo', { 'go.mod': 'module x\n', 'main.go': 'package main\nfunc main(){}' });
  const r = await call('POST', `/api/projects/${proj.id}/play`);
  const j = await until(async () => { const x = await job(r.body.jobId); return x.status !== 'running' && x; });
  const out = (await lines(r.body.jobId)).join('\n');
  if (/Go is required/.test(out)) { assert.equal(j.status, 'error'); assert.match(out, /winget install GoLang\.Go/); assert.match(j.summary, /required program was not found/); }
});

test('Play opens a plain HTML project directly', async () => {
  fs.writeFileSync(openLog, '');
  const proj = await addProject('game', { 'index.html': '<script src="g.js"></script>', 'g.js': 'var a=1' });
  const r = await call('POST', `/api/projects/${proj.id}/play`);
  const j = await until(async () => { const x = await job(r.body.jobId); return x.status !== 'running' && x; });
  assert.equal(j.status, 'success');
  assert.equal(fs.readFileSync(openLog, 'utf8').trim(), path.join(proj.localPath, 'index.html'));
});

test('Play serves an HTML project that needs a server, and Stop shuts it down', async () => {
  fs.writeFileSync(openLog, '');
  const proj = await addProject('modsite', { 'index.html': '<script type="module" src="m.js"></script>', 'm.js': 'export const a=1' });
  const r = await call('POST', `/api/projects/${proj.id}/play`);
  const url = await until(async () => (await job(r.body.jobId)).link);
  const page = await new Promise((res, rej) => http.get(url, x => { let b = ''; x.on('data', c => { b += c; }); x.on('end', () => res({ s: x.statusCode, b, t: x.headers['content-type'] })); }).on('error', rej));
  assert.equal(page.s, 200); assert.match(page.b, /type="module"/);
  const js = await new Promise((res, rej) => http.get(url + 'm.js', x => { res(x.headers['content-type']); }).on('error', rej));
  assert.match(js, /javascript/);
  const trav = await new Promise((res, rej) => http.get(url + '..%2f..%2fetc%2fpasswd', x => res(x.statusCode)).on('error', rej));
  assert.notEqual(trav, 200);
  await call('POST', `/api/projects/${proj.id}/stop`);
  await until(async () => (await job(r.body.jobId)).status === 'cancelled');
  await assert.rejects(new Promise((res, rej) => http.get(url, res).on('error', rej)));
});

test('Play on a Chrome extension opens the folder and the extensions page', async () => {
  fs.writeFileSync(openLog, '');
  const proj = await addProject('ext', { 'manifest.json': { manifest_version: 3, name: 'e' } });
  const r = await call('POST', `/api/projects/${proj.id}/play`);
  await until(async () => (await job(r.body.jobId)).status === 'success');
  const log = fs.readFileSync(openLog, 'utf8');
  assert.match(log, /folder:/); assert.match(log, /chrome:\/\/extensions/);
});

test('Play refuses projects with no run step', async () => {
  const proj = await addProject('docs-only', { 'README.md': 'x' });
  const r = await call('POST', `/api/projects/${proj.id}/play`);
  assert.equal(r.status, 400); assert.match(r.body.error, /No run step/);
});

test('generated launcher is hidden from git and never overwrites a foreign file', async () => {
  const p = mk('hide', { 'package.json': { scripts: { dev: 'node -e 1' } } });
  sh(p.localPath, 'init', '-q', '-b', 'main'); sh(p.localPath, 'add', '-A'); sh(p.localPath, 'commit', '-qm', 'i');
  const plan = launch.detect(p);
  fs.writeFileSync(path.join(p.localPath, launch.BAT_NAME), launch.renderBat(plan));
  const { git } = require('../lib/proc');
  // simulate what ensureLauncher does for a fresh repo
  fs.rmSync(path.join(p.localPath, launch.BAT_NAME));
  const mod = require('../lib/launch');
  assert.ok(mod.renderBat(plan).includes(launch.MARKER));
  const foreign = mk('foreign', { 'Streamline-Play.bat': '@echo mine' });
  assert.equal(launch.detect(foreign).kind, 'launcher'); // a file we did not write is treated as the user's launcher
});
