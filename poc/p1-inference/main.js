// P1 / P4 のメインスレッド側。
//
// 画像を用意して Worker に渡し、結果を表示する。
// 画像はファイル選択があればそれを使い、なければ合成画像で代替する。
// 合成画像では検出が0件になるが、測りたいのは推論時間なので支障はない。

const ORT_SIZE = 512;
const out = document.getElementById('out');
const fileInput = document.getElementById('file');

function log(line, cls = '') {
  console.log('[PoC]', line);
  const el = document.createElement('div');
  el.textContent = line;
  if (cls) el.className = cls;
  out.appendChild(el);
}

async function loadLabels() {
  const config = await (await fetch('/models/yolos-tiny/config.json')).json();
  return config.id2label ?? null;
}

// 合成画像。実写ではないため検出は期待できない。
function syntheticCanvas(w, h) {
  const c = new OffscreenCanvas(w, h);
  const g = c.getContext('2d');
  g.fillStyle = '#8fa6c4'; g.fillRect(0, 0, w, h);
  g.fillStyle = '#4a5c3a'; g.fillRect(0, h * 0.65, w, h * 0.35);
  g.fillStyle = '#2f3540'; g.fillRect(w * 0.15, h * 0.3, w * 0.18, h * 0.4);
  g.fillStyle = '#7a4b3a'; g.beginPath(); g.arc(w * 0.6, h * 0.5, Math.min(w, h) * 0.12, 0, Math.PI * 2); g.fill();
  return c;
}

async function sourceCanvas(file) {
  if (!file) return { canvas: syntheticCanvas(640, 480), kind: '合成画像（検出は期待できない）' };
  const bitmap = await createImageBitmap(file);
  const c = new OffscreenCanvas(bitmap.width, bitmap.height);
  c.getContext('2d').drawImage(bitmap, 0, 0);
  return { canvas: c, kind: `${file.name}（${bitmap.width}x${bitmap.height}）` };
}

function resizeToImageData(canvas, size) {
  const c = new OffscreenCanvas(size, size);
  const g = c.getContext('2d');
  g.drawImage(canvas, 0, 0, size, size);
  return g.getImageData(0, 0, size, size);
}

function row(r) {
  const name = `${r.runtime} / ${r.backend}`.padEnd(32);
  if (r.error) return `${name} 実行できず: ${r.error}`;
  return `${name} load ${String(r.loadMs).padStart(5)}ms  infer ${String(r.inferMs).padStart(5)}ms ` +
         `(min ${r.minMs} / max ${r.maxMs})  検出 ${r.detections.length}件`;
}

async function run(file) {
  out.textContent = '';
  const labelMap = await loadLabels();
  const { canvas, kind } = await sourceCanvas(file);

  log('--- 入力 ---', 'head');
  log(`画像: ${kind}`);
  log(`ONNX 側の入力: ${ORT_SIZE}x${ORT_SIZE}（YOLOS-tiny, shortest_edge=512 に合わせた）`);
  log(`TF.js 側の入力: coco-ssd が内部でリサイズするため元サイズのまま渡す`);

  const ortImage = resizeToImageData(canvas, ORT_SIZE);
  const tfImage = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);

  const worker = new Worker('./infer-worker.js');
  worker.onmessage = (e) => {
    const { type } = e.data;
    if (type === 'log') {
      log(e.data.text);
    } else if (type === 'env') {
      const env = e.data.env;
      log('--- Worker 内の環境 ---', 'head');
      log(`crossOriginIsolated: ${env.crossOriginIsolated}`);
      log(`SharedArrayBuffer: ${env.sharedArrayBuffer}`);
      log(`WebGPU (navigator.gpu): ${env.webgpuInWorker}`);
      log(`ORT WASM スレッド数: ${env.ortWasmThreads} / 論理コア数: ${env.hardwareConcurrency}`);
      log('--- 実行 ---', 'head');
    } else if (type === 'done') {
      log('--- 結果 ---', 'head');
      e.data.results.forEach((r) => log(row(r), r.error ? 'ng' : 'ok'));

      const withDet = e.data.results.filter((r) => !r.error && r.detections.length);
      if (withDet.length) {
        log('--- 検出内容（上位3件）---', 'head');
        withDet.forEach((r) => {
          log(`${r.runtime} / ${r.backend}`);
          r.detections.slice(0, 3).forEach((d) =>
            log(`  ${d.label} ${d.confidence}  bbox(${d.bbox.x}, ${d.bbox.y}, ${d.bbox.w}, ${d.bbox.h})`));
        });
      }
      console.log('[PoC][RESULT]', JSON.stringify({ env: e.data.env, results: e.data.results.map((r) => ({ ...r, detections: r.detections?.length ?? 0 })) }));
      worker.terminate();
    }
  };
  worker.onerror = (err) => {
    log(`Worker が失敗: ${err.message}`, 'ng');
    console.log('[PoC][RESULT] worker error', err.message);
  };
  worker.postMessage({ ortImage, tfImage, labelMap });
}

fileInput.addEventListener('change', () => run(fileInput.files[0]));
run(null);
