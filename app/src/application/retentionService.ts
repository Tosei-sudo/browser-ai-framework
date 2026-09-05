/**
 * RetentionService — 推論履歴の保持ポリシー（方針14）。
 *
 * **プロジェクトごとに上限件数を超えたぶんを、古い順に削除する。**
 * `pinned` の履歴は対象外。持ち越し事項#6・#15 の上限件数はここで確定した。
 *
 * 削除するのは履歴（`Inference` / `InferenceTarget` / `Detection`）だけで、
 * 画像の実体は消さない。実体の回収は参照が無くなったときに別途行う（04 §7）。
 */
import type { InferenceId, ProjectId } from '@domain/ids';
import type { Repositories, UnitOfWork } from '@ports/repository';

/** 推論履歴の上限件数（プロジェクトごと）。 */
export const MAX_INFERENCES_PER_PROJECT = 200;

export interface RetentionDeps {
  readonly repositories: Repositories;
  readonly unitOfWork: UnitOfWork;
}

export interface RetentionResult {
  readonly deleted: number;
}

export async function enforceRetention(
  deps: RetentionDeps,
  projectId: ProjectId,
  limit: number = MAX_INFERENCES_PER_PROJECT,
): Promise<RetentionResult> {
  const total = await deps.repositories.inferences.countByProject(projectId);
  if (total <= limit) return { deleted: 0 };

  // pinned でないものを古い順に、超過ぶんだけ取り出す（方針14）。
  const excess = total - limit;
  const candidates = await deps.repositories.inferences.listUnpinnedOldestFirst(projectId, excess);
  for (const inference of candidates) {
    await deleteInference(deps, inference.inference_id);
  }
  return { deleted: candidates.length };
}

/** 1回の推論を、ぶら下がる Target と Detection ごと消す。 */
export async function deleteInference(
  deps: RetentionDeps,
  inferenceId: InferenceId,
): Promise<void> {
  const targets = await deps.repositories.inferenceTargets.listByInference(inferenceId);
  const detections = await Promise.all(
    targets.map((target) => deps.repositories.detections.listByTarget(target.target_id)),
  );

  await deps.unitOfWork.run(
    ['detections', 'inference_targets', 'inferences'],
    'readwrite',
    async (repos) => {
      for (const list of detections) {
        for (const detection of list) {
          await repos.detections.delete(detection.detection_id);
        }
      }
      for (const target of targets) {
        await repos.inferenceTargets.delete(target.target_id);
      }
      await repos.inferences.delete(inferenceId);
    },
  );
}
