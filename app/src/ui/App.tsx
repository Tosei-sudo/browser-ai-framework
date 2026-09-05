/**
 * UI Layer（03 §4）。React は表示層に閉じ込め、ユースケースは
 * Application Layer に置く（論点35）。
 *
 * M0 の時点では土台の確認だけを行う。画面は M3（推論）で作る。
 */
import { useEffect, useState } from 'react';
import { MlWorkerClient } from '../worker/client';
import { STORE_NAMES } from '@ports/stores';

type WorkerState =
  | { readonly kind: 'checking' }
  | { readonly kind: 'ready'; readonly backend: string }
  | { readonly kind: 'failed'; readonly message: string };

export function App(): React.ReactElement {
  const [worker, setWorker] = useState<WorkerState>({ kind: 'checking' });

  useEffect(() => {
    const client = new MlWorkerClient();
    client
      .request((jobId) => ({ type: 'init', jobId }))
      .then((response) => {
        setWorker(
          response.type === 'ready'
            ? { kind: 'ready', backend: response.backend }
            : { kind: 'failed', message: '想定しない応答' },
        );
      })
      .catch((error: unknown) => {
        setWorker({ kind: 'failed', message: error instanceof Error ? error.message : String(error) });
      });
    return () => client.terminate();
  }, []);

  return (
    <main>
      <h1>Browser AI Framework</h1>
      <p>
        M0（土台）。推論は M3、ストレージは M1 で実装する。
      </p>
      <dl>
        <dt>ML Worker</dt>
        <dd>
          {worker.kind === 'checking' && '確認中'}
          {worker.kind === 'ready' && `起動済み（backend: ${worker.backend}）`}
          {worker.kind === 'failed' && `失敗: ${worker.message}`}
        </dd>
        <dt>OPFS</dt>
        <dd>{'storage' in navigator && 'getDirectory' in navigator.storage ? '利用可能' : '利用不可'}</dd>
        <dt>WebGPU</dt>
        <dd>{'gpu' in navigator ? '利用可能' : '利用不可（WebGL に退避する）'}</dd>
        <dt>ストア定義</dt>
        <dd>{STORE_NAMES.length} 件</dd>
      </dl>
    </main>
  );
}
