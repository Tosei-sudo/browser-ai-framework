/**
 * LabelSetManager — クラス体系の定義と派生（方針1 / 持ち越し事項#1）。
 *
 * 作り方は2通り（#1 の決定）。
 *  1. **Base Model の体系を複製して編集する** — 派生元を残す
 *  2. **空から作る** — 新しいクラスだけを扱う
 *
 * `LabelClass.index` はモデル出力の次元との対応を固定する（方針1）。
 * **一度振った index は詰め直さない。** 詰め直すと過去のモデル出力の意味が変わる。
 */
import { assertLabelClassIndexes } from '@domain/invariants';
import { newId } from '@domain/ids';
import type { LabelClassId, LabelSetId, ProjectId } from '@domain/ids';
import type { LabelClass, LabelSet } from '@domain/index';
import type { Repositories, UnitOfWork } from '@ports/repository';

export interface LabelSetManagerDeps {
  readonly repositories: Repositories;
  readonly unitOfWork: UnitOfWork;
}

/** クラス index から色を決める（ModelManager と同じ規則）。 */
function colorFor(index: number): string {
  return `hsl(${((index * 137.508) % 360).toFixed(0)} 70% 55%)`;
}

export async function listLabelSets(
  deps: LabelSetManagerDeps,
  projectId: ProjectId,
): Promise<LabelSet[]> {
  return deps.repositories.labelSets.listByProject(projectId);
}

export async function createEmptyLabelSet(
  deps: LabelSetManagerDeps,
  projectId: ProjectId,
  name: string,
  classNames: readonly string[] = [],
): Promise<LabelSet> {
  return persist(deps, projectId, name, null, classNames);
}

/**
 * 既存の体系（Base Model のものを含む）を複製する。
 * 複製元は `derived_from_label_set_id` に残す。
 */
export async function deriveLabelSet(
  deps: LabelSetManagerDeps,
  projectId: ProjectId,
  sourceLabelSetId: LabelSetId,
  name: string,
): Promise<LabelSet> {
  const source = await deps.repositories.labelSets.get(sourceLabelSetId);
  if (!source) throw new Error(`複製元のクラス体系が見つからない: ${sourceLabelSetId}`);
  const classes = await deps.repositories.labelClasses.listByLabelSet(sourceLabelSetId);
  return persist(
    deps,
    projectId,
    name,
    sourceLabelSetId,
    classes.map((klass) => klass.name),
  );
}

async function persist(
  deps: LabelSetManagerDeps,
  projectId: ProjectId,
  name: string,
  derivedFrom: LabelSetId | null,
  classNames: readonly string[],
): Promise<LabelSet> {
  const labelSetId = newId<'LabelSetId'>() as LabelSetId;
  const labelSet: LabelSet = {
    label_set_id: labelSetId,
    project_id: projectId,
    name: name.trim() || 'クラス体系',
    class_count: classNames.length,
    derived_from_label_set_id: derivedFrom,
  };
  const classes: LabelClass[] = classNames.map((className, index) => ({
    label_class_id: newId<'LabelClassId'>() as LabelClassId,
    label_set_id: labelSetId,
    name: className,
    index,
    color: colorFor(index),
  }));
  assertLabelClassIndexes(labelSet, classes);

  await deps.unitOfWork.run(['label_sets', 'label_classes'], 'readwrite', async (repos) => {
    await repos.labelSets.put(labelSet);
    await repos.labelClasses.putMany(classes);
  });
  return labelSet;
}

/** クラスを末尾に足す。index は連番の続きで、既存の対応は動かさない。 */
export async function addClass(
  deps: LabelSetManagerDeps,
  labelSetId: LabelSetId,
  name: string,
): Promise<LabelClass> {
  const labelSet = await deps.repositories.labelSets.get(labelSetId);
  if (!labelSet) throw new Error(`クラス体系が見つからない: ${labelSetId}`);
  const classes = await deps.repositories.labelClasses.listByLabelSet(labelSetId);
  const klass: LabelClass = {
    label_class_id: newId<'LabelClassId'>() as LabelClassId,
    label_set_id: labelSetId,
    name: name.trim() || `class_${classes.length}`,
    index: classes.length,
    color: colorFor(classes.length),
  };
  const updated: LabelSet = { ...labelSet, class_count: classes.length + 1 };
  assertLabelClassIndexes(updated, [...classes, klass]);

  await deps.unitOfWork.run(['label_sets', 'label_classes'], 'readwrite', async (repos) => {
    await repos.labelClasses.put(klass);
    await repos.labelSets.put(updated);
  });
  return klass;
}

/** 名前と色だけ変える。index は変えない（方針1）。 */
export async function updateClass(
  deps: LabelSetManagerDeps,
  labelClassId: LabelClassId,
  patch: { readonly name?: string; readonly color?: string },
): Promise<void> {
  const klass = await deps.repositories.labelClasses.get(labelClassId);
  if (!klass) return;
  await deps.unitOfWork.run(['label_classes'], 'readwrite', async (repos) => {
    await repos.labelClasses.put({
      ...klass,
      name: patch.name ?? klass.name,
      color: patch.color ?? klass.color,
    });
  });
}

/**
 * クラスを消せるか調べる。
 *
 * アノテーションや検出結果から参照されているクラスは消さない。
 * 消すと履歴の意味が失われる（方針1・16）。**末尾のクラスだけ削除を許す**のは、
 * 途中を抜くと index が飛び、モデル出力との対応がずれるため。
 */
export async function canDeleteClass(
  deps: LabelSetManagerDeps,
  labelClassId: LabelClassId,
): Promise<{ readonly ok: boolean; readonly reason?: string }> {
  const klass = await deps.repositories.labelClasses.get(labelClassId);
  if (!klass) return { ok: false, reason: 'クラスが見つからない' };

  const classes = await deps.repositories.labelClasses.listByLabelSet(klass.label_set_id);
  if (klass.index !== classes.length - 1) {
    return { ok: false, reason: '末尾のクラスだけ削除できる（index を詰め直さないため）' };
  }
  const annotations = await deps.repositories.annotationObjects.countByLabelClass(labelClassId);
  if (annotations > 0) return { ok: false, reason: `アノテーション ${annotations} 件が参照している` };
  const detections = await deps.repositories.detections.countByLabelClass(labelClassId);
  if (detections > 0) return { ok: false, reason: `検出結果 ${detections} 件が参照している` };
  return { ok: true };
}

export async function deleteClass(
  deps: LabelSetManagerDeps,
  labelClassId: LabelClassId,
): Promise<void> {
  const check = await canDeleteClass(deps, labelClassId);
  if (!check.ok) throw new Error(check.reason ?? 'このクラスは削除できない');
  const klass = await deps.repositories.labelClasses.get(labelClassId);
  if (!klass) return;
  const labelSet = await deps.repositories.labelSets.get(klass.label_set_id);
  await deps.unitOfWork.run(['label_sets', 'label_classes'], 'readwrite', async (repos) => {
    await repos.labelClasses.delete(labelClassId);
    if (labelSet) {
      await repos.labelSets.put({ ...labelSet, class_count: labelSet.class_count - 1 });
    }
  });
}

/**
 * そのプロジェクトで使えるクラス体系。
 *
 * プロジェクト内のものに加えて、**Base Model のグローバルな体系**も含める
 * （方針11 の例外）。学習の教師データが Base Model のクラスで付いていることは
 * 普通にあるため、データセットやアノテーションでも選べる必要がある。
 */
export async function listUsableLabelSets(
  deps: LabelSetManagerDeps,
  projectId: ProjectId,
): Promise<LabelSet[]> {
  const own = await deps.repositories.labelSets.listByProject(projectId);
  const builtin = await deps.repositories.models.listBuiltin();
  const globalIds = [
    ...new Set(
      builtin
        .filter((model) => model.task_type === 'object_detection')
        .map((model) => model.label_set_id),
    ),
  ];
  const globals = (await deps.repositories.labelSets.getMany(globalIds)).filter(
    (set) => set.project_id === null,
  );
  return [...own, ...globals];
}
