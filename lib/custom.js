'use strict';
/**
 * Custom Play setups (from the ChatGPT fallback). The reply is untrusted text that ends up as commands on this
 * computer, so it is checked strictly: only a short list of well-known programs, one command per step, no shell
 * operators or quotes, every path inside the project, and the user reviews the result before it is saved.
 */
const fs = require('fs');
const path = require('path');
const store = require('./store');
const { isInside } = require('./util');

const FILE = 'custom-plays.json';

const ALLOWED_PROGRAMS = new Set([
  'npm', 'npx', 'pnpm', 'yarn', 'bun', 'bunx', 'node', 'deno', 'tsx', 'vite', 'next', 'tsc', 'electron', 'wrangler',
  'python', 'python3', 'py', 'pip', 'pip3', 'uv', 'poetry', 'pipenv', 'flask', 'uvicorn', 'streamlit', 'gunicorn',
  'dotnet', 'cargo', 'rustc', 'go', 'flutter', 'dart', 'java', 'javac', 'mvn', 'gradle', 'gradlew',
  'make', 'cmake', 'msbuild', 'ninja', 'php', 'composer', 'ruby', 'bundle', 'rails', 'jekyll', 'hugo', 'mkdocs', 'godot'
]);
const KINDS = new Set(['command', 'open-file', 'exe']);
const BAD_ENV = new Set(['PATH', 'PATHEXT', 'COMSPEC', 'SYSTEMROOT', 'WINDIR', 'NODE_OPTIONS', 'PYTHONPATH', 'PYTHONHOME', 'LD_PRELOAD', 'PSMODULEPATH']);
const FORBIDDEN_CHARS = /[&|<>^%"`();\r\n\0$]/;

const getAll = () => store.read(FILE, {});
const get = id => getAll()[id] || null;
function save(id, config) { const all = getAll(); all[id] = { ...config, savedAt: new Date().toISOString(), source: 'chatgpt' }; store.write(FILE, all); }
function remove(id) { const all = getAll(); const had = id in all; delete all[id]; store.write(FILE, all); return had; }

/** Pulls a JSON object out of whatever the chat reply looks like (fenced block, prose around it, etc.). */
function extractJson(text) {
  const t = String(text || '');
  const fenced = [...t.matchAll(/```(?:json|JSON)?\s*([\s\S]*?)```/g)].map(m => m[1].trim()).filter(s => s.startsWith('{'));
  const candidates = fenced.length ? fenced : [t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1)];
  for (const c of candidates) {
    if (!c || !c.startsWith('{')) continue;
    try { return JSON.parse(c.replace(/^﻿/, '')); } catch { /* try next */ }
  }
  return null;
}

const relClean = p => String(p || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');

// A path the reply gave us: must be relative and stay inside the project.
function projectPath(dir, rel, label, errors, { mustExist = false } = {}) {
  const r = relClean(rel);
  if (!r) return '';
  if (/^[A-Za-z]:/.test(r) || r.startsWith('/') || r.startsWith('~') || r.split('/').includes('..') || FORBIDDEN_CHARS.test(r)) {
    errors.push(`${label}: "${rel}" must be a simple path inside the project.`);
    return null;
  }
  const abs = path.join(dir, ...r.split('/'));
  if (!isInside(dir, abs)) { errors.push(`${label}: "${rel}" is outside the project.`); return null; }
  if (mustExist && !fs.existsSync(abs)) { errors.push(`${label}: "${r}" does not exist in the project.`); return null; }
  return r;
}

function checkCommand(dir, cmd, label, errors, warnings) {
  const c = String(cmd || '').trim();
  if (!c) { errors.push(`${label}: command is empty.`); return null; }
  if (c.length > 400) { errors.push(`${label}: command is too long.`); return null; }
  if (FORBIDDEN_CHARS.test(c)) { errors.push(`${label}: "${c}" contains characters that are not allowed (& | ; < > ^ % quotes, parentheses, $). Use one simple command per step.`); return null; }
  const tokens = c.split(/\s+/);
  const first = tokens[0];
  const low = first.toLowerCase();
  const stem = low.replace(/\.(cmd|exe|bat)$/, '');
  const pathLike = /[\\/]/.test(first) || /\.(bat|cmd|exe)$/.test(low) && !ALLOWED_PROGRAMS.has(stem);

  if (stem === 'powershell' || stem === 'pwsh') {
    let i = 1; let script = null;
    for (; i < tokens.length; i++) {
      const t = tokens[i].toLowerCase();
      if (t === '-noprofile' || t === '-noninteractive' || t === '-nologo') continue;
      if (t === '-executionpolicy') { if (!/^(bypass|remotesigned|unrestricted|allsigned|default)$/i.test(tokens[i + 1] || '')) { errors.push(`${label}: unsupported -ExecutionPolicy value.`); return null; } i++; continue; }
      if (t === '-file') { script = tokens[i + 1]; i += 2; break; }
      errors.push(`${label}: PowerShell is only allowed as "powershell -File script.ps1" (no -Command or encoded commands).`); return null;
    }
    if (!script || !/\.ps1$/i.test(script)) { errors.push(`${label}: PowerShell must run a .ps1 file from the project with -File.`); return null; }
    if (projectPath(dir, script, label, errors, { mustExist: true }) === null) return null;
    return { exe: stem, text: c };
  }

  if (pathLike) {
    if (!/\.(bat|cmd|exe)$/.test(low)) { errors.push(`${label}: "${first}" must be a .bat, .cmd or .exe inside the project.`); return null; }
    const rel = projectPath(dir, first, label, errors);
    if (rel === null) return null;
    if (!fs.existsSync(path.join(dir, ...rel.split('/')))) warnings.push(`${label}: "${rel}" does not exist yet. It must be created by an earlier step.`);
    return { exe: first, text: c };
  }
  if (!ALLOWED_PROGRAMS.has(stem)) {
    errors.push(`${label}: "${first}" is not one of the programs Streamline will run from a pasted reply. Allowed: ${[...ALLOWED_PROGRAMS].slice(0, 14).join(', ')}, ... (or a .bat/.cmd/.exe inside the project).`);
    return null;
  }
  for (const t of tokens.slice(1)) {
    if (/^[A-Za-z]:[\\/]/.test(t) || t.split(/[\\/]/).includes('..') || /^[\\/]/.test(t) && /[\\/]/.test(t.slice(1))) { errors.push(`${label}: argument "${t}" points outside the project.`); return null; }
  }
  if (/^(pip3?|uv|poetry|pipenv)$/.test(stem) && /\binstall\b/.test(c) && !/-r\b|\s-e\b|\s\.\s*$/.test(c)) warnings.push(`${label}: installs packages by name (${c}). Check they are the ones you expect.`);
  return { exe: stem, text: c };
}

/**
 * Validates a pasted reply for one project. Returns { ok, errors, warnings, config, cannotRun, questions }.
 * `config` is a normalized, safe-to-store object.
 */
function validate(project, reply) {
  const dir = path.resolve(project.localPath);
  const errors = [];
  const warnings = [];
  const raw = typeof reply === 'string' ? extractJson(reply) : reply;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, errors: ['I could not find a JSON block in that reply. Ask ChatGPT to answer with only the JSON block.'], warnings };
  if (raw.cannot_run) return { ok: false, errors: [], warnings, cannotRun: String(raw.cannot_run).slice(0, 600), questions: Array.isArray(raw.questions) ? raw.questions.map(q => String(q).slice(0, 300)).slice(0, 6) : [] };
  if (raw.streamline !== 1) errors.push('The reply is missing "streamline": 1, so it does not look like the format that was requested.');
  const kind = raw.kind;
  if (!KINDS.has(kind)) errors.push(`"kind" must be one of: ${[...KINDS].join(', ')}.`);

  const cfg = { streamline: 1, kind, needs: [], setup: [], run: null, file: '', openUrl: '', opensWindow: !!raw.opensWindow, notes: String(raw.notes || '').slice(0, 800) };

  if (raw.needs !== undefined) {
    if (!Array.isArray(raw.needs) || raw.needs.length > 8) errors.push('"needs" must be a list of at most 8 programs.');
    else for (const n of raw.needs) {
      const exe = String((n && n.exe) || '').trim();
      if (!/^[A-Za-z0-9._-]{1,40}$/.test(exe)) { errors.push(`"needs": "${exe}" is not a valid program name.`); continue; }
      cfg.needs.push({ exe, install: String((n && n.install) || '').replace(/[^A-Za-z0-9 ._:\/-]/g, '').slice(0, 120) });
    }
  }

  if (raw.setup !== undefined) {
    if (!Array.isArray(raw.setup) || raw.setup.length > 10) errors.push('"setup" must be a list of at most 10 steps.');
    else raw.setup.forEach((s, i) => {
      const label = `Setup step ${i + 1}`;
      const chk = checkCommand(dir, s && s.cmd, label, errors, warnings);
      const cwd = projectPath(dir, s && s.cwd, label + ' folder', errors, { mustExist: true });
      const skip = projectPath(dir, s && s.skipIfExists, label + ' skip-check', errors);
      if (chk && cwd !== null && skip !== null) cfg.setup.push({ say: String((s && s.say) || 'Setting up').replace(/[^A-Za-z0-9 ,.:_-]/g, '').slice(0, 80) || 'Setting up', cmd: chk.text, cwd, skipIfExists: skip });
    });
  }

  if (kind === 'command') {
    const rn = raw.run || {};
    const chk = checkCommand(dir, rn.cmd, 'Run command', errors, warnings);
    const cwd = projectPath(dir, rn.cwd, 'Run folder', errors, { mustExist: true });
    const env = {};
    if (rn.env !== undefined) {
      if (typeof rn.env !== 'object' || Array.isArray(rn.env) || Object.keys(rn.env).length > 6) errors.push('"env" must be an object with at most 6 entries.');
      else for (const [k, v] of Object.entries(rn.env)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]{0,40}$/.test(k) || BAD_ENV.has(k.toUpperCase())) { errors.push(`Environment variable "${k}" is not allowed.`); continue; }
        if (!/^[A-Za-z0-9._:\/\\-]{0,100}$/.test(String(v))) { errors.push(`Environment value for ${k} contains characters that are not allowed.`); continue; }
        env[k] = String(v);
      }
    }
    if (chk && cwd !== null) cfg.run = { cmd: chk.text, cwd, env };
  } else if (kind === 'open-file' || kind === 'exe') {
    const f = projectPath(dir, raw.file, 'File', errors, { mustExist: true });
    if (f) {
      if (kind === 'open-file' && !/\.html?$/i.test(f)) errors.push('For "open-file" the file must be an .html page.');
      if (kind === 'exe' && !/\.exe$/i.test(f)) errors.push('For "exe" the file must be an .exe inside the project.');
      cfg.file = f;
    }
  }

  if (raw.openUrl) {
    const u = String(raw.openUrl).trim();
    if (!/^http:\/\/(localhost|127\.0\.0\.1):\d{2,5}(\/[A-Za-z0-9._~\/?#=&%-]*)?$/.test(u)) errors.push('"openUrl" can only be a http://localhost:PORT address.');
    else cfg.openUrl = u;
  }
  if (kind === 'command' && cfg.run) {
    const lastSetupCmds = cfg.setup.length;
    if (lastSetupCmds && !cfg.needs.length) warnings.push('No required programs were listed, so Streamline cannot give an install hint if one is missing.');
  }
  return { ok: errors.length === 0, errors, warnings, config: errors.length ? null : cfg };
}

module.exports = { get, getAll, save, remove, validate, extractJson, ALLOWED_PROGRAMS };
