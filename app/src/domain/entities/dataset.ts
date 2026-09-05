import type {
  AnnotationSetId,
  DatasetId,
  DatasetItemId,
  DatasetVersionId,
  ImageId,
  IsoDateTime,
  LabelSetId,
  ProjectId,
} from '../ids';

/**
 * Dataset — ユーザーが編集し続ける可変の作業領域（方針2 / 論点02）。
 * 学習が参照するのはこれではなく `DatasetVersion`。
 */
export interface Dataset {
  readonly dataset_id: DatasetId;
  readonly project_id: ProjectId;
  name: string;
  readonly label_set_id: LabelSetId;
  description: string;
  readonly created_at: IsoDateTime;
  updated_at: IsoDateTime;
}

export type SplitPolicy =
  | { readonly kind: 'ratio'; readonly train: number; readonly val: number; readonly test: number }
  | { readonly kind: 'manual' };

/**
 * DatasetVersion — 学習開始時に切り出す不変スナップショット（方針2）。
 *
 * 凍結（`frozen_at`）後は内容を変更しない。すべての属性が readonly なのは
 * この不変条件を型で表すため。
 */
export interface DatasetVersion {
  readonly dataset_version_id: DatasetVersionId;
  readonly dataset_id: DatasetId;
  readonly version_no: number;
  readonly item_count: number;
  readonly split_policy: SplitPolicy;
  readonly frozen_at: IsoDateTime;
}

export type DatasetSplit = 'train' | 'val' | 'test';

/**
 * DatasetItem — 版・画像・アノテーション版・split の4点を結びつける。
 * 「この学習は画像 X の rev3 を train として使った」を確定させる。
 */
export interface DatasetItem {
  readonly item_id: DatasetItemId;
  readonly dataset_version_id: DatasetVersionId;
  readonly image_id: ImageId;
  /** 使用したアノテーションの版を固定する */
  readonly annotation_set_id: AnnotationSetId;
  readonly split: DatasetSplit;
}
