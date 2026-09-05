/**
 * Service Worker（論点24 / 持ち越し事項#12）。
 *
 * **アプリ本体をキャッシュし、配信元に届かなくても起動できるようにする。**
 * 閉域では配信元が止まることもあるため、取得済みのものだけで動く状態を作る。
 *
 * 方針:
 *  - 同一オリジンの GET だけを扱う。**外部への要求は素通しもしない**（論点36）
 *  - **network-first。** 取れたらそれを返し、キャッシュを更新する。
 *    取れなければキャッシュを返す（オフライン）
 *  - `models/` はキャッシュしない。重みは OPFS に取り込む方が本筋で、
 *    キャッシュにも置くと同じ12.8MBを二重に持つ（方針6・18）
 *  - 版が変わったら古いキャッシュを捨てる。版は登録時のクエリで受け取る
 *
 * cache-first にしない理由: 新しいビルドを配ってもキャッシュ済みの
 * `index.html` が返り続け、**更新が反映されない**。実際にこの罠を踏んだ。
 * 閉域でも配信元は同一オリジンの静的ファイルで、取得は速い。
 */

const VERSION = new URL(self.location.href).searchParams.get('v') ?? 'dev';
const CACHE_NAME = `browser-ai-framework-${VERSION}`;

self.addEventListener('install', (event) => {
  // 新しい版はすぐ有効にする。閉域では利用者に「タブを閉じて開き直す」と
  // 案内する手段がないため、待たせない。
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // 外部は扱わない（論点36）
  if (url.pathname.includes('/models/')) return; // 重みは OPFS 側で持つ

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      try {
        const response = await fetch(request);
        // 成功した同一オリジンの応答でキャッシュを更新する。
        if (response.ok && response.type === 'basic') {
          cache.put(request, response.clone());
        }
        return response;
      } catch (error) {
        // 配信元に届かない。キャッシュがあればそれを返す。
        const cached = await cache.match(request);
        if (cached) return cached;
        if (request.mode === 'navigate') {
          const fallback = await cache.match('./index.html');
          if (fallback) return fallback;
        }
        throw error;
      }
    })(),
  );
});
