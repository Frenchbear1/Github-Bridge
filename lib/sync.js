'use strict';
const fs = require('fs');
const path = require('path');
const jobs = require('./jobs');
const store = require('./store');
const { run, killTree } = require('./proc');
const { IS_WIN } = require('./util');

// Messages copied from "1 - Refresh GitHub Projects.bat" so exit codes read exactly as they do today.
const EXIT_MESSAGES = {
  1: { status: 'warning', text: 'Some checks could not finish. See "Sync status.txt" and try again later.' },
  2: { status: 'warning', text: 'Another refresh is already running. Wait for it to finish before trying again.' }
};

function runnerFor(script) {
  if (process.env.STREAMLINE_SYNC_RUNNER) return { exe: process.env.STREAMLINE_SYNC_RUNNER, args: [script] }; // tests only
  if (IS_WIN) {
    const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    // Same flags as the existing .bat; hidden window via windowsHide.
    return { exe, args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script] };
  }
  return { exe: 'pwsh', args: ['-NoProfile', '-File', script] };
}

function readLastRun(script) {
  try {
    const txt = fs.readFileSync(path.join(path.dirname(script), 'last-run.json'), 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(txt);
  } catch { return null; }
}

function startSync() {
  const settings = store.getSettings();
  const script = settings.syncScript;
  if (!script || !fs.existsSync(script)) {
    throw new Error('Sync script not found. Set its location in Settings (Sync-GitHubProjects.ps1).');
  }
  if (jobs.runningOfType('sync')) {
    const err = new Error('An update is already running.');
    err.status = 409;
    throw err;
  }
  const job = jobs.create('sync', 'Update Local GitHub');
  job.log(`Running ${path.basename(script)}`);
  const { exe, args } = runnerFor(script);
  let cancelled = false;
  run(exe, args, {
    cwd: path.dirname(script),
    onLine: (line, stream) => job.log(line, stream === 'err' ? 'error' : 'info'),
    onSpawn: child => job.onCancel(() => { cancelled = true; killTree(child); })
  }).then(r => {
    if (cancelled) return job.finish('cancelled', 'Update cancelled.');
    const last = readLastRun(script);
    const extra = { exitCode: r.code, lastRun: last };
    const stats = last ? ` (${last.Repositories} projects, ${last.Seconds}s, ${last.Errors} errors, ${last.Paused} paused)` : '';
    if (r.code === 0) job.finish('success', 'Finished. GitHub Projects are up to date' + stats + '.', extra);
    else if (EXIT_MESSAGES[r.code]) job.finish(EXIT_MESSAGES[r.code].status, EXIT_MESSAGES[r.code].text, extra);
    else job.finish('error', 'Refresh could not finish. See the output above.' + (r.code === -1 ? ' ' + r.err : ''), extra);
  });
  return job.id;
}

module.exports = { startSync };
