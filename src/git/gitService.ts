import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import simpleGit, { SimpleGit } from 'simple-git';
import { BranchRef } from '../core/types';

/** Единый формат ключа для buildMainSubjectDateIndex — используется и при построении индекса, и при поиске по нему (см. planner.ts). */
export function mainSubjectDateKey(subject: string, authorDate: string): string {
  return `${subject} ${authorDate}`;
}

export interface FirstParentCommit {
  sha: string;
  parents: string[];
  subject: string;
  authorDate: string;
  authorName: string;
}

/** Сам merge-коммит PR (см. GitService.listMergeEvents) — sha этого конкретного коммита слияния, а не какого-либо коммита ветки. */
export interface MergeEventDetails {
  sha: string;
  /** Родители merge-коммита — обычный (не octopus) merge всегда содержит tip слитой ветки среди них; используется, чтобы понять, какие именно "свои" коммиты ветки реально вошли в это конкретное слияние (см. applyMergeEvents в session.ts) — топология, а не текст subject. */
  parents: string[];
  subject: string;
  authorDate: string;
  authorName: string;
  /** Best-effort — только для бейджа/ссылки на PR, НЕ участвует в определении самого факта слияния (см. extractPrNumber). null, если subject не совпал ни с одним известным форматом хостинга/языка. */
  prNumber: number | null;
}

/**
 * Известные форматы subject merge-коммита, из которых можно вытащить номер PR/MR — ЛУЧШЕЕ, ЧТО
 * ПОЛУЧИЛОСЬ (best-effort), а не источник истины: сам факт слияния определяется топологией
 * (см. listMergeEvents), этот список только украшает найденное слияние ссылкой на PR, если
 * получится. Список неполный по конструкции — новый хостинг/язык интерфейса просто не даст
 * бейджа с номером PR, но слияние всё равно найдётся и линия на графе всё равно нарисуется.
 */
const PR_NUMBER_PATTERNS: RegExp[] = [
  /\(pull request #(\d+)\)/i, // Bitbucket (EN): Merged in X (pull request #42)
  /\(pull-запрос #(\d+)\)/i, // Bitbucket (RU): Объединено в X (pull-запрос #42)
  /^Merge pull request #(\d+) from/i, // GitHub: Merge pull request #42 from user/branch
  /!(\d+)$/, // GitLab merge request subject обычно кончается на "...!42"
];

function extractPrNumber(subject: string): number | null {
  const trimmed = subject.trim();
  for (const pattern of PR_NUMBER_PATTERNS) {
    const match = pattern.exec(trimmed);
    if (match) return Number(match[1]);
  }
  return null;
}

/**
 * Сколько SHA передавать одним вызовом git в computePatchIdsForCommits. На Windows суммарная
 * длина аргументов процесса ограничена (`CreateProcess`, обычно ~32К символов) — при полном
 * списке коммитов из сотен веток разом (каждый SHA — 40 символов) один вызов на всё сразу мог
 * упереться в этот лимит (`spawn ENAMETOOLONG`). 200 SHA — это ~8200 символов, с большим запасом.
 */
const PATCH_ID_CHUNK_SIZE = 200;

/**
 * Насколько глубоко обходим назад собственную first-parent историю релизной ветки в поисках
 * границы с предыдущим релизом (см. resolveReleaseBranchBaseRef) — запас на случай, если несколько
 * релизов подряд ушли в main fast-forward'ом без единого merge-коммита между ними.
 */
const RELEASE_BRANCH_FF_BOUNDARY_WALK_CAP = 2000;

export class GitConflictError extends Error {
  constructor(message: string, public readonly sha: string) {
    super(message);
  }
}

export class GitService {
  private readonly git: SimpleGit;
  private readonly repoPath: string;

  constructor(repoPath: string) {
    this.repoPath = repoPath;
    // idle-таймаут: если git-процесс завис (например, ждёт ввод в неинтерактивном контексте
    // расширения — креды, GPG, подтверждение) и не пишет ничего в stdout/stderr, принудительно
    // завершаем его вместо того, чтобы промис зависал навсегда.
    //
    // 25 секунд оказалось МАЛО для некоторых легитимных (не зависших, а просто медленных) операций
    // на старых/крупных ветках — например, релизная ветка часто содержит cherry-pick'и множества
    // задач с ОЧЕНЬ старыми исходными датами автора, из-за чего просмотр "уже в main"
    // (buildMainSubjectDateIndex/computePatchIdIndex) вынужден проходить по большому куску истории
    // main — на Windows это подтверждённо упиралось в 25с и падало с "block timeout reached", хотя
    // git продолжал реально работать, просто медленно. 2 минуты — с большим запасом на такие
    // случаи, но всё ещё конечное время, чтобы не зависнуть навсегда при действительно зависшем процессе.
    this.git = simpleGit(repoPath, { timeout: { block: 120000 } });
  }

  /**
   * Запускает git-процесс, опционально скармливая ему stdout ДРУГОГО процесса на stdin (для
   * пайпов вроде `git log -p | git patch-id`). Принимает сам исходный процесс (а не только его
   * stdout-поток), чтобы поймать и его собственную ошибку спавна — например, `ENAMETOOLONG` при
   * слишком длинном списке аргументов (актуально для computePatchIdsForCommits: без этого такая
   * ошибка "исходного" процесса нигде не перехватывалась и падала как uncaught 'error' на его
   * ChildProcess, а не как штатный отказ). Любая ошибка спавна (исходного или самого этого
   * процесса) трактуется так же, как ненулевой код выхода — вызывающий код уже умеет с этим
   * работать (возвращает пустой результат), никакого дополнительного отказоустойчивого кода не
   * потребовалось.
   */
  private spawnCapture(args: string[], sourceProc?: ChildProcessWithoutNullStreams): Promise<{ stdout: string; code: number }> {
    return new Promise((resolve) => {
      const proc = spawn('git', args, { cwd: this.repoPath });
      let stdout = '';
      let settled = false;
      const settle = (result: { stdout: string; code: number }) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      proc.stdout.on('data', (d) => {
        stdout += d;
      });
      proc.stderr.on('data', () => {
        // намеренно игнорируем — ошибки git-процесса не показываем пользователю напрямую, вызывающий код обрабатывает пустой результат
      });
      if (sourceProc) {
        sourceProc.stdout.pipe(proc.stdin);
        sourceProc.on('error', () => settle({ stdout, code: 1 }));
      } else {
        proc.stdin.end();
      }
      proc.on('error', () => settle({ stdout, code: 1 }));
      proc.on('close', (code) => settle({ stdout, code: code ?? 0 }));
    });
  }

  /**
   * Индекс "patch-id (подпись содержимого диффа) → sha" для ПОЛНОЙ истории ref'а (БЕЗ
   * --first-parent). В отличие от простого SHA-based сравнения (isAncestor), устойчив к
   * cherry-pick: задача попадает в main не напрямую, а через релизную ветку, и cherry-pick
   * создаёт НОВЫЙ commit с другим SHA, но с тем же содержимым диффа — patch-id у них совпадает.
   *
   * ВАЖНО: здесь нельзя использовать --first-parent (в отличие от buildMergeParentIndex, у
   * которого другая задача). Реальные коммиты задачи попадают в main как ВТОРОЙ родитель
   * merge-коммита (сама задача была на релизной ветке) — --first-parent-обход main видит только
   * сам merge-коммит и коммиты, сделанные непосредственно на main, и полностью пропускает диффы
   * коммитов внутри смёрженных веток. Это подтверждено на реальном репозитории: коммит
   * 9497dd588 (второй родитель merge-коммита main) отсутствовал в --first-parent индексе (size 3),
   * но появляется в полном логе (size 36) — отсюда ложное "не уже в main" для реально
   * зашипленных коммитов. Ложных срабатываний от полного обхода не возникает: это просто
   * каталог "какие диффы когда-либо попадали в main", а не отслеживание fork-point/ancestry.
   *
   * `sinceIso` ограничивает объём истории: cherry-pick сохраняет исходную дату автора коммита,
   * поэтому копия не может появиться в main раньше, чем был написан оригинал.
   */
  async computePatchIdIndex(ref: string, sinceIso?: string): Promise<Map<string, string>> {
    const logArgs = ['log', '-p'];
    if (sinceIso) {
      logArgs.push(`--since=${sinceIso}`);
    }
    logArgs.push(ref);

    const logProc = spawn('git', logArgs, { cwd: this.repoPath });
    const { stdout, code } = await this.spawnCapture(['patch-id', '--stable'], logProc);
    if (code !== 0) {
      return new Map();
    }

    const index = new Map<string, string>();
    for (const line of stdout.split('\n')) {
      const [patchId, sha] = line.trim().split(/\s+/);
      if (patchId && sha) {
        index.set(patchId, sha);
      }
    }
    return index;
  }

  /**
   * Индекс "subject коммита + дата автора → sha" по ПОЛНОЙ истории ref'а (те же причины не
   * использовать --first-parent, что и у computePatchIdIndex) — ДОПОЛНЕНИЕ к patch-id-сравнению
   * для случая, когда patch-id не совпал, хотя коммит по сути тот же самый. patch-id хэширует
   * содержимое диффа ЦЕЛИКОМ, включая неизменённые строки-контекст вокруг правки — если между
   * исходной веткой и релизной/main соседние (не относящиеся к этому коммиту) строки файла успели
   * разъехаться из-за ДРУГИХ правок, patch-id перестаёт совпадать, хотя сам коммит объективно уже
   * выпущен. cherry-pick/rebase при этом ВСЕГДА сохраняет исходную дату автора — пара
   * (subject, authorDate) поэтому почти такой же надёжный отпечаток оригинального коммита, как
   * patch-id, но не чувствителен к дрейфу окружающего контекста. Вызов дешёвый (без диффов —
   * только метаданные), поэтому не жалко делать его всегда рядом с patch-id индексом.
   */
  async buildMainSubjectDateIndex(ref: string, sinceIso?: string): Promise<Map<string, string>> {
    const args = ['log', '--pretty=%H%x1f%s%x1f%aI'];
    if (sinceIso) {
      args.push(`--since=${sinceIso}`);
    }
    args.push(ref);

    const raw = await this.git.raw(args);
    const index = new Map<string, string>();
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const [sha, subject, authorDate] = trimmed.split('\x1f');
      if (!sha || !subject || !authorDate) continue;
      const key = mainSubjectDateKey(subject, authorDate);
      if (!index.has(key)) {
        index.set(key, sha);
      }
    }
    return index;
  }

  /**
   * patch-id для НЕСКОЛЬКИХ конкретных коммитов ОДНИМ вызовом (`git log --no-walk -p sha1 sha2
   * ...` вместо N отдельных диффов) — та же "подпись", что и в computePatchIdIndex, для прямого
   * сравнения. Возвращает sha → patchId; коммиты, для которых patch-id не удалось получить,
   * в карте отсутствуют.
   *
   * Список бьётся на пачки по PATCH_ID_CHUNK_SIZE — при сотнях-тысячах SHA (много веток разом
   * в списке + у части из них по многу собственных коммитов) один-единственный вызов может
   * превысить лимит длины командной строки ОС (на Windows это `spawn ENAMETOOLONG`). Несколько
   * более коротких вызовов параллельно работают эквивалентно одному большому — `--no-walk`
   * показывает диффы каждого коммита независимо друг от друга.
   */
  async computePatchIdsForCommits(shas: string[]): Promise<Map<string, string>> {
    if (shas.length === 0) {
      return new Map();
    }
    const chunks: string[][] = [];
    for (let i = 0; i < shas.length; i += PATCH_ID_CHUNK_SIZE) {
      chunks.push(shas.slice(i, i + PATCH_ID_CHUNK_SIZE));
    }
    const chunkResults = await Promise.all(chunks.map((chunk) => this.computePatchIdsForCommitsChunk(chunk)));
    const bySha = new Map<string, string>();
    for (const chunkResult of chunkResults) {
      for (const [sha, patchId] of chunkResult) {
        bySha.set(sha, patchId);
      }
    }
    return bySha;
  }

  private async computePatchIdsForCommitsChunk(shas: string[]): Promise<Map<string, string>> {
    const logProc = spawn('git', ['log', '--no-walk', '-p', ...shas], { cwd: this.repoPath });
    const { stdout, code } = await this.spawnCapture(['patch-id', '--stable'], logProc);
    if (code !== 0) {
      return new Map();
    }
    const bySha = new Map<string, string>();
    for (const line of stdout.split('\n')) {
      const [patchId, sha] = line.trim().split(/\s+/);
      if (patchId && sha) {
        bySha.set(sha, patchId);
      }
    }
    return bySha;
  }

  /**
   * patch-id ВСЕЙ ветки целиком как ОДНОГО объединённого диффа (baseSha..tipRef) — дополнение к
   * computePatchIdsForCommits для случая, когда несколько коммитов ветки при сборке релиза
   * склеили (squash) в один коммит на релизной/основной ветке: по отдельности их patch-id не
   * совпадёт ни с чем, а объединённый — может.
   */
  async computeWholeDiffPatchId(baseSha: string, tipRef: string): Promise<string | null> {
    const diffProc = spawn('git', ['diff', baseSha, tipRef], { cwd: this.repoPath });
    const { stdout, code } = await this.spawnCapture(['patch-id', '--stable'], diffProc);
    if (code !== 0) {
      return null;
    }
    const [patchId] = stdout.trim().split(/\s+/);
    return patchId || null;
  }

  async assertRepo(): Promise<void> {
    const isRepo = await this.git.checkIsRepo();
    if (!isRepo) {
      throw new Error('Указанный путь не является git-репозиторием.');
    }
  }

  async assertClean(): Promise<void> {
    const status = await this.git.status();
    if (!status.isClean()) {
      throw new Error(
        'В рабочем каталоге есть незакоммиченные изменения. Закоммитьте, застэшьте или отмените их перед сборкой релиза.'
      );
    }
  }

  async resolveRef(ref: string): Promise<string> {
    return (await this.git.revparse([ref])).trim();
  }

  /** Дата автора конкретного коммита — используется, чтобы выбрать САМУЮ БЛИЖНЮЮ (свежую) из нескольких опорных точек ветвления (см. resolveBranchOwnCommits в planner.ts). */
  async commitAuthorDate(sha: string): Promise<string> {
    return (await this.git.raw(['log', '-1', '--pretty=%aI', sha])).trim();
  }

  async refExists(ref: string): Promise<boolean> {
    try {
      await this.git.revparse(['--verify', `${ref}^{commit}`]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * true, если ancestorRef реально находится в истории descendantRef (`git merge-base --is-ancestor`)
   * — дёшево (без диффов). Используется, чтобы отличить "релизная ветка уже полностью выпущена в
   * main" (см. loadReleaseBranchOwnCommits в session.ts) от "релизная ветка ещё пустая, просто
   * ничего пока не собрано" — в обоих случаях releaseBranchOwnCommits(releaseBranch, mainRef)
   * одинаково вернёт 0 коммитов, но причины принципиально разные.
   */
  async isAncestor(ancestorRef: string, descendantRef: string): Promise<boolean> {
    try {
      await this.git.raw(['merge-base', '--is-ancestor', ancestorRef, descendantRef]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * git merge-base завершается кодом 1 и пустым выводом (без сообщения об ошибке), если у веток
   * нет общего предка — simple-git в этом случае не бросает исключение, а тихо возвращает ''.
   * Это опасно: диапазон `${''}..${ref}` git интерпретирует как `HEAD..ref`, что может утянуть
   * всю историю ветки, включая корневой коммит без родителя. Поэтому бросаем понятную ошибку сами.
   */
  async mergeBase(a: string, b: string): Promise<string> {
    const result = (await this.git.raw(['merge-base', a, b])).trim();
    if (!result) {
      throw new Error(`У веток ${a} и ${b} нет общего предка (не связаны общей историей).`);
    }
    return result;
  }

  /**
   * Множество SHA всей FIRST-PARENT истории ref'а (например, devRef) — одним git-вызовом (только
   * hash'и, без диффов, поэтому дёшево даже на многотысячной истории). Это "эталон": commit,
   * входящий в это множество, гарантированно уже часть основной линии dev, а не чьей-то отдельной
   * ветки — используется в resolveBranchOwnCommits, чтобы найти, где история ветки СЛИВАЕТСЯ с
   * историей dev, независимо от того, сколько раз и как эту ветку в dev до этого вливали.
   */
  async buildDevFirstParentSet(ref: string): Promise<Set<string>> {
    const raw = await this.git.raw(['log', '--first-parent', '--pretty=%H', ref]);
    return new Set(raw.split('\n').map((l) => l.trim()).filter(Boolean));
  }

  /**
   * FIRST-PARENT история ref'а от его кончика вглубь, БЕЗ нижней границы (в отличие от
   * firstParentLog, которому нужен baseRef) — используется resolveBranchOwnCommits, чтобы пройти
   * собственную историю ветки назад и найти точку, где она упирается в dev (см. buildDevFirstParentSet).
   * `maxCount` — защита от аномально глубокого обхода (см. константу поиска точки ветвления в planner.ts).
   */
  async firstParentChain(ref: string, maxCount: number): Promise<{ commits: FirstParentCommit[]; truncated: boolean }> {
    const format = ['%H', '%P', '%s', '%aI', '%an'].join('%x1f');
    const args = ['log', '--first-parent', '--topo-order', `--max-count=${maxCount + 1}`, `--pretty=format:${format}%x1e`, ref];

    const raw = await this.git.raw(args);

    const entries = raw
      .split('\x1e')
      .map((e) => e.trim())
      .filter(Boolean);

    const truncated = entries.length > maxCount;
    const limited = truncated ? entries.slice(0, maxCount) : entries;

    const commits = limited.map((entry) => {
      const [sha, parents, subject, authorDate, authorName] = entry.split('\x1f');
      return {
        sha,
        parents: parents.split(' ').filter(Boolean),
        subject,
        authorDate,
        authorName,
      };
    });

    return { commits: commits.reverse(), truncated };
  }

  /**
   * Коммиты по конкретному файлу на ЛЮБОЙ ветке репозитория (`--all`), которые ещё НЕ являются
   * предками mainRef — то есть объективно ещё не выпущены. Используется для поиска вероятной
   * реальной причины dry-run конфликта на этом файле (см. findConflictCauses в planner.ts):
   * узкий, привязанный к одному файлу запрос, а не сканирование сотен веток целиком.
   *
   * `--source` в паре с `%S` в формате подставляет имя ref'а, через который git дошёл до коммита
   * при обходе `--all` — не всегда единственно верное "чьё" это коммит (одна и та же история
   * бывает видна одновременно с нескольких веток), но для узкой задачи "какая ветка ещё не влита
   * и трогает этот файл" этого достаточно.
   *
   * `--no-merges` — иначе в кандидаты попадают технические merge-коммиты (веток, обновлявшихся от
   * dev/main, или старые внутренние слияния release-веток) — у них нет своего осмысленного диффа,
   * поэтому patch-id/subject+date сравнение (см. filterGenuineCandidates в planner.ts) никогда не
   * находит для них совпадения в main, и такой merge-коммит ложно тянет за собой всю ветку в
   * "возможные причины конфликта", даже если её РЕАЛЬНЫЕ (не-merge) коммиты давно и корректно
   * распознаны как уже выпущенные (см. историю с hotfix/DOS-680 — merge-коммит `Merged in
   * release-2023-07-13 (pull request #534)` внутри её собственной истории выглядел как "ещё не в
   * main", хотя настоящий контент ветки — `[DOS-680] added mapping field names...` — там уже был).
   */
  async logCommitsNotInRefTouchingFile(
    mainRef: string,
    file: string,
    maxCount: number
  ): Promise<Array<{ sha: string; subject: string; authorDate: string; authorName: string; sourceRef: string }>> {
    const format = ['%H', '%s', '%aI', '%an', '%S'].join('%x1f');
    const raw = await this.git.raw([
      'log',
      '--all',
      '--not',
      mainRef,
      '--source',
      '--no-merges',
      `--max-count=${maxCount}`,
      `--pretty=format:${format}%x1e`,
      '--',
      file,
    ]);

    return raw
      .split('\x1e')
      .map((e) => e.trim())
      .filter(Boolean)
      .map((entry) => {
        const [sha, subject, authorDate, authorName, sourceRef] = entry.split('\x1f');
        return { sha, subject, authorDate, authorName, sourceRef };
      });
  }

  /**
   * То же самое, что и logCommitsNotInRefTouchingFile, но БЕЗ привязки к файлу — по всему
   * репозитории — и с отсечкой по дате автора коммита вместо этого. Используется для поиска веток,
   * отсоединившихся раньше самой ранней ветки в текущей хронологии и всё ещё не слитых обратно (см.
   * findStaleUnmergedBranches в planner.ts) — широкий скан по всему репозиторию.
   *
   * `--no-merges` — иначе в кандидаты попадают чисто технические merge-коммиты вида "Merge branch
   * 'dev' into feature/X" (кто-то подтягивал dev в свою ветку) или PR-merge коммит ЧУЖОЙ, давно
   * влитой ветки, случайно попавший в обзор через --source. У merge-коммита нет своего осмысленного
   * диффа, поэтому patch-id/subject+date сравнение (см. filterGenuineCandidates) никогда не
   * находит для него совпадения в dev — и он ложно остаётся "ещё не влитым", хотя реальный контент
   * ветки уже полностью там.
   */
  async logCommitsNotInRefBeforeDate(
    devRef: string,
    beforeDateIso: string,
    maxCount: number
  ): Promise<Array<{ sha: string; subject: string; authorDate: string; authorName: string; sourceRef: string }>> {
    const format = ['%H', '%s', '%aI', '%an', '%S'].join('%x1f');
    const raw = await this.git.raw([
      'log',
      '--all',
      '--not',
      devRef,
      '--source',
      '--no-merges',
      `--until=${beforeDateIso}`,
      `--max-count=${maxCount}`,
      `--pretty=format:${format}%x1e`,
    ]);

    return raw
      .split('\x1e')
      .map((e) => e.trim())
      .filter(Boolean)
      .map((entry) => {
        const [sha, subject, authorDate, authorName, sourceRef] = entry.split('\x1f');
        return { sha, subject, authorDate, authorName, sourceRef };
      });
  }

  /**
   * Индекс "sha родителя → ВСЕ merge-коммиты first-parent истории ref'а (обычно dev), где этот sha
   * — один из родителей" (sha/родители/тема/дата/автор/номер PR), построенный ОДНИМ git-вызовом
   * (`--merges` ограничивает выборку коммитами с 2+ родителями — иначе в подсчёт попали бы и
   * обычные коммиты dev).
   *
   * Раньше слияние искалось по СОВПАДЕНИЮ ИМЕНИ ВЕТКИ, разобранного из subject через regex вида
   * "Merged in X (pull request #N)" — жёстко привязано к формату ОДНОГО хостинга на ОДНОМ языке
   * интерфейса. Ломалось на: другом языке Bitbucket (найдено на реальном репозитории — русское
   * "Объединено в X (pull-запрос #N)", причём в ОДНОЙ истории вперемешку с английскими — локаль
   * аккаунта, смёржившего PR, могла меняться), GitHub ("Merge pull request #N from ..."), GitLab,
   * обычном `git merge` без хостинга вообще — да и в принципе НИКАКОЙ subject не мог бы поймать
   * squash-merge (там результат — обычный коммит с ОДНИМ родителем, до текста дело не доходит).
   *
   * Родители merge-коммита — это топология, а не текст: у обычного (не octopus, не squash) merge
   * один из родителей ВСЕГДА равен tip'у слитой ветки на момент слияния, независимо от хостинга,
   * языка интерфейса или того, кто вызвал `git merge` — это гарантия самого git, а не соглашение
   * Bitbucket. Индексируя по sha родителя, вызывающий код (см. applyMergeEvents в session.ts)
   * просто проверяет "есть ли среди родителей какой-нибудь ИЗ УЖЕ ИЗВЕСТНЫХ своих коммитов ветки"
   * — без единой попытки понять по subject'у, что вообще произошло.
   *
   * prNumber в каждом событии — best-effort (см. extractPrNumber), только для бейджа/ссылки, не
   * участвует в поиске самого слияния: если subject не подошёл ни под один известный формат,
   * просто null — слияние всё равно найдено и попадёт на график.
   *
   * Сам коммит слияния (а не только номер PR) нужен дорожке веток в хронологии (см. releasePanel.ts):
   * раньше она пыталась угадать точку слияния, разбирая subject уже загруженных "контекстных"
   * коммитов dev — ненадёжно, поскольку тот же коммит не гарантированно присутствует в контекстных
   * коммитах (окно дат, лимит, свёрнутый список). Здесь же — один и тот же авторитетный источник
   * для обеих задач.
   */
  async listMergeEvents(ref: string): Promise<Map<string, MergeEventDetails[]>> {
    const format = ['%H', '%P', '%s', '%aI', '%an'].join('%x1f');
    const raw = await this.git.raw(['log', '--first-parent', '--merges', `--pretty=format:${format}`, ref]);
    const byParentSha = new Map<string, MergeEventDetails[]>();
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      const [sha, parentsRaw, subject, authorDate, authorName] = line.split('\x1f');
      const parents = parentsRaw.split(' ').filter(Boolean);
      const event: MergeEventDetails = { sha, parents, subject, authorDate, authorName, prNumber: extractPrNumber(subject ?? '') };
      for (const parentSha of parents) {
        const list = byParentSha.get(parentSha) ?? [];
        list.push(event);
        byParentSha.set(parentSha, list);
      }
    }
    return byParentSha;
  }

  async branchExists(name: string): Promise<boolean> {
    const branches = await this.git.branch(['--list', name]);
    return Object.keys(branches.branches).length > 0;
  }

  async checkoutBranch(name: string): Promise<void> {
    await this.git.checkout(name);
  }

  /**
   * Обычный git pull для уже выбранной (текущей) ветки. Если у неё нет upstream-tracking (ветка
   * создана локально без --track, или потеряла привязку — например, то же "устаревшая локальная
   * ветка" из GitService.applyDuplicateBranchFilter в session.ts) — голый `git pull` без
   * аргументов отказывается работать вообще ("There is no tracking information for the current
   * branch"), хотя remote-ветка с ТЕМ ЖЕ именем скорее всего существует: иначе зачем бы
   * пользователь стоял на этой ветке и жал Pull. Проверяем upstream ЗАРАНЕЕ (через @{u}, а не
   * парсингом текста ошибки — он не зависит от локали git) и, если его нет, а remoteName/<ветка>
   * существует, настраиваем upstream на неё перед пуллом — ровно то же самое действие, которое
   * сама git и предлагает сделать вручную (`git branch --set-upstream-to=...`), просто
   * автоматически: имя совпадает однозначно, гадать здесь не о чём. Если подходящей remote-ветки
   * нет вовсе — просто пуллим как обычно и получаем настоящую (уже осмысленную) ошибку git.
   */
  async pull(remoteName: string): Promise<void> {
    const hasUpstream = await this.git
      .raw(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
      .then(() => true)
      .catch(() => false);
    if (!hasUpstream) {
      const branch = await this.currentBranch();
      const remoteRef = `${remoteName}/${branch}`;
      if (branch && (await this.refExists(remoteRef))) {
        await this.git.raw(['branch', `--set-upstream-to=${remoteRef}`, branch]);
      }
    }
    await this.git.pull();
  }

  /**
   * Создаёт релизную ветку от baseRef. Бросает исключение, если ветка уже существует.
   *
   * --no-track ОБЯЗАТЕЛЕН: baseRef обычно origin/<mainBranch> (см. session.ts resolveMainRef —
   * предпочитает remote-ветку как более свежую базу), а git при `checkout -b` от remote-ветки по
   * умолчанию (branch.autoSetupMerge=true) сам настраивает upstream-tracking новой ветки НА ЭТУ
   * remote-ветку. Без --no-track релизная ветка тихо начинала бы "отслеживать" main — встроенный
   * в VS Code Source Control тогда вместо "Опубликовать ветку" показывает "Синхронизировать
   * изменения" (раз upstream уже есть), и её нажатие пушит коммиты релизной ветки ПРЯМО в main на
   * remote — подтверждённый на реальном инциденте баг (см. changelog): пользователь думал, что
   * стоит на релизной ветке, а после "Синхронизировать" все её коммиты оказались в main/Bitbucket.
   */
  async createReleaseBranch(name: string, baseRef: string): Promise<void> {
    if (await this.branchExists(name)) {
      throw new Error(`Ветка ${name} уже существует. Используйте "продолжить сборку релиза", чтобы дособрать её.`);
    }
    await this.git.raw(['checkout', '-b', name, '--no-track', baseRef]);
  }

  /**
   * История first-parent от baseRef (исключая) до headRef (включая) — то есть ровно
   * последовательность точек интеграции PR в основную ветку, будь то merge-commit или squash.
   */
  /**
   * @param maxCount Ограничение числа коммитов (защита от аномально большого диапазона —
   *   например, если dev-ветка сильно отстала). При превышении возвращаются самые НОВЫЕ
   *   maxCount коммитов диапазона, а truncated=true.
   */
  async firstParentLog(
    baseRef: string,
    headRef: string,
    maxCount?: number
  ): Promise<{ commits: FirstParentCommit[]; truncated: boolean }> {
    const format = ['%H', '%P', '%s', '%aI', '%an'].join('%x1f');
    const args = ['log', '--first-parent', '--topo-order', `--pretty=format:${format}%x1e`];
    if (maxCount) {
      args.push(`--max-count=${maxCount + 1}`);
    }
    args.push(`${baseRef}..${headRef}`);

    const raw = await this.git.raw(args);

    const entries = raw
      .split('\x1e')
      .map((e) => e.trim())
      .filter(Boolean);

    const truncated = !!maxCount && entries.length > maxCount;
    const limited = truncated ? entries.slice(0, maxCount) : entries;

    const commits = limited.map((entry) => {
      const [sha, parents, subject, authorDate, authorName] = entry.split('\x1f');
      return {
        sha,
        parents: parents.split(' ').filter(Boolean),
        subject,
        authorDate,
        authorName,
      };
    });

    // git log выдаёт от новых к старым — разворачиваем в хронологический порядок интеграции
    return { commits: commits.reverse(), truncated };
  }

  /**
   * История first-parent ref'а (например, dev), ограниченная диапазоном ДАТ, а не коммитов —
   * используется для "контекстных" коммитов в хронологии (что ещё происходило в dev-ветке в это
   * же время, для общей картины, не для cherry-pick).
   */
  async firstParentLogByDateRange(
    ref: string,
    sinceIso: string,
    untilIso: string,
    maxCount?: number
  ): Promise<{ commits: FirstParentCommit[]; truncated: boolean }> {
    const format = ['%H', '%P', '%s', '%aI', '%an'].join('%x1f');
    const args = [
      'log',
      '--first-parent',
      '--topo-order',
      `--since=${sinceIso}`,
      `--until=${untilIso}`,
      `--pretty=format:${format}%x1e`,
    ];
    if (maxCount) {
      args.push(`--max-count=${maxCount + 1}`);
    }
    args.push(ref);

    const raw = await this.git.raw(args);

    const entries = raw
      .split('\x1e')
      .map((e) => e.trim())
      .filter(Boolean);

    const truncated = !!maxCount && entries.length > maxCount;
    const limited = truncated ? entries.slice(0, maxCount) : entries;

    const commits = limited.map((entry) => {
      const [sha, parents, subject, authorDate, authorName] = entry.split('\x1f');
      return {
        sha,
        parents: parents.split(' ').filter(Boolean),
        subject,
        authorDate,
        authorName,
      };
    });

    return { commits: commits.reverse(), truncated };
  }

  /**
   * Список веток: локальные (refs/heads) и remote-tracking (refs/remotes), без origin/HEAD,
   * с датой/автором/темой последнего коммита, отсортированный от свежих к старым (по дате
   * коммита в дереве — committerdate, отражает реальную активность в ветке).
   *
   * ВАЖНО: `lastCommitDate` берётся как AUTHOR date (`%(authordate)`), а не committer date —
   * это должно совпадать с тем, что используют остальные части кода (FirstParentCommit.authorDate,
   * mainSubjectDateKey и весь фолбэк "уже в main" по subject+дате в session.ts/planner.ts):
   * cherry-pick/rebase сохраняет author date оригинального коммита, но всегда переписывает
   * committer date на момент самого cherry-pick/rebase — используя committerdate здесь, сравнение
   * с main по (subject, дата) никогда бы не совпадало для перенесённых коммитов. Сортировка
   * списка при этом всё равно идёт по committerdate — для порядка "что свежее трогали" это
   * осмысленнее, только per-branch дата в самой карточке должна быть author date.
   */
  async listBranches(): Promise<BranchRef[]> {
    const format = ['%(refname:short)', '%(refname)', '%(objectname)', '%(authordate:iso-strict)', '%(authorname)', '%(subject)'].join(
      '%09'
    );
    const raw = await this.git.raw([
      'for-each-ref',
      `--format=${format}`,
      '--sort=-committerdate',
      'refs/heads',
      'refs/remotes',
    ]);

    const result: BranchRef[] = [];
    for (const line of raw.split('\n').map((l) => l.trim()).filter(Boolean)) {
      const [short, full, sha, date, author, subject] = line.split('\t');
      if (!short || !full || short.endsWith('/HEAD')) {
        continue;
      }
      const isRemote = full.startsWith('refs/remotes/');
      const name = isRemote ? short.slice(short.indexOf('/') + 1) : short;
      result.push({
        ref: short,
        name,
        isRemote,
        lastCommitSha: sha ?? '',
        lastCommitDate: date ?? '',
        lastCommitAuthor: author ?? '',
        lastCommitSubject: subject ?? '',
        // Дорого проверять для каждой ветки сразу (может быть тысяча веток) — заполняется
        // отдельно (mapWithConcurrency) только для среза, реально показанного в панели.
        mainStatus: 'none',
        // Аналогично: номер PR и ссылки проставляются отдельно (session.ts) только для среза.
        prNumber: null,
        taskUrl: null,
        prUrl: null,
        commitUrl: null,
      });
    }
    return result;
  }

  /** Создаёт временный worktree на указанном ref — используется для безопасного dry-run cherry-pick. */
  async addWorktree(path: string, ref: string): Promise<void> {
    await this.git.raw(['worktree', 'add', '--detach', path, ref]);
  }

  async removeWorktree(path: string): Promise<void> {
    try {
      await this.git.raw(['worktree', 'remove', '--force', path]);
    } catch {
      // каталог мог быть уже удалён вручную — не критично
    }
  }

  /** Убирает "осиротевшие" worktree-записи (например, если VS Code закрыли посреди dry-run). */
  async pruneWorktrees(): Promise<void> {
    try {
      await this.git.raw(['worktree', 'prune']);
    } catch {
      // не критично
    }
  }

  /** Файлы, изменённые коммитом относительно его первого родителя (единообразно для merge и обычных коммитов) */
  /**
   * Список файлов и построчная статистика (--numstat) одним вызовом — раньше список файлов и
   * статистика добавлений/удалений (для заливки на графе, см. drawRail в releasePanel.ts) были бы
   * двумя отдельными git-вызовами на каждый коммит; --numstat отдаёт оба сразу за ту же цену. У
   * бинарных файлов git пишет "-" вместо числа — такие строки не попадают в сумму insertions/deletions,
   * но файл всё равно учитывается в списке files.
   */
  async diffStat(sha: string, firstParentSha: string): Promise<{ files: string[]; insertions: number; deletions: number }> {
    const raw = await this.git.raw(['diff', '--numstat', firstParentSha, sha]);
    const files: string[] = [];
    let insertions = 0;
    let deletions = 0;
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const [ins, del, ...fileParts] = trimmed.split('\t');
      files.push(fileParts.join('\t'));
      if (ins !== '-') insertions += Number(ins);
      if (del !== '-') deletions += Number(del);
    }
    return { files, insertions, deletions };
  }

  async currentBranch(): Promise<string> {
    const status = await this.git.status();
    return status.current ?? '';
  }

  /**
   * Cherry-pick одного коммита интеграции. Для merge-коммитов (2+ родителя) используется -m 1.
   *
   * Возвращает 'applied' (обычный успешный cherry-pick) или 'empty' — ОСОБЫЙ случай, когда
   * содержимое коммита УЖЕ полностью присутствует в целевой ветке: git в этом случае тоже
   * завершается ненулевым кодом ("The previous cherry-pick is now empty..."), но это НЕ конфликт —
   * `git status` в этот момент показывает чистое дерево, БЕЗ единого конфликтующего файла
   * (проверено на реальном примере: cherry-pick уже-выпущенного коммита обратно на main). Раньше
   * это ошибочно трактовалось как обычный конфликт с ПУСТЫМ списком файлов ("конфликт (0
   * файлов)") — сбивающее с толку сообщение без единого файла для разрешения, а при реальном
   * (не dry-run) применении плана пользователь оказывался в незавершённом cherry-pick без единого
   * реального конфликта для разрешения. Различаем по наличию конфликтующих файлов: если их нет —
   * это точно пустой cherry-pick, а не какая-то другая причина неудачи (единственная другая частая
   * причина ненулевого кода — реальный конфликт — ВСЕГДА оставляет конфликтующие файлы). Пустой
   * cherry-pick завершаем сами (`--skip`), чтобы не оставлять репозиторий в подвешенном состоянии.
   */
  async cherryPickIntegrationCommit(commit: FirstParentCommit): Promise<'applied' | 'empty'> {
    try {
      if (commit.parents.length > 1) {
        await this.git.raw(['cherry-pick', '-m', '1', commit.sha]);
      } else {
        await this.git.raw(['cherry-pick', commit.sha]);
      }
      return 'applied';
    } catch (err) {
      const conflicted = await this.conflictedFiles();
      if (conflicted.length === 0) {
        await this.cherryPickSkip();
        return 'empty';
      }
      throw new GitConflictError(
        `Конфликт при cherry-pick коммита ${commit.sha.slice(0, 8)} ("${commit.subject}"). ` +
          'Разрешите конфликт в рабочем каталоге, затем продолжите сборку релиза.',
        commit.sha
      );
    }
  }

  /**
   * sha коммита, чей cherry-pick начат, но не завершён (--continue/--skip/--abort ещё не вызван) —
   * null, если сейчас такого нет. Надёжнее проверки "есть ли конфликтующие файлы": пользователь
   * может разрешить конфликт и застейджить файлы (git add), но последовательность cherry-pick при
   * этом всё ещё числится незавершённой, пока не выполнен --continue — на этом этапе конфликтующих
   * файлов уже 0, но CHERRY_PICK_HEAD ещё существует. Используется, чтобы применение следующего
   * пункта плана (см. applyNextItem в executor.ts) понимало "нужно продолжить именно ЭТУ, уже
   * начатую попытку (--continue)" вместо того, чтобы начинать новый cherry-pick с нуля.
   */
  async cherryPickHeadSha(): Promise<string | null> {
    try {
      const out = await this.git.raw(['rev-parse', '--verify', 'CHERRY_PICK_HEAD']);
      return out.trim() || null;
    } catch {
      return null;
    }
  }

  async isCherryPickInProgress(): Promise<boolean> {
    return (await this.cherryPickHeadSha()) !== null;
  }

  async conflictedFiles(): Promise<string[]> {
    const status = await this.git.status();
    return status.conflicted;
  }

  /**
   * Последний коммит, менявший конкретный файл в истории ref'а — используется сразу после
   * обнаружения dry-run конфликта (см. performDryRun), пока рабочий каталог worktree ещё в
   * состоянии "прямо перед конфликтом" (HEAD = main + всё, что уже успешно применено ранее в
   * этом же прогоне): это и есть настоящий, а не угаданный по эвристике, источник конфликта —
   * тот, кто последним трогал файл до попытки применить конфликтующий коммит. Возвращает null,
   * если файл в истории ref'а не встречается (например, файл только что создан этим коммитом).
   */
  async lastCommitTouchingFile(ref: string, file: string): Promise<FirstParentCommit | null> {
    const format = ['%H', '%P', '%s', '%aI', '%an'].join('%x1f');
    const raw = await this.git.raw(['log', '-1', `--pretty=format:${format}`, ref, '--', file]);
    const trimmed = raw.trim();
    if (!trimmed) {
      return null;
    }
    const [sha, parents, subject, authorDate, authorName] = trimmed.split('\x1f');
    return { sha, parents: parents.split(' ').filter(Boolean), subject, authorDate, authorName };
  }

  /**
   * Продолжает уже начатый (см. cherryPickHeadSha) cherry-pick того же коммита — пользователь тем
   * временем разрешил конфликт руками в рабочем каталоге. Та же обработка исходов, что и у
   * cherryPickIntegrationCommit: если после --continue конфликт всё ещё остаётся (разрешили не все
   * файлы) — не сырая git-ошибка, а тот же GitConflictError, с которым UI уже умеет работать
   * (см. applyNextItem в executor.ts).
   */
  async continueCherryPick(commit: FirstParentCommit): Promise<'applied' | 'empty'> {
    try {
      await this.git.raw(['cherry-pick', '--continue']);
      return 'applied';
    } catch (err) {
      const conflicted = await this.conflictedFiles();
      if (conflicted.length === 0) {
        await this.cherryPickSkip();
        return 'empty';
      }
      throw new GitConflictError(
        `Конфликт коммита ${commit.sha.slice(0, 8)} ("${commit.subject}") разрешён не полностью. ` +
          'Разрешите оставшиеся конфликты в рабочем каталоге и нажмите "Начать сборку" ещё раз.',
        commit.sha
      );
    }
  }

  async cherryPickAbort(): Promise<void> {
    await this.git.raw(['cherry-pick', '--abort']);
  }

  async cherryPickSkip(): Promise<void> {
    await this.git.raw(['cherry-pick', '--skip']);
  }

  /** Публикует релизную ветку в remote (с установкой upstream, -u) — обычный git push. */
  async pushBranch(remoteName: string, branchName: string): Promise<void> {
    await this.git.push(['-u', remoteName, branchName]);
  }

  /**
   * Собственные коммиты релизной ветки — всё, что в ней есть, а в mainRef (точнее — в состоянии
   * main НЕПОСРЕДСТВЕННО ПЕРЕД тем, как эта ветка в него влилась, см. resolveReleaseBranchBaseRef)
   * нет. Используется, когда для найденной релизной ветки нет сохранённого плана (см.
   * loadReleaseBranchOwnCommits/tryReconstructPlanFromReleaseBranch в session.ts) — например, ветку
   * создали в старой версии расширения без сохранения состояния, или вручную, или релиз уже выпущен
   * в main, а через день-два в ТУ ЖЕ ветку докидывают забытую задачу — чтобы всё равно показать,
   * какие задачи в ней уже реально есть.
   *
   * otherReleaseBranchTips — sha кончиков ДРУГИХ, уже существующих релизных веток (см.
   * releaseBranchMatcher в session.ts) — нужен resolveReleaseBranchBaseRef для случая, когда ЭТА
   * ветка влилась в main fast-forward'ом (без отдельного merge-коммита именно для неё).
   */
  async releaseBranchOwnCommits(
    releaseBranch: string,
    mainRef: string,
    maxCount: number,
    otherReleaseBranchTips: Set<string> = new Set()
  ): Promise<FirstParentCommit[]> {
    const baseRef = await this.resolveReleaseBranchBaseRef(releaseBranch, mainRef, otherReleaseBranchTips);
    const format = ['%H', '%P', '%s', '%aI', '%an'].join('%x1f');
    const raw = await this.git.raw([
      'log',
      releaseBranch,
      '--not',
      baseRef,
      '--no-merges',
      `--max-count=${maxCount}`,
      `--pretty=format:${format}%x1e`,
    ]);
    return raw
      .split('\x1e')
      .map((e) => e.trim())
      .filter(Boolean)
      .map((entry) => {
        const [sha, parents, subject, authorDate, authorName] = entry.split('\x1f');
        return { sha, parents: parents.split(' ').filter(Boolean), subject, authorDate, authorName };
      });
  }

  /**
   * Простое `git log releaseBranch --not mainRef` вырождается в пустоту, как только релизная ветка
   * реально влилась в main (fast-forward или обычный merge — с этого момента её кончик становится
   * АНЦЕСТОРОМ main, и `--not mainRef` перестаёт видеть в ней хоть что-то "своё", хотя коммиты
   * реально там есть) — подтверждено на реальном репозитории: релиз, влитый ВЧЕРА через обычный
   * merge-коммит ("Merged in release/X (pull request #N)"), после слияния показывал 0 "своих"
   * коммитов, хотя их там 3.
   *
   * Вместо текущего mainRef ищем в first-parent истории main САМ merge-коммит, который влил ЭТУ
   * ветку (по топологии — родитель = кончик релизной ветки, та же техника, что и
   * GitService.listMergeEvents для веток относительно dev) — и берём его ПЕРВОГО родителя: это и
   * есть состояние main непосредственно ДО поглощения ветки, относительно которого сравнение снова
   * работает как обычная ancestry-проверка.
   *
   * Если такого merge-коммита нет, но кончик релизной ветки всё равно уже предок main (влита
   * fast-forward'ом, без отдельного merge-коммита — подтверждено на реальном примере: релиз,
   * ушедший в main через fast-forward, до этой ветки первым же исправлением показывал 0 "своих"
   * коммитов, хотя их 5) — идём по СОБСТВЕННОЙ first-parent истории релизной ветки от кончика назад
   * и ищем ближайший (самый свежий) merge-коммит, у которого хотя бы один НЕ-первый родитель —
   * это кончик КАКОЙ-ТО ДРУГОЙ, реально существующей релизной ветки (otherReleaseBranchTips,
   * передаётся вызывающим кодом — session.ts знает шаблон имени релизных веток, GitService не
   * обязан): это и есть merge-коммит, которым в main влился ПРЕДЫДУЩИЙ релиз, то есть граница с
   * тем, что было в main до старта ЭТОЙ ветки — при fast-forward'е собственная история ветки и
   * часть истории main совпадают буквально, поэтому искать можно по любой из них.
   *
   * Более простые сигналы здесь НЕДОСТАТОЧНЫ — оба подтверждены на реальном примере:
   * "ближайший коммит с 2+ родителями" в принципе — между двумя релизами в main нашёлся обычный
   * административный merge ("Merge branch 'main' of github.com:.../... into main" — синхронизация
   * с апстримом), из-за чего "своими" ошибочно считались 200+ чужих коммитов вместо 5 своих;
   * "ближайший merge с любым распознанным номером PR" (extractPrNumber) — тоже недостаточно: на
   * пути попался merge совсем другой, не релизной задачи, тоже прошедший через PR хостинга
   * ("Объединено в release (pull-запрос #339)" — не имеет отношения к released/release-YYYY-MM-DD).
   * Только явное совпадение с кончиком РЕАЛЬНО СУЩЕСТВУЮЩЕЙ релизной ветки — это гарантия топологии
   * git, а не подверженное чужим PR совпадение текста.
   *
   * Если ветка вовсе не влита никуда, или влита fast-forward'ом без единого предыдущего релиза (с
   * ещё существующей веткой) в пределах глубины обхода — используем mainRef как есть, ничего не
   * меняется (самый частый случай — ветка ещё не выпущена).
   */
  private async resolveReleaseBranchBaseRef(
    releaseBranch: string,
    mainRef: string,
    otherReleaseBranchTips: Set<string>
  ): Promise<string> {
    try {
      const releaseTip = await this.resolveRef(releaseBranch);
      const mainMergeEvents = await this.listMergeEvents(mainRef);
      // listMergeEvents индексирует merge-событие по ВСЕМ его родителям, а не только по тому,
      // который реально "влился" — releaseTip может совпасть с ПЕРВЫМ родителем совершенно
      // ДРУГОГО, более позднего merge-коммита (main просто продолжила свою линию оттуда дальше)
      // — подтверждено на реальном примере: кончик release-2026-08-04 оказался ПЕРВЫМ родителем
      // merge-коммита СЛЕДУЮЩЕГО релиза (release-2026-08-11), из-за чего baseRef ошибочно
      // становился самим releaseTip, а "своих" коммитов — 0. Реальное "влилась именно ЭТА ветка"
      // — только когда releaseTip НЕ первый родитель (обычный второй родитель merge, см.
      // GitService.listMergeEvents/applyMergeEvents в session.ts — та же конвенция).
      const mergeEvent = (mainMergeEvents.get(releaseTip) ?? []).find((ev) => ev.parents[0] !== releaseTip);
      if (mergeEvent) {
        return mergeEvent.parents[0];
      }
      if (await this.isAncestor(releaseBranch, mainRef)) {
        // firstParentChain возвращает коммиты от САМОГО СТАРОГО к самому свежему (см. её докстринг
        // и planner.ts resolveBranchOwnCommits, который по той же причине идёт по массиву в обратном
        // порядке) — обходим с конца (от кончика релизной ветки), а не с начала: иначе находится
        // первый совпавший merge СО СТОРОНЫ САМОЙ СТАРОЙ истории, а не ближайший к кончику (
        // подтверждено на реальном примере: наивный обход с начала находил случайный merge
        // трёхлетней давности вместо merge-коммита предыдущего релиза, состоявшегося днями раньше).
        const { commits } = await this.firstParentChain(releaseTip, RELEASE_BRANCH_FF_BOUNDARY_WALK_CAP);
        let boundary: FirstParentCommit | undefined;
        for (let i = commits.length - 1; i >= 0; i--) {
          const c = commits[i];
          if (c.sha !== releaseTip && c.parents.length > 1 && c.parents.slice(1).some((p) => otherReleaseBranchTips.has(p))) {
            boundary = c;
            break;
          }
        }
        if (boundary) {
          return boundary.sha;
        }
      }
      return mainRef;
    } catch {
      return mainRef;
    }
  }
}
