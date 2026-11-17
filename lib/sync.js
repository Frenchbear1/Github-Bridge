'use strict';
/**
 * Update Local GitHub, built into Streamline.
 *
 * Same rules the old Sync-GitHubProjects.ps1 followed, now with live progress:
 *   - finds your repositories through the GitHub CLI sign-in Streamline already uses
 *   - asks GitHub (one bulk request) for every branch head, and skips projects that already match
 *   - downloads repositories you do not have yet (shallow clone, published only when complete)
 *   - fast-forwards the rest, but ONLY when the project is clean: it never commits, stashes, resets,
 *     cleans, force-updates or deletes anything, and pauses on local edits, other branches or local commits
 */
const fs = require('fs');
const path = require('path');
const jobs = require('./jobs');
const store = require('./store');
const auth = require('./auth');
const repo = require('./repo');
const { git, gh, killTree } = require('./proc');
const { normKey } = require('./util');

const NAME_RE = /^[A-Za-z0-9_.-]+$/;
const BRANCH_RE = /^[A-Za-z0-9_./-]+$/;
const OWNER_RE = /^[A-Za-z0-9-]+$/;
const OID_RE = /^[0-9a-f]{40}$/;
const MARKERS = ['MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'index.lock'];

const sameUrl = (a, b) => String(a || '').trim().replace(/\/+$/, '').replace(/\.git$/i, '').toLowerCase() === String(b || '').trim().replace(/\/+$/, '').replace(/\.git$/i, '').toLowerCase();
const samePath = (a, b) => normKey(a) === normKey(b);
const oneLine = s => String(s || '').replace(/\s+/g, ' ').trim();

/* ---------- settings ---------- */
function clamp(n, lo, hi, dflt) { n = Number(n); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : dflt; }

// Settings win. If you used the old script before, its config.json is read once as the starting point.
function loadConfig() {
  const s = store.getSettings();
  let legacy = {};
  try {
    if (s.syncScript) legacy = JSON.parse(fs.readFileSync(path.join(path.dirname(s.syncScript), 'config.json'), 'utf8').replace(/^﻿/, ''));
  } catch { /* no old config */ }
  const excludedList = (Array.isArray(s.syncExcluded) ? s.syncExcluded : (Array.isArray(legacy.excludedRepositories) ? legacy.excludedRepositories : [])).map(String);
  return {
    owner: String(s.syncOwner || legacy.owner || '').trim(),
    root: s.projectsRoot || legacy.root || '',
    excludedList,
    excluded: new Set(excludedList.map(x => x.toLowerCase())),
    branchOverrides: legacy.branchOverrides && typeof legacy.branchOverrides === 'object' ? legacy.branchOverrides : {},
    parallel: clamp(s.syncParallel || legacy.maxParallel, 1, 16, 8)
  };
}

/* ---------- git helpers ---------- */
function emptyHooksDir() {
  const dir = path.join(store.DATA_DIR, 'empty-hooks');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* best effort */ }
  return dir;
}

function makeRunner(active) {
  const hooks = emptyHooksDir();
  const track = child => { active.add(child); child.once('close', () => active.delete(child)); };
  const sgit = (cwd, args, timeoutMs = 180000) => git(cwd, ['-c', `core.hooksPath=${hooks}`, '-c', 'core.fsmonitor=false', ...args], { timeoutMs, onSpawn: track });
  const must = async (cwd, args, timeoutMs) => {
    const r = await sgit(cwd, args, timeoutMs);
    if (r.code !== 0) throw new Error(oneLine(r.err || r.out) || `git ${args[0]} failed (exit ${r.code})`);
    return r.out;
  };
  return { sgit, must };
}

/* ---------- what exactly is in the way ---------- */
const MAX_FILES = 300;
// Parses `git status --porcelain=v1 -z` into { path, from, kind, staged }.
function parseStatus(out) {
  const parts = String(out || '').split('\0');
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (e.length < 4) continue;
    const x = e[0], y = e[1], p = e.slice(3);
    let from = null;
    if (x === 'R' || x === 'C') from = parts[++i] || null;
    let kind;
    if (x === '?' && y === '?') kind = 'new';
    else if (x === '!' && y === '!') kind = 'ignored';
    else if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) kind = 'conflict';
    else if (x === 'D' || y === 'D') kind = 'deleted';
    else if (x === 'A') kind = 'added';
    else if (x === 'R') kind = 'renamed';
    else kind = 'edited';
    files.push({ path: p, from, kind, staged: x !== ' ' && x !== '?' && x !== '!' });
  }
  return files;
}

async function changedFiles(g, folder) {
  const r = await g.sgit(folder, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none']);
  return r.code === 0 ? parseStatus(r.out) : [];
}

// Files git names when it refuses an update ("...would be overwritten by merge:" followed by tab-indented paths).
function blockingFiles(text) {
  const out = [];
  let on = false;
  for (const line of String(text || '').split(/\r?\n/)) {
    if (/would be (overwritten|removed)/i.test(line)) { on = true; continue; }
    if (on && /^\s+\S/.test(line) && !/^\s*(Please|Aborting|error)/i.test(line)) out.push({ path: line.trim(), kind: 'blocking', staged: false });
    else if (on && line.trim()) on = false;
  }
  return out;
}

async function pauseInfo(g, folder, branch, code, extra = {}) {
  const info = { code };
  if (code === 'dirty' || code === 'changed') {
    const all = await changedFiles(g, folder);
    info.files = all.slice(0, MAX_FILES);
    if (all.length > MAX_FILES) info.moreFiles = all.length - MAX_FILES;
  }
  if (code === 'branch') {
    const cur = await g.sgit(folder, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    info.onBranch = cur.code === 0 ? cur.out : '(detached)';
    info.expected = branch;
    const dirty = await changedFiles(g, folder);
    info.clean = dirty.length === 0;
  }
  if (code === 'commits' && extra.target) {
    const log = await g.sgit(folder, ['log', '--format=%h %s', '-n', '20', `${extra.target}..HEAD`]);
    info.commits = log.code === 0 && log.out ? log.out.split(/\r?\n/) : [];
  }
  if (code === 'declined') info.files = blockingFiles(extra.err);
  return info;
}

const SAFETY_CODES = [
  [/different branch/i, 'branch'], [/operation is in progress/i, 'operation'], [/assume-unchanged|skip-worktree/i, 'flags'],
  [/local edits/i, 'dirty'], [/not the root/i, 'root']
];
const safetyCode = reason => (SAFETY_CODES.find(([re]) => re.test(reason)) || [null, 'other'])[1];

// Returns a reason to leave the project alone, or null when it is safe to update.
async function localSafety(g, folder, branch) {
  const top = await g.must(folder, ['rev-parse', '--show-toplevel']);
  if (!samePath(top, folder)) return 'Folder is not the root of its own repository.';
  const cur = await g.sgit(folder, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (cur.code !== 0 || cur.out !== branch) return `On a different branch (or detached HEAD); expected ${branch}.`;
  const gitDir = await g.must(folder, ['rev-parse', '--absolute-git-dir']);
  for (const m of MARKERS) if (fs.existsSync(path.join(gitDir, m))) return 'A Git operation is in progress.';
  const flags = await g.must(folder, ['ls-files', '-v']);
  if (/^[a-zS] /m.test(flags)) return 'Some files are marked assume-unchanged or skip-worktree.';
  const dirty = await g.must(folder, ['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none']);
  if (dirty) return 'You have local edits or untracked files.';
  return null;
}

async function alreadyAtRemote(g, r, folder) {
  if (!OID_RE.test(r.remoteOid || '')) return false;
  const local = await g.sgit(folder, ['rev-parse', '--show-toplevel', 'HEAD', '--symbolic-full-name', 'HEAD']);
  if (local.code !== 0) return false;
  const parts = local.out.split(/\r?\n/);
  if (parts.length !== 3 || parts[1] !== r.remoteOid || parts[2] !== 'refs/heads/' + r.branch) return false;
  if (!samePath(parts[0], folder)) return false;
  const origin = await g.sgit(folder, ['remote', 'get-url', 'origin']);
  return origin.code === 0 && sameUrl(origin.out, r.url);
}

/* ---------- one repository ---------- */
async function syncOne(g, r, folder, stagingRoot) {
  const out = (state, detail, info) => ({ name: r.name, fullName: r.fullName, url: r.url, branch: r.branch, state, detail, ...(info ? { info } : {}) });
  const paused = async (detail, code, extra) => out('Paused', detail, await pauseInfo(g, folder, r.branch, code, extra).catch(() => ({ code })));
  try {
    if (!NAME_RE.test(r.name) || r.name === '.' || r.name === '..' || !BRANCH_RE.test(r.branch)) throw new Error('Unusual repository or branch name; skipped for safety.');
    if (!fs.existsSync(folder)) {
      fs.mkdirSync(stagingRoot, { recursive: true });
      const stage = path.join(stagingRoot, r.name + '-' + Math.random().toString(16).slice(2, 10));
      try {
        await g.must(stagingRoot, ['clone', '--quiet', '--depth', '1', '--single-branch', '--branch', r.branch, '--', r.url, stage], 900000);
        if (fs.existsSync(folder)) throw new Error('The folder appeared while downloading; left untouched.');
        fs.renameSync(stage, folder);
      } finally { fs.rmSync(stage, { recursive: true, force: true }); }
      return out('Cloned', `Downloaded ${r.branch}.`);
    }
    if (fs.lstatSync(folder).isSymbolicLink()) throw new Error('The folder is a link; left untouched.');
    if (await alreadyAtRemote(g, r, folder)) return out('Skipped', 'Already matches GitHub.');

    const reason = await localSafety(g, folder, r.branch);
    if (reason) return paused(reason, safetyCode(reason));
    const origin = await g.must(folder, ['remote', 'get-url', 'origin']);
    if (!sameUrl(origin, r.url)) throw new Error('This folder\'s origin is a different repository; left untouched.');

    await g.must(folder, ['fetch', '--quiet', '--no-tags', 'origin', `refs/heads/${r.branch}:refs/remotes/origin/${r.branch}`]);
    const target = await g.must(folder, ['rev-parse', `refs/remotes/origin/${r.branch}`]);
    const head = await g.must(folder, ['rev-parse', 'HEAD']);
    if (head === target) return out('Current', 'Already up to date.');
    const anc = await g.sgit(folder, ['merge-base', '--is-ancestor', head, target]);
    if (anc.code === 1) return paused('You have local commits that GitHub does not (or history diverged).', 'commits', { target });
    if (anc.code !== 0) throw new Error(oneLine(anc.err) || 'Could not compare with GitHub.');
    const again = await localSafety(g, folder, r.branch);
    const head2 = await g.must(folder, ['rev-parse', 'HEAD']);
    if (again || head2 !== head) return paused('The project changed while checking; left untouched.', 'changed');
    const merged = await g.sgit(folder, ['-c', 'merge.autoStash=false', 'merge', '--ff-only', '--no-autostash', '--no-overwrite-ignore', target]);
    if (merged.code === 0) return out('Updated', `Updated ${r.branch}.`);
    const bf = blockingFiles(merged.err || merged.out);
    return paused(bf.length ? 'These files are not in Git here, but GitHub now has files with the same names. Move them out to update.' : 'Git declined the update to protect your files: ' + oneLine(merged.err || merged.out), 'declined', { err: merged.err || merged.out });
  } catch (e) {
    return out('Error', oneLine(e.message));
  }
}

/* ---------- GitHub lookups ---------- */
async function listRepos(owner, cfg) {
  const r = await gh(['repo', 'list', owner, '--limit', '10000', '--json', 'name,nameWithOwner,isArchived,defaultBranchRef,url'], { timeoutMs: 120000 });
  if (r.code !== 0) throw new Error(oneLine(r.err || r.out) || 'Could not list repositories.');
  const all = JSON.parse(r.out);
  const list = all.filter(x => !x.isArchived && x.defaultBranchRef && x.defaultBranchRef.name).map(x => ({
    name: x.name,
    fullName: x.nameWithOwner,
    url: String(x.url).replace(/\.git$/i, '') + '.git',
    branch: Object.prototype.hasOwnProperty.call(cfg.branchOverrides, x.name) ? String(cfg.branchOverrides[x.name]) : x.defaultBranchRef.name
  })).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  if (!list.length) throw new Error('GitHub returned no repositories for ' + owner + '.');
  return list;
}

// One request per 100 repositories returns every branch head, so unchanged projects are never touched.
async function branchHeads(list, active) {
  const heads = new Map();
  for (let i = 0; i < list.length; i += 100) {
    const batch = list.slice(i, i + 100).filter(x => /^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(x.fullName) && BRANCH_RE.test(x.branch));
    const fields = batch.map((x, n) => `r${n}:repository(owner:${JSON.stringify(x.fullName.split('/')[0])},name:${JSON.stringify(x.name)}){ref(qualifiedName:${JSON.stringify('refs/heads/' + x.branch)}){target{oid}}}`);
    const r = await gh(['api', 'graphql', '-f', 'query=query{' + fields.join(' ') + '}'], { timeoutMs: 120000, onSpawn: c => { active.add(c); c.once('close', () => active.delete(c)); } });
    if (r.code !== 0) throw new Error(oneLine(r.err || r.out) || 'GitHub did not answer.');
    const resp = JSON.parse(r.out);
    if (resp.errors) throw new Error('GitHub could not return every branch.');
    batch.forEach((x, n) => {
      const oid = resp.data && resp.data['r' + n] && resp.data['r' + n].ref && resp.data['r' + n].ref.target && resp.data['r' + n].ref.target.oid;
      if (OID_RE.test(oid || '')) heads.set(x.fullName, oid);
    });
  }
  return heads;
}

const KIND_LABEL = { new: 'new file', edited: 'edited', deleted: 'deleted', added: 'new (staged)', renamed: 'renamed', conflict: 'conflict', blocking: 'in the way', ignored: 'ignored' };

/* ---------- the job ---------- */
const empty = () => ({ phase: 'Starting', total: 0, done: 0, updated: 0, cloned: 0, current: 0, paused: 0, errors: 0 });

function startSync() {
  const cfg = loadConfig();
  if (!cfg.root || !fs.existsSync(cfg.root) || !fs.statSync(cfg.root).isDirectory()) {
    throw new Error('Projects folder not found. Set it in Settings.');
  }
  if (jobs.runningOfType('sync')) { const e = new Error('An update is already running.'); e.status = 409; throw e; }
  const job = jobs.create('sync', 'Update Local GitHub');
  const sync = empty();
  const push = (phase) => { if (phase) sync.phase = phase; job.set({ sync: { ...sync } }); };
  const active = new Set();
  let cancelled = false;
  job.onCancel(() => { cancelled = true; for (const c of active) killTree(c); });
  push('Starting');

  (async () => {
    const started = Date.now();
    const secs = () => Math.round((Date.now() - started) / 100) / 10;
    let warning = '';

    // 1. sign-in
    push('Checking your GitHub sign-in');
    job.progress('Checking your GitHub sign-in…');
    const a = await auth.status(true);
    if (!a.ghFound) return job.finish('error', 'The GitHub CLI (gh) was not found. Install it from https://cli.github.com and try again.');
    if (!a.signedIn) return job.finish('error', 'You are not signed in to GitHub. Click "Sign in to GitHub" at the top, then update again.');
    const owner = cfg.owner || a.user;
    if (!owner || !OWNER_RE.test(owner)) return job.finish('error', 'Could not work out which GitHub account to update. Set it in Settings.');
    job.log(`Account: ${owner}`);
    job.log(`Folder: ${cfg.root}`);

    // 2. repositories (falls back to the last list if GitHub cannot be reached)
    push('Finding your repositories');
    job.progress('Finding your repositories…');
    const cachePath = 'sync-repos.json';
    let list;
    try {
      list = await listRepos(owner, cfg);
      store.write(cachePath, { owner, list });
    } catch (e) {
      if (cancelled) return job.finish('cancelled', 'Update cancelled.');
      const cached = store.read(cachePath, null);
      if (!cached || cached.owner !== owner || !Array.isArray(cached.list) || !cached.list.length) {
        return job.finish('error', 'Could not get your repository list from GitHub. ' + e.message);
      }
      list = cached.list;
      warning = 'Could not refresh the repository list, so the last known list was used. ' + e.message;
      job.log(warning, 'error');
    }
    list = list.filter(x => !cfg.excluded.has(x.name.toLowerCase()));
    sync.total = list.length;
    job.log(`${list.length} repositories on GitHub`);

    // 3. quick check: one bulk question to GitHub
    push('Asking GitHub what changed');
    job.progress('Asking GitHub what changed…');
    try {
      const heads = await branchHeads(list, active);
      for (const x of list) if (heads.has(x.fullName)) x.remoteOid = heads.get(x.fullName);
    } catch (e) {
      if (cancelled) return job.finish('cancelled', 'Update cancelled.');
      job.log('Quick check unavailable, so every project is checked individually. ' + e.message);
    }

    // 4. update everything, a few at a time
    const g = makeRunner(active);
    const staging = path.join(cfg.root, '.streamline-staging');
    const results = [];
    const seen = new Set();
    const queue = list.slice();
    const worker = async () => {
      while (queue.length && !cancelled) {
        const r = queue.shift();
        const key = r.name.toLowerCase();
        let res;
        if (seen.has(key)) res = { name: r.name, fullName: r.fullName, branch: r.branch, state: 'Error', detail: 'Another repository uses the same folder name.' };
        else { seen.add(key); res = await syncOne(g, r, path.join(cfg.root, r.name), staging); }
        if (cancelled) break;
        results.push(res);
        sync.done = results.length;
        if (res.state === 'Updated') sync.updated++;
        else if (res.state === 'Cloned') sync.cloned++;
        else if (res.state === 'Paused') sync.paused++;
        else if (res.state === 'Error') sync.errors++;
        else sync.current++;
        if (res.state === 'Cloned') {
          try { repo.upsertProject({ name: r.name, url: r.url, localPath: path.join(cfg.root, r.name), branch: r.branch }); } catch { /* saving the project is a bonus */ }
        }
        const label = { Updated: 'UPDATED   ', Cloned: 'DOWNLOADED', Paused: 'PAUSED    ', Error: 'ERROR     ' }[res.state];
        if (label) job.log(`${label} ${res.name}${res.state === 'Cloned' || res.state === 'Updated' ? '' : ' — ' + res.detail}`, res.state === 'Error' ? 'error' : 'info');
        if (res.info && res.info.files && res.info.files.length) {
          for (const f of res.info.files.slice(0, 8)) job.log(`             ${KIND_LABEL[f.kind] || f.kind}: ${f.path}`);
          const more = res.info.files.length - 8 + (res.info.moreFiles || 0);
          if (more > 0) job.log(`             …and ${more} more`);
        }
        if (res.info && res.info.commits && res.info.commits.length) for (const c of res.info.commits.slice(0, 5)) job.log(`             local commit: ${c}`);
        job.progress(`${sync.done} of ${sync.total} checked`);
        push('Updating your projects');
      }
    };
    push('Updating your projects');
    await Promise.all(Array.from({ length: Math.min(cfg.parallel, list.length) || 1 }, worker));
    try { if (!fs.readdirSync(staging).length) fs.rmdirSync(staging); } catch { /* none left */ }

    if (cancelled) return job.finish('cancelled', `Update cancelled after ${results.length} of ${sync.total} projects.`, { results });

    // 5. summary
    const upToDate = sync.current;
    const bits = [];
    if (sync.updated) bits.push(`${sync.updated} updated`);
    if (sync.cloned) bits.push(`${sync.cloned} downloaded`);
    bits.push(`${upToDate} up to date`);
    if (sync.paused) bits.push(`${sync.paused} paused to protect your work`);
    if (sync.errors) bits.push(`${sync.errors} ${sync.errors === 1 ? 'error' : 'errors'}`);
    const summary = `Checked ${results.length} projects in ${secs()}s: ${bits.join(', ')}.`;
    const last = { finishedAt: new Date().toISOString(), seconds: secs(), total: results.length, updated: sync.updated, cloned: sync.cloned, upToDate, paused: sync.paused, errors: sync.errors };
    try { store.write('sync-last.json', last); } catch { /* best effort */ }
    sync.phase = 'Done';
    const problems = sync.errors > 0 || !!warning;
    try { require('./links').refresh().catch(() => {}); } catch { /* links are a bonus */ }
    job.finish(problems ? 'warning' : 'success', problems && warning && !sync.errors ? summary + ' ' + warning : summary, { sync: { ...sync }, results, lastRun: last });
  })().catch(e => job.finish(cancelled ? 'cancelled' : 'error', cancelled ? 'Update cancelled.' : 'The update could not finish. ' + oneLine(e.message)));
  return job.id;
}

function counts(results) {
  const c = { total: results.length, done: results.length, updated: 0, cloned: 0, current: 0, paused: 0, errors: 0, phase: 'Done' };
  for (const r of results) { if (r.state === 'Updated') c.updated++; else if (r.state === 'Cloned') c.cloned++; else if (r.state === 'Paused') c.paused++; else if (r.state === 'Error') c.errors++; else c.current++; }
  return c;
}

function latestSyncJob() { return jobs.list().find(j => j.type === 'sync' && j.status !== 'running' && Array.isArray(j.results)) || null; }

// Checks one project again (after you moved files out of the way) and updates the last results.
async function retryOne(name) {
  const cfg = loadConfig();
  const last = latestSyncJob();
  const prev = last && last.results.find(r => r.name === name);
  const cached = (store.read('sync-repos.json', {}).list || []).find(r => r.name === name);
  const r = cached || (prev && prev.url ? { name, fullName: prev.fullName, url: prev.url, branch: prev.branch } : null);
  if (!r) throw new Error('That repository is not in the last update.');
  const res = await syncOne(makeRunner(new Set()), r, path.join(cfg.root, r.name), path.join(cfg.root, '.streamline-staging'));
  if (last) {
    const results = last.results.map(x => (x.name === name ? res : x));
    const c = counts(results);
    const bits = [];
    if (c.updated) bits.push(`${c.updated} updated`);
    if (c.cloned) bits.push(`${c.cloned} downloaded`);
    bits.push(`${c.current} up to date`);
    if (c.paused) bits.push(`${c.paused} paused to protect your work`);
    if (c.errors) bits.push(`${c.errors} ${c.errors === 1 ? 'error' : 'errors'}`);
    jobs.patch(last.id, { results, sync: c, status: c.errors ? 'warning' : 'success', summary: `Checked ${results.length} projects: ${bits.join(', ')}.` });
  }
  return res;
}

module.exports = { startSync, retryOne, loadConfig, localSafety, syncOne, sameUrl, parseStatus, blockingFiles, makeRunner, changedFiles };
