'use strict';
/** When a project's files last changed (newest file time), ignoring dependency, build and cache folders. */
const fs = require('fs');
const path = require('path');

const SKIP = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', 'dist', 'build', 'target', 'obj', 'bin', 'out', 'coverage', '.next', '.nuxt', '.expo', '.gradle', '.idea', '.vs', '.cache', '.turbo', '.svelte-kit', '.parcel-cache', '.wrangler', 'Pods', 'DerivedData']);
const SKIP_FILES = new Set(['Streamline-Play.bat']);
const MAX_ENTRIES = 4000;
const cache = new Map(); // dir -> { at, value }

function newestChange(dir) {
  const hit = cache.get(dir);
  if (hit && Date.now() - hit.at < 15000) return hit.value;
  let newest = 0, seen = 0;
  (function walk(d, depth) {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (++seen > MAX_ENTRIES) return;
      const full = path.join(d, e.name);
      if (e.isDirectory()) { if (!SKIP.has(e.name) && depth < 6) walk(full, depth + 1); }
      else if (e.isFile() && !SKIP_FILES.has(e.name)) { try { const m = fs.statSync(full).mtimeMs; if (m > newest) newest = m; } catch { /* ignore */ } }
    }
  })(dir, 0);
  cache.set(dir, { at: Date.now(), value: newest });
  return newest;
}

module.exports = { newestChange };
