/**
 * 評価（M5 / 方針4）。
 *
 * 凍結した版の test split でモデルを走らせ、mAP@0.5 とクラス別 AP を出す。
 * **同じ版で測れば別のモデルと比べられる。** それが版を凍結する理由（方針2）。
 */
import { useCallback, useEffect, useState } from 'react';
import type { Dataset, DatasetSplit, DatasetVersion, Evaluation, Model, Project } from '@domain/index';
import type { DatasetVersionId, ModelId } from '@domain/ids';
import { listDatasets, listVersions, type DatasetManagerDeps } from '../application/datasetManager';
import { listEvaluations, runEvaluation, type EvaluationManagerDeps } from '../application/evaluationManager';
import type { StoragePorts } from '@infrastructure/storage';
import type { WorkerRunners } from '@infrastructure/tfjs/workerRunner';

export function EvaluationPanel({
  ports,
  project,
  runners,
  readOnly,
  reloadToken,
}: {
  ports: StoragePorts;
  project: Project;
  runners: WorkerRunners;
  readOnly: boolean;
  reloadToken: number;
}): React.ReactElement {
  const [models, setModels] = useState<Model[]>([]);
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [versions, setVersions] = useState<DatasetVersion[]>([]);
  const [modelId, setModelId] = useState<ModelId | null>(null);
  const [versionId, setVersionId] = useState<DatasetVersionId | null>(null);
  const [history, setHistory] = useState<{ evaluation: Evaluation; text: string }[]>([]);
  const [split, setSplit] = useState<DatasetSplit>('test');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const datasetDeps: DatasetManagerDeps = {
    repositories: ports.repositories,
    unitOfWork: ports.unitOfWork,
  };
  const deps: EvaluationManagerDeps = {
    ...datasetDeps,
    blobStore: ports.blobStore,
    runner: runners.inference,
  };

  const reload = useCallback(() => {
    void (async () => {
      // 評価できるのは検出モデル。学習したモデルとカタログの完成モデルの両方。
      const [projectModels, builtin, datasetList] = await Promise.all([
        ports.repositories.models.listByProject(project.project_id),
        ports.repositories.models.listBuiltin(),
        listDatasets(datasetDeps, project.project_id),
      ]);
      const usable = [...projectModels, ...builtin].filter(
        (model) => model.task_type === 'object_detection' && model.artifact_status === 'present',
      );
      setModels(usable);
      setModelId((current) => current ?? usable[0]?.model_id ?? null);
      setDatasets(datasetList);
      const versionLists = await Promise.all(
        datasetList.map((dataset) => listVersions(datasetDeps, dataset.dataset_id)),
      );
      const flat = versionLists.flat();
      setVersions(flat);
      setVersionId((current) => current ?? flat[0]?.dataset_version_id ?? null);

      const target = modelId ?? usable[0]?.model_id;
      if (target) {
        const list = await listEvaluations(deps, target);
        const texts = await Promise.all(
          list.slice(0, 5).map(async (evaluation) => {
            const metrics = await ports.repositories.evaluationMetrics.listByEvaluation(
              evaluation.evaluation_id,
            );
            const overall = metrics.filter((metric) => metric.label_class_id === null);
            const text = overall
              .map((metric) => `${metric.metric_name} ${metric.value.toFixed(3)}`)
              .join(' / ');
            return { evaluation, text };
          }),
        );
        setHistory(texts);
      }
    })().catch((cause: unknown) => setMessage(String(cause)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ports, project, modelId]);

  useEffect(reload, [reload, reloadToken]);

  const model = models.find((candidate) => candidate.model_id === modelId);
  const version = versions.find((candidate) => candidate.dataset_version_id === versionId);

  const start = (): void => {
    if (!model || !version) return;
    setBusy(true);
    setMessage(null);
    void runEvaluation(deps, {
      projectId: project.project_id,
      model,
      datasetVersionId: version.dataset_version_id,
      split,
    })
      .then((result) => {
        setMessage(
          `mAP@0.5 ${result.summary.mAP50.toFixed(3)} / precision ${result.summary.precision.toFixed(3)}` +
            ` / recall ${result.summary.recall.toFixed(3)}（画像 ${result.summary.images} 枚 / 正解 ${result.summary.groundTruths} 件）`,
        );
        reload();
      })
      .catch((cause: unknown) => setMessage(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false));
  };

  return (
    <section>
      <h2>評価</h2>
      <p className="lead">
        凍結した版の test split で測る。突き合わせは IoU 0.5 以上を正解とし、
        クラス別 AP と全体の mAP@0.5 / precision / recall を記録する（方針4）。
      </p>
      {message && <p className="muted">{message}</p>}

      <div className="row">
        <span>
          モデル{' '}
          <select value={modelId ?? ''} onChange={(event) => setModelId(event.target.value as ModelId)}>
            {models.map((candidate) => (
              <option key={candidate.model_id} value={candidate.model_id}>
                {candidate.name}（{candidate.origin}）
              </option>
            ))}
          </select>
        </span>
        <span>
          split{' '}
          <select value={split} onChange={(event) => setSplit(event.target.value as DatasetSplit)}>
            <option value="test">test</option>
            <option value="val">val</option>
            <option value="train">train（過学習の確認用）</option>
          </select>
        </span>
        <span>
          版{' '}
          <select
            value={versionId ?? ''}
            onChange={(event) => setVersionId(event.target.value as DatasetVersionId)}
          >
            {versions.map((candidate) => {
              const owner = datasets.find((item) => item.dataset_id === candidate.dataset_id);
              return (
                <option key={candidate.dataset_version_id} value={candidate.dataset_version_id}>
                  {owner?.name ?? '?'} v{candidate.version_no}
                </option>
              );
            })}
          </select>
        </span>
      </div>

      <p>
        <button type="button" onClick={start} disabled={readOnly || busy || !model || !version}>
          {busy ? '評価中…' : '評価する'}
        </button>
      </p>

      {history.length > 0 && (
        <ul className="history">
          {history.map(({ evaluation, text }) => (
            <li key={evaluation.evaluation_id}>
              <span className="muted">
                {new Date(evaluation.executed_at).toLocaleString('ja-JP')} / {evaluation.split_used} /{' '}
                {text}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
