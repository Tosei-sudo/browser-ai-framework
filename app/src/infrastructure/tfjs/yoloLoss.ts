/**
 * YOLOv8 の損失（M5 / 持ち越し事項#19）。
 *
 * 3つの和で、YOLOv8 と同じ構成にしてある。
 *   - 分類: BCE。正解スコアは**タスク整合割当（TAL）の整合度**で重みづけする
 *   - ボックス: CIoU 損失
 *   - DFL: 分布の隣り合う2ビンへの交差エントロピー
 *
 * 割当（どのセルをその正解の担当にするか）は**予測を見て決める**。
 * 微分は通さないので、損失の計算とは別に1回前向き計算して求める。
 */
import * as tf from '@tensorflow/tfjs-core';
import type { Anchors, HeadOutput, HeadSpec } from './yoloHead';

const EPS = 1e-9;
const TOPK = 10;
const ALPHA = 0.5;
const BETA = 6;

export interface GroundTruth {
  /** xyxy（入力画素）。letterbox 後の座標に直して渡す */
  readonly boxes: readonly (readonly [number, number, number, number])[];
  readonly classes: readonly number[];
}

export interface Targets {
  /** [N, 1]。担当に選ばれたセルが 1 */
  readonly fgMask: tf.Tensor2D;
  /** [N, 4] xyxy */
  readonly targetBoxes: tf.Tensor2D;
  /** [N, numClasses]。整合度で重みづけした正解スコア */
  readonly targetScores: tf.Tensor2D;
  /** 正規化に使う合計 */
  readonly scoreSum: tf.Scalar;
  dispose(): void;
}

/**
 * one-hot を自前で作る。
 *
 * `tf.oneHot` を使わない理由が2つある。
 *  - depth 1 を受け付けない（正解1件・クラス1つは普通に起こる）
 *  - 戻りが int32 で、float32 と混ぜると壊れた値になる。**実際に WebGPU 上で
 *    割当が全アンカーになる不具合を出した**
 *
 * `equal` と `range` の比較で作れば、どのバックエンドでも同じ結果になる。
 */
function oneHotSafe(indices: tf.Tensor, depth: number): tf.Tensor {
  return tf.tidy(() => {
    const bins = tf.range(0, depth, 1, 'float32');
    const expanded = tf.expandDims(tf.cast(indices, 'float32'), -1);
    return tf.cast(tf.equal(expanded, bins), 'float32');
  });
}

/** IoU。[a, N] と [a, 4] の組み合わせで使う。 */
function iouMatrix(gtBoxes: tf.Tensor2D, predBoxes: tf.Tensor2D): tf.Tensor2D {
  return tf.tidy(() => {
    const gt = tf.expandDims(gtBoxes, 1); // [ng, 1, 4]
    const pred = tf.expandDims(predBoxes, 0); // [1, N, 4]
    const x1 = tf.maximum(tf.slice(gt, [0, 0, 0], [-1, -1, 1]), tf.slice(pred, [0, 0, 0], [-1, -1, 1]));
    const y1 = tf.maximum(tf.slice(gt, [0, 0, 1], [-1, -1, 1]), tf.slice(pred, [0, 0, 1], [-1, -1, 1]));
    const x2 = tf.minimum(tf.slice(gt, [0, 0, 2], [-1, -1, 1]), tf.slice(pred, [0, 0, 2], [-1, -1, 1]));
    const y2 = tf.minimum(tf.slice(gt, [0, 0, 3], [-1, -1, 1]), tf.slice(pred, [0, 0, 3], [-1, -1, 1]));
    const inter = tf.mul(
      tf.relu(tf.sub(x2, x1)),
      tf.relu(tf.sub(y2, y1)),
    );
    const areaGt = tf.mul(
      tf.sub(tf.slice(gt, [0, 0, 2], [-1, -1, 1]), tf.slice(gt, [0, 0, 0], [-1, -1, 1])),
      tf.sub(tf.slice(gt, [0, 0, 3], [-1, -1, 1]), tf.slice(gt, [0, 0, 1], [-1, -1, 1])),
    );
    const areaPred = tf.mul(
      tf.sub(tf.slice(pred, [0, 0, 2], [-1, -1, 1]), tf.slice(pred, [0, 0, 0], [-1, -1, 1])),
      tf.sub(tf.slice(pred, [0, 0, 3], [-1, -1, 1]), tf.slice(pred, [0, 0, 1], [-1, -1, 1])),
    );
    const union = tf.sub(tf.add(areaGt, areaPred), inter);
    return tf.squeeze(tf.div(inter, tf.add(union, EPS)), [2]) as tf.Tensor2D;
  });
}

/**
 * タスク整合割当（TAL）。
 *
 * 「分類が当たっていて、かつ枠も合っているセル」を正解の担当にする。
 * 整合度 = スコア^0.5 × IoU^6 で、YOLOv8 と同じ重みづけ。
 */
export function assignTargets(
  predScores: tf.Tensor2D,
  predBoxes: tf.Tensor2D,
  anchors: Anchors,
  gt: GroundTruth,
  spec: HeadSpec,
): Targets {
  const total = anchors.total;
  if (gt.boxes.length === 0) {
    // 正解が無い画像。すべて背景として扱う（loss は分類だけ効く）。
    return {
      fgMask: tf.zeros([total, 1]),
      targetBoxes: tf.zeros([total, 4]),
      targetScores: tf.zeros([total, spec.numClasses]),
      scoreSum: tf.scalar(1),
      dispose(): void {
        tf.dispose([this.fgMask, this.targetBoxes, this.targetScores, this.scoreSum]);
      },
    };
  }

  const result = tf.tidy(() => {
    const gtBoxes = tf.tensor2d(gt.boxes.map((box) => [...box]));
    const gtClasses = tf.tensor1d([...gt.classes], 'int32');
    const ng = gt.boxes.length;

    // 1. セルの中心が正解の内側にあるか。
    const cx = tf.slice(anchors.points, [0, 0], [-1, 1]);
    const cy = tf.slice(anchors.points, [0, 1], [-1, 1]);
    const gtx1 = tf.reshape(tf.slice(gtBoxes, [0, 0], [-1, 1]), [ng, 1]);
    const gty1 = tf.reshape(tf.slice(gtBoxes, [0, 1], [-1, 1]), [ng, 1]);
    const gtx2 = tf.reshape(tf.slice(gtBoxes, [0, 2], [-1, 1]), [ng, 1]);
    const gty2 = tf.reshape(tf.slice(gtBoxes, [0, 3], [-1, 1]), [ng, 1]);
    const pointsX = tf.reshape(cx, [1, total]);
    const pointsY = tf.reshape(cy, [1, total]);
    const inside = tf.logicalAnd(
      tf.logicalAnd(tf.greater(pointsX, gtx1), tf.less(pointsX, gtx2)),
      tf.logicalAnd(tf.greater(pointsY, gty1), tf.less(pointsY, gty2)),
    );
    const maskInGts = tf.cast(inside, 'float32') as tf.Tensor2D; // [ng, N]

    // 2. 整合度。分類スコアは正解クラスのぶんだけ見る。
    const overlaps = iouMatrix(gtBoxes as tf.Tensor2D, predBoxes); // [ng, N]
    const scoresT = tf.transpose(predScores); // [nc, N]
    const classScores = tf.gather(scoresT, gtClasses) as tf.Tensor2D; // [ng, N]
    const align = tf.mul(tf.pow(classScores, ALPHA), tf.pow(overlaps, BETA)) as tf.Tensor2D;
    const masked = tf.mul(align, maskInGts) as tf.Tensor2D;

    // 3. 正解ごとに上位 k セルを選ぶ。
    const k = Math.min(TOPK, total);
    const { indices } = tf.topk(masked, k);
    const topkMask = tf.clipByValue(
      tf.sum(oneHotSafe(indices, total), 1),
      0,
      1,
    ) as tf.Tensor2D; // [ng, N]
    let maskPos = tf.mul(topkMask, maskInGts) as tf.Tensor2D;

    // 4. 1つのセルが複数の正解に選ばれたら、IoU の高い方に寄せる。
    const assignedCount = tf.sum(maskPos, 0, true); // [1, N]
    const conflicted = tf.greater(assignedCount, 1);
    const bestGt = tf.argMax(overlaps, 0); // [N]
    const isBest = tf.transpose(oneHotSafe(bestGt, ng)) as tf.Tensor2D; // [ng, N]
    maskPos = tf.where(tf.tile(conflicted, [ng, 1]), tf.mul(isBest, maskInGts), maskPos) as tf.Tensor2D;

    // 5. セルごとの担当（正解の index）と、その正解のボックス・クラス。
    const targetGtIdx = tf.argMax(maskPos, 0); // [N]
    const fgMask = tf.reshape(tf.clipByValue(tf.sum(maskPos, 0), 0, 1), [total, 1]) as tf.Tensor2D;
    const targetBoxes = tf.gather(gtBoxes, targetGtIdx) as tf.Tensor2D; // [N, 4]
    const targetLabels = tf.gather(gtClasses, targetGtIdx); // [N]

    // 6. 正解スコアを整合度で重みづけする（YOLOv8 の norm_align_metric）。
    const alignPos = tf.mul(align, maskPos) as tf.Tensor2D;
    const posAlignMax = tf.max(alignPos, 1, true); // [ng, 1]
    const posOverlapMax = tf.max(tf.mul(overlaps, maskPos), 1, true); // [ng, 1]
    const normAlign = tf.max(
      tf.mul(alignPos, tf.div(posOverlapMax, tf.add(posAlignMax, EPS))),
      0,
    ); // [N]
    const oneHotLabels = oneHotSafe(targetLabels, spec.numClasses) as tf.Tensor2D;
    const targetScores = tf.mul(
      tf.mul(oneHotLabels, fgMask),
      tf.reshape(normAlign, [total, 1]),
    ) as tf.Tensor2D;

    return {
      fgMask: tf.keep(fgMask),
      targetBoxes: tf.keep(targetBoxes),
      targetScores: tf.keep(targetScores),
      scoreSum: tf.keep(tf.maximum(tf.sum(targetScores), 1) as tf.Scalar),
    };
  });

  return {
    ...result,
    dispose(): void {
      tf.dispose([result.fgMask, result.targetBoxes, result.targetScores, result.scoreSum]);
    },
  };
}

/** CIoU。IoU に中心距離と縦横比の項を足したもの。枠の学習が安定する。 */
function ciou(predBoxes: tf.Tensor2D, targetBoxes: tf.Tensor2D): tf.Tensor2D {
  return tf.tidy(() => {
    const px1 = tf.slice(predBoxes, [0, 0], [-1, 1]);
    const py1 = tf.slice(predBoxes, [0, 1], [-1, 1]);
    const px2 = tf.slice(predBoxes, [0, 2], [-1, 1]);
    const py2 = tf.slice(predBoxes, [0, 3], [-1, 1]);
    const tx1 = tf.slice(targetBoxes, [0, 0], [-1, 1]);
    const ty1 = tf.slice(targetBoxes, [0, 1], [-1, 1]);
    const tx2 = tf.slice(targetBoxes, [0, 2], [-1, 1]);
    const ty2 = tf.slice(targetBoxes, [0, 3], [-1, 1]);

    const pw = tf.relu(tf.sub(px2, px1));
    const ph = tf.relu(tf.sub(py2, py1));
    const tw = tf.relu(tf.sub(tx2, tx1));
    const th = tf.relu(tf.sub(ty2, ty1));

    const interW = tf.relu(tf.sub(tf.minimum(px2, tx2), tf.maximum(px1, tx1)));
    const interH = tf.relu(tf.sub(tf.minimum(py2, ty2), tf.maximum(py1, ty1)));
    const inter = tf.mul(interW, interH);
    const union = tf.add(tf.sub(tf.add(tf.mul(pw, ph), tf.mul(tw, th)), inter), EPS);
    const iou = tf.div(inter, union);

    const pcx = tf.div(tf.add(px1, px2), 2);
    const pcy = tf.div(tf.add(py1, py2), 2);
    const tcx = tf.div(tf.add(tx1, tx2), 2);
    const tcy = tf.div(tf.add(ty1, ty2), 2);
    const centerDistance = tf.add(tf.square(tf.sub(pcx, tcx)), tf.square(tf.sub(pcy, tcy)));

    const encloseW = tf.sub(tf.maximum(px2, tx2), tf.minimum(px1, tx1));
    const encloseH = tf.sub(tf.maximum(py2, ty2), tf.minimum(py1, ty1));
    const diagonal = tf.add(tf.add(tf.square(encloseW), tf.square(encloseH)), EPS);

    const atanTarget = tf.atan(tf.div(tw, tf.add(th, EPS)));
    const atanPred = tf.atan(tf.div(pw, tf.add(ph, EPS)));
    const v = tf.mul(tf.square(tf.sub(atanTarget, atanPred)), 4 / Math.PI ** 2);
    const alpha = tf.div(v, tf.add(tf.add(tf.sub(tf.scalar(1), iou), v), EPS));

    return tf.sub(iou, tf.add(tf.div(centerDistance, diagonal), tf.mul(alpha, v))) as tf.Tensor2D;
  });
}

export interface LossParts {
  readonly total: tf.Scalar;
  readonly box: tf.Scalar;
  readonly cls: tf.Scalar;
  readonly dfl: tf.Scalar;
}

/** YOLOv8 の既定と同じ重み。 */
const BOX_GAIN = 7.5;
const CLS_GAIN = 0.5;
const DFL_GAIN = 1.5;

/**
 * 損失を計算する。**この関数の中の計算にだけ勾配が流れる。**
 * 割当（`targets`）は前向き計算1回ぶんから先に求めておく。
 */
export function computeLoss(
  output: HeadOutput,
  anchors: Anchors,
  spec: HeadSpec,
  targets: Targets,
  decoded: tf.Tensor2D,
): LossParts {
  // 分類: BCE（ロジットから）。正解スコアは整合度で重みづけ済み。
  //   BCE(x, y) = max(x, 0) - x*y + log(1 + exp(-|x|))
  // ロジットのまま計算するのは、sigmoid を挟むと勾配が飽和するため。
  const logits = output.clsLogits;
  const clsLoss = tf.div(
    tf.sum(
      tf.add(
        tf.sub(tf.relu(logits), tf.mul(logits, targets.targetScores)),
        tf.log1p(tf.exp(tf.neg(tf.abs(logits)))),
      ),
    ),
    targets.scoreSum,
  ) as tf.Scalar;

  // ボックス: CIoU 損失。担当セルだけ、整合度で重みづけ。
  const weight = tf.sum(targets.targetScores, -1, true); // [N, 1]
  const iouLoss = tf.sub(tf.scalar(1), ciou(decoded, targets.targetBoxes));
  const boxLoss = tf.div(
    tf.sum(tf.mul(tf.mul(iouLoss, weight), targets.fgMask)),
    targets.scoreSum,
  ) as tf.Scalar;

  // DFL: 正解距離を挟む2ビンへの交差エントロピー。
  const dflLoss = tf.tidy(() => {
    const cx = tf.slice(anchors.points, [0, 0], [-1, 1]);
    const cy = tf.slice(anchors.points, [0, 1], [-1, 1]);
    const tx1 = tf.slice(targets.targetBoxes, [0, 0], [-1, 1]);
    const ty1 = tf.slice(targets.targetBoxes, [0, 1], [-1, 1]);
    const tx2 = tf.slice(targets.targetBoxes, [0, 2], [-1, 1]);
    const ty2 = tf.slice(targets.targetBoxes, [0, 3], [-1, 1]);
    const distance = tf.div(
      tf.concat([tf.sub(cx, tx1), tf.sub(cy, ty1), tf.sub(tx2, cx), tf.sub(ty2, cy)], 1),
      anchors.strides,
    );
    const clipped = tf.clipByValue(distance, 0, spec.regMax - 1.01);
    const lower = tf.floor(clipped);
    const upper = tf.add(lower, 1);
    const weightUpper = tf.sub(clipped, lower);
    const weightLower = tf.sub(tf.scalar(1), weightUpper);

    const logits = tf.reshape(output.boxDist, [-1, spec.regMax]);
    const logProbability = tf.logSoftmax(logits, -1);
    const pick = (index: tf.Tensor): tf.Tensor =>
      tf.neg(
        tf.sum(
          tf.mul(oneHotSafe(tf.reshape(index, [-1]), spec.regMax), logProbability),
          -1,
        ),
      );
    const ce = tf.add(
      tf.mul(pick(lower), tf.reshape(weightLower, [-1])),
      tf.mul(pick(upper), tf.reshape(weightUpper, [-1])),
    );
    const perAnchor = tf.mean(tf.reshape(ce, [-1, 4]), -1, true); // [N, 1]
    return tf.div(
      tf.sum(tf.mul(tf.mul(perAnchor, weight), targets.fgMask)),
      targets.scoreSum,
    ) as tf.Scalar;
  });

  const total = tf.add(
    tf.add(tf.mul(boxLoss, BOX_GAIN), tf.mul(clsLoss, CLS_GAIN)),
    tf.mul(dflLoss, DFL_GAIN),
  ) as tf.Scalar;

  return { total, box: boxLoss, cls: clsLoss, dfl: dflLoss };
}
