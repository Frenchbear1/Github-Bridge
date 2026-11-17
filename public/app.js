'use strict';
/* Streamline front end. All dynamic text is inserted with textContent (never innerHTML). */
const $ = id => document.getElementById(id);
const state = { settings: null, projects: [], defaults: [], auth: null, platform: '', plans: {} };
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
  try { state.plans = (await api('GET', '/api/play')).plans; } catch { state.plans = {}; }
  try { state.health = await api('GET', '/api/health'); } catch { state.health = { results: {}, counts: {}, at: null }; }
  renderAuth(); renderHealth(); renderProjects(); renderUploadRepos(); renderSettings(); renderClone(); renderSyncBtn();
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
  b.title = 'Check GitHub and bring every project up to date. Projects with local changes are never touched.';
  renderSyncBar();
}

// A slim status bar under the header: live progress while updating, then a plain-language result.
const syncDismissed = new Set();
function renderSyncBar() {
  const bar = $('syncBar');
  const syncs = [...jobs.values()].filter(j => j.meta.type === 'sync').sort((a, b) => b.meta.startedAt.localeCompare(a.meta.startedAt));
  const j = syncs[0];
  const m = j && j.meta;
  const fresh = m && (m.status === 'running' || (!syncDismissed.has(m.id) && Date.now() - new Date(m.finishedAt || m.startedAt).getTime() < 15 * 60 * 1000 && j.seenRunning));
  if (m && m.status === 'running') j.seenRunning = true;
  if (!fresh) { bar.classList.add('hidden'); bar.replaceChildren(); return; }
  bar.classList.remove('hidden');
  const s = m.sync || {};
  const chip = (n, label, cls) => n ? h('span', { class: 'chip ' + cls }, `${n} ${label}`) : null;
  if (m.status === 'running') {
    const pct = s.total ? Math.round((s.done / s.total) * 100) : 0;
    bar.className = 'syncbar running';
    bar.replaceChildren(
      h('div', { class: 'sb-top' },
        h('span', { class: 'spin' }),
        h('strong', {}, s.total && s.done ? `Updating projects: ${s.done} of ${s.total}` : (s.phase || 'Starting') + '…'),
        h('span', { class: 'sb-chips' }, chip(s.updated, 'updated', 'ok'), chip(s.cloned, 'downloaded', 'ok'), chip(s.paused, 'paused', 'warn'), chip(s.errors, s.errors === 1 ? 'error' : 'errors', 'err')),
        h('button', { class: 'btn small', onclick: () => api('POST', `/api/jobs/${m.id}/cancel`) }, 'Cancel')),
      h('div', { class: 'sb-track' + (s.total ? '' : ' indet') }, h('div', { class: 'sb-fill', style: `width:${pct}%` })));
    return;
  }
  const rs = m.results || [];
  const group = (state, title, cls) => {
    const items = rs.filter(r => r.state === state);
    if (!items.length) return null;
    // Good news is a compact list of names; things that need you get one line each with the reason.
    const body = (state === 'Paused' || state === 'Error')
      ? items.map(r => h('div', { class: 'sb-row' }, h('span', { class: 'sb-name' }, r.name), h('span', { class: 'sb-why' }, r.detail)))
      : [h('div', { class: 'sb-names' }, items.map(r => h('span', { class: 'sb-pill' }, r.name)))];
    return h('div', { class: 'sb-group ' + cls }, h('div', { class: 'sb-gtitle' }, `${title} (${items.length})`), ...body);
  };
  const detailed = rs.some(r => ['Updated', 'Cloned', 'Paused', 'Error'].includes(r.state));
  bar.className = 'syncbar done ' + m.status;
  bar.replaceChildren(
    h('div', { class: 'sb-top' },
      h('strong', {}, m.status === 'cancelled' ? 'Update cancelled' : m.status === 'error' ? 'Update failed' : (m.status === 'warning' ? 'Update finished with problems' : ((s.paused || s.updated || s.cloned) ? 'Update finished' : 'Everything is up to date'))),
      h('span', { class: 'sb-sum' }, m.summary),
      h('button', { class: 'btn small ghost', title: 'Dismiss', onclick: () => { syncDismissed.add(m.id); renderSyncBar(); } }, '\u2715')),
    detailed ? h('div', { class: 'sb-groups' }, group('Error', 'Could not update', 'err'), group('Paused', 'Paused to protect your work', 'warn'), group('Updated', 'Updated', 'ok'), group('Cloned', 'Downloaded', 'ok')) : null);
}

$('syncBtn').addEventListener('click', async () => {
  try { const r = await api('POST', '/api/sync'); focusJob(r.jobId); }
  catch (e) { showTab('settings'); notice($('sNotice'), e.message, 'err'); }
});

/* ---------- projects ---------- */
function playingJob(projectId) {
  return [...jobs.values()].map(j => j.meta).find(m => m.type === 'play' && (m.status === 'running' || m.live) && m.projectId === projectId) || null;
}

const sortFn = mode => mode === 'name' ? (a, b) => a.name.localeCompare(b.name)
  : mode === 'used' ? (a, b) => (b.lastUsed || '').localeCompare(a.lastUsed || '') || a.name.localeCompare(b.name)
  : (a, b) => (b.modified || 0) - (a.modified || 0) || a.name.localeCompare(b.name);
try { $('projSort').value = localStorage.getItem('sl.sort') || 'changed'; } catch { /* default */ }
if (!$('projSort').value) $('projSort').value = 'changed';
$('projSort').addEventListener('change', () => { try { localStorage.setItem('sl.sort', $('projSort').value); } catch { /* ignore */ } renderProjects(); });

// the ⋯ menu closes when you pick something or click elsewhere
document.addEventListener('click', e => { const m = $('projMenu'); if (m.open && (!m.contains(e.target) || e.target.closest('.menu-pop button'))) m.open = false; });

const openProblems = new Set();

function renderProjects() {
  const q = $('projSearch').value.trim().toLowerCase();
  const list = $('projList');
  list.replaceChildren();
  const shown = state.projects
    .filter(p => !q || p.name.toLowerCase().includes(q) || p.localPath.toLowerCase().includes(q))
    .sort(sortFn($('projSort').value));
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
    const plan = state.plans[p.id];
    const run = playingJob(p.id);
    const hr = ((state.health || {}).results || {})[p.id];
    let playBtn = null;
    if (run) {
      playBtn = h('button', { class: 'btn small danger-fill', title: 'Stop this project', onclick: () => api('POST', `/api/projects/${p.id}/stop`).catch(e => alert(e.message)) }, '\u25A0 Stop');
    } else if (plan && plan.canPlay && !(hr && hr.status === 'fail')) {
      playBtn = h('span', { class: 'btnpair' },
        h('button', { class: 'btn small play', title: `${plan.label}: ${plan.detail}`, onclick: async () => { try { focusJob((await api('POST', `/api/projects/${p.id}/play`)).jobId); } catch (e) { alert(e.message); } } }, '\u25B6 Play'),
        plan.stopFile ? h('button', { class: 'btn small ghost', title: `Runs ${plan.stopFile}`, onclick: () => api('POST', `/api/projects/${p.id}/stop`).catch(e => alert(e.message)) }, 'Stop') : null);
    }
    const open = openProblems.has(p.id);
    const hTag = hr && !run ? h('span', { class: 'tag ' + (hr.ignored ? 'ignored' : hr.status), title: hr.note || hr.problem || '', onclick: () => { if (hr.status === 'fail' || hr.status === 'warn') { open ? openProblems.delete(p.id) : openProblems.add(p.id); renderProjects(); } } },
      (hr.ignored ? 'ignored' : { ok: '\u2713 works', fail: '\u2717 failed', warn: '? unsure', skip: 'not tested' }[hr.status]) || hr.status) : null;
    const problem = hr && open && (hr.status === 'fail' || hr.status === 'warn')
      ? h('div', { class: 'problem' },
        h('div', { class: 'pbody' }, h('div', {}, hr.problem), (hr.output || []).length ? h('pre', {}, hr.output.join('\n')) : null),
        h('div', { class: 'pbtns' },
          h('button', { class: 'btn small primary', title: 'Builds a ChatGPT prompt that includes this error', onclick: () => openPlayDialog(p, { problem: hr.problem, output: hr.output || [] }) }, 'Fix with ChatGPT\u2026'),
          h('button', { class: 'btn small', title: hr.ignored ? 'Count this failure again' : 'Hide this failure from the banner and the ChatGPT prompt', onclick: async () => { try { state.health = await api('POST', '/api/health/ignore', { id: p.id, ignored: !hr.ignored }); renderHealth(); renderProjects(); } catch (e) { alert(e.message); } } }, hr.ignored ? 'Stop ignoring' : 'Ignore'))) : null;
    const how = plan ? [plan.label, plan.detail].filter(Boolean).join(' \u00B7 ') : '';
    list.append(h('div', { class: 'item' },
      h('div', { class: 'grow' },
        h('div', { class: 'name' }, p.name, h('span', { class: 'tag' }, p.branch), p.exists ? null : h('span', { class: 'tag bad' }, 'folder missing'), run ? h('span', { class: 'tag live' }, 'running') : null, plan && plan.source === 'custom' ? h('span', { class: 'tag custom' }, 'custom') : null, hTag),
        plan && plan.canPlay ? h('div', { class: 'how', title: (plan.notes || []).join(' ') }, how, h('button', { class: 'linkish', title: 'Not right? Set it up differently', onclick: () => openPlayDialog(p) }, 'Change\u2026')) : null,
        h('div', { class: 'path', title: p.localPath }, p.localPath)),
      h('div', { class: 'actions' },
        // row 1: run it and look at it. row 2: sync with GitHub, then remove
        h('div', { class: 'arow' },
          playBtn,
          run && run.link ? h('a', { class: 'btn small', href: run.link, target: '_blank', rel: 'noopener' }, 'Open') : null,
          h('button', { class: 'btn small', title: 'Open in File Explorer, the GitHub page, VS Code, Notepad and other installed programs', onclick: () => openWith(p) }, 'Open in\u2026')),
        h('div', { class: 'arow' },
          h('button', { class: 'btn small', title: 'Download the latest changes from GitHub', onclick: async () => { try { focusJob((await api('POST', `/api/projects/${p.id}/pull`)).jobId); } catch (e) { alert(e.message); } } }, '\u2193 Pull'),
          h('button', { class: 'btn small', title: 'Send your changes to GitHub', onclick: () => { $('upRepo').value = p.id; showTab('upload'); schedulePreview(); } }, '\u2191 Upload'),
          rm)),
      problem));
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


/* ---------- Set up Play (ChatGPT fallback) ---------- */
const dlg = { project: null, timer: null, seq: 0 };

async function openPlayDialog(p, failure) {
  dlg.project = p;
  const plan = state.plans[p.id] || {};
  $('dlgTitle').textContent = `Set up Play: ${p.name}`;
  $('dlgWhy').textContent = failure
    ? `Play failed (${failure.problem || 'it exited with an error'}). The prompt below includes the error, so ChatGPT can work out what to change. Paste its reply back here and Streamline applies it.`
    : plan.canPlay
    ? `Streamline will currently run this as "${plan.label}" (${plan.detail}). If that is not what you want, replace it with a setup from ChatGPT.`
    : `Streamline could not tell how to run this project${plan.detail ? ` (${plan.detail})` : ''}. ChatGPT can work it out from the project's files, and you paste its answer back here.`;
  $('dlgReply').value = ''; $('dlgResult').replaceChildren(); $('dlgCopied').textContent = '';
  $('dlgSave').disabled = true; $('dlgSaveRun').disabled = true;
  $('dlgReset').classList.toggle('hidden', !(plan.source === 'custom'));
  $('dlgPrompt').value = 'Preparing…'; $('dlgChars').textContent = '';
  if (!$('playDlg').open) $('playDlg').showModal();
  try {
    const r = failure ? await api('POST', `/api/projects/${p.id}/prompt`, { failure }) : await api('GET', `/api/projects/${p.id}/prompt`);
    $('dlgPrompt').value = r.prompt;
    $('dlgChars').textContent = `(${r.chars.toLocaleString()} characters, ${r.included.length} files)`;
  } catch (e) { $('dlgPrompt').value = ''; $('dlgResult').replaceChildren(h('div', { class: 'notice err' }, e.message)); }
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall back below */ }
  const ta = $('dlgPrompt');
  ta.select();
  try { return document.execCommand('copy'); } catch { return false; }
}

$('dlgCopy').addEventListener('click', async () => {
  const ok = await copyText($('dlgPrompt').value);
  $('dlgCopied').textContent = ok ? 'Copied. Paste it into ChatGPT, then paste its reply below.' : 'Could not copy automatically. Open "See exactly what gets copied" and copy the text yourself.';
});
$('dlgClose').addEventListener('click', () => $('playDlg').close());

let dlgOk = false;
function renderDlgResult(r) {
  const box = $('dlgResult');
  box.replaceChildren();
  dlgOk = !!r.ok;
  $('dlgSave').disabled = !r.ok; $('dlgSaveRun').disabled = !r.ok;
  if (r.cannotRun) {
    box.append(h('div', { class: 'notice warn' }, 'ChatGPT could not work it out: ' + r.cannotRun),
      r.questions && r.questions.length ? h('div', { class: 'hint' }, 'It needs to know: ' + r.questions.join(' • ') + '. Answer in the same ChatGPT chat, then paste its new reply here.') : null);
    return;
  }
  for (const e of r.errors || []) box.append(h('div', { class: 'notice err' }, e));
  for (const w of r.warnings || []) box.append(h('div', { class: 'notice warn' }, w));
  if (!r.ok) return;
  const c = r.config;
  const rev = h('div', { class: 'review' }, h('h4', {}, 'Review: this is exactly what Play will do'));
  if (c.kind === 'command') {
    if (c.needs.length) rev.append(h('div', {}, 'Needs installed: ', c.needs.map(n => n.exe).join(', ')));
    const steps = [...c.setup.map(s => `${s.cwd ? `[in ${s.cwd}] ` : ''}${s.cmd}${s.skipIfExists ? `   (first time only: skipped once ${s.skipIfExists} exists)` : ''}`), `${c.run.cwd ? `[in ${c.run.cwd}] ` : ''}${c.run.cmd}`];
    rev.append(h('ol', {}, steps.map(t => h('li', {}, h('code', {}, t)))));
    if (c.openUrl) rev.append(h('div', {}, 'Then opens ', h('code', {}, c.openUrl)));
    if (Object.keys(c.run.env || {}).length) rev.append(h('div', {}, 'With: ', h('code', {}, Object.entries(c.run.env).map(([k, v]) => `${k}=${v}`).join(' '))));
  } else if (c.kind === 'open-file') rev.append(h('div', {}, 'Opens ', h('code', {}, c.file), r.summary && r.summary.action === 'serve' ? ' through a local server (it needs one).' : ' in your browser.'));
  else rev.append(h('div', {}, 'Starts ', h('code', {}, c.file)));
  if (c.notes) rev.append(h('div', { class: 'hint' }, c.notes));
  if (r.bat) rev.append(h('details', { class: 'more' }, h('summary', {}, 'Show the launcher file this creates'), h('pre', {}, r.bat)));
  box.append(rev);
}

async function checkReply() {
  const text = $('dlgReply').value;
  const seq = ++dlg.seq;
  if (!text.trim()) { $('dlgResult').replaceChildren(); $('dlgSave').disabled = true; $('dlgSaveRun').disabled = true; return; }
  try {
    const r = await api('POST', `/api/projects/${dlg.project.id}/custom/check`, { reply: text });
    if (seq === dlg.seq) renderDlgResult(r);
  } catch (e) { if (seq === dlg.seq) renderDlgResult({ ok: false, errors: [e.message] }); }
}
$('dlgReply').addEventListener('input', () => { clearTimeout(dlg.timer); dlg.timer = setTimeout(checkReply, 400); });

async function saveCustom(runAfter) {
  try {
    const r = await api('POST', `/api/projects/${dlg.project.id}/custom/save`, { reply: $('dlgReply').value });
    if (!r.ok) return renderDlgResult(r);
    $('playDlg').close();
    await loadState();
    if (runAfter) focusJob((await api('POST', `/api/projects/${dlg.project.id}/play`)).jobId);
  } catch (e) { renderDlgResult({ ok: false, errors: [e.message] }); }
}
$('dlgSave').addEventListener('click', () => saveCustom(false));
$('dlgSaveRun').addEventListener('click', () => saveCustom(true));
$('dlgReset').addEventListener('click', async () => {
  await api('DELETE', `/api/projects/${dlg.project.id}/custom`);
  $('playDlg').close(); await loadState();
});


/* ---------- open in editor ---------- */
async function openWith(p) {
  $('openTitle').textContent = `Open ${p.name} in\u2026`;
  const list = $('openList'); list.replaceChildren(); $('openMsg').classList.add('hidden');
  list.append(h('div', { class: 'hint' }, 'Looking for installed programs\u2026'));
  if (!$('openDlg').open) $('openDlg').showModal();
  let eds = [];
  try { eds = (await api('GET', '/api/editors')).editors; } catch { /* folder still works */ }
  list.replaceChildren();
  const go = async (editor, label) => {
    try { await api('POST', `/api/projects/${p.id}/open`, editor ? { editor } : {}); $('openDlg').close(); }
    catch (e) { notice($('openMsg'), `Could not open ${label}: ${e.message}`, 'err'); }
  };
  list.append(h('button', { class: 'btn', onclick: () => go(null, 'the folder') }, 'File Explorer', h('span', { class: 'sub' }, 'the project folder')));
  list.append(h('button', { class: 'btn', onclick: async () => {
    try { await api('POST', `/api/projects/${p.id}/open`, { github: true }); $('openDlg').close(); }
    catch (e) { notice($('openMsg'), e.message, 'err'); }
  } }, 'GitHub repository', h('span', { class: 'sub' }, 'opens it in your browser')));
  for (const e of eds) list.append(h('button', { class: 'btn', onclick: () => go(e.id, e.label) }, e.label,
    e.id === 'notepad' || e.id === 'notepadpp' ? h('span', { class: 'sub' }, 'opens the main file') : null));
}
$('openClose').addEventListener('click', () => $('openDlg').close());

/* ---------- health check ---------- */
function renderHealth() {
  const bar = $('healthBar');
  const hs = state.health || {};
  const c = hs.counts || {};
  const total = (c.ok || 0) + (c.fail || 0) + (c.warn || 0) + (c.skip || 0) + (c.ignored || 0);
  bar.replaceChildren();
  $('checkBtn').disabled = !!hs.running;
  $('checkBtn').textContent = hs.running ? 'Checking…' : (total ? 'Check again' : 'Check all projects');
  if (!total && !hs.running) return bar.classList.add('hidden');
  bar.classList.remove('hidden');
  const jj = [...jobs.values()].find(j => j.meta.type === 'check' && j.meta.status === 'running');
  const job = jj && jj.meta;
  bar.append(h('span', { class: 'grow' },
    hs.running ? `Checking projects${job && job.progress ? ': ' + job.progress : '…'}` : `Last check${hs.at ? ' ' + (new Date(hs.at).toDateString() === new Date().toDateString() ? new Date(hs.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : new Date(hs.at).toLocaleDateString()) : ''}: `,
    hs.running ? null : h('strong', {}, `${c.ok || 0} work`), hs.running ? null : `, ${c.fail || 0} failed`, !hs.running && c.warn ? `, ${c.warn} unsure` : null, !hs.running && c.skip ? `, ${c.skip} not tested` : null, !hs.running && c.ignored ? `, ${c.ignored} ignored` : null));
  if (!hs.running && ((c.fail || 0) + (c.warn || 0)) > 0) bar.append(h('button', { class: 'btn small primary', onclick: openFixDialog }, 'Fix failures with ChatGPT…'));
}

let healthTimer = null;
function refreshHealthSoon() {
  clearTimeout(healthTimer);
  healthTimer = setTimeout(async () => {
    try { state.health = await api('GET', '/api/health'); renderHealth(); renderProjects(); } catch { /* ignore */ }
  }, 400);
}

$('checkBtn').addEventListener('click', async () => {
  try {
    const r = await api('POST', '/api/health/run', {});
    state.health = { ...(state.health || {}), running: true }; renderHealth();
    focusJob(r.jobId);
  } catch (e) { notice($('projMsg'), e.message, 'err'); }
});

const fix = { seq: 0, timer: null };
async function openFixDialog() {
  $('fixReply').value = ''; $('fixResult').replaceChildren(); $('fixCopied').textContent = ''; $('fixSave').disabled = true;
  $('fixPrompt').value = 'Preparing…'; $('fixChars').textContent = ''; $('fixWhy').textContent = '';
  if (!$('fixDlg').open) $('fixDlg').showModal();
  try {
    const r = await api('GET', '/api/health/prompt');
    $('fixPrompt').value = r.prompt;
    $('fixChars').textContent = `(${r.chars.toLocaleString()} characters, ${r.projects.length} project${r.projects.length === 1 ? '' : 's'})`;
    $('fixWhy').textContent = r.left ? `${r.projects.length} projects are in this prompt. ${r.left} more failed. Apply this batch first, then use "Check again" and "Fix failures" for the rest.` : 'Streamline tried each project and these failed. ChatGPT works out what each one needs, and the app applies it and re-tests.';
  } catch (e) { $('fixPrompt').value = ''; $('fixResult').replaceChildren(h('div', { class: 'notice err' }, e.message)); }
}
$('fixClose').addEventListener('click', () => $('fixDlg').close());
$('fixCopy').addEventListener('click', async () => {
  let ok = false;
  try { await navigator.clipboard.writeText($('fixPrompt').value); ok = true; } catch { $('fixPrompt').select(); try { ok = document.execCommand('copy'); } catch { /* ignore */ } }
  $('fixCopied').textContent = ok ? 'Copied. Paste it into ChatGPT, then paste its reply below.' : 'Could not copy automatically. Open "See exactly what gets copied" and copy the text yourself.';
});

function renderFixResult(r) {
  const box = $('fixResult');
  box.replaceChildren();
  $('fixSave').disabled = !r.ok;
  for (const e of r.errors || []) box.append(h('div', { class: 'notice err' }, e));
  for (const it of r.items || []) {
    if (!it.ok) {
      box.append(h('div', { class: 'review' }, h('h4', {}, `${it.name}: not applied`),
        it.cannotRun ? h('div', {}, 'ChatGPT could not work it out: ' + it.cannotRun + (it.questions && it.questions.length ? ' It needs to know: ' + it.questions.join(' • ') : '')) : null,
        ...(it.errors || []).map(e => h('div', { class: 'notice err' }, e))));
      continue;
    }
    const c = it.config;
    const steps = c.kind === 'command'
      ? [...c.setup.map(s => `${s.cwd ? `[in ${s.cwd}] ` : ''}${s.cmd}`), `${c.run.cwd ? `[in ${c.run.cwd}] ` : ''}${c.run.cmd}`]
      : [c.kind === 'open-file' ? `Open ${c.file}` : `Start ${c.file}`];
    box.append(h('div', { class: 'review' }, h('h4', {}, `${it.name}: will be applied`),
      h('ol', {}, steps.map(t => h('li', {}, h('code', {}, t)))),
      c.openUrl ? h('div', {}, 'Then opens ', h('code', {}, c.openUrl)) : null,
      c.notes ? h('div', { class: 'hint' }, c.notes) : null,
      ...(it.warnings || []).map(w => h('div', { class: 'notice warn' }, w))));
  }
}
$('fixReply').addEventListener('input', () => {
  clearTimeout(fix.timer);
  fix.timer = setTimeout(async () => {
    const text = $('fixReply').value; const seq = ++fix.seq;
    if (!text.trim()) { $('fixResult').replaceChildren(); $('fixSave').disabled = true; return; }
    try { const r = await api('POST', '/api/health/fix/check', { reply: text }); if (seq === fix.seq) renderFixResult(r); }
    catch (e) { if (seq === fix.seq) renderFixResult({ ok: false, errors: [e.message], items: [] }); }
  }, 400);
});
$('fixSave').addEventListener('click', async () => {
  try {
    const r = await api('POST', '/api/health/fix/save', { reply: $('fixReply').value });
    if (!r.saved || !r.saved.length) return renderFixResult(r);
    $('fixDlg').close();
    await loadState();
    if (r.jobId) focusJob(r.jobId);
  } catch (e) { renderFixResult({ ok: false, errors: [e.message], items: [] }); }
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
  const sc = state.syncConfig || {};
  $('sOwner').value = s.syncOwner || '';
  $('sOwner').placeholder = sc.owner || (state.auth && state.auth.user) || 'signed-in account';
  $('sSkip').value = (sc.excluded || []).join('\n');
  $('sPar').value = sc.parallel || 8;
  $('sRoot').value = s.projectsRoot || '';
  $('sMax').value = s.maxFileMB;
  $('sCustom').value = (s.customExclusions || []).join('\n');
  const box = $('sDefaults');
  box.replaceChildren(...state.defaults.map(d => {
    const cb = h('input', { type: 'checkbox', 'data-id': d.id });
    cb.checked = d.locked || !(s.disabledDefaults || []).includes(d.id);
    cb.disabled = d.locked;
    return h('label', { title: d.why }, cb, h('span', {}, d.glob), h('small', {}, d.why));
  }));
}
$('sRootBrowse').addEventListener('click', async () => { const [d] = await pick('folder', $('sRoot').value, 'Select your GitHub Projects folder'); if (d) $('sRoot').value = d; });
$('sSave').addEventListener('click', async () => {
  const disabled = [...document.querySelectorAll('#sDefaults input')].filter(c => !c.checked && !c.disabled).map(c => c.dataset.id);
  try {
    await api('PUT', '/api/settings', {
      syncOwner: $('sOwner').value, syncExcluded: $('sSkip').value.split('\n').map(x => x.trim()).filter(Boolean), syncParallel: Number($('sPar').value) || 8, projectsRoot: $('sRoot').value, maxFileMB: Number($('sMax').value),
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
  if (meta.type === 'play') renderProjects();
  if (meta.type === 'check') { if (meta.status === 'running') { const hs = state.health || (state.health = {}); hs.running = true; renderHealth(); } refreshHealthSoon(); }
}

async function loadLines(j) {
  j.loaded = true;
  try { j.lines = (await api('GET', `/api/jobs/${j.meta.id}/lines`)).lines; } catch { /* ignore */ }
  renderJobs();
}

async function autoFixAfterFailure(meta) {
  const p = state.projects.find(x => x.id === meta.projectId);
  if (!p || $('playDlg').open || $('fixDlg').open) return;
  let out = [];
  try { out = (await api('GET', `/api/jobs/${meta.id}/lines`)).lines.map(l => l.text); } catch { /* still useful without it */ }
  openPlayDialog(p, { problem: meta.summary, output: out.slice(-25) });
}

function onJobFinished(meta) {
  if (meta.type === 'play' && meta.status === 'error' && meta.projectId) autoFixAfterFailure(meta);
  if (meta.type === 'clone' || meta.type === 'pull' || meta.type === 'sync') loadState();
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
        m.link ? h('a', { href: m.link, target: '_blank', rel: 'noopener' }, m.linkLabel || 'View on GitHub') : null),
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
