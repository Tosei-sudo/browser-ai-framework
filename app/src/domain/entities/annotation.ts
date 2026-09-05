import type {
  AnnotationObjectId,
  AnnotationSetId,
  ImageId,
  InferenceTargetId,
  IsoDateTime,
  LabelClassId,
  LabelSetId,
} from '../ids';

/** 矩形。ピクセル座標か正規化座標かは `bbox_format` が決める（方針5）。 */
export interface BBox {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export type BBoxFormat = 'pixel_xywh' | 'normalized_xywh';

export type AnnotationSetStatus = 'draft' | 'confirmed';

/** 方針12: 推論結果から起こしたアノテーションは由来を残す。 */
export type AnnotationSource = 'manual' | 'imported' | 'from_detection';

/**
 * AnnotationSet — ある画像に対する、ある時点の、完成した1版（方針5）。
 *
 * 編集のたびに新しい版（`revision_no`）を作る。過去の学習が参照した版は
 * 書き換えない。
 */
export interface AnnotationSet {
  readonly annotation_set_id: AnnotationSetId;
  readonly image_id: ImageId;
  readonly label_set_id: LabelSetId;
  readonly revision_no: number;
  status: AnnotationSetStatus;
  readonly source: AnnotationSource;
  /** `source = from_detection` のときのみ非 null（方針12） */
  readonly origin_target_id: InferenceTargetId | null;
  readonly created_at: IsoDateTime;
}

export interface AnnotationObject {
  readonly object_id: AnnotationObjectId;
  readonly annotation_set_id: AnnotationSetId;
  /** 文字列のクラス名ではなく参照で持つ（方針1） */
  readonly label_class_id: LabelClassId;
  bbox: BBox;
  readonly bbox_format: BBoxFormat;
  /** 自由形式。検索対象にしない（04 §5） */
  attributes: Record<string, unknown>;
}
