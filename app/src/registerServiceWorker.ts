/**
 * Service Worker の登録（論点24）。
 *
 * 開発中は登録しない。キャッシュが効くと変更が反映されず、
 * 「直したのに直らない」を追いかけることになるため。
 *
 * 版はビルドごとに変わる `__BUILD_ID__` をクエリで渡す。
 * 版が変われば Service Worker のURLも変わり、ブラウザが更新を検知する。
 */
declare const __BUILD_ID__: string;

export function registerServiceWorker(): void {
  if (!import.meta.env.PROD) return;
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    void navigator.serviceWorker
      .register(`./sw.js?v=${__BUILD_ID__}`, { scope: './' })
      .catch(() => {
        // 登録できなくてもアプリは動く。オフライン起動ができないだけ。
      });
  });
}
