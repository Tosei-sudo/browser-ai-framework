import type {
  DetectionId,
  ImageId,
  InferenceId,
  InferenceTargetId,
  IsoDateTime,
  LabelClassId,
  ModelId,
  ProjectId,
} from '../ids';
import type { BBox, BBoxFormat } from './annotation';
import type { RuntimeInfo } from './training';

/**
 * Inference — 推論の実行1回（方針9 / 論点11）。
 * スレッショルドはモデル属性ではなく実行ごとにここへ持つ（方針15）。
 */
export interface Inference {
  readonly inference_id: InferenceId;
  readonly project_id: ProjectId;
  readonly model_id: ModelId;
  readonly conf_threshold: number;
  readonly iou_threshold: number;
  readonly max_detections: number;
  readonly runtime_info: RuntimeInfo;
  readonly executed_at: IsoDateTime;
  /** 方針14: pinned は保持ポリシーの自動削除から除外する */
  pinned: boolean;
}

export type InferenceTargetStatus = 'succeeded' | 'failed' | 'skipped';

/**
 * InferenceTarget — 実行 × 画像1枚。画像ごとの成否と処理時間を持つ。
 * 推論の記録は Target 単位でコミットする（04 §6.3）。
 */
export interface InferenceTarget {
  readonly target_id: InferenceTargetId;
  readonly inference_id: InferenceId;
  readonly image_id: ImageId;
  status: InferenceTargetStatus;
  elapsed_ms: number | null;
  error_message: string | null;
}

/** Detection — 検出1件。クラスは参照で持つため、後から名称を変えても壊れない。 */
export interface Detection {
  readonly detection_id: DetectionId;
  readonly target_id: InferenceTargetId;
  readonly label_class_id: LabelClassId;
  readonly confidence: number;
  readonly bbox: BBox;
  readonly bbox_format: BBoxFormat;
  /** confidence 降順の順位。0 始まり */
  readonly rank: number;
}
