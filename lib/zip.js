'use strict';
/** A small zip writer (deflate, no dependencies), so a project folder can be shared as one file. */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) { let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }

function dosTime(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: (Math.max(d.getFullYear() - 1980, 0) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  };
}

const LIMIT = 0xFFFFFFFF - 1024 * 1024; // no Zip64: stay under 4 GB

/**
 * Writes `files` (paths relative to `root`, "/" separated) into `out`, under a top folder `prefix/`.
 * onProgress(doneCount) is called as files are added. Writes to a temp file first.
 */
async function writeZip(root, files, out, prefix, onProgress, isCancelled) {
  const tmp = out + '.partial';
  const fd = fs.openSync(tmp, 'w');
  const central = [];
  let offset = 0;
  const write = buf => { fs.writeSync(fd, buf); offset += buf.length; };
  try {
    for (let i = 0; i < files.length; i++) {
      if (isCancelled && isCancelled()) throw Object.assign(new Error('cancelled'), { cancelled: true });
      const rel = files[i];
      const full = path.join(root, ...rel.split('/'));
      const st = fs.statSync(full);
      const data = fs.readFileSync(full);
      const deflated = zlib.deflateRawSync(data, { level: 6 });
      const useStore = deflated.length >= data.length;
      const body = useStore ? data : deflated;
      const name = Buffer.from((prefix ? prefix + '/' : '') + rel, 'utf8');
      const crc = crc32(data);
      const { time, date } = dosTime(st.mtime);
      if (offset + body.length + name.length + 30 > LIMIT) throw new Error('The project is too big to zip (over 4 GB).');
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
      local.writeUInt16LE(useStore ? 0 : 8, 8); local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12);
      local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22);
      local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
      const at = offset;
      write(local); write(name); write(body);
      const c = Buffer.alloc(46);
      c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8);
      c.writeUInt16LE(useStore ? 0 : 8, 10); c.writeUInt16LE(time, 12); c.writeUInt16LE(date, 14);
      c.writeUInt32LE(crc, 16); c.writeUInt32LE(body.length, 20); c.writeUInt32LE(data.length, 24);
      c.writeUInt16LE(name.length, 28); c.writeUInt32LE(at, 42);
      central.push(Buffer.concat([c, name]));
      if (onProgress && (i % 25 === 0 || i === files.length - 1)) onProgress(i + 1);
      if (i % 50 === 0) await new Promise(r => setImmediate(r)); // keep the server responsive
    }
    const cdStart = offset;
    for (const c of central) write(c);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length, 8); end.writeUInt16LE(central.length, 10);
    end.writeUInt32LE(offset - cdStart, 12); end.writeUInt32LE(cdStart, 16);
    write(end);
    fs.closeSync(fd);
    fs.renameSync(tmp, out);
  } catch (e) {
    try { fs.closeSync(fd); } catch { /* already closed */ }
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

module.exports = { writeZip, crc32 };
