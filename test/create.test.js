'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-create-'));
process.env.STREAMLINE_DATA = path.join(tmp, 'data');
process.env.GIT_AUTHOR_NAME = 'T'; process.env.GIT_AUTHOR_EMAIL = 't@t'; process.env.GIT_COMMITTER_NAME = 'T'; process.env.GIT_COMMITTER_EMAIL = 't@t';
// A stand-in for the GitHub CLI: "repo create NAME ..." makes a bare repo, adds it as origin and pushes.
const fake = path.join(tmp, 'gh');
fs.writeFileSync(fake, `#!/bin/sh
echo "$@" >> "${tmp}/gh.log"
[ -f "${tmp}/gh.fail" ] && { cat "${tmp}/gh.fail" >&2; exit 1; }
name=$3; src=""; while [ $# -gt 0 ]; do [ "$1" = "--source" ] && src=$2; shift; done
bare="${tmp}/remotes/$(basename $name).git"; mkdir -p "$bare"; git init -q --bare "$bare"
cd "$src" && git remote add origin "$bare" && git push -q -u origin HEAD
echo "Created repository $name"
`, { mode: 0o755 });
process.env.STREAMLINE_GH = fake;

const jobs = require('../lib/jobs');
const store = require('../lib/store');
const create = require('../lib/create');
const waitJob = async id => { for (let i = 0; i < 300; i++) { const j = jobs.get(id); if (j && j.status !== 'running') return j; await new Promise(r => setTimeout(r, 100)); } throw new Error('timeout'); };
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

test('creates a repo from a brand-new folder, with a README, and saves the project', async () => {
  const parent = path.join(tmp, 'projects');
  const j = await waitJob(create.startCreate({ name: 'brand-new', description: 'A test repo', visibility: 'private', mode: 'new', parent }));
  assert.equal(j.status, 'success', JSON.stringify(j.summary));
  const dir = path.join(parent, 'brand-new');
  assert.match(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), /# brand-new[\s\S]*A test repo/);
  assert.equal(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  assert.equal(git(dir, 'log', '--format=%s'), 'Initial commit');
  assert.match(fs.readFileSync(path.join(tmp, 'gh.log'), 'utf8'), /repo create brand-new --private .*--description A test repo/);
  assert.ok(store.getProjects().some(p => p.name === 'brand-new' && p.localPath === dir));
});

test('uploads an existing folder, adds a .gitignore, and keeps node_modules and .env out', async () => {
  const dir = path.join(tmp, 'mine'); fs.mkdirSync(path.join(dir, 'node_modules/x'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.js'), '1'); fs.writeFileSync(path.join(dir, '.env'), 'KEY=secret'); fs.writeFileSync(path.join(dir, 'node_modules/x/a.js'), '2');
  const j = await waitJob(create.startCreate({ name: 'mine', visibility: 'public', mode: 'existing', folder: dir }));
  assert.equal(j.status, 'success', JSON.stringify(j.summary));
  const tracked = git(dir, 'ls-files').split('\n');
  assert.ok(tracked.includes('index.js') && tracked.includes('.gitignore'));
  assert.ok(!tracked.includes('.env') && !tracked.some(f => f.startsWith('node_modules')));
  assert.match(fs.readFileSync(path.join(tmp, 'gh.log'), 'utf8'), /repo create mine --public/);
});

test('refuses bad names, folders already on GitHub, nested repos, and oversized files', async () => {
  assert.throws(() => create.validate({ name: 'has space', mode: 'new', parent: tmp }), /no spaces/);
  assert.throws(() => create.validate({ name: 'x.git', mode: 'new', parent: tmp }), /no spaces/);
  assert.throws(() => create.validate({ name: 'ok', mode: 'new', parent: tmp, owner: 'bad owner!' }), /owner/);
  assert.throws(() => create.validate({ name: 'mine', mode: 'new', parent: tmp }), /already exists/);
  const again = path.join(tmp, 'mine');
  const j = await waitJob(create.startCreate({ name: 'mine2', mode: 'existing', folder: again }));
  assert.equal(j.status, 'error'); assert.match(j.summary, /already connected/);
  const nested = path.join(again, 'inner'); fs.mkdirSync(nested); fs.writeFileSync(path.join(nested, 'f'), 'x');
  assert.match((await waitJob(create.startCreate({ name: 'inner', mode: 'existing', folder: nested }))).summary, /inside another Git repository/);
  const big = path.join(tmp, 'big'); fs.mkdirSync(big); const fd = fs.openSync(path.join(big, 'huge.bin'), 'w'); fs.ftruncateSync(fd, 96 * 1024 * 1024); fs.closeSync(fd);
  assert.match((await waitJob(create.startCreate({ name: 'big', mode: 'existing', folder: big }))).summary, /over 100 MB: huge\.bin/);
});

test('explains a name that is taken, and a signed-out CLI', async () => {
  const mk = n => { const d = path.join(tmp, n); fs.mkdirSync(d); fs.writeFileSync(path.join(d, 'a'), '1'); return d; };
  fs.writeFileSync(path.join(tmp, 'gh.fail'), 'GraphQL: Name already exists on this account (createRepository)');
  assert.match((await waitJob(create.startCreate({ name: 'taken', mode: 'existing', folder: mk('t1') }))).summary, /already exists on your account/);
  fs.writeFileSync(path.join(tmp, 'gh.fail'), 'To get started with GitHub CLI, please run:  gh auth login');
  assert.match((await waitJob(create.startCreate({ name: 'signedout', mode: 'existing', folder: mk('t2') }))).summary, /Sign in to GitHub/);
  fs.rmSync(path.join(tmp, 'gh.fail'));
});
