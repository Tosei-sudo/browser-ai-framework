/// <reference lib="webworker" />
/**
 * ML Worker の入口（論点19）。
 *
 * ここに推論・学習の実装（TensorFlow.js）を置く。**メインスレッドからは
 * ジョブキュー経由でしか呼ばれない。** M0 の時点では受け口とバンドル構成だけを
 * 用意し、実際のエンジンは M3（推論）・M5（学習）で入れる。
 *
 * 外部取得ゼロ（論点36）。このファイルとここから読み込むものは、
 * すべて同一オリジンの配信物に含まれていなければならない。
 */
import type { JobRequest, JobResponse } from './protocol';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

/** ジョブは1件ずつ実行する。前のジョブが終わるまで次を始めない。 */
let queue: Promise<void> = Promise.resolve();

function post(message: JobResponse): void {
  ctx.postMessage(message);
}

async function handle(request: JobRequest): Promise<void> {
  switch (request.type) {
    case 'init': {
      // 論点34: WebGPU を優先し、使えなければ WebGL に退避する。
      // 実際のバックエンド初期化は M3 で TensorFlow.js を入れるときに行う。
      const backend = 'gpu' in navigator ? 'webgpu' : 'webgl';
      post({ type: 'ready', jobId: request.jobId, backend });
      return;
    }
    case 'infer': {
      request.image.close();
      post({
        type: 'failed',
        jobId: request.jobId,
        message: '推論エンジンは未実装（M3 で実装する）',
      });
      return;
    }
    case 'cancel': {
      post({
        type: 'failed',
        jobId: request.jobId,
        message: 'キャンセルは未実装（M3 で実装する）',
      });
      return;
    }
  }
}

ctx.addEventListener('message', (event: MessageEvent<JobRequest>) => {
  const request = event.data;
  queue = queue.then(() =>
    handle(request).catch((error: unknown) => {
      post({
        type: 'failed',
        jobId: request.jobId,
        message: error instanceof Error ? error.message : String(error),
      });
    }),
  );
});
