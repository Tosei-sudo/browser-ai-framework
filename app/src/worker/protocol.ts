/**
 * ML Worker とメインスレッドの間で交わすメッセージ（論点19）。
 *
 * Worker は単一で、ジョブは1件ずつ実行する。推論と学習を分けないのは、
 * ブラウザのメモリ上限が最大の制約であり、Worker を分けると同じ重みを
 * 二重に持ちうるため（03 §4）。
 *
 * **中断（cancel）だけはキューに並べず即座に処理する。** 学習の後ろに
 * 並べたら、学習が終わるまで中断できない。
 */
import type { InputSpec } from '@domain/index';
import type { ArtifactId, ModelId } from '@domain/ids';
import type { Backend, DecodedDetection, DetectionParams } from '@ports/mlRuntime';
import type { TopologyFile } from '@infrastructure/tfjs/modelLoader';

export type JobId = string;

/** 変換して持ち込んだモデル（GraphModel）。重みは Worker が OPFS から読む。 */
export interface GraphModelRef {
  readonly modelId: ModelId;
  readonly artifactId: ArtifactId;
  readonly topology: TopologyFile;
  readonly inputSpec: InputSpec;
}

/** ブラウザ内で学習した検出ヘッド。バックボーンは系譜の親から辿って渡す。 */
export interface HeadModelRef {
  readonly modelId: ModelId;
  readonly artifactId: ArtifactId;
  readonly backbone: GraphModelRef;
  readonly inputSpec: InputSpec;
}

export type ModelRef =
  | ({ readonly kind: 'graph' } & GraphModelRef)
  | ({ readonly kind: 'head' } & HeadModelRef);

/** 学習1件ぶんの教師データ。実体は Worker が OPFS から読む。 */
export interface TrainingSampleRef {
  readonly blobId: string;
  readonly mimeType: string;
  /** 元画像の画素座標 xywh + クラス index */
  readonly boxes: readonly {
    readonly x: number;
    readonly y: number;
    readonly w: number;
    readonly h: number;
    readonly cls: number;
  }[];
}

export interface TrainingJobConfig {
  readonly epochs: number;
  readonly lr: number;
  readonly numClasses: number;
}

/** メインスレッド → Worker */
export type JobRequest =
  | { readonly type: 'init'; readonly jobId: JobId }
  | {
      readonly type: 'infer';
      readonly jobId: JobId;
      readonly model: ModelRef;
      readonly image: ImageBitmap;
      readonly params: DetectionParams;
    }
  | {
      readonly type: 'train';
      readonly jobId: JobId;
      readonly backbone: GraphModelRef;
      readonly samples: readonly TrainingSampleRef[];
      readonly config: TrainingJobConfig;
    }
  | { readonly type: 'cancel'; readonly jobId: JobId }
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
  | {
      readonly type: 'progress';
      readonly jobId: JobId;
      readonly epoch: number;
      readonly metrics: Readonly<Record<string, number>>;
    }
  | {
      readonly type: 'trained';
      readonly jobId: JobId;
      readonly weights: ArrayBuffer;
      readonly finalMetrics: Readonly<Record<string, number>>;
      readonly backend: Backend;
      readonly elapsedMs: number;
    }
  | { readonly type: 'unloaded'; readonly jobId: JobId }
  | { readonly type: 'failed'; readonly jobId: JobId; readonly message: string };
