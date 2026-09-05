/**
 * IndexedDB のスキーマ定義（04 §4 の20ストア）。
 *
 * インデックスは「実際に必要なクエリから逆算して定義する」という 04 の方針に従い、
 * 設計ドキュメントに書かれたものだけを張る。名前も 04 の表と一致させる。
 */
import type { StoreName } from '@ports/stores';

export const DB_NAME = 'browser-ai-framework';

/**
 * スキーマのバージョン。**上げたら必ず MIGRATIONS に対応する移行関数を足す**（論点28）。
 * 属性の追加は既定値で吸収できるため、ここを上げるのはストア・インデックスの
 * 追加削除に限る。
 */
export const DB_VERSION = 2;

export interface IndexDefinition {
  readonly name: string;
  readonly keyPath: string | readonly string[];
  readonly unique?: boolean;
}

export interface StoreDefinition {
  readonly name: StoreName;
  readonly keyPath: string;
  readonly indexes: readonly IndexDefinition[];
}

export const STORE_DEFINITIONS: readonly StoreDefinition[] = [
  {
    name: 'projects',
    keyPath: 'project_id',
    indexes: [{ name: 'by_updated_at', keyPath: 'updated_at' }],
  },
  {
    name: 'images',
    keyPath: 'image_id',
    indexes: [
      { name: 'by_project', keyPath: 'project_id' },
      { name: 'by_content_hash', keyPath: 'content_hash' },
      // 削除済みを除いた一覧。`deleted_at` は null をキーにできないため
      // 永続化層で '' に変換する（mappers.ts）。
      { name: 'by_project_deleted', keyPath: ['project_id', 'deleted_at'] },
    ],
  },
  {
    name: 'image_blobs',
    keyPath: 'blob_id',
    indexes: [{ name: 'by_content_hash', keyPath: 'content_hash' }],
  },
  {
    name: 'label_sets',
    keyPath: 'label_set_id',
    indexes: [{ name: 'by_project', keyPath: 'project_id' }],
  },
  {
    name: 'label_classes',
    keyPath: 'label_class_id',
    indexes: [
      { name: 'by_label_set', keyPath: 'label_set_id' },
      { name: 'by_label_set_index', keyPath: ['label_set_id', 'index'], unique: true },
    ],
  },
  {
    name: 'annotation_sets',
    keyPath: 'annotation_set_id',
    indexes: [
      { name: 'by_image_revision', keyPath: ['image_id', 'revision_no'], unique: true },
      { name: 'by_origin_target', keyPath: 'origin_target_id' },
    ],
  },
  {
    name: 'annotation_objects',
    keyPath: 'object_id',
    indexes: [
      { name: 'by_annotation_set', keyPath: 'annotation_set_id' },
      { name: 'by_label_class', keyPath: 'label_class_id' },
    ],
  },
  {
    name: 'datasets',
    keyPath: 'dataset_id',
    indexes: [{ name: 'by_project', keyPath: 'project_id' }],
  },
  {
    name: 'dataset_versions',
    keyPath: 'dataset_version_id',
    indexes: [{ name: 'by_dataset_version_no', keyPath: ['dataset_id', 'version_no'], unique: true }],
  },
  {
    name: 'dataset_items',
    keyPath: 'item_id',
    indexes: [
      { name: 'by_version_split', keyPath: ['dataset_version_id', 'split'] },
      { name: 'by_image', keyPath: 'image_id' },
      { name: 'by_annotation_set', keyPath: 'annotation_set_id' },
    ],
  },
  {
    // 凍結前の可変メンバーシップ（2026-09-05 追加。スキーマ版2）
    name: 'dataset_members',
    keyPath: 'member_id',
    indexes: [
      { name: 'by_dataset', keyPath: 'dataset_id' },
      { name: 'by_image', keyPath: 'image_id' },
      { name: 'by_dataset_image', keyPath: ['dataset_id', 'image_id'], unique: true },
    ],
  },
  {
    name: 'models',
    keyPath: 'model_id',
    indexes: [
      // Base Model は project_id が null のため、この索引には載らない（04 §4.4）。
      // Base Model は by_origin で取り、プロジェクト内の一覧と結合する。
      { name: 'by_project', keyPath: 'project_id' },
      { name: 'by_origin', keyPath: 'origin' },
      { name: 'by_label_set', keyPath: 'label_set_id' },
      { name: 'by_artifact_status', keyPath: 'artifact_status' },
    ],
  },
  {
    name: 'model_artifacts',
    keyPath: 'artifact_id',
    indexes: [{ name: 'by_checksum', keyPath: 'checksum' }],
  },
  {
    name: 'model_derivations',
    keyPath: 'derivation_id',
    indexes: [
      { name: 'by_child_model', keyPath: 'child_model_id' },
      { name: 'by_parent_model', keyPath: 'parent_model_id' },
      { name: 'by_training', keyPath: 'training_id' },
    ],
  },
  {
    name: 'trainings',
    keyPath: 'training_id',
    indexes: [
      { name: 'by_project', keyPath: 'project_id' },
      { name: 'by_status', keyPath: 'status' },
      { name: 'by_source_model', keyPath: 'source_model_id' },
      { name: 'by_dataset_version', keyPath: 'dataset_version_id' },
    ],
  },
  {
    name: 'training_metrics',
    keyPath: 'metric_id',
    indexes: [{ name: 'by_training_epoch', keyPath: ['training_id', 'epoch'] }],
  },
  {
    name: 'evaluations',
    keyPath: 'evaluation_id',
    indexes: [
      { name: 'by_model', keyPath: 'model_id' },
      { name: 'by_dataset_version', keyPath: 'dataset_version_id' },
    ],
  },
  {
    name: 'evaluation_metrics',
    keyPath: 'metric_id',
    indexes: [{ name: 'by_evaluation', keyPath: 'evaluation_id' }],
  },
  {
    name: 'inferences',
    keyPath: 'inference_id',
    indexes: [
      { name: 'by_project_executed_at', keyPath: ['project_id', 'executed_at'] },
      // RetentionService が使う（方針14）。真偽値はキーにできないため
      // `pinned` は 0 / 1 の数値で保持する（04 §4.5）。
      { name: 'by_project_pinned_executed_at', keyPath: ['project_id', 'pinned', 'executed_at'] },
      { name: 'by_model', keyPath: 'model_id' },
    ],
  },
  {
    name: 'inference_targets',
    keyPath: 'target_id',
    indexes: [
      { name: 'by_inference', keyPath: 'inference_id' },
      { name: 'by_image', keyPath: 'image_id' },
    ],
  },
  {
    name: 'detections',
    keyPath: 'detection_id',
    indexes: [
      { name: 'by_target', keyPath: 'target_id' },
      { name: 'by_label_class', keyPath: 'label_class_id' },
    ],
  },
];

/**
 * 移行関数（論点28）。
 *
 * バージョンごとに積み上げ、任意の古いバージョンから順に適用する。
 * `version` は「この関数を適用すると到達するバージョン」。
 *
 * - 属性の追加は既定値で吸収し、ここに書かない。
 * - ストア・インデックスの追加はここに書く。**運用中に必ず発生し、
 *   後方互換では吸収できない。**
 */
export interface Migration {
  readonly version: number;
  readonly describe: string;
  apply(db: IDBDatabase, transaction: IDBTransaction): void;
}

function createStore(db: IDBDatabase, name: StoreName): void {
  const definition = STORE_DEFINITIONS.find((store) => store.name === name);
  if (!definition) throw new Error(`ストア定義がない: ${name}`);
  const objectStore = db.createObjectStore(definition.name, { keyPath: definition.keyPath });
  for (const index of definition.indexes) {
    objectStore.createIndex(index.name, index.keyPath as string | string[], {
      unique: index.unique ?? false,
    });
  }
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    describe: '初版。20ストアとインデックスを作成する',
    apply(db) {
      for (const store of STORE_DEFINITIONS) {
        if (store.name === 'dataset_members') continue; // 版2で追加する
        createStore(db, store.name);
      }
    },
  },
  {
    version: 2,
    describe: 'dataset_members を追加する（凍結前の可変メンバーシップ）',
    apply(db) {
      createStore(db, 'dataset_members');
    },
  },
];
