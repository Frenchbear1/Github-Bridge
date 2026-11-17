'use strict';
const { spawn } = require('child_process');
const { IS_WIN } = require('./util');

// Native Windows file/folder dialogs, opened through a hidden PowerShell (no console window).
const FOLDER = `
Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true; $owner.ShowInTaskbar = $false; $owner.Opacity = 0
$owner.StartPosition = 'CenterScreen'; $owner.Show(); $owner.Activate()
$d = New-Object System.Windows.Forms.FolderBrowserDialog
$d.Description = $env:SL_TITLE
$d.ShowNewFolderButton = $true
if ($env:SL_START -and (Test-Path -LiteralPath $env:SL_START)) { $d.SelectedPath = $env:SL_START }
if ($d.ShowDialog($owner) -eq 'OK') { [Console]::Out.Write($d.SelectedPath) }
$owner.Close()
`;

const FILES = `
Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true; $owner.ShowInTaskbar = $false; $owner.Opacity = 0
$owner.StartPosition = 'CenterScreen'; $owner.Show(); $owner.Activate()
$d = New-Object System.Windows.Forms.OpenFileDialog
$d.Multiselect = $true
$d.Title = $env:SL_TITLE
$d.CheckFileExists = $true
if ($env:SL_START -and (Test-Path -LiteralPath $env:SL_START)) { $d.InitialDirectory = $env:SL_START }
if ($d.ShowDialog($owner) -eq 'OK') { [Console]::Out.Write(($d.FileNames -join "\`n")) }
$owner.Close()
`;

function pick(kind, { start, title } = {}) {
  return new Promise((resolve, reject) => {
    if (!IS_WIN) return reject(Object.assign(new Error('The Browse dialog is only available on Windows. Paste the path instead.'), { status: 501 }));
    const script = kind === 'files' ? FILES : FOLDER;
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const exe = (process.env.SystemRoot || 'C:\\Windows') + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
    const child = spawn(exe, ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      windowsHide: true,
      env: { ...process.env, SL_START: start || '', SL_TITLE: title || (kind === 'files' ? 'Select files' : 'Select a folder') },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', reject);
    child.on('close', () => {
      const paths = out.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      if (!paths.length && err.trim()) return reject(new Error('Dialog failed: ' + err.trim().split('\n')[0]));
      resolve(paths);
    });
  });
}

module.exports = { pick };
