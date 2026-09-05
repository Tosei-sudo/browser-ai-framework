/**
 * Preprocessor の TF.js 実装（論点20・方針15）。
 *
 * `Model.input_spec` だけで挙動が決まる。ユースケース側は差し替えを意識しない。
 * letterbox は縦横比を保ったまま余白で埋める方式で、YOLO の学習時と揃える。
 */
import * as tf from '@tensorflow/tfjs-core';
import type { InputSpec } from '@domain/index';
import type { ModelInput, Preprocessor } from '@ports/mlRuntime';

export function createPreprocessor(): Preprocessor {
  return {
    async run(image: ImageBitmap, spec: InputSpec): Promise<ModelInput> {
      const targetWidth = spec.size.width;
      const targetHeight = spec.size.height;
      const scale = spec.letterbox
        ? Math.min(targetWidth / image.width, targetHeight / image.height)
        : 1;
      const drawWidth = spec.letterbox ? Math.round(image.width * scale) : targetWidth;
      const drawHeight = spec.letterbox ? Math.round(image.height * scale) : targetHeight;
      const padX = Math.floor((targetWidth - drawWidth) / 2);
      const padY = Math.floor((targetHeight - drawHeight) / 2);

      const tensor = tf.tidy(() => {
        const pixels = tf.cast(tf.browser.fromPixels(image), 'float32');
        const resized = tf.image.resizeBilinear(pixels, [drawHeight, drawWidth]);
        const padded = spec.letterbox
          ? tf.pad(resized, [
              [padY, targetHeight - drawHeight - padY],
              [padX, targetWidth - drawWidth - padX],
              [0, 0],
            ])
          : resized;
        // YOLO は 0〜1 に落とすだけ。mean / std は input_spec に従う。
        const mean = tf.tensor1d([...spec.normalize.mean]);
        const std = tf.tensor1d([...spec.normalize.std]);
        const scaled = tf.div(tf.sub(tf.div(padded, 255), mean), std);
        return tf.expandDims(scaled, 0);
      });

      const data = (await tensor.data()) as Float32Array;
      const shape = tensor.shape;
      tensor.dispose();

      return {
        data,
        shape,
        transform: {
          scale: spec.letterbox ? scale : targetWidth / image.width,
          padX,
          padY,
          sourceWidth: image.width,
          sourceHeight: image.height,
        },
      };
    },
  };
}
