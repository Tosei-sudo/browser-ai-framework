// Worker 側の OPFS 操作。
//
// createSyncAccessHandle() は Worker でしか使えないため、
// メインスレッド（createWritable）との比較のためにこちらを用意している。

async function getDir(path) {
  let dir = await navigator.storage.getDirectory();
  for (const seg of path) {
    dir = await dir.getDirectoryHandle(seg, { create: true });
  }
  return dir;
}

async function writeSync(name, buffer) {
  const dir = await getDir(['blobs', 'models']);
  const file = await dir.getFileHandle(name, { create: true });
  const handle = await file.createSyncAccessHandle();
  try {
    handle.truncate(0);
    handle.write(new Uint8Array(buffer), { at: 0 });
    handle.flush();
    return handle.getSize();
  } finally {
    handle.close();
  }
}

async function readSync(name) {
  const dir = await getDir(['blobs', 'models']);
  const file = await dir.getFileHandle(name);
  const handle = await file.createSyncAccessHandle();
  try {
    const size = handle.getSize();
    const buf = new ArrayBuffer(size);
    handle.read(new Uint8Array(buf), { at: 0 });
    return buf;
  } finally {
    handle.close();
  }
}

self.onmessage = async (e) => {
  const { id, op, name, buffer } = e.data;
  try {
    if (op === 'write') {
      const t0 = performance.now();
      const size = await writeSync(name, buffer);
      self.postMessage({ id, ok: true, ms: performance.now() - t0, size });
    } else if (op === 'read') {
      const t0 = performance.now();
      const buf = await readSync(name);
      const ms = performance.now() - t0;
      self.postMessage({ id, ok: true, ms, buffer: buf }, [buf]);
    } else if (op === 'syncAccessSupported') {
      self.postMessage({ id, ok: true, supported: typeof FileSystemFileHandle !== 'undefined' && 'createSyncAccessHandle' in FileSystemFileHandle.prototype });
    }
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.message || err) });
  }
};
