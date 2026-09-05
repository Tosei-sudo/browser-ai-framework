/**
 * `InferenceRunner` の実装。ML Worker へ依頼を出す（論点19）。
 *
 * Application Layer は Worker も TF.js も知らない。ここが唯一の接点。
 * モデル構造（`model.json`）はここで取得し、重みは Worker が OPFS から直接読む。
 */
import type { Model } from '@domain/index';
import type { ModelId } from '@domain/ids';
import type { BaseModelCatalog, BaseModelEntry } from '@ports/baseModelCatalog';
import type { DetectionParams } from '@ports/mlRuntime';
import type { InferenceRunner } from '../../application/inferenceManager';
import { findEntryFor } from '../../application/modelManager';
import type { MlWorkerClient } from '../../worker/client';
import type { TopologyFile } from './modelLoader';

export function createWorkerRunner(
  client: MlWorkerClient,
  catalog: BaseModelCatalog,
): InferenceRunner {
  // model.json は 150KB ほど。モデルごとに1度だけ読む。
  const topologies = new Map<ModelId, TopologyFile>();

  async function topologyFor(model: Model): Promise<TopologyFile> {
    const cached = topologies.get(model.model_id);
    if (cached) return cached;
    const entries = await catalog.list();
    const entry: BaseModelEntry | undefined = await findEntryFor(entries, model.model_id);
    if (!entry) throw new Error(`カタログに対応する項目がない: ${model.model_id}`);
    const topology = (await catalog.fetchTopology(entry)) as TopologyFile;
    topologies.set(model.model_id, topology);
    return topology;
  }

  return {
    async infer(model: Model, image: ImageBitmap, params: DetectionParams) {
      const artifactId = model.artifact_id;
      if (artifactId === null) {
        throw new Error('重みが取り込まれていない。Base Model の重みを先に取り込むこと');
      }
      const topology = await topologyFor(model);
      const response = await client.request(
        (jobId) => ({
          type: 'infer',
          jobId,
          model: {
            modelId: model.model_id,
            artifactId,
            topology,
            inputSpec: model.input_spec,
          },
          image,
          params,
        }),
        [image],
      );
      if (response.type !== 'inferred') {
        throw new Error('推論の応答が想定と違う');
      }
      return {
        detections: response.detections,
        elapsedMs: response.elapsedMs,
        backend: response.backend,
      };
    },
  };
}
