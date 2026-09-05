/**
 * Port（抽象インターフェース） — 03 §5。
 *
 * Application Layer はこの層のインターフェースにのみ依存する。
 * 実装（IndexedDB / OPFS / TensorFlow.js / fetch）は起動時に注入する。
 */
export * from './stores';
export type * from './repository';
export type * from './blobStore';
export type * from './mlRuntime';
export type * from './baseModelCatalog';
