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
export type DatasetMemberId = Branded<'DatasetMemberId'>;
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

/**
 * 決まった文字列から毎回同じ ID を作る（UUID v5 相当）。
 *
 * Base Model のカタログ同期で使う。カタログの `key` から ID を導けば、
 * 起動のたびに同じレコードへ収束し、重複登録が起きない（方針18）。
 * 形式は UUID に揃える（方針17）。
 */
export async function stableId<T extends string>(namespace: string, key: string): Promise<Branded<T>> {
  const data = new TextEncoder().encode(`${namespace}:${key}`);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  const bytes = digest.slice(0, 16);
  // UUID の版（5）と variant を立てる。
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-') as Branded<T>;
}

/** バイト列の SHA-256（16進）。重みの検証と重複排除に使う。 */
export async function sha256Hex(data: ArrayBuffer): Promise<ContentHash> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('') as ContentHash;
}
