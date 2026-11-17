'use strict';
/** Creates a new GitHub repository from a local folder (new or existing) and saves it as a project. */
const fs = require('fs');
const path = require('path');
const jobs = require('./jobs');
const repo = require('./repo');
const { git, gh, killTree, jobLineHandler, authHint } = require('./proc');
const { webUrlFromRemote, fmtSize } = require('./util');

const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;
const OWNER_RE = /^[A-Za-z0-9-]{1,39}$/;
const MAX_FILE = 95 * 1024 * 1024; // GitHub rejects files over 100 MB
const GITIGNORE = `# Added by Streamline
node_modules/
.venv/
venv/
__pycache__/
dist/
build/
.next/
.expo/
target/
obj/
*.log
.DS_Store
Thumbs.db
.env
.env.*
!.env.example
Streamline-Play.bat
`;

const isEmptyDir = dir => { try { return fs.readdirSync(dir).filter(n => n !== '.git').length === 0; } catch { return true; } };

function validate(b) {
  const name = String(b.name || '').trim();
  if (!NAME_RE.test(name) || name === '.' || name === '..' || name.endsWith('.git')) throw new Error('Repository names can use letters, numbers, dashes, dots and underscores (no spaces).');
  const owner = String(b.owner || '').trim();
  if (owner && !OWNER_RE.test(owner)) throw new Error('That owner does not look like a GitHub user or organization name.');
  const visibility = b.visibility === 'public' ? 'public' : 'private';
  const description = String(b.description || '').replace(/[\r\n\0]+/g, ' ').trim().slice(0, 350);
  let dir;
  if (b.mode === 'existing') {
    if (!b.folder || !String(b.folder).trim()) throw new Error('Choose the folder to upload.');
    dir = path.resolve(String(b.folder).trim());
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`"${dir}" is not a folder.`);
    if (isEmptyDir(dir)) throw new Error('That folder is empty. Choose "Start with a new empty folder" instead, or add some files first.');
  } else {
    if (!b.parent || !String(b.parent).trim()) throw new Error('Choose where the new folder should go.');
    dir = path.join(path.resolve(String(b.parent).trim()), name);
    if (fs.existsSync(dir) && !isEmptyDir(dir)) throw new Error(`"${dir}" already exists and is not empty. Pick another name, or use "I already have a folder".`);
  }
  return { name, owner, visibility, description, dir, existing: b.mode === 'existing' };
}

function startCreate(body) {
  const v = validate(body);
  const full = v.owner ? `${v.owner}/${v.name}` : v.name;
  const job = jobs.create('create', `Create ${full}`);
  job.log(`Creating a ${v.visibility} repository "${full}" from ${v.dir}`);
  let cancelled = false;
  const onSpawn = child => job.onCancel(() => { cancelled = true; killTree(child); });
  const fail = (msg, extra) => job.finish('error', msg, extra);

  (async () => {
    fs.mkdirSync(v.dir, { recursive: true });
    const top = await git(v.dir, ['rev-parse', '--show-toplevel']);
    const isRepo = top.code === 0 && require('./util').normKey(top.out) === require('./util').normKey(v.dir);
    if (top.code === 0 && !isRepo) return fail('That folder is inside another Git repository. Choose a folder that is not already part of one.');
    if (isRepo) {
      const origin = await git(v.dir, ['remote', 'get-url', 'origin']);
      if (origin.code === 0 && origin.out) return fail(`That folder is already connected to ${origin.out}. Use it from the Projects tab instead.`);
    } else {
      let r = await git(v.dir, ['init', '-b', 'main']);
      if (r.code !== 0) { r = await git(v.dir, ['init']); if (r.code === 0) await git(v.dir, ['symbolic-ref', 'HEAD', 'refs/heads/main']); }
      if (r.code !== 0) return fail('Could not set up Git in that folder. ' + r.err);
      job.log('Set up Git in the folder.');
    }

    if (!fs.existsSync(path.join(v.dir, '.gitignore')) && !isEmptyDir(v.dir)) { fs.writeFileSync(path.join(v.dir, '.gitignore'), GITIGNORE); job.log('Added a .gitignore so dependencies, build folders and .env files stay out.'); }
    if (isEmptyDir(v.dir)) { fs.writeFileSync(path.join(v.dir, 'README.md'), `# ${v.name}\n${v.description ? `\n${v.description}\n` : ''}`); job.log('Added a README.md so the repository is not empty.'); }

    const hasCommit = (await git(v.dir, ['rev-parse', '--verify', 'HEAD'])).code === 0;
    if (!hasCommit) {
      const add = await git(v.dir, ['add', '-A']);
      if (add.code !== 0) return fail('Could not stage the files. ' + add.err);
      const listed = await git(v.dir, ['ls-files', '-z']);
      const files = listed.out.split('\0').filter(Boolean);
      if (!files.length) return fail('Every file in that folder is ignored, so there is nothing to upload.');
      const big = files.map(f => { try { return { f, size: fs.statSync(path.join(v.dir, f)).size }; } catch { return null; } }).filter(x => x && x.size > MAX_FILE);
      if (big.length) { await git(v.dir, ['reset', '-q']); return fail(`GitHub does not accept files over 100 MB: ${big.slice(0, 5).map(x => `${x.f} (${fmtSize(x.size)})`).join(', ')}. Move or ignore ${big.length === 1 ? 'it' : 'them'} and try again.`); }
      job.log(`Committing ${files.length} file${files.length === 1 ? '' : 's'}.`);
      const c = await git(v.dir, ['commit', '-m', 'Initial commit']);
      if (c.code !== 0) return fail(/user\.(name|email)|identity|tell me who you are/i.test(c.err) ? 'Git needs your name and email once: run  git config --global user.name "Your Name"  and  git config --global user.email "you@example.com"  then try again.' : 'Could not commit. ' + (c.err || c.out));
    } else job.log('Using the commit history that is already in the folder.');
    if (cancelled) return job.finish('cancelled', 'Cancelled.');

    const args = ['repo', 'create', full, `--${v.visibility}`, '--source', v.dir, '--remote', 'origin', '--push'];
    if (v.description) args.push('--description', v.description);
    const r = await gh(args, { cwd: v.dir, onLine: jobLineHandler(job), onSpawn });
    if (cancelled) return job.finish('cancelled', 'Cancelled.');
    if (r.code !== 0) {
      const why = /already exists|Name already/i.test(r.err) ? ` A repository named "${v.name}" already exists on your account. Pick another name.` : authHint(r.err) || (/gh auth login|GH_TOKEN|not authenticated|authentication required/i.test(r.err) ? ' You are signed out of GitHub. Click "Sign in to GitHub" at the top and try again.' : '') || (/Could not find "gh"|ENOENT/.test(r.err) ? ' The GitHub CLI (gh) is needed to create repositories. Install it with: winget install GitHub.cli' : '');
      return fail('GitHub could not create the repository.' + why, { exitCode: r.code });
    }
    const info = await repo.repoInfo(v.dir);
    const web = webUrlFromRemote(info && info.url);
    const project = repo.upsertProject({ name: v.name, url: info && info.url || '', localPath: v.dir, branch: info ? info.branch : 'main' });
    job.finish('success', `Created ${full} and saved it to your projects.`, { exitCode: 0, link: web, linkLabel: web ? 'Open on GitHub' : undefined, projectId: project.id });
  })().catch(e => job.finish('error', e.message));
  return job.id;
}

module.exports = { startCreate, validate, GITIGNORE };
