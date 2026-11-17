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

/* ---------- what is in the way, and clearing it ---------- */
const syncfix = require('../lib/syncfix');
const lastResults = () => jobs.list().find(j => j.type === 'sync' && j.status !== 'running').results;

test('a paused project lists the exact files; Move out sets them aside and updates', async () => {
  store.saveSettings({ projectsRoot: root });
  makeRemote('kappa'); cloneLocal('kappa');
  setRepos(['kappa']);
  pushChange('kappa', 'from-github.txt');
  const dir = path.join(root, 'kappa');
  fs.writeFileSync(path.join(dir, 'README.md'), 'my edit\n');
  fs.mkdirSync(path.join(dir, 'notes'));
  fs.writeFileSync(path.join(dir, 'notes', 'todo.txt'), 'mine');
  const { job, lines } = await runSync();
  const r = job.results.find(x => x.name === 'kappa');
  assert.equal(r.state, 'Paused');
  assert.equal(r.info.code, 'dirty');
  assert.deepEqual(r.info.files.map(f => `${f.kind}:${f.path}`).sort(), ['edited:README.md', 'new:notes/todo.txt']);
  assert.ok(lines.some(l => /new file: notes\/todo\.txt/.test(l)));

  const out = await syncfix.fix({ name: 'kappa', action: 'moveout', paths: ['README.md', 'notes/todo.txt'] });
  assert.equal(out.result.state, 'Updated', JSON.stringify(out));
  assert.equal(fs.readFileSync(path.join(root, '_Set aside', 'kappa', 'README.md'), 'utf8'), 'my edit\n');
  assert.equal(fs.readFileSync(path.join(root, '_Set aside', 'kappa', 'notes', 'todo.txt'), 'utf8'), 'mine');
  assert.equal(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), 'kappa\n');
  assert.ok(fs.existsSync(path.join(dir, 'from-github.txt')));
  assert.equal(lastResults().find(x => x.name === 'kappa').state, 'Updated', 'the stored results are updated too');
});

test('Delete removes a new file; a deleted tracked file can be restored; staged files are handled', async () => {
  pushChange('kappa', 'again.txt');
  const dir = path.join(root, 'kappa');
  fs.writeFileSync(path.join(dir, 'junk.log'), 'x');
  fs.writeFileSync(path.join(dir, 'staged.txt'), 'y'); sh(dir, 'add', 'staged.txt');
  fs.rmSync(path.join(dir, 'README.md'));
  await runSync();
  const r = lastResults().find(x => x.name === 'kappa');
  assert.deepEqual(r.info.files.map(f => f.kind).sort(), ['added', 'deleted', 'new']);
  const out = await syncfix.fix({ name: 'kappa', action: 'delete', paths: ['junk.log', 'staged.txt', 'README.md'] });
  assert.equal(out.result.state, 'Updated', JSON.stringify(out));
  assert.ok(!fs.existsSync(path.join(dir, 'junk.log')));
  assert.ok(!fs.existsSync(path.join(dir, 'staged.txt')));
  assert.ok(fs.existsSync(path.join(dir, 'README.md')));
});

test('files outside the project or not reported by Git are refused', async () => {
  await assert.rejects(syncfix.fix({ name: 'kappa', action: 'delete', paths: ['../alpha/README.md'] }), /inside the project/);
  await assert.rejects(syncfix.fix({ name: 'kappa', action: 'delete', paths: ['.git/config'] }), /inside the project/);
  await assert.rejects(syncfix.fix({ name: '..', action: 'delete', paths: ['x'] }), /Unknown project/);
  const out = await syncfix.fix({ name: 'kappa', action: 'delete', paths: ['README.md'] });
  assert.match(out.done[0], /nothing to do/);
  assert.ok(fs.existsSync(path.join(root, 'kappa', 'README.md')), 'a clean tracked file is never touched');
});

test('a file that would be overwritten is named; local commits are listed; wrong branch can be switched back', async () => {
  const dir = path.join(root, 'kappa');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'secret.cfg\n');
  const w = path.join(work, 'kappa');
  fs.writeFileSync(path.join(w, 'secret.cfg'), 'from github'); sh(w, 'add', '-f', 'secret.cfg'); sh(w, 'commit', '-q', '-m', 'track it'); sh(w, 'push', '-q', 'origin', 'main');
  fs.writeFileSync(path.join(dir, 'secret.cfg'), 'local'); fs.rmSync(path.join(dir, '.gitignore'));
  sh(dir, 'config', 'core.excludesFile', path.join(tmp, 'globalignore')); fs.writeFileSync(path.join(tmp, 'globalignore'), 'secret.cfg\n');
  await runSync();
  let r = lastResults().find(x => x.name === 'kappa');
  assert.equal(r.state, 'Paused');
  assert.equal(r.info.code, 'declined', JSON.stringify(r));
  assert.deepEqual(r.info.files.map(f => f.path), ['secret.cfg']);
  const out = await syncfix.fix({ name: 'kappa', action: 'moveout', paths: ['secret.cfg'] });
  assert.equal(out.result.state, 'Updated', JSON.stringify(out));
  assert.equal(fs.readFileSync(path.join(root, '_Set aside', 'kappa', 'secret.cfg'), 'utf8'), 'local');

  fs.writeFileSync(path.join(dir, 'mine.txt'), '1'); sh(dir, 'add', '-A'); sh(dir, 'commit', '-q', '-m', 'my local work');
  pushChange('kappa', 'later.txt');
  await runSync();
  r = lastResults().find(x => x.name === 'kappa');
  assert.equal(r.info.code, 'commits');
  assert.match(r.info.commits[0], /my local work/);

  sh(dir, 'reset', '-q', '--hard', 'origin/main'); sh(dir, 'checkout', '-q', '-b', 'side');
  await runSync();
  r = lastResults().find(x => x.name === 'kappa');
  assert.equal(r.info.code, 'branch'); assert.equal(r.info.onBranch, 'side'); assert.equal(r.info.clean, true);
  const sw = await syncfix.fix({ name: 'kappa', action: 'switch', branch: 'main' });
  assert.match(sw.result.state, /Updated|Current/, JSON.stringify(sw));
  assert.equal(sh(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
});

test('programs Streamline starts never inherit its PORT or private settings', () => {
  const { childEnv } = require('../lib/proc');
  const saved = process.env.PORT; process.env.PORT = '4545';
  const env = childEnv({ X: '1' });
  if (saved === undefined) delete process.env.PORT; else process.env.PORT = saved;
  assert.equal(env.PORT, undefined);
  assert.equal(Object.keys(env).some(k => /^STREAMLINE_/.test(k)), false);
  assert.equal(env.X, '1');
});

/* ---------- website, Pages and releases ---------- */
test('GitHub links and releases are loaded, and Play can be routed to them', async () => {
  const links = require('../lib/links');
  const launch = require('../lib/launch');
  fs.writeFileSync(path.join(tmp, 'repos.json'), JSON.stringify([
    { name: 'alpha', homepage: 'https://alpha.example.com', pages: 'https://tester.github.io/alpha/', releases: [{ tag: 'v2.0', assets: ['alpha-mac.dmg', 'Alpha.AppImage'] }] },
    { name: 'beta' }
  ]));
  store.saveProjects([
    { id: 'aaaaaaaaaa', name: 'alpha', url: 'https://github.com/tester/alpha.git', localPath: path.join(root, 'alpha'), branch: 'main' },
    { id: 'bbbbbbbbbb', name: 'beta', url: 'https://github.com/tester/beta', localPath: path.join(root, 'beta'), branch: 'main' },
    { id: 'cccccccccc', name: 'local-only', url: '', localPath: path.join(root, 'gamma'), branch: 'main' }
  ]);
  const st = await links.refresh();
  assert.equal(st.byId.aaaaaaaaaa.homepage, 'https://alpha.example.com');
  assert.equal(st.byId.aaaaaaaaaa.pages, 'https://tester.github.io/alpha/');
  assert.equal(st.byId.aaaaaaaaaa.releases[0].tag, 'v2.0');
  assert.equal(st.byId.bbbbbbbbbb.homepage, '');
  assert.equal(st.byId.cccccccccc, undefined);
  assert.equal(links.runnableAsset(st.byId.aaaaaaaaaa.releases[0]).name, 'Alpha.AppImage');

  links.setTarget('aaaaaaaaaa', 'release');
  assert.equal(links.targetOf('aaaaaaaaaa'), 'release');
  assert.throws(() => links.setTarget('aaaaaaaaaa', 'evil'), /Unknown/);
  const project = store.getProjects()[0];
  const id = links.play(project, 'release', launch);
  for (let i = 0; i < 100 && !fs.existsSync(path.join(tmp, 'RELEASE_RAN')); i++) await new Promise(r => setTimeout(r, 100));
  assert.ok(fs.existsSync(path.join(tmp, 'RELEASE_RAN')), 'the release file was downloaded and run');
  assert.equal(jobs.get(id).projectId, 'aaaaaaaaaa');
  assert.throws(() => links.play(store.getProjects()[1], 'homepage', launch), /no website/);
  links.setTarget('aaaaaaaaaa', 'local');
  assert.equal(links.targetOf('aaaaaaaaaa'), 'local');
});
