// P1 / P4: Worker 内で物体検知の推論を行い、ランタイムとバックエンドごとに時間を測る。
//
// 論点19（単一 ML Worker に集約）の構成に合わせ、推論はすべて Worker で行う。
// UMD ビルドを importScripts で読む。バンドラを挟まないため製品構成とは異なるが、
// 検証したいのは推論が Worker で動くかと所要時間であり、そこには影響しない。

importScripts('/node_modules/onnxruntime-web/dist/ort.all.min.js');
importScripts('/node_modules/@tensorflow/tfjs/dist/tf.min.js');
importScripts('/node_modules/@tensorflow-models/coco-ssd/dist/coco-ssd.min.js');

ort.env.wasm.wasmPaths = '/node_modules/onnxruntime-web/dist/';
ort.env.logLevel = 'error';

const MODEL_URL = '/models/yolos-tiny/model.onnx';
const INPUT_SIZE = 512;      // preprocessor_config.json の shortest_edge に合わせた
const ITERATIONS = 5;
const CONF_THRESHOLD = 0.5;

let labels = null;

function log(...args) {
  self.postMessage({ type: 'log', text: args.join(' ') });
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

// --- 前処理（設計上の Preprocessor 相当・論点20）------------------------------

function toTensor(imageData) {
  const { data, width, height } = imageData;
  const mean = [0.485, 0.456, 0.406];
  const std = [0.229, 0.224, 0.225];
  const out = new Float32Array(3 * width * height);
  const plane = width * height;
  for (let i = 0; i < plane; i++) {
    out[i] = (data[i * 4] / 255 - mean[0]) / std[0];
    out[plane + i] = (data[i * 4 + 1] / 255 - mean[1]) / std[1];
    out[plane * 2 + i] = (data[i * 4 + 2] / 255 - mean[2]) / std[2];
  }
  return new ort.Tensor('float32', out, [1, 3, height, width]);
}

// --- 後処理（設計上の Postprocessor 相当・論点20）-----------------------------

function decode(results, width, height) {
  const logits = results.logits ?? results[Object.keys(results)[0]];
  const boxes = results.pred_boxes ?? results[Object.keys(results)[1]];
  const [, numTokens, numClasses] = logits.dims;
  const detections = [];

  for (let t = 0; t < numTokens; t++) {
    // softmax（最後のクラスは no-object）
    let max = -Infinity;
    for (let c = 0; c < numClasses; c++) max = Math.max(max, logits.data[t * numClasses + c]);
    let sum = 0;
    const probs = new Float32Array(numClasses);
    for (let c = 0; c < numClasses; c++) { probs[c] = Math.exp(logits.data[t * numClasses + c] - max); sum += probs[c]; }

    let best = -1, bestP = 0;
    for (let c = 0; c < numClasses - 1; c++) {
      const p = probs[c] / sum;
      if (p > bestP) { bestP = p; best = c; }
    }
    if (bestP < CONF_THRESHOLD) continue;

    const [cx, cy, w, h] = [0, 1, 2, 3].map((k) => boxes.data[t * 4 + k]);
    detections.push({
      label: labels?.[String(best)] ?? String(best),
      confidence: +bestP.toFixed(3),
      bbox: {
        x: +((cx - w / 2) * width).toFixed(1),
        y: +((cy - h / 2) * height).toFixed(1),
        w: +(w * width).toFixed(1),
        h: +(h * height).toFixed(1),
      },
    });
  }
  return detections.sort((a, b) => b.confidence - a.confidence);
}

// --- ONNX Runtime Web -------------------------------------------------------

async function runOrt(backend, imageData) {
  const result = { runtime: 'onnxruntime-web', backend };
  let session;
  try {
    const t0 = performance.now();
    session = await ort.InferenceSession.create(MODEL_URL, { executionProviders: [backend] });
    result.loadMs = Math.round(performance.now() - t0);
  } catch (err) {
    result.error = String(err?.message ?? err);
    return result;
  }

  try {
    const tensor = toTensor(imageData);
    const feeds = { [session.inputNames[0]]: tensor };

    await session.run(feeds);                       // ウォームアップ
    const times = [];
    let out;
    for (let i = 0; i < ITERATIONS; i++) {
      const t = performance.now();
      out = await session.run(feeds);
      times.push(performance.now() - t);
    }
    result.inferMs = Math.round(median(times));
    result.minMs = Math.round(Math.min(...times));
    result.maxMs = Math.round(Math.max(...times));
    result.inputNames = session.inputNames;
    result.outputNames = session.outputNames;
    result.detections = decode(out, INPUT_SIZE, INPUT_SIZE);
  } catch (err) {
    result.error = String(err?.message ?? err);
  } finally {
    await session.release?.();
  }
  return result;
}

// --- TensorFlow.js ----------------------------------------------------------

async function runTfjs(backend, imageData) {
  const result = { runtime: 'tensorflow.js', backend };
  try {
    await tf.setBackend(backend);
    await tf.ready();
    if (tf.getBackend() !== backend) {
      result.error = `バックエンドを ${backend} にできなかった（実際: ${tf.getBackend()}）`;
      return result;
    }
  } catch (err) {
    result.error = String(err?.message ?? err);
    return result;
  }

  let model;
  try {
    const t0 = performance.now();
    model = await cocoSsd.load({ base: 'lite_mobilenet_v2' });
    result.loadMs = Math.round(performance.now() - t0);
  } catch (err) {
    result.error = 'モデルのロードに失敗: ' + String(err?.message ?? err);
    return result;
  }

  try {
    await model.detect(imageData);                  // ウォームアップ
    const times = [];
    let preds;
    for (let i = 0; i < ITERATIONS; i++) {
      const t = performance.now();
      preds = await model.detect(imageData);
      times.push(performance.now() - t);
    }
    result.inferMs = Math.round(median(times));
    result.minMs = Math.round(Math.min(...times));
    result.maxMs = Math.round(Math.max(...times));
    result.detections = preds.map((p) => ({
      label: p.class,
      confidence: +p.score.toFixed(3),
      bbox: { x: +p.bbox[0].toFixed(1), y: +p.bbox[1].toFixed(1), w: +p.bbox[2].toFixed(1), h: +p.bbox[3].toFixed(1) },
    }));
  } catch (err) {
    result.error = String(err?.message ?? err);
  } finally {
    model?.dispose?.();
  }
  return result;
}

// --- エントリポイント --------------------------------------------------------

self.onmessage = async (e) => {
  const { ortImage, tfImage, labelMap } = e.data;
  labels = labelMap;

  const env = {
    crossOriginIsolated: self.crossOriginIsolated,
    sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
    webgpuInWorker: typeof self.navigator?.gpu !== 'undefined',
    ortWasmThreads: ort.env.wasm.numThreads,
    hardwareConcurrency: navigator.hardwareConcurrency,
  };
  self.postMessage({ type: 'env', env });

  const results = [];
  for (const backend of ['wasm', 'webgpu']) {
    log(`ONNX Runtime Web / ${backend} を実行中…`);
    results.push(await runOrt(backend, ortImage));
  }
  for (const backend of ['webgl', 'cpu']) {
    log(`TensorFlow.js / ${backend} を実行中…`);
    results.push(await runTfjs(backend, tfImage));
  }

  self.postMessage({ type: 'done', results, env });
};
