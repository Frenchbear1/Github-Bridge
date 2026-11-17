'use strict';
/** Finds code editors installed on this computer and opens a project in one. The browser only ever sends an editor id. */
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { IS_WIN } = require('./util');

const env = k => process.env[k] || '';
const roots = () => [env('LOCALAPPDATA') && path.join(env('LOCALAPPDATA'), 'Programs'), env('ProgramFiles'), env('ProgramFiles(x86)'), env('LOCALAPPDATA')].filter(Boolean);

// id, label, executable locations (relative to the roots above), command name on PATH, how it opens a project
const KNOWN = [
  { id: 'vscode', label: 'Visual Studio Code', rel: ['Microsoft VS Code/Code.exe'], cmd: 'code' },
  { id: 'vscode-insiders', label: 'VS Code Insiders', rel: ['Microsoft VS Code Insiders/Code - Insiders.exe'], cmd: 'code-insiders' },
  { id: 'cursor', label: 'Cursor', rel: ['cursor/Cursor.exe', 'Cursor/Cursor.exe'], cmd: 'cursor' },
  { id: 'windsurf', label: 'Windsurf', rel: ['Windsurf/Windsurf.exe'], cmd: 'windsurf' },
  { id: 'vscodium', label: 'VSCodium', rel: ['VSCodium/VSCodium.exe'], cmd: 'codium' },
  { id: 'zed', label: 'Zed', rel: ['Zed/Zed.exe', 'Zed Editor/zed.exe'], cmd: 'zed' },
  { id: 'notepadpp', label: 'Notepad++', rel: ['Notepad++/notepad++.exe'], file: true },
  { id: 'sublime', label: 'Sublime Text', rel: ['Sublime Text/sublime_text.exe', 'Sublime Text 3/sublime_text.exe'], cmd: 'subl' },
  { id: 'atom', label: 'Atom', rel: ['atom/atom.exe'] },
  { id: 'vs', label: 'Visual Studio', vswhere: true },
  { id: 'rider', label: 'JetBrains Rider', jetbrains: 'rider64.exe' },
  { id: 'idea', label: 'IntelliJ IDEA', jetbrains: 'idea64.exe' },
  { id: 'pycharm', label: 'PyCharm', jetbrains: 'pycharm64.exe' },
  { id: 'webstorm', label: 'WebStorm', jetbrains: 'webstorm64.exe' },
  { id: 'clion', label: 'CLion', jetbrains: 'clion64.exe' },
  { id: 'androidstudio', label: 'Android Studio', rel: ['Android/Android Studio/bin/studio64.exe'] },
  { id: 'notepad', label: 'Notepad', exe: () => path.join(env('SystemRoot') || 'C:\\Windows', 'notepad.exe'), file: true },
  { id: 'terminal', label: 'Windows Terminal', rel: [], cmd: 'wt', terminal: true }
];

function onPath(cmd) {
  const r = spawnSync(IS_WIN ? 'where' : 'which', [cmd], { encoding: 'utf8', windowsHide: true });
  const first = r.status === 0 ? String(r.stdout).split(/\r?\n/).find(l => /\.exe$/i.test(l.trim())) : null;
  return first ? first.trim() : null;
}

function findJetBrains(exeName) {
  for (const base of [env('ProgramFiles'), env('LOCALAPPDATA') && path.join(env('LOCALAPPDATA'), 'Programs')].filter(Boolean)) {
    const jb = path.join(base, 'JetBrains');
    let dirs = []; try { dirs = fs.readdirSync(jb); } catch { continue; }
    for (const d of dirs.sort().reverse()) { const f = path.join(jb, d, 'bin', exeName); if (fs.existsSync(f)) return f; }
  }
  return null;
}

function findVs() {
  const vw = path.join(env('ProgramFiles(x86)'), 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  if (!fs.existsSync(vw)) return null;
  const r = spawnSync(vw, ['-latest', '-property', 'productPath'], { encoding: 'utf8', windowsHide: true });
  const p = String(r.stdout || '').trim().split(/\r?\n/)[0];
  return p && fs.existsSync(p) ? p : null;
}

let cache = null;
function list(fresh) {
  if (process.env.STREAMLINE_EDITORS_JSON) return JSON.parse(process.env.STREAMLINE_EDITORS_JSON); // test hook
  if (cache && !fresh) return cache;
  const out = [];
  if (IS_WIN) {
    for (const k of KNOWN) {
      let exe = null;
      if (k.exe) exe = k.exe();
      else if (k.jetbrains) exe = findJetBrains(k.jetbrains);
      else if (k.vswhere) exe = findVs();
      else exe = (k.rel || []).flatMap(r => roots().map(b => path.join(b, ...r.split('/')))).find(f => fs.existsSync(f)) || null;
      if (!exe && k.cmd) exe = onPath(k.cmd);
      if (exe && fs.existsSync(exe)) out.push({ id: k.id, label: k.label, exe, file: !!k.file, terminal: !!k.terminal });
    }
  }
  cache = out;
  return out;
}

const NOTE_FILES = ['README.md', 'README.txt', 'README', 'package.json', 'index.html', 'main.py', 'app.py'];

/** Opens a project folder in the editor with this id. Returns what was opened. */
function openIn(editorId, dir) {
  const ed = list().find(e => e.id === editorId);
  if (!ed) throw new Error('That program was not found on this computer.');
  let args = [dir], cwd = dir, label = 'folder';
  if (ed.file) { // opens files, not folders
    const f = NOTE_FILES.find(n => fs.existsSync(path.join(dir, n)));
    args = f ? [path.join(dir, f)] : []; label = f || 'editor';
  }
  if (ed.terminal) args = ['-d', dir];
  if (process.env.STREAMLINE_OPEN_LOG) { fs.appendFileSync(process.env.STREAMLINE_OPEN_LOG, `editor:${ed.id}:${args.join(' ')}\n`); return { label }; }
  const child = spawn(ed.exe, args, { cwd, detached: true, stdio: 'ignore', windowsHide: false });
  child.on('error', () => {});
  child.unref();
  return { label };
}

module.exports = { list, openIn };
