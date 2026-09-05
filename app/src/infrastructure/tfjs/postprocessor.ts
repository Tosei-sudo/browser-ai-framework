/**
 * Postprocessor の TF.js 実装（論点20）。
 *
 * YOLOv8 の出力 `[1, 84, 8400]` を検出結果へ変換する。
 *   84 = 4（cx, cy, w, h）+ 80（クラススコア）
 *   8400 = 3階層ぶんの全アンカー
 *
 * 座標はモデル入力（letterbox 済み）の画素なので、**前処理の変換を戻して
 * 元画像の座標系に直す。** クラス名の解決は Application Layer が行うため、
 * ここではクラスの index までを返す。
 */
import * as tf from '@tensorflow/tfjs-core';
import type {
  DecodedDetection,
  DetectionParams,
  ModelInput,
  Postprocessor,
  RawOutput,
} from '@ports/mlRuntime';

export function createPostprocessor(): Postprocessor {
  return {
    async run(
      output: RawOutput,
      input: ModelInput,
      params: DetectionParams,
    ): Promise<DecodedDetection[]> {
      const [, channels = 0, anchors = 0] = output.shape;
      const classCount = channels - 4;

      // [1, 84, 8400] → boxes [8400, 4] と scores [8400]
      const { boxes, scores, classes } = tf.tidy(() => {
        const raw = tf.tensor(output.data, [channels, anchors]);
        const transposed = tf.transpose(raw); // [8400, 84]
        const boxParts = tf.slice(transposed, [0, 0], [anchors, 4]);
        const classScores = tf.slice(transposed, [0, 4], [anchors, classCount]);

        const cx = tf.slice(boxParts, [0, 0], [anchors, 1]);
        const cy = tf.slice(boxParts, [0, 1], [anchors, 1]);
        const w = tf.slice(boxParts, [0, 2], [anchors, 1]);
        const h = tf.slice(boxParts, [0, 3], [anchors, 1]);
        const half = tf.div(w, 2);
        const halfH = tf.div(h, 2);
        // NMS は [y1, x1, y2, x2] を取る。
        const y1 = tf.sub(cy, halfH);
        const x1 = tf.sub(cx, half);
        const y2 = tf.add(cy, halfH);
        const x2 = tf.add(cx, half);

        return {
          boxes: tf.concat([y1, x1, y2, x2], 1) as tf.Tensor2D,
          scores: tf.max(classScores, 1) as tf.Tensor1D,
          classes: tf.argMax(classScores, 1) as tf.Tensor1D,
        };
      });

      const kept = await tf.image.nonMaxSuppressionAsync(
        boxes,
        scores,
        params.maxDetections,
        params.iouThreshold,
        params.confThreshold,
      );

      const [keptIndexes, boxData, scoreData, classData] = await Promise.all([
        kept.data() as Promise<Int32Array>,
        boxes.data() as Promise<Float32Array>,
        scores.data() as Promise<Float32Array>,
        classes.data() as Promise<Int32Array>,
      ]);
      tf.dispose([boxes, scores, classes, kept]);

      const { scale, padX, padY, sourceWidth, sourceHeight } = input.transform;
      const detections: DecodedDetection[] = [];
      for (const index of keptIndexes) {
        const base = index * 4;
        const y1 = boxData[base] ?? 0;
        const x1 = boxData[base + 1] ?? 0;
        const y2 = boxData[base + 2] ?? 0;
        const x2 = boxData[base + 3] ?? 0;
        // letterbox の余白を引いてから縮尺を戻す。
        const left = (x1 - padX) / scale;
        const top = (y1 - padY) / scale;
        const right = (x2 - padX) / scale;
        const bottom = (y2 - padY) / scale;
        detections.push({
          classIndex: classData[index] ?? 0,
          confidence: scoreData[index] ?? 0,
          bbox: {
            x: clamp(left, 0, sourceWidth),
            y: clamp(top, 0, sourceHeight),
            w: clamp(right - left, 0, sourceWidth),
            h: clamp(bottom - top, 0, sourceHeight),
          },
        });
      }
      // 表示と `Detection.rank` のために信頼度の降順で返す。
      return detections.sort((a, b) => b.confidence - a.confidence);
    },
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
