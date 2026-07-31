import * as crypto from 'crypto';
import * as os from 'os';
import * as path from 'path';
import { GitConflictError, GitService } from '../git/gitService';
import { ConflictSource, DryRunResult, PlanItem } from './types';

export interface DryRunOutcome {
  results: DryRunResult[];
  /** Индекс (в переданном массиве items) коммита, на котором остановились из-за конфликта, либо null если всё применилось чисто */
  stoppedAt: number | null;
}

/**
 * Реально прогоняет cherry-pick выбранных коммитов во временном git worktree (не трогая
 * рабочий каталог пользователя), чтобы точно узнать, где будут конфликты, а не гадать по файлам.
 */
export async function performDryRun(git: GitService, mainRef: string, items: PlanItem[]): Promise<DryRunOutcome> {
  const included = items.filter((i) => i.included);
  const tmpDir = path.join(os.tmpdir(), `qvarh-release-dryrun-${crypto.randomUUID()}`);

  await git.addWorktree(tmpDir, mainRef);
  const worktreeGit = new GitService(tmpDir);

  const results: DryRunResult[] = [];
  let stoppedAt: number | null = null;

  try {
    for (let i = 0; i < included.length; i++) {
      const item = included[i];
      try {
        const outcome = await worktreeGit.cherryPickIntegrationCommit({
          sha: item.sha,
          parents: item.parents,
          subject: item.subject,
          authorDate: item.authorDate,
          authorName: item.authorName,
        });
        results.push({ sha: item.sha, status: outcome === 'empty' ? 'empty' : 'ok', conflictFiles: [], conflictSources: [] });
      } catch (err) {
        if (err instanceof GitConflictError) {
          const conflictFiles = await worktreeGit.conflictedFiles();
          // Смотрим "кто последним трогал файл" ДО abort — HEAD ещё в состоянии "main + всё, что
          // уже успешно применено в этом прогоне", т.е. ровно то состояние, с которым реально не
          // сошёлся конфликтующий коммит. Настоящая причина, а не догадка по пересечению файлов.
          const conflictSources: ConflictSource[] = await Promise.all(
            conflictFiles.map(async (file): Promise<ConflictSource> => {
              const last = await worktreeGit.lastCommitTouchingFile('HEAD', file);
              return {
                file,
                sha: last?.sha ?? null,
                subject: last?.subject ?? null,
                authorName: last?.authorName ?? null,
                authorDate: last?.authorDate ?? null,
                commitUrl: null, // проставляется в session.ts (buildLinks) — ядро не знает о конфиге ссылок
                possibleCauses: [], // заполняется в session.ts (findConflictCauses) — там же есть конфиг/список веток
              };
            })
          );
          results.push({ sha: item.sha, status: 'conflict', conflictFiles, conflictSources });
          stoppedAt = i;
          await worktreeGit.cherryPickAbort();
          break;
        }
        throw err;
      }
    }
  } finally {
    await git.removeWorktree(tmpDir);
  }

  return { results, stoppedAt };
}
