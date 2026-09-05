/**
 * ML Worker への依頼をまとめる層（論点19）。
 *
 * Application Layer は Worker も TF.js も知らない。ここが唯一の接点。
 * モデル構造（`model.json`）はここで取得し、重みは Worker が OPFS から直接読む。
 *
 * 学習したモデル（`baif_yolo_head_v1`）は**系譜の親からバックボーンを辿る**（方針7）。
 * ヘッド単体では推論できないため、この解決をここで行う。
 */
import type { Model } from '@domain/index';
import type { ModelId } from '@domain/ids';
import type { BaseModelCatalog, BaseModelEntry } from '@ports/baseModelCatalog';
import type { DetectionParams } from '@ports/mlRuntime';
import type { Repositories } from '@ports/repository';
import type { InferenceRunner } from '../../application/inferenceManager';
import type { TrainingRunner } from '../../application/trainingManager';
import { findEntryFor } from '../../application/modelManager';
import type { MlWorkerClient } from '../../worker/client';
import type { GraphModelRef, ModelRef } from '../../worker/protocol';
import type { TopologyFile } from './modelLoader';

export interface WorkerRunners {
  readonly inference: InferenceRunner;
  readonly training: TrainingRunner;
}

export function createWorkerRunner(
  client: MlWorkerClient,
  catalog: BaseModelCatalog,
  repositories: Repositories,
): WorkerRunners {
  // model.json は 150KB ほど。モデルごとに1度だけ読む。
  const topologies = new Map<ModelId, TopologyFile>();

  async function entryFor(model: Model): Promise<BaseModelEntry> {
    const entries = await catalog.list();
    const entry = await findEntryFor(entries, model.model_id);
    if (!entry) throw new Error(`カタログに対応する項目がない: ${model.name}`);
    return entry;
  }

  async function graphRef(model: Model): Promise<GraphModelRef> {
    const artifactId = model.artifact_id;
    if (artifactId === null) {
      throw new Error(`「${model.name}」の重みが取り込まれていない`);
    }
    let topology = topologies.get(model.model_id);
    if (!topology) {
      topology = (await catalog.fetchTopology(await entryFor(model))) as TopologyFile;
      topologies.set(model.model_id, topology);
    }
    return {
      modelId: model.model_id,
      artifactId,
      topology,
      inputSpec: model.input_spec,
    };
  }

  /** 学習したモデルの親（バックボーン）を系譜から辿る。 */
  async function backboneOf(model: Model): Promise<Model> {
    const derivations = await repositories.modelDerivations.listByChild(model.model_id);
    const parentId = derivations[0]?.parent_model_id;
    if (!parentId) throw new Error(`「${model.name}」の系譜に親がない`);
    const parent = await repositories.models.get(parentId);
    if (!parent) throw new Error('系譜の親モデルが見つからない');
    return parent;
  }

  async function modelRef(model: Model): Promise<ModelRef> {
    if (model.origin === 'builtin') {
      return { kind: 'graph', ...(await graphRef(model)) };
    }
    const artifactId = model.artifact_id;
    if (artifactId === null) throw new Error(`「${model.name}」の重みが破棄されている`);
    const backbone = await backboneOf(model);
    return {
      kind: 'head',
      modelId: model.model_id,
      artifactId,
      backbone: await graphRef(backbone),
      inputSpec: model.input_spec,
    };
  }

  const inference: InferenceRunner = {
    async infer(model: Model, image: ImageBitmap, params: DetectionParams) {
      const ref = await modelRef(model);
      const response = await client.request(
        (jobId) => ({ type: 'infer', jobId, model: ref, image, params }),
        [image],
      );
      if (response.type !== 'inferred') throw new Error('推論の応答が想定と違う');
      return {
        detections: response.detections,
        elapsedMs: response.elapsedMs,
        backend: response.backend,
      };
    },
  };

  const training: TrainingRunner = {
    async train(params) {
      const backbone = await graphRef(params.backbone);
      const response = await client.request(
        (jobId) => ({
          type: 'train',
          jobId,
          backbone,
          samples: params.samples,
          config: params.config,
        }),
        [],
        (progress) => {
          if (progress.type === 'progress') {
            params.onProgress(progress.epoch, progress.metrics);
          }
        },
      );
      if (response.type !== 'trained') throw new Error('学習の応答が想定と違う');
      return {
        weights: response.weights,
        finalMetrics: response.finalMetrics,
        backend: response.backend,
        elapsedMs: response.elapsedMs,
      };
    },
    cancel() {
      client.cancel();
    },
  };

  return { inference, training };
}
