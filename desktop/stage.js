'use strict';
// Copies the Streamline server (kept dependency-free in the repo root) into ./server so electron-builder can package it.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const out = path.join(__dirname, 'server');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
for (const item of ['server.js', 'lib', 'public']) fs.cpSync(path.join(root, item), path.join(out, item), { recursive: true });
fs.writeFileSync(path.join(out, 'package.json'), JSON.stringify({ name: 'streamline-server', version: '1.0.0', private: true }, null, 2));
console.log('Staged server into', out);
