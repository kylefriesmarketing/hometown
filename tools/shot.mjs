// shot.mjs — catch a screenshot the page takes of itself.
//
// WHY: the Browser pane never composites a WebGL page, so the built-in
// screenshot tools time out and the canvas reports 0×0. But a WebGL drawing
// buffer is only cleared on COMPOSITE — so render() followed by toDataURL()
// *in the same synchronous task* returns real pixels. This catches the result
// and writes a PNG we can actually look at.
//
// RUN:  node tools/shot.mjs [port] [outDir]
//
// THEN, in the page console (all one statement — the same task is the point):
//   __htShot('name')
// which main.js defines. Never pipe base64 back through a tool result.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PORT = Number(process.argv[2] || 8398);
const OUT = process.argv[3] || path.join(os.tmpdir(), 'hometown-shots');
fs.mkdirSync(OUT, { recursive: true });

http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
  if (req.method !== 'POST') { res.writeHead(200).end('hometown shot receiver'); return; }

  const name = (new URL(req.url, 'http://x').searchParams.get('name') || 'shot')
    .replace(/[^a-z0-9_-]/gi, '_');
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    const b64 = body.replace(/^data:image\/\w+;base64,/, '');
    const file = path.join(OUT, `${name}.png`);
    fs.writeFileSync(file, Buffer.from(b64, 'base64'));
    console.log(`${file}  (${(fs.statSync(file).size / 1024).toFixed(0)} KB)`);
    res.writeHead(200).end('ok');
  });
}).listen(PORT, () => console.log(`shot receiver -> :${PORT}  writing to ${OUT}`));
