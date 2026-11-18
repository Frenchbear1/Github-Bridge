'use strict';
/** Builds the one-shot prompt that gets copied to the clipboard for ChatGPT. */
const fs = require('fs');
const path = require('path');
const { makeMatcher } = require('./exclusions');
const { redact } = require('./util');
const launch = require('./launch');
const { git } = require('./proc');

const MAX_TOTAL = 48000;
const PER_FILE = 4500;

const KEY_FILES = [
  /^readme(\.[a-z]+)?$/i, /^package\.json$/, /^pyproject\.toml$/, /^requirements.*\.txt$/, /^cargo\.toml$/, /^go\.mod$/, /^pubspec\.yaml$/,
  /\.(csproj|sln|vcxproj)$/i, /^cmakelists\.txt$/i, /^makefile$/i, /^manifest\.json$/, /^docker-compose\.ya?ml$/i, /^dockerfile$/i,
  /\.(bat|cmd|ps1|sh)$/i, /^(\.nvmrc|\.node-version|\.python-version|global\.json|tauri\.conf\.json|vite\.config\.[jt]s|next\.config\.[jm]?[jt]s|setup\.py|setup\.cfg|tox\.ini|build\.gradle|pom\.xml|build\.gradle\.kts|capacitor\.config\.json)$/i
];
const SECRETISH = /^(\.env.*|.*\.(pem|key|pfx|p12|keystore)|id_rsa.*|.*secret.*|.*credentials.*)$/i;
const SECRET_LINE = /((?:api[_-]?key|secret|token|passw(?:or)?d|auth|private[_-]?key)[A-Za-z0-9_]*\s*[:=]\s*)(["']?)[^\s"',;]{6,}\2/gi;

function walk(root, isExcluded, limit) {
  const out = [];
  (function rec(dir, rel, depth) {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    ents.sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
    for (const e of ents) {
      if (out.length >= limit) return;
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.name === '.git' || isExcluded(r, e.isDirectory())) continue;
      if (e.isDirectory()) { out.push(r + '/'); if (depth < 3) rec(path.join(dir, e.name), r, depth + 1); }
      else if (e.isFile() && !SECRETISH.test(e.name)) out.push(r);
    }
  })(root, '', 1);
  return out;
}

function clean(text) {
  return redact(text).replace(SECRET_LINE, '$1$2***$2');
}

async function gather(project, maxTotal = MAX_TOTAL, maxFiles = 350) {
  const dir = path.resolve(project.localPath);
  const plan = launch.detect(project);
  const isExcluded = makeMatcher({});
  const files = walk(dir, isExcluded, maxFiles);

  const origin = await git(dir, ['remote', 'get-url', 'origin']);
  const picked = [];
  for (const f of files) {
    if (f.endsWith('/')) continue;
    const depth = f.split('/').length;
    const base = path.basename(f);
    if (depth <= 2 && KEY_FILES.some(re => re.test(base))) picked.push(f);
  }
  // Root-level files first, then one level down (monorepos: web/package.json, server/requirements.txt ...).
  picked.sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));

  const blocks = [];
  let used = 0;
  const included = [];
  for (const f of picked) {
    let body;
    try {
      const st = fs.statSync(path.join(dir, f));
      if (st.size > 400000) continue;
      body = fs.readFileSync(path.join(dir, f), 'utf8');
    } catch { continue; }
    if (body.includes('\u0000')) continue;
    body = clean(body);
    const cut = body.length > PER_FILE ? body.slice(0, PER_FILE) + '\n...[truncated]' : body;
    if (used + cut.length > maxTotal) break;
    used += cut.length;
    included.push(f);
    blocks.push(`----- FILE: ${f} -----\n${cut}`);
  }
  // A glimpse of the main web page, if any.
  const html = files.find(f => /(^|\/)index\.html$/i.test(f));
  if (html && !included.includes(html) && used < maxTotal - 2000) {
    const body = clean(fs.readFileSync(path.join(dir, html), 'utf8').slice(0, 1800));
    blocks.push(`----- FILE: ${html} (first 1800 characters) -----\n${body}`);
    included.push(html);
  }

  const tree = files.join('\n') + (files.length >= maxFiles ? '\n...[listing truncated]' : '');
  return { dir, plan, origin, tree, blocks, included, files };
}

async function buildPrompt(project, failure) {
  const { plan, origin, tree, blocks, included, files } = await gather(project);
  const prompt = `I want a one-click "Run" button for a project on my Windows 10/11 PC. The app that provides the button is called Streamline. It can only run a few simple steps, so I need you to work out exactly how this project is started and answer in one fixed JSON format that the app understands.

PROJECT
- Name: ${project.name}
- Repository: ${origin.out || '(none)'}
- Folder layout below is relative to the project folder. node_modules, .git, build output and secrets were left out on purpose.
- The app's automatic detection said: ${plan.canPlay ? `${plan.label} (${plan.detail}), but I want to confirm or correct it` : 'it could not tell how to run this project'}${plan.detail && !plan.canPlay ? ` (${plan.detail})` : ''}

${failure ? `WHAT HAPPENED WHEN PLAY WAS TRIED
${failure.problem || 'it failed'}
Output (last lines):
${failure.output.map(l => '  ' + clean(l)).join('\n') || '  (no output)'}

` : ''}FOLDER LISTING
${tree}

KEY FILES
${blocks.join('\n\n') || '(no recognizable build or config files were found)'}

WHAT I NEED
Tell me the exact steps to start this project on Windows, then reply with ONLY one JSON code block (no other text before or after it) in exactly this shape:

\`\`\`json
{
  "streamline": 1,
  "kind": "command",
  "needs": [{ "exe": "node", "install": "winget install OpenJS.NodeJS.LTS" }],
  "setup": [
    { "say": "Installing dependencies", "cmd": "npm install --no-package-lock", "cwd": "", "skipIfExists": "node_modules" }
  ],
  "run": { "cmd": "npm run dev", "cwd": "", "env": {} },
  "openUrl": "http://localhost:5173/",
  "opensWindow": false,
  "interactive": false,
  "notes": "One sentence describing what this does."
}
\`\`\`

RULES FOR THE JSON
- "kind" is one of: "command" (run a command, usually a dev server or an app), "open-file" (just open a local .html page; add "file": "path/to/page.html" and leave out "run"), or "exe" (start a program that is already built; add "file": "path/to/app.exe" and leave out "run").
- "needs" lists the programs that must already be installed (the "exe" is the command name, "install" is a winget command or short instruction).
- "setup" is optional first-time preparation (install dependencies, create a virtual environment, build). Each step has "skipIfExists": a path that, once it exists, means the step can be skipped next time (for example "node_modules" or ".venv"). Use "" if the step must always run.
- "run.cmd" is the single command that starts the project and keeps running. "cwd" is a sub-folder to run in, or "" for the project folder.
- "openUrl" is the web address to open in the browser once it is running, or null if nothing should open (desktop apps, command-line tools). Set "opensWindow": true for desktop apps. Set "interactive": true for command-line tools that wait for the user to type (they get their own console window; a hidden run would fail with an input error).
- Every "cmd" must be ONE plain command: no &&, |, >, <, ^, %, quotes, parentheses or $. Use "cwd" instead of "cd". Use forward-slash or backslash relative paths only; no absolute paths and no "..".
- Only use well-known tools (npm, pnpm, yarn, bun, node, python, py, pip, uv, poetry, dotnet, cargo, go, flutter, java, mvn, gradle, make, cmake, msbuild, php, ruby and similar), or a .bat/.cmd/.exe that exists inside the project, or "powershell -File script.ps1" for a script in the project. No downloads, no curl, no admin rights.
- Do not create or modify lock files: use "npm ci" if package-lock.json exists, otherwise "npm install --no-package-lock" (pnpm: "--no-lockfile" when there is no lock file).
- Prefer the development command a developer would use (for example "npm run dev"), not a production build, unless there is nothing else.
- If the project cannot be run without something I must provide (an API key, a database, a phone, hardware), still give the best JSON you can and explain the catch in "notes".
- If you genuinely cannot tell how to run it, reply with ONLY this instead: { "streamline": 1, "cannot_run": "short reason", "questions": ["what you need to know"] }
`;
  return { prompt, chars: prompt.length, included, fileCount: files.length };
}

const JSON_SHAPE = `{
  "streamline": 1,
  "kind": "command",
  "needs": [{ "exe": "node", "install": "winget install OpenJS.NodeJS.LTS" }],
  "setup": [
    { "say": "Installing dependencies", "cmd": "npm install --no-package-lock", "cwd": "", "skipIfExists": "node_modules" }
  ],
  "run": { "cmd": "npm run dev", "cwd": "", "env": {} },
  "openUrl": "http://localhost:5173/",
  "opensWindow": false,
  "interactive": false,
  "notes": "One sentence describing what this does."
}`;

const MAX_BATCH = 8;

/**
 * One prompt for every project whose automatic check failed. `entries` is [{ project, result }] where result is the
 * health-check outcome (what was tried and the output it produced).
 */
async function buildFixPrompt(entries) {
  const take = entries.slice(0, MAX_BATCH);
  const per = Math.max(6000, Math.floor(70000 / Math.max(1, take.length)));
  const sections = [];
  const names = [];
  for (const { project, result } of take) {
    const g = await gather(project, per, 220);
    names.push(project.name);
    const custom = require('./custom').get(project.id);
    sections.push(`################ PROJECT: ${project.name} ################
Repository: ${g.origin.out || '(none)'}
What Streamline tried: ${result.label}${result.detail ? ` (${result.detail})` : ''}${custom ? ' [this was a setup from an earlier ChatGPT reply]' : ''}
What happened: ${result.problem || 'it failed'}
Output from the failed attempt (last lines):
${(result.output || []).map(l => '  ' + clean(l)).join('\n') || '  (no output)'}

FOLDER LISTING
${g.tree}

KEY FILES
${g.blocks.join('\n\n') || '(no recognizable build or config files were found)'}`);
  }
  const prompt = `I have a Windows 10/11 PC. A desktop app called Streamline gives each of my projects a one-click "Play" button. It tried to run the projects below in the background and these ones FAILED. For each one, work out why it failed and how it should really be started, then reply with ONE JSON block that Streamline can apply automatically.

${sections.join('\n\n')}

################ WHAT I NEED ################
Reply with ONLY one JSON code block, no other text before or after it. It must have this shape, with one entry per project, keyed by the exact project name (${names.map(n => `"${n}"`).join(', ')}):

\`\`\`json
{
  "streamline": 2,
  "projects": {
    "${names[0]}": ${JSON_SHAPE.split('\n').join('\n    ')}
  }
}
\`\`\`

RULES FOR EACH PROJECT'S JSON
- "kind" is one of: "command" (run a command, usually a dev server or an app), "open-file" (just open a local .html page; add "file": "path/to/page.html" and leave out "run"), or "exe" (start a program that is already built; add "file": "path/to/app.exe" and leave out "run").
- "needs" lists programs that must already be installed ("exe" is the command name, "install" is a winget command or short instruction).
- "setup" is optional first-time preparation (install dependencies, create a virtual environment, build). Each step has "skipIfExists": a path that, once it exists, means the step can be skipped next time (for example "node_modules" or ".venv"). Use "" if the step must always run.
- "run.cmd" is the single command that starts the project and keeps running. "cwd" is a sub-folder to run in, or "" for the project folder.
- "openUrl" is the web address to open once it is running, or null if nothing should open (desktop apps, command-line tools). Set "opensWindow": true for desktop apps. Set "interactive": true for command-line tools that wait for the user to type (they get their own console window; a hidden run would fail with an input error).
- Every "cmd" must be ONE plain command: no &&, |, >, <, ^, %, ;, quotes, parentheses or $. Use "cwd" instead of "cd". Relative paths only; no absolute paths and no "..".
- Only use well-known tools (npm, pnpm, yarn, bun, node, python, py, pip, uv, poetry, dotnet, cargo, go, flutter, java, mvn, gradle, make, cmake, msbuild, php, ruby and similar), or a .bat/.cmd/.exe that exists inside the project, or "powershell -File script.ps1" for a script in the project. No downloads, no curl, no admin rights.
- Do not create or modify lock files: use "npm ci" if package-lock.json exists, otherwise "npm install --no-package-lock".
- Prefer the development command a developer would use (for example "npm run dev").
- If a project cannot be run without something I must provide (an API key, a database, hardware), give the best JSON you can and explain the catch in "notes".
- If you genuinely cannot tell how to run a project, give that project's entry as: { "streamline": 1, "cannot_run": "short reason", "questions": ["what you need to know"] }
`;
  return { prompt, chars: prompt.length, projects: take.map(e => e.project.id), left: Math.max(0, entries.length - take.length) };
}

module.exports = { buildPrompt, buildFixPrompt, gather, MAX_BATCH };
