import type { BlobId, ContentHash, ImageId, IsoDateTime, ProjectId } from '../ids';

export type ImageSource = 'upload' | 'capture' | 'import';

/**
 * Image — 複数の Dataset・推論から共有参照される画像のメタ。
 *
 * 削除は論理削除（方針16）。`deleted_at` が入っていても、
 * 過去の学習・推論が参照する行は残す。
 */
export interface Image {
  readonly image_id: ImageId;
  readonly project_id: ProjectId;
  readonly blob_id: BlobId;
  readonly width: number;
  readonly height: number;
  readonly content_hash: ContentHash;
  readonly source: ImageSource;
  readonly imported_at: IsoDateTime;
  /** 論理削除。未削除は null（方針16） */
  deleted_at: IsoDateTime | null;
}

/**
 * ImageBlob — 画像の実体。`content_hash` 一致で重複排除する（方針16）。
 *
 * `data` は OPFS に置くため、IndexedDB に保存するメタには含めない。
 * 実体の入出力は `BlobStore` が担う（03 §5）。
 */
export interface ImageBlob {
  readonly blob_id: BlobId;
  readonly content_hash: ContentHash;
  readonly mime_type: string;
  readonly byte_size: number;
}
