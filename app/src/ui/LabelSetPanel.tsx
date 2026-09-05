/**
 * クラス体系の管理（M4 / 持ち越し事項#1）。
 *
 * Base Model の体系を複製して編集するか、空から作る。
 * **index は詰め直さない**（方針1）。削除は末尾かつ未参照のときだけ許す。
 */
import { useCallback, useEffect, useState } from 'react';
import type { LabelClass, LabelSet, Model, Project } from '@domain/index';
import type { LabelSetId } from '@domain/ids';
import {
  addClass,
  canDeleteClass,
  createEmptyLabelSet,
  deleteClass,
  deriveLabelSet,
  listLabelSets,
  type LabelSetManagerDeps,
} from '../application/labelSetManager';
import { listBaseModels } from '../application/modelManager';
import type { StoragePorts } from '@infrastructure/storage';

export function LabelSetPanel({
  ports,
  project,
  readOnly,
}: {
  ports: StoragePorts;
  project: Project;
  readOnly: boolean;
}): React.ReactElement {
  const [sets, setSets] = useState<LabelSet[]>([]);
  const [classes, setClasses] = useState<Record<string, LabelClass[]>>({});
  const [baseModels, setBaseModels] = useState<Model[]>([]);
  const [name, setName] = useState('');
  const [className, setClassName] = useState('');
  const [selected, setSelected] = useState<LabelSetId | null>(null);
  const [error, setError] = useState<string | null>(null);

  const deps: LabelSetManagerDeps = {
    repositories: ports.repositories,
    unitOfWork: ports.unitOfWork,
  };

  const reload = useCallback(() => {
    void (async () => {
      const list = await listLabelSets(deps, project.project_id);
      setSets(list);
      const entries = await Promise.all(
        list.map(
          async (set) =>
            [set.label_set_id, await ports.repositories.labelClasses.listByLabelSet(set.label_set_id)] as const,
        ),
      );
      setClasses(Object.fromEntries(entries));
      setBaseModels(
        await listBaseModels({
          repositories: ports.repositories,
          unitOfWork: ports.unitOfWork,
          blobStore: ports.blobStore,
          catalog: ports.catalog,
        }),
      );
      if (!selected && list[0]) setSelected(list[0].label_set_id);
    })().catch((cause: unknown) => setError(String(cause)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ports, project]);

  useEffect(reload, [reload]);

  const run = (task: Promise<unknown>): void => {
    setError(null);
    task
      .then(() => reload())
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  };

  return (
    <section>
      <h2>クラス体系</h2>
      <p className="lead">
        Base Model の体系を複製するか、空から作る。
        <strong>index は固定</strong>で、詰め直さない（方針1）。
      </p>
      {error && <p className="notice stop">失敗: {error}</p>}

      <div className="row">
        <span>
          <input
            type="text"
            value={name}
            placeholder="クラス体系の名前"
            onChange={(event) => setName(event.target.value)}
            disabled={readOnly}
          />{' '}
          <button
            type="button"
            disabled={readOnly}
            onClick={() => run(createEmptyLabelSet(deps, project.project_id, name).then(() => setName('')))}
          >
            空から作成
          </button>{' '}
          {baseModels.map((model) => (
            <button
              key={model.model_id}
              type="button"
              disabled={readOnly}
              onClick={() =>
                run(
                  deriveLabelSet(
                    deps,
                    project.project_id,
                    model.label_set_id,
                    name || `${model.name} から複製`,
                  ).then(() => setName('')),
                )
              }
            >
              {model.name} から複製
            </button>
          ))}
        </span>
      </div>

      {sets.length === 0 && <p className="muted">まだクラス体系がない。</p>}
      {sets.map((set) => {
        const list = classes[set.label_set_id] ?? [];
        const isOpen = selected === set.label_set_id;
        return (
          <div key={set.label_set_id} className="row">
            <div>
              <button type="button" onClick={() => setSelected(isOpen ? null : set.label_set_id)}>
                {isOpen ? '−' : '+'}
              </button>{' '}
              <strong>{set.name}</strong>
              <span className="muted">
                {' '}
                / {set.class_count} クラス
                {set.derived_from_label_set_id !== null && ' / 複製'}
              </span>
              {isOpen && (
                <ul className="detection-list">
                  {list.map((klass) => (
                    <li key={klass.label_class_id}>
                      <span className="swatch" style={{ background: klass.color }} />
                      <span className="muted">#{klass.index}</span> {klass.name}
                      {klass.index === list.length - 1 && (
                        <button
                          type="button"
                          disabled={readOnly}
                          onClick={() =>
                            run(
                              canDeleteClass(deps, klass.label_class_id).then((check) =>
                                check.ok
                                  ? deleteClass(deps, klass.label_class_id)
                                  : Promise.reject(new Error(check.reason)),
                              ),
                            )
                          }
                        >
                          削除
                        </button>
                      )}
                    </li>
                  ))}
                  <li>
                    <input
                      type="text"
                      value={className}
                      placeholder="クラス名"
                      onChange={(event) => setClassName(event.target.value)}
                      disabled={readOnly}
                    />{' '}
                    <button
                      type="button"
                      disabled={readOnly}
                      onClick={() =>
                        run(addClass(deps, set.label_set_id, className).then(() => setClassName('')))
                      }
                    >
                      クラスを追加
                    </button>
                  </li>
                </ul>
              )}
            </div>
          </div>
        );
      })}
    </section>
  );
}
