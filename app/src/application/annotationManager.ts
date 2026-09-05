/**
 * AnnotationManager — アノテーションの作成と版管理（方針5・12）。
 *
 * 「ある画像に対する、ある時点の、完成した1版」が `AnnotationSet`。
 * **編集のたびに新しい版を作り、過去の版は書き換えない。**
 * 版は全件残す（持ち越し事項#4 の決定）。矩形のレコードは軽く、
 * 「データを捨てない」（`order.txt` §11 ③）にも合う。
 */
import { assertAnnotationOrigin } from '@domain/invariants';
import { newId, now } from '@domain/ids';
import type {
  AnnotationObjectId,
  AnnotationSetId,
  ImageId,
  InferenceTargetId,
  LabelSetId,
} from '@domain/ids';
import type { AnnotationObject, AnnotationSet, BBox } from '@domain/index';
import type { Repositories, UnitOfWork } from '@ports/repository';

export interface AnnotationManagerDeps {
  readonly repositories: Repositories;
  readonly unitOfWork: UnitOfWork;
}

/** 編集中の1つの矩形。まだ `AnnotationObject` になっていない状態。 */
export interface DraftObject {
  readonly label_class_id: AnnotationObject['label_class_id'];
  readonly bbox: BBox;
}

export interface Revision {
  readonly set: AnnotationSet;
  readonly objects: AnnotationObject[];
}

export async function loadLatest(
  deps: AnnotationManagerDeps,
  imageId: ImageId,
): Promise<Revision | undefined> {
  const set = await deps.repositories.annotationSets.findLatestByImage(imageId);
  if (!set) return undefined;
  return {
    set,
    objects: await deps.repositories.annotationObjects.listByAnnotationSet(set.annotation_set_id),
  };
}

export async function listRevisions(
  deps: AnnotationManagerDeps,
  imageId: ImageId,
): Promise<AnnotationSet[]> {
  const list = await deps.repositories.annotationSets.listByImage(imageId);
  return [...list].reverse();
}

/**
 * 新しい版を保存する（方針5）。
 *
 * `revision_no` は既存の最大 + 1。**同じ版を上書きしない。**
 * 版と矩形は単一トランザクションでコミットする（04 §6.3）。
 */
export async function saveRevision(
  deps: AnnotationManagerDeps,
  params: {
    readonly imageId: ImageId;
    readonly labelSetId: LabelSetId;
    readonly objects: readonly DraftObject[];
    readonly source?: AnnotationSet['source'];
    readonly originTargetId?: InferenceTargetId;
    readonly status?: AnnotationSet['status'];
  },
): Promise<Revision> {
  const existing = await deps.repositories.annotationSets.listByImage(params.imageId);
  const revisionNo = existing.reduce((max, set) => Math.max(max, set.revision_no), 0) + 1;

  const setId = newId<'AnnotationSetId'>() as AnnotationSetId;
  const set: AnnotationSet = {
    annotation_set_id: setId,
    image_id: params.imageId,
    label_set_id: params.labelSetId,
    revision_no: revisionNo,
    status: params.status ?? 'confirmed',
    source: params.source ?? 'manual',
    origin_target_id: params.originTargetId ?? null,
    created_at: now(),
  };
  assertAnnotationOrigin(set);

  const objects: AnnotationObject[] = params.objects.map((draft) => ({
    object_id: newId<'AnnotationObjectId'>() as AnnotationObjectId,
    annotation_set_id: setId,
    label_class_id: draft.label_class_id,
    bbox: draft.bbox,
    // 画素座標で持つ。正規化は学習時に行う（方針5）。
    bbox_format: 'pixel_xywh',
    attributes: {},
  }));

  await deps.unitOfWork.run(['annotation_sets', 'annotation_objects'], 'readwrite', async (repos) => {
    await repos.annotationSets.put(set);
    await repos.annotationObjects.putMany(objects);
  });
  return { set, objects };
}

/**
 * 推論結果からアノテーションを起こす（方針12）。
 *
 * 由来を `origin_target_id` に残すので、「この教師データは推論結果由来」が
 * 後から辿れる。クラス体系は推論に使ったモデルのものをそのまま使う。
 */
export async function createFromDetections(
  deps: AnnotationManagerDeps,
  targetId: InferenceTargetId,
  options: { readonly minConfidence?: number } = {},
): Promise<Revision> {
  const target = await deps.repositories.inferenceTargets.get(targetId);
  if (!target) throw new Error(`推論の対象が見つからない: ${targetId}`);
  const inference = await deps.repositories.inferences.get(target.inference_id);
  if (!inference) throw new Error('推論の記録が見つからない');
  const model = await deps.repositories.models.get(inference.model_id);
  if (!model) throw new Error('推論に使ったモデルが見つからない');

  const detections = await deps.repositories.detections.listByTarget(targetId);
  const threshold = options.minConfidence ?? 0;
  const objects = detections
    .filter((detection) => detection.confidence >= threshold)
    .map((detection) => ({ label_class_id: detection.label_class_id, bbox: detection.bbox }));

  return saveRevision(deps, {
    imageId: target.image_id,
    labelSetId: model.label_set_id,
    objects,
    source: 'from_detection',
    originTargetId: targetId,
    // 人が確認していないため下書き。確定は編集画面で行う。
    status: 'draft',
  });
}
