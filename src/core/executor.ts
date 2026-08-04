import { GitConflictError, GitService } from '../git/gitService';
import { PlanItem, ReleasePlan } from './types';

export type ExecutorEvent =
  | { type: 'applied'; item: PlanItem; index: number; total: number }
  | { type: 'conflict'; item: PlanItem; index: number; total: number }
  | { type: 'done' };

export type ProgressCallback = (event: ExecutorEvent) => void;

function pendingItems(plan: ReleasePlan): PlanItem[] {
  return plan.items.filter((i) => i.included && !i.applied);
}

/**
 * Применяет один следующий неприменённый пункт плана. Возвращает true, если применён без конфликта.
 *
 * Если предыдущий вызов уже начал cherry-pick именно ЭТОГО пункта и остановился на конфликте (см.
 * GitConflictError ниже), а пользователь тем временем разрешил его руками в рабочем каталоге —
 * продолжаем ТУ ЖЕ, уже начатую попытку (--continue), а не начинаем новый cherry-pick с нуля. Так
 * повторный вызов "Начать сборку" после конфликта сам понимает, что делать, без отдельной кнопки
 * "Продолжить" — см. GitService.cherryPickHeadSha.
 *
 * Если незавершённый cherry-pick в рабочем каталоге относится к ДРУГОМУ коммиту (например, выбор
 * веток поменялся, пока конфликт был не разрешён — см. onToggleItem в session.ts, который разрешает
 * снимать чекбокс с ещё не применённого пункта даже во время конфликта) — не пытаемся угадать, а
 * останавливаемся с понятной ошибкой: продолжить чужую попытку --continue означало бы закоммитить
 * содержимое ДРУГОГО коммита, но молча пометить applied текущий пункт плана — несоответствие
 * реального состояния репозитория и того, что показывает хронология.
 */
export async function applyNextItem(git: GitService, plan: ReleasePlan, onProgress?: ProgressCallback): Promise<boolean> {
  const pending = pendingItems(plan);
  if (pending.length === 0) {
    onProgress?.({ type: 'done' });
    return true;
  }

  const item = pending[0];
  const index = plan.items.indexOf(item);
  const commit = { sha: item.sha, parents: item.parents, subject: item.subject, authorDate: item.authorDate, authorName: item.authorName };

  const inProgressSha = await git.cherryPickHeadSha();
  if (inProgressSha && inProgressSha !== item.sha) {
    throw new Error(
      `В рабочем каталоге уже начат cherry-pick другого коммита (${inProgressSha.slice(0, 8)}), а следующий пункт плана — ${item.sha.slice(0, 8)}. ` +
        'Похоже, выбор коммитов поменялся во время незавершённого конфликта. Нажмите "Отменить сборку", затем "Начать сборку" ещё раз.'
    );
  }

  try {
    const outcome = inProgressSha === item.sha ? await git.continueCherryPick(commit) : await git.cherryPickIntegrationCommit(commit);
    item.applied = true;
    if (outcome === 'empty') {
      // ВАЖНО: cherry-pick тут идёт на РЕЛИЗНУЮ ветку (текущий HEAD после onStartBuilding), а не на
      // main — "empty" означает "содержимое уже есть в релизной ветке" (например, более ранний
      // пункт этого же плана уже привнёс тот же диф), а НЕ "уже выпущено в main". item.alreadyInMain
      // отражает совсем другую, более раннюю проверку (см. markAlreadyInMain в planner.ts — patch-id/
      // subject+date против настоящего mainRef) — путать их сюда нельзя, иначе бейдж "уже в main"
      // показывался бы для коммитов, которые физически есть только в релизной ветке (она ещё не
      // дошла даже до qa, не то что до main). Используем тот же dryRunStatus='empty', что и dry-run
      // (см. performDryRun/renderItemRow — уже рендерится нейтральной подписью "уже применено
      // (пустой cherry-pick)", без утверждения "в main").
      item.dryRunStatus = 'empty';
    }
    onProgress?.({ type: 'applied', item, index, total: plan.items.length });
    return true;
  } catch (err) {
    if (err instanceof GitConflictError) {
      onProgress?.({ type: 'conflict', item, index, total: plan.items.length });
      return false;
    }
    throw err;
  }
}

/**
 * Применяет всё до первого конфликта либо до конца плана — единственный способ применения (см.
 * releasePanel.ts, кнопка "Начать сборку"). Повторный вызов после того, как предыдущий остановился
 * на конфликте, сам продолжает с того же места (см. applyNextItem) — конфликт нужно разрешить в
 * файлах репозитория ПЕРЕД повторным вызовом, отдельной кнопки для этого больше нет.
 */
export async function applyAll(git: GitService, plan: ReleasePlan, onProgress?: ProgressCallback): Promise<void> {
  for (;;) {
    const pending = pendingItems(plan);
    if (pending.length === 0) {
      onProgress?.({ type: 'done' });
      return;
    }
    const ok = await applyNextItem(git, plan, onProgress);
    if (!ok) {
      return; // остановились на конфликте — ждём ручного разрешения
    }
  }
}
