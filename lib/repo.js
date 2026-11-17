'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const store = require('./store');
const { git } = require('./proc');
const { projectId, isInside, normKey } = require('./util');

// Cheap read of origin URL + branch straight from .git (no process spawn); used when scanning many folders.
function quickInfo(dir) {
  try {
    const gitPath = path.join(dir, '.git');
    if (!fs.statSync(gitPath).isDirectory()) return null;
    const cfg = fs.readFileSync(path.join(gitPath, 'config'), 'utf8');
    const m = cfg.match(/\[remote "origin"\][^[]*?url\s*=\s*(.+)/);
    const head = fs.readFileSync(path.join(gitPath, 'HEAD'), 'utf8').trim();
    const b = head.match(/^ref: refs\/heads\/(.+)$/);
    return { url: m ? m[1].trim() : '', branch: b ? b[1] : 'main' };
  } catch { return null; }
}

async function repoInfo(dir) {
  const top = await git(dir, ['rev-parse', '--show-toplevel']);
  if (top.code !== 0) return null;
  if (normKey(top.out) !== normKey(dir)) return null;
  const origin = await git(dir, ['remote', 'get-url', 'origin']);
  const br = await git(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  return { url: origin.code === 0 ? origin.out : '', branch: br.code === 0 && br.out ? br.out : 'main' };
}

function upsertProject({ name, url, localPath, branch }) {
  const list = store.getProjects();
  const id = projectId(localPath);
  const now = new Date().toISOString();
  const existing = list.find(p => p.id === id);
  if (existing) {
    Object.assign(existing, { name: name || existing.name, url: url || existing.url, branch: branch || existing.branch });
  } else {
    list.push({ id, name: name || path.basename(localPath), url: url || '', localPath: path.resolve(localPath), branch: branch || 'main', addedAt: now, lastUsed: null });
  }
  store.saveProjects(list);
  return list.find(p => p.id === id);
}

function touch(id) {
  const list = store.getProjects();
  const p = list.find(x => x.id === id);
  if (p) { p.lastUsed = new Date().toISOString(); store.saveProjects(list); }
}

function removeProject(id) {
  const list = store.getProjects();
  const next = list.filter(p => p.id !== id);
  store.saveProjects(next);
  return next.length !== list.length;
}

async function scanFolder(root) {
  const entries = await fsp.readdir(root, { withFileTypes: true });
  const known = new Set(store.getProjects().map(p => p.id));
  let added = 0;
  let skipped = 0;
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const dir = path.join(root, e.name);
    const info = quickInfo(dir);
    if (!info) { skipped++; continue; }
    if (known.has(projectId(dir))) continue;
    upsertProject({ name: e.name, url: info.url, localPath: dir, branch: info.branch });
    added++;
  }
  return { added, skipped };
}

module.exports = { quickInfo, repoInfo, upsertProject, touch, removeProject, scanFolder, isInside };
