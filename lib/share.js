'use strict';
/**
 * Share: turn a project into something a non-technical person can actually use.
 *
 * You pick what to share (website, GitHub Pages, latest release download, the code on GitHub, or a zip
 * of your copy). Streamline writes a ChatGPT prompt with every real fact it knows (exact links, release
 * files, how the project runs, its README) and asks for ONE friendly, self-contained HTML page that walks
 * people through the simplest way to get it and use it. You paste the reply back and Streamline saves
 * the page (and the zip, if chosen) in "_Share pages" in your projects folder, ready to send.
 */
const fs = require('fs');
const path = require('path');
const store = require('./store');
const jobs = require('./jobs');
const links = require('./links');
const launch = require('./launch');
const { gather } = require('./prompt');
const { makeMatcher } = require('./exclusions');
const { writeZip } = require('./zip');
const { isInside } = require('./util');

const SHARE_DIR = '_Share pages';
const DEVICES = { windows: 'a Windows PC', mac: 'a Mac', phone: 'a phone or tablet', any: 'not sure (could be Windows, Mac or a phone)' };
const mb = n => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const safeName = s => String(s).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').slice(0, 80) || 'Project';

function shareDir(project) {
  const root = store.getSettings().projectsRoot;
  if (root && fs.existsSync(root)) return path.join(root, SHARE_DIR);
  return path.join(path.dirname(path.resolve(project.localPath)), SHARE_DIR);
}
const zipPath = project => path.join(shareDir(project), safeName(project.name) + '.zip');
const pagePath = project => path.join(shareDir(project), safeName(project.name) + ' - How to get it.html');

/* ---------- what can be shared ---------- */
function options(project) {
  const L = links.infoOf(project.id) || {};
  const rel = links.latestRelease(L);
  const asset = rel ? links.runnableAsset(rel) : null;
  const priv = !!L.private;
  const plan = launch.detect(project);
  const items = [];
  if (L.homepage) items.push({ key: 'website', label: 'Website', sub: L.homepage, url: L.homepage, easy: 1 });
  if (L.pages && L.pages.replace(/\/$/, '') !== (L.homepage || '').replace(/\/$/, '')) items.push({ key: 'pages', label: 'GitHub Pages site', sub: L.pages, url: L.pages, easy: 1 });
  if (rel) {
    items.push({
      key: 'release', label: `Download: latest release (${rel.tag})`,
      sub: asset ? `${asset.name}${asset.size ? ' · ' + mb(asset.size) : ''}` : `${rel.assets.length} file${rel.assets.length === 1 ? '' : 's'}: ${rel.assets.map(a => a.name).join(', ') || 'source code only'}`,
      url: rel.url, easy: asset ? 2 : 4,
      warn: priv ? 'This repository is private, so other people cannot download its releases. Make it public on GitHub, or share the zip instead.' : ''
    });
  }
  if (L.repo) {
    items.push({
      key: 'code', label: 'The code on GitHub', sub: L.repo, url: L.repo, easy: 5,
      warn: priv ? 'Private repository: only people you invite on GitHub can see it.' : ''
    });
  }
  items.push({ key: 'zip', label: 'The whole project as a zip file', sub: `Made from your copy (without node_modules, build output, .git and secrets like .env). You send it along with the page.`, easy: plan.kind === 'static' ? 2 : 3 });
  // Recommend the simplest thing that actually works for someone else.
  const usable = items.filter(i => !i.warn);
  const best = usable.sort((a, b) => a.easy - b.easy)[0];
  return { items: items.map(({ easy, ...i }) => i), recommended: best ? [best.key] : ['zip'], private: priv, hasLinks: !!links.infoOf(project.id) };
}

/* ---------- the zip ---------- */
function listFiles(root) {
  const isExcluded = makeMatcher({});
  const out = [];
  let bytes = 0;
  (function rec(dir, rel) {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.name === '.git' || isExcluded(r, e.isDirectory())) continue;
      if (/^(_Share pages|_Set aside)$/.test(e.name) && !rel) continue;
      if (e.isDirectory()) rec(path.join(dir, e.name), r);
      else if (e.isFile()) { out.push(r); try { bytes += fs.statSync(path.join(dir, e.name)).size; } catch { /* skip */ } }
    }
  })(root, '');
  return { files: out, bytes };
}

function startZip(project) {
  const dir = path.resolve(project.localPath);
  if (!fs.existsSync(dir)) throw new Error('The project folder is missing.');
  const out = zipPath(project);
  const job = jobs.create('share', `Zip ${project.name} for sharing`);
  job.set({ projectId: project.id });
  let cancelled = false;
  job.onCancel(() => { cancelled = true; });
  (async () => {
    const { files, bytes } = listFiles(dir);
    if (!files.length) return job.finish('error', 'There are no files to zip.');
    if (files.length > 65000) return job.finish('error', 'The project has too many files to zip.');
    job.log(`Zipping ${files.length} files (${mb(bytes)} before compression)…`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    await writeZip(dir, files, out, safeName(project.name), n => job.progress(`${n} of ${files.length} files`), () => cancelled);
    const size = fs.statSync(out).size;
    job.finish('success', `Saved ${path.basename(out)} (${mb(size)}) in ${SHARE_DIR}.`, { file: out });
  })().catch(e => job.finish(e.cancelled ? 'cancelled' : 'error', e.cancelled ? 'Zip cancelled.' : 'Could not make the zip: ' + e.message));
  return { jobId: job.id, file: out };
}

/* ---------- the ChatGPT prompt ---------- */
async function buildPrompt(project, { items, device, note }) {
  const opts = options(project);
  const chosen = opts.items.filter(i => (items || []).includes(i.key));
  if (!chosen.length) throw new Error('Pick at least one thing to share.');
  const L = links.infoOf(project.id) || {};
  const rel = links.latestRelease(L);
  const { plan, tree, blocks } = await gather(project, 14000, 120);
  const readme = blocks.find(b => /^----- FILE: readme/i.test(b));
  const otherFiles = blocks.filter(b => b !== readme && /package\.json|pyproject|requirements|manifest\.json|\.csproj|Cargo\.toml|go\.mod/i.test(b)).slice(0, 2);
  const devText = DEVICES[device] || DEVICES.windows;

  const shareLines = [];
  for (const i of chosen) {
    if (i.key === 'website' || i.key === 'pages') shareLines.push(`- ${i.label}: ${i.url}`);
    if (i.key === 'release' && rel) {
      shareLines.push(`- Latest release ${rel.tag} (release page: ${rel.url})`);
      for (const a of rel.assets) shareLines.push(`    file: ${a.name}${a.size ? ` (${mb(a.size)})` : ''} -> direct download link: ${a.url}`);
      if (!rel.assets.length) shareLines.push('    (no files attached, only the source code)');
    }
    if (i.key === 'code') {
      shareLines.push(`- The code on GitHub: ${i.url}`);
      shareLines.push(`    one-click download of the code as a zip: ${i.url}/archive/HEAD.zip`);
    }
    if (i.key === 'zip') shareLines.push(`- A zip file I will send them together with this page, named exactly "${path.basename(zipPath(project))}". It contains a folder named "${safeName(project.name)}" with the project's files. (There is no link for it; refer to it as "the zip file that came with this page".)`);
    if (i.warn) shareLines.push(`    WARNING: ${i.warn} Do not rely on this link working for them.`);
  }

  const prereqs = ((plan.recipe && plan.recipe.prereqs) || []).map(p => p.name || p.exe).filter(Boolean);
  const how = [
    `How it runs on my computer (detected by my tool): ${plan.label}${plan.detail ? ' — ' + plan.detail : ''}${plan.canPlay ? '' : ' (no simple run step found)'}`,
    plan.kind ? `Project type: ${plan.kind}` : '',
    prereqs.length ? `Needs installed to run from the files: ${prereqs.join(', ')}` : '',
    plan.port ? `It runs as a local web page (port ${plan.port}).` : '',
    plan.desktop ? 'It opens as a desktop window.' : ''
  ].filter(Boolean);

  const text = `I want to share my project "${project.name}" with people who are NOT technical. They have never used GitHub, code, a terminal or a command prompt. I will send them ONE web page (an HTML file) that you write, and it must walk them through getting it and using it, step by step.

=== WHAT I AM SHARING ===
${shareLines.join('\n')}

=== THEIR DEVICE ===
${devText}
${note ? `\n=== A NOTE FROM ME ===\n${String(note).slice(0, 1500)}\n` : ''}
=== ABOUT THE PROJECT ===
Name: ${project.name}
${L.description ? `GitHub description: ${L.description}\n` : ''}${how.join('\n')}
${L.private ? 'The GitHub repository is PRIVATE: GitHub links (code, releases) will not open for them.\n' : ''}
Files in the project (partial):
${tree.split('\n').slice(0, 60).join('\n')}

${readme || '(no README)'}
${otherFiles.join('\n\n')}

=== YOUR JOB ===
1. Choose the SIMPLEST way for them, using only what I am sharing above. From easiest to hardest:
   a) A website link: they just click it. If it is a web app, tell them how to bookmark it or add it to their home screen.
   b) A ready-made download (an installer .exe/.msi, a portable .exe, or a .zip with an .exe inside): download, open, done.
   c) Only if nothing simpler exists: the project files, with the fewest possible steps. Prefer things they can click (double-click a file, run an installer with Next buttons, e.g. the "LTS" installer from nodejs.org) over typing commands. Never use git, "clone", package managers like winget/npm/pip for installing tools, or developer jargon. If a command really cannot be avoided, give exactly one copy-paste box and say exactly where to paste it and how to open that place.
   If I picked something much harder than another option I listed, put a one-line note for ME before the HTML (outside the code block) saying which option would be easier.
2. Write for a beginner: short sentences, numbered steps, one action per step, bold the exact button and file names, and say what they will see on screen (for example the blue "Windows protected your PC" box: click "More info" then "Run anyway"; a browser saying the file "isn't commonly downloaded": click "Keep"; "Extract all" for zip files).
3. The page should contain:
   - A friendly title and one sentence on what "${project.name}" is and why they would want it (from the README; do not invent features).
   - Big, obvious buttons for each link/download, using the EXACT URLs above (direct download links for files).
   - "Get it" steps for ${devText}${device === 'any' ? ', with a short separate section per device type where it differs' : ''}.
   - "How to use it": the few things they need to know to start, from the README.
   - "If something goes wrong": the 3 most likely problems for this method and the fix for each.
   - How to update it or remove it, if that applies.
4. Use ONLY the links, file names and facts given here. Never invent URLs, version numbers, features or settings. Leave out anything you are unsure of.
5. Format: reply with ONE complete HTML document in a single \`\`\`html code block, starting with <!DOCTYPE html>. Make it self-contained (all CSS inline in a <style> tag; no external fonts, scripts, images or CDNs) so it works when opened straight from a file. Clean, friendly design, large readable text, works on phones. JavaScript is optional and only for small conveniences like copy buttons.`;
  return { prompt: text, chars: text.length, zip: chosen.some(i => i.key === 'zip') ? path.basename(zipPath(project)) : null };
}

/* ---------- saving ChatGPT's page ---------- */
function extractHtml(reply) {
  const s = String(reply || '');
  const fenced = s.match(/```(?:html)?\s*\n([\s\S]*?)```/i);
  let html = (fenced ? fenced[1] : s).trim();
  const start = html.search(/<!DOCTYPE html|<html[\s>]/i);
  if (start > 0) html = html.slice(start);
  const end = html.toLowerCase().lastIndexOf('</html>');
  if (end > 0) html = html.slice(0, end + 7);
  if (!/^(<!DOCTYPE html|<html[\s>])/i.test(html) || !/<\/html>\s*$/i.test(html)) {
    throw new Error('That does not look like a complete web page. Paste ChatGPT\'s whole reply (it should contain a block starting with <!DOCTYPE html> and ending with </html>). If its reply was cut off, ask it to "continue" and paste the full code.');
  }
  if (html.length > 3 * 1024 * 1024) throw new Error('The page is too large.');
  const note = fenced ? s.slice(0, s.indexOf(fenced[0])).trim() : '';
  return { html, note: note.slice(0, 600) };
}

function savePage(project, reply) {
  const { html, note } = extractHtml(reply);
  const file = pagePath(project);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, html);
  const zip = zipPath(project);
  return { file, zip: fs.existsSync(zip) ? zip : null, note, folder: path.dirname(file) };
}

function checkShareFile(file) {
  const f = path.resolve(String(file || ''));
  const okRoot = store.getProjects().map(shareDir).concat(store.getSettings().projectsRoot ? [path.join(store.getSettings().projectsRoot, SHARE_DIR)] : []);
  if (!okRoot.some(r => isInside(r, f)) || !fs.existsSync(f)) throw new Error('That file is not in a share folder.');
  return f;
}

module.exports = { options, buildPrompt, startZip, savePage, extractHtml, checkShareFile, zipPath, pagePath, listFiles };
