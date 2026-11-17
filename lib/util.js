'use strict';
const path = require('path');
const crypto = require('crypto');

const IS_WIN = process.platform === 'win32';

// Remove anything that looks like a credential before it reaches the log, the UI or disk.
function redact(text) {
  return String(text)
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{20,})\b/g, '***')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '***')
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1***@')
    .replace(/(authorization:\s*(?:bearer|basic|token)\s+)\S+/gi, '$1***');
}

function normKey(p) {
  const r = path.resolve(p);
  return IS_WIN ? r.toLowerCase() : r;
}

function isInside(parent, child) {
  const a = normKey(parent);
  const b = normKey(child);
  if (a === b) return true;
  const sep = path.sep;
  return b.startsWith(a.endsWith(sep) ? a : a + sep);
}

function toPosix(p) {
  return p.split(path.sep).join('/');
}

function projectId(localPath) {
  return crypto.createHash('sha1').update(normKey(localPath)).digest('hex').slice(0, 10);
}

// Accepts https://github.com/o/r(.git), git@github.com:o/r.git, github.com/o/r, or o/r.
function parseRepoUrl(input) {
  let s = String(input || '').trim();
  if (!s) throw new Error('Paste a GitHub repository URL.');
  if (process.env.STREAMLINE_ALLOW_ANY_REMOTE === '1' && (s.startsWith('/') || s.startsWith('file://') || /^[A-Za-z]:[\\/]/.test(s))) {
    // Test hook only: lets the automated tests clone from a local folder.
    const name = path.basename(s.replace(/\.git$/, '').replace(/[\\/]+$/, ''));
    return { url: s, name, owner: 'local', web: null };
  }
  let m = s.match(/^git@github\.com:([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/);
  if (!m) m = s.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:[/#?].*)?$/i);
  if (!m) m = s.match(/^([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/);
  if (!m) throw new Error('That does not look like a GitHub repository URL (expected https://github.com/owner/repo).');
  const [, owner, name] = m;
  if (name === '.' || name === '..') throw new Error('Invalid repository name.');
  return { url: `https://github.com/${owner}/${name}.git`, name, owner, web: `https://github.com/${owner}/${name}` };
}

function webUrlFromRemote(remote) {
  const m = String(remote || '').match(/github\.com[/:]([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i);
  return m ? `https://github.com/${m[1]}/${m[2]}` : null;
}

function cleanSubfolder(sub) {
  let s = String(sub || '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!s) return '';
  const parts = s.split('/').filter(Boolean);
  for (const p of parts) {
    if (p === '.' || p === '..' || /[:*?"<>|]/.test(p)) throw new Error('Target subfolder contains invalid characters.');
    if (p.toLowerCase() === '.git') throw new Error('Target subfolder cannot be .git.');
  }
  return parts.join('/');
}

function fmtSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
}

module.exports = { IS_WIN, redact, normKey, isInside, toPosix, projectId, parseRepoUrl, webUrlFromRemote, cleanSubfolder, fmtSize };
