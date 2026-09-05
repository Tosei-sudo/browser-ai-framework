/**
 * 変換済みモデルを配信物へ取り込む（論点22・36）。
 *
 * tools/model-conversion（Docker）の出力を app/public/models/ へ置き、
 * カタログJSON を作る。**重みは git 管理外**なので、この工程で持ち込む。
 *
 *   node scripts/import-models.mjs [変換出力のディレクトリ]
 *
 * TF.js の重みは既定で 4MB ごとのシャードに分かれるが、ここで**1本の
 * weights.bin にまとめ直す**。理由は 04 の設計で実体を `BlobStore` の1件
 * （= OPFS の1ファイル）として扱うと決めているため（方針6・16）。
 * `model.json` の weightsManifest も1グループへ書き換える。
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = fileURLToPath(new URL('..', import.meta.url));
const sourceDir = resolve(process.argv[2] ?? join(appDir, '..', 'tools', 'model-conversion', 'out'));
const targetRoot = join(appDir, 'public', 'models');

/**
 * カタログに載せるモデル。**MVP は推論だけなので完成モデル1件**（論点30）。
 * 学習の土台になるバックボーンは M5 で足す。
 */
const INCLUDE = [{ dir: 'yolov8n_tfjs', key: 'yolov8n', name: 'YOLOv8n (COCO)' }];

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/** シャードを1本にまとめ、weightsManifest を書き換える。 */
function bundleWeights(modelDir, topology) {
  const specs = [];
  const chunks = [];
  for (const group of topology.weightsManifest) {
    specs.push(...group.weights);
    for (const path of group.paths) {
      chunks.push(readFileSync(join(modelDir, path)));
    }
  }
  return {
    weights: Buffer.concat(chunks),
    topology: { ...topology, weightsManifest: [{ paths: ['weights.bin'], weights: specs }] },
  };
}

function importModel({ dir, key, name }) {
  const modelDir = join(sourceDir, dir);
  if (!existsSync(modelDir)) {
    throw new Error(
      `${modelDir} がない。tools/model-conversion/README.md の手順で変換してから実行すること。`,
    );
  }
  const topology = JSON.parse(readFileSync(join(modelDir, 'model.json'), 'utf8'));
  const metadata = JSON.parse(readFileSync(join(modelDir, 'metadata.json'), 'utf8'));
  const { weights, topology: rewritten } = bundleWeights(modelDir, topology);

  const targetDir = join(targetRoot, key);
  rmSync(targetDir, { recursive: true, force: true });
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(join(targetDir, 'model.json'), JSON.stringify(rewritten));
  writeFileSync(join(targetDir, 'weights.bin'), weights);

  const shards = readdirSync(modelDir).filter((f) => f.endsWith('.bin')).length;
  console.log(`${key}: ${shards} シャード → weights.bin（${(weights.length / 1e6).toFixed(1)} MB）`);

  return {
    key,
    name,
    task_type: metadata.task_type,
    format: metadata.format,
    input_spec: metadata.input_spec,
    classes: metadata.classes,
    topology_path: `models/${key}/model.json`,
    weights_path: `models/${key}/weights.bin`,
    byte_size: weights.length,
    checksum: sha256(weights),
  };
}

mkdirSync(targetRoot, { recursive: true });
const models = INCLUDE.map(importModel);
const catalog = { catalog_version: 1, generated_at: new Date().toISOString(), models };
writeFileSync(join(targetRoot, 'catalog.json'), `${JSON.stringify(catalog, null, 2)}\n`);
console.log(`catalog.json: ${models.length} 件`);
