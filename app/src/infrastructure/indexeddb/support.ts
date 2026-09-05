/**
 * IndexedDB の要求を Promise で扱うための最小限の道具。
 *
 * 外部ライブラリ（idb など）を入れていないのは、閉域へ持ち込む依存を
 * 増やさないため（論点36）。必要な操作が少なく、ここで足りる。
 */
import type { StoreName } from '@ports/stores';

/** ストアを取り出す手段。トランザクションの内と外で実装が変わる。 */
export type StoreProvider = (name: StoreName, mode: IDBTransactionMode) => IDBObjectStore;

export function req<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB の要求が失敗した'));
  });
}

export function done(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('トランザクションが中断された'));
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('トランザクションが失敗した'));
  });
}

/** データベース直結の `StoreProvider`。呼び出しごとに単発のトランザクションを張る。 */
export function directProvider(db: IDBDatabase): StoreProvider {
  return (name, mode) => db.transaction([name], mode).objectStore(name);
}

/** トランザクション内の `StoreProvider`。同一トランザクションを共有する（04 §6.3）。 */
export function transactionProvider(transaction: IDBTransaction): StoreProvider {
  return (name, mode) => {
    if (mode === 'readwrite' && transaction.mode === 'readonly') {
      throw new Error(`読み取り専用トランザクションで ${name} に書き込もうとした`);
    }
    return transaction.objectStore(name);
  };
}

/** 昇順で全件。`query` を渡すと範囲で絞る。 */
export async function getAll<T>(
  source: IDBObjectStore | IDBIndex,
  query?: IDBKeyRange | IDBValidKey,
  count?: number,
): Promise<T[]> {
  return req(source.getAll(query ?? null, count) as IDBRequest<T[]>);
}

/** カーソルで N 件だけ取り出す。`direction` に 'prev' を渡すと降順。 */
export async function take<T>(
  source: IDBObjectStore | IDBIndex,
  query: IDBKeyRange | null,
  direction: IDBCursorDirection,
  limit: number,
): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const results: T[] = [];
    const request = source.openCursor(query, direction);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || results.length >= limit) {
        resolve(results);
        return;
      }
      results.push(cursor.value as T);
      cursor.continue();
    };
    request.onerror = () => reject(request.error ?? new Error('カーソルの走査に失敗した'));
  });
}
