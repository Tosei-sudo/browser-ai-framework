/**
 * ブラウザ内の転移学習（M5 / 方針3・13）。
 *
 * **バックボーンは凍結し、ヘッドだけを学習する。** R1（06 §7）で成立を確認した
 * 構成をそのまま製品側に持ってきたもの。
 *
 * 割当（TAL）を画像ごとに行うため、**勾配の単位は画像1枚**。
 * 正解の件数が画像ごとに違うので、まとめて扱うと padding が要る。
 * 少データ（`order.txt` §3.3）が前提なので、これで足りる。
 */
import * as tf from '@tensorflow/tfjs-core';
import type { InputSpec } from '@domain/index';
import { createPreprocessor } from './preprocessor';
import {
  createHead,
  decodeBoxes,
  headForward,
  makeAnchors,
  serializeHead,
  type HeadSpec,
} from './yoloHead';
import { assignTargets, computeLoss, type GroundTruth } from './yoloLoss';
import type { LoadedGraphModel } from './modelLoader';

export interface TrainingSample {
  readonly bitmap: () => Promise<ImageBitmap>;
  /** 元画像の画素座標 xywh + クラス index */
  readonly boxes: readonly {
    readonly x: number;
    readonly y: number;
    readonly w: number;
    readonly h: number;
    readonly cls: number;
  }[];
}

export interface TrainingConfig {
  readonly epochs: number;
  readonly lr: number;
  readonly inputSpec: InputSpec;
}

export interface EpochMetrics {
  readonly loss: number;
  readonly box: number;
  readonly cls: number;
  readonly dfl: number;
}

const preprocessor = createPreprocessor();

/** 特徴量は解像度の高い順（P3→P4→P5）に並べ替える。変換で順序が入れ替わる。 */
function sortFeatures(tensors: tf.Tensor[]): tf.Tensor4D[] {
  return [...tensors]
    .map((tensor) => tensor as tf.Tensor4D)
    .sort((a, b) => (b.shape[1] ?? 0) - (a.shape[1] ?? 0));
}

export async function trainHead(params: {
  readonly backbone: LoadedGraphModel;
  readonly samples: readonly TrainingSample[];
  readonly spec: HeadSpec;
  readonly config: TrainingConfig;
  readonly onEpoch: (epoch: number, metrics: EpochMetrics) => void;
  readonly shouldStop: () => boolean;
}): Promise<{ readonly weights: ArrayBuffer; readonly finalMetrics: EpochMetrics }> {
  // **学習は WebGL で行う。**
  //
  // WebGPU バックエンドでは割当（TAL）の結果が壊れる。同じコードで比べると、
  // WebGL では正解の担当セルが 10 件（topk のとおり）、targetScores は 1 以下に
  // 収まるのに対し、WebGPU では担当が全 8400 セルになり targetScores が
  // 数十万になった（2026-09-05 実測）。topk / where / clip のどれが原因かは
  // 切り分けていない（持ち越し）。
  //
  // 推論は WebGPU で正しく動いているため、学習の前後でバックエンドを切り替える。
  const preferred = tf.getBackend();
  if (preferred !== 'webgl') {
    await tf.setBackend('webgl');
    await tf.ready();
  }
  const head = createHead(params.spec);
  const anchors = makeAnchors(params.spec);
  const optimizer = tf.train.adam(params.config.lr);

  let last: EpochMetrics = { loss: 0, box: 0, cls: 0, dfl: 0 };

  for (let epoch = 1; epoch <= params.config.epochs; epoch += 1) {
    const sums = { loss: 0, box: 0, cls: 0, dfl: 0 };
    let counted = 0;

    // 順序は毎エポック変える。少データだと並び順の影響が出やすい。
    const order = [...params.samples.keys()].sort(() => Math.random() - 0.5);

    for (const index of order) {
      if (params.shouldStop()) {
        optimizer.dispose();
        throw new Error('学習を中断した');
      }
      const sample = params.samples[index];
      if (!sample) continue;

      const bitmap = await sample.bitmap();
      const input = await preprocessor.run(bitmap, params.config.inputSpec);
      bitmap.close();

      // 正解を letterbox 後の座標へ直す。前処理と同じ変換をかける。
      const { scale, padX, padY } = input.transform;
      const gt: GroundTruth = {
        boxes: sample.boxes.map(
          (box) =>
            [
              box.x * scale + padX,
              box.y * scale + padY,
              (box.x + box.w) * scale + padX,
              (box.y + box.h) * scale + padY,
            ] as [number, number, number, number],
        ),
        classes: sample.boxes.map((box) => box.cls),
      };

      const inputTensor = tf.tensor4d(input.data, [
        input.shape[0] ?? 1,
        input.shape[1] ?? params.spec.inputSize,
        input.shape[2] ?? params.spec.inputSize,
        input.shape[3] ?? 3,
      ]);
      const features = sortFeatures(
        (() => {
          const output = params.backbone.execute(inputTensor);
          return Array.isArray(output) ? output : [output];
        })(),
      );
      inputTensor.dispose();

      // 1回目の前向き計算で割当を決める。ここには勾配を通さない。
      // Targets は自分で dispose するため tf.tidy には入れない。
      const scoutOutput = headForward(head, features);
      const scoutDecoded = decodeBoxes(scoutOutput.boxDist, anchors, params.spec);
      const scoutScores = tf.sigmoid(scoutOutput.clsLogits) as tf.Tensor2D;
      const targets = assignTargets(scoutScores, scoutDecoded, anchors, gt, params.spec);
      tf.dispose([scoutOutput.clsLogits, scoutOutput.boxDist, scoutDecoded, scoutScores]);

      // 2回目で損失を作り、ヘッドの重みだけを更新する。
      // 内訳（box / cls / dfl）は minimize の中で keep して取り出す。
      const parts: { box: tf.Scalar; cls: tf.Scalar; dfl: tf.Scalar } = {
        box: tf.keep(tf.scalar(0)),
        cls: tf.keep(tf.scalar(0)),
        dfl: tf.keep(tf.scalar(0)),
      };
      const lossTensor = optimizer.minimize(
        () => {
          const output = headForward(head, features);
          const decoded = decodeBoxes(output.boxDist, anchors, params.spec);
          const computed = computeLoss(output, anchors, params.spec, targets, decoded);
          tf.dispose([parts.box, parts.cls, parts.dfl]);
          parts.box = tf.keep(computed.box.clone());
          parts.cls = tf.keep(computed.cls.clone());
          parts.dfl = tf.keep(computed.dfl.clone());
          return computed.total;
        },
        true,
        head.variables,
      );

      const metrics = { loss: 0, box: 0, cls: 0, dfl: 0 };
      const [lossValue, boxValue, clsValue, dflValue] = await Promise.all([
        lossTensor ? lossTensor.data() : Promise.resolve(new Float32Array([0])),
        parts.box.data(),
        parts.cls.data(),
        parts.dfl.data(),
      ]);
      metrics.loss = lossValue[0] ?? 0;
      metrics.box = boxValue[0] ?? 0;
      metrics.cls = clsValue[0] ?? 0;
      metrics.dfl = dflValue[0] ?? 0;

      if (lossTensor) lossTensor.dispose();
      tf.dispose([parts.box, parts.cls, parts.dfl]);
      targets.dispose();
      tf.dispose(features);

      sums.loss += metrics.loss;
      sums.box += metrics.box;
      sums.cls += metrics.cls;
      sums.dfl += metrics.dfl;
      counted += 1;
    }

    const divisor = Math.max(counted, 1);
    last = {
      loss: sums.loss / divisor,
      box: sums.box / divisor,
      cls: sums.cls / divisor,
      dfl: sums.dfl / divisor,
    };
    params.onEpoch(epoch, last);
  }

  const weights = await serializeHead(head);
  tf.dispose([anchors.points, anchors.strides, ...head.variables]);
  optimizer.dispose();
  // 推論のために元のバックエンドへ戻す。
  if (preferred !== 'webgl') {
    await tf.setBackend(preferred);
    await tf.ready();
  }
  return { weights, finalMetrics: last };
}
