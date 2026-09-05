/**
 * 複数ストアをまたぐ書き込みの境界（04 §6.3）。
 *
 * 学習の完了・アノテーションの版確定・データセット版の凍結・推論の記録は、
 * それぞれ単一トランザクションでコミットする。
 *
 * **実体（OPFS）は先に書き、メタをここでコミットする**（論点27）。
 * コミットに失敗した場合は孤児ファイルが残るが、起動時のGCで回収する。
 */
import type { Repositories, UnitOfWork } from '@ports/repository';
import type { StoreName } from '@ports/stores';
import { createRepositories } from './repositories';
import { done, transactionProvider } from './support';

export function createUnitOfWork(db: IDBDatabase, readOnly: boolean): UnitOfWork {
  return {
    async run<T>(
      stores: readonly StoreName[],
      mode: 'readonly' | 'readwrite',
      fn: (repos: Repositories) => Promise<T>,
    ): Promise<T> {
      if (readOnly && mode === 'readwrite') {
        // 移行に失敗して読み取り専用で開いている（04 §8.3）。
        throw new Error('読み取り専用モードでは書き込めない。データをエクスポートすること');
      }
      const transaction = db.transaction([...stores], mode);
      const completion = done(transaction);
      let result: T;
      try {
        result = await fn(createRepositories(transactionProvider(transaction)));
      } catch (error) {
        transaction.abort();
        throw error;
      }
      await completion;
      return result;
    },
  };
}
