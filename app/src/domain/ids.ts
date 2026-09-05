/**
 * ID の型定義（方針17: ID は UUID / ULID）。
 *
 * エンティティごとに別のブランド型にして、`image_id` を期待する場所へ
 * `model_id` を渡すといった取り違えをコンパイル時に落とす。
 * 実体はいずれも文字列なので、永続化・エクスポート時の扱いは変わらない。
 */

declare const brand: unique symbol;

type Branded<K extends string> = string & { readonly [brand]: K };

export type ProjectId = Branded<'ProjectId'>;
export type ImageId = Branded<'ImageId'>;
export type BlobId = Branded<'BlobId'>;
export type AnnotationSetId = Branded<'AnnotationSetId'>;
export type AnnotationObjectId = Branded<'AnnotationObjectId'>;
export type LabelSetId = Branded<'LabelSetId'>;
export type LabelClassId = Branded<'LabelClassId'>;
export type DatasetId = Branded<'DatasetId'>;
export type DatasetVersionId = Branded<'DatasetVersionId'>;
export type DatasetItemId = Branded<'DatasetItemId'>;
export type ModelId = Branded<'ModelId'>;
export type ArtifactId = Branded<'ArtifactId'>;
export type DerivationId = Branded<'DerivationId'>;
export type TrainingId = Branded<'TrainingId'>;
export type TrainingMetricId = Branded<'TrainingMetricId'>;
export type EvaluationId = Branded<'EvaluationId'>;
export type EvaluationMetricId = Branded<'EvaluationMetricId'>;
export type InferenceId = Branded<'InferenceId'>;
export type InferenceTargetId = Branded<'InferenceTargetId'>;
export type DetectionId = Branded<'DetectionId'>;

/** ISO 8601（UTC）の日時文字列。文字列のまま辞書順で時系列に並ぶ。 */
export type IsoDateTime = Branded<'IsoDateTime'>;

/** 内容ハッシュ（方針16 の重複排除、`ModelArtifact.checksum` に使う）。 */
export type ContentHash = Branded<'ContentHash'>;

/** UUID v4 を発行する。閉域でも動くよう Web Crypto のみを使う。 */
export function newId<T extends string>(): Branded<T> {
  return crypto.randomUUID() as Branded<T>;
}

export function now(): IsoDateTime {
  return new Date().toISOString() as IsoDateTime;
}

export function toIsoDateTime(value: Date | string): IsoDateTime {
  return (typeof value === 'string' ? new Date(value) : value).toISOString() as IsoDateTime;
}
