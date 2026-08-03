import * as vscode from 'vscode';
import { ProjectProfile, ReleaseConfig } from './core/types';

export function readConfig(): ReleaseConfig {
  const cfg = vscode.workspace.getConfiguration('qvarhRelease');
  return {
    mainBranch: cfg.get<string>('git.mainBranch', 'main'),
    devBranch: cfg.get<string>('git.devBranch', 'dev'),
    remoteName: cfg.get<string>('git.remoteName', 'origin'),
    releaseBranchPattern: cfg.get<string>('git.releaseBranchPattern', 'release/release-{date}'),
    repositoryPath: cfg.get<string>('git.repositoryPath', ''),
    branchListLimit: cfg.get<number>('git.branchListLimit', 100),
    nonTaskBranchPrefixes: parseNonTaskBranchPrefixes(cfg.get<string>('git.nonTaskBranchPrefixes', 'qa, revert-pr-, chore/')),
    hideDuplicateRemoteBranches: cfg.get<boolean>('git.hideDuplicateRemoteBranches', true),
    staleBranchesLookbackReleases: cfg.get<number>('git.staleBranchesLookbackReleases', 4),
    taskTrackerBaseUrl: cfg.get<string>('links.taskTrackerBaseUrl', ''),
    bitbucketWorkspace: cfg.get<string>('links.bitbucketWorkspace', ''),
    bitbucketRepoSlug: cfg.get<string>('links.bitbucketRepoSlug', ''),
  };
}

/**
 * Сохранённые профили проектов (см. ProjectProfile в core/types.ts) — хранятся ОДНИМ массивом в
 * user-настройках (qvarhRelease.projects), в отличие от остальных настроек (по одному ключу на
 * поле): профиль — цельная единица (добавляется/удаляется/редактируется целиком), а не набор
 * независимо переключаемых полей, так что массив объектов здесь удобнее и естественнее, чем
 * попытка развернуть его на плоские ключи.
 */
export function readProjects(): ProjectProfile[] {
  const projects = vscode.workspace.getConfiguration('qvarhRelease').get<ProjectProfile[]>('projects', []);
  // Профили, сохранённые ДО появления hideDuplicateRemoteBranches/staleBranchesLookbackReleases,
  // физически не содержат эти поля в хранимом JSON — без явного бэкофилла они остались бы
  // undefined (не свои default-значения).
  return projects.map((p) => ({
    ...p,
    hideDuplicateRemoteBranches: p.hideDuplicateRemoteBranches ?? true,
    staleBranchesLookbackReleases: p.staleBranchesLookbackReleases ?? 4,
  }));
}

export async function saveProjects(projects: ProjectProfile[]): Promise<void> {
  await vscode.workspace.getConfiguration('qvarhRelease').update('projects', projects, vscode.ConfigurationTarget.Global);
}

/**
 * Ключ задачи вида "PROJ-123" (буквы, затем дефис, затем номер) — универсальный формат, принятый
 * не только в Jira, но и в большинстве других таск-трекеров (YouTrack, Linear, GitHub Issues с
 * префиксом и т.п.), поэтому регулярка не привязана к конкретному трекеру.
 */
const TASK_KEY_PATTERN = /\b([A-Z][A-Z0-9]+-\d+)\b/;

/** Ищет ключ задачи (напр. PROJ-123) в имени ветки или subject коммита. */
export function extractTaskKey(text: string): string | null {
  const match = TASK_KEY_PATTERN.exec(text);
  return match ? match[1] : null;
}

export function buildTaskUrl(cfg: ReleaseConfig, key: string): string {
  return `${cfg.taskTrackerBaseUrl.replace(/\/+$/, '')}/${key}`;
}

export function buildBitbucketPrUrl(cfg: ReleaseConfig, repoSlug: string, prNumber: number): string {
  return `https://bitbucket.org/${cfg.bitbucketWorkspace}/${repoSlug}/pull-requests/${prNumber}`;
}

export function buildBitbucketCommitUrl(cfg: ReleaseConfig, repoSlug: string, sha: string): string {
  return `https://bitbucket.org/${cfg.bitbucketWorkspace}/${repoSlug}/commits/${sha}`;
}

/** Если bitbucketRepoSlug не задан в конфиге — по умолчанию берём имя папки репозитория (обычно совпадает со слагом в Bitbucket). */
export function resolveBitbucketRepoSlug(cfg: ReleaseConfig, repoPath: string): string {
  if (cfg.bitbucketRepoSlug) {
    return cfg.bitbucketRepoSlug;
  }
  const parts = repoPath.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || '';
}

export function parseNonTaskBranchPrefixes(raw: string): string[] {
  return raw
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
}

export function resolveRepositoryPath(cfg: ReleaseConfig): string {
  if (cfg.repositoryPath) {
    return cfg.repositoryPath;
  }
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    throw new Error('Не открыт workspace и не задан qvarhRelease.git.repositoryPath — некуда клонировать релизную ветку.');
  }
  return folder.uri.fsPath;
}

export function formatReleaseBranch(pattern: string, date: string): string {
  return pattern.replace('{date}', date);
}

/**
 * Строит проверку "это релизная ветка?" по НЕЙМСПЕЙСУ шаблона релизной ветки — части пути до
 * первого "/" (например "release/release-{date}" → всё, что начинается с "release/"). Именно
 * неймспейс, а не точный шаблон с датой: соглашение об именовании внутри "release/" на практике
 * дрейфует за время жизни проекта (release/release-2026-06-30, release/PROJ-2669,
 * release/2025-11-19, release/release-2026-06-30-v2 — всё это встречается в одном репозитории),
 * а сам факт "лежит в неймспейсе release/" — надёжный и не меняющийся сигнал "это не задача,
 * а релизный артефакт". Используется вместо проверки через git-ancestry (уже ли в main): во
 * многих workflow релизная ветка мержится в main squash'ем или отдельным процессом, и её
 * собственные коммиты никогда не становятся предками main по факту, даже если содержимое там
 * давно есть — то есть ancestry для этой цели в принципе ненадёжна.
 */
export function releaseBranchMatcher(pattern: string): (name: string) => boolean {
  const slashIndex = pattern.indexOf('/');
  const namespace = slashIndex >= 0 ? pattern.slice(0, slashIndex + 1) : pattern.split('{')[0];
  return (name: string) => name.startsWith(namespace);
}
