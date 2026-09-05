// P2 / P3: ブラウザ内での転移学習が成立するか、どれくらい時間がかかるか。
//
// 構成（論点33・方針3の frozen_layers に対応）:
//   MobileNet v2 を凍結したバックボーンとして使い、その特徴量に対して
//   検出ヘッドだけを学習する。ヘッドは単一ボックス回帰で、精度そのものは問わない。
//   確かめたいのは「学習ループが Worker 内で回るか」「1 epoch 何秒か」
//   「メモリが持つか」「学習した重みを取り出して保存できるか」の4点。
//
// バックボーンが凍結されているため、特徴量は一度計算すれば変わらない。
// 実アプリでも同じ最適化ができるため、特徴量を先に全件計算してから
// ヘッドを学習する構成にしている。

importScripts('/node_modules/@tensorflow/tfjs/dist/tf.min.js');
importScripts('/node_modules/@tensorflow-models/mobilenet/dist/mobilenet.min.js');

const IMAGE_SIZE = 224;      // MobileNet の入力
const EPOCHS = 30;
const BATCH_SIZE = 16;
const VAL_RATIO = 0.2;

function log(...args) {
  self.postMessage({ type: 'log', text: args.join(' ') });
}

function progress(payload) {
  self.postMessage({ type: 'progress', ...payload });
}

function memMB() {
  const m = tf.memory();
  return {
    tensors: m.numTensors,
    mb: +(m.numBytes / 1024 / 1024).toFixed(1),
  };
}

// --- データの読み込み --------------------------------------------------------

async function loadImageTensor(url) {
  const blob = await (await fetch(url)).blob();
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(IMAGE_SIZE, IMAGE_SIZE);
  const g = canvas.getContext('2d');
  g.drawImage(bitmap, 0, 0, IMAGE_SIZE, IMAGE_SIZE);
  bitmap.close();
  const imageData = g.getImageData(0, 0, IMAGE_SIZE, IMAGE_SIZE);
  return tf.tidy(() => tf.browser.fromPixels(imageData).toFloat().div(255));
}

// --- 特徴量の事前計算（バックボーン凍結）--------------------------------------

async function extractFeatures(samples, backbone) {
  const feats = [];
  const t0 = performance.now();
  for (let i = 0; i < samples.length; i++) {
    const img = await loadImageTensor(samples[i].url);
    const f = tf.tidy(() => backbone.infer(img, true).squeeze());
    feats.push(f);
    img.dispose();
    if ((i + 1) % 25 === 0) {
      progress({ phase: 'features', done: i + 1, total: samples.length, mem: memMB() });
    }
  }
  const ms = performance.now() - t0;
  const stacked = tf.stack(feats);
  feats.forEach((f) => f.dispose());
  return { x: stacked, ms };
}

// --- 検出ヘッド --------------------------------------------------------------

function buildHead(inputDim) {
  const model = tf.sequential();
  model.add(tf.layers.dense({ inputShape: [inputDim], units: 128, activation: 'relu' }));
  model.add(tf.layers.dropout({ rate: 0.2 }));
  // [cx, cy, w, h] を 0..1 で出す
  model.add(tf.layers.dense({ units: 4, activation: 'sigmoid' }));
  model.compile({ optimizer: tf.train.adam(1e-3), loss: 'meanSquaredError' });
  return model;
}

// cxcywh(0..1) 同士の IoU
function iou(a, b) {
  const box = (v) => [v[0] - v[2] / 2, v[1] - v[3] / 2, v[0] + v[2] / 2, v[1] + v[3] / 2];
  const [ax1, ay1, ax2, ay2] = box(a);
  const [bx1, by1, bx2, by2] = box(b);
  const iw = Math.max(0, Math.min(ax2, bx2) - Math.max(ax1, bx1));
  const ih = Math.max(0, Math.min(ay2, by2) - Math.max(ay1, by1));
  const inter = iw * ih;
  const union = (ax2 - ax1) * (ay2 - ay1) + (bx2 - bx1) * (by2 - by1) - inter;
  return union > 0 ? inter / union : 0;
}

async function meanIoU(model, x, yArray) {
  const pred = model.predict(x);
  const p = await pred.array();
  pred.dispose();
  let sum = 0;
  for (let i = 0; i < p.length; i++) sum += iou(p[i], yArray[i]);
  return sum / p.length;
}

// --- エントリポイント --------------------------------------------------------

self.onmessage = async (e) => {
  const { samples } = e.data;
  const result = { epochs: EPOCHS, batchSize: BATCH_SIZE, samples: samples.length };

  try {
    await tf.setBackend('webgl');
    await tf.ready();
    result.backend = tf.getBackend();
    log(`バックエンド: ${result.backend}`);

    log('MobileNet v2 を読み込み中…');
    let t0 = performance.now();
    const backbone = await mobilenet.load({ version: 2, alpha: 1.0 });
    result.backboneLoadMs = Math.round(performance.now() - t0);
    log(`バックボーンのロード: ${result.backboneLoadMs}ms  ${JSON.stringify(memMB())}`);

    log(`特徴量を事前計算中（${samples.length}枚、バックボーンは凍結）…`);
    const { x: features, ms: featMs } = await extractFeatures(samples, backbone);
    result.featureMs = Math.round(featMs);
    result.featurePerImageMs = +(featMs / samples.length).toFixed(1);
    result.featureDim = features.shape[1];
    log(`特徴量の計算: ${result.featureMs}ms（1枚あたり ${result.featurePerImageMs}ms）  次元 ${result.featureDim}`);
    log(`メモリ: ${JSON.stringify(memMB())}`);

    // ラベル（cxcywh を 0..1 に正規化）
    const yArray = samples.map((s) => s.box);
    const labels = tf.tensor2d(yArray);

    // train / val 分割
    const nVal = Math.floor(samples.length * VAL_RATIO);
    const nTrain = samples.length - nVal;
    const xTrain = features.slice([0, 0], [nTrain, -1]);
    const yTrain = labels.slice([0, 0], [nTrain, -1]);
    const xVal = features.slice([nTrain, 0], [nVal, -1]);
    const yVal = labels.slice([nTrain, 0], [nVal, -1]);
    const yValArray = yArray.slice(nTrain);
    result.split = { train: nTrain, val: nVal };

    const head = buildHead(result.featureDim);
    result.headParams = head.countParams();
    log(`検出ヘッド: 学習対象パラメータ ${result.headParams.toLocaleString()}`);

    result.iouBefore = +(await meanIoU(head, xVal, yValArray)).toFixed(3);
    log(`学習前の平均IoU（検証データ）: ${result.iouBefore}`);

    log(`学習開始: ${EPOCHS} epoch / batch ${BATCH_SIZE}`);
    const epochMs = [];
    const history = [];
    let epochStart = 0;

    t0 = performance.now();
    await head.fit(xTrain, yTrain, {
      epochs: EPOCHS,
      batchSize: BATCH_SIZE,
      validationData: [xVal, yVal],
      shuffle: true,
      callbacks: {
        onEpochBegin: () => { epochStart = performance.now(); },
        onEpochEnd: async (epoch, logs) => {
          const ms = performance.now() - epochStart;
          epochMs.push(ms);
          history.push({ epoch: epoch + 1, loss: +logs.loss.toFixed(5), valLoss: +logs.val_loss.toFixed(5), ms: Math.round(ms) });
          progress({ phase: 'train', epoch: epoch + 1, total: EPOCHS, loss: +logs.loss.toFixed(5), valLoss: +logs.val_loss.toFixed(5), ms: Math.round(ms), mem: memMB() });
          await tf.nextFrame();
        },
      },
    });
    result.trainMs = Math.round(performance.now() - t0);
    result.epochMsMedian = Math.round([...epochMs].sort((a, b) => a - b)[Math.floor(epochMs.length / 2)]);
    result.history = history;
    result.lossFirst = history[0].loss;
    result.lossLast = history[history.length - 1].loss;
    result.valLossFirst = history[0].valLoss;
    result.valLossLast = history[history.length - 1].valLoss;

    result.iouAfter = +(await meanIoU(head, xVal, yValArray)).toFixed(3);
    result.memAfterTrain = memMB();
    log(`学習完了: ${result.trainMs}ms（1 epoch 中央値 ${result.epochMsMedian}ms）`);
    log(`学習後の平均IoU（検証データ）: ${result.iouAfter}`);

    // 学習した重みを ArrayBuffer として取り出し、OPFS に保存できるか（P5 との接続）
    log('学習した重みを取り出して OPFS に保存中…');
    const artifacts = await new Promise((resolve, reject) => {
      head.save(tf.io.withSaveHandler(async (a) => { resolve(a); return { modelArtifactsInfo: { dateSaved: new Date(), modelTopologyType: 'JSON' } }; }))
        .catch(reject);
    });
    const weightBytes = artifacts.weightData.byteLength;
    const root = await navigator.storage.getDirectory();
    const blobs = await root.getDirectoryHandle('blobs', { create: true });
    const models = await blobs.getDirectoryHandle('models', { create: true });
    const fh = await models.getFileHandle('poc-p2-head.bin', { create: true });
    const ah = await fh.createSyncAccessHandle();
    ah.truncate(0);
    ah.write(new Uint8Array(artifacts.weightData), { at: 0 });
    ah.flush();
    const savedSize = ah.getSize();
    ah.close();
    await models.removeEntry('poc-p2-head.bin');
    result.weightBytes = weightBytes;
    result.weightSavedBytes = savedSize;
    result.weightRoundTrip = weightBytes === savedSize;
    log(`重みの取り出しと保存: ${(weightBytes / 1024).toFixed(1)}KB  一致 ${result.weightRoundTrip}`);

    [features, labels, xTrain, yTrain, xVal, yVal].forEach((t) => t.dispose());
    head.dispose();
    result.memFinal = memMB();
    result.ok = true;
  } catch (err) {
    result.ok = false;
    result.error = String(err?.stack ?? err?.message ?? err);
  }

  self.postMessage({ type: 'done', result });
};
