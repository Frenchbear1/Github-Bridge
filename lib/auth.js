'use strict';
const jobs = require('./jobs');
const { gh, ghExe, killTree } = require('./proc');
const { openUrl } = require('./open');

let cache = { at: 0, value: null };

// Checks the existing GitHub CLI sign-in. Tokens are never read or returned.
async function status(force) {
  if (!force && cache.value && Date.now() - cache.at < 15000) return cache.value;
  const r = await gh(['auth', 'status', '--hostname', 'github.com'], { timeoutMs: 15000 });
  const text = r.out + '\n' + r.err;
  let value;
  if (/Could not find|ENOENT/i.test(text) && r.code !== 0 && !/github\.com/.test(text)) value = { ghFound: false, signedIn: false, user: null };
  else {
    const m = text.match(/account\s+(\S+)/i) || text.match(/as\s+(\S+)/i);
    value = { ghFound: true, signedIn: r.code === 0, user: r.code === 0 && m ? m[1].replace(/[()]/g, '') : null };
  }
  cache = { at: Date.now(), value };
  return value;
}

// Browser device-flow sign-in through the GitHub CLI. The one-time code is shown in the Activity log.
function startLogin() {
  if (jobs.runningOfType('login')) { const e = new Error('Sign-in is already in progress.'); e.status = 409; throw e; }
  const job = jobs.create('login', 'Sign in to GitHub');
  job.log('Starting GitHub sign-in…');
  let opened = false;
  let cancelled = false;
  gh(['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web', '--skip-ssh-key'], {
    input: '\n',
    timeoutMs: 10 * 60 * 1000,
    onSpawn: child => job.onCancel(() => { cancelled = true; killTree(child); }),
    onLine: line => {
      job.log(line);
      const code = line.match(/one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/i);
      if (code) job.set({ progress: `Enter code ${code[1]} on GitHub` });
      if (!opened && /github\.com\/login\/device/.test(line)) { opened = true; openUrl('https://github.com/login/device'); }
    }
  }).then(async r => {
    if (cancelled) return job.finish('cancelled', 'Sign-in cancelled.');
    if (r.code !== 0) return job.finish('error', 'Sign-in did not complete. You can also run "gh auth login" in a terminal.');
    await gh(['auth', 'setup-git', '--hostname', 'github.com']); // lets git use the new sign-in
    const s = await status(true);
    job.finish('success', s.user ? `Signed in as ${s.user}.` : 'Signed in.');
  });
  return job.id;
}

module.exports = { status, startLogin, ghExe };
