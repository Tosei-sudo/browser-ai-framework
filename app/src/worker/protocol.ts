/**
 * ML Worker とメインスレッドの間で交わすメッセージ（論点19）。
 *
 * Worker は単一で、ジョブは1件ずつ実行する。推論と学習を分けないのは、
 * ブラウザのメモリ上限が最大の制約であり、Worker を分けると同じ重みを
 * 二重に持ちうるため（03 §4）。
 */
import type { InputSpec } from '@domain/index';
import type { ArtifactId, ModelId } from '@domain/ids';
import type { TopologyFile } from '@infrastructure/tfjs/modelLoader';
import type { Backend, DecodedDetection, DetectionParams } from '@ports/mlRuntime';

export type JobId = string;

/** 推論に必要な、モデル1件ぶんの情報。重みは OPFS から Worker が直接読む。 */
export interface ModelHandle {
  readonly modelId: ModelId;
  readonly artifactId: ArtifactId;
  /** 配信物の `model.json` の中身。取得は Infrastructure が行い、Worker には渡すだけ */
  readonly topology: TopologyFile;
  readonly inputSpec: InputSpec;
}

/** メインスレッド → Worker */
export type JobRequest =
  | { readonly type: 'init'; readonly jobId: JobId }
  | {
      readonly type: 'infer';
      readonly jobId: JobId;
      readonly model: ModelHandle;
      readonly image: ImageBitmap;
      readonly params: DetectionParams;
    }
  | { readonly type: 'unload'; readonly jobId: JobId; readonly modelId: ModelId };

/** Worker → メインスレッド */
export type JobResponse =
  | { readonly type: 'ready'; readonly jobId: JobId; readonly backend: Backend }
  | {
      readonly type: 'inferred';
      readonly jobId: JobId;
      readonly detections: readonly DecodedDetection[];
      readonly elapsedMs: number;
      readonly backend: Backend;
    }
  | { readonly type: 'unloaded'; readonly jobId: JobId }
  | {
      readonly type: 'progress';
      readonly jobId: JobId;
      readonly epoch: number;
      readonly metrics: Readonly<Record<string, number>>;
    }
  | { readonly type: 'failed'; readonly jobId: JobId; readonly message: string };
