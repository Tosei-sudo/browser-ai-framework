/**
 * IndexedDB を開く（論点28）。
 *
 * 移行に失敗した場合は**初期化せず、旧スキーマのまま読み取り専用で開く。**
 * ローカルにしかないデータを消さないため（04 §8.3）。
 * 呼び出し側は `readonly` を受け取ったら、閲覧とエクスポート以外を禁止する。
 */
import { DB_NAME, DB_VERSION, MIGRATIONS } from './schema';

export type DatabaseState =
  | { readonly kind: 'ready'; readonly db: IDBDatabase }
  | { readonly kind: 'readonly'; readonly db: IDBDatabase; readonly reason: string };

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB の要求が失敗した'));
  });
}

/** 移行を伴わずに開く。旧スキーマのまま読み取るために使う。 */
function openExisting(): Promise<IDBDatabase> {
  return request(indexedDB.open(DB_NAME));
}

export async function openDatabase(): Promise<DatabaseState> {
  try {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (event) => {
        const transaction = req.transaction;
        if (!transaction) {
          reject(new Error('upgradeneeded にトランザクションがない'));
          return;
        }
        // 古いバージョンから順に積み上げて適用する（論点28）。
        for (const migration of MIGRATIONS) {
          if (migration.version <= event.oldVersion) continue;
          if (migration.version > DB_VERSION) continue;
          migration.apply(req.result, transaction);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('IndexedDB を開けなかった'));
      req.onblocked = () =>
        reject(new Error('他のタブが古いバージョンで開いている。すべてのタブを閉じて開き直すこと'));
    });
    return { kind: 'ready', db };
  } catch (error) {
    // 移行の失敗、または想定より新しいバージョンのデータ。
    // どちらも初期化してはいけない。読める形で開き直す。
    const reason = error instanceof Error ? error.message : String(error);
    const db = await openExisting();
    return { kind: 'readonly', db, reason };
  }
}
