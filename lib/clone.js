'use strict';
const fs = require('fs');
const path = require('path');
const jobs = require('./jobs');
const repo = require('./repo');
const { git, killTree, jobLineHandler, authHint } = require('./proc');
const { parseRepoUrl } = require('./util');

function destIsUsable(dest) {
  if (!fs.existsSync(dest)) return true;
  return fs.statSync(dest).isDirectory() && fs.readdirSync(dest).length === 0;
}

// Starts a clone job and returns immediately with the job id.
function startClone({ url, parent }) {
  const parsed = parseRepoUrl(url);
  if (!parent || !String(parent).trim()) throw new Error('Choose a folder to clone into.');
  const parentDir = path.resolve(String(parent).trim());
  const dest = path.join(parentDir, parsed.name);
  if (!destIsUsable(dest)) throw new Error(`"${dest}" already exists and is not empty.`);

  const job = jobs.create('clone', `Clone ${parsed.owner}/${parsed.name}`);
  job.log(`Cloning ${parsed.url}`);
  job.log(`Into ${dest}`);

  (async () => {
    try { fs.mkdirSync(parentDir, { recursive: true }); } catch (e) { return job.finish('error', `Could not create ${parentDir}: ${e.message}`); }
    let cancelled = false;
    const r = await git(parentDir, ['-c', 'protocol.ext.allow=never', 'clone', '--progress', '--', parsed.url, dest], {
      onLine: jobLineHandler(job),
      onSpawn: child => job.onCancel(() => { cancelled = true; killTree(child); })
    });
    if (cancelled) return job.finish('cancelled', 'Clone cancelled.');
    if (r.code !== 0) {
      return job.finish('error', 'Clone failed.' + authHint(r.err), { exitCode: r.code });
    }
    const info = await repo.repoInfo(dest);
    const project = repo.upsertProject({ name: parsed.name, url: info && info.url || parsed.url, localPath: dest, branch: info ? info.branch : 'main' });
    job.finish('success', `Cloned ${parsed.name} and saved it to your projects.`, { exitCode: 0, link: parsed.web, projectId: project.id });
  })().catch(e => job.finish('error', e.message));
  return job.id;
}

function startPull(project) {
  const job = jobs.create('pull', `Pull ${project.name}`);
  (async () => {
    let cancelled = false;
    const onSpawn = child => job.onCancel(() => { cancelled = true; killTree(child); });
    const f = await git(project.localPath, ['fetch', '--progress', 'origin'], { onLine: jobLineHandler(job), onSpawn });
    if (cancelled) return job.finish('cancelled', 'Cancelled.');
    if (f.code !== 0) return job.finish('error', 'Fetch failed.' + authHint(f.err));
    const br = await git(project.localPath, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    const branch = br.out || project.branch;
    const m = await git(project.localPath, ['merge', '--ff-only', `origin/${branch}`], { onLine: jobLineHandler(job) });
    if (m.code !== 0) return job.finish('warning', 'Could not fast-forward (local changes or diverged history). Nothing was changed.');
    job.finish('success', /Already up to date/i.test(m.out) ? 'Already up to date.' : 'Updated from GitHub.');
  })().catch(e => job.finish('error', e.message));
  return job.id;
}

module.exports = { startClone, startPull };
