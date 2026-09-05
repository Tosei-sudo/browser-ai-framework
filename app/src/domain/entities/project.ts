import type { IsoDateTime, ProjectId } from '../ids';

/**
 * Project — トップレベル資産のスコープ単位（方針10 / 論点16）。
 *
 * MVP では既定プロジェクト1件に固定し、管理UIは持たない（論点37）。
 * ただしスキーマ上は最初から存在し、全エンティティが `project_id` を持つ。
 */
export interface Project {
  readonly project_id: ProjectId;
  name: string;
  description: string;
  readonly created_at: IsoDateTime;
  updated_at: IsoDateTime;
}
