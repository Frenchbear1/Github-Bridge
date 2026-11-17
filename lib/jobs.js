'use strict';
const { EventEmitter } = require('events');
const crypto = require('crypto');
const store = require('./store');
const { redact } = require('./util');

const MAX_JOBS = 60;
const MAX_LINES = 400;

const bus = new EventEmitter();
bus.setMaxListeners(50);

let jobs = store.read('activity.json', []).map(j => (
  j.status === 'running' ? { ...j, live: false, status: 'error', summary: 'Interrupted (Streamline was closed).', finishedAt: j.finishedAt || new Date().toISOString() } : { ...j, live: false }
));

const cancelers = new Map();
let persistTimer = null;
function persist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try { store.write('activity.json', jobs); } catch { /* best effort */ }
  }, 500);
}

function meta(job) {
  const { lines, ...rest } = job;
  return { ...rest, lineCount: lines.length };
}

function create(type, title) {
  const job = {
    id: crypto.randomBytes(6).toString('hex'),
    type, title,
    status: 'running',        // running | success | warning | error | cancelled
    startedAt: new Date().toISOString(),
    finishedAt: null,
    progress: '',
    summary: '',
    exitCode: null,
    link: null,
    lines: []
  };
  jobs.unshift(job);
  if (jobs.length > MAX_JOBS) jobs.length = MAX_JOBS;
  bus.emit('job', meta(job));
  persist();
  return {
    id: job.id,
    log(text, level) {
      for (const raw of String(text).split(/\r\n|\r|\n/)) {
        if (!raw.trim()) continue;
        const line = { t: new Date().toISOString(), text: redact(raw), level: level || 'info' };
        job.lines.push(line);
        if (job.lines.length > MAX_LINES) job.lines.shift();
        bus.emit('line', { id: job.id, line });
      }
      persist();
    },
    progress(text) {
      job.progress = redact(text).trim();
      bus.emit('job', meta(job));
    },
    onCancel(fn) { cancelers.set(job.id, fn); },
    set(extra) { Object.assign(job, extra); bus.emit('job', meta(job)); },
    // A program that was started and is still running in the background. The job counts as a success; `live` keeps it
    // controllable (Stop) without showing it as "working" in Activity.
    background(summary) {
      job.status = 'success'; job.live = true; job.summary = summary || ''; job.progress = '';
      bus.emit('job', meta(job)); persist();
    },
    finish(status, summary, extra) {
      job.live = false;
      job.status = status;
      job.summary = summary || '';
      job.progress = '';
      job.finishedAt = new Date().toISOString();
      Object.assign(job, extra || {});
      cancelers.delete(job.id);
      bus.emit('job', meta(job));
      persist();
    },
    get status() { return job.status; }
  };
}

function cancel(id) {
  const fn = cancelers.get(id);
  if (!fn) return false;
  fn();
  return true;
}
function list() { return jobs.map(meta); }
function lines(id) { const j = jobs.find(x => x.id === id); return j ? j.lines : null; }
function get(id) { return jobs.find(x => x.id === id) || null; }
function runningOfType(type) { return jobs.find(j => j.type === type && j.status === 'running') || null; }
// Change a finished job's stored details (used when a paused project is fixed from the results).
function patch(id, extra) { const j = jobs.find(x => x.id === id); if (!j) return null; Object.assign(j, extra); bus.emit('job', meta(j)); persist(); return meta(j); }
function clearFinished() { jobs = jobs.filter(j => j.status === 'running'); persist(); bus.emit('cleared'); }

module.exports = { bus, cancel, create, list, lines, get, runningOfType, clearFinished, patch };
