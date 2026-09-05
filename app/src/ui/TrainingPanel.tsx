/**
 * 転移学習の実行（M5 / 方針3・7・13）。
 *
 * 凍結した版とバックボーンを選び、ヘッドだけを学習する。
 * 進捗はエポックごとに届き、`TrainingMetric` として残る（方針3）。
 * **失敗・中断も記録として残る**（方針13）。
 */
import { useCallback, useEffect, useState } from 'react';
import type { Dataset, DatasetVersion, Model, Project, Training } from '@domain/index';
import type { DatasetVersionId } from '@domain/ids';
import { listDatasets, listVersions, type DatasetManagerDeps } from '../application/datasetManager';
import { listBaseModels } from '../application/modelManager';
import {
  DEFAULT_HYPERPARAMETERS,
  listTrainings,
  loadLineage,
  runTraining,
  type TrainingManagerDeps,
} from '../application/trainingManager';
import type { StoragePorts } from '@infrastructure/storage';
import type { WorkerRunners } from '@infrastructure/tfjs/workerRunner';

export function TrainingPanel({
  ports,
  project,
  runners,
  readOnly,
  reloadToken,
  onChanged,
}: {
  ports: StoragePorts;
  project: Project;
  runners: WorkerRunners;
  readOnly: boolean;
  reloadToken: number;
  onChanged: () => void;
}): React.ReactElement {
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [versions, setVersions] = useState<DatasetVersion[]>([]);
  const [versionId, setVersionId] = useState<DatasetVersionId | null>(null);
  const [backbones, setBackbones] = useState<Model[]>([]);
  const [trainings, setTrainings] = useState<Training[]>([]);
  const [lineage, setLineage] = useState<string>('');
  const [epochs, setEpochs] = useState(DEFAULT_HYPERPARAMETERS.epochs);
  const [lr, setLr] = useState(DEFAULT_HYPERPARAMETERS.lr);
  const [progress, setProgress] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const datasetDeps: DatasetManagerDeps = {
    repositories: ports.repositories,
    unitOfWork: ports.unitOfWork,
  };
  const deps: TrainingManagerDeps = {
    ...datasetDeps,
    blobStore: ports.blobStore,
    runner: runners.training,
  };

  const reload = useCallback(() => {
    void (async () => {
      const [datasetList, models, trainingList] = await Promise.all([
        listDatasets(datasetDeps, project.project_id),
        listBaseModels({
          repositories: ports.repositories,
          unitOfWork: ports.unitOfWork,
          blobStore: ports.blobStore,
          catalog: ports.catalog,
        }),
        listTrainings(deps, project.project_id),
      ]);
      setDatasets(datasetList);
      setBackbones(models.filter((model) => model.task_type === 'feature_extraction'));
      setTrainings(trainingList);
      const versionLists = await Promise.all(
        datasetList.map((dataset) => listVersions(datasetDeps, dataset.dataset_id)),
      );
      const flat = versionLists.flat();
      setVersions(flat);
      setVersionId((current) => current ?? flat[0]?.dataset_version_id ?? null);
    })().catch((cause: unknown) => setMessage(String(cause)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ports, project]);

  useEffect(reload, [reload, reloadToken]);

  const backbone = backbones.find((model) => model.artifact_status === 'present');
  const version = versions.find((candidate) => candidate.dataset_version_id === versionId);
  const dataset = datasets.find((candidate) => candidate.dataset_id === version?.dataset_id);

  const start = (): void => {
    if (!backbone || !version || !dataset) return;
    setRunning(true);
    setMessage(null);
    setProgress('準備中…');
    void runTraining(deps, {
      projectId: project.project_id,
      backbone,
      datasetVersionId: version.dataset_version_id,
      labelSetId: dataset.label_set_id,
      name: `${dataset.name} v${version.version_no}`,
      hyperparameters: { epochs, lr },
      onProgress: (event) => {
        const loss = event.metrics['loss'] ?? 0;
        const box = event.metrics['box'] ?? 0;
        const cls = event.metrics['cls'] ?? 0;
        const dfl = event.metrics['dfl'] ?? 0;
        setProgress(
          `epoch ${event.epoch} / ${epochs} — loss ${loss.toFixed(4)} ` +
            `(box ${box.toFixed(3)} / cls ${cls.toFixed(3)} / dfl ${dfl.toFixed(3)})`,
        );
      },
    })
      .then(async (result) => {
        setMessage(
          result.model
            ? `学習が完了した: ${result.model.name}`
            : `学習は ${result.training.status}: ${result.training.error_message ?? ''}`,
        );
        if (result.model) {
          const chain = await loadLineage(deps, result.model.model_id);
          setLineage(
            chain
              .map((entry) => (entry.kind ? `${entry.model.name}（${entry.kind}）` : entry.model.name))
              .join(' ← '),
          );
        }
        reload();
        onChanged();
      })
      .catch((cause: unknown) => setMessage(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => {
        setRunning(false);
        setProgress(null);
      });
  };

  return (
    <section>
      <h2>転移学習</h2>
      <p className="lead">
        バックボーンは凍結し、検出ヘッドだけを学習する（方針3）。
        ヘッドは YOLOv8 と同じ構成（3スケール・DFL・タスク整合割当）。
        <strong>複数タブでの同時実行は Web Locks で止める</strong>（03 §4）。
      </p>
      {message && <p className="muted">{message}</p>}
      {!backbone && (
        <p className="notice warn">
          学習用バックボーンの重みが無い。Base Model の一覧から
          「YOLOv8n バックボーン（学習用）」を取り込むこと。
        </p>
      )}

      <div className="row">
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
                  {owner?.name ?? '?'} v{candidate.version_no}（{candidate.item_count} 件）
                </option>
              );
            })}
          </select>
        </span>
        <span className="muted">
          <label>
            epochs{' '}
            <input
              type="number"
              min="1"
              max="200"
              value={epochs}
              onChange={(event) => setEpochs(Number(event.target.value))}
              disabled={running}
              style={{ width: '4rem' }}
            />
          </label>{' '}
          <label>
            lr{' '}
            <input
              type="number"
              step="0.0001"
              min="0.0001"
              max="0.1"
              value={lr}
              onChange={(event) => setLr(Number(event.target.value))}
              disabled={running}
              style={{ width: '6rem' }}
            />
          </label>
        </span>
      </div>

      <p>
        <button
          type="button"
          onClick={start}
          disabled={readOnly || running || !backbone || !version}
        >
          学習を開始
        </button>{' '}
        <button type="button" onClick={() => runners.training.cancel()} disabled={!running}>
          中断
        </button>
      </p>
      {progress && <p className="muted">{progress}</p>}
      {lineage && <p className="muted">系譜: {lineage}</p>}

      {trainings.length > 0 && (
        <ul className="history">
          {trainings.slice(0, 8).map((training) => (
            <li key={training.training_id}>
              <span className="muted">
                {new Date(training.started_at).toLocaleString('ja-JP')} / {training.status} / epochs{' '}
                {String(training.hyperparameters.epochs)}
                {training.final_metrics
                  ? ` / loss ${(training.final_metrics['loss'] ?? 0).toFixed(4)}`
                  : ''}
                {training.error_message ? ` / ${training.error_message}` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
