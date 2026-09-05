/**
 * UI Layer（03 §4）。React は表示層に閉じ込め、ユースケースは
 * Application Layer に置く（論点35）。
 *
 * M1 の時点では、起動処理（StartupService）の結果とストレージの状態を出す。
 * 推論の画面は M3 で作る。
 */
import { useEffect, useState } from 'react';
import { runStartup, type StartupResult } from '../application/startupService';
import { createStoragePorts, type StoragePorts } from '@infrastructure/storage';
import { MlWorkerClient } from '../worker/client';
import { STORE_NAMES } from '@ports/stores';
import { PersistenceNotice, ReadOnlyNotice, StorageStatus } from './StorageNotices';
import { StorageSelfCheck } from './StorageSelfCheck';
import { BaseModels } from './BaseModels';

type BootState =
  | { readonly kind: 'booting' }
  | { readonly kind: 'ready'; readonly ports: StoragePorts; readonly startup: StartupResult }
  | { readonly kind: 'failed'; readonly message: string };

type WorkerState = { readonly backend: string } | { readonly error: string } | null;

export function App(): React.ReactElement {
  const [boot, setBoot] = useState<BootState>({ kind: 'booting' });
  const [worker, setWorker] = useState<WorkerState>(null);
  const [requesting, setRequesting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    createStoragePorts()
      .then(async (ports) => {
        const startup = await runStartup({
          repositories: ports.repositories,
          unitOfWork: ports.unitOfWork,
          blobStore: ports.blobStore,
          storagePolicy: ports.storagePolicy,
          catalog: ports.catalog,
          readOnlyReason: ports.readOnlyReason,
        });
        if (!cancelled) setBoot({ kind: 'ready', ports, startup });
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

  useEffect(() => {
    const client = new MlWorkerClient();
    client
      .request((jobId) => ({ type: 'init', jobId }))
      .then((response) => {
        setWorker(response.type === 'ready' ? { backend: response.backend } : { error: '想定しない応答' });
      })
      .catch((error: unknown) => {
        setWorker({ error: error instanceof Error ? error.message : String(error) });
      });
    return () => client.terminate();
  }, []);

  const refreshStorage = (): void => {
    if (boot.kind !== 'ready') return;
    boot.ports.storagePolicy
      .estimate()
      .then((storage) => setBoot({ ...boot, startup: { ...boot.startup, storage } }))
      .catch(() => undefined);
  };

  const requestPersistence = (): void => {
    if (boot.kind !== 'ready') return;
    setRequesting(true);
    boot.ports.storagePolicy
      .requestPersistence()
      .then(async () => {
        const storage = await boot.ports.storagePolicy.estimate();
        setBoot({ ...boot, startup: { ...boot.startup, storage } });
      })
      .finally(() => setRequesting(false));
  };

  return (
    <main>
      <h1>Browser AI Framework</h1>
      <p className="lead">M2（Base Model の配信と読み込み）。推論は M3 で実装する。</p>

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
            <dt>OPFS</dt>
            <dd>{'storage' in navigator && 'getDirectory' in navigator.storage ? '利用可能' : '利用不可'}</dd>
          </dl>

          <BaseModels
            ports={boot.ports}
            readOnly={boot.startup.readOnly}
            onStorageChanged={refreshStorage}
          />

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
