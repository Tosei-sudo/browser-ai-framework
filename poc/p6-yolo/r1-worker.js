// R1: YOLOv8 を TF.js へ変換したものが、ブラウザで
//   (1) 推論に使えるか
//   (2) ヘッドだけを学習できる形に分解できるか
// を確かめる（07 §3 / 論点33）。
//
// 構成は PoC P2/P3 と同じ考え方。バックボーン + ネックを凍結した特徴抽出器として使い、
// その上に新しい検出ヘッドを載せて、ヘッドだけを学習する（方針3 の frozen_layers）。

importScripts('/node_modules/@tensorflow/tfjs/dist/tf.min.js');

const FULL_MODEL = '/models/yolov8n_tfjs/model.json';
const BACKBONE_MODEL = '/models/yolov8n_backbone_tfjs/model.json';
const IMAGE_SIZE = 640;
const SAMPLES = 16;      // 学習に使う合成サンプル数
const STEPS = 10;        // 学習ステップ数
const NUM_CLASSES = 2;   // 転移先のクラス数（COCO の80から載せ替える想定）

function log(line, cls = '') {
  self.postMessage({ type: 'log', line, cls });
}

function mb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 変換で出力の順序が入れ替わるため、解像度の高い順（P3→P4→P5）に並べ直す。 */
function sortFeatures(tensors) {
  return [...tensors].sort((a, b) => b.shape[1] - a.shape[1]);
}

/** 合成画像。R1 で確かめたいのは精度ではなく成立性なので中身は問わない。 */
function syntheticInput(batch = 1) {
  return tf.tidy(() => tf.randomUniform([batch, IMAGE_SIZE, IMAGE_SIZE, 3], 0, 1));
}

async function checkFullModel() {
  log('■ 1. 完成モデル（検出ヘッドまで）', 'head');
  const started = performance.now();
  const model = await tf.loadGraphModel(FULL_MODEL);
  log(`  読み込み: ${(performance.now() - started).toFixed(0)} ms`);

  const input = syntheticInput();
  // 1回目はカーネルの初期化を含むため捨てる。
  tf.dispose(await model.executeAsync(input));

  const times = [];
  let shape = null;
  for (let i = 0; i < 5; i += 1) {
    const t0 = performance.now();
    const output = await model.executeAsync(input);
    const tensor = Array.isArray(output) ? output[0] : output;
    await tensor.data();
    times.push(performance.now() - t0);
    shape = tensor.shape;
    tf.dispose(output);
  }
  input.dispose();
  const median = times.sort((a, b) => a - b)[Math.floor(times.length / 2)];
  log(`  出力形状: [${shape}]（84 = 4 box + 80 class、8400 = 全アンカー）`);
  log(`  推論: ${median.toFixed(1)} ms（5回の中央値）`, 'ok');
  model.dispose();
}

async function checkBackbone() {
  log('■ 2. バックボーン + ネック（検出ヘッドを外したもの）', 'head');
  const model = await tf.loadGraphModel(BACKBONE_MODEL);
  const input = syntheticInput();
  const features = await model.executeAsync(input);
  // 出力の順序は変換で入れ替わる。解像度の高い順（P3→P4→P5）に並べ直す。
  const list = sortFeatures(Array.isArray(features) ? features : [features]);
  for (const [i, tensor] of list.entries()) {
    log(`  特徴量 P${i + 3}: [${tensor.shape}]`);
  }
  tf.dispose(features);
  input.dispose();
  log('  ヘッドを外した特徴量を取り出せる', 'ok');
  return model;
}

/** 転移先の検出ヘッド。特徴量1階層ぶんを受け取り、クラスとボックスを出す。 */
function buildHead(featureShape) {
  const [, height, width, channels] = featureShape;
  const model = tf.sequential();
  model.add(tf.layers.conv2d({
    inputShape: [height, width, channels],
    filters: 64, kernelSize: 3, padding: 'same', activation: 'relu',
  }));
  model.add(tf.layers.conv2d({
    filters: 4 + NUM_CLASSES, kernelSize: 1, padding: 'same',
  }));
  model.compile({ optimizer: tf.train.adam(1e-3), loss: 'meanSquaredError' });
  return model;
}

async function trainHead(backbone) {
  log('■ 3. ヘッドだけの学習', 'head');

  // 凍結したバックボーンの特徴量は学習中に変わらないため、先に全件計算する。
  // 実アプリでも同じ最適化ができる（P2/P3 と同じ構成）。
  const t0 = performance.now();
  const featureBatches = [];
  for (let i = 0; i < SAMPLES; i += 1) {
    const input = syntheticInput();
    const output = await backbone.executeAsync(input);
    const list = sortFeatures(Array.isArray(output) ? output : [output]);
    // 最も粗い階層（P5, 20x20）だけを使う。成立性の確認が目的なので1階層で足りる。
    const p5 = list[list.length - 1];
    featureBatches.push(tf.keep(p5.clone()));
    tf.dispose(output);
    input.dispose();
  }
  const features = tf.concat(featureBatches, 0);
  featureBatches.forEach((t) => t.dispose());
  log(`  特徴量の事前計算: ${SAMPLES} 件 / ${(performance.now() - t0).toFixed(0)} ms`);
  log(`  特徴量テンソル: [${features.shape}]`);

  const head = buildHead(features.shape);
  const params = head.countParams();
  log(`  ヘッドのパラメータ数: ${params.toLocaleString()}`);

  const targets = tf.randomUniform([SAMPLES, features.shape[1], features.shape[2], 4 + NUM_CLASSES]);
  const losses = [];
  const trainStart = performance.now();
  for (let step = 0; step < STEPS; step += 1) {
    const history = await head.fit(features, targets, { epochs: 1, batchSize: 4, verbose: 0 });
    losses.push(history.history.loss[0]);
  }
  const elapsed = performance.now() - trainStart;
  log(`  学習: ${STEPS} ステップ / ${elapsed.toFixed(0)} ms（1ステップ ${(elapsed / STEPS).toFixed(0)} ms）`);
  log(`  loss: ${losses[0].toFixed(4)} → ${losses[losses.length - 1].toFixed(4)}`,
      losses[losses.length - 1] < losses[0] ? 'ok' : 'ng');

  // 学習したヘッドの重みを取り出せるか（保存できるかの確認。方針6）。
  const weights = head.getWeights();
  const bytes = weights.reduce((sum, w) => sum + w.size * 4, 0);
  log(`  ヘッドの重みを取り出せる: ${weights.length} テンソル / ${mb(bytes)}`, 'ok');

  // 重みは head.dispose() が解放する。ここで個別に解放すると二重解放になる。
  tf.dispose([features, targets]);
  head.dispose();
}

async function main() {
  await tf.ready();
  log(`backend: ${tf.getBackend()}`);
  try {
    await checkFullModel();
    const backbone = await checkBackbone();
    await trainHead(backbone);
    backbone.dispose();
    const memory = tf.memory();
    log(`■ メモリ: ${mb(memory.numBytes)} / テンソル ${memory.numTensors} 個`, 'head');
  } catch (error) {
    log(`失敗: ${error.message}`, 'ng');
    console.error(error);
  }
  self.postMessage({ type: 'done' });
}

self.onmessage = (event) => {
  if (event.data.type === 'start') main();
};
