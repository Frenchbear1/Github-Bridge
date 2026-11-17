'use strict';
/** Background "check every project" run, its saved results, and applying a batch reply from ChatGPT. */
const store = require('./store');
const jobs = require('./jobs');
const launch = require('./launch');
const custom = require('./custom');
const { buildFixPrompt } = require('./prompt');

const FILE = 'health.json';
const load = () => { const h = store.read(FILE, {}); return { at: h.at || null, results: h.results || {}, ignored: h.ignored || {} }; };
const saveResult = r => { const h = load(); h.results[r.id] = r; h.at = new Date().toISOString(); store.write(FILE, h); };

// A result belongs to the recipe that was tested. If the project's recipe has changed since (a custom setup was saved,
// files were added), the old result no longer says anything about Play and is dropped.
function stale(project, r) {
  try { const plan = launch.detect(project); return `${plan.source}|${plan.detail}` !== `${r.source}|${r.detail}`; }
  catch { return false; }
}

function status() {
  const h = load();
  const projects = new Map(store.getProjects().map(p => [p.id, p]));
  const results = {};
  for (const [id, r] of Object.entries(h.results)) if (projects.has(id) && !stale(projects.get(id), r)) results[id] = { ...r, ignored: !!h.ignored[id] && (r.status === 'fail' || r.status === 'warn') };
  const count = k => Object.values(results).filter(r => r.status === k && !r.ignored).length;
  return { at: h.at, results, counts: { ok: count('ok'), fail: count('fail'), warn: count('warn'), skip: count('skip'), ignored: Object.values(results).filter(r => r.ignored).length }, running: !!jobs.runningOfType('check') };
}

/** Starts a check of the given projects (default: all). Returns the job id. */
function startCheck(projectIds) {
  const existing = jobs.runningOfType('check');
  if (existing) return existing.id;
  const all = store.getProjects();
  const list = projectIds ? all.filter(p => projectIds.includes(p.id)) : all;
  const job = jobs.create('check', projectIds ? `Re-check ${list.length} project${list.length === 1 ? '' : 's'}` : 'Check all projects');
  let cancelled = false;
  job.onCancel(() => { cancelled = true; job.finish('cancelled', 'Check stopped.'); });
  (async () => {
    const tally = { ok: 0, fail: 0, warn: 0, skip: 0 };
    for (let i = 0; i < list.length && !cancelled; i++) {
      const p = list[i];
      job.progress && job.set({ progress: `${i + 1} of ${list.length}: ${p.name}` });
      job.log(`[${i + 1}/${list.length}] ${p.name}`);
      let r;
      try { r = await launch.check(p, { cancelled: () => cancelled }); }
      catch (e) { r = { id: p.id, name: p.name, status: 'fail', label: 'Check', problem: e.message, output: [], checkedAt: new Date().toISOString() }; }
      if (cancelled) return;
      saveResult(r);
      tally[r.status] = (tally[r.status] || 0) + 1;
      const word = { ok: 'works', fail: 'FAILED', warn: 'unsure', skip: 'skipped' }[r.status];
      job.log(`    ${word}: ${r.status === 'fail' || r.status === 'warn' ? r.problem : r.note}`, r.status === 'fail' ? 'error' : 'info');
    }
    const msg = `${tally.ok} work, ${tally.fail} failed${tally.warn ? `, ${tally.warn} unsure` : ''}${tally.skip ? `, ${tally.skip} skipped` : ''}.`;
    job.finish(tally.fail || tally.warn ? 'warning' : 'success', msg);
  })().catch(e => job.finish('error', e.message));
  return job.id;
}

/** A saved or removed custom setup makes the last check result stale, so drop it (Play comes back; Check again re-tests). */
function forget(id) {
  const h = load();
  delete h.results[id]; delete h.ignored[id];
  store.write(FILE, h);
}

/** Ignored failures stay out of the banner and the ChatGPT prompt until you stop ignoring them. */
function setIgnored(id, ignored) {
  const h = load();
  if (ignored) h.ignored[id] = true; else delete h.ignored[id];
  store.write(FILE, h);
  return status();
}

const failing = () => {
  const { results } = status();
  return store.getProjects().map(project => ({ project, result: results[project.id] })).filter(x => x.result && !x.result.ignored && (x.result.status === 'fail' || x.result.status === 'warn'));
};

async function fixPrompt() {
  const list = failing();
  if (!list.length) return { prompt: '', chars: 0, projects: [], left: 0, none: true };
  return buildFixPrompt(list);
}

/** Validates (and with save=true, stores) a batch reply. Returns one entry per project in the reply. */
function applyReply(reply, save) {
  const raw = custom.extractJson(reply);
  if (!raw || typeof raw !== 'object') return { ok: false, errors: ['I could not find a JSON block in that reply. Ask ChatGPT to answer with only the JSON block.'], items: [] };
  const projects = raw.streamline === 2 && raw.projects && typeof raw.projects === 'object' ? raw.projects : null;
  if (!projects) return { ok: false, errors: ['The reply is not in the batch format ("streamline": 2 with a "projects" object).'], items: [] };
  const all = store.getProjects();
  const byName = new Map(all.map(p => [p.name.toLowerCase(), p]));
  const items = [];
  const saved = [];
  for (const [name, cfg] of Object.entries(projects)) {
    const project = byName.get(String(name).toLowerCase());
    if (!project) { items.push({ name, ok: false, errors: [`No saved project is named "${name}".`], warnings: [] }); continue; }
    const v = custom.validate(project, cfg);
    if (!v.ok) { items.push({ id: project.id, name: project.name, ok: false, errors: v.errors, warnings: v.warnings, cannotRun: v.cannotRun || null, questions: v.questions || [] }); continue; }
    const preview = launch.previewCustom(project, v.config);
    if (save) { custom.save(project.id, v.config); saved.push(project.id); }
    items.push({ id: project.id, name: project.name, ok: true, warnings: v.warnings, config: v.config, ...preview });
  }
  return { ok: items.some(i => i.ok), errors: [], items, saved };
}

module.exports = { forget, setIgnored, status, startCheck, fixPrompt, applyReply };
