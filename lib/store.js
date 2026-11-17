'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_DIR = process.env.STREAMLINE_DATA || path.join(__dirname, '..', 'data');

function ensure() { fs.mkdirSync(DATA_DIR, { recursive: true }); }

function read(name, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8')); }
  catch { return fallback; }
}

function write(name, value) {
  ensure();
  const file = path.join(DATA_DIR, name);
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

// Look for the user's existing GitHub Projects folder + sync script without hard-coding a username.
function detectDefaults() {
  const home = os.homedir();
  const candidates = [
    process.env.STREAMLINE_PROJECTS_ROOT,
    path.join(home, 'Downloads', 'Codex Only', 'GitHub Projects'),
    path.join(home, 'Documents', 'GitHub Projects'),
    path.join(home, 'GitHub Projects'),
    path.join(home, 'Documents', 'GitHub')
  ].filter(Boolean);
  let projectsRoot = '';
  let syncScript = process.env.STREAMLINE_SYNC_SCRIPT || '';
  for (const c of candidates) {
    const script = path.join(c, '.github-sync', 'Sync-GitHubProjects.ps1');
    if (fs.existsSync(script)) { projectsRoot = c; syncScript = syncScript || script; break; }
  }
  if (!projectsRoot) projectsRoot = candidates.find(c => fs.existsSync(c)) || path.join(home, 'GitHub Projects');
  return { projectsRoot, syncScript };
}

const DEFAULT_SETTINGS = () => ({
  ...detectDefaults(),
  maxFileMB: 95,
  customExclusions: [],
  disabledDefaults: []
});

function getSettings() {
  return { ...DEFAULT_SETTINGS(), ...read('settings.json', {}) };
}

function saveSettings(patch) {
  const next = { ...getSettings(), ...patch };
  write('settings.json', next);
  return next;
}

function getProjects() { return read('projects.json', []); }
function saveProjects(list) { write('projects.json', list); }

module.exports = { DATA_DIR, read, write, getSettings, saveSettings, getProjects, saveProjects };
