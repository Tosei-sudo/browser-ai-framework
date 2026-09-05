/// <reference lib="webworker" />
/**
 * ML Worker の入口（論点19）。
 *
 * 推論と学習はここでしか動かない。ジョブは1件ずつ順に実行する。
 * **中断だけはキューに並べず、その場でフラグを立てる。**
 *
 * 重みは OPFS から直接読む。メインスレッドを経由して数十MBを転送しない。
 * 外部取得ゼロ（論点36）。
 */
import * as tf from '@tensorflow/tfjs-core';
import type { BlobId, ModelId } from '@domain/ids';
import { selectBackend } from '@infrastructure/tfjs/backend';
import { loadFromArtifact, type LoadedGraphModel } from '@infrastructure/tfjs/modelLoader';
import { createPreprocessor } from '@infrastructure/tfjs/preprocessor';
import { createPostprocessor, finalizeDetections } from '@infrastructure/tfjs/postprocessor';
import { createOpfsBlobStore } from '@infrastructure/opfs/blobStore';
import {
  DEFAULT_HEAD_SPEC,
  decodeBoxes,
  deserializeHead,
  headForward,
  makeAnchors,
  type HeadSpec,
} from '@infrastructure/tfjs/yoloHead';
import { trainHead } from '@infrastructure/tfjs/trainingEngine';
import type { DecodedDetection, DetectionParams, RawOutput } from '@ports/mlRuntime';
import type { GraphModelRef, JobRequest, JobResponse, ModelRef } from './protocol';

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const blobStore = createOpfsBlobStore();
const preprocessor = createPreprocessor();
const postprocessor = createPostprocessor();

/** 読み込み済みのモデル。メモリ上限があるため、必要なものだけ保持する。 */
const loadedGraphs = new Map<ModelId, LoadedGraphModel>();

/** ジョブは1件ずつ実行する。前のジョブが終わるまで次を始めない。 */
let queue: Promise<void> = Promise.resolve();
/** 中断の要求。学習ループが各サンプルの前に見る。 */
let cancelRequested = false;

function post(message: JobResponse, transfer: Transferable[] = []): void {
  ctx.postMessage(message, transfer);
}

async function ensureGraph(ref: GraphModelRef): Promise<LoadedGraphModel> {
  const cached = loadedGraphs.get(ref.modelId);
  if (cached) return cached;
  const weights = await blobStore.get({ kind: 'model', id: ref.artifactId });
  if (!weights) throw new Error('重みが OPFS にない。先に取り込むこと');
  const model = await loadFromArtifact({
    modelId: ref.modelId,
    topology: ref.topology,
    weights,
  });
  loadedGraphs.set(ref.modelId, model);
  return model;
}

/** 特徴量は解像度の高い順（P3→P4→P5）に並べ替える。変換で順序が入れ替わる。 */
function sortFeatures(tensors: tf.Tensor[]): tf.Tensor4D[] {
  return [...tensors]
    .map((tensor) => tensor as tf.Tensor4D)
    .sort((a, b) => (b.shape[1] ?? 0) - (a.shape[1] ?? 0));
}

function headSpecFor(numClasses: number, inputSize: number): HeadSpec {
  return { ...DEFAULT_HEAD_SPEC, numClasses, inputSize };
}

interface InferOutcome {
  readonly detections: readonly DecodedDetection[];
  readonly elapsedMs: number;
}

async function inferGraph(
  ref: Extract<ModelRef, { kind: 'graph' }>,
  image: ImageBitmap,
  params: DetectionParams,
): Promise<InferOutcome> {
  const model = await ensureGraph(ref);
  const started = performance.now();
  const input = await preprocessor.run(image, ref.inputSpec);
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
  const detections = await postprocessor.run(raw, input, params);
  return { detections, elapsedMs: performance.now() - started };
}

/**
 * 学習したヘッドでの推論。
 *
 * バックボーン（凍結、GraphModel）で特徴量を出し、その上のヘッドを通す。
 * **バックボーンは系譜の親から辿ったもの**で、ヘッド単体では動かない（方針7）。
 */
async function inferHead(
  ref: Extract<ModelRef, { kind: 'head' }>,
  image: ImageBitmap,
  params: DetectionParams,
): Promise<InferOutcome> {
  const backbone = await ensureGraph(ref.backbone);
  const weights = await blobStore.get({ kind: 'model', id: ref.artifactId });
  if (!weights) throw new Error('学習したヘッドの重みが OPFS にない');
  const head = deserializeHead(weights);
  const anchors = makeAnchors(head.spec);

  const started = performance.now();
  const input = await preprocessor.run(image, ref.inputSpec);
  const inputTensor = tf.tensor(input.data, [...input.shape]);
  const features = sortFeatures(
    (() => {
      const output = backbone.execute(inputTensor);
      return Array.isArray(output) ? output : [output];
    })(),
  );
  inputTensor.dispose();

  const output = headForward(head, features);
  const decoded = decodeBoxes(output.boxDist, anchors, head.spec);
  const detections = await finalizeDetections(decoded, output.clsLogits, input, params);

  tf.dispose([
    ...features,
    output.clsLogits,
    output.boxDist,
    decoded,
    anchors.points,
    anchors.strides,
    ...head.variables,
  ]);
  return { detections, elapsedMs: performance.now() - started };
}

async function handleTrain(request: Extract<JobRequest, { type: 'train' }>): Promise<void> {
  const backend = await selectBackend();
  const backbone = await ensureGraph(request.backbone);
  const spec = headSpecFor(request.config.numClasses, request.backbone.inputSpec.size.width);
  const started = performance.now();

  const samples = request.samples.map((sample) => ({
    bitmap: async (): Promise<ImageBitmap> => {
      const bytes = await blobStore.get({ kind: 'image', id: sample.blobId as BlobId });
      if (!bytes) throw new Error('教師データの画像が OPFS にない');
      return createImageBitmap(new Blob([bytes], { type: sample.mimeType }));
    },
    boxes: sample.boxes,
  }));

  const result = await trainHead({
    backbone,
    samples,
    spec,
    config: {
      epochs: request.config.epochs,
      lr: request.config.lr,
      inputSpec: request.backbone.inputSpec,
    },
    onEpoch: (epoch, metrics) => {
      post({ type: 'progress', jobId: request.jobId, epoch, metrics: { ...metrics } });
    },
    shouldStop: () => cancelRequested,
  });

  post(
    {
      type: 'trained',
      jobId: request.jobId,
      weights: result.weights,
      finalMetrics: { ...result.finalMetrics },
      backend,
      elapsedMs: performance.now() - started,
    },
    [result.weights],
  );
}

async function handle(request: JobRequest): Promise<void> {
  switch (request.type) {
    case 'init': {
      const backend = await selectBackend();
      post({ type: 'ready', jobId: request.jobId, backend });
      return;
    }
    case 'infer': {
      const backend = await selectBackend();
      try {
        const outcome =
          request.model.kind === 'graph'
            ? await inferGraph(request.model, request.image, request.params)
            : await inferHead(request.model, request.image, request.params);
        post({
          type: 'inferred',
          jobId: request.jobId,
          detections: outcome.detections,
          elapsedMs: outcome.elapsedMs,
          backend,
        });
      } finally {
        request.image.close();
      }
      return;
    }
    case 'train':
      cancelRequested = false;
      await handleTrain(request);
      return;
    case 'cancel':
      // listener が先に処理する。念のためここでも受ける。
      cancelRequested = true;
      return;
    case 'unload': {
      loadedGraphs.get(request.modelId)?.dispose();
      loadedGraphs.delete(request.modelId);
      post({ type: 'unloaded', jobId: request.jobId });
      return;
    }
  }
}

ctx.addEventListener('message', (event: MessageEvent<JobRequest>) => {
  const request = event.data;
  // 中断は待たせない。学習の後ろに並べたら意味がない。
  if (request.type === 'cancel') {
    cancelRequested = true;
    return;
  }
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
