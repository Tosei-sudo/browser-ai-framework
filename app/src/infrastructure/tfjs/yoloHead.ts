/**
 * YOLOv8 相当の検出ヘッド（M5 / 論点33・方針3）。
 *
 * R1 で「凍結したバックボーンの特徴量に新しいヘッドを載せて学習できる」ことは
 * 確認した（06 §7）。ここではそのヘッドを**本物の構成**にする。
 *
 *   - 3スケール（P3 / P4 / P5、stride 8 / 16 / 32）
 *   - 分類とボックスの分離ブランチ（decoupled head）
 *   - ボックスは DFL（Distribution Focal Loss）。1辺を `regMax` 個のビンの
 *     分布として出し、期待値を距離にする
 *
 * 重みはこの層が持つ `tf.Variable` の集合で、学習後は1本の ArrayBuffer に
 * 詰めて OPFS へ置く（方針6）。形式は `ModelArtifact.format` の
 * `baif_yolo_head_v1`。
 */
import * as tf from '@tensorflow/tfjs-core';

export interface HeadSpec {
  readonly numClasses: number;
  /** DFL のビン数。YOLOv8 と同じ 16 */
  readonly regMax: number;
  /** 各階層の stride。入力 640 なら 8 / 16 / 32 */
  readonly strides: readonly number[];
  /** 各階層の入力チャンネル数（P3=64, P4=128, P5=256） */
  readonly channels: readonly number[];
  /** 中間チャンネル数 */
  readonly hidden: number;
  readonly inputSize: number;
}

export const DEFAULT_HEAD_SPEC: Omit<HeadSpec, 'numClasses'> = {
  regMax: 16,
  strides: [8, 16, 32],
  channels: [64, 128, 256],
  hidden: 64,
  inputSize: 640,
};

export interface HeadVariables {
  readonly spec: HeadSpec;
  /** 階層ごと・ブランチごとの重み。順序は serialize と揃える */
  readonly variables: tf.Variable[];
}

function conv(name: string, shape: [number, number, number, number]): tf.Variable[] {
  // He 初期化。silu を使うので relu 系の初期化で足りる。
  const [kh, kw, cin] = shape;
  const std = Math.sqrt(2 / (kh * kw * cin));
  return [
    tf.variable(tf.mul(tf.randomNormal(shape), std), true, `${name}/kernel`),
    tf.variable(tf.zeros([shape[3]]), true, `${name}/bias`),
  ];
}

/**
 * ヘッドの重みを作る。
 *
 * 分類ブランチの最終バイアスは負に振る。学習の最初から
 * 「ほとんど背景」と出させるためで、初期の loss が跳ねるのを防ぐ。
 */
export function createHead(spec: HeadSpec): HeadVariables {
  const variables: tf.Variable[] = [];
  spec.channels.forEach((cin, level) => {
    variables.push(...conv(`box${level}/c1`, [3, 3, cin, spec.hidden]));
    variables.push(...conv(`box${level}/c2`, [3, 3, spec.hidden, spec.hidden]));
    variables.push(...conv(`box${level}/out`, [1, 1, spec.hidden, 4 * spec.regMax]));
    variables.push(...conv(`cls${level}/c1`, [3, 3, cin, spec.hidden]));
    variables.push(...conv(`cls${level}/c2`, [3, 3, spec.hidden, spec.hidden]));
    const out = conv(`cls${level}/out`, [1, 1, spec.hidden, spec.numClasses]);
    const bias = out[1];
    if (bias) {
      bias.assign(tf.fill([spec.numClasses], -4));
    }
    variables.push(...out);
  });
  return { spec, variables };
}

function silu(x: tf.Tensor): tf.Tensor {
  return tf.mul(x, tf.sigmoid(x));
}

function applyConv(x: tf.Tensor4D, kernel: tf.Tensor, bias: tf.Tensor): tf.Tensor4D {
  return tf.add(
    tf.conv2d(x, kernel as tf.Tensor4D, 1, 'same'),
    bias,
  ) as tf.Tensor4D;
}

export interface HeadOutput {
  /** [N, numClasses]。sigmoid をかける前の値 */
  readonly clsLogits: tf.Tensor2D;
  /** [N, 4 * regMax]。DFL のロジット */
  readonly boxDist: tf.Tensor2D;
}

/**
 * 前向き計算。**バッチは1枚ずつ**（features は [1,H,W,C]）。
 *
 * 1枚ずつにしているのは、後段の割当（TAL）を画像ごとに行うため。
 * 正解の件数が画像ごとに違うので、まとめて扱うと padding が必要になる。
 */
export function headForward(head: HeadVariables, features: readonly tf.Tensor4D[]): HeadOutput {
  const clsParts: tf.Tensor2D[] = [];
  const boxParts: tf.Tensor2D[] = [];
  const perLevel = 12; // conv 6本 × (kernel, bias)

  features.forEach((feature, level) => {
    const base = level * perLevel;
    const v = head.variables;
    const boxK1 = v[base];
    const boxB1 = v[base + 1];
    const boxK2 = v[base + 2];
    const boxB2 = v[base + 3];
    const boxKO = v[base + 4];
    const boxBO = v[base + 5];
    const clsK1 = v[base + 6];
    const clsB1 = v[base + 7];
    const clsK2 = v[base + 8];
    const clsB2 = v[base + 9];
    const clsKO = v[base + 10];
    const clsBO = v[base + 11];
    if (!boxK1 || !boxB1 || !boxK2 || !boxB2 || !boxKO || !boxBO) throw new Error('ヘッドの重みが足りない');
    if (!clsK1 || !clsB1 || !clsK2 || !clsB2 || !clsKO || !clsBO) throw new Error('ヘッドの重みが足りない');

    const boxHidden = silu(applyConv(silu(applyConv(feature, boxK1, boxB1)) as tf.Tensor4D, boxK2, boxB2));
    const boxOut = applyConv(boxHidden as tf.Tensor4D, boxKO, boxBO);
    const clsHidden = silu(applyConv(silu(applyConv(feature, clsK1, clsB1)) as tf.Tensor4D, clsK2, clsB2));
    const clsOut = applyConv(clsHidden as tf.Tensor4D, clsKO, clsBO);

    const cells = boxOut.shape[1] * boxOut.shape[2];
    boxParts.push(tf.reshape(boxOut, [cells, 4 * head.spec.regMax]));
    clsParts.push(tf.reshape(clsOut, [cells, head.spec.numClasses]));
  });

  return {
    clsLogits: tf.concat(clsParts, 0) as tf.Tensor2D,
    boxDist: tf.concat(boxParts, 0) as tf.Tensor2D,
  };
}

/** 各セルの中心座標（入力画素）と stride。DFL の距離を画素へ戻すのに使う。 */
export interface Anchors {
  /** [N, 2]（cx, cy） */
  readonly points: tf.Tensor2D;
  /** [N, 1] */
  readonly strides: tf.Tensor2D;
  readonly total: number;
}

export function makeAnchors(spec: HeadSpec): Anchors {
  const points: number[][] = [];
  const strides: number[][] = [];
  for (const stride of spec.strides) {
    const size = Math.round(spec.inputSize / stride);
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        points.push([(x + 0.5) * stride, (y + 0.5) * stride]);
        strides.push([stride]);
      }
    }
  }
  return {
    points: tf.tensor2d(points),
    strides: tf.tensor2d(strides),
    total: points.length,
  };
}

/**
 * DFL のロジットを距離に変換し、xyxy のボックスにする。
 *
 * 各辺を `regMax` 個のビンの分布として出しているので、softmax の期待値を取る。
 * これが「分布として出す」ことの実体で、1つの値を直接回帰するより素直に学習する。
 */
export function decodeBoxes(boxDist: tf.Tensor2D, anchors: Anchors, spec: HeadSpec): tf.Tensor2D {
  return tf.tidy(() => {
    const reshaped = tf.reshape(boxDist, [-1, 4, spec.regMax]);
    const probability = tf.softmax(reshaped, -1);
    const bins = tf.range(0, spec.regMax, 1, 'float32');
    // [N, 4]（左・上・右・下の距離。stride 単位）
    const distance = tf.sum(tf.mul(probability, bins), -1) as tf.Tensor2D;
    const scaled = tf.mul(distance, anchors.strides) as tf.Tensor2D;

    const left = tf.slice(scaled, [0, 0], [-1, 1]);
    const top = tf.slice(scaled, [0, 1], [-1, 1]);
    const right = tf.slice(scaled, [0, 2], [-1, 1]);
    const bottom = tf.slice(scaled, [0, 3], [-1, 1]);
    const cx = tf.slice(anchors.points, [0, 0], [-1, 1]);
    const cy = tf.slice(anchors.points, [0, 1], [-1, 1]);

    return tf.concat(
      [tf.sub(cx, left), tf.sub(cy, top), tf.add(cx, right), tf.add(cy, bottom)],
      1,
    ) as tf.Tensor2D;
  });
}

/** 重みを1本の ArrayBuffer にする。先頭に形状のヘッダを置く（方針6の実体）。 */
export const HEAD_MAGIC = 'BAIFHEAD';

export interface HeadFile {
  readonly version: 1;
  readonly spec: HeadSpec;
  readonly tensors: readonly { readonly shape: number[]; readonly length: number }[];
}

export async function serializeHead(head: HeadVariables): Promise<ArrayBuffer> {
  const datas = await Promise.all(head.variables.map((variable) => variable.data()));
  const tensors = head.variables.map((variable, index) => ({
    shape: [...variable.shape],
    length: (datas[index] as Float32Array).length,
  }));
  const header = new TextEncoder().encode(
    JSON.stringify({ version: 1, spec: head.spec, tensors } satisfies HeadFile),
  );
  const total = datas.reduce((sum, data) => sum + (data as Float32Array).byteLength, 0);
  const buffer = new ArrayBuffer(HEAD_MAGIC.length + 4 + header.byteLength + total);
  const bytes = new Uint8Array(buffer);
  bytes.set(new TextEncoder().encode(HEAD_MAGIC), 0);
  new DataView(buffer).setUint32(HEAD_MAGIC.length, header.byteLength, true);
  bytes.set(header, HEAD_MAGIC.length + 4);
  let offset = HEAD_MAGIC.length + 4 + header.byteLength;
  for (const data of datas) {
    bytes.set(new Uint8Array((data as Float32Array).buffer), offset);
    offset += (data as Float32Array).byteLength;
  }
  return buffer;
}

export function deserializeHead(buffer: ArrayBuffer): HeadVariables {
  const magic = new TextDecoder().decode(new Uint8Array(buffer, 0, HEAD_MAGIC.length));
  if (magic !== HEAD_MAGIC) throw new Error('ヘッドの重みの形式が違う');
  const headerLength = new DataView(buffer).getUint32(HEAD_MAGIC.length, true);
  const headerStart = HEAD_MAGIC.length + 4;
  const header = JSON.parse(
    new TextDecoder().decode(new Uint8Array(buffer, headerStart, headerLength)),
  ) as HeadFile;

  let offset = headerStart + headerLength;
  const variables = header.tensors.map((entry) => {
    const data = new Float32Array(buffer.slice(offset, offset + entry.length * 4));
    offset += entry.length * 4;
    return tf.variable(tf.tensor(data, entry.shape), true);
  });
  return { spec: header.spec, variables };
}
