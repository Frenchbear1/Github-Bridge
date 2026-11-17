'use strict';
/**
 * Play button engine.
 *   detect(project)  -> plan   (what "Play" means for this project)
 *   start(project)   -> jobId  (runs it, streams output, opens the browser when a web address appears)
 *   stop(project)    -> bool
 *
 * Generated launchers (Streamline-Play.bat) are written into the project but hidden from Git through
 * .git/info/exclude, so they never show up as "untracked files" and never get committed or pushed.
 */
const fs = require('fs');
const net = require('net');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const jobs = require('./jobs');
const custom = require('./custom');
const { run, git, killTree, killPort, childEnv } = require('./proc');
const { openUrl, openFolderWindow, openChromeExtensions } = require('./open');
const { IS_WIN } = require('./util');
const { spawn } = require('child_process');

const MARKER = 'streamline-launcher';
const BAT_NAME = 'Streamline-Play.bat';
const RUN_MARK = 'Streamline: starting ';

/* ------------------------------------------------------------------ helpers */
const read = p => { try { return fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''); } catch { return null; } };
const has = (dir, f) => fs.existsSync(path.join(dir, f));
const readJson = p => { const t = read(p); if (!t) return null; try { return JSON.parse(t); } catch { return null; } };
const listDir = dir => { try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; } };
// cmd.exe /s /c removes the first and last quote of the command line, so a path with spaces needs an extra pair:
//   cmd /d /s /c ""C:\My Folder\run.bat""
const cmdArgs = file => ['/d', '/s', '/c', `""${file}""`];
const safeTitle = s => String(s).replace(/[^A-Za-z0-9 ._-]/g, '').trim() || 'Project';

const HINTS = {
  node:   { name: 'Node.js',        hint: 'winget install OpenJS.NodeJS.LTS' },
  pnpm:   { name: 'pnpm',           hint: 'npm install -g pnpm' },
  yarn:   { name: 'Yarn',           hint: 'npm install -g yarn' },
  bun:    { name: 'Bun',            hint: 'winget install Oven-sh.Bun' },
  dotnet: { name: '.NET SDK',       hint: 'winget install Microsoft.DotNet.SDK.8' },
  cargo:  { name: 'Rust cargo',   hint: 'winget install Rustlang.Rustup' },
  go:     { name: 'Go',             hint: 'winget install GoLang.Go' },
  flutter:{ name: 'Flutter',        hint: 'winget install Google.Flutter' },
  python: { name: 'Python',         hint: 'winget install Python.Python.3.12' }
};
const prereq = exe => ({ exe, ...HINTS[exe] });

/* ------------------------------------------------------------------ detection */
const GOOD_LAUNCHER = /(start|launch|play|run|serve)/i;
const BAD_LAUNCHER = /(refresh|update|sync|install|uninstall|build|setup|stop|kill|clean|deploy|publish|test|package|release|backup|push|pull)/i;

function findExistingLauncher(dir) {
  const c = listDir(dir)
    .filter(e => e.isFile() && /\.(bat|cmd|vbs)$/i.test(e.name))
    .filter(e => !/^streamline-/i.test(e.name) || (e.name.toLowerCase() === BAT_NAME.toLowerCase() && !isOurs(path.join(dir, e.name))))
    .map(e => ({ name: e.name, score: (GOOD_LAUNCHER.test(e.name) ? 10 : 0) - (BAD_LAUNCHER.test(e.name) ? 20 : 0) + (/\.bat$/i.test(e.name) ? 1 : 0) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  if (!c.length) return null;
  const stop = listDir(dir).find(e => e.isFile() && /\.(bat|cmd|vbs)$/i.test(e.name) && /stop/i.test(e.name) && !/^streamline-/i.test(e.name));
  return { file: c[0].name, others: c.slice(1).map(x => x.name), stopFile: stop ? stop.name : null };
}

function isOurs(file) {
  const t = read(file);
  return !!t && t.slice(0, 400).includes(MARKER);
}

function nodePlan(dir, name) {
  const pkg = readJson(path.join(dir, 'package.json'));
  if (!pkg) return null;
  const scripts = pkg.scripts || {};
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const pm = has(dir, 'pnpm-lock.yaml') ? 'pnpm' : has(dir, 'yarn.lock') ? 'yarn' : (has(dir, 'bun.lockb') || has(dir, 'bun.lock')) ? 'bun' : 'npm';
  const desktop = !!(deps.electron || deps['@tauri-apps/cli']);
  const order = (desktop || deps.expo) ? ['start', 'dev', 'tauri:dev', 'serve'] : ['dev', 'start', 'serve', 'preview', 'develop'];
  const key = order.find(k => scripts[k]);
  if (!key) {
    if (deps.electron && pkg.main) return { label: 'Electron app', cmd: 'npx electron .', exe: 'npx', args: ['electron', '.'], pm: 'npm', desktop: true, install: true, port: null, autoOpens: false };
    return null;
  }
  const text = String(scripts[key]);
  let label = 'Node app';
  let port = null;
  let autoOpens = false;
  const f = [
    [deps.expo || /\bexpo\b/.test(text), 'Expo (Metro bundler)', null],
    [deps.electron, 'Electron app', null],
    [deps['@tauri-apps/cli'], 'Tauri app', null],
    [deps.next || /\bnext\b/.test(text), 'Next.js', 3000],
    [deps.vite || /\bvite\b/.test(text), 'Vite', 5173],
    [deps['react-scripts'], 'Create React App', 3000, true],
    [deps.astro || /\bastro\b/.test(text), 'Astro', 4321],
    [deps['@sveltejs/kit'], 'SvelteKit', 5173],
    [deps.nuxt, 'Nuxt', 3000],
    [deps['@angular/cli'], 'Angular', 4200],
    [deps.gatsby, 'Gatsby', 8000],
    [deps.parcel || /\bparcel\b/.test(text), 'Parcel', 1234],
    [deps['webpack-dev-server'] || /webpack serve/.test(text), 'Webpack dev server', 8080],
    [deps.express || deps.fastify || deps.koa, 'Node server', null]
  ].find(x => x[0]);
  if (f) { label = f[1]; port = f[2]; autoOpens = !!f[3]; }
  const explicit = text.match(/(?:--port[= ]|-p |PORT=)(\d{2,5})\b/);
  if (explicit) port = Number(explicit[1]);
  const runCmd = pm === 'npm' && key === 'start' ? 'npm start' : `${pm} run ${key}`;
  const [exe, ...args] = runCmd.split(' ');
  return { label, cmd: runCmd, exe, args, pm, desktop: desktop || !!deps.expo, install: true, port, autoOpens, script: key };
}

function pythonPlan(dir, name) {
  const req = (read(path.join(dir, 'requirements.txt')) || '').toLowerCase();
  const pyproject = read(path.join(dir, 'pyproject.toml'));
  const rootPy = listDir(dir).filter(e => e.isFile() && /\.py$/i.test(e.name)).map(e => e.name);
  const depsFile = has(dir, 'requirements.txt') ? 'requirements.txt' : (pyproject && /\bdependencies\s*=/.test(pyproject) ? 'pyproject.toml' : null);
  let run = null;
  let label = 'Python app';
  let port = null;
  let autoOpens = false;
  if (has(dir, 'manage.py')) { run = ['manage.py', 'runserver']; label = 'Django'; port = 8000; }
  else {
    const guess = ['main.py', 'app.py', 'run.py', 'server.py', 'start.py', 'gui.py', 'game.py', name.toLowerCase().replace(/[-\s]+/g, '_') + '.py'];
    let entry = guess.find(g => rootPy.some(r => r.toLowerCase() === g.toLowerCase()));
    if (entry) entry = rootPy.find(r => r.toLowerCase() === entry.toLowerCase());
    if (!entry && rootPy.length === 1) entry = rootPy[0];
    if (!entry && has(dir, '__main__.py')) entry = '__main__.py';
    if (!entry) return null;
    const src = (read(path.join(dir, entry)) || '').toLowerCase();
    if (/\bstreamlit\b/.test(req)) { run = ['-m', 'streamlit', 'run', entry, '--server.headless', 'true']; label = 'Streamlit'; port = 8501; autoOpens = false; }
    else if (/fastapi\(/.test(src) && !/uvicorn\.run\(/.test(src) && /uvicorn/.test(req)) { run = ['-m', 'uvicorn', entry.replace(/\.py$/i, '') + ':app', '--reload']; label = 'FastAPI'; port = 8000; }
    else {
      run = [entry];
      if (/\bflask\b/.test(req) || /flask\(/.test(src)) { label = 'Flask'; port = 5000; }
      else if (/tkinter|pygame|pyqt|pyside|kivy|customtkinter|mainloop\(/.test(src + req)) label = 'Python desktop app';
    }
  }
  return { label, run, depsFile, port, autoOpens, desktop: label === 'Python desktop app' };
}

function dotnetPlan(dir) {
  const ents = listDir(dir);
  const csproj = ents.find(e => e.isFile() && /\.csproj$/i.test(e.name));
  const sln = ents.find(e => e.isFile() && /\.sln$/i.test(e.name));
  const isApp = txt => /<OutputType>\s*(Win)?Exe/i.test(txt) || /Sdk="Microsoft\.NET\.Sdk\.Web"/i.test(txt);
  if (csproj) {
    const t = read(path.join(dir, csproj.name)) || '';
    if (!isApp(t)) return null;
    return { label: /Sdk\.Web/i.test(t) ? 'ASP.NET app' : '.NET app', args: ['run'], web: /Sdk\.Web/i.test(t) };
  }
  if (sln) {
    const t = read(path.join(dir, sln.name)) || '';
    for (const m of t.matchAll(/"([^"]+\.csproj)"/gi)) {
      const rel = m[1].replace(/\\/g, '/');
      const body = read(path.join(dir, ...rel.split('/'))) || '';
      if (isApp(body)) return { label: /Sdk\.Web/i.test(body) ? 'ASP.NET app' : '.NET app', args: ['run', '--project', rel], web: /Sdk\.Web/i.test(body) };
    }
  }
  return null;
}

const EXE_DIRS = ['', 'dist', 'app', 'bin', 'out', 'release', 'Release', 'build', 'build/Release', 'bin/Release', 'x64/Release', 'dist/win-unpacked'];
const EXE_SKIP = /(unins|setup|install|update|crash|redist|vcredist|helper|launcher_old)/i;
function findBuiltExe(dir, name) {
  const found = [];
  for (const sub of EXE_DIRS) {
    const base = sub ? path.join(dir, ...sub.split('/')) : dir;
    for (const e of listDir(base)) if (e.isFile() && /\.exe$/i.test(e.name) && !EXE_SKIP.test(e.name)) found.push(path.join(base, e.name));
  }
  if (!found.length) return null;
  const want = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  const match = found.filter(f => path.basename(f, '.exe').toLowerCase().replace(/[^a-z0-9]/g, '') === want);
  if (match.length) return match[0];
  return found.length === 1 ? found[0] : null;
}

const HTML_SPOTS = ['index.html', 'public/index.html', 'docs/index.html', 'dist/index.html', 'build/index.html', 'src/index.html'];
function htmlPlan(dir) {
  let rel = HTML_SPOTS.find(p => has(dir, p));
  if (!rel) {
    const htmls = listDir(dir).filter(e => e.isFile() && /\.html?$/i.test(e.name));
    if (htmls.length === 1) rel = htmls[0].name;
  }
  if (!rel) return null;
  return analyzeHtml(dir, rel);
}

function analyzeHtml(dir, rel) {
  const root = path.dirname(path.join(dir, rel));
  const html = (read(path.join(dir, rel)) || '').slice(0, 400000);
  const reasons = [];
  if (/type\s*=\s*["']?module\b/i.test(html)) reasons.push('uses ES modules');
  if (/\b(?:src|href)\s*=\s*["']?\/(?!\/)/i.test(html)) reasons.push('uses root-relative links');
  const scripts = [...html.matchAll(/<script[^>]+src\s*=\s*["']?([^"'\s>:]+)/gi)].map(m => m[1]).slice(0, 12);
  for (const s of scripts) {
    const js = (read(path.join(root, s.split('?')[0])) || '').slice(0, 300000);
    if (/\bfetch\s*\(|XMLHttpRequest|\bimport\s+[^;]*from\s+['"]|serviceWorker|new Worker\(/.test(js)) { reasons.push(`${path.basename(s)} loads files or modules`); break; }
  }
  if (/\bfetch\s*\(|XMLHttpRequest|serviceWorker/.test(html)) reasons.push('loads data at runtime');
  return { rel, root, serve: reasons.length > 0, reasons: [...new Set(reasons)] };
}

const SAFE_AUTO_EXCLUDE = new Set(['node_modules', '.venv', 'venv', 'target', 'obj', '.next', '.expo', '__pycache__']);


/** Command-line tools that wait for typing (input(), readline, prompts) need a real console window, not a hidden one. */
function looksInteractive(dir, cwd, tokens) {
  const file = tokens.find(t => /\.(py|js|mjs|cjs)$/i.test(t));
  if (!file) return false;
  const text = read(path.join(dir, cwd || '', ...file.replace(/\\/g, '/').split('/')));
  if (!text || text.length > 400000) return false;
  if (/\.py$/i.test(file)) return /\binput\s*\(/.test(text) && !/(tkinter|PyQt|PySide|wx\b|kivy|pygame|flask|fastapi|streamlit|uvicorn|django|gradio|nicegui)/i.test(text);
  return /(require\(['"]readline['"]\)|from ['"](node:)?readline|inquirer|prompts|process\.stdin)/.test(text) && !/(express|http\.createServer|fastify|koa|electron)/.test(text);
}

function customPlan(base, dir, cfg) {
  const common = { ...base, kind: 'custom', source: 'custom', label: 'Custom setup', canPlay: true, notes: cfg.notes ? [cfg.notes] : [] };
  if (cfg.kind === 'open-file') {
    const html = analyzeHtml(dir, cfg.file);
    return { ...common, action: html.serve ? 'serve' : 'open-file', detail: html.serve ? `Serves ${cfg.file} on localhost` : `Opens ${cfg.file}`, html };
  }
  if (cfg.kind === 'exe') return { ...common, action: 'exe', detail: cfg.file, exe: path.join(dir, ...cfg.file.split('/')) };
  const port = cfg.openUrl ? Number(new URL(cfg.openUrl).port) : null;
  const exclude = cfg.setup.map(s => s.skipIfExists).filter(x => x && SAFE_AUTO_EXCLUDE.has(path.basename(x))).map(x => x.replace(/\/?$/, '/'));
  return { ...common, action: 'script', detail: cfg.run.cmd, port, openUrl: cfg.openUrl || null, autoOpens: false, desktop: !!cfg.opensWindow, interactive: !!cfg.interactive || (!cfg.opensWindow && !port && looksInteractive(dir, cfg.run.cwd, cfg.run.cmd.split(/\s+/))),
    recipe: {
      prereqs: cfg.needs.map(n => ({ exe: n.exe, name: n.exe, hint: n.install || 'Install it, then try again' })),
      setup: cfg.setup.map(st => ({ type: 'custom-step', ...st })),
      run: { cmd: cfg.run.cmd, cwd: cfg.run.cwd, env: cfg.run.env || {} }
    }, exclude };
}

/** Works out what Play means for a project. Never changes anything. */
function detect(project) {
  const dir = path.resolve(project.localPath);
  const name = project.name || path.basename(dir);
  const base = { name, dir, notes: [], exclude: [] };
  if (!fs.existsSync(dir)) return { ...base, kind: 'none', action: 'none', label: 'Folder missing', detail: '', canPlay: false, source: 'auto' };

  const cfg = project.id ? custom.get(project.id) : null;
  if (cfg) return customPlan(base, dir, cfg);

  const existing = findExistingLauncher(dir);
  if (existing) {
    return { ...base, kind: 'launcher', action: 'existing', source: 'existing', label: 'Your launcher', detail: existing.file, file: existing.file,
      canPlay: true, stopFile: existing.stopFile, notes: existing.others.length ? [`Other scripts here: ${existing.others.join(', ')}`] : [] };
  }

  const n = nodePlan(dir, name);
  if (n) {
    const pre = [prereq('node')];
    if (n.pm !== 'npm') pre.push(prereq(n.pm));
    // Installing must never create or rewrite a lock file: that would make the repo "dirty" and pause Update Local GitHub.
    const locked = has(dir, { npm: 'package-lock.json', pnpm: 'pnpm-lock.yaml', yarn: 'yarn.lock', bun: has(dir, 'bun.lock') ? 'bun.lock' : 'bun.lockb' }[n.pm]);
    const installCmds = {
      npm: locked ? ['npm ci', 'npm install --no-package-lock'] : ['npm install --no-package-lock'],
      pnpm: locked ? ['pnpm install --frozen-lockfile', 'pnpm install --no-lockfile'] : ['pnpm install --no-lockfile'],
      yarn: ['yarn install --frozen-lockfile', 'yarn install --immutable', 'yarn install'],
      bun: ['bun install --frozen-lockfile', 'bun install']
    }[n.pm];
    const notes = [];
    if (/expo/i.test(n.label)) notes.push('Expo starts the Metro bundler. Scan the QR code from the output with Expo Go on your phone.');
    return { ...base, kind: 'node', action: 'script', source: 'auto', label: n.label, detail: n.cmd, canPlay: true, port: n.port, autoOpens: n.autoOpens, desktop: n.desktop,
      recipe: { prereqs: pre, setup: [{ type: 'install-if-missing', dir: 'node_modules', say: 'Installing dependencies, first run only...', cmds: installCmds }], run: { cmd: n.cmd } },
      exclude: ['node_modules/'], notes };
  }

  const py = pythonPlan(dir, name);
  if (py) {
    const setup = [{ type: 'python-env', depsFile: py.depsFile }];
    return { ...base, kind: 'python', action: 'script', source: 'auto', label: py.label, detail: 'python ' + py.run.join(' '), canPlay: true, port: py.port, autoOpens: py.autoOpens, desktop: py.desktop, interactive: !py.desktop && !py.port && looksInteractive(dir, '', py.run),
      recipe: { prereqs: [prereq('python')], setup, run: { python: py.run } }, exclude: py.depsFile ? ['.venv/', '__pycache__/'] : ['__pycache__/'] };
  }

  const dn = dotnetPlan(dir);
  if (dn) return { ...base, kind: 'dotnet', action: 'script', source: 'auto', label: dn.label, detail: 'dotnet ' + dn.args.join(' '), canPlay: true, desktop: !dn.web,
    recipe: { prereqs: [prereq('dotnet')], setup: [], run: { cmd: 'dotnet ' + dn.args.map(a => (/\s/.test(a) ? `"${a}"` : a)).join(' ') } }, exclude: ['obj/', 'bin/Debug/', 'bin/Release/'] };

  if (has(dir, 'Cargo.toml')) return { ...base, kind: 'rust', action: 'script', source: 'auto', label: 'Rust app', detail: 'cargo run', canPlay: true, desktop: true,
    recipe: { prereqs: [prereq('cargo')], setup: [], run: { cmd: 'cargo run' } }, exclude: ['target/'], notes: ['The first run compiles the project and can take a few minutes.'] };

  if (has(dir, 'go.mod')) return { ...base, kind: 'go', action: 'script', source: 'auto', label: 'Go app', detail: 'go run .', canPlay: true,
    recipe: { prereqs: [prereq('go')], setup: [], run: { cmd: 'go run .' } } };

  if (has(dir, 'pubspec.yaml') && /flutter/.test(read(path.join(dir, 'pubspec.yaml')) || '')) return { ...base, kind: 'flutter', action: 'script', source: 'auto', label: 'Flutter app', detail: 'flutter run -d windows', canPlay: true, desktop: true,
    recipe: { prereqs: [prereq('flutter')], setup: [], run: { cmd: 'flutter run -d windows' } }, exclude: ['build/', '.dart_tool/'] };

  const exe = findBuiltExe(dir, name);
  if (exe) return { ...base, kind: 'exe', action: 'exe', source: 'auto', label: 'Built program', detail: path.relative(dir, exe), exe, canPlay: true,
    notes: ['Runs the program that is already built in this project. Rebuild it yourself when you change the code.'] };

  const manifest = readJson(path.join(dir, 'manifest.json'));
  if (manifest && typeof manifest.manifest_version === 'number') {
    return { ...base, kind: 'extension', action: 'extension', source: 'auto', label: 'Chrome extension', detail: 'Opens chrome://extensions and this folder', canPlay: true,
      notes: ['Turn on Developer mode, click "Load unpacked", and choose this project folder (it opens for you).'] };
  }

  const html = htmlPlan(dir);
  if (html) {
    return { ...base, kind: 'html', action: html.serve ? 'serve' : 'open-file', source: 'auto', label: html.serve ? 'Web page (served locally)' : 'Web page',
      detail: html.serve ? `Serves ${html.rel} on localhost` : `Opens ${html.rel}`, canPlay: true, html,
      notes: html.serve ? [`Served by Streamline because it ${html.reasons.join(' and ')}.`] : [] };
  }

  const found = [];
  if (has(dir, 'package.json')) found.push('package.json has no dev/start script');
  return { ...base, kind: 'none', action: 'none', source: 'auto', label: 'No run step found', detail: found.join(', '), canPlay: false };
}

function previewCustom(project, cfg) {
  const dir = path.resolve(project.localPath);
  const plan = customPlan({ name: project.name, dir, notes: [], exclude: [] }, dir, cfg);
  return { summary: summary(plan), bat: plan.action === 'script' ? renderBat(plan).replace(/\r\n/g, '\n') : null };
}

function summary(plan) {
  return { kind: plan.kind, action: plan.action, source: plan.source, label: plan.label, detail: plan.detail, canPlay: plan.canPlay, port: plan.port || null, interactive: !!plan.interactive, stopFile: plan.stopFile || null, notes: plan.notes };
}

/* ------------------------------------------------------------------ rendering */
const winCmd = c => c.replace(/^\S+/, t => t.replace(/\//g, '\\'));
const posixCmd = c => c.replace(/^\S+/, t => t.replace(/\\/g, '/'));
const winDir = d => d.replace(/\//g, '\\');

function renderBat(plan) {
  const r = plan.recipe;
  const L = [];
  L.push('@echo off');
  L.push(`rem ${MARKER} v1 - generated by Streamline for the Play button. Safe to delete; it is recreated when needed.`);
  L.push('setlocal');
  L.push(`title ${safeTitle(plan.name)}`);
  L.push('cd /d "%~dp0"');
  for (const p of r.prereqs) {
    if (p.exe === 'python') continue; // handled by python-env
    L.push(`where ${p.exe} >nul 2>nul || (echo ${p.name} is required but was not found. Install it with: ${p.hint} & goto :fail)`);
  }
  for (const s of r.setup) {
    if (s.type === 'install-if-missing') {
      L.push(`if not exist "${s.dir}" (`, `  echo ${s.say}`, `  ${s.cmds.map(c => 'call ' + c).join(' || ')} || goto :fail`, ')');
    } else if (s.type === 'custom-step') {
      const inner = [`echo ${s.say}`];
      if (s.cwd) inner.push(`pushd "%~dp0${winDir(s.cwd)}" || goto :fail`);
      inner.push(`call ${winCmd(s.cmd)} || (${s.cwd ? 'popd & ' : ''}goto :fail)`);
      if (s.cwd) inner.push('popd');
      if (s.skipIfExists) L.push(`if not exist "${winDir(s.skipIfExists)}" (`, ...inner.map(x => '  ' + x), ')');
      else L.push(...inner);
    } else if (s.type === 'python-env') {
      L.push('set "PY="');
      L.push('where py >nul 2>nul && set "PY=py -3"');
      L.push('if not defined PY where python >nul 2>nul && set "PY=python"');
      L.push(`if not defined PY (echo Python is required but was not found. Install it with: ${HINTS.python.hint} & goto :fail)`);
      if (s.depsFile) {
        L.push('if not exist ".venv\\Scripts\\python.exe" (', '  echo Creating a private Python environment, first run only...', '  %PY% -m venv .venv || goto :fail', ')');
        const flag = s.depsFile === 'requirements.txt' ? '-r requirements.txt' : '-e .';
        L.push(`fc /b "${s.depsFile}" ".venv\\.streamline-deps" >nul 2>nul || (`, '  echo Installing dependencies...', `  ".venv\\Scripts\\python.exe" -m pip install ${flag} || goto :fail`, `  copy /y "${s.depsFile}" ".venv\\.streamline-deps" >nul`, ')');
        L.push('set PY=".venv\\Scripts\\python.exe"');
      }
    }
  }
  if (plan.port && !plan.autoOpens && !plan.desktop) {
    L.push(`if not defined STREAMLINE start "" /min powershell -NoProfile -Command "Start-Sleep 5; Start-Process http://localhost:${plan.port}"`);
  }
  L.push(`echo ${RUN_MARK}${safeTitle(plan.name)}`, 'if defined STREAMLINE_DRY goto :dry');
  for (const [k, v] of Object.entries(r.run.env || {})) L.push(`set "${k}=${v}"`);
  if (r.run.cwd) L.push(`pushd "%~dp0${winDir(r.run.cwd)}" || goto :fail`);
  if (r.run.python) L.push(`%PY% ${r.run.python.map(a => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`);
  else L.push(`call ${r.run.cwd !== undefined ? winCmd(r.run.cmd) : r.run.cmd}`);
  L.push('if errorlevel 1 goto :fail', 'goto :end', ':fail', 'echo.', 'echo Something went wrong. Read the messages above.', 'if not defined STREAMLINE pause', 'exit /b 1', ':dry', 'echo Streamline: setup finished, nothing was started because this was only a check.', ':end', 'if not defined STREAMLINE pause');
  return L.join('\r\n') + '\r\n';
}

// Same recipe as a POSIX script. Used when developing or testing on a non-Windows machine.
function renderSh(plan) {
  const r = plan.recipe;
  const L = ['set -e'];
  for (const p of r.prereqs) {
    const exe = p.exe === 'python' ? 'python3' : p.exe;
    L.push(`command -v ${exe} >/dev/null 2>&1 || { echo "${p.name} is required but was not found. Install it with: ${p.hint}"; exit 9009; }`);
  }
  for (const s of r.setup) {
    if (s.type === 'install-if-missing') L.push(`[ -d "${s.dir}" ] || { echo "${s.say}"; ${s.cmds.join(' || ')}; }`);
    if (s.type === 'custom-step') {
      const body = `echo "${s.say}"; ${s.cwd ? `(cd "${s.cwd}" && ${posixCmd(s.cmd)})` : posixCmd(s.cmd)}`;
      L.push(s.skipIfExists ? `[ -e "${s.skipIfExists}" ] || { ${body}; }` : `{ ${body}; }`);
    }
    if (s.type === 'python-env' && s.depsFile) L.push('[ -d .venv ] || python3 -m venv .venv', `. .venv/bin/activate`, `cmp -s ${s.depsFile} .venv/.streamline-deps || { pip install ${s.depsFile === 'requirements.txt' ? '-r requirements.txt' : '-e .'} && cp ${s.depsFile} .venv/.streamline-deps; }`);
  }
  L.push(`echo "${RUN_MARK}${safeTitle(plan.name)}"`, '[ -n "$STREAMLINE_DRY" ] && { echo "Streamline: setup finished, nothing was started because this was only a check."; exit 0; }');
  for (const [k, v] of Object.entries(r.run.env || {})) L.push(`export ${k}='${v}'`);
  if (r.run.cwd) L.push(`cd "${r.run.cwd}"`);
  if (r.run.python) L.push(`exec python3 ${r.run.python.map(a => `'${a}'`).join(' ')}`);
  else L.push(`exec ${posixCmd(r.run.cmd)}`);
  return L.join('\n') + '\n';
}

/* ------------------------------------------------------------------ keep launchers out of Git */
async function ensureExcluded(dir, patterns) {
  const gitDir = path.join(dir, '.git');
  try { if (!fs.statSync(gitDir).isDirectory()) return; } catch { return; }
  const want = [];
  for (const pat of patterns) {
    const probe = pat.endsWith('/') ? pat + '.streamline-probe' : pat;
    const r = await git(dir, ['check-ignore', '-q', '--', probe]);
    if (r.code !== 0) want.push(pat);
  }
  if (!want.length) return;
  const file = path.join(gitDir, 'info', 'exclude');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const cur = read(file) || '';
  const add = want.filter(p => !cur.split(/\r?\n/).includes(p));
  if (!add.length) return;
  const header = cur.includes('# Added by Streamline') ? '' : '# Added by Streamline (keeps generated launchers and dependencies out of "git status")\n';
  fs.writeFileSync(file, cur + (cur && !cur.endsWith('\n') ? '\n' : '') + header + add.join('\n') + '\n');
}

async function ensureLauncher(plan) {
  const file = path.join(plan.dir, BAT_NAME);
  const body = renderBat(plan);
  if (fs.existsSync(file) && !isOurs(file)) return file; // never overwrite someone else's file
  if (read(file) !== body) fs.writeFileSync(file, body);
  await ensureExcluded(plan.dir, [BAT_NAME, ...plan.exclude]);
  return file;
}

/* ------------------------------------------------------------------ running */
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;
const URL_RE = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{2,5})[^\s"')<>]*/i;
const LISTEN_RE = /\b(?:listening|running|started|serving|available)\b[^\n]*?(?:port|:)\s*(\d{4,5})\b/i;

function findWebAddress(line, allowPortGuess) {
  const clean = line.replace(ANSI, '');
  const u = clean.match(URL_RE);
  if (u) return u[0].replace(/0\.0\.0\.0|\[::1\]|127\.0\.0\.1/, 'localhost');
  if (allowPortGuess) { const l = clean.match(LISTEN_RE); if (l) return `http://localhost:${l[1]}/`; }
  return null;
}

function portOpen(port) {
  return new Promise(resolve => {
    const s = net.connect({ port, host: '127.0.0.1' });
    s.setTimeout(800);
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('timeout', () => { s.destroy(); resolve(false); });
    s.on('error', () => resolve(false));
  });
}

function localPort(url) {
  try { const u = new URL(url); if (!/^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)$/i.test(u.hostname)) return 0; return Number(u.port) || (u.protocol === 'https:' ? 443 : 80); } catch { return 0; }
}

// While a started web project is running, check its address every few seconds. When it stops answering
// (you closed it, it crashed), the job ends by itself so Play comes back.
function watchPort(job, getPort, onGone) {
  let misses = 0;
  const t = setInterval(async () => {
    const meta = jobs.get(job.id);
    if (!meta || (meta.status !== 'running' && !meta.live)) return clearInterval(t);
    const port = getPort();
    if (!port || !meta.live) return;
    if (await portOpen(port)) { misses = 0; return; }
    if (++misses >= 3) {
      clearInterval(t);
      onGone();
      setTimeout(() => { const m = jobs.get(job.id); if (m && (m.status === 'running' || m.live)) job.finish('success', 'Stopped (it is no longer running).'); }, 1500);
    }
  }, Number(process.env.STREAMLINE_WATCH_MS) || 3000);
  if (t.unref) t.unref();
}

function runningJob(projectId) {
  return jobs.list().find(j => j.type === 'play' && (j.status === 'running' || j.live) && j.projectId === projectId) || null;
}

const PLAY_ENV = { STREAMLINE: '1', BROWSER: 'none', FORCE_COLOR: '0', NO_COLOR: '1', PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', CI: '' };

function describeExit(code) {
  if (code === 9009 || code === 127) return 'A required program was not found. See the output for what to install.';
  return `Exited with code ${code}. See the output above.`;
}

function startScript(project, plan, job) {
  let opened = false;
  let cancelled = false;
  let timer = null;
  let webPort = 0, openedUrl = '';
  const open = url => {
    if (opened) return;
    opened = true;
    webPort = localPort(url); openedUrl = url;
    if (timer) clearInterval(timer);
    openUrl(url);
    job.set({ link: url, linkLabel: 'Open ' + url.replace(/^https?:\/\//, '').replace(/\/$/, '') });
    job.log(`Opened ${url} in your browser.`);
    job.background(`Running in the background at ${url}`);
  };
  const webish = !plan.desktop;

  (async () => {
    let exe, args, opts = {};
    if (IS_WIN) {
      let target;
      if (plan.action === 'existing') target = path.join(plan.dir, plan.file);
      else target = await ensureLauncher(plan);
      job.log(`Running ${path.basename(target)}`);
      if (/\.vbs$/i.test(target)) { exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe'); args = [target]; }
      else { exe = 'cmd.exe'; args = cmdArgs(target); opts = { verbatim: true }; }
    } else {
      if (plan.action === 'existing') return job.finish('error', 'Existing .bat launchers can only be run on Windows.');
      exe = 'sh'; args = ['-c', renderSh(plan)];
      await ensureExcluded(plan.dir, plan.exclude);
    }
    job.log(plan.action === 'existing' ? `Using your launcher: ${plan.file}` : `Starting: ${plan.detail}`);
    if (plan.interactive && plan.action !== 'existing') {
      // Needs keyboard input, so it gets its own console window that stays open.
      if (process.env.STREAMLINE_OPEN_LOG) { fs.appendFileSync(process.env.STREAMLINE_OPEN_LOG, `console:${plan.dir}\n`); return job.finish('success', 'Opened in its own window.'); }
      if (IS_WIN) {
        // A detached child gets its own console window, and Streamline still sees when it is closed.
        let child;
        try {
          child = spawn('cmd.exe', ['/d', '/s', '/k', args[3]], { cwd: plan.dir, env: childEnv(PLAY_ENV), windowsVerbatimArguments: true, detached: true, stdio: 'ignore', windowsHide: false });
        } catch (e) { return job.finish('error', 'Could not open a console window: ' + e.message); }
        let stopped = false;
        child.on('error', e => job.finish('error', 'Could not open a console window: ' + e.message));
        child.on('exit', () => { if (job.status === 'running' || job.live) job.finish(stopped ? 'cancelled' : 'success', stopped ? 'Stopped.' : 'Window closed.'); });
        job.onCancel(() => { stopped = true; killTree(child); });
        return job.background('Opened in its own window (it waits for you to type). Close the window or press Stop when you are done.');
      }
      return job.finish('success', 'Interactive tool (would open in a console window on Windows).');
    }
    if (plan.port && webish) {
      let tries = 0;
      timer = setInterval(async () => {
        if (opened || ++tries > 60) return clearInterval(timer);
        if (await portOpen(plan.port)) open(plan.openUrl || `http://localhost:${plan.port}/`);
      }, 1000);
    }
    // Desktop apps, tools and servers whose address we never saw: once setup is done and it is still running, call it a success.
    let markAt = plan.action === 'existing' ? Date.now() : 0;
    const promo = setInterval(() => { if (!job.live && job.status === 'running' && markAt && Date.now() - markAt >= 6000) job.background('Started and running in the background'); }, 1000);
    const r = await run(exe, args, {
      cwd: plan.dir, env: PLAY_ENV, ...opts,
      onSpawn: child => {
        job.onCancel(() => { cancelled = true; killTree(child); if (webPort) setTimeout(() => killPort(webPort), 1500); });
        watchPort(job, () => webPort, () => { if (!cancelled) { cancelled = 'gone'; killTree(child); } });
      },
      onLine: line => {
        job.log(line.replace(ANSI, ''));
        if (!markAt && line.includes(RUN_MARK)) markAt = Date.now();
        if (!opened && webish) { const u = findWebAddress(line, plan.kind !== 'launcher'); if (u) open(u); }
      }
    });
    if (timer) clearInterval(timer);
    clearInterval(promo);
    if (cancelled === 'gone') return job.finish('success', 'Stopped (it is no longer running).');
    if (cancelled) return job.finish('cancelled', 'Stopped.');
    if (r.code === 0 && webPort && await portOpen(webPort)) {
      // The launcher handed off to a server that keeps running: keep it stoppable and watch it.
      job.onCancel(() => { killPort(webPort); job.finish('cancelled', 'Stopped.'); });
      watchPort(job, () => webPort, () => {});
      return job.background(`Running in the background at ${openedUrl}`);
    }
    if (r.code === 0) return job.finish('success', plan.action === 'existing' ? 'Your launcher finished. The project should now be running.' : 'Finished.', { exitCode: 0 });
    job.finish('error', describeExit(r.code), { exitCode: r.code });
  })().catch(e => job.finish('error', e.message));
}


/* ------------------------------------------------------------------ health check (background test of Play) */
const CHECK_MAX_MS = 150000;
const tail = (lines, n = 14) => lines.filter(l => l.trim()).slice(-n);

/**
 * Tries a project's Play recipe without the user watching and reports what happened. Nothing is opened in a browser.
 * Desktop apps only run their setup steps (a dry run) so no windows pop up; servers are started, watched, then stopped.
 */
async function check(project, { cancelled = () => false, log = () => {} } = {}) {
  const plan = detect(project);
  const out = { id: project.id, name: project.name, label: plan.label, detail: plan.detail, kind: plan.kind, source: plan.source, checkedAt: new Date().toISOString(), output: [] };
  const ok = (note, extra) => ({ ...out, status: 'ok', note, ...extra });
  const fail = (problem, output = [], extra) => ({ ...out, status: 'fail', problem, output: tail(output), ...extra });
  const skip = note => ({ ...out, status: 'skip', note });

  if (!plan.canPlay) return fail(`${plan.label}${plan.detail ? ' (' + plan.detail + ')' : ''}`, [], { needsSetup: true });
  if (runningJob(project.id)) return skip('Running right now, so it was not tested.');
  const dir = plan.dir;

  if (plan.action === 'open-file' || plan.action === 'serve') {
    const f = path.join(dir, plan.html.rel);
    return fs.existsSync(f) ? ok(plan.action === 'serve' ? 'Web page found. It is served locally when you press Play.' : 'Web page found. It opens in your browser.') : fail(`The page ${plan.html.rel} is missing.`);
  }
  if (plan.action === 'extension') return readJson(path.join(dir, 'manifest.json')) ? ok('Extension manifest is valid. Load it from chrome://extensions.') : fail('manifest.json is missing or is not valid JSON.');
  if (plan.action === 'exe') return fs.existsSync(plan.exe) ? ok('Built program found. It was not launched during the check.') : fail(`The program ${plan.detail} is missing.`);
  if (plan.action === 'existing') return skip('This uses your own launcher, so it was not test-run. Press Play to try it.');

  let exe, args, opts = {};
  if (IS_WIN) {
    const target = await ensureLauncher(plan);
    exe = 'cmd.exe'; args = cmdArgs(target); opts = { verbatim: true };
  } else {
    exe = 'sh'; args = ['-c', renderSh(plan)];
    await ensureExcluded(dir, plan.exclude);
  }
  const dry = !!plan.desktop || !!plan.interactive;
  const lines = [];
  const began = Date.now();
  let lastOutput = began, address = null, child = null, stopped = false;
  const killChild = () => { if (child && !stopped) { stopped = true; killTree(child); } };

  let timerRef = null;
  const watcher = new Promise(resolve => {
    const t = setInterval(async () => {
      const now = Date.now();
      if (cancelled()) { clearInterval(t); killChild(); return resolve('cancelled'); }
      if (!dry) {
        if (address) { clearInterval(t); return resolve('serving'); }
        if (plan.port && await portOpen(plan.port)) { address = `http://localhost:${plan.port}/`; clearInterval(t); return resolve('serving'); }
        if (now - began > 15000 && now - lastOutput > 10000) { clearInterval(t); return resolve('quiet'); }
      }
      if (now - began > CHECK_MAX_MS) { clearInterval(t); resolve('timeout'); }
    }, 500);
    timerRef = t;
  });
  const finished = run(exe, args, {
    cwd: dir, env: { ...PLAY_ENV, ...(dry ? { STREAMLINE_DRY: '1' } : {}) }, ...opts,
    onSpawn: c => { child = c; },
    onLine: line => { const l = line.replace(ANSI, ''); lines.push(l); lastOutput = Date.now(); log(l); if (!dry && !address) address = findWebAddress(l, plan.kind !== 'launcher'); }
  }).then(r => ({ exited: true, code: r.code }));

  const first = await Promise.race([finished, watcher.then(why => ({ exited: false, why }))]);
  clearInterval(timerRef);
  if (first.exited) {
    if (first.code === 0) return ok(plan.interactive ? 'Setup finished. This is a command-line tool that waits for you to type, so it was not run. Play opens it in its own window.' : dry ? 'Setup finished. Desktop apps are not launched during the check.' : 'Ran and finished successfully.', { output: tail(lines, 4) });
    return fail(describeExit(first.code), lines, { exitCode: first.code, missingProgram: first.code === 9009 || first.code === 127 });
  }
  killChild();
  await Promise.race([finished, new Promise(r => setTimeout(r, 4000))]);
  if (first.why === 'cancelled') return skip('Cancelled.');
  if (first.why === 'serving') return ok(`Started and is serving ${address}.`);
  if (first.why === 'quiet') return ok('Started and kept running.', { output: tail(lines, 4) });
  return { ...out, status: 'warn', problem: `Still setting up after ${Math.round(CHECK_MAX_MS / 1000)} seconds, so the check stopped it.`, output: tail(lines) };
}

function startExe(project, plan, job) {
  let cancelled = false;
  const began = Date.now();
  job.log(`Starting ${path.basename(plan.exe)}`);
  const exeTimer = setTimeout(() => { if (job.status === 'running') job.background('Started and running in the background'); }, 4000);
  run(plan.exe, [], { cwd: path.dirname(plan.exe), hide: false, onSpawn: child => job.onCancel(() => { cancelled = true; killTree(child); }), onLine: l => job.log(l) })  .then(r => {
    clearTimeout(exeTimer);
    if (cancelled) return job.finish('cancelled', 'Stopped.');
    if (r.code !== 0 && Date.now() - began < 4000) return job.finish('error', r.err && /Could not find/.test(r.err) ? r.err : `The program exited right away (code ${r.code}).`, { exitCode: r.code });
    job.finish('success', 'Closed.', { exitCode: r.code });
  });
}

const servers = new Map(); // job id -> http.Server

function startServe(project, plan, job) {
  const root = plan.html.root;
  const MIME = { '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.wasm': 'application/wasm', '.txt': 'text/plain; charset=utf-8', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.mp4': 'video/mp4', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.map': 'application/json' };
  const srv = http.createServer((req, res) => {
    let rel;
    try { rel = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400); return res.end(); }
    let file = path.normalize(path.join(root, rel));
    if (file !== root && !file.startsWith(root + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
    try { if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html'); } catch { /* 404 below */ }
    if (rel === '/' && !fs.existsSync(file)) file = path.join(plan.dir, plan.html.rel);
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(data);
    });
  });
  srv.on('error', e => job.finish('error', 'Could not start the local server: ' + e.message));
  srv.listen(0, '127.0.0.1', () => {
    const leaf = path.basename(plan.html.rel);
    const url = `http://localhost:${srv.address().port}/${leaf.toLowerCase() === 'index.html' ? '' : encodeURI(leaf)}`;
    servers.set(job.id, srv);
    job.log(`Serving ${root}`);
    job.log(`Reason: ${plan.notes.join(' ')}`);
    job.onCancel(() => { srv.close(); srv.closeAllConnections && srv.closeAllConnections(); servers.delete(job.id); job.finish('cancelled', 'Stopped.'); });
    openUrl(url);
    job.set({ link: url, linkLabel: 'Open ' + url.replace(/^https?:\/\//, '').replace(/\/$/, '') });
    job.log(`Opened ${url} in your browser. Press Stop when you are done.`);
    job.background(`Running in the background at ${url}`);
  });
}

function start(project) {
  const plan = detect(project);
  if (!plan.canPlay) throw new Error(plan.label + (plan.detail ? ` (${plan.detail})` : '') + '.');
  const existing = runningJob(project.id);
  if (existing) return existing.id;
  const job = jobs.create('play', `Run ${project.name}`);
  job.set({ projectId: project.id, kind: plan.kind });
  job.log(`${plan.label}: ${plan.detail}`);

  if (plan.action === 'open-file') {
    const file = path.join(plan.dir, plan.html.rel);
    openUrl(file);
    job.finish('success', `Opened ${plan.html.rel} in your browser.`);
  } else if (plan.action === 'serve') {
    startServe(project, plan, job);
  } else if (plan.action === 'exe') {
    startExe(project, plan, job);
  } else if (plan.action === 'extension') {
    openFolderWindow(plan.dir);
    openChromeExtensions();
    job.log(plan.notes[0]);
    job.finish('success', 'Opened the project folder and Chrome\'s extensions page. Click "Load unpacked" and pick the folder.');
  } else {
    startScript(project, plan, job);
  }
  return job.id;
}

function stop(project) {
  const j = runningJob(project.id);
  if (j) return jobs.cancel(j.id);
  const plan = detect(project);
  if (!plan.stopFile) return false;
  // The project's own Stop script (for launchers that start things in the background).
  const job = jobs.create('stop', `Stop ${project.name}`);
  const file = path.join(plan.dir, plan.stopFile);
  job.log(`Running ${plan.stopFile}`);
  const vbs = /\.vbs$/i.test(file);
  const exe = IS_WIN ? (vbs ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe') : 'cmd.exe') : 'sh';
  const args = IS_WIN ? (vbs ? [file] : cmdArgs(file)) : [file];
  run(exe, args, { cwd: plan.dir, env: PLAY_ENV, verbatim: IS_WIN && !vbs, onLine: l => job.log(l) })
    .then(r => (r.code === 0 ? job.finish('success', 'Stopped.') : job.finish('error', `Stop script exited with code ${r.code}.`)));
  return true;
}

module.exports = { check, RUN_MARK, cmdArgs, detect, summary, previewCustom, analyzeHtml, start, stop, runningJob, renderBat, renderSh, findWebAddress, BAT_NAME, MARKER };
