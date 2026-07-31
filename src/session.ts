import * as vscode from 'vscode';
import {
  buildBitbucketCommitUrl,
  buildBitbucketPrUrl,
  buildTaskUrl,
  extractTaskKey,
  formatReleaseBranch,
  readConfig,
  releaseBranchMatcher,
  resolveBitbucketRepoSlug,
  resolveRepositoryPath,
} from './config';
import { performDryRun } from './core/dryRun';
import { applyAll, applyNextItem, resolveConflictAndContinue, skipConflictingItem } from './core/executor';
import {
  DevFirstParentShas,
  ExtraBaseRef,
  MAX_COMMITS_PER_BRANCH,
  buildPlanItems,
  computeMainStatusForBranches,
  findAnchorCommit,
  findConflictCauses,
  findContextCommits,
  findStaleUnmergedBranches,
  getBranchCommits,
} from './core/planner';
import { BranchRef, MergeEventInfo, PlanItem, ReleaseConfig, ReleasePlan } from './core/types';
import { GitService, MergeEventDetails, mainSubjectDateKey } from './git/gitService';
import { ReleasePanel, ReleasePanelHost } from './ui/releasePanel';

const STATE_KEY = 'qvarhRelease.session.v3';

interface PersistedState {
  releaseBranch: string;
  selectedRefs: string[];
  plan: ReleasePlan | null;
}

export class ReleaseSession implements ReleasePanelHost {
  private config!: ReleaseConfig;
  private git!: GitService;
  private panel!: ReleasePanel;
  /** true после успешного ensureClients() в start()/resume() — см. onRefreshBranches. */
  private ready = false;

  /** Полный список веток репозитория (без ограничения) — источник истины для выбора/поиска. */
  private fullBranches: BranchRef[] = [];
  private selectedRefs = new Set<string>();
  private plan: ReleasePlan | null = null;
  private releaseBranch = '';
  /** Растёт при каждой новой сборке плана — защищает от того, что устаревший (медленный) результат построения перезапишет уже новый план. */
  private planGeneration = 0;
  private repoPath = '';
  /** Текст последнего фильтра списка веток — чтобы пересчитать срез с тем же фильтром после смены лимита показа. */
  private lastFilterQuery = '';
  /**
   * "Скрыть ветки, уже полностью в main" — применяется ТОЛЬКО кнопкой "Применить" (вместе с
   * лимитом показа), а не мгновенно при клике на чекбокс: фильтрация происходит на сервере ДО
   * среза по лимиту (см. sendBranchSlice), иначе "показывать 2000" при включённом скрытии
   * показывало бы МЕНЬШЕ 2000 строк — часть уже отобранных по лимиту веток вырезалась бы этим
   * фильтром постфактум на клиенте. Раз фильтрация теперь серверная и небесплатная (нужен
   * дополнительный проход patch-id по большему числу кандидатов), моментального переключения по
   * одному чекбоксу больше нет — обе настройки применяются одним действием.
   */
  private hideAlreadyInMain = false;
  /**
   * "Скрыть служебные ветки" (qa, revert-pr-, chore/ и т.п. — см. nonTaskBranchPrefixes) —
   * в отличие от hideAlreadyInMain, это просто проверка префикса имени, без единого git-вызова,
   * поэтому применяется СРАЗУ при переключении чекбокса, а не по кнопке "Применить".
   */
  private hideServiceBranches = false;
  /** Растёт при каждом новом срезе списка веток — защищает от того, что устаревшее (фоновое) уточнение статуса "в main" перезапишет уже новый список. */
  private branchSliceGeneration = 0;
  /**
   * Не даёт фоновым проходам refineBranchMainStatus накапливаться параллельно: каждое нажатие
   * клавиши в фильтре и любой refresh списка веток запускает новый такой проход (см.
   * sendBranchSlice), а на масштабе в сотни-тысячи веток один проход может идти минутами —
   * без ограничения десятки таких проходов могли бы работать ОДНОВРЕМЕННО, забивая пул
   * git-процессов и делая даже лёгкие операции (например, "показать коммиты" одной ветки)
   * аномально медленными на фоне этой нагрузки. Вместо очереди всех запросов держим только
   * САМЫЙ СВЕЖИЙ отложенный — предыдущие всё равно устарели бы по branchSliceGeneration.
   */
  private refineInFlight = false;
  private refinePending: {
    slice: BranchRef[];
    devRef: string;
    mainRef: string;
    devFirstParentShas: DevFirstParentShas;
    generation: number;
  } | null = null;

  constructor(private readonly context: vscode.ExtensionContext) {}

  /**
   * overrideConfig — запуск для КОНКРЕТНОГО сохранённого профиля проекта (см. ProjectProfile,
   * "Проекты" в боковой панели), а не для единственного текущего конфига по умолчанию. Профиль —
   * надмножество ReleaseConfig (структурно совместим), поэтому подходит сюда напрямую.
   */
  private async ensureClients(overrideConfig?: ReleaseConfig): Promise<void> {
    this.config = overrideConfig ?? readConfig();
    this.repoPath = resolveRepositoryPath(this.config);
    this.git = new GitService(this.repoPath);
    await this.git.assertRepo();
  }

  /** Ссылки на таск-трекер/Bitbucket для ветки/коммита — по конфигу, без обращения к внешним API (см. src/config.ts). */
  private buildLinks(
    branchName: string,
    subject: string,
    sha: string,
    prNumber: number | null
  ): { taskUrl: string | null; prUrl: string | null; commitUrl: string | null } {
    const taskKey = extractTaskKey(branchName) ?? extractTaskKey(subject);
    const repoSlug = resolveBitbucketRepoSlug(this.config, this.repoPath);
    return {
      taskUrl: taskKey && this.config.taskTrackerBaseUrl ? buildTaskUrl(this.config, taskKey) : null,
      prUrl: prNumber && repoSlug ? buildBitbucketPrUrl(this.config, repoSlug, prNumber) : null,
      commitUrl: sha && repoSlug ? buildBitbucketCommitUrl(this.config, repoSlug, sha) : null,
    };
  }

  /** Ссылка на основную ветку: origin/main, если есть, иначе локальная main — без checkout. Используется для создания релизной ветки и как база dry-run. */
  private async resolveMainRef(): Promise<string> {
    return this.resolveBranchRef(this.config.mainBranch);
  }

  /**
   * Ссылка на dev-ветку — используется как база для вычисления "своих" коммитов feature/fix-веток.
   * Если считать от основной ветки, а main сильно отстаёт от dev, в список попадает вся история dev.
   * Если dev-ветки нет (или веток от неё не создают), откатываемся на основную ветку.
   */
  private async resolveDevRef(): Promise<string> {
    const devRef = `${this.config.remoteName}/${this.config.devBranch}`;
    if (await this.git.refExists(devRef)) {
      return devRef;
    }
    if (await this.git.refExists(this.config.devBranch)) {
      return this.config.devBranch;
    }
    return this.resolveMainRef();
  }

  private async resolveBranchRef(branchName: string): Promise<string> {
    const remoteRef = `${this.config.remoteName}/${branchName}`;
    if (await this.git.refExists(remoteRef)) {
      return remoteRef;
    }
    return branchName;
  }

  /**
   * Кэширует ссылки main/dev, индекс "ветка → номер PR" и множество first-parent SHA dev-ветки —
   * реально они меняются только вместе с состоянием репозитория (Pull/явный Refresh), а не
   * при каждом нажатии клавиши в фильтре или смене лимита показа. Раньше все три пересчитывались
   * заново на КАЖДЫЙ такой вызов — в т.ч. внутри фонового уточнения статуса "в main"
   * (runBranchMainStatusRefinePass), которое само перезапускается на каждое изменение фильтра —
   * на репозитории с активной dev-веткой это ощутимо замедляло и фильтрацию списка, и построение
   * хронологии. Сбрасывается в начале refreshBranches() — единственного места, где состояние
   * репозитория действительно могло измениться.
   */
  private refsCache: {
    mainRef: string;
    devRef: string;
    mergeEvents: Map<string, MergeEventDetails[]>;
    devFirstParentShas: DevFirstParentShas;
  } | null = null;

  private async getRefsCache(): Promise<{
    mainRef: string;
    devRef: string;
    mergeEvents: Map<string, MergeEventDetails[]>;
    devFirstParentShas: DevFirstParentShas;
  }> {
    if (this.refsCache) {
      return this.refsCache;
    }
    const [mainRef, devRef] = await Promise.all([this.resolveMainRef(), this.resolveDevRef()]);
    const [mergeEvents, devFirstParentShas] = await Promise.all([
      this.git.listMergeEvents(devRef),
      this.git.buildDevFirstParentSet(devRef),
    ]);
    this.refsCache = { mainRef, devRef, mergeEvents, devFirstParentShas };
    return this.refsCache;
  }

  /**
   * Опорные ветки-кандидаты помимо dev для поиска "своих" коммитов ветки (см. resolveBranchOwnCommits
   * в planner.ts) — точное (не префиксное) совпадение имени с одной из nonTaskBranchPrefixes,
   * реально существующее в репозитории (обычно это "qa" — типичный пример из nonTaskBranchPrefixes,
   * в отличие от "revert-pr-"/"chore/", которые ПРЕФИКСЫ множества разных веток, а не имя одной
   * конкретной). Нужно, потому что служебные ветки вроде revert-pr-* Bitbucket заводит не от dev,
   * а от текущей ветки, на которой сделали revert (обычно qa) — без этого их "свои" коммиты
   * считались бы неверно (см. комментарий в planner.ts у resolveBranchOwnCommits).
   */
  private resolveExtraBaseRefs(): ExtraBaseRef[] {
    const exactNames = this.config.nonTaskBranchPrefixes.filter((p) => !p.endsWith('/') && !p.endsWith('-'));
    const refs: ExtraBaseRef[] = [];
    for (const name of exactNames) {
      const remoteRef = `${this.config.remoteName}/${name}`;
      if (this.fullBranches.some((b) => b.ref === remoteRef)) {
        refs.push({ ref: remoteRef, name });
      } else if (this.fullBranches.some((b) => b.ref === name)) {
        refs.push({ ref: name, name });
      }
    }
    return refs;
  }

  private persist(): void {
    const state: PersistedState = {
      releaseBranch: this.releaseBranch,
      selectedRefs: [...this.selectedRefs],
      plan: this.plan,
    };
    void this.context.workspaceState.update(STATE_KEY, state);
  }

  static hasPersistedState(context: vscode.ExtensionContext): boolean {
    return !!context.workspaceState.get<PersistedState>(STATE_KEY);
  }

  /** Заново читает список веток из git (дорого только сам git-вызов; отправка в панель — через sendBranchSlice). */
  private async refreshBranches(): Promise<void> {
    this.refsCache = null; // состояние репозитория могло поменяться (Pull/явный Refresh) — см. getRefsCache
    this.fullBranches = this.applyDuplicateBranchFilter(await this.git.listBranches());
    await this.sendBranchSlice('');
  }

  /**
   * Если включено (по умолчанию — см. hideDuplicateRemoteBranches в config.ts), скрывает
   * REMOTE-TRACKING ветку из списка, если для неё существует ЛОКАЛЬНАЯ пара с тем же именем —
   * иначе большинство веток репозитория показывались бы дважды подряд (feature/PROJ-123 и
   * origin/feature/PROJ-123), почти всегда указывая на один и тот же коммит. Локальная версия
   * оставляется как основная: типичный сценарий работы с расширением — сначала Pull (checkout +
   * pull) нужной ветки, дальше работа идёт именно с локальной веткой, а не с remote-tracking.
   */
  private applyDuplicateBranchFilter(branches: BranchRef[]): BranchRef[] {
    if (!this.config.hideDuplicateRemoteBranches) {
      return branches;
    }
    const localNames = new Set(branches.filter((b) => !b.isRemote).map((b) => b.name));
    return branches.filter((b) => !b.isRemote || !localNames.has(b.name));
  }

  /**
   * Быстрый (не эвристикой, но дешёвый) статус "полностью в main" по ПОСЛЕДНЕМУ коммиту каждой
   * ветки — patch-id, а не isAncestor (задача обычно попадает в main не напрямую, а через
   * cherry-pick в релизную ветку — тот же диф, другой SHA, git-ancestry по исходному коммиту это
   * не увидит), плюс subject+authorDate как fallback (см. mainSubjectDateKey) — ловит случаи,
   * когда patch-id не совпал из-за разъехавшегося вокруг правки контекста, хотя коммит объективно
   * уже выпущен. Не путать с computeMainStatusForBranches (planner.ts) — тот считает ТОЧНЫЙ статус
   * по ВСЕМ собственным коммитам каждой ветки и всегда работает только над уже показанным срезом
   * в фоне; этот же метод дешёвый настолько, что его можно позволить себе над ЛЮБЫМ набором
   * веток-кандидатов, в т.ч. до среза по лимиту (см. sendBranchSlice).
   */
  private async computeFastMainStatus(branches: BranchRef[], mainRef: string): Promise<Map<string, boolean>> {
    const withSha = branches.filter((b) => b.lastCommitSha);
    if (withSha.length === 0) {
      return new Map();
    }
    const minDate = withSha.reduce((min, b) => (b.lastCommitDate < min ? b.lastCommitDate : min), withSha[0].lastCommitDate);
    const [mainIndex, subjectDateIndex, ownPatchIds] = await Promise.all([
      this.git.computePatchIdIndex(mainRef, minDate),
      this.git.buildMainSubjectDateIndex(mainRef, minDate),
      this.git.computePatchIdsForCommits(withSha.map((b) => b.lastCommitSha)),
    ]);
    return new Map(
      withSha.map((b) => {
        const patchId = ownPatchIds.get(b.lastCommitSha);
        const matched =
          (!!patchId && mainIndex.has(patchId)) || subjectDateIndex.has(mainSubjectDateKey(b.lastCommitSubject, b.lastCommitDate));
        return [b.ref, matched] as const;
      })
    );
  }

  /**
   * Отправляет в панель ограниченный (по фильтру + лимиту) срез веток — чтобы не рендерить
   * тысячи строк разом. Дополнительно помечает, какие из показанных веток уже полностью
   * выпущены в основную ветку (например, старые release-ветки).
   *
   * Если включено "скрыть уже в main" (this.hideAlreadyInMain, см. onSetBranchListLimit) —
   * статус нужно знать ДО среза по лимиту, а не после: иначе "показывать 2000" при включённом
   * скрытии показало бы МЕНЬШЕ 2000 строк, потому что часть уже отобранных по лимиту веток
   * вырезалась бы фильтром постфактум. Поэтому в этом режиме считаем быстрый статус для ВСЕХ
   * подходящих по тексту фильтра веток (может быть дороже, чем обычно, но всё ещё один-два
   * пакетных git-вызова, а не по вызову на ветку), фильтруем, и только потом режем по лимиту.
   * Без "скрыть" — как раньше, статус считается уже после среза, только для показанных строк.
   */
  private async sendBranchSlice(filterText: string): Promise<void> {
    this.lastFilterQuery = filterText;
    this.branchSliceGeneration += 1;
    const generation = this.branchSliceGeneration;
    // Через пробел — несколько независимых терминов (ИЛИ): "2279 2322" находит ветки обеих задач разом.
    const needles = filterText.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const byFilter = needles.length
      ? this.fullBranches.filter((b) => {
          const haystack = `${b.name} ${b.ref}`.toLowerCase();
          return needles.some((needle) => haystack.includes(needle));
        })
      : this.fullBranches;
    const matches = this.hideServiceBranches
      ? byFilter.filter((b) => !this.config.nonTaskBranchPrefixes.some((p) => b.name.startsWith(p)))
      : byFilter;

    const { mainRef, devRef, mergeEvents, devFirstParentShas } = await this.getRefsCache();
    if (generation !== this.branchSliceGeneration) return; // устарел, пока ждали кэш ссылок — новее уже в пути

    let candidates = matches;
    let fastStatusByRef = new Map<string, boolean>();
    if (this.hideAlreadyInMain) {
      fastStatusByRef = await this.computeFastMainStatus(matches, mainRef);
      candidates = matches.filter((b) => !fastStatusByRef.get(b.ref));
    }

    const limit = Math.max(1, this.config.branchListLimit);
    const slice = candidates.slice(0, limit);

    if (!this.hideAlreadyInMain) {
      // Статус ещё не считался (выше это делается только когда скрытие включено) — считаем
      // теперь, но уже только для показанного среза, как и раньше.
      fastStatusByRef = await this.computeFastMainStatus(slice, mainRef);
    }

    // Устарел, пока считался быстрый статус "в main" — новее уже в пути, отправлять этот незачем
    // (и, что важнее, НЕЛЬЗЯ: без этой проверки более старый, но случайно завершившийся ПОЗЖЕ запрос
    // мог бы перезаписать в панели уже показанный новый/правильный результат — именно так выглядел
    // баг "поиск находит нужное, а потом добавляет ещё лишнее").
    if (generation !== this.branchSliceGeneration) return;

    const sliceWithFlags = slice.map((b) => {
      const prNumber = mergeEvents.get(b.name)?.[0]?.prNumber ?? null;
      // Только 'none'/'full' — по последнему коммиту ветки, дёшево (см. MainStatus в types.ts).
      // 'partial' панель уточняет сама на клиенте после разворачивания коммитов конкретной ветки.
      const mainStatus: 'none' | 'full' = fastStatusByRef.get(b.ref) ? 'full' : 'none';
      return {
        ...b,
        mainStatus,
        prNumber,
        ...this.buildLinks(b.name, b.lastCommitSubject, b.lastCommitSha, prNumber),
      };
    });

    this.panel.postBranches(sliceWithFlags, [...this.selectedRefs], {
      totalMatches: candidates.length,
      totalBranches: this.fullBranches.length,
      truncated: candidates.length > slice.length,
      limit,
    });

    void this.refineBranchMainStatus(slice, devRef, mainRef, devFirstParentShas, generation);
  }

  /**
   * Уточняет статус "в main" для показанного среза веток В ФОНЕ, не блокируя первичный рендер
   * списка (см. sendBranchSlice — там уже отправлен быстрый приближённый статус по последнему
   * коммиту). Здесь считается ТОЧНЫЙ статус по ВСЕМ собственным коммитам каждой ветки — это и
   * позволяет отличить "частично в main" от "не в main вовсе" сразу, без разворачивания коммитов
   * вручную. Дороже быстрого прохода (до двух git-вызовов на ветку), поэтому выполняется отдельным
   * проходом.
   *
   * Single-flight: если проход уже идёт, новый не запускается параллельно — запоминается только
   * САМЫЙ СВЕЖИЙ запрос (refinePending), и он подхватывается сразу после завершения текущего.
   * Без этого частый ввод в фильтре или повторные refresh на репозитории с сотнями-тысячами
   * веток породили бы десятки одновременных многоминутных сканов, забивающих пул git-процессов —
   * из-за чего даже лёгкие операции (например, "показать коммиты" одной ветки) могли зависать
   * на аномально долгое время в ожидании ресурсов.
   */
  private async refineBranchMainStatus(
    slice: BranchRef[],
    devRef: string,
    mainRef: string,
    devFirstParentShas: DevFirstParentShas,
    generation: number
  ): Promise<void> {
    if (this.refineInFlight) {
      this.refinePending = { slice, devRef, mainRef, devFirstParentShas, generation };
      return;
    }
    this.refineInFlight = true;
    try {
      await this.runBranchMainStatusRefinePass(slice, devRef, mainRef, devFirstParentShas, generation);
      while (this.refinePending) {
        const next = this.refinePending;
        this.refinePending = null;
        await this.runBranchMainStatusRefinePass(next.slice, next.devRef, next.mainRef, next.devFirstParentShas, next.generation);
      }
    } finally {
      this.refineInFlight = false;
    }
  }

  private async runBranchMainStatusRefinePass(
    slice: BranchRef[],
    devRef: string,
    mainRef: string,
    devFirstParentShas: DevFirstParentShas,
    generation: number
  ): Promise<void> {
    // Фоновый, необязательный проход — при ошибке просто остаёмся с уже отправленным быстрым
    // приближённым статусом, не показывая пользователю отдельную ошибку ради второстепенного уточнения.
    try {
      if (generation !== this.branchSliceGeneration) return; // устарел ещё до старта (например, пока ждал своей очереди в single-flight)

      // Опорные ветки помимо dev (resolveExtraBaseRefs) НАМЕРЕННО не передаются здесь: это добавило
      // бы ещё один git-вызов НА КАЖДУЮ ветку показанного среза (сотни штук на масштабе), заметно
      // замедлив именно этот фоновый проход, который и так гоняется на каждое изменение фильтра —
      // подтверждено на реальном использовании (заметно "потяжелевшие" фильтры после первой версии
      // этого исправления). Точность бейджа "в main" для единичных служебных веток вроде revert-pr-*
      // здесь не критична — она и так уточняется точно при явном разворачивании (см. getBranchCommits),
      // где эта же проверка стоит одного лишнего вызова, а не сотен.
      const statusByRef = await computeMainStatusForBranches(this.git, slice, devRef, mainRef, devFirstParentShas);
      if (generation !== this.branchSliceGeneration || statusByRef.size === 0) return;

      this.panel.postBranchMainStatus(Object.fromEntries(statusByRef));
    } catch {
      // см. комментарий выше — намеренно молча игнорируем
    }
  }

  /**
   * Применяет лимит показа веток И флажок "скрыть уже в main" ОДНИМ действием (кнопка
   * "Применить" в панели) — оба должны примениться вместе, поскольку хвост скрытия влияет на то,
   * сколько веток нужно ПОДНЯТЬ, чтобы получить ровно `limit` показанных (см. sendBranchSlice).
   */
  async onSetBranchListLimit(limit: number, hideAlreadyInMain: boolean): Promise<void> {
    const normalized = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : this.config.branchListLimit;
    this.config.branchListLimit = normalized;
    this.hideAlreadyInMain = hideAlreadyInMain;
    await vscode.workspace.getConfiguration('qvarhRelease').update('git.branchListLimit', normalized, vscode.ConfigurationTarget.Global);
    await this.sendBranchSlice(this.lastFilterQuery);
  }

  /** Просто проверка префикса имени (см. hideServiceBranches) — дёшево, применяется сразу, без кнопки "Применить". */
  async onSetHideServiceBranches(hide: boolean): Promise<void> {
    this.hideServiceBranches = hide;
    await this.sendBranchSlice(this.lastFilterQuery);
  }

  private async warnIfCherryPickInProgress(): Promise<void> {
    if (await this.git.isCherryPickInProgress()) {
      this.panel.postError(
        'В репозитории обнаружен незавершённый cherry-pick (вероятно, от прошлой сессии). ' +
          'Это может мешать переключению веток через интерфейс VS Code. ' +
          'Разрешите конфликт и нажмите "Продолжить после конфликта", либо нажмите "Отменить сборку (cherry-pick --abort)" ниже.'
      );
    }
  }

  private async postCurrentBranch(): Promise<void> {
    const current = await this.git.currentBranch();
    this.panel.postCurrentBranch(current, this.config.mainBranch);
  }

  private selectedBranchRefs(): BranchRef[] {
    return this.fullBranches.filter((b) => this.selectedRefs.has(b.ref));
  }

  /**
   * Проставляет item.prNumber (и ссылки на PR/задачу/коммит) и строит mergeEventsByBranch — оба по
   * ОДНОМУ И ТОМУ ЖЕ авторитетному источнику (GitService.listMergeEvents), а не догадкам по subject'ам
   * уже загруженных контекстных коммитов. Вынесено отдельным методом, чтобы resume() мог пересчитать
   * это ЗАНОВО для персистентного плана: план, сохранённый в workspaceState, — это застывший снимок
   * (mergeEventsByBranch в нём мог не существовать вовсе, если план сохранён более старой версией
   * расширения, ДО того, как это поле появилось, — а сериализованный JSON просто не содержит полей,
   * которых не было при сохранении), а сама dev-ветка вполне может продолжать жить и мержить ветки
   * дальше — обновляем эти данные, а не показываем их замороженными на момент последней сборки плана.
   */
  private applyMergeEvents(items: PlanItem[], mergeEvents: Map<string, MergeEventDetails[]>): Record<string, MergeEventInfo[]> {
    for (const item of items) {
      item.prNumber = mergeEvents.get(item.branch)?.[0]?.prNumber ?? null;
      Object.assign(item, this.buildLinks(item.branch, item.subject, item.sha, item.prNumber));
    }
    const mergeEventsByBranch: Record<string, MergeEventInfo[]> = {};
    for (const branch of new Set(items.map((i) => i.branch))) {
      // Если имя ветки когда-то уже использовалось (см. GitService.listMergeEvents), кандидатов
      // может быть несколько — оставляем только те слияния, которые реально влили один из ИЗВЕСТНЫХ
      // "своих" коммитов ЭТОЙ ветки (сверяем по родителям merge-коммита), а не любое совпадение по
      // имени: иначе сюда попал бы случайный старый merge той же ветки, никак не связанный с текущей
      // выборкой коммитов. Ветка вполне может быть смёржена НЕСКОЛЬКО РАЗ за свою жизнь (часть работы
      // смёржена раньше, часть — позже отдельным PR) — тогда relevant содержит больше одного элемента,
      // и дорожка веток в хронологии показывает каждое такое слияние отдельной точкой (см. renderItems).
      const branchItemShas = new Set(items.filter((i) => i.branch === branch).map((i) => i.sha));
      const relevant = (mergeEvents.get(branch) ?? []).filter((ev) => ev.parents.some((p) => branchItemShas.has(p)));
      if (relevant.length === 0) continue;
      mergeEventsByBranch[branch] = relevant
        .slice()
        .sort((a, b) => (a.authorDate < b.authorDate ? -1 : 1))
        .map((ev) => ({
          sha: ev.sha,
          subject: ev.subject,
          authorDate: ev.authorDate,
          authorName: ev.authorName,
          prNumber: ev.prNumber,
          ...this.buildLinks(branch, ev.subject, ev.sha, ev.prNumber),
        }));
    }
    return mergeEventsByBranch;
  }

  /**
   * Хронология (buildPlanItems + контекстные коммиты dev), сразу с проверкой на конфликты
   * (dry-run — см. runDryRunOnCurrentPlan), которая автоматически считается при построении/
   * изменении (кнопка "Проверить на конфликты" убрана — дублировала то, что и так нужно знать
   * сразу после построения).
   */
  private async rebuildPlan(): Promise<void> {
    const selected = this.selectedBranchRefs();
    if (selected.length === 0) {
      this.plan = null;
      this.panel.postPlan(null);
      return;
    }

    this.planGeneration += 1;
    const generation = this.planGeneration;

    const { mainRef, devRef, mergeEvents, devFirstParentShas } = await this.getRefsCache();
    if (generation !== this.planGeneration) return; // выбор веток уже поменялся, пока ждали кэш ссылок

    const { items, skipped, truncatedBranches } = await buildPlanItems(
      this.git,
      selected,
      devRef,
      mainRef,
      devFirstParentShas,
      this.resolveExtraBaseRefs()
    );

    if (generation !== this.planGeneration) return; // выбор веток уже поменялся, этот результат устарел

    const mergeEventsByBranch = this.applyMergeEvents(items, mergeEvents);

    const minItemDate = items.reduce((min, i) => (i.authorDate < min ? i.authorDate : min), items[0].authorDate);
    const [{ commits: contextCommits, truncated: contextTruncated }, anchorCommit] = await Promise.all([
      findContextCommits(this.git, devRef, items),
      findAnchorCommit(this.git, devRef, minItemDate),
    ]);
    for (const commit of contextCommits) {
      Object.assign(commit, this.buildLinks('', commit.subject, commit.sha, null));
    }
    if (anchorCommit) {
      Object.assign(anchorCommit, this.buildLinks('', anchorCommit.subject, anchorCommit.sha, null));
    }

    if (generation !== this.planGeneration) return;

    this.plan = {
      releaseBranch: this.releaseBranch,
      mainBranch: mainRef,
      items,
      contextCommits,
      contextCommitsTruncated: contextTruncated,
      anchorCommit,
      mergeEventsByBranch,
    };

    let dryRunWarning: string | null = null;
    try {
      await this.runDryRunOnCurrentPlan();
    } catch (err: any) {
      // Мягкий отказ — хронология всё равно должна показаться, просто без результатов dry-run
      // (коммиты останутся 'untested'); пользователь узнает из предупреждения, а не из падения всей сборки хронологии.
      dryRunWarning = `Проверка на конфликты не выполнена: ${err?.message ?? err}`;
    }

    if (generation !== this.planGeneration) return;

    this.persist();
    this.panel.postPlan(this.plan);
    this.panel.postStaleBranchesLoading();
    void this.runFindStaleBranches(generation, devRef);

    const warnings: string[] = [];
    if (skipped.length > 0) {
      warnings.push(
        'Не удалось получить коммиты для веток: ' + skipped.map((s) => `${s.branch} (${s.reason})`).join('; ')
      );
    }
    if (truncatedBranches.length > 0) {
      warnings.push(
        `У веток ${truncatedBranches.join(', ')} между ней и dev-веткой больше ${MAX_COMMITS_PER_BRANCH} коммитов — показаны только самые свежие. ` +
          'Возможно, dev-ветка сильно отстала или настройка devBranch указывает не туда — проверьте в настройках.'
      );
    }
    if (dryRunWarning) {
      warnings.push(dryRunWarning);
    }
    if (warnings.length > 0) {
      this.panel.postError(warnings.join(' '));
    }
  }

  /**
   * Открывает панель сборки: без checkout/pull основной ветки — только чтение состояния
   * репозитория. overrideConfig — запуск для сохранённого профиля проекта (см. ensureClients).
   *
   * Панель создаётся/показывается ПЕРВЫМ действием, до единого git-вызова — раньше здесь сначала
   * ждали ensureClients+pruneWorktrees, и панель (даже пустая, с лоадером) не появлялась, пока они
   * не завершатся, из-за чего "Собрать релизную ветку" ощутимо не сразу реагировала на клик.
   * Список веток теперь приходит в уже открытую панель отдельным сообщением, как только будет готов.
   */
  async start(extensionUri: vscode.Uri, overrideConfig?: ReleaseConfig): Promise<void> {
    this.panel = ReleasePanel.createOrShow(extensionUri, this);
    try {
      await this.ensureClients(overrideConfig);
      this.ready = true;
      await this.git.pruneWorktrees();
      await this.postCurrentBranch();
      await this.refreshBranches();
      await this.warnIfCherryPickInProgress();
    } catch (err: any) {
      this.panel.postError(err?.message ?? String(err));
    }
  }

  /** Продолжение ранее начатой сборки (например, после перезапуска VS Code или конфликта). Панель открывается сразу — см. комментарий у start(). */
  async resume(extensionUri: vscode.Uri): Promise<void> {
    this.panel = ReleasePanel.createOrShow(extensionUri, this);
    try {
      await this.ensureClients();
      this.ready = true;
      await this.git.pruneWorktrees();

      const state = this.context.workspaceState.get<PersistedState>(STATE_KEY);
      if (!state) {
        throw new Error('Нет сохранённой сборки релиза — начните новую через "Qvarh Release: собрать релизную ветку".');
      }
      this.releaseBranch = state.releaseBranch;
      this.selectedRefs = new Set(state.selectedRefs);
      this.plan = state.plan;

      await this.postCurrentBranch();
      await this.refreshBranches();
      if (this.plan) {
        // Персистентный план — застывший снимок с прошлого раза; dev могла продолжить жить и
        // смержить что-то уже ПОСЛЕ того, как план был сохранён (или план вообще сохранён более
        // старой версией расширения, до появления mergeEventsByBranch, — тогда в JSON его просто
        // нет). Пересчитываем его заново тем же дешёвым, уже закэшированным запросом, а не
        // показываем как есть — иначе дорожка веток в хронологии может ошибочно показывать давно
        // влитую ветку как всё ещё не влитую.
        try {
          const { mergeEvents } = await this.getRefsCache();
          this.plan.mergeEventsByBranch = this.applyMergeEvents(this.plan.items, mergeEvents);
        } catch {
          // Мягкий отказ — план всё равно должен показаться, просто без обновлённых данных о слиянии.
        }
        this.panel.postPlan(this.plan);
      }
      await this.warnIfCherryPickInProgress();
    } catch (err: any) {
      this.panel.postError(err?.message ?? String(err));
    }
  }

  /**
   * Клиентский скрипт панели шлёт 'refreshBranches' сам, сразу при загрузке (см. releasePanel.ts) —
   * это может произойти РАНЬШЕ, чем ensureClients() в start()/resume() успеет отработать (панель
   * теперь открывается ДО них, см. комментарий у start()). Пока клиенты не готовы, просто
   * игнорируем — start()/resume() и так сами вызовут refreshBranches(), как только будут готовы.
   */
  async onRefreshBranches(): Promise<void> {
    if (!this.ready) return;
    await this.refreshBranches();
  }

  async onFilterBranches(query: string): Promise<void> {
    await this.sendBranchSlice(query);
  }

  async onPullBranch(branchName: string): Promise<void> {
    await this.git.assertClean();
    await this.git.checkoutBranch(branchName);
    await this.git.pull();
    await this.postCurrentBranch();
    await this.refreshBranches();
  }

  async onExpandBranch(ref: string): Promise<void> {
    const branch = this.fullBranches.find((b) => b.ref === ref);
    if (!branch) {
      // Ветка могла исчезнуть из fullBranches между кликом на клиенте и обработкой здесь (например,
      // список как раз обновлялся). ВАЖНО ответить в любом случае — иначе клиент навсегда
      // останется в состоянии "Загрузка коммитов…", ожидая ответ, которого никогда не будет.
      this.panel.postBranchCommits(ref, [], false);
      this.panel.postError(`Ветка ${ref} не найдена в текущем списке — попробуйте обновить список веток.`);
      return;
    }
    try {
      const { devRef, mainRef } = await this.getRefsCache();
      const { commits, truncated, forkedFrom } = await getBranchCommits(
        this.git,
        branch,
        devRef,
        mainRef,
        undefined,
        this.resolveExtraBaseRefs()
      );
      for (const commit of commits) {
        Object.assign(commit, this.buildLinks(branch.name, commit.subject, commit.sha, null));
      }
      this.panel.postBranchCommits(ref, commits, truncated, forkedFrom ?? null);
    } catch (err: any) {
      this.panel.postBranchCommits(ref, [], false);
      this.panel.postError(`Не удалось получить коммиты ветки ${branch.name}: ${err?.message ?? err}`);
    }
  }

  /** Строит предпросмотр хронологии по выбранным веткам (и сразу проверяет на конфликты — см. rebuildPlan). Ничего не меняет в git — ветку релиза ещё не создаёт. */
  async onBuildPlan(selectedRefs: string[]): Promise<void> {
    if (selectedRefs.length === 0) {
      throw new Error('Выберите хотя бы одну ветку.');
    }
    this.selectedRefs = new Set(selectedRefs);
    await this.rebuildPlan();
  }

  /** Сбрасывает построенную хронологию и снимает выбор веток — начать заново, не закрывая панель. */
  async onClearPlan(): Promise<void> {
    this.selectedRefs = new Set();
    this.plan = null;
    this.persist();
    this.panel.postPlan(null);
  }

  /**
   * Автоматически, сразу после построения хронологии (см. rebuildPlan), но НЕ блокируя её показ —
   * широкий скан по ВСЕМУ репозиторию (дороже узкого findConflictCauses), поэтому запускается
   * отдельно от остального построения плана и результат подгружается следом (панель тем временем
   * показывает индикатор загрузки — см. postStaleBranchesLoading). Ищет ветки, отсоединившиеся от
   * dev РАНЬШЕ самой ранней ветки в текущей хронологии и всё ещё не слитые в саму dev (не в main —
   * ветка, уже влитая в dev, но ещё не выпущенная релизом, это норма, а не "забытая задача"). Ошибки
   * тут намеренно не всплывают наверх и не портят уже показанную хронологию — это необязательная
   * подсказка, а не критичная часть построения плана. `generation` защищает от гонки: если, пока
   * шёл скан, выбор веток уже поменялся и построился новый план, устаревший результат просто не
   * отправляется в панель.
   */
  private async runFindStaleBranches(generation: number, devRef: string): Promise<void> {
    if (!this.plan) return;
    const earliestDate = this.plan.items.reduce((min, i) => (i.authorDate < min ? i.authorDate : min), this.plan.items[0].authorDate);
    const excludeShas = new Set(this.plan.items.map((i) => i.sha));
    let hints: Awaited<ReturnType<typeof findStaleUnmergedBranches>> = [];
    try {
      hints = await findStaleUnmergedBranches(
        this.git,
        devRef,
        earliestDate,
        excludeShas,
        (name) => this.isIgnorableCandidateName(name),
        this.config.remoteName
      );
    } catch {
      hints = [];
    }
    if (generation !== this.planGeneration) return;
    const withLinks = hints.map((h) => ({ ...h, commitUrl: this.buildLinks('', h.subject, h.sha, null).commitUrl }));
    this.panel.postStaleBranches(withLinks);
  }

  async onToggleItem(sha: string, included: boolean): Promise<void> {
    if (!this.plan) return;
    const item = this.plan.items.find((i) => i.sha === sha);
    if (item && !item.applied) {
      item.included = included;
      this.persist();
    }
  }

  /** Main/dev/релизные/служебные ветки — не кандидаты в "возможные причины конфликта" (см. findConflictCauses), это не забытые задачи. */
  private isIgnorableCandidateName(name: string): boolean {
    const isReleaseBranch = releaseBranchMatcher(this.config.releaseBranchPattern);
    return (
      name === this.config.devBranch ||
      name === this.config.mainBranch ||
      isReleaseBranch(name) ||
      this.config.nonTaskBranchPrefixes.some((p) => name.startsWith(p))
    );
  }

  /**
   * Реально прогоняет cherry-pick во временном worktree, чтобы точно (а не эвристикой) показать
   * конфликты — раньше отдельная кнопка, теперь вызывается автоматически из rebuildPlan сразу
   * после построения/изменения хронологии (см. комментарий там), поэтому здесь только мутирует
   * this.plan.items — persist/postPlan и обработку ошибок делает вызывающий код.
   *
   * Если dry-run остановился на настоящем конфликте (не на уже-в-main коммите — для него достаточно
   * подсказки "можно исключить из релиза", основанной на существующем item.alreadyInMain), для
   * каждого конфликтующего файла ищем вероятную причину — см. findConflictCauses: коммиты с других,
   * ещё не выбранных веток, которые тоже трогают этот файл и ещё не в main. Дёшево (по одному
   * git-вызову на конфликтующий файл, а их обычно один-два — dry-run останавливается на первом
   * же конфликте), поэтому можно позволить себе всегда, а не только по отдельной кнопке.
   */
  private async runDryRunOnCurrentPlan(): Promise<void> {
    if (!this.plan || this.plan.items.length === 0) return;
    const outcome = await performDryRun(this.git, this.plan.mainBranch, this.plan.items);

    const bySha = new Map(outcome.results.map((r) => [r.sha, r] as const));
    for (const item of this.plan.items) {
      const result = bySha.get(item.sha);
      if (result) {
        item.dryRunStatus = result.status;
        item.dryRunConflictFiles = result.conflictFiles;
        item.dryRunConflictSources = result.conflictSources.map((source) => ({
          ...source,
          commitUrl: source.sha ? this.buildLinks('', source.subject ?? '', source.sha, null).commitUrl : null,
        }));
      } else if (item.included) {
        item.dryRunStatus = 'untested';
      }
    }

    const conflictItem = this.plan.items.find((i) => i.dryRunStatus === 'conflict');
    if (conflictItem && !conflictItem.alreadyInMain) {
      const excludeShas = new Set(this.plan.items.map((i) => i.sha));
      for (const source of conflictItem.dryRunConflictSources) {
        const causes = await findConflictCauses(
          this.git,
          this.plan.mainBranch,
          source.file,
          excludeShas,
          (name) => this.isIgnorableCandidateName(name),
          this.config.remoteName
        );
        source.possibleCauses = causes.map((c) => ({ ...c, commitUrl: this.buildLinks('', c.subject, c.sha, null).commitUrl }));
      }
    }
  }

  /** Реально создаёт (или переиспользует) релизную ветку от основной — только на этом шаге нужна дата. */
  async onStartBuilding(releaseDate: string): Promise<void> {
    if (!this.plan) throw new Error('Сначала постройте хронологию.');
    if (!releaseDate) throw new Error('Укажите дату релиза — она используется в имени релизной ветки.');

    await this.git.assertClean();

    this.releaseBranch = formatReleaseBranch(this.config.releaseBranchPattern, releaseDate);
    const mainRef = await this.resolveMainRef();

    if (await this.git.branchExists(this.releaseBranch)) {
      await this.git.checkoutBranch(this.releaseBranch);
    } else {
      await this.git.createReleaseBranch(this.releaseBranch, mainRef);
    }

    this.plan.releaseBranch = this.releaseBranch;
    this.persist();
    await this.postCurrentBranch();
    this.panel.postPlan(this.plan);
  }

  async onStartAuto(): Promise<void> {
    if (!this.plan?.releaseBranch) throw new Error('Сначала создайте релизную ветку.');
    await applyAll(this.git, this.plan, (ev) => {
      this.persist();
      this.panel.postProgress(ev);
    });
  }

  async onStepNext(): Promise<void> {
    if (!this.plan?.releaseBranch) throw new Error('Сначала создайте релизную ветку.');
    await applyNextItem(this.git, this.plan, (ev) => {
      this.persist();
      this.panel.postProgress(ev);
    });
  }

  async onContinueConflict(): Promise<void> {
    if (!this.plan) return;
    await resolveConflictAndContinue(this.git, this.plan);
    this.persist();
    this.panel.postPlan(this.plan);
  }

  async onSkipConflict(): Promise<void> {
    if (!this.plan) return;
    await skipConflictingItem(this.git, this.plan);
    this.persist();
    this.panel.postPlan(this.plan);
  }

  /** Аварийный выход: полностью отменяет незавершённый cherry-pick (git cherry-pick --abort). */
  async onAbortBuild(): Promise<void> {
    if (await this.git.isCherryPickInProgress()) {
      await this.git.cherryPickAbort();
    }
    await this.postCurrentBranch();
    this.panel.postError('');
  }
}
