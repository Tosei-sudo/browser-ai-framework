/// <reference lib="webworker" />
/**
 * ML Worker の入口（論点19）。
 *
 * 推論はここでしか動かない。メインスレッドからはジョブキュー経由で呼ばれ、
 * **ジョブは1件ずつ順に実行する。**
 *
 * 重みは OPFS から直接読む。メインスレッドを経由して数十MBを転送しない。
 * モデル構造（model.json）は取得済みのものを受け取る。外部取得ゼロ（論点36）。
 */
import * as tf from '@tensorflow/tfjs-core';
import type { ModelId } from '@domain/ids';
import { selectBackend } from '@infrastructure/tfjs/backend';
import { loadFromArtifact, type LoadedGraphModel } from '@infrastructure/tfjs/modelLoader';
import { createPreprocessor } from '@infrastructure/tfjs/preprocessor';
import { createPostprocessor } from '@infrastructure/tfjs/postprocessor';
import { createOpfsBlobStore } from '@infrastructure/opfs/blobStore';
import type { RawOutput } from '@ports/mlRuntime';
import type { JobRequest, JobResponse, ModelHandle } from './protocol';

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const blobStore = createOpfsBlobStore();
const preprocessor = createPreprocessor();
const postprocessor = createPostprocessor();

/** 読み込み済みのモデル。メモリ上限があるため、必要なものだけ保持する。 */
const loaded = new Map<ModelId, LoadedGraphModel>();

/** ジョブは1件ずつ実行する。前のジョブが終わるまで次を始めない。 */
let queue: Promise<void> = Promise.resolve();

function post(message: JobResponse): void {
  ctx.postMessage(message);
}

async function ensureLoaded(handle: ModelHandle): Promise<LoadedGraphModel> {
  const cached = loaded.get(handle.modelId);
  if (cached) return cached;

  const weights = await blobStore.get({ kind: 'model', id: handle.artifactId });
  if (!weights) {
    // メタはあるが実体がない。M2 の取り込みが済んでいないか、破棄された。
    throw new Error('重みが OPFS にない。先に取り込むこと');
  }
  const model = await loadFromArtifact({
    modelId: handle.modelId,
    topology: handle.topology,
    weights,
  });
  loaded.set(handle.modelId, model);
  return model;
}

async function infer(request: Extract<JobRequest, { type: 'infer' }>): Promise<void> {
  const backend = await selectBackend();
  const model = await ensureLoaded(request.model);

  const started = performance.now();
  const input = await preprocessor.run(request.image, request.model.inputSpec);
  request.image.close();

  const inputTensor = tf.tensor(input.data, [...input.shape]);
  let raw: RawOutput;
  try {
    const output = await model.executeAsync(inputTensor);
    const tensor = Array.isArray(output) ? output[0] : output;
    if (!tensor) throw new Error('モデルが出力を返さなかった');
    raw = { data: (await tensor.data()) as Float32Array, shape: tensor.shape };
    tf.dispose(output);
  } finally {
    inputTensor.dispose();
  }

  const detections = await postprocessor.run(raw, input, request.params);
  post({
    type: 'inferred',
    jobId: request.jobId,
    detections,
    elapsedMs: performance.now() - started,
    backend,
  });
}

async function handle(request: JobRequest): Promise<void> {
  switch (request.type) {
    case 'init': {
      const backend = await selectBackend();
      post({ type: 'ready', jobId: request.jobId, backend });
      return;
    }
    case 'infer':
      await infer(request);
      return;
    case 'unload': {
      loaded.get(request.modelId)?.dispose();
      loaded.delete(request.modelId);
      post({ type: 'unloaded', jobId: request.jobId });
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
