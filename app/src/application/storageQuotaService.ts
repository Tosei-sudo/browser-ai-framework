/**
 * StorageQuotaService — 容量の監視（論点23 / 持ち越し事項#11）。
 *
 * `QuotaExceeded` は起きてから対処すると復旧が難しい。**先回りして止める。**
 *   - 80% で警告（重みの破棄とエクスポートを促す）
 *   - 95% で新規の取り込みを止める
 *
 * 破棄できるものは方針6の重み（Base Model は配信物から取り直せる）。
 */
import type { StorageEstimate, StoragePolicy } from '@ports/blobStore';

export const WARN_RATIO = 0.8;
export const BLOCK_RATIO = 0.95;

export type QuotaLevel = 'ok' | 'warn' | 'blocked';

export interface QuotaStatus {
  readonly level: QuotaLevel;
  readonly usage: number;
  readonly quota: number;
  readonly ratio: number;
  /** これから書き込もうとしている概算バイト数を足しても収まるか */
  readonly canAccept: (bytes: number) => boolean;
}

export function evaluateQuota(estimate: StorageEstimate): QuotaStatus {
  const ratio = estimate.quota > 0 ? estimate.usage / estimate.quota : 0;
  const level: QuotaLevel = ratio >= BLOCK_RATIO ? 'blocked' : ratio >= WARN_RATIO ? 'warn' : 'ok';
  return {
    level,
    usage: estimate.usage,
    quota: estimate.quota,
    ratio,
    canAccept: (bytes) =>
      estimate.quota <= 0 || (estimate.usage + bytes) / estimate.quota < BLOCK_RATIO,
  };
}

export async function checkQuota(policy: StoragePolicy): Promise<QuotaStatus> {
  return evaluateQuota(await policy.estimate());
}

/**
 * 書き込み前の確認。**止めるのは 95% を超えるときだけ。**
 * 警告は UI が出す（操作は止めない）。
 */
export async function assertCanStore(policy: StoragePolicy, bytes: number): Promise<void> {
  const status = await checkQuota(policy);
  if (!status.canAccept(bytes)) {
    throw new Error(
      `保存領域が上限に近い（${(status.ratio * 100).toFixed(0)}%）。` +
        '不要な重みを破棄するか、エクスポートしてから削除すること',
    );
  }
}
