#!/usr/bin/env node
// A stand-in for the GitHub CLI used by the sync tests. Reads repos from FAKEGH_DIR/repos.json.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const dir = process.env.FAKEGH_DIR;
const a = process.argv.slice(2);
const repos = () => JSON.parse(fs.readFileSync(path.join(dir, 'repos.json'), 'utf8'));
if (a[0] === 'auth' && a[1] === 'status') {
  if (process.env.FAKEGH_SIGNED_OUT) { console.error('You are not logged into any GitHub hosts. To log in, run: gh auth login'); process.exit(1); }
  console.log('github.com\n  ✓ Logged in to github.com account tester (keyring)'); process.exit(0);
}
if (a[0] === 'repo' && a[1] === 'list') {
  if (process.env.FAKEGH_LIST_FAIL) { console.error('network down'); process.exit(1); }
  console.log(JSON.stringify(repos().map(r => ({ name: r.name, nameWithOwner: 'tester/' + r.name, isArchived: !!r.archived, defaultBranchRef: { name: 'main' }, url: path.join(dir, 'remotes', r.name) }))));
  process.exit(0);
}
if (a[0] === 'api' && a[1] === 'graphql' && a.join(' ').includes('homepageUrl')) {
  const q = a.join(' ');
  const data = {};
  for (const m of q.matchAll(/(r\d+):repository\(owner:"[^"]+",name:"([^"]+)"\)/g)) {
    const r = repos().find(x => x.name === m[2]);
    if (!r) { data[m[1]] = null; continue; }
    data[m[1]] = { homepageUrl: r.homepage || null, url: 'https://github.com/tester/' + r.name,
      deployments: { nodes: r.pages ? [{ latestStatus: { environmentUrl: r.pages, state: 'ACTIVE' } }] : [] },
      releases: { totalCount: (r.releases || []).length, nodes: (r.releases || []).map(x => ({ name: x.tag, tagName: x.tag, url: 'https://github.com/tester/' + r.name + '/releases/tag/' + x.tag, publishedAt: '2026-01-01T00:00:00Z', isPrerelease: false, isDraft: false, releaseAssets: { nodes: x.assets.map(n => ({ name: n, downloadUrl: 'https://example.invalid/' + n, size: 10 })) } })) } };
  }
  console.log(JSON.stringify({ data })); process.exit(0);
}
if (a[0] === 'release' && a[1] === 'download') {
  const dest = a[a.indexOf('-D') + 1], name = a[a.indexOf('-p') + 1];
  fs.writeFileSync(path.join(dest, name), '#!/bin/sh\necho ran > "' + path.join(dir, 'RELEASE_RAN') + '"\n');
  process.exit(0);
}
if (a[0] === 'api' && a[1] === 'graphql') {
  if (process.env.FAKEGH_GRAPHQL_FAIL) { console.error('graphql down'); process.exit(1); }
  const q = a.join(' ');
  const data = {};
  for (const m of q.matchAll(/(r\d+):repository\(owner:"[^"]+",name:"([^"]+)"\)/g)) {
    let oid = null;
    try { oid = execFileSync('git', ['--git-dir', path.join(dir, 'remotes', m[2] + '.git'), 'rev-parse', 'refs/heads/main'], { encoding: 'utf8' }).trim(); } catch { /* none */ }
    data[m[1]] = { ref: oid ? { target: { oid } } : null };
  }
  console.log(JSON.stringify({ data })); process.exit(0);
}
console.error('fakegh: unsupported ' + a.join(' ')); process.exit(2);
