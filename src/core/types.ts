export interface ReleaseConfig {
  mainBranch: string;
  /** Ветка, от которой создаются feature-ветки (dev/develop) — используется как база для вычисления "своих" коммитов ветки, а не mainBranch, т.к. main может сильно отставать от dev */
  devBranch: string;
  remoteName: string;
  releaseBranchPattern: string;
  repositoryPath: string;
  branchListLimit: number;
  /** Префиксы веток, которые не являются задачами (qa, revert-pr-, chore/ и т.п.) — исключаются из поиска зависимостей */
  nonTaskBranchPrefixes: string[];
  /** Скрывать remote-tracking ветку из списка, если для неё есть локальная пара с тем же именем (иначе почти все ветки показываются дважды) */
  hideDuplicateRemoteBranches: boolean;
  /**
   * Сколько последних релизных веток (по шаблону releaseBranchPattern) считать "окном" для поиска
   * забытых/не выбранных веток (см. StaleBranchHint, findStaleUnmergedBranches в planner.ts) —
   * дата самой старой из них становится верхней границей поиска (--until), наравне с датой самой
   * ранней выбранной в текущей хронологии ветки (берётся более ПОЗДНЯЯ из двух — иначе окно поиска
   * сужалось бы, а не расширялось). Меняется прямо в блоке
   * "Забытые ветки" панели сборки релиза; изменение применяется со следующего построения
   * хронологии, а не мгновенно (сам список уже построен и переопределять его на лету незачем).
   */
  staleBranchesLookbackReleases: number;
  /**
   * Базовый URL задачи в таск-трекере, без ключа задачи — ключ добавляется через "/" (например,
   * для Jira это https://your-company.atlassian.net/browse; подойдёт любой трекер, где страница
   * задачи открывается по адресу вида "базовый-url/КЛЮЧ-ЗАДАЧИ").
   */
  taskTrackerBaseUrl: string;
  /** Workspace (организация) в Bitbucket */
  bitbucketWorkspace: string;
  /** Имя репозитория в Bitbucket */
  bitbucketRepoSlug: string;
}

/**
 * Сохранённый профиль проекта — полный набор настроек (ReleaseConfig) плюс имя и стабильный id,
 * привязанные к КОНКРЕТНОМУ репозиторию (repositoryPath здесь обязателен, не может быть пустым и
 * упасть на workspace, как в основном конфиге — профиль должен работать независимо от того, какой
 * workspace сейчас открыт). Хранится массивом в qvarhRelease.projects — так можно держать
 * настройки сразу нескольких репозиториев и запускать сборку релиза для любого из них одним
 * кликом, не переключая открытый в VS Code workspace и не трогая единственный "текущий" конфиг.
 */
export interface ProjectProfile extends ReleaseConfig {
  id: string;
  name: string;
}

/**
 * 'full' — ВСЕ коммиты ветки (относительно dev) уже есть в main по patch-id; 'none' — ни один.
 * Сервер вычисляет только эти два значения дёшево (по patch-id последнего коммита ветки —
 * см. session.ts sendBranchSlice). 'partial' (часть коммитов уже в main, часть ещё нет — например,
 * задачу довыполняли уже после того, как первую половину отпустили в отдельном релизе) сервер не
 * определяет проактивно для всего списка веток: это требует полного постатейного списка коммитов
 * КАЖДОЙ ветки, а не только последнего (лишний git log + patch-id на каждую из сотен веток —
 * слишком дорого для списка, который должен обновляться быстро). Панель уточняет статус до
 * 'partial' на клиенте, когда пользователь разворачивает коммиты конкретной ветки (там уже точный
 * список с patch-id на каждый коммит, без дополнительных git-вызовов).
 */
export type MainStatus = 'none' | 'partial' | 'full';

export interface BranchRef {
  /** Полное имя ref'а, например origin/feature/PROJ-1234 или feature/PROJ-1234 (для локальных) */
  ref: string;
  /** Короткое имя без remote-префикса */
  name: string;
  isRemote: boolean;
  lastCommitSha: string;
  lastCommitDate: string;
  lastCommitAuthor: string;
  lastCommitSubject: string;
  /** См. MainStatus. Сервер присылает только 'none'/'full' (по последнему коммиту ветки) — 'partial' появляется на клиенте после разворачивания коммитов ветки. */
  mainStatus: MainStatus;
  /** Номер PR в Bitbucket, если ветка уже была смёржена в dev (распарсен из subject merge-коммита); null, если ещё не мёржилась */
  prNumber: number | null;
  /** Ссылка на задачу в Jira, вычисленная из ключа в имени ветки; null, если ключ не найден */
  taskUrl: string | null;
  /** Ссылка на PR в Bitbucket (из prNumber); null, если ветка ещё не мёржилась */
  prUrl: string | null;
  /** Ссылка на коммит в Bitbucket */
  commitUrl: string | null;
}

export interface CommitInfo {
  sha: string;
  parents: string[];
  subject: string;
  authorDate: string;
  authorName: string;
  /** Этот конкретный коммит уже есть в основной ветке (уже выпущен) */
  alreadyInMain: boolean;
  /** Ссылка на задачу в таск-трекере, вычисленная из subject коммита (и, если применимо, имени ветки); null, если ключ не найден */
  taskUrl: string | null;
  /** Ссылка на коммит в Bitbucket */
  commitUrl: string | null;
}

/** CommitInfo + число добавленных/удалённых строк (см. GitService.diffStat) — только для превью коммитов ветки в списке (см. getBranchCommits в planner.ts), а не для CommitInfo в целом: контекстных/якорных коммитов хронологии на каждом построении плана и так много, лишний git-вызов на каждый был бы заметно дороже, а для них diffstat никто не просил. */
export interface BranchCommitInfo extends CommitInfo {
  insertions: number;
  deletions: number;
}

/**
 * Агрегированные +/- и число затронутых файлов по ВСЕМ собственным коммитам ветки сразу (см.
 * computeMainStatusForBranches в planner.ts) — приближённая сводка для строки в списке веток, без
 * разворачивания коммитов. Один git diff --numstat между первым родителем самого раннего
 * собственного коммита и кончиком ветки (а не сумма diffStat по каждому коммиту отдельно) — так
 * файлы, тронутые в нескольких коммитах подряд, считаются один раз, а не по числу коммитов.
 */
export interface BranchDiffStat {
  insertions: number;
  deletions: number;
  filesChanged: number;
}

/**
 * 'empty' — содержимое коммита УЖЕ полностью присутствует в основной ветке (пустой cherry-pick, см.
 * GitService.cherryPickIntegrationCommit) — это не конфликт и не обычное применение, а подтверждённый
 * на 100% (реальным git, не эвристикой) факт "уже выпущено".
 *
 * 'conditional' — коммит вообще не проверялся реальным cherry-pick в этом прогоне: он трогает
 * файл(ы), которые уже трогает более ранний, ЕЩЁ НЕ разрешённый конфликт ДРУГОЙ, независимой ветки
 * (см. performDryRun в dryRun.ts) — итоговое содержимое этих файлов зависит от того, как вы реально
 * разрешите тот конфликт, поэтому пробовать сейчас означало бы гадать. В отличие от 'conflict' — это
 * не подтверждённый git'ом факт, а честная неопределённость ("может быть, а может и не быть — не
 * проверялось").
 *
 * 'untested' — помимо старого смысла ("коммит не входит в план/dry-run вообще не запускался"),
 * performDryRun использует его и для коммита, который трогает файл(ы) более раннего неразрешённого
 * конфликта ТОЙ ЖЕ ветки (в отличие от 'conditional' — там ветка другая, независимая): несколько
 * своих коммитов одной ветки — это непрерывная, последовательная история, как при rebase, где
 * разрешение первого конфликта обычно "тянет" за собой чистое применение следующих коммитов той же
 * цепочки. Реального независимого риска здесь нет, поэтому не 'conditional' — но и подтвердить
 * git'ом нечем (worktree после abort не содержит изменений этого файла), поэтому не 'ok'.
 */
export type DryRunStatus = 'untested' | 'ok' | 'conflict' | 'conditional' | 'empty';

/**
 * Коммит с ДРУГОЙ, ещё не выбранной в релиз ветки, который тоже меняет файл, вызвавший конфликт,
 * и ещё не выпущен в main — то есть вероятная настоящая причина конфликта: не противоречащие
 * правки, а просто забытая задача, которую нужно добавить в хронологию ПЕРЕД проблемным коммитом.
 * См. findConflictCauses в planner.ts.
 */
export interface ConflictCause {
  sha: string;
  subject: string;
  authorName: string;
  authorDate: string;
  /** Короткое имя ветки-кандидата (без remote-префикса) */
  branch: string;
  /** Ref в формате refname:short (например, origin/feature/PROJ-1234) — то же значение, что и BranchRef.ref, чтобы можно было напрямую отметить эту ветку выбранной (см. StaleBranchHint/"Добавить в релиз" в releasePanel.ts), не разыскивая её заново по имени. */
  ref: string;
  /** Ссылка на задачу в таск-трекере, вычисленная из ключа в имени ветки/subject коммита; null, если ключ не найден или трекер не настроен */
  taskUrl: string | null;
  commitUrl: string | null;
}

/**
 * "Та же задача, но другой коммит" — на dev нашёлся коммит с тем же ключом задачи (см.
 * extractTaskKey), что и у коммита, которому git blame приписывает КОНКРЕТНЫЕ конфликтующие
 * строки на основной ветке (см. GitService.analyzeConflictSource) — другой sha, другое дерево, но,
 * возможно, тот же смысл. Типичная причина — не "забытая ветка" (см. ConflictCause) и не случайное
 * пересечение правок, а исторический артефакт: когда-то при подготовке релиза здесь уже был
 * конфликт, и вместо мержа его решили отдельным, самостоятельным коммитом — dev и main с тех пор
 * физически расходятся по истории этого места, хотя результат мог остаться тем же.
 *
 * contentMatch показывает, действительно ли сошёлся РЕЗУЛЬТАТ (не идентичность коммитов, а
 * итоговое содержимое файла на момент каждого из двух коммитов, см. git diff -w):
 * - 'identical' — файлы побайтово совпадают;
 * - 'near-identical' — отличия только в пробелах/пустых строках (git diff -w между ними пуст);
 * - 'different' — реальные отличия остаются, возможно разное поведение — разрешать вручную.
 */
export interface TaskDivergence {
  taskKey: string;
  contentMatch: 'identical' | 'near-identical' | 'different';
  otherSha: string;
  otherSubject: string;
  otherAuthorName: string;
  otherAuthorDate: string;
  otherCommitUrl: string | null;
}

/**
 * Сырой текст одного блока конфликта — "наша" версия (main/baseRef, между `<<<<<<<` и `=======`)
 * и "их" версия (входящий коммит, между `=======` и `>>>>>>>`), взятые прямо из файла worktree
 * ДО abort (см. GitService.parseConflictBlocks) — не escapeHtml'нутые, этим занимается клиент.
 * sameContent — true, если после нормализации пробелов/пустых строк обе версии совпадают: это
 * не текстовое различие, а несовпадение КОНТЕКСТА 3-way merge (например, вокруг успела сдвинуться
 * пустая строка) — можно спокойно принять любую сторону при разрешении, не разбираясь в смысле.
 */
export interface ConflictHunk {
  oursText: string[];
  theirsText: string[];
  sameContent: boolean;
  /** Номер первой строки oursText в baseRef; null, если сторона пуста (коммит удаляет содержимое) или найти не удалось. */
  oursStartLine: number | null;
  /** Номер первой строки theirsText в самом конфликтующем коммите; null по той же причине. */
  theirsStartLine: number | null;
}

/**
 * Реальный (не эвристический) источник dry-run конфликта по одному файлу — коммит, которому git
 * blame приписывает КОНКРЕТНЫЕ строки, оказавшиеся в конфликте (не "последний коммит, менявший
 * файл вообще" — тот мог трогать совершенно другое место того же файла и вводить в заблуждение,
 * см. GitService.analyzeConflictSource). sha — null, если файл в истории не найден (например, сам
 * конфликтующий коммит его создаёт) или конфликт нетекстовый (бинарный файл).
 */
export interface ConflictSource {
  file: string;
  sha: string | null;
  subject: string | null;
  authorName: string | null;
  authorDate: string | null;
  /** Ссылка на коммит в Bitbucket; null, если Bitbucket не настроен или sha отсутствует */
  commitUrl: string | null;
  /** См. ConflictHunk. Пустой массив — маркеры конфликта не удалось распарсить (бинарный файл и т.п.). */
  hunks: ConflictHunk[];
  /** См. TaskDivergence. null — либо в subject не нашлось ключа задачи, либо на dev не нашлось коммита с тем же ключом. */
  taskDivergence: TaskDivergence | null;
  /**
   * Ветки-кандидаты (см. ConflictCause), которые тоже трогают этот файл и ещё не в main — вероятная
   * настоящая причина конфликта, а не противоречащие правки. Заполняется только когда сам
   * конфликтующий коммит НЕ отмечен как alreadyInMain (для него более простая подсказка — см.
   * PlanItem.alreadyInMain — просто исключить его из релиза). Пустой массив — кандидатов не нашлось,
   * конфликт, вероятно, придётся разрешать вручную.
   */
  possibleCauses: ConflictCause[];
}

export interface PlanItem extends CommitInfo {
  branch: string;
  files: string[];
  /** Число добавленных/удалённых строк (git diff --numstat к первому родителю) — для заливки на графе, см. drawRail в releasePanel.ts. Бинарные файлы не учитываются (git показывает "-" вместо числа). */
  insertions: number;
  deletions: number;
  included: boolean;
  applied: boolean;
  /** sha других включённых коммитов (с других веток), которые правят те же файлы */
  overlapsWith: string[];
  dryRunStatus: DryRunStatus;
  dryRunConflictFiles: string[];
  /** Реальный источник конфликта на каждый файл из dryRunConflictFiles — см. ConflictSource */
  dryRunConflictSources: ConflictSource[];
  /** Номер PR в Bitbucket, в котором ветка этого коммита была смёржена в dev; null, если ещё не мёржилась */
  prNumber: number | null;
  /** Ссылка на задачу в таск-трекере, вычисленная из ключа в имени ветки/subject коммита; null, если ключ не найден */
  taskUrl: string | null;
  /** Ссылка на PR в Bitbucket (из prNumber); null, если ветка ещё не мёржилась */
  prUrl: string | null;
  /** Ссылка на коммит в Bitbucket */
  commitUrl: string | null;
}

export interface ReleasePlan {
  releaseBranch: string;
  mainBranch: string;
  items: PlanItem[];
  /** "Фоновые" коммиты dev-ветки между самым старым и самым новым коммитом хронологии — для общей картины, не для cherry-pick. */
  contextCommits: CommitInfo[];
  contextCommitsTruncated: boolean;
  /**
   * Последний коммит dev-ветки СТРОГО до начала хронологии (по дате самого раннего коммита среди
   * items) — для наглядности ("что было в dev прямо перед этим"), не для cherry-pick. Показывается
   * в том же стиле, что и contextCommits, и скрывается тем же переключателем. null, если у плана нет
   * ни одного коммита или такой коммит не нашёлся (например, hitDevBoundary никогда не встречался).
   */
  anchorCommit: CommitInfo | null;
  /**
   * ВСЕ реальные коммиты слияния КАЖДОЙ ветки из items обратно в dev, которые реально включают один
   * из "своих" коммитов этой ветки — определяется по ТОПОЛОГИИ (родители merge-коммита, см.
   * GitService.listMergeEvents/session.ts applyMergeEvents), а не по имени ветки или тексту
   * subject: это гарантия git, а не соглашение конкретного хостинга/языка интерфейса, поэтому
   * находит слияние независимо от того, кто и как его сделал (Bitbucket на любом языке, GitHub,
   * GitLab, обычный `git merge`). Отсутствует в объекте, если ветка ещё не мержилась ЛИБО была
   * мержена squash'ем (тогда результат — обычный коммит с одним родителем, топология этого не
   * ловит — известное ограничение, не баг). Обычно один элемент, но ветка может быть смёржена
   * НЕСКОЛЬКО РАЗ за свою жизнь (часть коммитов влита раньше отдельным PR, часть — позже) — тогда
   * элементов больше одного, отсортированы по возрастанию даты. Нужен дорожке веток слева от
   * хронологии (releasePanel.ts), чтобы НАДЁЖНО показать точки слияния — раньше она пыталась
   * угадать их, разбирая subject уже загруженных "контекстных" коммитов dev, а тот же коммит не
   * гарантированно там присутствует (окно дат между items, MAX_CONTEXT_COMMITS, свёрнутый список)
   * — из-за чего влитые ветки визуально выглядели "ещё не влитыми". Здесь же — тот самый
   * git-запрос, которым и так считается item.prNumber, поэтому дополнительных вызовов не требует.
   */
  mergeEventsByBranch: Record<string, MergeEventInfo[]>;
}

/** Сам merge-коммит PR, которым ветка влилась обратно в dev — см. ReleasePlan.mergeEventsByBranch. */
export interface MergeEventInfo {
  sha: string;
  subject: string;
  authorDate: string;
  authorName: string;
  /** Best-effort (см. GitService.extractPrNumber) — null, если subject не подошёл ни под один известный формат хостинга/языка; на сам факт слияния не влияет. */
  prNumber: number | null;
  taskUrl: string | null;
  prUrl: string | null;
  commitUrl: string | null;
}

/**
 * Ветка, которая ещё не выпущена в main и либо (а) отсоединилась от dev РАНЬШЕ самой ранней
 * выбранной в хронологии ветки, либо (б) просто не отмечена чекбоксом в текущей выборке и не
 * трогалась дольше "окна" последних N релизов (см. staleBranchesLookbackReleases в конфиге) —
 * в обоих случаях подсказка одна: "возможно, где-то есть забытая, давно не трогаемая задача"
 * (см. findStaleUnmergedBranches в planner.ts). Считается автоматически после каждой пересборки
 * хронологии — широкий скан по всему репозиторию, поэтому не блокирует её показ (см. postStaleBranchesLoading).
 */
export interface StaleBranchHint {
  branch: string;
  /** См. ConflictCause.ref — тот же формат refname:short, что и BranchRef.ref. */
  ref: string;
  sha: string;
  subject: string;
  authorDate: string;
  authorName: string;
  taskUrl: string | null;
  commitUrl: string | null;
}

export interface DryRunResult {
  sha: string;
  status: 'ok' | 'conflict' | 'conditional' | 'empty' | 'untested';
  /**
   * Для 'conflict' — реально конфликтующие файлы (из git-маркеров). Для 'conditional' — файлы,
   * из-за пересечения с которыми коммит не пробовался: они уже трогает более ранний неразрешённый
   * конфликт этого прогона (см. DryRunStatus). Для остальных статусов — пустой массив.
   */
  conflictFiles: string[];
  /** Всегда пустой массив для 'conditional' — реальный cherry-pick не запускался, анализировать нечего. */
  conflictSources: ConflictSource[];
}
