'use strict';
/**
 * Clears what stopped Update Local GitHub from updating a project, one file at a time, without losing anything:
 *   - "moveout": the file is moved to <projects folder>\_Set aside\<project>\<same path>
 *   - "delete":  the file goes to the Recycle Bin (Windows)
 * Either way, a file that Git tracks is then put back to the last committed version, so the project is clean
 * and can be fast-forwarded. "switch" goes back to the expected branch when nothing is changed.
 */
const fs = require('fs');
const path = require('path');
const { run } = require('./proc');
const { IS_WIN, isInside } = require('./util');
const sync = require('./sync');

const SET_ASIDE = '_Set aside';
const NAME_RE = /^[A-Za-z0-9_.-]+$/;
const BRANCH_RE = /^[A-Za-z0-9_./-]+$/;

function cleanRel(rel) {
  const s = String(rel || '').replace(/\\/g, '/').replace(/\/+$/, '');
  const parts = s.split('/');
  if (!s || path.isAbsolute(s) || /^[A-Za-z]:/.test(s) || parts.some(p => !p || p === '.' || p === '..') || parts[0].toLowerCase() === '.git') {
    throw new Error(`Not a file inside the project: ${rel}`);
  }
  return parts.join('/');
}

function freeName(dest) {
  if (!fs.existsSync(dest)) return dest;
  const ext = path.extname(dest);
  const base = dest.slice(0, dest.length - ext.length);
  for (let i = 2; ; i++) { const c = `${base} (${i})${ext}`; if (!fs.existsSync(c)) return c; }
}

function moveTo(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try { fs.renameSync(src, dest); }
  catch (e) {
    if (e.code !== 'EXDEV') throw e;
    fs.cpSync(src, dest, { recursive: true });
    fs.rmSync(src, { recursive: true, force: true });
  }
}

async function recycle(paths) {
  if (!paths.length) return;
  if (!IS_WIN) { for (const p of paths) fs.rmSync(p, { recursive: true, force: true }); return; }
  const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  // Paths travel in an environment variable, so no quoting problems with spaces or odd characters.
  const script = "$ErrorActionPreference='Stop'; Add-Type -AssemblyName Microsoft.VisualBasic; foreach ($f in (ConvertFrom-Json $env:SL_RECYCLE)) { if (Test-Path -LiteralPath $f -PathType Container) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($f,'OnlyErrorDialogs','SendToRecycleBin') } elseif (Test-Path -LiteralPath $f) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($f,'OnlyErrorDialogs','SendToRecycleBin') } }";
  const r = await run(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { env: { SL_RECYCLE: JSON.stringify(paths) }, timeoutMs: 60000 });
  if (r.code !== 0) throw new Error('Could not move to the Recycle Bin: ' + (r.err || r.out));
}

async function fix({ name, action, paths, branch }) {
  if (!NAME_RE.test(String(name || '')) || name === '.' || name === '..') throw new Error('Unknown project.');
  if (!['moveout', 'delete', 'switch'].includes(action)) throw new Error('Unknown action.');
  const cfg = sync.loadConfig();
  const folder = path.join(cfg.root, name);
  if (!fs.existsSync(path.join(folder, '.git'))) throw new Error(`${name} is not a Git project in your projects folder.`);
  const g = sync.makeRunner(new Set());

  if (action === 'switch') {
    if (!BRANCH_RE.test(String(branch || ''))) throw new Error('Unknown branch.');
    if ((await sync.changedFiles(g, folder)).length) throw new Error('This project has changed files; deal with those first.');
    await g.must(folder, ['switch', '--quiet', branch]);
    return { done: [`Switched to ${branch}`], result: await sync.retryOne(name) };
  }

  if (!Array.isArray(paths) || !paths.length) throw new Error('Choose at least one file.');
  const done = [];
  const recycleList = [];
  const restore = [];
  for (const raw of paths.slice(0, 500)) {
    const rel = cleanRel(raw);
    const full = path.join(folder, ...rel.split('/'));
    if (!isInside(folder, full) || full === folder) throw new Error(`Not a file inside the project: ${raw}`);
    // Only files Git itself reports (changed, new, ignored, or in the way) can be touched.
    const st = await g.sgit(folder, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching', '--', rel]);
    const entry = sync.parseStatus(st.out).find(f => f.path.replace(/\/$/, '') === rel || f.from === rel) || sync.parseStatus(st.out)[0];
    if (!entry) { done.push(`${rel}: already matches Git, nothing to do`); continue; }
    if (entry.staged) await g.must(folder, ['reset', '--quiet', '--', ...(entry.from ? [entry.from] : []), entry.path]);
    if (fs.existsSync(full) || (() => { try { fs.lstatSync(full); return true; } catch { return false; } })()) {
      if (action === 'moveout') {
        const dest = freeName(path.join(cfg.root, SET_ASIDE, name, ...rel.split('/')));
        moveTo(full, dest);
        done.push(`${rel} → ${path.relative(cfg.root, dest)}`);
      } else {
        recycleList.push(full);
        done.push(`${rel} → Recycle Bin`);
      }
    } else done.push(`${rel}: restored`);
    for (const p of [entry.path, entry.from].filter(Boolean)) {
      const tracked = await g.sgit(folder, ['cat-file', '-e', `HEAD:${p}`]);
      if (tracked.code === 0) restore.push(p);
    }
  }
  await recycle(recycleList);
  if (restore.length) await g.must(folder, ['checkout', '--quiet', 'HEAD', '--', ...restore]);
  return { done, result: await sync.retryOne(name) };
}

module.exports = { fix, SET_ASIDE, cleanRel };
