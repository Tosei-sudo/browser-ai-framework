/**
 * プロジェクトの作成・切替・削除と、エクスポート / インポート（M4）。
 *
 * 削除は取り消せない（持ち越し事項#8 の決定は即時削除 + 実体回収）。
 * **消す前にエクスポートを促す。** `persist()` が拒否される環境では
 * これが唯一の保険になる（06 §3.4）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Project } from '@domain/index';
import type { ProjectId } from '@domain/ids';
import {
  createProject,
  deleteProject,
  listProjects,
  type ProjectManagerDeps,
} from '../application/projectManager';
import { exportProject } from '../application/exportService';
import { importProject } from '../application/importService';
import type { StoragePorts } from '@infrastructure/storage';

export function ProjectPanel({
  ports,
  current,
  readOnly,
  onSelect,
  onChanged,
}: {
  ports: StoragePorts;
  current: Project;
  readOnly: boolean;
  onSelect: (project: Project) => void;
  onChanged: () => void;
}): React.ReactElement {
  const [projects, setProjects] = useState<Project[]>([]);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const deps: ProjectManagerDeps = {
    repositories: ports.repositories,
    unitOfWork: ports.unitOfWork,
    blobStore: ports.blobStore,
  };

  const reload = useCallback(() => {
    listProjects(deps)
      .then(setProjects)
      .catch((cause: unknown) => setError(String(cause)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ports]);

  useEffect(reload, [reload]);

  const wrap = (task: Promise<void>): void => {
    setBusy(true);
    setError(null);
    task
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => {
        setBusy(false);
        reload();
        onChanged();
      });
  };

  const onCreate = (): void => {
    wrap(
      createProject(deps, name).then((project) => {
        setName('');
        setMessage(`「${project.name}」を作成した`);
        onSelect(project);
      }),
    );
  };

  const onDelete = (project: Project): void => {
    if (projects.length <= 1) {
      setError('最後のプロジェクトは削除できない');
      return;
    }
    const ok = window.confirm(
      `「${project.name}」を削除する。画像・モデル・履歴もすべて消え、取り消せない。\n` +
        '必要ならキャンセルして先にエクスポートすること。',
    );
    if (!ok) return;
    wrap(
      deleteProject(deps, project.project_id).then((result) => {
        setMessage(
          `削除した: メタ ${result.records} 件 / 画像の実体 ${result.images} 件 / 重み ${result.artifacts} 件`,
        );
        if (project.project_id === current.project_id) {
          const next = projects.find((candidate) => candidate.project_id !== project.project_id);
          if (next) onSelect(next);
        }
      }),
    );
  };

  const onExport = (project: Project): void => {
    wrap(
      exportProject(deps, project.project_id).then((result) => {
        const url = URL.createObjectURL(result.blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = result.fileName;
        anchor.click();
        URL.revokeObjectURL(url);
        setMessage(
          `エクスポートした: ${result.fileName}（メタ ${result.records} 件 / 実体 ${result.blobs} 件）`,
        );
      }),
    );
  };

  const onImport = (event: React.ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    if (!file) return;
    wrap(
      importProject(deps, file).then((result) => {
        setMessage(
          `取り込んだ: ${result.projectName}（メタ ${result.records} 件 / 実体 ${result.blobs} 件）`,
        );
        if (fileRef.current) fileRef.current.value = '';
        return listProjects(deps).then((all) => {
          const imported = all.find(
            (project) => project.project_id === (result.projectId as ProjectId),
          );
          if (imported) onSelect(imported);
        });
      }),
    );
  };

  return (
    <section>
      <h2>プロジェクト</h2>
      <p className="lead">
        プロジェクトは完全分離で、資産をまたいで参照しない（方針11）。
        Base Model とそのクラス体系だけが全プロジェクトで共通。
      </p>

      {error && <p className="notice stop">失敗: {error}</p>}
      {message && <p className="muted">{message}</p>}

      <ul className="history">
        {projects.map((project) => (
          <li key={project.project_id}>
            <label>
              <input
                type="radio"
                name="project"
                checked={project.project_id === current.project_id}
                onChange={() => onSelect(project)}
              />{' '}
              {project.name}
              <span className="muted"> / {new Date(project.created_at).toLocaleDateString('ja-JP')}</span>
            </label>
            <span>
              <button type="button" onClick={() => onExport(project)} disabled={busy}>
                エクスポート
              </button>{' '}
              <button
                type="button"
                onClick={() => onDelete(project)}
                disabled={busy || readOnly || projects.length <= 1}
              >
                削除
              </button>
            </span>
          </li>
        ))}
      </ul>

      <div className="row">
        <span>
          <input
            type="text"
            value={name}
            placeholder="新しいプロジェクト名"
            onChange={(event) => setName(event.target.value)}
            disabled={busy || readOnly}
          />{' '}
          <button type="button" onClick={onCreate} disabled={busy || readOnly}>
            作成
          </button>
        </span>
        <span>
          <label className="muted">
            インポート:{' '}
            <input
              ref={fileRef}
              type="file"
              accept=".baif"
              onChange={onImport}
              disabled={busy || readOnly}
            />
          </label>
        </span>
      </div>
    </section>
  );
}
