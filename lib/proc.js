'use strict';
const fs = require('fs');
const { spawn } = require('child_process');
const { IS_WIN } = require('./util');

const GIT_ENV = {
  GIT_TERMINAL_PROMPT: '0',     // never wait for a password on a hidden console
  GCM_INTERACTIVE: 'Never',
  GH_PROMPT_DISABLED: '1'
};

function findExe(envName, winPath, fallback) {
  if (process.env[envName]) return process.env[envName];
  if (IS_WIN && fs.existsSync(winPath)) return winPath;
  return fallback;
}

const gitExe = () => findExe('STREAMLINE_GIT', 'C:\\Program Files\\Git\\cmd\\git.exe', 'git');
const ghExe = () => findExe('STREAMLINE_GH', 'C:\\Program Files\\GitHub CLI\\gh.exe', 'gh');

function lineSplitter(cb) {
  let buf = '';
  return {
    push(chunk) {
      buf += chunk;
      const parts = buf.split(/\r\n|\r|\n/);
      buf = parts.pop();
      for (const p of parts) cb(p);
    },
    flush() { if (buf) cb(buf); buf = ''; }
  };
}

function killTree(child) {
  if (!child || child.killed || child.exitCode !== null) return;
  if (IS_WIN) spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  else {
    // POSIX: the child leads its own process group, so one signal reaches npm and everything it started.
    try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* already gone */ } }
  }
}

/**
 * Run a program without a console window. Resolves (never rejects) with { code, out, err }.
 * opts: cwd, env, input, onLine(line, stream), onSpawn(child), timeoutMs
 */
function run(exe, args, opts = {}) {
  return new Promise(resolve => {
    let child;
    try {
      child = spawn(exe, args, {
        cwd: opts.cwd,
        env: { ...process.env, ...GIT_ENV, ...(opts.env || {}) },
        windowsHide: opts.hide !== false, // GUI programs must not be started hidden
        windowsVerbatimArguments: !!opts.verbatim,
        detached: !IS_WIN,
        stdio: [opts.input != null ? 'pipe' : 'ignore', 'pipe', 'pipe']
      });
    } catch (e) {
      return resolve({ code: -1, out: '', err: e.message });
    }
    if (opts.onSpawn) opts.onSpawn(child);
    let out = '';
    let err = '';
    const so = lineSplitter(l => opts.onLine && opts.onLine(l, 'out'));
    const se = lineSplitter(l => opts.onLine && opts.onLine(l, 'err'));
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => { out += d; so.push(d); });
    child.stderr.on('data', d => { err += d; se.push(d); });
    let timer = null;
    if (opts.timeoutMs) timer = setTimeout(() => { err += '\nTimed out.'; killTree(child); }, opts.timeoutMs);
    let finished = false;
    const finish = code => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      so.flush(); se.flush();
      resolve({ code: code === null || code === undefined ? -1 : code, out: out.replace(/\s+$/, ''), err: err.replace(/\s+$/, '') });
    };
    // A program that cannot start (e.g. not installed) emits 'error' and may never emit 'close'.
    child.on('error', e => {
      err += (err ? '\n' : '') + (e.code === 'ENOENT' ? `Could not find "${exe}". Is it installed?` : e.message);
      finish(-1);
    });
    child.on('close', finish);
    if (opts.input != null) {
      child.stdin.on('error', () => {});
      child.stdin.end(opts.input);
    }
  });
}

const git = (cwd, args, opts = {}) => run(gitExe(), ['-c', 'core.longpaths=true', '-c', 'core.quotepath=false', ...args], { cwd, ...opts });
const gh = (args, opts = {}) => run(ghExe(), args, opts);

const PROGRESS_RE = /^(remote: )?(Enumerating|Counting|Compressing|Receiving|Resolving|Writing|Updating files|Checking out|Unpacking)\b.*\d+%/;

// Route output lines to a job: git progress replaces the progress line, everything else is logged.
function jobLineHandler(job) {
  return (line) => {
    if (PROGRESS_RE.test(line)) job.progress(line);
    else job.log(line);
  };
}

const AUTH_HINT_RE = /Authentication failed|could not read Username|terminal prompts disabled|Permission denied|Repository not found|403|401|invalid credentials|not logged in/i;
function authHint(text) {
  return AUTH_HINT_RE.test(text || '') ? ' If this is a private repository or you are signed out, click "Sign in to GitHub" at the top and try again.' : '';
}

module.exports = { run, git, gh, gitExe, ghExe, killTree, jobLineHandler, authHint };
