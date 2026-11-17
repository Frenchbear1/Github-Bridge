'use strict';
/* Streamline front end. All dynamic text is inserted with textContent (never innerHTML). */
const $ = id => document.getElementById(id);
const state = { settings: null, projects: [], defaults: [], auth: null, platform: '', syncScriptFound: false };
const jobs = new Map();          // id -> { meta, lines, open, loaded }
let items = [];                  // upload selection
let lastPreview = null;
let previewTimer = null;
let previewSeq = 0;

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'X-Streamline': '1', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  let data = {};
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function notice(el, msg, kind) {
  el.className = 'notice ' + (kind || '');
  el.textContent = msg || '';
  if (!msg) el.classList.add('hidden');
}

function fmtSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}

function ago(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return Math.floor(s) + 's ago';
  if (s < 3600) return Math.floor(s / 60) + ' min ago';
  if (s < 86400) return Math.floor(s / 3600) + ' h ago';
  return new Date(iso).toLocaleDateString();
}

/* ---------- tabs ---------- */
function showTab(name) {
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('hidden', p.id !== 'panel-' + name));
  try { localStorage.setItem('sl.tab', name); } catch { /* ignore */ }
}
$('tabs').addEventListener('click', e => { const t = e.target.closest('button[data-tab]'); if (t) showTab(t.dataset.tab); });

/* ---------- state ---------- */
async function loadState() {
  const s = await api('GET', '/api/state');
  Object.assign(state, s);
  renderAuth(); renderProjects(); renderUploadRepos(); renderSettings(); renderClone(); renderSyncBtn();
}

function renderAuth() {
  const box = $('auth');
  box.replaceChildren();
  const a = state.auth || {};
  if (!state.git || !state.git.found) box.append(h('span', { class: 'chip-auth' }, h('span', { class: 'dot off' }), 'Git not found'));
  else if (!a.ghFound) box.append(h('span', { class: 'chip-auth', title: 'Install the GitHub CLI (gh) to sign in from Streamline.' }, h('span', { class: 'dot off' }), 'GitHub CLI not found'));
  else if (a.signedIn) box.append(h('span', { class: 'chip-auth' }, h('span', { class: 'dot' }), a.user ? `Signed in as ${a.user}` : 'Signed in'));
  else box.append(h('button', { class: 'btn', onclick: signIn }, 'Sign in to GitHub'));
}

async function signIn() {
  try { const r = await api('POST', '/api/auth/login'); focusJob(r.jobId); }
  catch (e) { alert(e.message); }
}

function renderSyncBtn() {
  const running = [...jobs.values()].some(j => j.meta.type === 'sync' && j.meta.status === 'running');
  const b = $('syncBtn');
  b.disabled = running;
  b.textContent = running ? 'Updating…' : 'Update Local GitHub';
  b.title = state.syncScriptFound ? 'Runs your Sync-GitHubProjects.ps1 in the background' : 'Sync script not found. Set it in Settings.';
}

$('syncBtn').addEventListener('click', async () => {
  try { const r = await api('POST', '/api/sync'); focusJob(r.jobId); }
  catch (e) { showTab('settings'); notice($('sNotice'), e.message, 'err'); }
});

/* ---------- projects ---------- */
function renderProjects() {
  const q = $('projSearch').value.trim().toLowerCase();
  const list = $('projList');
  list.replaceChildren();
  const shown = state.projects
    .filter(p => !q || p.name.toLowerCase().includes(q) || p.localPath.toLowerCase().includes(q))
    .sort((a, b) => (b.lastUsed || '').localeCompare(a.lastUsed || '') || a.name.localeCompare(b.name));
  if (!shown.length) {
    list.append(h('div', { class: 'empty' }, state.projects.length ? 'No projects match.' : 'No saved projects yet. Clone a repository, or import the ones already in your projects folder.'));
    return;
  }
  for (const p of shown) {
    let confirming = false;
    const rm = h('button', { class: 'btn small ghost danger', title: 'Forget this project (files stay on disk)' }, 'Remove');
    rm.addEventListener('click', async () => {
      if (!confirming) { confirming = true; rm.textContent = 'Sure?'; setTimeout(() => { confirming = false; rm.textContent = 'Remove'; }, 3000); return; }
      await api('DELETE', '/api/projects/' + p.id); await loadState();
    });
    list.append(h('div', { class: 'item' },
      h('div', { class: 'grow' },
        h('div', { class: 'name' }, p.name, h('span', { class: 'tag' }, p.branch), p.exists ? null : h('span', { class: 'tag bad' }, 'folder missing')),
        h('div', { class: 'path', title: p.localPath }, p.localPath)),
      h('div', { class: 'actions' },
        h('button', { class: 'btn small', onclick: () => { $('upRepo').value = p.id; showTab('upload'); schedulePreview(); } }, 'Upload'),
        h('button', { class: 'btn small', onclick: async () => { try { focusJob((await api('POST', `/api/projects/${p.id}/pull`)).jobId); } catch (e) { alert(e.message); } } }, 'Pull'),
        h('button', { class: 'btn small', onclick: () => api('POST', `/api/projects/${p.id}/open`).catch(e => alert(e.message)) }, 'Open'),
        rm)));
  }
}
$('projSearch').addEventListener('input', renderProjects);

async function pick(kind, start, title) {
  try { return (await api('POST', '/api/pick', { kind, start, title })).paths; }
  catch (e) { alert(e.message); return []; }
}

$('addFolderBtn').addEventListener('click', async () => {
  const [dir] = await pick('folder', (state.settings || {}).projectsRoot, 'Select a Git project folder');
  if (!dir) return;
  try { await api('POST', '/api/projects', { localPath: dir }); notice($('projMsg'), 'Project saved.', 'ok'); await loadState(); }
  catch (e) { notice($('projMsg'), e.message, 'err'); }
});

$('scanBtn').addEventListener('click', async () => {
  try {
    const r = await api('POST', '/api/projects/scan', { root: (state.settings || {}).projectsRoot });
    notice($('projMsg'), r.added ? `Imported ${r.added} project${r.added === 1 ? '' : 's'} from ${(state.settings || {}).projectsRoot}.` : 'No new Git projects found in that folder.', r.added ? 'ok' : '');
    await loadState();
  } catch (e) { notice($('projMsg'), e.message, 'err'); }
});

/* ---------- clone ---------- */
function repoNameFromUrl(u) {
  const m = u.trim().match(/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/);
  return m ? m[1] : '';
}
function renderClone() {
  if (!$('clParent').value) $('clParent').value = state.settings.projectsRoot || '';
  updateCloneDest();
}
function updateCloneDest() {
  const name = repoNameFromUrl($('clUrl').value);
  const parent = $('clParent').value.replace(/[\\/]+$/, '');
  $('clDest').textContent = name && parent ? `Will create: ${parent}${state.platform === 'win32' ? '\\' : '/'}${name}` : '';
}
$('clUrl').addEventListener('input', updateCloneDest);
$('clParent').addEventListener('input', updateCloneDest);
$('clBrowse').addEventListener('click', async () => { const [d] = await pick('folder', $('clParent').value, 'Clone into which folder?'); if (d) { $('clParent').value = d; updateCloneDest(); } });
$('clBtn').addEventListener('click', async () => {
  notice($('clNotice'), '');
  try {
    const r = await api('POST', '/api/clone', { url: $('clUrl').value, parent: $('clParent').value });
    $('clUrl').value = ''; updateCloneDest(); focusJob(r.jobId);
  } catch (e) { notice($('clNotice'), e.message, 'err'); }
});
$('clUrl').addEventListener('keydown', e => { if (e.key === 'Enter') $('clBtn').click(); });

/* ---------- upload ---------- */
function renderUploadRepos() {
  const sel = $('upRepo');
  const prev = sel.value || (() => { try { return localStorage.getItem('sl.repo'); } catch { return ''; } })();
  sel.replaceChildren(h('option', { value: '' }, state.projects.length ? 'Choose a saved repository…' : 'No saved repositories yet'));
  for (const p of [...state.projects].sort((a, b) => a.name.localeCompare(b.name))) sel.append(h('option', { value: p.id }, p.name));
  if ([...sel.options].some(o => o.value === prev)) sel.value = prev;
}
$('upRepo').addEventListener('change', () => { try { localStorage.setItem('sl.repo', $('upRepo').value); } catch { /* ignore */ } schedulePreview(); });
$('upSub').addEventListener('input', schedulePreview);

function renderItems() {
  const box = $('upItems');
  box.replaceChildren(...items.map((p, i) => h('div', { class: 'chip' }, h('span', { title: p }, p), h('button', { title: 'Remove', onclick: () => { items.splice(i, 1); renderItems(); schedulePreview(); } }, '×'))));
}
function addItems(paths) {
  for (const p of paths) { const t = p.trim().replace(/^"|"$/g, ''); if (t && !items.includes(t)) items.push(t); }
  renderItems(); schedulePreview();
}
$('addFilesBtn').addEventListener('click', async () => addItems(await pick('files', '', 'Select files to upload')));
$('addDirBtn').addEventListener('click', async () => addItems(await pick('folder', '', 'Select a folder to upload')));
$('upPath').addEventListener('keydown', e => { if (e.key === 'Enter' && $('upPath').value.trim()) { addItems([$('upPath').value]); $('upPath').value = ''; } });

function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(runPreview, 350);
}

async function runPreview() {
  const box = $('upPreview');
  lastPreview = null;
  $('upBtn').disabled = true;
  notice($('upNotice'), '');
  if (!$('upRepo').value || !items.length) { box.classList.add('hidden'); return; }
  const seq = ++previewSeq;
  box.classList.remove('hidden');
  box.replaceChildren(h('span', { class: 'spin' }), ' Checking what would change…');
  try {
    const p = await api('POST', '/api/upload/preview', { projectId: $('upRepo').value, items, subfolder: $('upSub').value });
    if (seq !== previewSeq) return;
    lastPreview = p;
    renderPreview(p);
    $('upBtn').disabled = p.counts.new + p.counts.modified === 0;
  } catch (e) {
    if (seq !== previewSeq) return;
    box.classList.add('hidden');
    notice($('upNotice'), e.message, 'err');
  }
}

function renderPreview(p) {
  const box = $('upPreview');
  box.replaceChildren();
  box.append(h('div', { class: 'sumline' },
    h('span', { class: 'n' }, `${p.counts.new} new`),
    h('span', { class: 'm' }, `${p.counts.modified} modified`),
    h('span', { class: 'u' }, `${p.counts.unchanged} unchanged`),
    h('span', { class: 'x' }, `${p.excludedCount} excluded`),
    h('span', { class: 'u' }, p.bytesText + ' to upload'),
    h('span', { class: 'u' }, `→ ${p.branch}`)));
  for (const w of p.warnings) box.append(h('div', { class: 'notice warn' }, w));
  if (p.files.length) {
    box.append(h('div', { class: 'files' }, p.files.map(f => h('div', {}, h('span', { class: 'st ' + f.status }, f.status), h('span', { class: 'pth', title: f.path }, f.path), h('span', { class: 'sz' }, fmtSize(f.size))))));
    if (p.filesTruncated) box.append(h('div', { class: 'hint' }, 'List truncated; all files will still be processed.'));
  }
  if (p.excludedCount) box.append(h('details', { class: 'more' }, h('summary', {}, `${p.excludedCount} excluded by smart/custom exclusions`), h('pre', {}, p.excludedSamples.join('\n') + (p.excludedCount > p.excludedSamples.length ? '\n…' : ''))));
  if (p.ignoredCount) box.append(h('details', { class: 'more' }, h('summary', {}, `${p.ignoredCount} skipped because the repo's .gitignore ignores them`), h('pre', {}, p.ignoredSamples.join('\n'))));
  if (p.tooLarge.length) box.append(h('details', { class: 'more' }, h('summary', {}, `${p.tooLarge.length} too large`), h('pre', {}, p.tooLarge.map(f => `${f.rel} (${fmtSize(f.size)})`).join('\n'))));
}

$('upBtn').addEventListener('click', async () => {
  $('upBtn').disabled = true;
  try {
    const r = await api('POST', '/api/upload', { projectId: $('upRepo').value, items, subfolder: $('upSub').value, message: $('upMsg').value });
    $('upMsg').value = ''; focusJob(r.jobId);
  } catch (e) { notice($('upNotice'), e.message, 'err'); $('upBtn').disabled = false; }
});

/* ---------- settings ---------- */
function renderSettings() {
  const s = state.settings;
  $('sSync').value = s.syncScript || '';
  $('sRoot').value = s.projectsRoot || '';
  $('sMax').value = s.maxFileMB;
  $('sCustom').value = (s.customExclusions || []).join('\n');
  $('sSyncState').textContent = state.syncScriptFound ? 'Script found.' : 'Script not found at this location.';
  const box = $('sDefaults');
  box.replaceChildren(...state.defaults.map(d => {
    const cb = h('input', { type: 'checkbox', 'data-id': d.id });
    cb.checked = d.locked || !(s.disabledDefaults || []).includes(d.id);
    cb.disabled = d.locked;
    return h('label', { title: d.why }, cb, h('span', {}, d.glob), h('small', {}, d.why));
  }));
}
$('sSyncBrowse').addEventListener('click', async () => { const [f] = await pick('files', '', 'Select Sync-GitHubProjects.ps1'); if (f) $('sSync').value = f; });
$('sRootBrowse').addEventListener('click', async () => { const [d] = await pick('folder', $('sRoot').value, 'Select your GitHub Projects folder'); if (d) $('sRoot').value = d; });
$('sSave').addEventListener('click', async () => {
  const disabled = [...document.querySelectorAll('#sDefaults input')].filter(c => !c.checked && !c.disabled).map(c => c.dataset.id);
  try {
    await api('PUT', '/api/settings', {
      syncScript: $('sSync').value, projectsRoot: $('sRoot').value, maxFileMB: Number($('sMax').value),
      customExclusions: $('sCustom').value.split('\n'), disabledDefaults: disabled
    });
    await loadState();
    notice($('sNotice'), 'Settings saved.', 'ok');
    schedulePreview();
  } catch (e) { notice($('sNotice'), e.message, 'err'); }
});

/* ---------- activity ---------- */
function upsertJob(meta) {
  let j = jobs.get(meta.id);
  if (!j) {
    j = { meta, lines: [], open: meta.status === 'running', loaded: false };
    jobs.set(meta.id, j);
  } else {
    const wasRunning = j.meta.status === 'running';
    j.meta = meta;
    if (wasRunning && meta.status !== 'running') {
      j.open = meta.status === 'error' || meta.status === 'warning';
      onJobFinished(meta);
    }
  }
  if (j.open && !j.loaded) loadLines(j);
  renderJobs(); renderSyncBtn();
}

async function loadLines(j) {
  j.loaded = true;
  try { j.lines = (await api('GET', `/api/jobs/${j.meta.id}/lines`)).lines; } catch { /* ignore */ }
  renderJobs();
}

function onJobFinished(meta) {
  if (meta.type === 'clone' || meta.type === 'pull') loadState();
  if (meta.type === 'login') { api('GET', '/api/auth').then(a => { state.auth = a; renderAuth(); }); }
  if (meta.type === 'upload') schedulePreview();
}

function focusJob(id) {
  const j = jobs.get(id);
  if (j) { j.open = true; if (!j.loaded) loadLines(j); }
  renderJobs();
}

function renderJobs() {
  const box = $('jobs');
  const all = [...jobs.values()].sort((a, b) => b.meta.startedAt.localeCompare(a.meta.startedAt));
  if (!all.length) { box.replaceChildren(h('div', { class: 'empty' }, 'Nothing yet. Uploads, clones and updates will show up here.')); return; }
  box.replaceChildren(...all.map(j => {
    const m = j.meta;
    const running = m.status === 'running';
    const log = j.open ? h('div', { class: 'log' }, j.lines.length ? j.lines.map(l => h('div', { class: l.level === 'error' ? 'error' : '' }, l.text)) : '(no output)') : null;
    const el = h('div', { class: 'job ' + m.status },
      h('div', { class: 'job-top' }, h('span', { class: 'job-title' }, m.title), h('span', { class: 'job-time' }, running ? 'running…' : ago(m.finishedAt || m.startedAt))),
      m.summary ? h('div', { class: 'job-sum' }, m.summary) : null,
      running && m.progress ? h('div', { class: 'job-prog' }, h('span', { class: 'spin' }), m.progress) : (running ? h('div', { class: 'job-prog' }, h('span', { class: 'spin' }), 'Working…') : null),
      h('div', { class: 'job-actions' },
        running ? h('button', { class: 'btn small', onclick: () => api('POST', `/api/jobs/${m.id}/cancel`) }, 'Cancel') : null,
        h('button', { class: 'link-btn', onclick: () => { j.open = !j.open; if (j.open && !j.loaded) loadLines(j); renderJobs(); } }, j.open ? 'Hide output' : 'Show output'),
        m.link ? h('a', { href: m.link, target: '_blank', rel: 'noopener' }, 'View on GitHub') : null),
      log);
    const logEl = el.querySelector('.log');
    if (logEl) logEl.scrollTop = logEl.scrollHeight;
    return el;
  }));
}

$('clearBtn').addEventListener('click', async () => { await api('POST', '/api/jobs/clear'); });

function connectEvents() {
  const es = new EventSource('/api/events');
  es.addEventListener('job', e => upsertJob(JSON.parse(e.data)));
  es.addEventListener('line', e => {
    const { id, line } = JSON.parse(e.data);
    const j = jobs.get(id);
    if (!j || !j.loaded) return;
    j.lines.push(line);
    if (j.lines.length > 400) j.lines.shift();
    if (j.open) renderJobs();
  });
  es.addEventListener('cleared', () => { for (const [id, j] of jobs) if (j.meta.status !== 'running') jobs.delete(id); renderJobs(); });
  es.onerror = () => { /* the browser reconnects automatically */ };
}

/* ---------- start ---------- */
(async function init() {
  try { showTab(localStorage.getItem('sl.tab') || 'projects'); } catch { showTab('projects'); }
  try {
    await loadState();
    const { jobs: list } = await api('GET', '/api/jobs');
    for (const m of list) jobs.set(m.id, { meta: m, lines: [], open: m.status === 'running', loaded: false });
    for (const j of jobs.values()) if (j.open) loadLines(j);
    renderJobs(); renderSyncBtn();
    connectEvents();
  } catch (e) {
    document.body.prepend(h('div', { class: 'notice err' }, 'Cannot reach the Streamline server: ' + e.message));
  }
  setInterval(renderJobs, 30000);
})();
