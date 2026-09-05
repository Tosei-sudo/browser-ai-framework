/**
 * BaseModelCatalog の実装（論点22・36）。
 *
 * **同一オリジンに同梱された静的ファイルだけを読む。**
 * 絶対URLを組み立てないこと。配信物をどのパスに置いても動くよう、
 * すべて `import.meta.url` からの相対で解決する。
 */
import type { BaseModelCatalog, BaseModelEntry } from '@ports/baseModelCatalog';

const CATALOG_PATH = 'models/catalog.json';

interface CatalogFile {
  readonly catalog_version: number;
  readonly generated_at: string;
  readonly models: readonly BaseModelEntry[];
}

/**
 * 配信物の基準は HTML の位置。閉域では配信物一式が任意のパスへ置かれるため、
 * 絶対パス（`/models/...`）ではなく `document.baseURI` からの相対で解決する。
 */
function resolvePath(path: string): string {
  return new URL(path, document.baseURI).href;
}

async function fetchOrThrow(path: string): Promise<Response> {
  const response = await fetch(resolvePath(path));
  if (!response.ok) {
    throw new Error(`配信物から ${path} を読めなかった（${response.status}）`);
  }
  return response;
}

export function createStaticCatalog(): BaseModelCatalog {
  return {
    async list() {
      const file = (await (await fetchOrThrow(CATALOG_PATH)).json()) as CatalogFile;
      if (file.catalog_version !== 1) {
        throw new Error(`未知のカタログ版: ${file.catalog_version}`);
      }
      return [...file.models];
    },

    async fetchWeights(entry) {
      return (await fetchOrThrow(entry.weights_path)).arrayBuffer();
    },

    async fetchTopology(entry) {
      return (await fetchOrThrow(entry.topology_path)).json();
    },
  };
}
