'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const { makeMatcher } = require('../lib/exclusions');
const { parseRepoUrl, redact, cleanSubfolder } = require('../lib/util');

/* ---------- unit tests ---------- */
test('smart exclusions', () => {
  const ex = makeMatcher({});
  for (const p of ['node_modules/a.js', 'src/node_modules/x/y.js', '.git/config', 'build/out.js', 'a/dist/b.js', 'x.log', '.env', '.env.local', 'k/server.pem', '__pycache__/a.pyc', 'App/bin/Debug/app.dll', '.DS_Store']) {
    assert.equal(ex(p, false), true, p + ' should be excluded');
  }
  for (const p of ['src/app.js', 'README.md', '.env.example', 'bin/run.sh', 'build', 'docs/build-notes.md', '.github/workflows/ci.yml', '.gitignore']) {
    assert.equal(ex(p, false), false, p + ' should be kept');
  }
  assert.equal(ex('build', true), true);
});

test('custom exclusions and disabled defaults', () => {
  const ex = makeMatcher({ customExclusions: ['*.psd', 'secrets/', 'docs/drafts'], disabledDefaults: ['build'] });
  assert.equal(ex('art/logo.psd', false), true);
  assert.equal(ex('secrets/a.txt', false), true);
  assert.equal(ex('docs/drafts/a.md', false), true);
  assert.equal(ex('other/docs/drafts/a.md', false), false); // slash patterns are anchored
  assert.equal(ex('build/out.js', false), false);           // default switched off
  assert.equal(ex('.git/HEAD', false), true);               // .git can never be enabled
  const locked = makeMatcher({ disabledDefaults: ['git'] });
  assert.equal(locked('.git/HEAD', false), true);
});

test('repository URL parsing', () => {
  assert.equal(parseRepoUrl('https://github.com/Frenchbear1/Github-Bridge').url, 'https://github.com/Frenchbear1/Github-Bridge.git');
  assert.equal(parseRepoUrl('git@github.com:o/r.git').name, 'r');
  assert.equal(parseRepoUrl('github.com/o/r/tree/main').name, 'r');
  assert.equal(parseRepoUrl('o/r').url, 'https://github.com/o/r.git');
  for (const bad of ['', 'https://evil.com/o/r', 'ext::sh -c id', '--upload-pack=x', 'file:///etc']) assert.throws(() => parseRepoUrl(bad), bad);
});

test('secrets are redacted', () => {
  assert.equal(redact('token ghp_abcdefghijklmnopqrstuvwxyz0123456789 end'), 'token *** end');
  assert.equal(redact('https://user:pass123@github.com/o/r.git'), 'https://***@github.com/o/r.git');
});

test('subfolder validation', () => {
  assert.equal(cleanSubfolder('\\docs\\img/'), 'docs/img');
  assert.throws(() => cleanSubfolder('../x'));
  assert.throws(() => cleanSubfolder('a/.git'));
});

/* ---------- integration ---------- */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'streamline-test-'));
const PORT = 4600 + Math.floor(Math.random() * 300);
const dataDir = path.join(tmp, 'data');
const remote = path.join(tmp, 'remote.git');
const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...gitEnv } });
const gitEnv = { GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t' };
let server;

function call(method, url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port: PORT, path: url, method, headers: { 'X-Streamline': '1', ...(data ? { 'Content-Type': 'application/json' } : {}), ...headers } }, res => {
      let buf = '';
      res.on('data', c => { buf += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(buf); } catch { /* html */ } resolve({ status: res.statusCode, body: j, text: buf }); });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function waitJob(id) {
  for (let i = 0; i < 200; i++) {
    const { body } = await call('GET', '/api/jobs');
    const j = body.jobs.find(x => x.id === id);
    if (j && j.status !== 'running') return j;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('job timed out');
}

before(async () => {
  fs.mkdirSync(path.join(tmp, 'seed'));
  sh(tmp, 'init', '--bare', '-b', 'main', remote);
  sh(path.join(tmp, 'seed'), 'init', '-b', 'main');
  fs.writeFileSync(path.join(tmp, 'seed', 'README.md'), '# seed\n');
  sh(path.join(tmp, 'seed'), 'add', '.');
  sh(path.join(tmp, 'seed'), 'commit', '-m', 'seed');
  sh(path.join(tmp, 'seed'), 'push', remote, 'main');

  server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, ...gitEnv, PORT: String(PORT), STREAMLINE_DATA: dataDir, STREAMLINE_ALLOW_ANY_REMOTE: '1', STREAMLINE_SYNC_RUNNER: 'sh', HOME: tmp },
    stdio: 'pipe'
  });
  for (let i = 0; i < 50; i++) {
    try { const r = await call('GET', '/api/jobs'); if (r.status === 200) return; } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('server did not start');
});

after(() => { if (server) server.kill(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('serves the UI and rejects foreign hosts / missing header', async () => {
  const page = await call('GET', '/');
  assert.equal(page.status, 200);
  assert.match(page.text, /Streamline/);
  assert.equal((await call('GET', '/api/state', null, { Host: 'evil.example.com' })).status, 403);
  assert.equal((await call('POST', '/api/sync', {}, { 'X-Streamline': '' })).status, 403);
  assert.equal((await call('POST', '/api/sync', {}, { Origin: 'http://evil.example.com' })).status, 403);
  assert.equal((await call('GET', '/..%2f..%2fetc/passwd')).status, 404);
});

let project;
test('clone saves the project', async () => {
  const parent = path.join(tmp, 'projects');
  const r = await call('POST', '/api/clone', { url: remote, parent });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const job = await waitJob(r.body.jobId);
  assert.equal(job.status, 'success', job.summary);
  const st = await call('GET', '/api/state');
  assert.equal(st.body.projects.length, 1);
  project = st.body.projects[0];
  assert.equal(project.name, 'remote');
  assert.ok(fs.existsSync(path.join(parent, 'remote', 'README.md')));
  const again = await call('POST', '/api/clone', { url: remote, parent });
  assert.equal(again.status, 400); // existing non-empty folder is refused
  assert.match(again.body.error, /already exists/);
});

let src;
test('preview applies smart exclusions', async () => {
  src = path.join(tmp, 'mywork');
  const w = (p, c = 'x') => { fs.mkdirSync(path.dirname(path.join(src, p)), { recursive: true }); fs.writeFileSync(path.join(src, p), c); };
  w('src/app.js', 'console.log(1)');
  w('src/util.js');
  w('node_modules/pkg/index.js');
  w('build/out.js');
  w('.env', 'SECRET=1');
  w('.env.example', 'SECRET=');
  w('debug.log');
  w('.git/config');
  w('art/logo.psd');
  const r = await call('POST', '/api/upload/preview', { projectId: project.id, items: [src] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const paths = r.body.files.map(f => f.path).sort();
  assert.deepEqual(paths, ['.env.example', 'art/logo.psd', 'src/app.js', 'src/util.js']);
  assert.equal(r.body.counts.new, 4);
  assert.equal(r.body.excludedCount, 5);
  // custom exclusion
  await call('PUT', '/api/settings', { customExclusions: ['*.psd'] });
  const r2 = await call('POST', '/api/upload/preview', { projectId: project.id, items: [src] });
  assert.equal(r2.body.counts.new, 3);
});

test('upload commits and pushes only the allowed files', async () => {
  const r = await call('POST', '/api/upload', { projectId: project.id, items: [src], subfolder: 'imported', message: 'Test upload' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const job = await waitJob(r.body.jobId);
  assert.equal(job.status, 'success', job.summary + JSON.stringify(job));
  const tree = sh(remote, 'ls-tree', '-r', '--name-only', 'main').trim().split('\n').sort();
  assert.deepEqual(tree, ['README.md', 'imported/.env.example', 'imported/src/app.js', 'imported/src/util.js']);
  assert.equal(sh(remote, 'log', '-1', '--format=%s', 'main').trim(), 'Test upload');
});

test('re-upload reports nothing to do; edits show as modified', async () => {
  const p1 = await call('POST', '/api/upload/preview', { projectId: project.id, items: [src], subfolder: 'imported' });
  assert.equal(p1.body.counts.new + p1.body.counts.modified, 0);
  const r = await call('POST', '/api/upload', { projectId: project.id, items: [src], subfolder: 'imported' });
  const job = await waitJob(r.body.jobId);
  assert.equal(job.status, 'success');
  assert.match(job.summary, /Nothing to upload/);

  fs.writeFileSync(path.join(src, 'src', 'app.js'), 'console.log(2)');
  const p2 = await call('POST', '/api/upload/preview', { projectId: project.id, items: [src], subfolder: 'imported' });
  assert.equal(p2.body.counts.modified, 1);
  assert.equal(p2.body.counts.unchanged, 2);
});

test('single file upload, and fast-forward when GitHub is ahead', async () => {
  // someone else pushes first
  const other = path.join(tmp, 'other');
  sh(tmp, 'clone', remote, other);
  fs.writeFileSync(path.join(other, 'from-elsewhere.txt'), 'hi');
  sh(other, 'add', '.');
  sh(other, 'commit', '-m', 'elsewhere');
  sh(other, 'push', 'origin', 'main');

  const f = path.join(tmp, 'single.txt');
  fs.writeFileSync(f, 'single');
  const r = await call('POST', '/api/upload', { projectId: project.id, items: [f, path.join(src, 'src', 'app.js')], subfolder: 'misc' });
  const job = await waitJob(r.body.jobId);
  assert.equal(job.status, 'success', job.summary);
  const tree = sh(remote, 'ls-tree', '-r', '--name-only', 'main').split('\n');
  assert.ok(tree.includes('from-elsewhere.txt'));
  assert.ok(tree.includes('misc/single.txt'));
  assert.ok(tree.includes('misc/app.js'));
});

test('in-place upload of files already inside the repo', async () => {
  const dir = project.localPath;
  fs.writeFileSync(path.join(dir, 'inplace.txt'), 'a');
  const r = await call('POST', '/api/upload', { projectId: project.id, items: [dir] });
  const job = await waitJob(r.body.jobId);
  assert.equal(job.status, 'success', job.summary);
  assert.ok(sh(remote, 'ls-tree', '-r', '--name-only', 'main').includes('inplace.txt'));
});

test('refuses to sweep in unrelated staged changes', async () => {
  const dir = project.localPath;
  fs.writeFileSync(path.join(dir, 'staged-other.txt'), 'x');
  sh(dir, 'add', 'staged-other.txt');
  const f = path.join(tmp, 'another.txt');
  fs.writeFileSync(f, 'y');
  const r = await call('POST', '/api/upload', { projectId: project.id, items: [f] });
  const job = await waitJob(r.body.jobId);
  assert.equal(job.status, 'error');
  assert.match(job.summary, /other staged/);
  sh(dir, 'reset', '-q', 'staged-other.txt');
  fs.rmSync(path.join(dir, 'staged-other.txt'));
});

test('add existing folder and import-from-folder', async () => {
  const root = path.join(tmp, 'scanroot');
  for (const n of ['a', 'b']) { fs.mkdirSync(path.join(root, n), { recursive: true }); sh(path.join(root, n), 'init', '-b', 'main'); }
  fs.mkdirSync(path.join(root, 'plain'));
  const r = await call('POST', '/api/projects/scan', { root });
  assert.equal(r.body.added, 2);
  const one = await call('POST', '/api/projects', { localPath: path.join(root, 'plain') });
  assert.equal(one.status, 400);
});

/* ---------- sync runner: exit codes 0 / 1 / 2 must map exactly like the .bat ---------- */
async function runSync(exitCode) {
  const dir = path.join(tmp, 'sync' + exitCode, '.github-sync');
  fs.mkdirSync(dir, { recursive: true });
  const script = path.join(dir, 'Sync-GitHubProjects.ps1');
  fs.writeFileSync(script, `echo "UPDATED     o/repo"\necho "Finished in 1 seconds. Updated: 1 | Downloaded: 0 | Errors: 0"\nexit ${exitCode}\n`);
  fs.writeFileSync(path.join(dir, 'last-run.json'), '﻿' + JSON.stringify({ Repositories: 56, Seconds: 9.9, Errors: 0, Paused: 0 }));
  const put = await call('PUT', '/api/settings', { syncScript: script });
  assert.equal(put.status, 200);
  const r = await call('POST', '/api/sync', {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const job = await waitJob(r.body.jobId);
  const lines = (await call('GET', `/api/jobs/${job.id}/lines`)).body.lines.map(l => l.text);
  return { job, lines };
}

test('sync exit code 0 = success with live output', async () => {
  const { job, lines } = await runSync(0);
  assert.equal(job.status, 'success');
  assert.equal(job.exitCode, 0);
  assert.ok(lines.includes('UPDATED     o/repo'));
  assert.match(job.summary, /56 projects/);
});

test('sync exit code 1 = finished with errors', async () => {
  const { job } = await runSync(1);
  assert.equal(job.status, 'warning');
  assert.equal(job.exitCode, 1);
  assert.equal(job.summary, 'Some checks could not finish. See "Sync status.txt" and try again later.');
});

test('sync exit code 2 = already running', async () => {
  const { job } = await runSync(2);
  assert.equal(job.status, 'warning');
  assert.equal(job.exitCode, 2);
  assert.equal(job.summary, 'Another refresh is already running. Wait for it to finish before trying again.');
});

test('sync any other exit code = error', async () => {
  const { job } = await runSync(5);
  assert.equal(job.status, 'error');
  assert.equal(job.exitCode, 5);
});

test('second sync while one runs is refused', async () => {
  const dir = path.join(tmp, 'slow', '.github-sync');
  fs.mkdirSync(dir, { recursive: true });
  const script = path.join(dir, 'Sync-GitHubProjects.ps1');
  fs.writeFileSync(script, 'sleep 1\nexit 0\n');
  await call('PUT', '/api/settings', { syncScript: script });
  const a = await call('POST', '/api/sync', {});
  const b = await call('POST', '/api/sync', {});
  assert.equal(a.status, 200);
  assert.equal(b.status, 409);
  await waitJob(a.body.jobId);
});

test('sync with a missing script gives a helpful error', async () => {
  await call('PUT', '/api/settings', { syncScript: path.join(tmp, 'nope.ps1') });
  const r = await call('POST', '/api/sync', {});
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Sync script not found/);
});

test('closing the last browser tab stops the server; a quick reload keeps it alive', async () => {
  const { spawn } = require('node:child_process');
  const http = require('node:http');
  const port = 4790 + Math.floor(Math.random() * 100);
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), '--autoquit'], {
    env: { ...process.env, PORT: String(port), STREAMLINE_DATA: fs.mkdtempSync(path.join(os.tmpdir(), 'sl-aq-')), STREAMLINE_AUTOQUIT_GRACE_MS: '2000', STREAMLINE_AUTOQUIT_FIRST_MS: '60000' }, stdio: 'ignore'
  });
  let exited = false; child.on('exit', () => { exited = true; });
  const connect = () => new Promise((res, rej) => { const r = http.get({ port, host: '127.0.0.1', path: '/api/events', headers: { Host: `localhost:${port}` } }, resp => res({ r, resp })); r.on('error', rej); });
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  try {
    let c; for (let i = 0; i < 30; i++) { try { c = await connect(); break; } catch { await sleep(200); } }
    assert.ok(c, 'server did not start');
    c.r.destroy(); await sleep(800);                       // tab reload: gone for less than the grace period
    c = await connect(); await sleep(3500);
    assert.equal(exited, false, 'stopped while a tab was open');
    c.r.destroy();                                         // tab closed for good
    for (let i = 0; i < 40 && !exited; i++) await sleep(250);
    assert.equal(exited, true, 'did not stop after the tab closed');
  } finally { if (!exited) child.kill(); }
});
