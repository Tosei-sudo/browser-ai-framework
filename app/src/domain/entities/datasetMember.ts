import type { DatasetId, DatasetMemberId, ImageId, IsoDateTime } from '../ids';

/**
 * DatasetMember — 可変な `Dataset` に今入っている画像（方針2 の補完）。
 *
 * ERモデル（01）では `Dataset` を「ユーザーが編集し続ける可変の作業領域」と
 * 定義したが、**その中身を持つ場所が定義されていなかった。**
 * `DatasetItem` は凍結後の `DatasetVersion` に属するため、凍結前の出し入れを
 * 表せない。ここを埋めるエンティティ（2026-09-05 追加）。
 *
 * 凍結すると、この一覧から `DatasetItem` が作られる。
 */
export interface DatasetMember {
  readonly member_id: DatasetMemberId;
  readonly dataset_id: DatasetId;
  readonly image_id: ImageId;
  readonly added_at: IsoDateTime;
}
