/**
 * ERモデルで決めた不変条件（03 §4「Domain Layer を追加する理由」）。
 *
 * ここに集約する理由は、Manager や UI に散らすと
 * 「どこで守られているのか」が追えなくなるため。
 */
import { invariant } from './errors';
import type { AnnotationSet } from './entities/annotation';
import type { DatasetVersion } from './entities/dataset';
import type { LabelClass, LabelSet } from './entities/label';
import type { Model, ModelDerivation } from './entities/model';
import type { ProjectId } from './ids';

/**
 * 方針11: `Model.project_id` は `origin = builtin` のときのみ null を許す。
 *
 * Base Model だけがプロジェクト横断で共有され、それ以外は必ずどれか1つの
 * プロジェクトに属する。
 */
export function assertModelProjectScope(model: Model): void {
  if (model.origin === 'builtin') {
    invariant(
      model.project_id === null,
      'model.project_scope',
      `Base Model は project_id を持たない: ${model.model_id}`,
    );
    return;
  }
  invariant(
    model.project_id !== null,
    'model.project_scope',
    `origin=${model.origin} のモデルは project_id が必須: ${model.model_id}`,
  );
}

/**
 * 方針6: 重みの有無は `artifact_status` と `artifact_id` の両方で表す。
 * 片方だけ更新した状態を作らせない。
 */
export function assertModelArtifactConsistency(model: Model): void {
  if (model.artifact_status === 'present') {
    invariant(
      model.artifact_id !== null,
      'model.artifact_consistency',
      `artifact_status=present なのに artifact_id が null: ${model.model_id}`,
    );
  } else {
    invariant(
      model.artifact_id === null,
      'model.artifact_consistency',
      `artifact_status=evicted なのに artifact_id が残っている: ${model.model_id}`,
    );
  }
}

/**
 * 方針8: モデルは不変ノード。生成後に書き換えない。
 *
 * 重みの破棄・再取得で動く `artifact_id` / `artifact_status` だけが例外（方針6）。
 * 更新が必要になった場合は、書き換えではなく派生（`ModelDerivation`）で表す。
 */
const MUTABLE_MODEL_FIELDS = new Set<keyof Model>(['artifact_id', 'artifact_status']);

export function assertModelImmutable(before: Model, after: Model): void {
  for (const key of Object.keys(before) as (keyof Model)[]) {
    if (MUTABLE_MODEL_FIELDS.has(key)) continue;
    invariant(
      Object.is(before[key], after[key]) || isDeepEqual(before[key], after[key]),
      'model.immutable',
      `Model は不変ノード。${String(key)} を書き換えられない: ${before.model_id}`,
    );
  }
}

/**
 * 方針7: 系譜の親子関係は `ModelDerivation` にのみ持つ。
 * 自分自身を親にする派生は系譜を循環させるため許さない。
 */
export function assertDerivationValid(derivation: ModelDerivation): void {
  invariant(
    derivation.parent_model_id !== derivation.child_model_id,
    'derivation.no_self_reference',
    `自分自身からの派生は作れない: ${derivation.child_model_id}`,
  );
  if (derivation.kind === 'transfer_learning' || derivation.kind === 'fine_tune') {
    invariant(
      derivation.training_id !== null,
      'derivation.training_required',
      `kind=${derivation.kind} の派生には training_id が必要: ${derivation.derivation_id}`,
    );
  }
}

/**
 * 方針2: `DatasetVersion` は凍結後に内容を変更できない。
 * 版そのものを作り直す以外の変更経路を持たせない。
 */
export function assertDatasetVersionFrozen(before: DatasetVersion, after: DatasetVersion): void {
  for (const key of Object.keys(before) as (keyof DatasetVersion)[]) {
    invariant(
      isDeepEqual(before[key], after[key]),
      'dataset_version.frozen',
      `凍結済みの DatasetVersion は変更できない: ${before.dataset_version_id}`,
    );
  }
}

/**
 * 方針1: `LabelClass.index` はモデル出力の次元との対応を固定する。
 * 0 始まりの連番であり、欠番も重複も許さない。詰め直すと過去の出力の意味が変わる。
 */
export function assertLabelClassIndexes(labelSet: LabelSet, classes: readonly LabelClass[]): void {
  invariant(
    classes.length === labelSet.class_count,
    'label_set.class_count',
    `class_count(${labelSet.class_count}) と実際の件数(${classes.length}) が一致しない: ${labelSet.label_set_id}`,
  );
  const indexes = [...classes].map((c) => c.index).sort((a, b) => a - b);
  indexes.forEach((index, i) => {
    invariant(
      index === i,
      'label_class.index',
      `LabelClass.index は 0 始まりの連番でなければならない: ${labelSet.label_set_id}`,
    );
  });
}

/**
 * 方針12: 推論結果から起こしたアノテーションは由来を残す。
 * `source` と `origin_target_id` は必ず対応する。
 */
export function assertAnnotationOrigin(set: AnnotationSet): void {
  if (set.source === 'from_detection') {
    invariant(
      set.origin_target_id !== null,
      'annotation_set.origin',
      `source=from_detection には origin_target_id が必要: ${set.annotation_set_id}`,
    );
  } else {
    invariant(
      set.origin_target_id === null,
      'annotation_set.origin',
      `source=${set.source} に origin_target_id は持たせない: ${set.annotation_set_id}`,
    );
  }
}

/**
 * 方針11: プロジェクト間の参照を許さない。
 * Base Model（project_id = null）だけが例外で、どのプロジェクトからも参照できる。
 */
export function assertSameProject(
  scope: ProjectId,
  refs: readonly { readonly project_id: ProjectId | null; readonly label: string }[],
): void {
  for (const ref of refs) {
    if (ref.project_id === null) continue;
    invariant(
      ref.project_id === scope,
      'project.no_cross_reference',
      `プロジェクトをまたいだ参照は許されない: ${ref.label}`,
    );
  }
}

/** 構造を持つ属性（input_spec など）の比較用。JSON で表せる値だけを想定する。 */
function isDeepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}
