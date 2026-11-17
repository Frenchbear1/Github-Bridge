'use strict';
const fs = require('fs');
const { spawn } = require('child_process');
const { IS_WIN } = require('./util');

function detached(exe, args) {
  try { spawn(exe, args, { windowsHide: true, stdio: 'ignore', detached: true }).unref(); } catch { /* user can open it manually */ }
}

// Opens a web address or a local file in the default app. STREAMLINE_OPEN_LOG is a test hook.
function openUrl(target) {
  const t = String(target);
  if (process.env.STREAMLINE_OPEN_LOG) { fs.appendFileSync(process.env.STREAMLINE_OPEN_LOG, t + '\n'); return; }
  if (IS_WIN) detached('rundll32', ['url.dll,FileProtocolHandler', t]);
  else detached(process.platform === 'darwin' ? 'open' : 'xdg-open', [t]);
}

function openFolderWindow(dir) {
  if (process.env.STREAMLINE_OPEN_LOG) { fs.appendFileSync(process.env.STREAMLINE_OPEN_LOG, 'folder:' + dir + '\n'); return; }
  if (IS_WIN) spawn('explorer.exe', [dir], { stdio: 'ignore', detached: true }).unref();
  else detached(process.platform === 'darwin' ? 'open' : 'xdg-open', [dir]);
}

// Opens Chrome's extensions page (best effort; falls back to the default browser).
function openChromeExtensions() {
  if (process.env.STREAMLINE_OPEN_LOG) { fs.appendFileSync(process.env.STREAMLINE_OPEN_LOG, 'chrome://extensions\n'); return; }
  if (IS_WIN) detached('cmd.exe', ['/d', '/c', 'start', '', 'chrome', 'chrome://extensions']);
}

module.exports = { openUrl, openFolderWindow, openChromeExtensions };
