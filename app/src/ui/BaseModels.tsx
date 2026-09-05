/**
 * Base Model の一覧と、重みの取り込み・破棄（方針6・18）。
 *
 * メタは起動時に全件登録されている。重みは使うときに取り込み、
 * 容量が要るときは破棄できる。**破棄してもメタと系譜は残る。**
 */
import { useCallback, useEffect, useState } from 'react';
import type { Model } from '@domain/index';
import type { ModelId } from '@domain/ids';
import { ensureWeights, evictWeights, listBaseModels } from '../application/modelManager';
import type { StoragePorts } from '@infrastructure/storage';

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** exponent).toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

interface Row {
  readonly model: Model;
  readonly byteSize: number | null;
}

export function BaseModels({
  ports,
  readOnly,
  onStorageChanged,
}: {
  ports: StoragePorts;
  readOnly: boolean;
  onStorageChanged: () => void;
}): React.ReactElement {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [busy, setBusy] = useState<ModelId | null>(null);
  const [error, setError] = useState<string | null>(null);

  const deps = {
    repositories: ports.repositories,
    unitOfWork: ports.unitOfWork,
    blobStore: ports.blobStore,
    catalog: ports.catalog,
  };

  const reload = useCallback(async () => {
    const models = await listBaseModels(deps);
    const next = await Promise.all(
      models.map(async (model) => ({
        model,
        byteSize:
          model.artifact_id === null
            ? null
            : ((await ports.repositories.modelArtifacts.get(model.artifact_id))?.byte_size ?? null),
      })),
    );
    setRows(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ports]);

  useEffect(() => {
    reload().catch((cause: unknown) => setError(String(cause)));
  }, [reload]);

  const run = (modelId: ModelId, action: 'import' | 'evict'): void => {
    setBusy(modelId);
    setError(null);
    const task =
      action === 'import' ? ensureWeights(deps, modelId) : evictWeights(deps, modelId);
    task
      .then(() => reload())
      .then(() => onStorageChanged())
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(null));
  };

  return (
    <section>
      <h2>Base Model</h2>
      <p className="lead">
        メタは起動時に全件登録済み（方針18）。重みは使うときに取り込む。
        取り込んだ重みは OPFS に置かれ、破棄してもメタと系譜は残る（方針6）。
      </p>
      {error && <p className="notice stop">失敗: {error}</p>}
      {rows === null && <p>読み込み中…</p>}
      {rows?.length === 0 && <p>カタログにモデルがない。</p>}
      {rows?.map(({ model, byteSize }) => (
        <div key={model.model_id} className="row">
          <div>
            <strong>{model.name}</strong>
            <span className="muted">
              {' '}
              / {model.task_type} / {model.artifact_status === 'present' ? '重みあり' : '重みなし'}
              {byteSize !== null && ` (${formatBytes(byteSize)})`}
            </span>
          </div>
          <div>
            {model.artifact_status === 'present' ? (
              <button
                type="button"
                onClick={() => run(model.model_id, 'evict')}
                disabled={readOnly || busy !== null}
              >
                {busy === model.model_id ? '処理中…' : '重みを破棄'}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => run(model.model_id, 'import')}
                disabled={readOnly || busy !== null}
              >
                {busy === model.model_id ? '取り込み中…' : '重みを取り込む'}
              </button>
            )}
          </div>
        </div>
      ))}
    </section>
  );
}
