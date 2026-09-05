/**
 * 永続化の要求と容量の把握（論点23・26）。
 *
 * **`persist()` は拒否されうる。** PoC でも実際に拒否された（06 §3.4）。
 * 拒否は異常ではなく初期状態として起こるものとして扱い、
 * 利用者には「消えうる」ことを伝えたうえでエクスポートを促す。
 */
import type { StorageEstimate, StoragePolicy } from '@ports/blobStore';

export function createStoragePolicy(): StoragePolicy {
  return {
    async requestPersistence() {
      if (!('storage' in navigator) || !('persist' in navigator.storage)) return false;
      if (await navigator.storage.persisted()) return true;
      return navigator.storage.persist();
    },

    async estimate(): Promise<StorageEstimate> {
      const persisted =
        'storage' in navigator && 'persisted' in navigator.storage
          ? await navigator.storage.persisted()
          : false;
      if (!('storage' in navigator) || !('estimate' in navigator.storage)) {
        return { usage: 0, quota: 0, persisted };
      }
      const estimate = await navigator.storage.estimate();
      return {
        usage: estimate.usage ?? 0,
        quota: estimate.quota ?? 0,
        persisted,
      };
    },
  };
}
