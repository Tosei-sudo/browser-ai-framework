/**
 * Application Layer の依存注入点（03 §4「Port を Application Layer の下に置く理由」）。
 *
 * Manager / Service はここに集めた Port だけを受け取り、
 * IndexedDB・OPFS・TensorFlow.js といった実装を直接参照しない。
 * 実装の差し替えが Application Layer に波及しないようにするため。
 *
 * Manager 群（`InferenceManager` / `ImageManager` / `StartupService` …）は
 * M1 以降で追加する。M0 では注入の形だけを固定する。
 */
import type {
  BaseModelCatalog,
  BlobStore,
  InferenceEngine,
  ModelLoader,
  Postprocessor,
  Preprocessor,
  Repositories,
  StoragePolicy,
  TrainingEngine,
  UnitOfWork,
} from '@ports/index';

export interface AppPorts {
  readonly repositories: Repositories;
  readonly unitOfWork: UnitOfWork;
  readonly blobStore: BlobStore;
  readonly storagePolicy: StoragePolicy;
  readonly baseModelCatalog: BaseModelCatalog;
  readonly modelLoader: ModelLoader;
  readonly preprocessor: Preprocessor;
  readonly postprocessor: Postprocessor;
  readonly inferenceEngine: InferenceEngine;
  /** 学習は MVP スコープ外（論点30）。M5 で実装を注入する */
  readonly trainingEngine: TrainingEngine | null;
}
