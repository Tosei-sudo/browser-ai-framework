import type {
  DatasetVersionId,
  IsoDateTime,
  LabelClassId,
  ModelId,
  ProjectId,
  TrainingId,
  TrainingMetricId,
} from '../ids';

/** 方針13: 失敗・中断した学習も記録として残す。 */
export type TrainingStatus = 'running' | 'completed' | 'failed' | 'cancelled';

/** source model のクラス index → dataset のクラスへの対応。 */
export type LabelMapping = Readonly<Record<number, LabelClassId>>;

/** 自由形式。インデックスを張らない（04 §5）。 */
export interface Hyperparameters {
  readonly epochs: number;
  readonly lr: number;
  readonly batch_size: number;
  /** 凍結する層。方針3 の frozen_layers */
  readonly frozen_layers: number | 'backbone' | 'none';
  readonly [key: string]: unknown;
}

/** 実行環境の記録。再現性の確認に使う。 */
export interface RuntimeInfo {
  readonly backend: string;
  readonly user_agent: string;
  readonly [key: string]: unknown;
}

/**
 * Training — 学習処理1回（方針3 / 論点03）。
 * 結果は独立エンティティにせず、ここと TrainingMetric / Evaluation に分解する。
 */
export interface Training {
  readonly training_id: TrainingId;
  readonly project_id: ProjectId;
  readonly source_model_id: ModelId;
  readonly dataset_version_id: DatasetVersionId;
  /** 失敗・中断時は null のまま残る（方針13） */
  output_model_id: ModelId | null;
  readonly label_mapping: LabelMapping;
  readonly hyperparameters: Hyperparameters;
  readonly augmentation: Record<string, unknown>;
  status: TrainingStatus;
  readonly started_at: IsoDateTime;
  ended_at: IsoDateTime | null;
  final_metrics: Readonly<Record<string, number>> | null;
  error_message: string | null;
  readonly runtime_info: RuntimeInfo;
}

/** TrainingMetric — 学習曲線を後から再描画するために 1:N で持つ。 */
export interface TrainingMetric {
  readonly metric_id: TrainingMetricId;
  readonly training_id: TrainingId;
  readonly epoch: number;
  readonly metric_name: string;
  readonly value: number;
  readonly logged_at: IsoDateTime;
}
