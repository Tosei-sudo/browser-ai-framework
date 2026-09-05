/**
 * ドメインの不変条件が破れたことを表す例外。
 *
 * ERモデルで決めた不変条件は Manager や UI に散らさず、この層で守る（03 §4）。
 * 破れた場合はバグであり、利用者への案内ではなく開発時に落とすためのもの。
 */
export class DomainError extends Error {
  constructor(
    /** 破れた不変条件の識別子（例: `model.immutable`） */
    readonly rule: string,
    message: string,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export function invariant(condition: unknown, rule: string, message: string): asserts condition {
  if (!condition) {
    throw new DomainError(rule, message);
  }
}
