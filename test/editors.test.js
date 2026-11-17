'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-ed-'));
process.env.STREAMLINE_OPEN_LOG = path.join(tmp, 'open.log');
process.env.STREAMLINE_EDITORS_JSON = JSON.stringify([
  { id: 'vscode', label: 'Visual Studio Code', exe: 'C:\\x\\Code.exe' },
  { id: 'notepad', label: 'Notepad', exe: 'C:\\Windows\\notepad.exe', file: true }
]);
const editors = require('../lib/editors');
const proj = path.join(tmp, 'My Project'); fs.mkdirSync(proj); fs.writeFileSync(path.join(proj, 'README.md'), 'hi');

test('opens the folder in folder-capable editors and the main file in Notepad', () => {
  editors.openIn('vscode', proj);
  assert.equal(editors.openIn('notepad', proj).label, 'README.md');
  const log = fs.readFileSync(process.env.STREAMLINE_OPEN_LOG, 'utf8').trim().split('\n');
  assert.equal(log[0], `editor:vscode:${proj}`);
  assert.equal(log[1], `editor:notepad:${path.join(proj, 'README.md')}`);
});

test('only editors found on this computer can be launched', () => {
  assert.throws(() => editors.openIn('C:\\evil.exe', proj), /not found/);
  assert.throws(() => editors.openIn('cursor', proj), /not found/);
});
