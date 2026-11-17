'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const jobs = require('./jobs');
const store = require('./store');
const repo = require('./repo');
const { makeMatcher } = require('./exclusions');
const { git, killTree, jobLineHandler, authHint } = require('./proc');
const { isInside, normKey, toPosix, cleanSubfolder, webUrlFromRemote, fmtSize } = require('./util');

const MAX_LIST = 3000;

async function walk(root, isExcluded, maxBytes, acc) {
  async function rec(dir, relDir) {
    let ents;
    try { ents = await fsp.readdir(dir, { withFileTypes: true }); }
    catch (e) { acc.errors.push(`${dir}: ${e.code || e.message}`); return; }
    for (const e of ents) {
      const rel = relDir ? relDir + '/' + e.name : e.name;
      const abs = path.join(dir, e.name);
      if (e.isSymbolicLink()) { acc.skipLink++; continue; }
      if (e.isDirectory()) {
        if (isExcluded(rel, true)) { acc.excluded.push(rel + '/'); continue; }
        await rec(abs, rel);
      } else if (e.isFile()) {
        if (isExcluded(rel, false)) { acc.excluded.push(rel); continue; }
        let st;
        try { st = await fsp.stat(abs); } catch { continue; }
        if (st.size > maxBytes) { acc.tooLarge.push({ rel, size: st.size }); continue; }
        acc.files.push({ abs, rel, size: st.size });
      }
    }
  }
  await rec(root, '');
}

async function sameContent(a, b, sizeA) {
  try {
    const sb = await fsp.stat(b);
    if (sb.size !== sizeA) return false;
    if (sizeA > 64 * 1024 * 1024) return false;
    const [x, y] = await Promise.all([fsp.readFile(a), fsp.readFile(b)]);
    return x.equals(y);
  } catch { return false; }
}

async function currentBranch(dir) {
  const r = await git(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  return r.code === 0 && r.out ? r.out : null;
}

function parseStatus(out) {
  const map = new Map();
  const f = out.split('\0');
  for (let i = 0; i < f.length; i++) {
    const e = f[i];
    if (e.length < 4) continue;
    map.set(e.slice(3), e.slice(0, 2));
    if (e[0] === 'R' || e[0] === 'C' || e[1] === 'R' || e[1] === 'C') i++; // skip rename source
  }
  return map;
}

async function ensureRepo(project) {
  const dir = path.resolve(project.localPath);
  if (!fs.existsSync(dir)) throw new Error(`Folder not found: ${dir}`);
  const info = await repo.repoInfo(dir);
  if (!info) throw new Error(`"${dir}" is not the root of a Git repository. Clone it first, or pick the right folder.`);
  return { dir, info };
}

async function aheadBehind(dir, branch) {
  const has = await git(dir, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`]);
  if (has.code !== 0) return { ahead: 0, behind: 0, remoteExists: false };
  const head = await git(dir, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  if (head.code !== 0) return { ahead: 0, behind: 0, remoteExists: true };
  const r = await git(dir, ['rev-list', '--left-right', '--count', `HEAD...origin/${branch}`]);
  const [a, b] = (r.out || '0\t0').split(/\s+/).map(Number);
  return { ahead: a || 0, behind: b || 0, remoteExists: true };
}

/** Works out exactly what an upload would do, without changing anything. */
async function buildPlan({ project, items, subfolder }) {
  const settings = store.getSettings();
  const { dir } = await ensureRepo(project);
  const sub = cleanSubfolder(subfolder);
  const isExcluded = makeMatcher(settings);
  const maxBytes = Math.max(1, Math.min(100, Number(settings.maxFileMB) || 95)) * 1024 * 1024;
  if (!Array.isArray(items) || !items.length) throw new Error('Add at least one file or folder.');

  const acc = { files: [], excluded: [], tooLarge: [], errors: [], skipLink: 0 };
  const entries = new Map(); // destRel -> entry
  const warnings = [];

  for (const raw of items) {
    const abs = path.resolve(String(raw));
    let st;
    try { st = await fsp.lstat(abs); } catch { warnings.push(`Not found: ${abs}`); continue; }
    const inside = isInside(dir, abs);
    if (st.isSymbolicLink()) { warnings.push(`Skipped link: ${abs}`); continue; }
    if (inside && sub) warnings.push('Target subfolder ignored for items already inside the repository.');
    const sub1 = { files: [], excluded: [], tooLarge: [], errors: [], skipLink: 0 };
    if (st.isFile()) {
      const base = path.basename(abs);
      if (isExcluded(base, false)) sub1.excluded.push(base);
      else if (st.size > maxBytes) sub1.tooLarge.push({ rel: base, size: st.size });
      else sub1.files.push({ abs, rel: base, size: st.size });
    } else if (st.isDirectory()) {
      await walk(abs, isExcluded, maxBytes, sub1);
    } else continue;

    acc.excluded.push(...sub1.excluded);
    acc.tooLarge.push(...sub1.tooLarge);
    acc.errors.push(...sub1.errors);
    acc.skipLink += sub1.skipLink;
    for (const f of sub1.files) {
      let destRel;
      if (inside) destRel = toPosix(path.relative(dir, f.abs));
      else destRel = sub ? `${sub}/${st.isDirectory() ? f.rel : path.basename(f.abs)}` : (st.isDirectory() ? f.rel : path.basename(f.abs));
      if (destRel.split('/').some(s => s === '..' || s.toLowerCase() === '.git')) continue;
      const destAbs = path.join(dir, ...destRel.split('/'));
      if (!isInside(dir, destAbs)) continue;
      if (normKey(destAbs) === normKey(f.abs)) { entries.set(destRel, { destRel, destAbs, src: f.abs, size: f.size, inPlace: true }); continue; }
      entries.set(destRel, { destRel, destAbs, src: f.abs, size: f.size, inPlace: inside });
    }
  }

  const list = [...entries.values()].sort((a, b) => a.destRel.localeCompare(b.destRel));
  const [statusR, tracked] = await Promise.all([
    git(dir, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
    git(dir, ['ls-files', '-z'])
  ]);
  const statusMap = parseStatus(statusR.out || '');
  const trackedSet = new Set((tracked.out || '').split('\0').filter(Boolean));

  const untracked = list.filter(e => !trackedSet.has(e.destRel)).map(e => e.destRel);
  const ignoredSet = new Set();
  if (untracked.length) {
    const ig = await git(dir, ['check-ignore', '-z', '--stdin'], { input: untracked.join('\0') });
    for (const p of (ig.out || '').split('\0').filter(Boolean)) ignoredSet.add(p);
  }

  const files = [];
  const ignored = [];
  for (const e of list) {
    if (ignoredSet.has(e.destRel)) { ignored.push(e.destRel); continue; }
    let status;
    if (trackedSet.has(e.destRel)) {
      if (e.inPlace) status = statusMap.has(e.destRel) ? 'modified' : 'unchanged';
      else status = (await sameContent(e.src, e.destAbs, e.size)) ? 'unchanged' : 'modified';
    } else status = 'new';
    files.push({ ...e, status });
  }

  const counts = { new: 0, modified: 0, unchanged: 0 };
  let bytes = 0;
  for (const f of files) { counts[f.status]++; if (f.status !== 'unchanged') bytes += f.size; }

  const branch = (await currentBranch(dir)) || project.branch || 'main';
  const ab = await aheadBehind(dir, branch);
  const origin = await git(dir, ['remote', 'get-url', 'origin']);
  if (origin.code !== 0) warnings.push('This repository has no "origin" remote, so nothing can be uploaded.');
  if (ab.behind > 0) warnings.push(`GitHub has ${ab.behind} newer commit(s). Streamline will fast-forward before uploading${ab.ahead ? ' (blocked: you also have local commits)' : ''}.`);
  if (acc.tooLarge.length) warnings.push(`${acc.tooLarge.length} file(s) over ${settings.maxFileMB} MB were skipped (GitHub rejects files over 100 MB).`);
  if (acc.errors.length) warnings.push(`${acc.errors.length} folder(s) could not be read.`);

  return {
    dir, branch, remote: origin.out || '', web: webUrlFromRemote(origin.out),
    files, counts, bytes, bytesText: fmtSize(bytes),
    excluded: acc.excluded, tooLarge: acc.tooLarge, ignored, warnings, ahead: ab.ahead, behind: ab.behind
  };
}

function summarize(plan) {
  const shown = plan.files.filter(f => f.status !== 'unchanged').concat(plan.files.filter(f => f.status === 'unchanged'));
  return {
    branch: plan.branch, remote: plan.remote, web: plan.web, counts: plan.counts, bytesText: plan.bytesText,
    files: shown.slice(0, MAX_LIST).map(f => ({ path: f.destRel, status: f.status, size: f.size })),
    filesTruncated: shown.length > MAX_LIST,
    excludedCount: plan.excluded.length, excludedSamples: plan.excluded.slice(0, 40),
    tooLarge: plan.tooLarge.slice(0, 20), ignoredCount: plan.ignored.length, ignoredSamples: plan.ignored.slice(0, 20),
    warnings: plan.warnings, ahead: plan.ahead, behind: plan.behind
  };
}

async function preview(args) { return summarize(await buildPlan(args)); }

function startUpload({ project, items, subfolder, message }) {
  const job = jobs.create('upload', `Upload to ${project.name}`);
  let cancelled = false;
  let current = null;
  job.onCancel(() => { cancelled = true; if (current) killTree(current); });
  const onSpawn = c => { current = c; };
  const hl = jobLineHandler(job);

  (async () => {
    const dir = path.resolve(project.localPath);
    const fail = (msg, extra) => job.finish('error', msg, extra);
    const check = () => { if (cancelled) { job.finish('cancelled', 'Upload cancelled.'); return true; } return false; };

    job.log('Checking repository…');
    await ensureRepo(project);
    const branch = (await currentBranch(dir)) || project.branch || 'main';

    job.log('Checking GitHub for newer commits…');
    const fetched = await git(dir, ['fetch', '--progress', 'origin'], { onLine: hl, onSpawn });
    if (check()) return;
    if (fetched.code !== 0) {
      const empty = /couldn't find remote ref|Could not read from remote/i.test(fetched.err) && !/Authentication|denied|not found/i.test(fetched.err);
      if (!empty) return fail('Could not reach GitHub.' + authHint(fetched.err));
    }
    const ab = await aheadBehind(dir, branch);
    if (ab.behind > 0) {
      if (ab.ahead > 0) return fail('Your local branch and GitHub have both changed. Resolve this in Git first; nothing was uploaded.');
      job.log(`Fast-forwarding ${ab.behind} commit(s) from GitHub…`);
      const m = await git(dir, ['merge', '--ff-only', `origin/${branch}`], { onLine: hl, onSpawn });
      if (m.code !== 0) return fail('Could not fast-forward from GitHub (local changes would be overwritten). Nothing was uploaded.');
    }

    const plan = await buildPlan({ project, items, subfolder });
    const changed = plan.files.filter(f => f.status !== 'unchanged');
    job.log(`${plan.counts.new} new, ${plan.counts.modified} modified, ${plan.counts.unchanged} unchanged · ${plan.excluded.length} excluded`);
    if (!changed.length) return job.finish('success', 'Nothing to upload. Everything is already up to date.');

    // Never sweep unrelated staged work into this commit.
    const staged = await git(dir, ['diff', '--cached', '--name-only', '-z']);
    const plannedSet = new Set(changed.map(f => f.destRel));
    const stray = (staged.out || '').split('\0').filter(Boolean).filter(p => !plannedSet.has(p));
    if (stray.length) return fail(`This repository already has ${stray.length} other staged change(s) (e.g. ${stray[0]}). Commit or unstage them first; nothing was uploaded.`);

    let copied = 0;
    for (const f of changed) {
      if (check()) return;
      if (f.inPlace) continue;
      await fsp.mkdir(path.dirname(f.destAbs), { recursive: true });
      await fsp.copyFile(f.src, f.destAbs);
      copied++;
    }
    if (copied) job.log(`Copied ${copied} file(s) into the repository.`);

    job.log('Staging files…');
    const add = await git(dir, ['add', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: changed.map(f => f.destRel).join('\0'), onLine: hl, onSpawn });
    if (add.code !== 0) return fail('git add failed: ' + (add.err.split('\n')[0] || 'unknown error'));
    const nowStaged = await git(dir, ['diff', '--cached', '--name-only', '-z']);
    if (!(nowStaged.out || '').split('\0').filter(Boolean).length) return job.finish('success', 'Nothing to upload. Everything is already up to date.');

    const msg = (message && String(message).trim()) || `Upload ${changed.length} file${changed.length === 1 ? '' : 's'} via Streamline`;
    job.log('Committing…');
    const c = await git(dir, ['commit', '-m', msg], { onLine: hl, onSpawn });
    if (c.code !== 0) {
      const needId = /tell me who you are|user\.email|empty ident/i.test(c.err);
      return fail('Commit failed.' + (needId ? ' Git does not know your name/email yet. Run: git config --global user.name "Your Name" and git config --global user.email "you@example.com"' : ' ' + (c.err.split('\n')[0] || '')));
    }
    if (check()) return;

    job.log(`Pushing to ${plan.remote ? plan.remote.replace(/\.git$/, '') : 'origin'} (${branch})…`);
    const p = await git(dir, ['push', '-u', '--progress', 'origin', 'HEAD'], { onLine: hl, onSpawn });
    if (cancelled) return job.finish('cancelled', 'Push cancelled. Your commit is saved locally.');
    const hash = (await git(dir, ['rev-parse', '--short', 'HEAD'])).out;
    if (p.code !== 0) {
      const rejected = /rejected|non-fast-forward|fetch first/i.test(p.err);
      return fail((rejected ? 'GitHub rejected the push because it has newer commits. Your commit is saved locally; use Pull, then upload again.' : 'Push failed. Your commit is saved locally.') + authHint(p.err));
    }
    const link = plan.web ? `${plan.web}/commit/${hash}` : null;
    repo.touch(project.id);
    job.finish('success', `Uploaded ${changed.length} file${changed.length === 1 ? '' : 's'} (${plan.counts.new} new, ${plan.counts.modified} modified) to ${project.name} · ${branch} · ${hash}`, { link });
  })().catch(e => job.finish('error', e.message));
  return job.id;
}

module.exports = { preview, startUpload, buildPlan };
