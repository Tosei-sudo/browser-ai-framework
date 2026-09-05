/**
 * 実行バックエンドの選択（論点34）。
 *
 * **WebGPU を優先し、使えない環境では WebGL に退避する。**
 * 論点36でブラウザが「新しめの Chrome / Edge」と確定したため、
 * WebGL への退避は保険であって主役ではない。
 */
import * as tf from '@tensorflow/tfjs-core';
// tfjs-core だけを使う構成では、勾配は既定で登録されない（バンドルを小さく保つため）。
// 学習に必要なので明示的に登録する。umbrella の @tensorflow/tfjs はこれを内部でやっている。
import '@tensorflow/tfjs-core/dist/register_all_gradients';
import '@tensorflow/tfjs-backend-webgl';
import '@tensorflow/tfjs-backend-webgpu';
import type { Backend } from '@ports/mlRuntime';

let selected: Backend | null = null;

export async function selectBackend(): Promise<Backend> {
  if (selected) return selected;

  if ('gpu' in navigator) {
    try {
      await tf.setBackend('webgpu');
      await tf.ready();
      selected = 'webgpu';
      return selected;
    } catch {
      // WebGPU の初期化に失敗した。WebGL に退避する。
    }
  }
  await tf.setBackend('webgl');
  await tf.ready();
  selected = 'webgl';
  return selected;
}
