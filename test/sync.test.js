'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-sync-'));
process.env.STREAMLINE_DATA = path.join(tmp, 'data');
process.env.FAKEGH_DIR = tmp;
process.env.STREAMLINE_GH = path.join(__dirname, 'fakegh.js');
const gitEnv = { GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t' };
Object.assign(process.env, gitEnv);

const store = require('../lib/store');
const jobs = require('../lib/jobs');
const sync = require('../lib/sync');

const sh = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();
const remotes = path.join(tmp, 'remotes');
const root = path.join(tmp, 'root');
const work = path.join(tmp, 'work');

function makeRemote(name) {
  const bare = path.join(remotes, name + '.git');
  fs.mkdirSync(bare, { recursive: true });
  sh(bare, 'init', '-q', '--bare', '-b', 'main');
  const w = path.join(work, name);
  fs.mkdirSync(w, { recursive: true });
  sh(w, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(w, 'README.md'), name + '\n');
  sh(w, 'add', '-A'); sh(w, 'commit', '-q', '-m', 'first');
  sh(w, 'remote', 'add', 'origin', bare); sh(w, 'push', '-q', 'origin', 'main');
}
function pushChange(name, file = 'new.txt') {
  const w = path.join(work, name);
  fs.writeFileSync(path.join(w, file), String(Math.random()));
  sh(w, 'add', '-A'); sh(w, 'commit', '-q', '-m', 'more'); sh(w, 'push', '-q', 'origin', 'main');
}
const cloneLocal = name => sh(root, 'clone', '-q', path.join(remotes, name + '.git'), name);
const setRepos = names => fs.writeFileSync(path.join(tmp, 'repos.json'), JSON.stringify(names.map(n => typeof n === 'string' ? { name: n } : n)));

async function runSync() {
  const id = sync.startSync();
  for (let i = 0; i < 600; i++) { const j = jobs.get(id); if (j.status !== 'running') return { job: j, lines: j.lines.map(l => l.text) }; await new Promise(r => setTimeout(r, 100)); }
  throw new Error('sync did not finish');
}
const stateOf = (job, name) => (job.results.find(r => r.name === name) || {}).state;

before(() => {
  fs.mkdirSync(root, { recursive: true });
  for (const n of ['alpha', 'beta', 'gamma', 'delta', 'omega']) makeRemote(n);
  for (const n of ['alpha', 'beta', 'gamma']) cloneLocal(n);
  store.saveSettings({ projectsRoot: root, syncScript: '' });
  setRepos(['alpha', 'beta', 'gamma', 'delta']);
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('first run: unchanged skipped, behind updated, new one downloaded, dirty one paused and untouched', async () => {
  pushChange('beta');
  pushChange('gamma');
  fs.writeFileSync(path.join(root, 'gamma', 'README.md'), 'my local edit\n');
  const { job, lines } = await runSync();
  assert.equal(job.status, 'success', job.summary);
  assert.equal(stateOf(job, 'alpha'), 'Skipped');
  assert.equal(stateOf(job, 'beta'), 'Updated');
  assert.equal(stateOf(job, 'gamma'), 'Paused');
  assert.equal(stateOf(job, 'delta'), 'Cloned');
  assert.ok(fs.existsSync(path.join(root, 'beta', 'new.txt')));
  assert.equal(fs.readFileSync(path.join(root, 'gamma', 'README.md'), 'utf8'), 'my local edit\n');
  assert.ok(!fs.existsSync(path.join(root, 'gamma', 'new.txt')));
  assert.ok(fs.existsSync(path.join(root, 'delta', 'README.md')));
  assert.equal(job.sync.total, 4); assert.equal(job.sync.done, 4);
  assert.match(job.summary, /1 updated, 1 downloaded, 1 up to date, 1 paused/);
  assert.ok(lines.some(l => /^UPDATED\s+beta/.test(l)));
  assert.ok(lines.some(l => /^DOWNLOADED\s+delta/.test(l)));
  assert.ok(lines.some(l => /^PAUSED\s+gamma — You have local edits/.test(l)));
  assert.ok(!lines.some(l => /alpha/.test(l) && /Skipped|up to date/i.test(l)), 'unchanged projects are counted, not listed');
  assert.ok(store.getProjects().some(p => p.name === 'delta'), 'downloaded projects are saved in Streamline');
  assert.equal(fs.existsSync(path.join(root, '.streamline-staging')), false);
});

test('a project with local commits or another branch is paused, never changed', async () => {
  cloneLocal('omega');
  setRepos(['alpha', 'omega']);
  fs.writeFileSync(path.join(root, 'omega', 'mine.txt'), 'x'); sh(path.join(root, 'omega'), 'add', '-A'); sh(path.join(root, 'omega'), 'commit', '-q', '-m', 'local');
  pushChange('omega');
  let { job } = await runSync();
  assert.equal(stateOf(job, 'omega'), 'Paused');
  assert.match(job.results.find(r => r.name === 'omega').detail, /local commits/);
  sh(path.join(root, 'omega'), 'checkout', '-q', '-b', 'feature');
  ({ job } = await runSync());
  assert.match(job.results.find(r => r.name === 'omega').detail, /different branch/i);
  assert.equal(sh(path.join(root, 'omega'), 'rev-parse', '--abbrev-ref', 'HEAD'), 'feature');
});

test('when nothing changed, a second run is quiet', async () => {
  setRepos(['alpha', 'beta', 'delta']);
  const { job } = await runSync();
  assert.equal(job.status, 'success');
  assert.equal(job.sync.updated + job.sync.cloned + job.sync.errors, 0);
  assert.match(job.summary, /3 up to date/);
});

test('the quick check is optional: without it each project is still checked', async () => {
  pushChange('alpha');
  process.env.FAKEGH_GRAPHQL_FAIL = '1';
  const { job, lines } = await runSync();
  delete process.env.FAKEGH_GRAPHQL_FAIL;
  assert.equal(stateOf(job, 'alpha'), 'Updated');
  assert.ok(lines.some(l => /Quick check unavailable/.test(l)));
});

test('when GitHub cannot be listed, the last known list is used with a warning', async () => {
  process.env.FAKEGH_LIST_FAIL = '1';
  const { job } = await runSync();
  delete process.env.FAKEGH_LIST_FAIL;
  assert.equal(job.status, 'warning');
  assert.match(job.summary, /last known list/);
  assert.ok(job.results.length >= 3);
});

test('excluded repositories are left out', async () => {
  store.saveSettings({ syncExcluded: ['delta'] });
  const { job } = await runSync();
  store.saveSettings({ syncExcluded: [] });
  assert.equal(stateOf(job, 'delta'), undefined);
});

test('signed out gives a clear message; a second update at once is refused', async () => {
  process.env.FAKEGH_SIGNED_OUT = '1';
  const { job } = await runSync();
  delete process.env.FAKEGH_SIGNED_OUT;
  assert.equal(job.status, 'error');
  assert.match(job.summary, /not signed in/i);
  const id = sync.startSync();
  assert.throws(() => sync.startSync(), /already running/);
  jobs.cancel(id);
  for (let i = 0; i < 100 && jobs.get(id).status === 'running'; i++) await new Promise(r => setTimeout(r, 100));
  assert.notEqual(jobs.get(id).status, 'running');
});

test('a missing projects folder is explained', () => {
  store.saveSettings({ projectsRoot: path.join(tmp, 'nope') });
  assert.throws(() => sync.startSync(), /Projects folder not found/);
  store.saveSettings({ projectsRoot: root });
});
