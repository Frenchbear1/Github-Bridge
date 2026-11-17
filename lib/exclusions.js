'use strict';
const path = require('path');

// Smart defaults: things that are large, regenerated, machine-specific or secret.
// dir:true patterns only match folders. Patterns with "/" are matched against the path
// relative to the selected folder; "**/" means "at any depth".
const DEFAULTS = [
  { id: 'git',          glob: '.git',            dir: true,  why: 'Git internals (always excluded)' , locked: true },
  { id: 'node_modules', glob: 'node_modules',    dir: true,  why: 'Installed npm packages' },
  { id: 'build',        glob: 'build',           dir: true,  why: 'Build output' },
  { id: 'dist',         glob: 'dist',            dir: true,  why: 'Build output' },
  { id: 'out',          glob: 'out',             dir: true,  why: 'Build output' },
  { id: 'target',       glob: 'target',          dir: true,  why: 'Rust/Java build output' },
  { id: 'next',         glob: '.next',           dir: true,  why: 'Next.js cache/output' },
  { id: 'nuxt',         glob: '.nuxt',           dir: true,  why: 'Nuxt cache/output' },
  { id: 'svelte',       glob: '.svelte-kit',     dir: true,  why: 'SvelteKit cache/output' },
  { id: 'parcel',       glob: '.parcel-cache',   dir: true,  why: 'Parcel cache' },
  { id: 'turbo',        glob: '.turbo',          dir: true,  why: 'Turborepo cache' },
  { id: 'cache',        glob: '.cache',          dir: true,  why: 'Tool caches' },
  { id: 'expo',         glob: '.expo',           dir: true,  why: 'Expo cache' },
  { id: 'coverage',     glob: 'coverage',        dir: true,  why: 'Test coverage output' },
  { id: 'pycache',      glob: '__pycache__',     dir: true,  why: 'Python bytecode cache' },
  { id: 'pytest',       glob: '.pytest_cache',   dir: true,  why: 'Pytest cache' },
  { id: 'mypy',         glob: '.mypy_cache',     dir: true,  why: 'Mypy cache' },
  { id: 'venv',         glob: '.venv',           dir: true,  why: 'Python virtual environment' },
  { id: 'venv2',        glob: 'venv',            dir: true,  why: 'Python virtual environment' },
  { id: 'gradle',       glob: '.gradle',         dir: true,  why: 'Gradle cache' },
  { id: 'idea',         glob: '.idea',           dir: true,  why: 'JetBrains IDE settings' },
  { id: 'vs',           glob: '.vs',             dir: true,  why: 'Visual Studio cache' },
  { id: 'obj',          glob: 'obj',             dir: true,  why: '.NET intermediate output' },
  { id: 'bindebug',     glob: '**/bin/Debug',    dir: true,  why: '.NET build output' },
  { id: 'binrelease',   glob: '**/bin/Release',  dir: true,  why: '.NET build output' },
  { id: 'pods',         glob: 'Pods',            dir: true,  why: 'CocoaPods packages' },
  { id: 'derived',      glob: 'DerivedData',     dir: true,  why: 'Xcode build data' },
  { id: 'terraform',    glob: '.terraform',      dir: true,  why: 'Terraform providers' },
  { id: 'dsstore',      glob: '.DS_Store',       dir: false, why: 'macOS folder metadata' },
  { id: 'thumbs',       glob: 'Thumbs.db',       dir: false, why: 'Windows thumbnail cache' },
  { id: 'desktopini',   glob: 'desktop.ini',     dir: false, why: 'Windows folder metadata' },
  { id: 'logs',         glob: '*.log',           dir: false, why: 'Log files' },
  { id: 'tmp',          glob: '*.tmp',           dir: false, why: 'Temporary files' },
  { id: 'swp',          glob: '*.swp',           dir: false, why: 'Editor swap files' },
  { id: 'pyc',          glob: '*.pyc',           dir: false, why: 'Python bytecode' },
  { id: 'env',          glob: '.env',            dir: false, why: 'Secrets / environment variables' },
  { id: 'envx',         glob: '.env.*',          dir: false, why: 'Secrets / environment variables (.env.example is allowed)' },
  { id: 'pem',          glob: '*.pem',           dir: false, why: 'Private keys / certificates' },
  { id: 'key',          glob: '*.key',           dir: false, why: 'Private keys' },
  { id: 'pfx',          glob: '*.pfx',           dir: false, why: 'Certificate bundles' },
  { id: 'p12',          glob: '*.p12',           dir: false, why: 'Certificate bundles' }
];

const ENV_ALLOWED = /^\.env\.(example|sample|template|dist)$/i;

function globToRegex(g) {
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        if (g[i + 2] === '/') { re += '(?:.*/)?'; i += 2; }
        else { re += '.*'; i += 1; }
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$', 'i');
}

function compile(raw, forceDir) {
  let g = String(raw || '').trim().replace(/\\/g, '/');
  if (!g || g.startsWith('#')) return null;
  let dir = !!forceDir;
  if (g.endsWith('/')) { dir = true; g = g.slice(0, -1); }
  let anchored = false;
  if (g.startsWith('/')) { anchored = true; g = g.slice(1); }
  if (g.includes('/')) anchored = true;
  if (!g) return null;
  return { re: globToRegex(g), dir, multi: anchored };
}

// Returns (relPath, isDir) => boolean. relPath is POSIX-style, relative to the selected item.
function makeMatcher(settings) {
  const disabled = new Set((settings && settings.disabledDefaults) || []);
  const rules = [];
  for (const d of DEFAULTS) {
    if (d.locked || !disabled.has(d.id)) {
      const r = compile(d.glob, d.dir);
      if (r) rules.push(r);
    }
  }
  for (const c of (settings && settings.customExclusions) || []) {
    const r = compile(c, false);
    if (r) rules.push(r);
  }
  return function isExcluded(rel, isDir) {
    const segs = rel.split('/');
    if (segs.includes('.git')) return true; // hard rule, cannot be disabled
    for (let i = 0; i < segs.length; i++) {
      const segIsDir = i < segs.length - 1 || isDir;
      for (const r of rules) {
        if (r.dir && !segIsDir) continue;
        const subject = r.multi ? segs.slice(0, i + 1).join('/') : segs[i];
        if (r.re.test(subject)) {
          if (!segIsDir && ENV_ALLOWED.test(segs[i])) continue;
          return true;
        }
      }
    }
    return false;
  };
}

module.exports = { DEFAULTS, makeMatcher };
