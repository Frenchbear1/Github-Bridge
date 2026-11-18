'use strict';
/**
 * What each project has on GitHub besides its code: the website link you set on the repository,
 * its GitHub Pages address, and its releases (with downloadable files).
 * Fetched in bulk through the GitHub CLI sign-in and cached in links.json.
 *
 * Also remembers what the Play button should do per project: run it locally (default),
 * open the website / Pages, or download and run (or open) the latest release.
 */
const fs = require('fs');
const path = require('path');
const store = require('./store');
const jobs = require('./jobs');
const { gh, run, killTree } = require('./proc');
const { openUrl, openFolderWindow } = require('./open');
const { webUrlFromRemote, IS_WIN } = require('./util');

const STALE_MS = 60 * 60 * 1000;
const NAME_RE = /^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/;
let refreshing = null;

function slugFor(project) {
  const web = webUrlFromRemote(project.url || '');
  if (!web) return null;
  const slug = web.replace(/^https:\/\/github\.com\//i, '');
  return NAME_RE.test(slug) ? slug : null;
}

const httpUrl = u => (/^https?:\/\//i.test(String(u || '')) ? String(u) : '');

async function fetchBatch(batch) {
  const fields = batch.map(({ slug }, n) => {
    const [owner, name] = slug.split('/');
    return `r${n}:repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(name)}){homepageUrl url isPrivate description ` +
      'deployments(environments:["github-pages"],first:1,orderBy:{field:CREATED_AT,direction:DESC}){nodes{latestStatus{environmentUrl state}}} ' +
      'releases(first:6,orderBy:{field:CREATED_AT,direction:DESC}){totalCount nodes{name tagName url publishedAt isPrerelease isDraft releaseAssets(first:30){nodes{name downloadUrl size}}}}}';
  });
  const r = await gh(['api', 'graphql', '-f', 'query=query{' + fields.join(' ') + '}'], { timeoutMs: 120000 });
  let resp = null;
  try { resp = JSON.parse(r.out); } catch { /* handled below */ }
  if (!resp || !resp.data) throw new Error((r.err || r.out || 'GitHub did not answer.').split('\n')[0]);
  const out = {};
  batch.forEach(({ id, slug }, n) => {
    const repo = resp.data['r' + n];
    if (!repo) { out[id] = { slug, missing: true }; return; }
    const dep = (((repo.deployments || {}).nodes || [])[0] || {}).latestStatus || {};
    const releases = ((repo.releases || {}).nodes || []).filter(x => !x.isDraft).map(x => ({
      name: x.name || x.tagName, tag: x.tagName, url: httpUrl(x.url), published: x.publishedAt, pre: !!x.isPrerelease,
      assets: ((x.releaseAssets || {}).nodes || []).map(a => ({ name: a.name, url: httpUrl(a.downloadUrl), size: a.size }))
    }));
    out[id] = {
      slug,
      repo: httpUrl(repo.url),
      homepage: httpUrl(repo.homepageUrl),
      private: !!repo.isPrivate,
      description: String(repo.description || '').slice(0, 300),
      pages: dep.state === 'INACTIVE' ? '' : httpUrl(dep.environmentUrl),
      releases,
      releaseCount: (repo.releases || {}).totalCount || 0,
      releasesUrl: httpUrl(repo.url) ? repo.url + '/releases' : ''
    };
  });
  return out;
}

function cached() { return store.read('links.json', { at: null, byId: {} }); }

function refresh() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const list = store.getProjects().map(p => ({ id: p.id, slug: slugFor(p) })).filter(x => x.slug);
    const prev = cached();
    const byId = {};
    let error = null;
    for (let i = 0; i < list.length; i += 40) {
      try { Object.assign(byId, await fetchBatch(list.slice(i, i + 40))); }
      catch (e) {
        error = e.message;
        for (const x of list.slice(i, i + 40)) if (prev.byId[x.id]) byId[x.id] = prev.byId[x.id];
      }
    }
    const next = { at: new Date().toISOString(), byId, error };
    store.write('links.json', next);
    jobs.bus.emit('links', { at: next.at });
    return next;
  })().finally(() => { refreshing = null; });
  return refreshing;
}

// Returns what is known now; starts a refresh in the background when it is old (or asked for).
function status(force) {
  const c = cached();
  const stale = !c.at || Date.now() - new Date(c.at).getTime() > STALE_MS || store.getProjects().some(p => slugFor(p) && !c.byId[p.id]);
  if ((force || stale) && !refreshing) refresh().catch(() => {});
  return { ...c, targets: store.read('play-targets.json', {}), refreshing: !!refreshing };
}

/* ---------- what Play does ---------- */
const TARGETS = ['local', 'homepage', 'pages', 'release'];
function setTarget(projectId, target) {
  if (!TARGETS.includes(target)) throw new Error('Unknown Play choice.');
  const all = store.read('play-targets.json', {});
  all[projectId] = target;
  store.write('play-targets.json', all);
  return all;
}
// Until you choose, a project with a website opens the website; otherwise it runs on this computer.
function defaultTarget(info) { return info && info.homepage ? 'homepage' : info && info.pages ? 'pages' : 'local'; }
const targetOf = projectId => store.read('play-targets.json', {})[projectId] || defaultTarget(cached().byId[projectId]);
const infoOf = projectId => cached().byId[projectId] || null;

// A file in a release that can be run or installed on this computer.
function runnableAsset(release) {
  const assets = (release && release.assets) || [];
  const score = a => {
    const n = a.name.toLowerCase();
    if (!IS_WIN) return /\.(appimage|sh)$/.test(n) ? 2 : 0;
    if (!/\.(exe|msi|zip)$/.test(n)) return 0;
    let s = n.endsWith('.exe') ? 30 : n.endsWith('.msi') ? 20 : 10;
    if (/setup|install/.test(n)) s += 5;
    if (/portable/.test(n)) s += 3;
    if (/(arm64|aarch64|mac|darwin|linux)/.test(n)) s -= 25;
    if (/blockmap|\.sig$|sha256/.test(n)) s = 0;
    return s;
  };
  return assets.map(a => ({ a, s: score(a) })).filter(x => x.s > 0).sort((x, y) => y.s - x.s).map(x => x.a)[0] || null;
}

function latestRelease(info) { return info && (info.releases || []).find(r => !r.pre) || (info && (info.releases || [])[0]) || null; }

/**
 * Plays a project through one of its online targets. Returns a job id.
 * kind: 'homepage' | 'pages' | 'release' | 'release-page'
 */
function play(project, kind, launch) {
  const info = infoOf(project.id);
  if (!info) throw new Error('Streamline has not loaded this project\'s GitHub links yet. Try again in a moment.');
  if (kind === 'homepage' || kind === 'pages') {
    const url = info[kind];
    if (!url) throw new Error(kind === 'pages' ? 'This repository has no GitHub Pages site.' : 'This repository has no website link set on GitHub.');
    openUrl(url);
    const job = jobs.create('play', `Open ${project.name} online`);
    job.set({ projectId: project.id, link: url, linkLabel: 'Open ' + url.replace(/^https?:\/\//, '').replace(/\/$/, '') });
    job.finish('success', `Opened ${url}`);
    return job.id;
  }
  const rel = latestRelease(info);
  if (!rel) throw new Error('This repository has no releases.');
  if (kind === 'release-page') {
    openUrl(rel.url);
    const job = jobs.create('play', `Open ${project.name} ${rel.tag}`);
    job.set({ projectId: project.id, link: rel.url, linkLabel: 'Release page' });
    job.finish('success', `Opened the ${rel.tag} release page.`);
    return job.id;
  }
  const asset = runnableAsset(rel);
  if (!asset) { openUrl(rel.url); throw new Error(`Release ${rel.tag} has no file this computer can run, so its page was opened instead.`); }
  return runRelease(project, info, rel, asset, launch);
}

function runRelease(project, info, rel, asset, launch) {
  const job = jobs.create('play', `Run ${project.name} ${rel.tag}`);
  job.set({ projectId: project.id, kind: 'release', link: rel.url, linkLabel: 'Release page' });
  const safe = s => String(s).replace(/[^A-Za-z0-9._-]/g, '_');
  const dir = path.join(store.DATA_DIR, 'releases', safe(info.slug.replace('/', '__')), safe(rel.tag));
  const file = path.join(dir, path.basename(asset.name));
  (async () => {
    let cancelled = false;
    if (!fs.existsSync(file)) {
      fs.mkdirSync(dir, { recursive: true });
      job.log(`Downloading ${asset.name} from release ${rel.tag}…`);
      job.progress(`Downloading ${asset.name}…`);
      const tmp = path.join(dir, '.partial');
      fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp);
      const r = await gh(['release', 'download', rel.tag, '-R', info.slug, '-p', asset.name, '-D', tmp, '--clobber'], {
        timeoutMs: 30 * 60 * 1000, onSpawn: c => job.onCancel(() => { cancelled = true; killTree(c); })
      });
      if (cancelled) { fs.rmSync(tmp, { recursive: true, force: true }); return job.finish('cancelled', 'Download cancelled.'); }
      if (r.code !== 0 || !fs.existsSync(path.join(tmp, asset.name))) { fs.rmSync(tmp, { recursive: true, force: true }); return job.finish('error', 'Could not download the release file. ' + (r.err || '').split('\n')[0]); }
      fs.renameSync(path.join(tmp, asset.name), file);
      fs.rmSync(tmp, { recursive: true, force: true });
    } else job.log(`Using the copy downloaded earlier: ${file}`);
    const lower = asset.name.toLowerCase();
    if (lower.endsWith('.exe') || lower.endsWith('.appimage')) {
      if (!IS_WIN) try { fs.chmodSync(file, 0o755); } catch { /* best effort */ }
      return launch.runExe(project, file, job);
    }
    if (lower.endsWith('.zip')) {
      const out = path.join(dir, 'unzipped');
      if (!fs.existsSync(out)) {
        job.log('Unzipping…');
        const r = IS_WIN
          ? await run('tar.exe', ['-xf', file, '-C', (fs.mkdirSync(out, { recursive: true }), out)])
          : await run('unzip', ['-q', file, '-d', out]);
        if (r.code !== 0) return job.finish('error', 'Could not unzip the release file.');
      }
      const exes = [];
      const walk = (d, depth) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory() && depth < 3) walk(f, depth + 1); else if (/\.exe$/i.test(e.name) && !/unins|setup|crash|helper|update/i.test(e.name)) exes.push(f); } };
      walk(out, 0);
      if (exes.length === 1) return launch.runExe(project, exes[0], job);
      openFolderWindow(out);
      return job.finish('success', `Unzipped ${asset.name} and opened the folder.`);
    }
    openUrl(file); // .msi and anything else: let Windows open it
    job.finish('success', `Opened ${asset.name}.`);
  })().catch(e => job.finish('error', e.message));
  return job.id;
}

module.exports = { defaultTarget, status, refresh, setTarget, targetOf, infoOf, play, latestRelease, runnableAsset, slugFor };
