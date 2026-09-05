import type {
  ArtifactId,
  ContentHash,
  DerivationId,
  IsoDateTime,
  LabelSetId,
  ModelId,
  ProjectId,
  TrainingId,
} from '../ids';

export type ModelOrigin = 'builtin' | 'user_trained' | 'imported';

/**
 * モデルの役割。
 *
 * `feature_extraction` は検出ヘッドを外したバックボーン（2026-09-05 追加）。
 * 単体では推論に使えないが、転移学習の土台として系譜の親になる（方針7）。
 */
export type TaskType = 'object_detection' | 'feature_extraction';

/** 前処理仕様（方針15）。実行時のスレッショルドはここに含めない。 */
export interface InputSpec {
  readonly size: { readonly width: number; readonly height: number };
  readonly normalize: { readonly mean: readonly number[]; readonly std: readonly number[] };
  readonly letterbox: boolean;
}

/** 重みの有無（方針6）。`evicted` は「メタは残るが実体は破棄済み」。 */
export type ArtifactStatus = 'present' | 'evicted';

/**
 * Model — 系譜上の1ノード。生成後に書き換えない不変ノード（方針8 / 論点08）。
 *
 * 親子関係はここではなく `ModelDerivation` にのみ持つ（方針7）。
 * `artifact_id` / `artifact_status` だけは重みの破棄・再取得で変わる（方針6）。
 */
export interface Model {
  readonly model_id: ModelId;
  /** Base Model（`origin = builtin`）のときのみ null（方針11） */
  readonly project_id: ProjectId | null;
  readonly name: string;
  readonly origin: ModelOrigin;
  readonly task_type: TaskType;
  readonly label_set_id: LabelSetId;
  readonly input_spec: InputSpec;
  /** 重みを破棄すると null になる（方針6） */
  artifact_id: ArtifactId | null;
  artifact_status: ArtifactStatus;
  /** 学習で生まれたモデルのみ非 null */
  readonly created_by_training_id: TrainingId | null;
  readonly created_at: IsoDateTime;
}

/**
 * 重みの形式（論点32）。
 *
 * - `tfjs_graph_model`: 変換して持ち込んだモデル（推論専用）
 * - `baif_yolo_head_v1`: ブラウザ内で学習した検出ヘッド（2026-09-05 追加）。
 *   バックボーンは持たず、系譜の親から辿る
 */
export type ModelFormat = 'tfjs_graph_model' | 'baif_yolo_head_v1';

/**
 * ModelArtifact — 重みの実体のメタ（方針6）。
 * 実体そのものは OPFS に置き、`BlobStore` が扱う。
 */
export interface ModelArtifact {
  readonly artifact_id: ArtifactId;
  readonly format: ModelFormat;
  readonly byte_size: number;
  readonly checksum: ContentHash;
  readonly stored_at: IsoDateTime;
}

/** 派生の種別（方針7）。学習を伴わない派生も同じ系譜に載せる。 */
export type DerivationKind =
  | 'transfer_learning'
  | 'fine_tune'
  | 'convert'
  | 'quantize'
  | 'import';

/**
 * ModelDerivation — モデルの親子関係（方針7 / 論点07）。
 * 系譜の遡上は `child_model_id` から再帰的に辿る。
 */
export interface ModelDerivation {
  readonly derivation_id: DerivationId;
  readonly parent_model_id: ModelId;
  readonly child_model_id: ModelId;
  readonly kind: DerivationKind;
  /** 学習由来のときのみ非 null */
  readonly training_id: TrainingId | null;
  readonly created_at: IsoDateTime;
}
