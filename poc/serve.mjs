// PoC 用の静的配信サーバー。
//
// COOP / COEP ヘッダの有無を切り替えられるようにしてある（論点34）。
// SharedArrayBuffer が必要かどうかの検証で使う。
//
//   node poc/serve.mjs              … ヘッダなし
//   node poc/serve.mjs --isolated   … COOP / COEP あり（crossOriginIsolated = true）

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT ?? 8123);
const ISOLATED = process.argv.includes('--isolated');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.css': 'text/css; charset=utf-8',
  '.onnx': 'application/octet-stream',
  '.bin': 'application/octet-stream',
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  // normalize() は Windows で区切りを \ に変えるため、末尾スラッシュの判定を先に行う。
  let path = decodeURIComponent(url.pathname);
  if (path.endsWith('/')) path += 'index.html';
  path = normalize(path).replace(/^(\.\.[/\\])+/, '');

  const headers = { 'Cache-Control': 'no-store' };
  if (ISOLATED) {
    headers['Cross-Origin-Opener-Policy'] = 'same-origin';
    headers['Cross-Origin-Embedder-Policy'] = 'require-corp';
    headers['Cross-Origin-Resource-Policy'] = 'same-origin';
  }

  try {
    const body = await readFile(join(ROOT, path));
    res.writeHead(200, { ...headers, 'Content-Type': MIME[extname(path)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { ...headers, 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found: ' + path);
  }
});

server.listen(PORT, () => {
  console.log(`[serve] http://localhost:${PORT}/  isolated=${ISOLATED}`);
  console.log(`[serve] P5: http://localhost:${PORT}/p5-opfs/`);
});
