/**
 * UI Layer（03 §4）。React は表示層に閉じ込め、ユースケースは
 * Application Layer に置く（論点35）。
 *
 * M3 までの範囲：起動処理の結果、Base Model の取り込み、推論、履歴。
 * MVP のスコープはここまで（論点30）。
 */
import { useCallback, useEffect, useState } from 'react';
import { runStartup, type StartupResult } from '../application/startupService';
import type { InferenceRunner } from '../application/inferenceManager';
import { createStoragePorts, type StoragePorts } from '@infrastructure/storage';
import { createWorkerRunner } from '@infrastructure/tfjs/workerRunner';
import { MlWorkerClient } from '../worker/client';
import { STORE_NAMES } from '@ports/stores';
import { PersistenceNotice, ReadOnlyNotice, StorageStatus } from './StorageNotices';
import { StorageSelfCheck } from './StorageSelfCheck';
import { BaseModels } from './BaseModels';
import { InferencePanel } from './InferencePanel';
import { HistoryPanel } from './HistoryPanel';

type BootState =
  | { readonly kind: 'booting' }
  | { readonly kind: 'ready'; readonly ports: StoragePorts; readonly startup: StartupResult }
  | { readonly kind: 'failed'; readonly message: string };

type WorkerState = { readonly backend: string } | { readonly error: string } | null;

export function App(): React.ReactElement {
  const [boot, setBoot] = useState<BootState>({ kind: 'booting' });
  const [ports, setPorts] = useState<StoragePorts | null>(null);
  const [runner, setRunner] = useState<InferenceRunner | null>(null);
  const [worker, setWorker] = useState<WorkerState>(null);
  const [requesting, setRequesting] = useState(false);
  const [historyToken, setHistoryToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    createStoragePorts()
      .then(async (created) => {
        const startup = await runStartup({
          repositories: created.repositories,
          unitOfWork: created.unitOfWork,
          blobStore: created.blobStore,
          storagePolicy: created.storagePolicy,
          catalog: created.catalog,
          readOnlyReason: created.readOnlyReason,
        });
        if (cancelled) return;
        setPorts(created);
        setBoot({ kind: 'ready', ports: created, startup });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setBoot({
            kind: 'failed',
            message: error instanceof Error ? error.message : String(error),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // ML Worker はセッション中1つだけ持つ（論点19）。
  useEffect(() => {
    if (!ports) return;
    const client = new MlWorkerClient();
    setRunner(createWorkerRunner(client, ports.catalog));
    client
      .request((jobId) => ({ type: 'init', jobId }))
      .then((response) => {
        setWorker(
          response.type === 'ready' ? { backend: response.backend } : { error: '想定しない応答' },
        );
      })
      .catch((error: unknown) => {
        setWorker({ error: error instanceof Error ? error.message : String(error) });
      });
    return () => client.terminate();
  }, [ports]);

  const refreshStorage = useCallback((): void => {
    setBoot((current) => {
      if (current.kind !== 'ready') return current;
      void current.ports.storagePolicy.estimate().then((storage) => {
        setBoot((latest) =>
          latest.kind === 'ready'
            ? { ...latest, startup: { ...latest.startup, storage } }
            : latest,
        );
      });
      return current;
    });
    setHistoryToken((token) => token + 1);
  }, []);

  const requestPersistence = (): void => {
    if (boot.kind !== 'ready') return;
    setRequesting(true);
    boot.ports.storagePolicy
      .requestPersistence()
      .then(() => refreshStorage())
      .finally(() => setRequesting(false));
  };

  return (
    <main>
      <h1>Browser AI Framework</h1>
      <p className="lead">M3（推論）。MVP のスコープはここまで（論点30）。</p>

      {boot.kind === 'booting' && <p>起動中…</p>}
      {boot.kind === 'failed' && (
        <div className="notice stop" role="alert">
          <p>
            <strong>起動に失敗しました。</strong> {boot.message}
          </p>
        </div>
      )}

      {boot.kind === 'ready' && (
        <>
          {boot.startup.readOnly && boot.startup.readOnlyReason !== null && (
            <ReadOnlyNotice reason={boot.startup.readOnlyReason} />
          )}
          <PersistenceNotice
            storage={boot.startup.storage}
            onRequest={requestPersistence}
            requesting={requesting}
          />

          <h2>起動処理</h2>
          <dl className="status">
            <dt>プロジェクト</dt>
            <dd>
              {boot.startup.project.name}（{boot.startup.project.project_id.slice(0, 8)}…）
            </dd>
            <dt>孤児ファイルの回収</dt>
            <dd>
              画像 {boot.startup.orphansCollected.images} 件 / 重み{' '}
              {boot.startup.orphansCollected.models} 件
            </dd>
            <dt>中断した学習の回収</dt>
            <dd>{boot.startup.interruptedTrainings} 件</dd>
            <dt>カタログ同期</dt>
            <dd>
              新規 {boot.startup.catalogSync.registered} 件 / 登録済み{' '}
              {boot.startup.catalogSync.alreadyKnown} 件
            </dd>
            <StorageStatus storage={boot.startup.storage} />
            <dt>ストア</dt>
            <dd>{STORE_NAMES.length} 件</dd>
            <dt>ML Worker</dt>
            <dd>
              {worker === null && '確認中'}
              {worker !== null && 'backend' in worker && `起動済み（backend: ${worker.backend}）`}
              {worker !== null && 'error' in worker && `失敗: ${worker.error}`}
            </dd>
          </dl>

          <BaseModels
            ports={boot.ports}
            readOnly={boot.startup.readOnly}
            onStorageChanged={refreshStorage}
          />

          {runner && (
            <>
              <InferencePanel
                ports={boot.ports}
                project={boot.startup.project}
                runner={runner}
                readOnly={boot.startup.readOnly}
                onChanged={refreshStorage}
                reloadToken={historyToken}
              />
              <HistoryPanel
                ports={boot.ports}
                project={boot.startup.project}
                runner={runner}
                readOnly={boot.startup.readOnly}
                reloadToken={historyToken}
              />
            </>
          )}

          <StorageSelfCheck
            ports={boot.ports}
            project={boot.startup.project}
            readOnly={boot.startup.readOnly}
          />
        </>
      )}
    </main>
  );
}
