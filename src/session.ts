import * as vscode from 'vscode';
import {
  buildBitbucketCommitUrl,
  buildBitbucketPrUrl,
  buildTaskUrl,
  extractTaskKey,
  formatReleaseBranch,
  readConfig,
  readProjects,
  releaseBranchMatcher,
  resolveBitbucketRepoSlug,
  resolveRepositoryPath,
  saveProjects,
} from './config';
import { performDryRun } from './core/dryRun';
import { applyAll } from './core/executor';
import {
  DevFirstParentShas,
  ExtraBaseRef,
  MAX_COMMITS_PER_BRANCH,
  buildPlanItems,
  computeMainStatusForBranches,
  findAnchorCommit,
  findCommitsAlreadyInRef,
  findConflictCauses,
  findContextCommits,
  findStaleUnmergedBranches,
  getBranchCommits,
} from './core/planner';
import { BranchRef, MergeEventInfo, PlanItem, ReleaseConfig, ReleasePlan } from './core/types';
import { GitService, MergeEventDetails, mainSubjectDateKey } from './git/gitService';
import { PanelContext, ReleasePanel, ReleasePanelHost } from './ui/releasePanel';

const STATE_KEY_PREFIX = 'qvarhRelease.session.v3';

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
  /**
   * id сохранённого профиля проекта, если панель открыта именно для него (см. start()), иначе
   * undefined — "текущий workspace". Нужен, чтобы понять, КУДА сохранять staleBranchesLookbackReleases
   * при изменении прямо в панели (см. onSetStaleBranchesLookback): в конкретный профиль в
   * qvarhRelease.projects или в единый workspace-конфиг qvarhRelease.git.*.
   */
  private projectId: string | undefined;

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
   * "Показать служебные ветки" (qa, revert-pr-, chore/ и т.п. — см. nonTaskBranchPrefixes) —
   * в отличие от hideAlreadyInMain, это просто проверка префикса имени, без единого git-вызова,
   * поэтому применяется СРАЗУ при переключении переключателя, реактивно. По умолчанию служебные
   * ветки СКРЫТЫ (true) — обычно они не нужны при выборе веток в релиз, показывать их сразу же
   * при первом открытии панели скорее шум, чем полезная информация.
   */
  private hideServiceBranches = true;
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

  /**
   * Панель — синглтон на всё расширение (см. ReleasePanel.createOrShow), а каждый клик по 🚀 (в т.ч.
   * повторный по ТОМУ ЖЕ проекту) создаёт НОВУЮ ReleaseSession и тут же становится её хозяином —
   * не дожидаясь, пока предыдущая ReleaseSession закончит СВОИ уже начатые git-вызовы. Без этой
   * проверки перед каждым post-вызовом ПОСЛЕ await устаревшая сессия (переключились на другой
   * проект/workspace до того, как её собственный refreshBranches()/rebuildPlan() и т.п. успел
   * завершиться) молча дописывала бы свой результат в уже переключённую панель — список веток,
   * хронология, ошибки предыдущего проекта "всплывали" бы поверх нового. Сам git-процесс (если уже
   * запущен, например реальный cherry-pick при сборке) при этом НЕ прерывается — прерывать
   * наполовину применённую сборку релиза было бы куда опаснее, чем просто не показать её прогресс;
   * прекращается только отправка результатов в панель, которая больше не про этот проект.
   */
  private isActive(): boolean {
    return this.panel.isCurrentHost(this);
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

  /**
   * Ссылка на основную ветку: ЛОКАЛЬНАЯ main, если она есть, иначе origin/main — без checkout.
   * Используется и для создания релизной ветки, и как база проверок "уже в main" (dry-run,
   * фоновый статус в списке веток) — важно, чтобы обе части использовали ОДНУ И ТУ ЖЕ базу:
   * иначе релизная ветка была бы отрезана от одного main, а "уже выпущено" считалось бы по
   * ДРУГОМУ (более свежему origin/main) — коммит мог бы тихо посчитаться "уже в main", хотя в
   * реальной базе релизной ветки его ещё нет.
   *
   * Раньше было наоборот (origin/main предпочитался как более свежий) — специально ради этого и
   * добавлена кнопка Pull в шапке панели: пользователь сам решает, когда обновить локальный main
   * (`git pull`), и до этого момента расширение использует именно то, что реально стоит в
   * рабочем каталоге, а не тихо подглядывает в origin за его спиной. Так удалённая ветка не может
   * незаметно "утечь" в качестве базы релиза — что раньше приводило к путанице с upstream-
   * tracking релизной ветки (см. GitService.createReleaseBranch).
   */
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
    if (await this.git.refExists(branchName)) {
      return branchName;
    }
    // Локальной ветки нет вовсе (например, репозиторий только что клонирован и её никто не
    // чекаутил) — тогда остаётся откатиться на remote-tracking, иначе резолвить было бы вообще
    // не из чего.
    return `${this.config.remoteName}/${branchName}`;
  }

  /**
   * Кэширует ссылки main/dev, индекс "sha родителя merge-коммита → merge-события" (см.
   * GitService.listMergeEvents) и множество first-parent SHA dev-ветки — реально они меняются
   * только вместе с состоянием репозитория (Pull/явный Refresh), а не
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

  /**
   * Ключ persisted-состояния — с привязкой к репозиторию (this.repoPath, известен только после
   * ensureClients()), а не один общий на всё расширение: один и тот же vscode workspace может
   * держать несколько сохранённых профилей проектов (см. "Проекты" в боковой панели) на РАЗНЫЕ
   * репозитории — раньше все они делили один и тот же ключ workspaceState, и сборка релиза для
   * одного проекта могла молча "продолжиться" данными от совсем другого репозитория.
   */
  private stateKey(): string {
    return `${STATE_KEY_PREFIX}:${this.repoPath}`;
  }

  private persist(): void {
    const state: PersistedState = {
      releaseBranch: this.releaseBranch,
      selectedRefs: [...this.selectedRefs],
      plan: this.plan,
    };
    void this.context.workspaceState.update(this.stateKey(), state);
  }

  /** Заново читает список веток из git (дорого только сам git-вызов; отправка в панель — через sendBranchSlice). */
  private async refreshBranches(): Promise<void> {
    this.refsCache = null; // состояние репозитория могло поменяться (Pull/явный Refresh) — см. getRefsCache
    this.fullBranches = this.applyDuplicateBranchFilter(await this.git.listBranches());
    this.postReleaseBranchPatternCount();
    await this.sendBranchSlice('');
  }

  /** Сколько веток в репозитории подходят под шаблон релизной ветки (releaseBranchPattern) — общая
   * картина наверху панели ("сколько релизов вообще было"), не привязано к конкретной дате/сборке. */
  private postReleaseBranchPatternCount(): void {
    if (!this.isActive()) return;
    const isReleaseBranch = releaseBranchMatcher(this.config.releaseBranchPattern);
    const count = this.fullBranches.filter((b) => isReleaseBranch(b.name)).length;
    this.panel.postReleaseBranchPatternCount(count);
  }

  /**
   * Если включено (по умолчанию — см. hideDuplicateRemoteBranches в config.ts), скрывает
   * REMOTE-TRACKING ветку из списка, если для неё существует ЛОКАЛЬНАЯ пара с тем же именем И
   * ТЕМ ЖЕ последним коммитом — иначе большинство веток репозитория показывались бы дважды подряд
   * (feature/PROJ-123 и origin/feature/PROJ-123), почти всегда указывая на один и тот же коммит.
   * Локальная версия оставляется как основная: типичный сценарий работы с расширением — сначала
   * Pull (checkout + pull) нужной ветки, дальше работа идёт именно с локальной веткой, а не с
   * remote-tracking.
   *
   * СРАВНЕНИЕ SHA ОБЯЗАТЕЛЬНО — раньше ветки считались "дубликатом" просто по совпадению ИМЕНИ, а
   * не факту, что это реально один и тот же коммит. Подтверждено на реальном случае: локальная
   * feature/DOS-2615 годами не обновлялась (последний коммит — от совсем другой задачи, чей-то
   * старый checkout под тем же именем) и указывала на коммит, уже полностью влитый в dev сам по
   * себе — у неё попросту НЕТ "своих" коммитов относительно dev. Реальная, актуальная работа по
   * DOS-2615 была только в origin/feature/DOS-2615 — но та молча скрывалась этим фильтром, раз
   * локальная "пара" с тем же именем формально существовала. Пользователь выбирал то, что видел
   * в списке (сталую локальную), получал "нет коммитов" и пустую хронологию — не баг построения
   * плана, а то, что реальная ветка с реальными коммитами вообще не попадала в список для выбора.
   * Если локальная и remote-tracking ветки расходятся (в любую сторону — локальная позади,
   * впереди или на другой линии) — показываем ОБЕ, а не гадаем, какая "правильнее": несовпадение
   * само по себе полезный сигнал (видно по превью последнего коммита в списке, какая из них
   * актуальна), молчаливое скрытие — нет.
   */
  private applyDuplicateBranchFilter(branches: BranchRef[]): BranchRef[] {
    if (!this.config.hideDuplicateRemoteBranches) {
      return branches;
    }
    const localShaByName = new Map(branches.filter((b) => !b.isRemote).map((b) => [b.name, b.lastCommitSha]));
    return branches.filter((b) => !b.isRemote || localShaByName.get(b.name) !== b.lastCommitSha);
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
    // баг "поиск находит нужное, а потом добавляет ещё лишнее"). !this.isActive() — тот же случай,
    // но по другой причине: не просто устарел фильтр, а сменился ПРОЕКТ (см. isActive).
    if (generation !== this.branchSliceGeneration || !this.isActive()) return;

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
      const { statusByRef, diffStatByRef } = await computeMainStatusForBranches(this.git, slice, devRef, mainRef, devFirstParentShas);
      if (generation !== this.branchSliceGeneration || !this.isActive()) return;

      if (statusByRef.size > 0) this.panel.postBranchMainStatus(Object.fromEntries(statusByRef));
      if (diffStatByRef.size > 0) this.panel.postBranchDiffStats(Object.fromEntries(diffStatByRef));
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
    if ((await this.git.isCherryPickInProgress()) && this.isActive()) {
      this.panel.postError(
        'В репозитории обнаружен незавершённый cherry-pick (вероятно, от прошлой сессии). ' +
          'Это может мешать переключению веток через интерфейс VS Code. ' +
          'Разрешите конфликт и нажмите "Начать сборку" ещё раз — она продолжит с того же места, либо нажмите "Отменить сборку (cherry-pick --abort)" ниже.'
      );
    }
  }

  private async postCurrentBranch(): Promise<void> {
    const current = await this.git.currentBranch();
    if (!this.isActive()) return;
    this.panel.postCurrentBranch(current, this.config.mainBranch, this.config.devBranch, this.config.staleBranchesLookbackReleases);
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
   *
   * Поиск слияния — по ТОПОЛОГИИ (родители merge-коммита среди уже известных "своих" коммитов
   * ветки, см. GitService.listMergeEvents), а не по имени ветки/тексту subject: это гарантия
   * самого git, а не соглашение конкретного хостинга или языка интерфейса. prNumber — best-effort
   * (см. extractPrNumber в gitService.ts), может быть null, если subject не подошёл ни под один
   * известный формат — на сам факт слияния (и линию на графе) это не влияет.
   */
  private applyMergeEvents(items: PlanItem[], mergeEventsByParentSha: Map<string, MergeEventDetails[]>): Record<string, MergeEventInfo[]> {
    const mergeEventsByBranch: Record<string, MergeEventInfo[]> = {};
    for (const branch of new Set(items.map((i) => i.branch))) {
      const branchItems = items.filter((i) => i.branch === branch);
      // Ветка вполне может быть смёржена НЕСКОЛЬКО РАЗ за свою жизнь (часть работы смёржена раньше,
      // часть — позже отдельным PR) — каждый "свой" коммит ветки может оказаться родителем СВОЕГО
      // merge-коммита, поэтому проверяем ВСЕ, а не только последний/первый. Дедуп по sha самого
      // merge-коммита — один merge мог "поглотить" сразу несколько своих коммитов подряд, событие
      // при этом одно и то же и не должно попасть в mergeEventsByBranch дважды.
      const seenMergeShas = new Set<string>();
      const relevant: MergeEventDetails[] = [];
      for (const item of branchItems) {
        // PR конкретного коммита — это PR того merge-коммита, который ЕГО реально поглотил
        // (т.е. у которого item.sha — родитель), а не "первый по дате" PR ветки: при нескольких
        // слияниях одной ветки разные коммиты уходят в разные PR (см. mergeEventsByParentSha).
        const ownEvents = (mergeEventsByParentSha.get(item.sha) ?? [])
          .slice()
          .sort((a, b) => (a.authorDate < b.authorDate ? -1 : 1));
        const own = ownEvents[0];
        item.prNumber = own?.prNumber ?? null;
        Object.assign(item, this.buildLinks(item.branch, item.subject, item.sha, item.prNumber));
        for (const ev of ownEvents) {
          if (seenMergeShas.has(ev.sha)) continue;
          seenMergeShas.add(ev.sha);
          relevant.push(ev);
        }
      }
      const sorted = relevant.slice().sort((a, b) => (a.authorDate < b.authorDate ? -1 : 1));
      if (sorted.length === 0) continue;
      mergeEventsByBranch[branch] = sorted.map((ev) => ({
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

    if (generation !== this.planGeneration || !this.isActive()) return;

    this.persist();
    this.panel.postPlan(this.plan);
    this.panel.postStaleBranchesLoading();
    void this.runFindStaleBranches(generation, mainRef);

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
    if (warnings.length > 0 && this.isActive()) {
      this.panel.postError(warnings.join(' '));
    }
  }

  /**
   * Сверяет item.applied для ещё НЕ отмеченных как applied пунктов плана с РЕАЛЬНОЙ историей
   * релизной ветки — по patch-id/subject+date (см. findCommitsAlreadyInRef в planner.ts), а не по
   * git-ancestry исходного sha (после cherry-pick у коммита другой sha и родители). Нужно при
   * восстановлении состояния после перезапуска VS Code (см. applyPersistedState) — persist()
   * записывает applied после каждого шага применения, но если сессия закрылась ДО того, как это
   * успело сохраниться, или пользователь успел применить что-то в релизной ветке НЕ через это
   * расширение, сохранённый флаг отстаёт от реальности. Можно собирать релиз частями в несколько
   * заходов (сейчас часть коммитов, после перезагрузки — остальное) — именно для этого сверка и
   * должна идти по факту git-истории, а не вслепую доверять старому снимку.
   */
  private async syncAppliedFromReleaseBranch(): Promise<void> {
    if (!this.plan || !this.releaseBranch) return;
    const notYetApplied = this.plan.items.filter((i) => !i.applied);
    if (notYetApplied.length === 0) return;
    const appliedShas = await findCommitsAlreadyInRef(this.git, this.releaseBranch, notYetApplied);
    if (appliedShas.size === 0) return;
    for (const item of notYetApplied) {
      if (appliedShas.has(item.sha)) {
        item.applied = true;
      }
    }
  }

  /** Пустой, но валидный план — только чтобы клиент узнал releaseBranch (см. updateBuildButtonsState в releasePanel.ts, читает currentPlan.releaseBranch), когда настоящей хронологии ещё нет. */
  private emptyPlanFor(releaseBranch: string): ReleasePlan {
    return {
      releaseBranch,
      mainBranch: '',
      items: [],
      contextCommits: [],
      contextCommitsTruncated: false,
      anchorCommit: null,
      mergeEventsByBranch: {},
    };
  }

  /**
   * Сверяет item.alreadyInMain со свежим состоянием mainRef, а не доверяет значению из
   * персистентного/сохранённого снимка плана. alreadyInMain, в отличие от item.applied, не должен
   * меняться от действий самой сборки релиза — но снимок в workspaceState мог быть посчитан ДО
   * того, как main реально получил этот диф (или до исправления самой эвристики сравнения в более
   * старой версии расширения), и без пересчёта восстановленная хронология показывала бы бейдж
   * "уже в main", посчитанный неизвестно когда, а не по факту текущей истории main.
   */
  private async syncAlreadyInMainFromCurrentState(mainRef: string): Promise<void> {
    if (!this.plan || this.plan.items.length === 0) return;
    const alreadyInMainShas = await findCommitsAlreadyInRef(this.git, mainRef, this.plan.items);
    for (const item of this.plan.items) {
      item.alreadyInMain = alreadyInMainShas.has(item.sha);
    }
  }

  /**
   * Общая часть start()/resume() ПОСЛЕ того, как this.releaseBranch/selectedRefs/plan уже
   * выставлены вызывающим кодом — пересчитывает mergeEventsByBranch (dev могла продолжить жить
   * между сессиями), сверяет applied/alreadyInMain с реальностью (см. syncAppliedFromReleaseBranch/
   * syncAlreadyInMainFromCurrentState) и перепрогоняет dry-run на АКТУАЛЬНЫХ данных (а не
   * показывает застывший снимок — см. runDryRunOnCurrentPlan), затем сохраняет и показывает план.
   *
   * Поля выставляются ДО refreshBranches() у обоих вызывающих (start()/resume()), а не здесь —
   * refreshBranches() отправляет клиенту список веток вместе с this.selectedRefs НА МОМЕНТ вызова
   * (см. sendBranchSlice → postBranches), и клиент заполняет чекбоксы только из ПЕРВОГО такого
   * сообщения (см. selectionInitialized в releasePanel.ts). Если restore этого метода выставлял бы
   * selectedRefs позже, первое сообщение уходило бы с пустым набором, и восстановленная хронология
   * приходила бы без отмеченных чекбоксов веток.
   */
  private async finishApplyingPlan(): Promise<void> {
    if (!this.plan) return;
    if (this.plan.items.length === 0) {
      this.persist();
      if (this.isActive()) this.panel.postPlan(this.plan);
      await this.loadReleaseBranchOwnCommits();
      return;
    }
    try {
      // Персистентный план — застывший снимок с прошлого раза; dev могла продолжить жить и
      // смержить что-то уже ПОСЛЕ того, как план был сохранён (или план вообще сохранён более
      // старой версией расширения, до появления mergeEventsByBranch, — тогда в JSON его просто
      // нет). Пересчитываем его заново тем же дешёвым, уже закэшированным запросом, а не
      // показываем как есть — иначе дорожка веток в хронологии может ошибочно показывать давно
      // влитую ветку как всё ещё не влитую.
      const { mainRef, mergeEvents } = await this.getRefsCache();
      this.plan.mergeEventsByBranch = this.applyMergeEvents(this.plan.items, mergeEvents);
      await this.syncAppliedFromReleaseBranch();
      await this.syncAlreadyInMainFromCurrentState(mainRef);
      // dryRunStatus/dryRunConflictFiles в снимке — тоже застывшие, с момента ПОСЛЕДНЕЙ сборки
      // хронологии (возможно ещё до того, как что-либо было применено). Раз applied только что
      // обновился по факту, старая dry-run информация для уже применённых пунктов не только
      // устарела, но и заведомо неверна (см. runDryRunOnCurrentPlan/performDryRun — теперь
      // пропускает applied-пункты и стартует от релизной, а не от основной ветки, если она есть).
      await this.runDryRunOnCurrentPlan();
    } catch {
      // Мягкий отказ — план всё равно должен показаться, просто без обновлённых данных.
    }
    this.persist();
    if (this.isActive()) this.panel.postPlan(this.plan);
  }

  /** "YYYY-MM-DD" на СЕГОДНЯ — тот же формат, что и клиентский todayIso() в releasePanel.ts, для formatReleaseBranch. */
  private todayIso(): string {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  /** Имя релизной ветки, которое дало бы имя формата, если бы её создавали ПРЯМО СЕЙЧАС. */
  private expectedReleaseBranchForToday(): string {
    return formatReleaseBranch(this.config.releaseBranchPattern, this.todayIso());
  }

  /**
   * Персистентное состояние для ЭТОГО репозитория, если оно есть и его релизная ветка реально
   * существует — с разовой миграцией из старого (до v0.29) общего на всё расширение ключа: раньше
   * состояние хранилось без привязки к репозиторию, и после того как ключ стал привязан к
   * this.repoPath, старые данные иначе остались бы сиротой (новый код их просто не читает, а
   * пользователь видел бы "релизная ветка еще не создана", хотя локально она уже есть и часть
   * коммитов применена). Переносим только если releaseBranch из старого состояния реально
   * существует В ЭТОМ репозитории — иначе это, скорее всего, состояние другого проекта из общего
   * workspace, и присваивать его этому было бы неправильно.
   */
  private async findUsablePersistedState(): Promise<PersistedState | undefined> {
    let state = this.context.workspaceState.get<PersistedState>(this.stateKey());
    if (!state) {
      const legacy = this.context.workspaceState.get<PersistedState>(STATE_KEY_PREFIX);
      if (legacy?.releaseBranch && (await this.git.branchExists(legacy.releaseBranch))) {
        state = legacy;
        void this.context.workspaceState.update(this.stateKey(), legacy);
        void this.context.workspaceState.update(STATE_KEY_PREFIX, undefined);
      }
    }
    if (state?.releaseBranch && !(await this.git.branchExists(state.releaseBranch))) {
      return undefined; // ветка удалена — состояние больше не актуально
    }
    return state;
  }

  /**
   * Когда для найденной (по сегодняшней дате, см. expectedReleaseBranchForToday) релизной ветки НЕТ
   * персистентного плана (например, ветку создали в версии расширения без сохранения состояния,
   * или вручную, не через это расширение) — читаем её git-историю напрямую (см.
   * GitService.releaseBranchOwnCommits) и показываем хотя бы то, что в ней реально уже есть, а не
   * молча оставляем панель без единой подсказки, что сборка вообще начата.
   */
  private async loadReleaseBranchOwnCommits(): Promise<void> {
    if (!this.releaseBranch) return;
    try {
      const mainRef = await this.resolveMainRef();
      const commits = await this.git.releaseBranchOwnCommits(this.releaseBranch, mainRef, 200);
      const withLinks = commits.map((c) => ({ ...c, ...this.buildLinks('', c.subject, c.sha, null) }));
      if (this.isActive()) this.panel.postReleaseBranchInfo(this.releaseBranch, withLinks);
    } catch {
      // Мягкий отказ — необязательная подсказка, не должна ронять открытие панели.
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
   *
   * Восстанавливает сборку автоматически (даже если панель открыта обычным способом — 🚀 в
   * "Проектах", а не отдельной командой "продолжить сборку") ТОЛЬКО если ТЕКУЩАЯ ветка репозитория
   * (git.currentBranch()) сама и есть релизная ветка для СЕГОДНЯШНЕЙ даты (см.
   * expectedReleaseBranchForToday). Специально не восстанавливаем по одному лишь факту "такая
   * ветка где-то существует" — если пользователь сейчас на dev (или любой другой ветке), значит
   * релизом прямо сейчас не занимается, и молчаливая подгрузка чужой хронологии только путает:
   * непонятно, к какому состоянию репозитория она относится, раз рабочий каталог сейчас не на ней.
   * Если персистентный план есть, но относится к ДРУГОЙ ветке (более старый релиз) — тоже не
   * подходит, читаем историю текущей ветки напрямую (см. loadReleaseBranchOwnCommits).
   */
  async start(extensionUri: vscode.Uri, overrideConfig?: ReleaseConfig, projectContext?: PanelContext): Promise<void> {
    this.panel = ReleasePanel.createOrShow(extensionUri, this, projectContext);
    this.projectId = projectContext?.projectId;
    try {
      await this.ensureClients(overrideConfig);
      this.ready = true;
      await this.git.pruneWorktrees();
      await this.postCurrentBranch();

      const currentBranchName = await this.git.currentBranch();
      const expected = this.expectedReleaseBranchForToday();
      let shouldFinishPlan = false;
      if (currentBranchName === expected) {
        const state = await this.findUsablePersistedState();
        if (state && state.releaseBranch === expected) {
          this.releaseBranch = state.releaseBranch;
          this.selectedRefs = new Set(state.selectedRefs);
          this.plan = state.plan ? { ...state.plan, releaseBranch: this.releaseBranch } : this.emptyPlanFor(this.releaseBranch);
        } else {
          // Нет персистентного плана именно для этой ветки (никто ничего не выбирал в ЭТОЙ
          // сессии, или сохранённое состояние — про другой, более старый релиз) — но ветка реально
          // есть и мы на ней, и клиент понимает "релиз создан" именно по currentPlan.releaseBranch
          // (см. updateBuildButtonsState в releasePanel.ts), поэтому заводим ПУСТОЙ, но валидный
          // план — как только пользователь выберет ветки и построит хронологию, rebuildPlan()
          // полностью заменит его настоящим.
          this.releaseBranch = expected;
          this.plan = this.emptyPlanFor(expected);
        }
        shouldFinishPlan = true;
      }

      await this.refreshBranches();

      if (shouldFinishPlan) {
        await this.finishApplyingPlan();
      }
      await this.warnIfCherryPickInProgress();
    } catch (err: any) {
      if (this.isActive()) this.panel.postError(err?.message ?? String(err));
    }
  }

  /**
   * Продолжение ранее начатой сборки (например, после перезапуска VS Code или конфликта) —
   * явная команда пользователя, поэтому, в отличие от start(), восстанавливает persisted-состояние
   * независимо от того, на какой ветке сейчас репозиторий (пользователь мог переключиться на
   * dev для другой задачи, не закончив релиз, и явно просит продолжить именно его). Панель
   * открывается сразу — см. комментарий у start().
   */
  async resume(extensionUri: vscode.Uri): Promise<void> {
    this.panel = ReleasePanel.createOrShow(extensionUri, this);
    try {
      await this.ensureClients();
      this.ready = true;
      await this.git.pruneWorktrees();

      const state = await this.findUsablePersistedState();
      if (!state) {
        throw new Error(
          'Нет сохранённой сборки релиза для этого репозитория (или её ветка больше не существует) — начните новую через "Qvarh Release: собрать релизную ветку".'
        );
      }
      this.releaseBranch = state.releaseBranch;
      this.selectedRefs = new Set(state.selectedRefs);
      this.plan = state.plan ? { ...state.plan, releaseBranch: this.releaseBranch } : this.emptyPlanFor(this.releaseBranch);

      await this.postCurrentBranch();
      await this.refreshBranches();
      await this.finishApplyingPlan();
      await this.warnIfCherryPickInProgress();
    } catch (err: any) {
      if (this.isActive()) this.panel.postError(err?.message ?? String(err));
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

  /**
   * Переключение на другую ветку (только checkout, без pull) — панель делает это САМА при выборе
   * ветки в селекте "Текущая ветка" (см. releasePanel.ts), pull — отдельным действием по кнопке
   * "Pull" (см. onPullCurrentBranch), уже над тем, что выбрано здесь.
   */
  async onSwitchBranch(branchName: string): Promise<void> {
    await this.git.assertClean();
    await this.git.checkoutBranch(branchName);
    await this.postCurrentBranch();
    await this.refreshBranches();
  }

  /** Pull ТЕКУЩЕЙ (уже выбранной через onSwitchBranch) ветки — без параметра имени и без checkout. */
  async onPullCurrentBranch(): Promise<void> {
    await this.git.assertClean();
    await this.git.pull(this.config.remoteName);
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
      if (!this.isActive()) return;
      this.panel.postBranchCommits(ref, commits, truncated, forkedFrom ?? null);
    } catch (err: any) {
      if (!this.isActive()) return;
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
   * Дата самой старой из последних N релизных веток (по шаблону releaseBranchPattern, сортировка
   * по дате последнего коммита — простое и дешёвое приближение "когда был этот релиз", без единого
   * дополнительного git-вызова, т.к. this.fullBranches уже загружен). null, если релизных веток
   * меньше N (в т.ч. вовсе нет) — тогда этот сигнал просто не участвует в поиске забытых веток,
   * остаётся только "раньше самой ранней выбранной".
   */
  private findReleaseLookbackDate(n: number): string | null {
    const isReleaseBranch = releaseBranchMatcher(this.config.releaseBranchPattern);
    const releaseBranches = this.fullBranches
      .filter((b) => isReleaseBranch(b.name) && b.lastCommitDate)
      .sort((a, b) => (a.lastCommitDate > b.lastCommitDate ? -1 : 1));
    if (releaseBranches.length < n) return null;
    return releaseBranches[n - 1].lastCommitDate;
  }

  /**
   * Автоматически, сразу после построения хронологии (см. rebuildPlan), но НЕ блокируя её показ —
   * широкий скан по ВСЕМУ репозиторию (дороже узкого findConflictCauses), поэтому запускается
   * отдельно от остального построения плана и результат подгружается следом (панель тем временем
   * показывает индикатор загрузки — см. postStaleBranchesLoading). Ищет ветки, ещё не выпущенные в
   * main и либо отсоединившиеся РАНЬШЕ самого свежего коммита среди уже выбранных веток в текущей
   * хронологии, либо просто не отмеченные чекбоксом сейчас и не трогавшиеся дольше окна последних
   * staleBranchesLookbackReleases релизов (более ПОЗДНЯЯ из двух дат в качестве верхней границы
   * `--until` — так шире, чем любой сигнал по отдельности, а не уже). Ошибки тут
   * намеренно не всплывают наверх и не портят уже показанную хронологию — это необязательная
   * подсказка, а не критичная часть построения плана. `generation` защищает от гонки: если, пока
   * шёл скан, выбор веток уже поменялся и построился новый план, устаревший результат просто не
   * отправляется в панель.
   */
  private async runFindStaleBranches(generation: number, mainRef: string): Promise<void> {
    if (!this.plan) return;
    // САМЫЙ СВЕЖИЙ коммит среди выбранных (MAX), а не самый ранний (MIN) — раньше здесь была
    // именно MIN-дата, из-за чего добавление в выбор ЕЩЁ ОДНОЙ, более старой ветки сдвигало эту
    // границу НАЗАД во времени и "прятало" уже найденную забытую ветку, оказавшуюся между старой и
    // новой границей (подтверждено на реальном кейсе: с одной выбранной feature/DOS-2808 забытая
    // feature/DOS-2841 находилась верно, но стоило добавить в выбор ещё и более старую feature/
    // DOS-2863 — feature/DOS-2841 переставала считаться забытой, хотя объективно осталась точно
    // такой же неучтённой веткой). MAX не зависит от того, какие ещё старые ветки попали в выбор:
    // граница — это "самое свежее из уже происходящего в этом релизе", и она может только
    // сдвигаться ВПЕРЁД (если выбрали ветку свежее), а не назад.
    const latestSelectedDate = this.plan.items.reduce((max, i) => (i.authorDate > max ? i.authorDate : max), this.plan.items[0].authorDate);
    const releaseLookbackDate = this.findReleaseLookbackDate(this.config.staleBranchesLookbackReleases);
    // MAX, а не MIN: --until в logCommitsNotInRefBeforeDate — верхняя граница (коммиты ДО этой
    // даты), поэтому объединение "по ИЛИ" двух сигналов (раньше latestSelectedDate ИЛИ раньше
    // releaseLookbackDate) даёт именно более позднюю из двух дат — более РАННЯЯ (MIN) только
    // сужала бы окно относительно исходного latestSelectedDate и могла вовсе потерять сигнал (б),
    // а не расширить поиск, как задумано.
    const beforeDate = releaseLookbackDate && releaseLookbackDate > latestSelectedDate ? releaseLookbackDate : latestSelectedDate;
    const excludeShas = new Set(this.plan.items.map((i) => i.sha));
    let hints: Awaited<ReturnType<typeof findStaleUnmergedBranches>> = [];
    try {
      hints = await findStaleUnmergedBranches(
        this.git,
        mainRef,
        beforeDate,
        excludeShas,
        (name) => this.isIgnorableCandidateName(name),
        this.config.remoteName
      );
    } catch {
      hints = [];
    }
    if (generation !== this.planGeneration || !this.isActive()) return;
    const withLinks = hints.map((h) => ({ ...h, ...this.buildLinks(h.branch, h.subject, h.sha, null) }));
    this.panel.postStaleBranches(withLinks);
  }

  /**
   * Меняет "окно" поиска забытых веток (см. runFindStaleBranches) — редактируется прямо в блоке
   * панели, не в настройках. Сохраняется в ТОТ ЖЕ профиль, для которого открыта панель (если это
   * сохранённый проект — см. this.projectId), иначе в единый workspace-конфиг qvarhRelease.git.*.
   * Не пересчитывает уже показанный список сразу — как и с лимитом показа веток, новое значение
   * учитывается со следующего построения хронологии.
   */
  async onSetStaleBranchesLookback(n: number): Promise<void> {
    const normalized = Number.isFinite(n) && n > 0 ? Math.floor(n) : this.config.staleBranchesLookbackReleases;
    this.config.staleBranchesLookbackReleases = normalized;
    if (this.projectId) {
      const projects = readProjects();
      const index = projects.findIndex((p) => p.id === this.projectId);
      if (index >= 0) {
        projects[index] = { ...projects[index], staleBranchesLookbackReleases: normalized };
        await saveProjects(projects);
      }
    } else {
      await vscode.workspace.getConfiguration('qvarhRelease').update('git.staleBranchesLookbackReleases', normalized, vscode.ConfigurationTarget.Global);
    }
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
    // Если релизная ветка уже реально существует — симулируем оставшиеся (ещё не applied, см.
    // performDryRun) пункты ОТ НЕЁ, а не от основной ветки: она уже содержит всё, что применено на
    // самом деле, и именно это состояние реально будет при следующем "Начать сборку". Симуляция от
    // main вместо этого — источник ложных конфликтов для контента, который уже применён и никакого
    // конфликта на самом деле не вызовет (см. performDryRun).
    const baseRef =
      this.releaseBranch && (await this.git.branchExists(this.releaseBranch)) ? this.releaseBranch : this.plan.mainBranch;
    const outcome = await performDryRun(this.git, baseRef, this.plan.items);

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
        source.possibleCauses = causes.map((c) => ({ ...c, ...this.buildLinks(c.branch, c.subject, c.sha, null) }));
      }
    }
  }

  /** Реально создаёт (или переиспользует) релизную ветку от основной — только на этом шаге нужна дата. */
  /**
   * Клиент шлёт это при загрузке панели и на каждое изменение поля "Дата релиза" (см.
   * releasePanel.ts) — дёшево: просто сверяет введённую дату с уже загруженным this.fullBranches
   * (без нового git-вызова), чтобы дизейблить "Создать релизную ветку", когда ветка с таким именем
   * уже существует (нет смысла создавать — нужно продолжать сборку уже имеющейся).
   */
  async onCheckReleaseDate(releaseDate: string): Promise<void> {
    if (!this.isActive()) return;
    if (!releaseDate) {
      this.panel.postReleaseDateCheck('', false);
      return;
    }
    const branchName = formatReleaseBranch(this.config.releaseBranchPattern, releaseDate);
    const exists = this.fullBranches.some((b) => b.name === branchName);
    this.panel.postReleaseDateCheck(branchName, exists);
  }

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
    if (!this.isActive()) return;
    this.panel.postPlan(this.plan);
  }

  /**
   * Единственный способ применения плана — "Начать сборку" (applyAll: всё подряд до первого
   * конфликта или до конца). Повторный клик после конфликта сам продолжает с того же места, если
   * конфликт уже разрешён в рабочем каталоге (см. applyNextItem в executor.ts) — отдельных кнопок
   * "Следующий шаг"/"Продолжить после конфликта"/"Пропустить конфликтующий пункт" больше нет:
   * пошаговое применение только замедляло тот же самый механизм, а "пропустить" эквивалентно
   * "Отменить сборку" + снять чекбокс с пункта + запустить сборку снова.
   *
   * applyAll реально выполняет cherry-pick в репозитории — переключение на другой проект его НЕ
   * прерывает (наполовину применённая сборка релиза — гораздо хуже, чем просто не увидеть её
   * прогресс), поэтому здесь isActive() гасит только пост в панель на каждом шаге, а не сам цикл
   * применения.
   */
  async onStartAuto(): Promise<void> {
    if (!this.plan?.releaseBranch) throw new Error('Сначала создайте релизную ветку.');
    await applyAll(this.git, this.plan, (ev) => {
      this.persist();
      if (this.isActive()) this.panel.postProgress(ev);
    });
  }

  /** Аварийный выход: полностью отменяет незавершённый cherry-pick (git cherry-pick --abort). */
  async onAbortBuild(): Promise<void> {
    if (await this.git.isCherryPickInProgress()) {
      await this.git.cherryPickAbort();
    }
    await this.postCurrentBranch();
    if (!this.isActive()) return;
    this.panel.postError('');
  }

  /** Публикует уже полностью собранную релизную ветку в remote (git push -u). */
  async onPublishRelease(): Promise<void> {
    if (!this.plan?.releaseBranch) throw new Error('Сначала соберите релиз.');
    await this.git.pushBranch(this.config.remoteName, this.plan.releaseBranch);
    if (!this.isActive()) return;
    this.panel.postPublished();
  }
}
