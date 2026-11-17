'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const store = require('./lib/store');
const jobs = require('./lib/jobs');
const repo = require('./lib/repo');
const clone = require('./lib/clone');
const upload = require('./lib/upload');
const sync = require('./lib/sync');
const auth = require('./lib/auth');
const picker = require('./lib/picker');
const launch = require('./lib/launch');
const { openUrl, openFolderWindow } = require('./lib/open');
const { DEFAULTS } = require('./lib/exclusions');
const { gitExe, ghExe, run } = require('./lib/proc');
const { IS_WIN } = require('./lib/util');
const pkg = require('./package.json');

const PORT = Number(process.env.PORT) || 4545;
const HOST = '127.0.0.1'; // loopback only: never reachable from the network
const PUBLIC = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png' };

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > 1024 * 1024) { reject(new HttpError(413, 'Request too large.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new HttpError(400, 'Invalid JSON.')); }
    });
    req.on('error', reject);
  });
}

// Blocks DNS-rebinding and cross-site requests from other web pages against this local server.
function guard(req) {
  const host = String(req.headers.host || '').toLowerCase();
  const okHosts = [`localhost:${PORT}`, `127.0.0.1:${PORT}`];
  if (!okHosts.includes(host)) throw new HttpError(403, 'Forbidden host.');
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    if (req.headers['x-streamline'] !== '1') throw new HttpError(403, 'Missing request header.');
    const origin = req.headers.origin;
    if (origin && !okHosts.map(h => 'http://' + h).includes(origin.toLowerCase())) throw new HttpError(403, 'Forbidden origin.');
  }
}

function findProject(id) {
  const p = store.getProjects().find(x => x.id === id);
  if (!p) throw new HttpError(404, 'Saved project not found.');
  return p;
}

function openFolder(dir) {
  if (!fs.existsSync(dir)) throw new HttpError(404, 'Folder not found.');
  openFolderWindow(dir);
}

function validSettings(b) {
  const out = {};
  if (b.projectsRoot !== undefined) out.projectsRoot = String(b.projectsRoot).trim();
  if (b.syncScript !== undefined) out.syncScript = String(b.syncScript).trim();
  if (b.maxFileMB !== undefined) {
    const n = Number(b.maxFileMB);
    if (!Number.isFinite(n) || n < 1 || n > 100) throw new HttpError(400, 'Max file size must be between 1 and 100 MB.');
    out.maxFileMB = n;
  }
  if (b.customExclusions !== undefined) {
    if (!Array.isArray(b.customExclusions)) throw new HttpError(400, 'customExclusions must be a list.');
    out.customExclusions = b.customExclusions.map(s => String(s).trim()).filter(Boolean).slice(0, 200);
  }
  if (b.disabledDefaults !== undefined) {
    if (!Array.isArray(b.disabledDefaults)) throw new HttpError(400, 'disabledDefaults must be a list.');
    const valid = new Set(DEFAULTS.filter(d => !d.locked).map(d => d.id));
    out.disabledDefaults = b.disabledDefaults.filter(id => valid.has(id));
  }
  return out;
}

const routes = {
  'GET /api/state': async () => {
    const settings = store.getSettings();
    const [a, g] = await Promise.all([auth.status(false), run(gitExe(), ['--version'])]);
    return {
      version: pkg.version,
      platform: process.platform,
      settings,
      defaults: DEFAULTS.map(({ id, glob, why, locked }) => ({ id, glob, why, locked: !!locked })),
      projects: store.getProjects().map(p => ({ ...p, exists: fs.existsSync(p.localPath) })),
      auth: a,
      git: { found: g.code === 0, version: g.out },
      syncScriptFound: !!settings.syncScript && fs.existsSync(settings.syncScript),
      syncRunning: !!jobs.runningOfType('sync')
    };
  },
  'GET /api/auth': async () => auth.status(true),
  'POST /api/auth/login': async () => ({ jobId: auth.startLogin() }),

  'PUT /api/settings': async ({ body }) => ({ settings: store.saveSettings(validSettings(body)) }),

  'GET /api/jobs': async () => ({ jobs: jobs.list() }),
  'POST /api/jobs/clear': async () => { jobs.clearFinished(); return { ok: true }; },

  'POST /api/clone': async ({ body }) => ({ jobId: clone.startClone({ url: body.url, parent: body.parent }) }),

  'POST /api/projects': async ({ body }) => {
    const dir = path.resolve(String(body.localPath || ''));
    if (!body.localPath || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new HttpError(400, 'Folder not found.');
    const info = await repo.repoInfo(dir);
    if (!info) throw new HttpError(400, 'That folder is not the root of a Git repository.');
    return { project: repo.upsertProject({ name: path.basename(dir), url: info.url, localPath: dir, branch: info.branch }) };
  },
  'POST /api/projects/scan': async ({ body }) => {
    const root = path.resolve(String(body.root || store.getSettings().projectsRoot || ''));
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new HttpError(400, 'Projects folder not found. Set it in Settings.');
    return repo.scanFolder(root);
  },

  'POST /api/pick': async ({ body }) => {
    const kind = body.kind === 'files' ? 'files' : 'folder';
    return { paths: await picker.pick(kind, { start: body.start, title: body.title }) };
  },

  'POST /api/upload/preview': async ({ body }) => upload.preview({ project: findProject(body.projectId), items: body.items, subfolder: body.subfolder }),
  'POST /api/upload': async ({ body }) => {
    const project = findProject(body.projectId);
    if (!Array.isArray(body.items) || !body.items.length) throw new HttpError(400, 'Add at least one file or folder.');
    return { jobId: upload.startUpload({ project, items: body.items, subfolder: body.subfolder, message: body.message }) };
  },

  'GET /api/play': async () => {
    const plans = {};
    const running = {};
    for (const p of store.getProjects()) {
      plans[p.id] = launch.summary(launch.detect(p));
      const j = launch.runningJob(p.id);
      if (j) running[p.id] = j.id;
    }
    return { plans, running };
  },

  'POST /api/quit': async () => {
    // Lets you stop the app from the browser (or Stop-Streamline.vbs) without any console window.
    setTimeout(() => process.exit(0), 150);
    return { ok: true };
  },

  'POST /api/sync': async () => ({ jobId: sync.startSync() })
};

async function handleApi(req, res, url) {
  const body = req.method === 'GET' || req.method === 'DELETE' ? {} : await readBody(req);
  const key = `${req.method} ${url.pathname}`;
  if (routes[key]) return send(res, 200, await routes[key]({ body, url }));

  let m;
  if ((m = url.pathname.match(/^\/api\/projects\/([a-f0-9]+)$/)) && req.method === 'DELETE') {
    return send(res, 200, { removed: repo.removeProject(m[1]) });
  }
  if ((m = url.pathname.match(/^\/api\/projects\/([a-f0-9]+)\/pull$/)) && req.method === 'POST') {
    return send(res, 200, { jobId: clone.startPull(findProject(m[1])) });
  }
  if ((m = url.pathname.match(/^\/api\/projects\/([a-f0-9]+)\/play$/)) && req.method === 'POST') {
    return send(res, 200, { jobId: launch.start(findProject(m[1])) });
  }
  if ((m = url.pathname.match(/^\/api\/projects\/([a-f0-9]+)\/stop$/)) && req.method === 'POST') {
    return send(res, 200, { stopped: launch.stop(findProject(m[1])) });
  }
  if ((m = url.pathname.match(/^\/api\/projects\/([a-f0-9]+)\/open$/)) && req.method === 'POST') {
    openFolder(findProject(m[1]).localPath);
    return send(res, 200, { ok: true });
  }
  if ((m = url.pathname.match(/^\/api\/jobs\/([a-f0-9]+)\/lines$/)) && req.method === 'GET') {
    const lines = jobs.lines(m[1]);
    if (!lines) throw new HttpError(404, 'Job not found.');
    return send(res, 200, { lines });
  }
  if ((m = url.pathname.match(/^\/api\/jobs\/([a-f0-9]+)\/cancel$/)) && req.method === 'POST') {
    return send(res, 200, { cancelled: jobs.cancel(m[1]) });
  }
  throw new HttpError(404, 'Not found.');
}

function handleEvents(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
  res.write('retry: 2000\n\n');
  const onJob = j => res.write(`event: job\ndata: ${JSON.stringify(j)}\n\n`);
  const onLine = l => res.write(`event: line\ndata: ${JSON.stringify(l)}\n\n`);
  const onCleared = () => res.write('event: cleared\ndata: {}\n\n');
  jobs.bus.on('job', onJob); jobs.bus.on('line', onLine); jobs.bus.on('cleared', onCleared);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { clearInterval(ping); jobs.bus.off('job', onJob); jobs.bus.off('line', onLine); jobs.bus.off('cleared', onCleared); });
}

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found');
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'"
  });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    guard(req);
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === '/api/events') return handleEvents(req, res);
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return serveStatic(req, res, url);
  } catch (e) {
    // Validation problems (bad URL, missing folder, ...) are reported as 400; HttpError carries its own status.
    const status = e.status || 400;
    if (!e.status) console.error('[streamline]', e.message);
    if (!res.headersSent) send(res, status, { error: e.message || 'Something went wrong.' });
    else res.end();
  }
});

function openBrowser(port) { openUrl(`http://localhost:${port}/`); }

server.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    console.log(`Streamline is already running on port ${PORT}.`);
    if (process.argv.includes('--open')) openBrowser(PORT);
    process.exit(0);
  }
  console.error(e);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`Streamline ${pkg.version} running at http://localhost:${PORT}/  (git: ${gitExe()}, gh: ${ghExe()})`);
  if (process.argv.includes('--open')) openBrowser(PORT);
});
