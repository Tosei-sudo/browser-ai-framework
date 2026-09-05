import type { LabelClassId, LabelSetId, ProjectId } from '../ids';

/**
 * LabelSet — Dataset と Model が「同じクラス集合の話をしている」ことを保証する
 * 唯一の仕組み（方針1 / 論点01）。
 */
export interface LabelSet {
  readonly label_set_id: LabelSetId;
  readonly project_id: ProjectId;
  name: string;
  readonly class_count: number;
  /** 既存の体系から派生させた場合の元。独立に作った場合は null */
  readonly derived_from_label_set_id: LabelSetId | null;
}

/**
 * LabelClass — `index` がモデル出力の次元との対応を固定する。
 *
 * `index` は同一 LabelSet 内で 0 始まりの連番であり、後から詰め直さない。
 * 詰め直すと過去のモデル出力の意味が変わる。
 */
export interface LabelClass {
  readonly label_class_id: LabelClassId;
  readonly label_set_id: LabelSetId;
  name: string;
  readonly index: number;
  /** 描画色（#RRGGBB） */
  color: string;
}
