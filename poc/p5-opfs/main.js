// P5: 学習済み重みを ArrayBuffer として OPFS に保存し、読み戻せるか。
//
// 04-storage-design.md の前提を確認する。
//   - ArrayBuffer の往復（論点25）
//   - 数十MB の書き込み・読み出しにかかる時間
//   - ディレクトリ列挙による孤児ファイル検出（論点27）
//   - checksum の算出（ModelArtifact.checksum, 方針6）
//   - navigator.storage.estimate() / persist()（論点23・26）

const SIZES_MB = [5, 20, 60];
const out = document.getElementById('out');
const results = [];

function log(line, cls = '') {
  console.log('[PoC]', line);
  const el = document.createElement('div');
  el.textContent = line;
  if (cls) el.className = cls;
  out.appendChild(el);
}

function mb(bytes) {
  return (bytes / 1024 / 1024).toFixed(1) + 'MB';
}

function rate(bytes, ms) {
  return ms > 0 ? (bytes / 1024 / 1024 / (ms / 1000)).toFixed(0) + 'MB/s' : '-';
}

// 決定的な擬似ランダム。crypto.getRandomValues は 64KB ずつしか埋められず遅いため。
function makeBuffer(bytes) {
  const buf = new ArrayBuffer(bytes);
  const view = new Uint32Array(buf);
  let x = 0x12345678;
  for (let i = 0; i < view.length; i++) {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    view[i] = x;
  }
  return buf;
}

async function sha256(buffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function getDir(path, create = true) {
  let dir = await navigator.storage.getDirectory();
  for (const seg of path) dir = await dir.getDirectoryHandle(seg, { create });
  return dir;
}

// --- Worker 呼び出し -------------------------------------------------------

const worker = new Worker('./opfs-worker.js');
let seq = 0;
const pending = new Map();
worker.onmessage = (e) => {
  const { id } = e.data;
  const resolve = pending.get(id);
  if (resolve) { pending.delete(id); resolve(e.data); }
};
function callWorker(msg, transfer = []) {
  const id = ++seq;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    worker.postMessage({ ...msg, id }, transfer);
  });
}

// --- 検証 ------------------------------------------------------------------

async function checkEnvironment() {
  log('--- 環境 ---', 'head');
  log(`crossOriginIsolated: ${self.crossOriginIsolated}`);
  log(`OPFS (navigator.storage.getDirectory): ${typeof navigator.storage?.getDirectory === 'function'}`);
  log(`SharedArrayBuffer: ${typeof SharedArrayBuffer !== 'undefined'}`);
  log(`WebGPU (navigator.gpu): ${typeof navigator.gpu !== 'undefined'}`);

  const sync = await callWorker({ op: 'syncAccessSupported' });
  log(`createSyncAccessHandle (Worker): ${sync.supported}`);

  const est = await navigator.storage.estimate();
  log(`estimate: usage=${mb(est.usage ?? 0)} quota=${mb(est.quota ?? 0)}`);
  results.push({ item: 'quota', value: mb(est.quota ?? 0) });

  const persisted = await navigator.storage.persisted();
  log(`persisted (要求前): ${persisted}`);
  const granted = persisted ? true : await navigator.storage.persist();
  log(`persist() の結果: ${granted}`, granted ? 'ok' : 'warn');
  results.push({ item: 'persist', value: String(granted) });
}

async function roundTrip(sizeMb, mode) {
  const bytes = sizeMb * 1024 * 1024;
  const name = `poc-${mode}-${sizeMb}mb.bin`;
  const src = makeBuffer(bytes);
  const srcSum = await sha256(src);

  let writeMs, readMs, readBuf;

  if (mode === 'main') {
    const dir = await getDir(['blobs', 'models']);
    const file = await dir.getFileHandle(name, { create: true });
    let t0 = performance.now();
    const w = await file.createWritable();
    await w.write(src);
    await w.close();
    writeMs = performance.now() - t0;

    t0 = performance.now();
    readBuf = await (await file.getFile()).arrayBuffer();
    readMs = performance.now() - t0;
  } else {
    const copy = src.slice(0);
    const wres = await callWorker({ op: 'write', name, buffer: copy }, [copy]);
    if (!wres.ok) throw new Error(wres.error);
    writeMs = wres.ms;

    const rres = await callWorker({ op: 'read', name });
    if (!rres.ok) throw new Error(rres.error);
    readMs = rres.ms;
    readBuf = rres.buffer;
  }

  const dstSum = await sha256(readBuf);
  const ok = srcSum === dstSum && readBuf.byteLength === bytes;
  log(
    `${mode.padEnd(6)} ${String(sizeMb).padStart(3)}MB  write ${writeMs.toFixed(0).padStart(5)}ms (${rate(bytes, writeMs)})  ` +
    `read ${readMs.toFixed(0).padStart(5)}ms (${rate(bytes, readMs)})  整合性 ${ok ? 'OK' : 'NG'}`,
    ok ? 'ok' : 'ng'
  );
  results.push({ item: `${mode} ${sizeMb}MB`, write: Math.round(writeMs), read: Math.round(readMs), ok });
  return ok;
}

async function checkListing() {
  log('--- ディレクトリ列挙（孤児ファイル検出の実現性・論点27）---', 'head');
  const dir = await getDir(['blobs', 'models']);
  const names = [];
  for await (const [name, handle] of dir.entries()) {
    const size = handle.kind === 'file' ? (await handle.getFile()).size : 0;
    names.push(`${name} (${mb(size)})`);
  }
  log(`列挙できたファイル: ${names.length}件`);
  names.forEach((n) => log('  ' + n));
  results.push({ item: 'listing', value: `${names.length}件` });
  return names.length;
}

async function cleanup() {
  log('--- 後片付け ---', 'head');
  const dir = await getDir(['blobs', 'models']);
  let removed = 0;
  const targets = [];
  for await (const name of dir.keys()) if (name.startsWith('poc-')) targets.push(name);
  for (const name of targets) { await dir.removeEntry(name); removed++; }
  log(`削除: ${removed}件`);
  const est = await navigator.storage.estimate();
  log(`estimate（削除後）: usage=${mb(est.usage ?? 0)}`);
}

async function main() {
  const t0 = performance.now();
  try {
    await checkEnvironment();

    log('--- ArrayBuffer の往復（メインスレッド: createWritable）---', 'head');
    for (const s of SIZES_MB) await roundTrip(s, 'main');

    log('--- ArrayBuffer の往復（Worker: createSyncAccessHandle）---', 'head');
    for (const s of SIZES_MB) await roundTrip(s, 'worker');

    await checkListing();
    await cleanup();

    const failed = results.filter((r) => r.ok === false);
    log(`--- 結果: ${failed.length === 0 ? 'すべて成功' : failed.length + '件失敗'}（${((performance.now() - t0) / 1000).toFixed(1)}秒）---`,
      failed.length === 0 ? 'ok head' : 'ng head');
    console.log('[PoC][RESULT]', JSON.stringify(results));
  } catch (err) {
    log(`失敗: ${err && err.stack || err}`, 'ng');
    console.log('[PoC][RESULT] error', String(err));
  }
}

main();
