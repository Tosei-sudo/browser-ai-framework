/**
 * ML ランタイム側の Port（03 §5）。
 *
 * Application Layer は TensorFlow.js に直接依存しない（`order.txt` §11 ⑥）。
 * 実装は単一の ML Worker の中に置き、ジョブキュー経由で呼ばれる（論点19）。
 */
import type { InputSpec, Model, RuntimeInfo } from '@domain/index';
import type { DatasetVersionId, ModelId } from '@domain/ids';
import type { Hyperparameters, LabelMapping } from '@domain/entities/training';

/** 実行バックエンド。WebGPU 優先、WebGL 退避（論点34）。 */
export type Backend = 'webgpu' | 'webgl';

/** 前処理済みのモデル入力。形状は `InputSpec` から決まる。 */
export interface ModelInput {
  readonly data: Float32Array;
  readonly shape: readonly number[];
  /** letterbox で加えた余白とスケール。後処理で座標を元に戻すのに使う */
  readonly transform: {
    readonly scale: number;
    readonly padX: number;
    readonly padY: number;
    readonly sourceWidth: number;
    readonly sourceHeight: number;
  };
}

/** モデルの生の出力。形式の解釈は `Postprocessor` が行う。 */
export interface RawOutput {
  readonly data: Float32Array;
  readonly shape: readonly number[];
}

/**
 * Preprocessor — `Model.input_spec` に従い画像をモデル入力へ変換する（論点20・方針15）。
 * モデルのメタ情報だけで挙動が決まるため、ユースケース側は差し替えを意識しない。
 */
export interface Preprocessor {
  run(image: ImageBitmap, spec: InputSpec): Promise<ModelInput>;
}

/** 推論の実行時パラメータ。モデル属性ではなく実行ごとに渡す（方針15）。 */
export interface DetectionParams {
  readonly confThreshold: number;
  readonly iouThreshold: number;
  readonly maxDetections: number;
}

/**
 * Postprocessor — 生の出力を検出結果へ変換する（デコード・NMS）。
 *
 * `label_class_id` の解決は Application Layer が行うため、ここでは
 * クラスの index までを返す。
 */
export interface DecodedDetection {
  readonly classIndex: number;
  readonly confidence: number;
  readonly bbox: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
}

export interface Postprocessor {
  run(
    output: RawOutput,
    input: ModelInput,
    params: DetectionParams,
  ): Promise<DecodedDetection[]>;
}

/** ModelLoader — 重みのロード・アンロード・形式の解釈。 */
export interface LoadedModel {
  readonly modelId: ModelId;
  readonly backend: Backend;
}

export interface ModelLoader {
  load(model: Model, weights: ArrayBuffer): Promise<LoadedModel>;
  unload(modelId: ModelId): Promise<void>;
  /** 現在ロード済みのモデル。メモリ上限の管理に使う */
  loaded(): Promise<ModelId[]>;
}

/** InferenceEngine — モデルと画像を受け取り検出結果を返す。 */
export interface InferenceRequest {
  readonly modelId: ModelId;
  readonly image: ImageBitmap;
  readonly params: DetectionParams;
}

export interface InferenceResult {
  readonly detections: readonly DecodedDetection[];
  readonly elapsedMs: number;
}

export interface InferenceEngine {
  infer(request: InferenceRequest): Promise<InferenceResult>;
  runtimeInfo(): Promise<RuntimeInfo>;
}

/**
 * TrainingEngine — source model + dataset version + 学習条件を受け取り、
 * 進捗を通知しつつ重みを返す。
 *
 * 将来のGPUサーバー学習も、この Port の別実装として追加できる（03 §4）。
 * MVP のスコープ外（論点30）だが、Application Layer が依存する形は先に決めておく。
 */
export interface TrainingRequest {
  readonly sourceModelId: ModelId;
  readonly datasetVersionId: DatasetVersionId;
  readonly hyperparameters: Hyperparameters;
  readonly labelMapping: LabelMapping;
}

export interface TrainingProgress {
  readonly epoch: number;
  readonly metrics: Readonly<Record<string, number>>;
}

export interface TrainingOutcome {
  readonly weights: ArrayBuffer;
  readonly finalMetrics: Readonly<Record<string, number>>;
  readonly runtimeInfo: RuntimeInfo;
}

export interface TrainingEngine {
  train(
    request: TrainingRequest,
    onProgress: (progress: TrainingProgress) => void,
    signal: AbortSignal,
  ): Promise<TrainingOutcome>;
}
