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

/** Применяет один следующий неприменённый пункт плана. Возвращает true, если применён без конфликта. */
export async function applyNextItem(git: GitService, plan: ReleasePlan, onProgress?: ProgressCallback): Promise<boolean> {
  const pending = pendingItems(plan);
  if (pending.length === 0) {
    onProgress?.({ type: 'done' });
    return true;
  }

  const item = pending[0];
  const index = plan.items.indexOf(item);

  try {
    const outcome = await git.cherryPickIntegrationCommit({
      sha: item.sha,
      parents: item.parents,
      subject: item.subject,
      authorDate: item.authorDate,
      authorName: item.authorName,
    });
    item.applied = true;
    if (outcome === 'empty') {
      // Содержимое уже полностью в целевой ветке (git сам определил это при попытке cherry-pick,
      // а не наша эвристика по patch-id/subject+date) — надёжнее любого предварительного анализа.
      item.alreadyInMain = true;
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

/** Автоматический режим: применяет всё до первого конфликта либо до конца плана. */
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

/** Вызывается после того, как пользователь вручную разрешил конфликт cherry-pick в рабочем каталоге. */
export async function resolveConflictAndContinue(git: GitService, plan: ReleasePlan): Promise<void> {
  const pending = pendingItems(plan);
  if (pending.length === 0) {
    return;
  }
  await git.cherryPickContinue();
  pending[0].applied = true;
}

/** Пропускает текущий конфликтующий пункт плана (например, если решили, что он не нужен). */
export async function skipConflictingItem(git: GitService, plan: ReleasePlan): Promise<void> {
  const pending = pendingItems(plan);
  if (pending.length === 0) {
    return;
  }
  await git.cherryPickSkip();
  pending[0].included = false;
}
