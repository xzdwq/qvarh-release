import * as crypto from 'crypto';
import * as os from 'os';
import * as path from 'path';
import { GitConflictError, GitService } from '../git/gitService';
import { ConflictSource, DryRunResult, PlanItem } from './types';

export interface DryRunOutcome {
  results: DryRunResult[];
}

/**
 * Реально прогоняет cherry-pick выбранных, ещё НЕ применённых коммитов во временном git worktree
 * (не трогая рабочий каталог пользователя), чтобы точно узнать, где будут конфликты, а не гадать
 * по файлам.
 *
 * Уже применённые (item.applied — реально закоммиченные в релизную ветку, см.
 * session.ts syncAppliedFromReleaseBranch) пункты сюда не попадают вовсе: они уже случились,
 * пересимулировать их незачем, а главное — baseRef может быть основной веткой, в которой этого
 * содержимого ЕЩЁ нет, и тогда попытка cherry-pick'а уже применённого коммита с нуля легко даёт
 * ЛОЖНЫЙ конфликт (например, если между ним и следующим пунктом есть смысловая зависимость,
 * которая в реальности уже удовлетворена, а в чистой симуляции от baseRef — ещё нет).
 *
 * baseRef — не обязательно основная ветка: если релизная ветка уже существует и в ней реально
 * что-то применено, вызывающий код (см. runDryRunOnCurrentPlan в session.ts) передаёт СЮДА именно
 * её — тогда симуляция оставшихся пунктов идёт от того состояния, что будет в реальности при
 * следующем "Начать сборку", а не от main, где часть контекста может отсутствовать.
 *
 * devRef нужен только для более точной диагностики самого конфликта (см.
 * GitService.analyzeConflictSource/findTaskDivergence) — на исход dry-run (ok/conflict/empty) не влияет.
 *
 * opts.skipDetailedAnalysis — пропускает GitService.analyzeConflictSource (git blame + поиск
 * задачи на dev + всё остальное, что реально небыстро, особенно когда конфликтов теперь несколько
 * за прогон, см. комментарий выше про blockedFiles) — конфликт всё равно находится ТОЧНО (реальным
 * cherry-pick, не эвристикой), просто без объяснения причины. Источник в этом случае — заглушка
 * (`analysisPending: true`, пустые hunks/sha/taskDivergence). Так вызывающий код (см.
 * runDryRunOnCurrentPlan в session.ts) может сначала быстро показать саму хронологию, а детали
 * конфликта досчитать вторым, более медленным фоновым прогоном, не задерживая первый.
 */
export async function performDryRun(
  git: GitService,
  baseRef: string,
  devRef: string,
  items: PlanItem[],
  opts?: { skipDetailedAnalysis?: boolean }
): Promise<DryRunOutcome> {
  const skipDetailedAnalysis = opts?.skipDetailedAnalysis ?? false;
  const included = items.filter((i) => i.included && !i.applied);
  const tmpDir = path.join(os.tmpdir(), `qvarh-release-dryrun-${crypto.randomUUID()}`);

  await git.addWorktree(tmpDir, baseRef);
  const worktreeGit = new GitService(tmpDir);

  const results: DryRunResult[] = [];
  // Файлы, чьё итоговое содержимое в этом прогоне НЕ определено: их правит коммит, который мы не
  // смогли применить (реальный конфликт, после которого сделан abort) или уже пропустили как
  // 'conditional'/'untested'. Ключ — файл, значение — ветки (PlanItem.branch) всех ещё не
  // разрешённых коммитов, которые его трогают.
  //
  // Ветка важна: несколько СВОИХ коммитов одной ветки — это последовательная, непрерывная история
  // (второй написан НА ОСНОВЕ первого) — как при rebase, где обычно достаточно разрешить конфликт
  // один раз, а дальнейшие коммиты той же цепочки применяются вслед за этим уже чисто. Поэтому
  // пересечение файлов только со своей же веткой — это не независимый риск, а ожидаемое продолжение
  // ("решите конфликт выше — и это применится вслед за ним"), и предупреждать здесь не о чём
  // (реального теста всё равно не будет — тестировать больше нечем, worktree после abort не содержит
  // изменений этого файла вообще). А вот пересечение файлов с ЧУЖОЙ, независимой веткой — настоящая
  // неопределённость: та ветка не связана с этой историей, и то, что получится в файле после вашего
  // разрешения, нельзя предсказать заранее — это и есть 'conditional'.
  const blockedFiles = new Map<string, Set<string>>();
  const addBlocked = (item: PlanItem) => {
    for (const f of item.files) {
      const owners = blockedFiles.get(f) ?? new Set<string>();
      owners.add(item.branch);
      blockedFiles.set(f, owners);
    }
  };

  try {
    for (const item of included) {
      const foreignBlockers = new Set<string>();
      const foreignFiles: string[] = [];
      let sameBranchOnly = false;
      for (const f of item.files) {
        const owners = blockedFiles.get(f);
        if (!owners) continue;
        const foreign = [...owners].filter((b) => b !== item.branch);
        if (foreign.length > 0) {
          foreignFiles.push(f);
          foreign.forEach((b) => foreignBlockers.add(b));
        } else {
          sameBranchOnly = true;
        }
      }
      if (foreignFiles.length > 0) {
        results.push({ sha: item.sha, status: 'conditional', conflictFiles: foreignFiles, conflictSources: [] });
        addBlocked(item);
        continue;
      }
      if (sameBranchOnly) {
        // Продолжение своей же, ещё не разрешённой цепочки — не проверяем (нечем), но и не пугаем
        // "возможным конфликтом": реального независимого риска здесь нет (см. комментарий выше).
        results.push({ sha: item.sha, status: 'untested', conflictFiles: [], conflictSources: [] });
        addBlocked(item);
        continue;
      }

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
          // Анализируем файл ДО abort — файл в worktree ещё содержит маркеры конфликта, по которым
          // GitService.analyzeConflictSource находит ТОЧНЫЕ конфликтующие строки (а не "последний
          // коммит, менявший файл вообще") и, если получится, коммит с той же задачей на dev.
          const conflictSources: ConflictSource[] = skipDetailedAnalysis
            ? conflictFiles.map((file): ConflictSource => ({
                file,
                sha: null,
                subject: null,
                authorName: null,
                authorDate: null,
                commitUrl: null,
                hunks: [],
                taskDivergence: null,
                possibleCauses: [],
                analysisPending: true,
              }))
            : await Promise.all(
                conflictFiles.map(async (file): Promise<ConflictSource> => {
                  const analysis = await worktreeGit.analyzeConflictSource(tmpDir, file, baseRef, devRef, item.sha);
                  return {
                    file,
                    sha: analysis.sha,
                    subject: analysis.subject,
                    authorName: analysis.authorName,
                    authorDate: analysis.authorDate,
                    commitUrl: null, // проставляется в session.ts (buildLinks) — ядро не знает о конфиге ссылок
                    hunks: analysis.hunks,
                    taskDivergence: analysis.taskDivergence ? { ...analysis.taskDivergence, otherCommitUrl: null } : null, // otherCommitUrl — тоже session.ts
                    possibleCauses: [], // заполняется в session.ts (findConflictCauses) — там же есть конфиг/список веток
                    analysisPending: false,
                  };
                })
              );
          results.push({ sha: item.sha, status: 'conflict', conflictFiles, conflictSources });
          await worktreeGit.cherryPickAbort();
          // Весь диф коммита (не только сами конфликтующие файлы) — после abort ни один из его
          // файлов реально не применён, а другие файлы того же коммита могли примениться БЕЗ
          // конфликта до того, как cherry-pick остановился на первом же спорном месте; после
          // настоящего разрешения (в реальности, не в этом прогоне) они всё-таки попадут в дерево.
          addBlocked(item);
          continue;
        }
        throw err;
      }
    }
  } finally {
    await git.removeWorktree(tmpDir);
  }

  return { results };
}
