/**
 * ドメインの値と IndexedDB のレコードの相互変換。
 *
 * **IndexedDB のキーにできない値があるため、索引に使う属性だけ形を変える。**
 *
 * - 真偽値はキーにできない → `pinned` は 0 / 1 で保持する（04 §4.5）
 * - null はキーにできない → `deleted_at` は未削除を '' で保持する
 *   （null のままだと `[project_id, deleted_at]` に載らず、
 *   「削除済みを除いた一覧」がそもそも引けない）
 *
 * ERモデル上の型は変えない。変換はこの層に閉じる。
 */
import type { Image, Inference } from '@domain/index';
import type { IsoDateTime } from '@domain/ids';

/** 未削除を表す番兵。空文字は有効なキーであり、どの日時文字列よりも小さい。 */
export const NOT_DELETED = '';

type ImageRecord = Omit<Image, 'deleted_at'> & { readonly deleted_at: string };
type InferenceRecord = Omit<Inference, 'pinned'> & { readonly pinned: 0 | 1 };

export function imageToRecord(image: Image): ImageRecord {
  return { ...image, deleted_at: image.deleted_at ?? NOT_DELETED };
}

export function imageFromRecord(record: ImageRecord): Image {
  return {
    ...record,
    deleted_at: record.deleted_at === NOT_DELETED ? null : (record.deleted_at as IsoDateTime),
  };
}

export function inferenceToRecord(inference: Inference): InferenceRecord {
  return { ...inference, pinned: inference.pinned ? 1 : 0 };
}

export function inferenceFromRecord(record: InferenceRecord): Inference {
  return { ...record, pinned: record.pinned === 1 };
}
