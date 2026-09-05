/**
 * ModelLoader の TF.js 実装（論点31）。
 *
 * 重みは **OPFS から読む**（M2 で取り込んだもの）。モデル構造は配信物の
 * `model.json` を読む。どちらも同一オリジンで完結する（論点36）。
 *
 * TF.js の既定のローダーは `model.json` の相対パスからシャードを取りに行くが、
 * ここでは重みを OPFS に持っているため、`IOHandler` を自前で用意して
 * ArrayBuffer をそのまま渡す。
 */
import * as tf from '@tensorflow/tfjs-core';
import { loadGraphModel } from '@tensorflow/tfjs-converter';
import type { ModelId } from '@domain/ids';

export interface LoadRequest {
  readonly modelId: ModelId;
  /** 配信物の `model.json` の中身 */
  readonly topology: TopologyFile;
  /** OPFS から読んだ重み */
  readonly weights: ArrayBuffer;
}

export interface TopologyFile {
  readonly modelTopology: NonNullable<tf.io.ModelArtifacts['modelTopology']>;
  readonly weightsManifest: readonly {
    readonly paths: readonly string[];
    readonly weights: readonly tf.io.WeightsManifestEntry[];
  }[];
  readonly format?: string;
  readonly generatedBy?: string;
  readonly convertedBy?: string;
  readonly signature?: unknown;
}

export type LoadedGraphModel = Awaited<ReturnType<typeof loadGraphModel>>;

/** `model.json` と重みから GraphModel を作る。 */
export async function loadFromArtifact(request: LoadRequest): Promise<LoadedGraphModel> {
  const weightSpecs = request.topology.weightsManifest.flatMap((group) => [...group.weights]);
  const handler: tf.io.IOHandler = {
    load: async () => ({
      modelTopology: request.topology.modelTopology,
      weightSpecs,
      weightData: request.weights,
      format: request.topology.format ?? 'graph-model',
      generatedBy: request.topology.generatedBy ?? '',
      convertedBy: request.topology.convertedBy ?? '',
    }),
  };
  return loadGraphModel(handler);
}
