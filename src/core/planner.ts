import { FirstParentCommit, GitService, mainSubjectDateKey } from '../git/gitService';
import { BranchRef, CommitInfo, ConflictCause, MainStatus, PlanItem, StaleBranchHint } from './types';

/** Сколько коммитов максимум забирать по одной ветке — защита от аномально большого диапазона (например, сильно отставшая dev-ветка). */
export const MAX_COMMITS_PER_BRANCH = 300;
/**
 * Сколько запросов гнать параллельно вместо строго последовательного перебора коммитов/веток —
 * для ИНТЕРАКТИВНЫХ операций, которые пользователь явно ждёт результата (построение хронологии
 * по уже выбранным веткам: обычно единицы веток, диффы файлов по их коммитам). Здесь важна
 * скорость отклика больше, чем экономия ресурсов.
 */
const CONCURRENCY = 12;
/**
 * То же самое, но для ФОНОВЫХ операций (уточнение статуса "в main" по всему показанному списку
 * веток) — результата этих проходов пользователь не ждёт немедленно, они могут идти минутами на
 * большом масштабе репозитория. Отдельная,
 * более скромная константа: спавн git-процесса на Windows — заметно дорогая операция (антивирус,
 * создание процесса), и 12 одновременных запусков, сустейненных на протяжении многих минут,
 * ощутимо конкурируют за ресурсы ОС с СОВСЕМ другими, казалось бы никак не связанными действиями
 * (например, открытием ссылки во внешнем браузере — тоже создание процесса) — из-за чего те
 * начинают заметно подтормаживать на фоне длинного скана. Меньшая конкурентность здесь заметно
 * снижает эту нагрузку, увеличивая время самого фонового прохода лишь незначительно.
 */
const BACKGROUND_CONCURRENCY = 6;
/** Git-константа пустого дерева — используется как база диффа для корневых коммитов (без родителя). */
const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
/**
 * Насколько глубоко (сколько first-parent коммитов самой ветки) обходим назад в поисках точки,
 * где история ветки сливается с dev — см. resolveBranchOwnCommits. Нужен запас на несколько
 * раундов реиспользования одного и того же имени ветки подряд, отсюда с большим запасом.
 */
const CHAIN_WALK_CAP = 2000;
/** Сколько "контекстных" (фоновых) коммитов dev-ветки максимум показывать в хронологии. */
export const MAX_CONTEXT_COMMITS = 200;
/** Сколько кандидатов максимум искать в findStaleUnmergedBranches (широкий скан по всему репозиторию — держим дешёвым). */
const MAX_STALE_CANDIDATES = 100;

/** Множество SHA first-parent истории dev — см. GitService.buildDevFirstParentSet. */
export type DevFirstParentShas = Set<string>;

export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i], i);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

/**
 * Собственные (уникальные относительно dev) коммиты ветки. Обычный случай — ветка ещё не влита
 * в dev целиком: тогда это просто обычная точка ветвления (`git merge-base`), дешёвый путь.
 *
 * Особый случай: ветка уже ПОЛНОСТЬЮ влита в dev (`merge-base(dev, ветка) === кончик ветки` —
 * коммитов "сверху" не остаётся, хотя ветка явно содержит свою работу). Причём так бывает не
 * только один раз: одно и то же имя ветки может заводиться от dev, дорабатываться и вливаться
 * заново НЕСКОЛЬКО раз подряд (например, задачу довыполняли уже после того, как первую часть
 * отпустили в отдельном PR) — тогда часть работы ветки лежит "внутри" dev с ОЧЕНЬ давних пор и
 * рискует быть потерянной из виду при повторном заведении той же ветки. Чтобы восстановить
 * коммиты со ВСЕХ таких раундов сразу, идём по собственной first-parent истории ветки от кончика
 * назад и останавливаемся, только дойдя до коммита, который сам уже часть first-parent истории
 * dev (devFirstParentShas — см. GitService.buildDevFirstParentSet) — то есть до настоящей самой
 * ранней точки ветвления, независимо от того, сколько раз ветку успели влить и завести заново.
 *
 * Раньше здесь был другой алгоритм: пошаговый "peel-back" через повторные `git merge-base` с
 * использованием индекса "чей коммит куда влился" (карта по НЕПОСРЕДСТВЕННЫМ родителям
 * merge-коммитов dev). Он ломался, когда между раундами реиспользования ветки в dev успевали
 * влиться ДРУГИЕ, никак не связанные задачи: `merge-base` пересчитывался и мог случайно
 * остановиться на коммите чужой задачи, оказавшемся на пути дev'а между двумя раундами нужной
 * ветки, — и терял более ранние раунды работы (подтверждено на реальном примере: ветка со
 * своей внутренней синхронизацией `git merge dev` внутри и двумя раундами вливания в dev теряла
 * коммиты первого раунда). Прямой обход собственной истории ветки с проверкой membership в
 * devFirstParentShas этой проблеме не подвержен: посторонние коммиты dev между раундами просто
 * никогда не встречаются в first-parent истории САМОЙ ветки, поэтому не могут сбить обход с пути.
 *
 * Попутно исключаются чистые merge-коммиты (2+ родителя) внутри собственной истории ветки —
 * это административные "влить dev к себе, чтобы быть в курсе изменений" синхронизации, а не
 * реальная работа: включать их в cherry-pick не нужно и часто бессмысленно (диф обычно пуст).
 */
/** Опорная ветка-кандидат для поиска точки ветвления — см. комментарий у ExtraBaseRef ниже. */
export interface ExtraBaseRef {
  /** Ref для git-команд (например, origin/qa) */
  ref: string;
  /** Короткое имя для отображения пользователю (например, qa) */
  name: string;
}

async function resolveBranchOwnCommits(
  git: GitService,
  branchRef: string,
  devRef: string,
  devFirstParentShas: DevFirstParentShas,
  chainWalkCap: number,
  displayCap: number,
  extraBaseRefs: ExtraBaseRef[] = []
): Promise<{ commits: FirstParentCommit[]; truncated: boolean; forkedFrom?: string }> {
  const branchTip = await git.resolveRef(branchRef);

  // Обычно ветка заведена от dev — но служебные ветки вроде revert-pr-* Bitbucket заводит от
  // ТЕКУЩЕЙ ветки, на которой сделали revert (например, qa), а не от dev. Если считать её "свои"
  // коммиты только относительно dev, merge-base(dev, ветка) может оказаться очень старой точкой
  // (там, где dev и qa в последний раз расходились) — и в "свои" ошибочно попадёт вся история qa
  // между этой точкой и кончиком ветки, а не единственный реальный коммит (подтверждено на
  // реальном кейсе revert-pr-1581, заведённой от qa: без этой проверки собственными считались
  // сотни чужих коммитов qa за несколько месяцев). Поэтому проверяем ВСЕ опорные ветки (dev и
  // явно настроенные "служебные" типа qa — см. resolveExtraBaseRefs в session.ts) и берём ту,
  // что даёт ближайшую (самую свежую) точку слияния.
  const baseCandidates = [{ ref: devRef, name: null as string | null }, ...extraBaseRefs.map((r) => ({ ref: r.ref, name: r.name }))];
  const mergeBaseResults = await mapWithConcurrency(baseCandidates, baseCandidates.length, async (candidate) => {
    try {
      return { ...candidate, sha: await git.mergeBase(candidate.ref, branchTip) };
    } catch {
      return null;
    }
  });
  const resolved = mergeBaseResults.filter((r): r is { ref: string; name: string | null; sha: string } => !!r);
  const forkPoints = resolved.filter((r) => r.sha !== branchTip);
  const absorbedBy = resolved.filter((r) => r.sha === branchTip);

  if (absorbedBy.length === 0) {
    // Ни одна опорная ветка не поглотила ветку целиком — обычный случай, берём САМУЮ СВЕЖУЮ
    // точку слияния (для типичной ветки от dev кандидат один — сам dev; для ветки, реально
    // заведённой от qa, но ещё не влитой никуда, qa даст более свежую точку, чем dev).
    let best = forkPoints[0];
    if (forkPoints.length > 1) {
      const dated = await mapWithConcurrency(forkPoints, forkPoints.length, async (fp) => ({
        ...fp,
        date: await git.commitAuthorDate(fp.sha),
      }));
      dated.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
      best = dated[0];
    }
    if (!best) {
      return { commits: [], truncated: false };
    }
    const result = await git.firstParentLog(best.sha, branchRef, displayCap);
    return { ...result, forkedFrom: best.name ?? undefined };
  }

  // Особый случай (см. исходный комментарий ниже) — какая-то из опорных веток уже содержит
  // ветку ЦЕЛИКОМ как предка. Идём по собственной first-parent истории ветки назад до границы с
  // ЛЮБОЙ из опорных веток (не только dev): так же корректно работает и для ветки, реально
  // заведённой не от dev (revert-pr-* от qa), и для обычной многократно переиспользованной
  // ветки от dev — раньше здесь проверялась только devFirstParentShas, из-за чего для ветки от
  // qa обход не находил границу вообще и уходил в глубь ЧУЖОЙ истории qa (см. выше).
  //
  // Раньше здесь был другой алгоритм: пошаговый "peel-back" через повторные `git merge-base` с
  // использованием индекса "чей коммит куда влился" (карта по НЕПОСРЕДСТВЕННЫМ родителям
  // merge-коммитов dev). Он ломался, когда между раундами реиспользования ветки в dev успевали
  // влиться ДРУГИЕ, никак не связанные задачи: `merge-base` пересчитывался и мог случайно
  // остановиться на коммите чужой задачи, оказавшемся на пути дev'а между двумя раундами нужной
  // ветки, — и терял более ранние раунды работы (подтверждено на реальном примере: ветка со
  // своей внутренней синхронизацией `git merge dev` внутри и двумя раундами вливания в dev теряла
  // коммиты первого раунда). Прямой обход собственной истории ветки с проверкой membership в
  // devFirstParentShas этой проблеме не подвержен: посторонние коммиты dev между раундами просто
  // никогда не встречаются в first-parent истории САМОЙ ветки, поэтому не могут сбить обход с пути.
  const extraBoundaries = await mapWithConcurrency(extraBaseRefs, extraBaseRefs.length, async (r) => ({
    name: r.name,
    shas: await git.buildDevFirstParentSet(r.ref),
  }));

  const { commits: chain, truncated: walkExhausted } = await git.firstParentChain(branchRef, chainWalkCap);
  let hitDevBoundary = false;
  let forkedFrom: string | undefined;
  const own: FirstParentCommit[] = [];
  for (let i = chain.length - 1; i >= 0; i--) {
    const commit = chain[i];
    if (devFirstParentShas.has(commit.sha)) {
      hitDevBoundary = true;
      break;
    }
    const extraHit = extraBoundaries.find((b) => b.shas.has(commit.sha));
    if (extraHit) {
      hitDevBoundary = true;
      forkedFrom = extraHit.name;
      break;
    }
    if (commit.parents.length > 1) {
      continue;
    }
    own.push(commit);
  }
  own.reverse();

  // Упёрлись в потолок обхода, так и не найдя границу с dev — часть более старых раундов могла
  // остаться неучтённой (см. предупреждение truncatedBranches в session.ts).
  const incomplete = walkExhausted && !hitDevBoundary;
  const displayTruncated = own.length > displayCap;
  const commits = displayTruncated ? own.slice(own.length - displayCap) : own;
  return { commits, truncated: displayTruncated || incomplete, forkedFrom };
}

/** Один общий индекс "с чем сравнивать main" — patch-id (точное совпадение диффа) плюс subject+authorDate (см. GitService.buildMainSubjectDateIndex, ловит cherry-pick с разъехавшимся вокруг контекстом). Строится один раз на весь батч проверяемых коммитов. */
interface MainMatchIndex {
  patchIndex: Map<string, string>;
  subjectDateIndex: Map<string, string>;
}

async function buildMainMatchIndex(git: GitService, mainRef: string, minDate: string): Promise<MainMatchIndex> {
  const [patchIndex, subjectDateIndex] = await Promise.all([
    git.computePatchIdIndex(mainRef, minDate),
    git.buildMainSubjectDateIndex(mainRef, minDate),
  ]);
  return { patchIndex, subjectDateIndex };
}

/**
 * Уже ли КОНКРЕТНЫЙ коммит в main — сперва по patch-id (точное совпадение содержимого диффа,
 * основной сигнал), а если не совпало — по subject+authorDate (см. buildMainSubjectDateIndex):
 * patch-id может не совпасть, даже если коммит объективно уже выпущен, если вокруг его правки
 * успели разъехаться СОСЕДНИЕ строки файла из-за других изменений — а дату автора cherry-pick/
 * rebase поменять не может, так что пара (subject, authorDate) остаётся надёжным отпечатком.
 */
function isAlreadyInMain(
  index: MainMatchIndex,
  commit: { sha: string; subject: string; authorDate: string },
  ownPatchIds: Map<string, string>
): boolean {
  const patchId = ownPatchIds.get(commit.sha);
  if (patchId && index.patchIndex.has(patchId)) {
    return true;
  }
  return index.subjectDateIndex.has(mainSubjectDateKey(commit.subject, commit.authorDate));
}

/**
 * Помечает коммиты, чьё СОДЕРЖИМОЕ (не SHA) уже есть в основной ветке — по patch-id/subject+date
 * (см. isAlreadyInMain), а не по git-ancestry. Задача обычно попадает в main не напрямую, а через
 * cherry-pick в релизную ветку: это создаёт НОВЫЙ коммит с другим SHA и другими родителями,
 * поэтому проверка по ancestry оригинального SHA почти всегда даёт false, даже когда содержимое
 * давно выпущено. Один общий индекс строится на всех коммитах разом.
 */
async function markAlreadyInMain(git: GitService, commits: FirstParentCommit[], mainRef: string): Promise<CommitInfo[]> {
  if (commits.length === 0) {
    return [];
  }
  const minDate = commits.reduce((min, c) => (c.authorDate < min ? c.authorDate : min), commits[0].authorDate);
  const [matchIndex, ownPatchIds] = await Promise.all([
    buildMainMatchIndex(git, mainRef, minDate),
    git.computePatchIdsForCommits(commits.map((c) => c.sha)),
  ]);
  return commits.map((c) => ({
    ...c,
    alreadyInMain: isAlreadyInMain(matchIndex, c, ownPatchIds),
    taskUrl: null, // проставляется в session.ts (buildLinks) — planner.ts не знает о конфиге ссылок
    commitUrl: null,
  }));
}

/** Коммиты ветки, уникальные относительно devRef — без диффа файлов, для лёгкого предпросмотра (expand в списке веток). */
export async function getBranchCommits(
  git: GitService,
  branch: BranchRef,
  devRef: string,
  mainRef: string,
  devFirstParentShas?: DevFirstParentShas,
  extraBaseRefs: ExtraBaseRef[] = []
): Promise<{ commits: CommitInfo[]; truncated: boolean; forkedFrom?: string }> {
  const ownShas = devFirstParentShas ?? (await git.buildDevFirstParentSet(devRef));
  const { commits, truncated, forkedFrom } = await resolveBranchOwnCommits(
    git,
    branch.ref,
    devRef,
    ownShas,
    CHAIN_WALK_CAP,
    MAX_COMMITS_PER_BRANCH,
    extraBaseRefs
  );
  return { commits: await markAlreadyInMain(git, commits, mainRef), truncated, forkedFrom };
}

async function collectBranchItems(
  git: GitService,
  branch: BranchRef,
  devRef: string,
  devFirstParentShas: DevFirstParentShas,
  extraBaseRefs: ExtraBaseRef[] = []
): Promise<{ items: PlanItem[]; truncated: boolean; base: string }> {
  const { commits, truncated } = await resolveBranchOwnCommits(
    git,
    branch.ref,
    devRef,
    devFirstParentShas,
    CHAIN_WALK_CAP,
    MAX_COMMITS_PER_BRANCH,
    extraBaseRefs
  );

  const diffStats = await mapWithConcurrency(commits, CONCURRENCY, (commit) =>
    git.diffStat(commit.sha, commit.parents[0] ?? EMPTY_TREE_SHA)
  );

  const items: PlanItem[] = commits.map((commit, i) => ({
    sha: commit.sha,
    parents: commit.parents,
    subject: commit.subject,
    authorDate: commit.authorDate,
    authorName: commit.authorName,
    alreadyInMain: false, // проставляется одним общим проходом в buildPlanItems (см. markAlreadyInMain)
    branch: branch.name,
    files: diffStats[i].files,
    insertions: diffStats[i].insertions,
    deletions: diffStats[i].deletions,
    included: true,
    applied: false,
    overlapsWith: [],
    dryRunStatus: 'untested',
    dryRunConflictFiles: [],
    dryRunConflictSources: [],
    prNumber: null, // проставляется одним общим проходом в session.ts (см. GitService.listMergeEvents)
    taskUrl: null,
    prUrl: null,
    commitUrl: null,
  }));

  // "base" здесь — сугубо для computeWholeDiffPatchId (см. buildPlanItems) — самый старый из
  // собственных коммитов ветки нужен как одна из границ диффа; если своих коммитов нет вовсе
  // (ветка целиком уже часть dev), пусть будет пустое дерево — валидная база для git diff.
  const base = commits[0]?.parents[0] ?? EMPTY_TREE_SHA;

  return { items, truncated, base };
}

/**
 * Точный статус "в main" (none/partial/full — см. MainStatus в types.ts) для СПИСКА веток —
 * фоновое уточнение того самого приближённого статуса, который session.ts проставляет сразу по
 * одному только последнему коммиту ветки (дёшево, но не отличает "не выпущено вовсе" от "выпущено
 * частично"). Здесь берётся ПОЛНЫЙ список собственных коммитов каждой ветки (resolveBranchOwnCommits
 * — тот же алгоритм, что и для хронологии), поэтому статус получается точным. Дороже: до двух
 * git-вызовов на ветку вместо одного пакетного на весь список сразу — поэтому вызывается ПОСЛЕ
 * быстрого прохода, в фоне, не блокируя первичный рендер списка веток (см. session.ts).
 */
export async function computeMainStatusForBranches(
  git: GitService,
  branches: BranchRef[],
  devRef: string,
  mainRef: string,
  devFirstParentShas: DevFirstParentShas,
  extraBaseRefs: ExtraBaseRef[] = []
): Promise<Map<string, MainStatus>> {
  const perBranch = await mapWithConcurrency(branches, BACKGROUND_CONCURRENCY, async (branch) => {
    try {
      const { commits } = await resolveBranchOwnCommits(
        git,
        branch.ref,
        devRef,
        devFirstParentShas,
        CHAIN_WALK_CAP,
        MAX_COMMITS_PER_BRANCH,
        extraBaseRefs
      );
      return { ref: branch.ref, commits };
    } catch {
      return { ref: branch.ref, commits: [] as FirstParentCommit[] };
    }
  });

  const allCommits = perBranch.flatMap((b) => b.commits);
  const result = new Map<string, MainStatus>();
  if (allCommits.length === 0) {
    return result;
  }

  const minDate = allCommits.reduce((min, c) => (c.authorDate < min ? c.authorDate : min), allCommits[0].authorDate);
  const [matchIndex, ownPatchIds] = await Promise.all([
    buildMainMatchIndex(git, mainRef, minDate),
    git.computePatchIdsForCommits(allCommits.map((c) => c.sha)),
  ]);

  for (const { ref, commits } of perBranch) {
    if (commits.length === 0) {
      // Ветка уже целиком часть dev (нет своих коммитов) — тут нечего уточнять, статус остаётся
      // тем, что уже дала быстрая проверка по последнему коммиту в session.ts.
      continue;
    }
    const matched = commits.filter((c) => isAlreadyInMain(matchIndex, c, ownPatchIds)).length;
    result.set(ref, matched === 0 ? 'none' : matched === commits.length ? 'full' : 'partial');
  }
  return result;
}

/** Помечает коммиты, которые правят те же файлы, что и коммиты с ДРУГИХ выбранных веток. */
function computeOverlaps(items: PlanItem[]): void {
  const fileOwners = new Map<string, string[]>();
  for (const item of items) {
    for (const file of item.files) {
      const owners = fileOwners.get(file) ?? [];
      owners.push(item.sha);
      fileOwners.set(file, owners);
    }
  }

  const branchBySha = new Map(items.map((i) => [i.sha, i.branch] as const));

  for (const item of items) {
    const overlap = new Set<string>();
    for (const file of item.files) {
      for (const otherSha of fileOwners.get(file) ?? []) {
        if (otherSha !== item.sha && branchBySha.get(otherSha) !== item.branch) {
          overlap.add(otherSha);
        }
      }
    }
    item.overlapsWith = [...overlap];
  }
}

export interface SkippedBranch {
  branch: string;
  reason: string;
}

/** Строит хронологический (по дате коммита) список коммитов выбранных веток относительно dev, с пометками пересечений файлов. */
export async function buildPlanItems(
  git: GitService,
  selectedBranches: BranchRef[],
  devRef: string,
  mainRef: string,
  devFirstParentShas: DevFirstParentShas,
  extraBaseRefs: ExtraBaseRef[] = []
): Promise<{ items: PlanItem[]; skipped: SkippedBranch[]; truncatedBranches: string[] }> {
  const all: PlanItem[] = [];
  const skipped: SkippedBranch[] = [];
  const truncatedBranches: string[] = [];
  const basesByBranch = new Map<string, string>();

  for (const branch of selectedBranches) {
    try {
      const { items, truncated, base } = await collectBranchItems(git, branch, devRef, devFirstParentShas, extraBaseRefs);
      all.push(...items);
      basesByBranch.set(branch.name, base);
      if (truncated) {
        truncatedBranches.push(branch.name);
      }
    } catch (err: any) {
      skipped.push({ branch: branch.name, reason: err?.message ?? String(err) });
    }
  }

  all.sort((a, b) => new Date(a.authorDate).getTime() - new Date(b.authorDate).getTime());
  computeOverlaps(all);

  // Один общий проход вместо отдельной проверки на каждую ветку — иначе на каждую пришлось бы
  // заново строить индекс patch-id основной ветки.
  if (all.length > 0) {
    const minDate = all.reduce((min, i) => (i.authorDate < min ? i.authorDate : min), all[0].authorDate);
    const [matchIndex, ownPatchIds] = await Promise.all([
      buildMainMatchIndex(git, mainRef, minDate),
      git.computePatchIdsForCommits(all.map((i) => i.sha)),
    ]);
    for (const item of all) {
      item.alreadyInMain = isAlreadyInMain(matchIndex, item, ownPatchIds);
    }

    // Дополнительно: если несколько коммитов ветки при сборке релиза склеили (squash) в один —
    // по отдельности их patch-id не совпадёт ни с чем, а вся ветка целиком как ОДИН диф — может.
    // Не отменяет ограничение: если ветка продолжила меняться уже после того, как её часть была
    // выпущена, точного совпадения может и не найтись — это предел сравнения по содержимому.
    const branchesToCheck = selectedBranches.filter((b) => !all.some((i) => i.branch === b.name && i.alreadyInMain));
    const wholeDiffPatchIds = await mapWithConcurrency(branchesToCheck, CONCURRENCY, async (branch) => {
      const base = basesByBranch.get(branch.name);
      if (!base) return null;
      return git.computeWholeDiffPatchId(base, branch.ref);
    });
    branchesToCheck.forEach((branch, i) => {
      const patchId = wholeDiffPatchIds[i];
      if (patchId && matchIndex.patchIndex.has(patchId)) {
        for (const item of all) {
          if (item.branch === branch.name) {
            item.alreadyInMain = true;
          }
        }
      }
    });
  }

  return { items: all, skipped, truncatedBranches };
}

/**
 * "Контекстные" коммиты — то, что ещё происходило в dev-ветке в промежутке между самым старым и
 * самым новым коммитом хронологии, но не относится ни к одной выбранной ветке. Чисто для общей
 * картины (кто ещё что делал в это время), не участвуют в cherry-pick.
 */
export async function findContextCommits(
  git: GitService,
  devRef: string,
  items: PlanItem[]
): Promise<{ commits: CommitInfo[]; truncated: boolean }> {
  if (items.length === 0) {
    return { commits: [], truncated: false };
  }
  const dates = items.map((i) => i.authorDate);
  const minDate = dates.reduce((a, b) => (a < b ? a : b));
  const maxDate = dates.reduce((a, b) => (a > b ? a : b));
  const knownShas = new Set(items.map((i) => i.sha));

  const { commits, truncated } = await git.firstParentLogByDateRange(devRef, minDate, maxDate, MAX_CONTEXT_COMMITS);
  const filtered = commits.filter((c) => !knownShas.has(c.sha));
  return {
    commits: filtered.map((c) => ({ ...c, alreadyInMain: false, taskUrl: null, commitUrl: null })),
    truncated,
  };
}

/**
 * Последний коммит dev-ветки СТРОГО до начала хронологии (по дате самого раннего показанного
 * коммита) — "якорь" для наглядности: что было в dev прямо перед тем, как начинается вся эта
 * последовательность. Не участвует в cherry-pick, показывается в стиле контекстных коммитов (см.
 * findContextCommits) и тем же переключателем скрывается.
 */
export async function findAnchorCommit(git: GitService, devRef: string, beforeDate: string): Promise<CommitInfo | null> {
  const { commits } = await git.firstParentLogByDateRange(devRef, '1970-01-01T00:00:00Z', beforeDate, 1);
  const commit = commits[0];
  if (!commit) {
    return null;
  }
  return { ...commit, alreadyInMain: false, taskUrl: null, commitUrl: null };
}

/**
 * Ищет вероятную РЕАЛЬНУЮ причину dry-run конфликта на конкретном файле: коммиты с других, ещё не
 * выбранных в релиз веток, которые тоже меняют этот файл и ещё не выпущены в main. Это не
 * "пересечение файлов вообще" (см. историю этого проекта — прежняя версия сканировала ВСЮ
 * хронологию на пересечение с ЛЮБЫМ файлом любой ветки и была слишком шумной: например, находила
 * ветку, менявшую тот же файл год назад по не связанной причине), а узкий, привязанный к
 * КОНКРЕТНОМУ уже случившемуся конфликту поиск — поэтому дешёвый (один `git log`, без обхода
 * сотен веток) и куда точнее: если кандидат находится, весьма вероятно, что дело не в
 * противоречащих правках, а в забытой задаче, которую нужно добавить в хронологию раньше.
 *
 * Технически: `git log --all --not <mainRef> --source -- <file>` — все коммиты по этому файлу на
 * ЛЮБОЙ ветке репозитория, которые ещё не являются предками main (объективно не выпущены), плюс
 * имя ref'а, через который git дошёл до коммита при обходе `--all` (источник кандидата в качестве
 * "чьей" это работы). Дальше отфильтровываются: сам конфликтующий коммит и уже показанные в
 * хронологии коммиты (excludeShas), main/dev/релизные/служебные ветки (isIgnorableCandidate — то же
 * самое исключение, что раньше использовалось для общего поиска зависимостей) и, наконец, кандидаты,
 * чьё содержимое, несмотря на то что формально не предок main, уже ПОЛНОСТЬЮ там присутствует (по
 * тому же patch-id/subject+date сравнению, что и остальной код) — типичный случай: старая
 * release-ветка технически "не предок main" (мержится squash'ем), но её содержимое там уже есть.
 */
function refToBranchName(ref: string, remoteName: string): string {
  const remotePrefix = `refs/remotes/${remoteName}/`;
  if (ref.startsWith('refs/heads/')) return ref.slice('refs/heads/'.length);
  if (ref.startsWith(remotePrefix)) return ref.slice(remotePrefix.length);
  if (ref.startsWith('refs/remotes/')) return ref.slice('refs/remotes/'.length);
  return ref;
}

interface RawCandidate {
  sha: string;
  subject: string;
  authorDate: string;
  authorName: string;
  sourceRef: string;
}

/**
 * Общая часть findConflictCauses и findStaleUnmergedBranches: из сырых кандидатов (см.
 * GitService.logCommitsNotInRefTouchingFile/logCommitsNotInRefBeforeDate) убирает уже известные
 * коммиты и служебные/релизные ветки, затем отсеивает те, чьё содержимое, несмотря на то что
 * формально не предок main, уже ПОЛНОСТЬЮ там присутствует (по patch-id/subject+date — типичный
 * случай: старая release-ветка технически "не предок main", но её содержимое там уже есть), и
 * оставляет один (самый свежий) коммит на ветку — не нужно показывать все её коммиты подряд.
 */
async function filterGenuineCandidates(
  git: GitService,
  mainRef: string,
  raw: RawCandidate[],
  excludeShas: Set<string>,
  isIgnorableCandidate: (name: string) => boolean,
  remoteName: string,
  limit: number
): Promise<ConflictCause[]> {
  const candidates = raw
    .filter((c) => !excludeShas.has(c.sha))
    .map((c) => ({ ...c, branch: refToBranchName(c.sourceRef, remoteName) }))
    .filter((c) => !isIgnorableCandidate(c.branch));
  if (candidates.length === 0) {
    return [];
  }

  const minDate = candidates.reduce((min, c) => (c.authorDate < min ? c.authorDate : min), candidates[0].authorDate);
  const [matchIndex, ownPatchIds] = await Promise.all([
    buildMainMatchIndex(git, mainRef, minDate),
    git.computePatchIdsForCommits(candidates.map((c) => c.sha)),
  ]);
  const genuine = candidates.filter((c) => !isAlreadyInMain(matchIndex, c, ownPatchIds));

  const byBranch = new Map<string, ConflictCause>();
  for (const c of genuine) {
    const existing = byBranch.get(c.branch);
    if (!existing || c.authorDate > existing.authorDate) {
      byBranch.set(c.branch, { sha: c.sha, subject: c.subject, authorName: c.authorName, authorDate: c.authorDate, branch: c.branch, taskUrl: null, commitUrl: null });
    }
  }
  return [...byBranch.values()].sort((a, b) => (a.authorDate < b.authorDate ? 1 : -1)).slice(0, limit);
}

export async function findConflictCauses(
  git: GitService,
  mainRef: string,
  file: string,
  excludeShas: Set<string>,
  isIgnorableCandidate: (name: string) => boolean,
  remoteName: string
): Promise<ConflictCause[]> {
  const raw = await git.logCommitsNotInRefTouchingFile(mainRef, file, 50);
  return filterGenuineCandidates(git, mainRef, raw, excludeShas, isIgnorableCandidate, remoteName, 5);
}

/**
 * Ветки, которые ещё не выпущены в main и либо (а) отделились от dev РАНЬШЕ самой ранней выбранной
 * в текущей хронологии ветки, либо (б) просто не отмечены чекбоксом сейчас и не трогались дольше
 * "окна" последних N релизных веток — в обоих случаях подсказка одна: "возможно, где-то есть
 * забытая, давно не трогаемая задача, которую вы не выбрали". beforeDateIso — уже посчитанная
 * снаружи (см. session.ts) верхняя граница поиска (--until) — самая ПОЗДНЯЯ из двух: дата earliest-
 * выбранного коммита и дата самой старой из последних N релизных веток (так сигналы (а) и (б)
 * объединяются по ИЛИ, а не по И — берём более раннюю дату, окно бы только сужалось).
 *
 * Сверяется с mainRef (а не с devRef): ветка, уже слитая в dev, но ЕЩЁ НЕ выпущенная релизом —
 * это ОБЪЕКТИВНО "не в main", и это ровно то, что должно попадать в подсказку, если её никто не
 * выбирал в релиз достаточно долго (несколько релизных циклов) — раньше сверка шла с devRef именно
 * чтобы НЕ считать "ждёт своего релиза" забытой задачей, но без разумного временного окна это было
 * слишком узко: реальный пример — ветка, влитая в dev и намеренно не выбранная в текущий релиз,
 * должна быть видна здесь, а не молчать только потому, что она технически уже в dev.
 *
 * Считается автоматически при каждом построении хронологии, но не блокирует её показ — это широкий
 * скан по ВСЕМУ репозиторию (в отличие от узкого findConflictCauses, привязанного к одному файлу),
 * поэтому запускается отдельно и результат подгружается следом, с индикатором загрузки.
 */
export async function findStaleUnmergedBranches(
  git: GitService,
  mainRef: string,
  beforeDateIso: string,
  excludeShas: Set<string>,
  isIgnorableCandidate: (name: string) => boolean,
  remoteName: string
): Promise<StaleBranchHint[]> {
  const raw = await git.logCommitsNotInRefBeforeDate(mainRef, beforeDateIso, MAX_STALE_CANDIDATES);
  const causes = await filterGenuineCandidates(git, mainRef, raw, excludeShas, isIgnorableCandidate, remoteName, 10);
  return causes.map(({ branch, sha, subject, authorName, authorDate, taskUrl, commitUrl }) => ({ branch, sha, subject, authorName, authorDate, taskUrl, commitUrl }));
}
