/**
 * ストレージの状態を利用者に伝える（論点26・28）。
 *
 * どちらも「異常」ではなく**起こりうる通常の状態**として扱う。
 * とくに `persist()` の拒否は初期状態として起こる（06 §3.4）。
 */
import type { StartupResult } from '../application/startupService';

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${value.toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

export function ReadOnlyNotice({ reason }: { reason: string }): React.ReactElement {
  return (
    <div className="notice stop" role="alert">
      <p>
        <strong>読み取り専用モードで開いています。</strong>
        データベースの移行に失敗したため、旧スキーマのまま開きました。
      </p>
      <p>
        新規作成・編集・学習はできません。
        <strong>データを失わないよう、先にエクスポートしてください。</strong>
      </p>
      <p style={{ color: 'var(--muted)' }}>理由: {reason}</p>
    </div>
  );
}

export function PersistenceNotice({
  storage,
  onRequest,
  requesting,
}: {
  storage: StartupResult['storage'];
  onRequest: () => void;
  requesting: boolean;
}): React.ReactElement | null {
  if (storage.persisted) return null;
  return (
    <div className="notice warn">
      <p>
        <strong>このブラウザは保存領域を「永続」にしていません。</strong>
        端末の空き容量が減ると、ブラウザの判断でデータが削除されることがあります。
      </p>
      <p>
        許可を求めることはできますが、<strong>ブラウザが拒否する場合があります</strong>。
        重要なデータは定期的にエクスポートしてください。
      </p>
      <button type="button" onClick={onRequest} disabled={requesting}>
        {requesting ? '要求中…' : '永続化を要求する'}
      </button>
    </div>
  );
}

export function StorageStatus({ storage }: { storage: StartupResult['storage'] }): React.ReactElement {
  const ratio = storage.quota > 0 ? (storage.usage / storage.quota) * 100 : 0;
  return (
    <>
      <dt>永続化</dt>
      <dd>{storage.persisted ? '有効' : '無効（削除されうる）'}</dd>
      <dt>使用量</dt>
      <dd>
        {formatBytes(storage.usage)} / {formatBytes(storage.quota)}（{ratio.toFixed(1)}%）
      </dd>
    </>
  );
}
