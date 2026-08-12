import * as vscode from 'vscode';
import { BranchCommitInfo, BranchDiffStat, BranchRef, MainStatus, ReleasePlan, StaleBranchHint } from '../core/types';
import { ExecutorEvent } from '../core/executor';
import { setActiveProjectId } from '../activeProject';

export interface BranchListInfo {
  totalMatches: number;
  totalBranches: number;
  truncated: boolean;
  /** Текущий лимит показа веток — чтобы панель могла предзаполнить своё поле "Показывать веток". */
  limit: number;
  /**
   * true только когда список пришёл из refreshBranches() (Pull/явный "Обновить список веток") —
   * единственного места, где состояние репозитория реально могло измениться (см. getRefsCache в
   * session.ts). При фильтрации/смене лимита остаётся false — там git-состояние не трогали, и
   * ранее уточнённый статус "в main" (branchMainStatusOverride на клиенте) всё ещё актуален,
   * пересчитывать его заново незачем.
   */
  refreshedGitState: boolean;
}

export interface ReleasePanelHost {
  onRefreshBranches(): Promise<void>;
  onFilterBranches(query: string): Promise<void>;
  onSetBranchListLimit(limit: number, hideAlreadyInMain: boolean): Promise<void>;
  onSetHideServiceBranches(hide: boolean): Promise<void>;
  onSwitchBranch(branchName: string): Promise<void>;
  onPullCurrentBranch(): Promise<void>;
  onExpandBranch(ref: string): Promise<void>;
  onBuildPlan(selectedRefs: string[]): Promise<void>;
  onClearPlan(): Promise<void>;
  onToggleItem(sha: string, included: boolean): Promise<void>;
  onStartBuilding(releaseDate: string): Promise<void>;
  onCheckReleaseDate(releaseDate: string): Promise<void>;
  onStartAuto(): Promise<void>;
  onAbortBuild(): Promise<void>;
  onPublishRelease(): Promise<void>;
  onSetStaleBranchesLookback(n: number): Promise<void>;
}

/** Что показывает панель прямо сейчас — какой сохранённый профиль проекта (id) или "текущий workspace" (undefined). Используется, чтобы понять, действительно ли произошло ПЕРЕКЛЮЧЕНИЕ, а не повторный вызов для того же самого контекста. */
export interface PanelContext {
  projectId?: string;
  projectName?: string;
}

export class ReleasePanel {
  public static current: ReleasePanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  /** id профиля проекта, который панель показывает прямо сейчас; undefined — "текущий workspace" (без профиля). См. createOrShow. */
  private currentProjectId: string | undefined;

  private static titleFor(context?: PanelContext): string {
    return context?.projectName ? `Qvarh Release Builder — ${context.projectName}` : 'Qvarh Release Builder';
  }

  static createOrShow(extensionUri: vscode.Uri, host: ReleasePanelHost, context?: PanelContext): ReleasePanel {
    const title = ReleasePanel.titleFor(context);
    if (ReleasePanel.current) {
      // Панель переиспользуется (её HTML/скрипт не перезагружаются) — если это ДРУГОЙ проект (или
      // переключение между проектом и текущим workspace), список веток/хронология/команда
      // cherry-pick на клиенте всё ещё принадлежат СТАРОМУ контексту и должны быть явно очищены
      // ПЕРЕД тем, как для нового контекста придут свои данные — иначе они на секунду-другую (или
      // навсегда, если пользователь не выберет ветки заново) выглядели бы как актуальные для нового
      // проекта. Повторный вызов для ТОГО ЖЕ проекта (например, случайно нажали 🚀 второй раз) —
      // не переключение, ничего не сбрасываем, чтобы не терять уже построенную хронологию.
      const switched = ReleasePanel.current.currentProjectId !== context?.projectId;
      ReleasePanel.current.panel.reveal();
      ReleasePanel.current.panel.title = title;
      ReleasePanel.current.host = host;
      ReleasePanel.current.currentProjectId = context?.projectId;
      setActiveProjectId(context?.projectId);
      if (switched) {
        ReleasePanel.current.panel.webview.postMessage({ command: 'resetForNewContext' });
      }
      return ReleasePanel.current;
    }
    const panel = vscode.window.createWebviewPanel('qvarhRelease', title, vscode.ViewColumn.One, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [extensionUri],
    });
    // .png, а не .svg с currentColor — иконка вкладки рендерится VS Code вне DOM самой веб-страницы
    // (нет унаследованного --vscode-foreground, как в заголовке панели, см. .app-logo), currentColor
    // резолвился бы в чёрный. .png уже с фиксированным цветом (тот же глиф, см. media/icon.png).
    panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'icon.png');
    ReleasePanel.current = new ReleasePanel(panel, host);
    ReleasePanel.current.currentProjectId = context?.projectId;
    setActiveProjectId(context?.projectId);
    return ReleasePanel.current;
  }

  /**
   * Панель — синглтон, переиспользуемый между проектами (см. createOrShow), а host каждый раз
   * ПЕРЕЗАПИСЫВАЕТСЯ на новую ReleaseSession, без ожидания завершения предыдущей. Если старая
   * ReleaseSession в этот момент ещё дожидается своих же git-вызовов (например, самый первый
   * refreshBranches() в start(), который может идти секунды на большом репозитории) и слепо зовёт
   * this.panel.postXxx(...) по их завершении — результат всё равно уйдёт в ЭТУ ЖЕ панель, но она
   * уже показывает ДРУГОЙ проект: список веток/фильтр предыдущего проекта на секунду (или навсегда)
   * "всплывают" поверх уже переключённого. ReleaseSession должна звать это ПЕРЕД каждым post-вызовом,
   * который идёт после await, и тихо пропускать отправку, если она больше не хозяин панели.
   */
  isCurrentHost(host: ReleasePanelHost): boolean {
    return this.host === host;
  }

  private constructor(panel: vscode.WebviewPanel, private host: ReleasePanelHost) {
    this.panel = panel;
    this.panel.webview.html = this.renderHtml();

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    this.panel.webview.onDidReceiveMessage(
      async (message) => {
        try {
          switch (message.command) {
            case 'refreshBranches':
              await this.host.onRefreshBranches();
              break;
            case 'filterBranches':
              await this.host.onFilterBranches(message.query);
              break;
            case 'setBranchListLimit':
              await this.host.onSetBranchListLimit(message.limit, message.hideAlreadyInMain);
              break;
            case 'setHideServiceBranches':
              await this.host.onSetHideServiceBranches(message.hide);
              break;
            case 'switchBranch':
              await this.host.onSwitchBranch(message.branch);
              break;
            case 'pullCurrentBranch':
              await this.host.onPullCurrentBranch();
              break;
            case 'expandBranch':
              await this.host.onExpandBranch(message.ref);
              break;
            case 'buildPlan':
              await this.host.onBuildPlan(message.selectedRefs);
              break;
            case 'clearPlan':
              await this.host.onClearPlan();
              break;
            case 'toggleItem':
              await this.host.onToggleItem(message.sha, message.included);
              break;
            case 'startBuilding':
              await this.host.onStartBuilding(message.releaseDate);
              break;
            case 'checkReleaseDate':
              await this.host.onCheckReleaseDate(message.releaseDate);
              break;
            case 'startAuto':
              await this.host.onStartAuto();
              break;
            case 'abortBuild':
              await this.host.onAbortBuild();
              break;
            case 'publishRelease':
              await this.host.onPublishRelease();
              break;
            case 'setStaleBranchesLookback':
              await this.host.onSetStaleBranchesLookback(message.value);
              break;
          }
        } catch (err: any) {
          this.postError(err?.message ?? String(err));
        }
      },
      null,
      this.disposables
    );
  }

  postCurrentBranch(current: string, mainBranch: string, devBranch: string, staleBranchesLookbackReleases: number): void {
    this.panel.webview.postMessage({ command: 'currentBranch', current, mainBranch, devBranch, staleBranchesLookbackReleases });
  }

  /**
   * Задачи, которые реально уже есть в найденной релизной ветке (см. session.ts
   * loadReleaseBranchOwnCommits) — только для случая, когда ветка найдена (по имени/дате), но нет
   * персистентного плана с полной хронологией (например, ветку создали в старой версии расширения
   * или вручную) — иначе панель ничем не подтвердила бы пользователю, что сборка уже начата.
   */
  postReleaseBranchInfo(
    releaseBranch: string,
    commits: Array<{ sha: string; subject: string; authorDate: string; authorName: string; taskUrl: string | null; prUrl: string | null; commitUrl: string | null }>,
    /** Короткое объяснение, когда commits пуст — почему (уже выпущена в main / ещё пустая) — см. session.ts loadReleaseBranchOwnCommits. */
    note: string | null = null
  ): void {
    this.panel.webview.postMessage({ command: 'releaseBranchInfo', releaseBranch, commits, note });
  }

  /** Сколько веток в репозитории подходят под шаблон релизной ветки — общая картина наверху панели, см. session.ts postReleaseBranchPatternCount. */
  postReleaseBranchPatternCount(count: number): void {
    this.panel.webview.postMessage({ command: 'releaseBranchPatternCount', count });
  }

  /** Ответ на 'checkReleaseDate' — есть ли уже релизная ветка с именем, которое дала бы введённая дата (см. session.ts onCheckReleaseDate). Панель по этому ответу дизейблит/включает "Создать релизную ветку". */
  postReleaseDateCheck(branchName: string, exists: boolean): void {
    this.panel.webview.postMessage({ command: 'releaseDateCheck', branchName, exists });
  }

  postBranches(branches: BranchRef[], selectedRefs: string[], info: BranchListInfo): void {
    this.panel.webview.postMessage({ command: 'branches', branches, selectedRefs, info });
  }

  postBranchCommits(ref: string, commits: BranchCommitInfo[], truncated: boolean, forkedFrom: string | null = null): void {
    this.panel.webview.postMessage({ command: 'branchCommits', ref, commits, truncated, forkedFrom });
  }

  /** Индикатор загрузки для поиска "забытых" веток — отправляется сразу после postPlan, пока широкий скан ещё идёт (см. session.ts rebuildPlan/runFindStaleBranches). */
  postStaleBranchesLoading(): void {
    this.panel.webview.postMessage({ command: 'staleBranchesLoading' });
  }

  /** Результат поиска "забытых" веток, отсоединившихся раньше самой ранней в хронологии — считается автоматически после каждого построения хронологии (см. session.ts runFindStaleBranches), не блокируя её показ. */
  postStaleBranches(hints: StaleBranchHint[]): void {
    this.panel.webview.postMessage({ command: 'staleBranches', hints });
  }

  /** Фоновое уточнение статуса "в main" (partial/full/none) для показанного среза веток — см. session.ts refineBranchMainStatus. */
  postBranchMainStatus(statusByRef: Record<string, MainStatus>): void {
    this.panel.webview.postMessage({ command: 'branchMainStatus', statusByRef });
  }

  /** Агрегированный +/- и число файлов на ветку (превью без разворачивания коммитов) — тем же фоновым проходом, что и postBranchMainStatus, см. computeMainStatusForBranches в planner.ts. */
  postBranchDiffStats(diffStatByRef: Record<string, BranchDiffStat>): void {
    this.panel.webview.postMessage({ command: 'branchDiffStats', diffStatByRef });
  }

  postPlan(plan: ReleasePlan | null): void {
    this.panel.webview.postMessage({ command: 'planBuilt', plan });
  }

  /**
   * Принудительно перезаписывает выбор веток на клиенте — в отличие от selectedRefs внутри
   * 'branches' (см. postBranches), который клиент принимает только ОДИН раз при первом открытии
   * панели (дальше это состояние клиента, чтобы фильтрация/лимит не сбрасывали чекбоксы). Нужно,
   * когда СЕРВЕР сам меняет выбор ПОСЛЕ того, как первое 'branches' уже ушло — единственный такой
   * случай сейчас: реконструкция хронологии по существующей релизной ветке (см. session.ts
   * tryReconstructPlanFromReleaseBranch) находит и авто-выбирает ветки уже ПОСЛЕ refreshBranches().
   * Без этого чекбоксы найденных веток не отмечались бы в списке, и повторное "Построить
   * хронологию" (например, чтобы добавить забытую задачу) отправило бы на сервер выбор БЕЗ них,
   * стирая уже восстановленную историю.
   */
  postSelectedRefs(refs: string[]): void {
    this.panel.webview.postMessage({ command: 'selectedRefs', refs });
  }

  /**
   * Лоадер на блок хронологии, когда её (пере)строит сама сессия, а не клик по "Построить
   * хронологию" — например, при попадании на уже существующую релизную ветку (см. session.ts
   * prepareReleaseBranchAdoption/finishApplyingPlan). Переиспользует тот же клиентский индикатор
   * (setBuildPlanBusy), что и обычная кнопка — planBuilt/error уже гасят его как обычно.
   */
  postPlanBuilding(): void {
    this.panel.webview.postMessage({ command: 'planBuilding' });
  }

  postProgress(event: ExecutorEvent): void {
    this.panel.webview.postMessage({ command: 'progress', event });
  }

  postPublished(): void {
    this.panel.webview.postMessage({ command: 'published' });
  }

  postError(message: string): void {
    this.panel.webview.postMessage({ command: 'error', message });
  }

  dispose(): void {
    ReleasePanel.current = undefined;
    setActiveProjectId(undefined);
    this.panel.dispose();
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }

  private renderHtml(): string {
    return /* html */ `<!doctype html>
<html lang="ru">
<head>
<meta charset="UTF-8" />
<style>
  :root {
    --qr-radius: 8px;
    --qr-radius-sm: 5px;
    --qr-card-bg: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
    --qr-card-border: var(--vscode-widget-border, var(--vscode-panel-border));
    --qr-gap: 14px;
  }
  * { box-sizing: border-box; }
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 14px; }
  /* Хедер панели — логотип + название + подпись под ним (см. renderHtml). */
  .app-header { display: flex; align-items: center; gap: 10px; }
  /* Инлайновый SVG, а не <img src="...icon.svg">: внешний файл-картинка рендерится браузером как
     отдельный документ, currentColor в нём резолвится в свой дефолт (чёрный), а НЕ в цвет текста
     страницы — из-за этого лого раньше просто не было видно на тёмной теме. Инлайновый <svg> —
     часть той же страницы, currentColor берёт --vscode-foreground как обычный текст. */
  .app-header svg.app-logo { width: 22px; height: 22px; flex: none; display: block; color: var(--vscode-foreground); }
  .app-header h2 { margin: 0; line-height: 1.3; font-size: 15px; }
  .app-subtitle { opacity: 0.7; font-size: 12px; margin: 2px 0 var(--qr-gap); }
  h3 { margin-bottom: 6px; }
  /* Карточка — общая "рамка" для утилитарной Git-строки наверху и каждого пронумерованного шага
     ниже (см. .card-num) — единственная единица визуальной группировки во всей панели, вместо
     разделителей section{border-bottom} до этого редизайна. */
  .card { background: var(--qr-card-bg); border: 1px solid var(--qr-card-border); border-radius: var(--qr-radius); padding: 12px 14px; margin-bottom: var(--qr-gap); }
  .git-bar { display: flex; align-items: center; gap: 10px 16px; flex-wrap: wrap; margin-bottom: var(--qr-gap); }
  .git-bar .field-inline { display: flex; align-items: center; gap: 8px; }
  .git-bar .field-inline label { font-size: 12px; opacity: 0.85; white-space: nowrap; }
  .git-bar .field-inline select { min-width: 200px; }
  .git-bar-actions { display: flex; gap: 6px; flex-wrap: wrap; margin-left: auto; }
  /* Заголовок карточки шага — кружок с номером (тот же порядок, что в разделах панели) + заголовок
     и короткое пояснение под ним. card-head сама по себе не обязательно кликабельна — у
     "Хронология коммитов" на неё же навешан collapse-toggle (см. #itemsHeader), поэтому cursor и
     user-select там задаются отдельным классом .clickable, а не тут, чтобы остальные заголовки не
     выглядели как кнопки, которыми не являются. */
  .card-head { display: flex; align-items: flex-start; gap: 10px; margin-bottom: 10px; }
  .card-head.clickable { cursor: pointer; user-select: none; }
  .card-num { display: flex; align-items: center; justify-content: center; width: 22px; height: 22px; border-radius: 50%; background: var(--vscode-button-background); color: var(--vscode-button-foreground); font-size: 12px; font-weight: 600; flex: none; margin-top: 1px; }
  .card-head-text { flex: 1; min-width: 0; }
  .card-title { margin: 0; font-size: 13px; font-weight: 600; }
  .card-desc { font-size: 11px; opacity: 0.7; margin: 2px 0 0; }
  .card-head-extra { display: flex; align-items: center; gap: 8px; flex: none; margin-top: 1px; }
  /* Дублирует итог по конфликтам из футера хронологии (см. .chrono-summary-row) прямо в заголовке
     карточки — виден сразу, не долистывая таблицу коммитов вниз. */
  .conflict-summary-top { font-size: 11px; padding: 2px 8px; border-radius: 10px; display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; }
  .conflict-summary-top.ok { background: color-mix(in srgb, var(--vscode-charts-green) 20%, transparent); color: var(--vscode-charts-green); }
  .conflict-summary-top.bad { background: var(--vscode-charts-red); color: #fff; }
  /* Кнопки-действия, встроенные ПРЯМО в кликабельный заголовок карточки (Очистить, Сбросить
     копирование, кнопка синхронизации) — иначе клик по ним сработал бы и как клик по самому
     заголовку (см. stopPropagation в их обработчиках), поэтому визуально мельче обычных кнопок,
     чтобы не спорить с заголовком за внимание. */
  button.small-btn { font-size: 11px; padding: 3px 8px; margin: 0; }
  /* Кнопка-иконка без текста (синхронизация хронологии с текущим выбором веток, см.
     #rebuildSyncBtn) — красная, если состав/количество выбранных веток разошлось с тем, на основе
     чего построена текущая хронология (нажатие перестраивает её), зелёная — если совпадает. */
  button.icon-btn { background: none; padding: 2px; margin: 0; display: inline-flex; align-items: center; justify-content: center; border-radius: 50%; }
  button.icon-btn svg { width: 16px; height: 16px; }
  button.icon-btn:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.2)); }
  .sync-btn.sync-bad { color: var(--vscode-charts-red); }
  .sync-btn.sync-ok { color: var(--vscode-charts-green); }
  /* Пока идёт (пере)построение хронологии — см. setBuildPlanBusy — крутится сама иконка, а не
     кнопка целиком (иначе hover-подсветка/фон тоже завертелись бы вместе с ней). */
  .sync-btn.spinning svg { animation: qvarh-spin 0.8s linear infinite; }
  /* Фиксированные цвета по явному ТЗ (а не тема-зависимые --vscode-button-*) — Pull/Создать
     релизную ветку синие, Начать сборку зелёная, Отменить сборку красная: они настолько разные по
     последствиям (переключение контекста / начало необратимого cherry-pick / его отмена), что
     стоит выделить цветом сильнее, чем просто primary/secondary. */
  .btn-blue { background: #2246a8; color: #fff; }
  .btn-blue:hover { filter: brightness(1.15); }
  .btn-green { background: #276839; color: #fff; }
  .btn-green:hover { filter: brightness(1.15); }
  .btn-red { background: #95292d; color: #fff; }
  .btn-red:hover { filter: brightness(1.15); }
  /* Поле поиска списка веток — иконка внутри инпута слева, текст с отступом под неё (padding-left
     на самом input, а не просто оверлей поверх текста) — курсор и ввод начинаются ПОСЛЕ иконки, а
     не наезжают на неё. */
  .search-field { position: relative; display: flex; align-items: center; }
  .search-field .search-icon { position: absolute; left: 8px; width: 14px; height: 14px; opacity: 0.6; pointer-events: none; color: var(--vscode-input-foreground); }
  .search-field input[type=text] { padding-left: 28px; max-width: 420px; }
  input[type=text], input[type=number], select { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: var(--qr-radius-sm); padding: 4px 6px; font-family: inherit; font-size: inherit; }
  input[type=text] { width: 100%; max-width: 260px; }
  select { cursor: pointer; }
  .field { margin-bottom: 8px; }
  .field label { display: block; margin-bottom: 2px; }
  /* Модификатор для полей, где label короткий и лучше смотрится в одну строку с самим input
     (см. "Дата релиза") — не трогает базовый .field (переносы label/input друг под другом нужны
     там, где текст лейбла длиннее, например у фильтра — впрочем, там своя обёртка .search-field). */
  .field.field-row { display: flex; align-items: center; gap: 8px; }
  .field.field-row label { display: inline; margin-bottom: 0; white-space: nowrap; }
  .button-row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-top: 8px; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: var(--qr-radius-sm); padding: 6px 12px; cursor: pointer; margin-right: 6px; margin-bottom: 6px; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  /* Разворачивание коммитов конкретной ветки в списке (см. .expand-toggle) — единственное
     оставшееся текстовое действие-ссылка в панели: этих кнопок по одной на КАЖДУЮ строку списка
     веток, полноценная кнопка на каждой была бы визуально слишком тяжёлой. "Показать контекстные
     коммиты"/"Сбросить копирование" (их в панели всего по одному экземпляру) теперь настоящие
     кнопки — см. .small-btn. */
  button.link { background: none; color: var(--vscode-textLink-foreground); padding: 0; margin: 0; text-decoration: underline; font-size: 11px; }
  .links a { color: var(--vscode-textLink-foreground); text-decoration: none; margin-right: 8px; font-size: 11px; }
  .links a:hover { text-decoration: underline; }
  /* Цвет +/- один на все контексты, где рендерится renderDiffStatInline (ссылки, автор в хронологии,
     суммаризация внизу таблицы, агрегированная сводка по ветке) — раньше был задан отдельно под
     каждым родительским классом и до суммаризации просто не добрался (см. .chrono-summary-row
     ниже), из-за чего там +/- были обычным текстом без цвета. Layout (расположение в строку/
     столбик, отступы, моноширинный шрифт) остаётся свой у каждого контекста — общий только цвет. */
  .diffstat-add { color: var(--vscode-charts-green); }
  .diffstat-del { color: var(--vscode-charts-red); }
  .links .diffstat { font-size: 11px; font-family: var(--vscode-editor-font-family, monospace); }
  .links .diffstat-del { margin-left: 4px; }
  button:disabled { opacity: 0.5; cursor: default; }
  /* position:relative — сам служит "холстом" для .branch-rail-overlay (см. renderBranches/
     drawBranchRail), как #items у хронологии, но без отдельного внешнего скролл-контейнера:
     #branchList одновременно и скроллится, и позиционирует поверх себя абсолютный SVG. */
  #branchList { position: relative; height: 280px; min-height: 120px; resize: vertical; overflow-y: auto; overflow-x: hidden; border: 1px solid var(--qr-card-border); border-radius: var(--qr-radius-sm); margin-top: 6px; }
  .branch-row-main { display: flex; align-items: flex-start; gap: 8px; }
  .branch-row.remote .branch-name::after { content: " (remote)"; opacity: 0.5; font-size: 10px; }
  .lane-label { font-size: 11px; padding: 1px 6px; border-radius: 3px; color: #000; flex: none; min-width: 90px; text-align: center; }
  .branch-main { flex: 1; min-width: 0; }
  .sha { font-family: var(--vscode-editor-font-family); font-size: 11px; opacity: 0.8; }
  .muted { opacity: 0.7; font-size: 12px; }
  .badge { font-size: 11px; padding: 1px 6px; border-radius: 3px; margin-right: 4px; display: inline-block; margin-top: 2px; }
  .badge.overlap { background: var(--vscode-charts-orange); color: #000; }
  .badge.ok { background: var(--vscode-charts-green); color: #000; }
  .badge.conflict { background: var(--vscode-charts-red); color: #fff; }
  .badge.applied { background: var(--vscode-charts-blue); color: #fff; }
  .badge.inmain { background: var(--vscode-charts-purple, #B37FEB); color: #000; }
  .badge.partial-inmain { background: var(--vscode-charts-yellow, #E2C08D); color: #000; }
  /* Тот же радиус, что и у кнопок (--qr-radius-sm) — раньше был отдельный "пилюльный" 10px, теперь
     единый скруглённый стиль по всей панели (см. .cherry-sha ниже — тот же приём для sha в командах). */
  .chip { display: inline-block; font-size: 11px; padding: 2px 8px; border-radius: var(--qr-radius-sm); background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); margin: 2px 4px 2px 0; }
  #error { display: flex; align-items: flex-start; gap: 8px; color: var(--vscode-errorForeground); background: var(--vscode-inputValidation-errorBackground, transparent); border: 1px solid var(--vscode-inputValidation-errorBorder, transparent); padding: 8px 10px; border-radius: var(--qr-radius-sm); min-height: 1em; margin-bottom: var(--qr-gap); }
  #errorText { white-space: pre-wrap; flex: 1; }
  #errorCloseBtn { background: none; border: none; color: inherit; cursor: pointer; padding: 0; margin: 0; font-size: 14px; line-height: 1; opacity: 0.7; }
  #errorCloseBtn:hover { opacity: 1; }
  .branch-commits { margin: 4px 0 4px 0; padding-left: 8px; border-left: 2px solid var(--qr-card-border); }
  .branch-commit-row { font-size: 11px; padding: 2px 0; }
  .conflict-details { margin-top: 4px; padding-left: 8px; border-left: 2px solid var(--vscode-charts-red); }
  .conflict-file { font-size: 11px; padding: 2px 0; }
  .conflict-hint { font-size: 11px; padding: 3px 0; }
  .conflict-cause { font-size: 11px; padding: 2px 0 2px 8px; }
  .filter-row { display: flex; gap: 14px; align-items: center; margin-top: 8px; flex-wrap: wrap; font-size: 12px; }
  .limit-field { display: flex; align-items: center; gap: 6px; white-space: nowrap; cursor: default; margin-left: auto; }
  /* Переключатель ("Показать служебные"/"Скрыть уже в main") — обычный чекбокс визуально в виде
     пилюли-свитча (см. track/knob через ::after), а не голый нативный чекбокс: реагирует сразу же
     (input change), никакой кнопки "Применить" тут больше нет (см. requestApplyBranchFilters). */
  .switch { display: inline-flex; align-items: center; gap: 8px; white-space: nowrap; cursor: pointer; user-select: none; }
  .switch input { position: absolute; opacity: 0; width: 1px; height: 1px; }
  .switch .track { width: 30px; height: 16px; border-radius: 8px; background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); position: relative; flex: none; transition: background-color 0.15s ease, border-color 0.15s ease; }
  .switch .track::after { content: ''; position: absolute; top: 1px; left: 1px; width: 12px; height: 12px; border-radius: 50%; background: var(--vscode-descriptionForeground); transition: transform 0.15s ease, background-color 0.15s ease; }
  .switch input:checked + .track { background: var(--vscode-button-background); border-color: var(--vscode-button-background); }
  .switch input:checked + .track::after { transform: translateX(14px); background: var(--vscode-button-foreground); }
  .switch input:focus-visible + .track { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
  /* Список веток — та же табличная подача, что и у хронологии (см. .chrono-grid-row): узкая
     колонка-"рельс" слева с прямой линией СВОЕГО цвета на каждую ветку (см. drawBranchRail —
     без ветвлений/слияний, это просто визуальная привязка к цвету, а не настоящий граф), затем
     контент ветки, затем агрегированный +/- "за базой" (см. BranchDiffStat в types.ts) в узкой
     колонке справа — статус "в main" здесь НЕ отдельная колонка, он остаётся бейджем рядом с
     именем ветки, как и раньше. */
  .branch-grid-row { display: grid; grid-template-columns: 22px minmax(160px, 1fr) 84px; column-gap: 0; align-items: stretch; }
  .branch-row { padding: 5px 0; border-bottom: 1px dashed var(--qr-card-border); }
  .branch-row:last-child { border-bottom: none; }
  .branch-header-row { border-bottom: 1px solid var(--qr-card-border); padding-bottom: 4px; margin-bottom: 2px; }
  .col-branch-info { padding: 0 8px; min-width: 0; }
  .col-branch-diffstat { padding: 3px 8px; text-align: right; }
  .col-branch-diffstat .diffstat { display: inline-flex; flex-direction: column; gap: 1px; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; }
  .col-branch-diffstat .muted { display: block; font-size: 10px; }
  /* .inline-loading (см. выше) — блочный flex, а не inline-flex, поэтому text-align:right ячейки
     на его позицию не влияет (блочный бокс всегда на всю ширину) — выравниваем спиннер вручную. */
  .col-branch-diffstat .inline-loading { justify-content: flex-end; }
  .branch-rail-spacer { position: relative; }
  /* Отдельный от хронологии SVG-оверлей (см. .rail-overlay выше — тот НЕ трогаем, это его
     упрощённая версия без лейнов/слияний специально для списка веток, см. drawBranchRail). */
  .branch-rail-overlay { position: absolute; top: 0; left: 0; pointer-events: none; }
  .branch-list-loading, .inline-loading { display: flex; align-items: center; gap: 6px; }
  .branch-list-loading { padding: 8px 0; }
  .branch-list-loading::before, .inline-loading::before {
    content: ''; width: 10px; height: 10px; border-radius: 50%; flex: none;
    border: 2px solid var(--vscode-panel-border); border-top-color: var(--vscode-foreground);
    animation: qvarh-spin 0.8s linear infinite;
  }
  @keyframes qvarh-spin { to { transform: rotate(360deg); } }
  /* Фиксированный квадратный бокс с flex-центрированием — раньше был несимметричный padding
     (0 0 0 4px) без явных width/height, из-за чего рамка наведения браузера обрамляла
     несимметричный бокс, а "×" внутри неё съезжал вправо, а не в центр. */
  .chip-remove { background: none; border: none; color: inherit; cursor: pointer; padding: 0; margin: 0 0 0 4px; font-size: 12px; width: 14px; height: 14px; display: inline-flex; align-items: center; justify-content: center; border-radius: 50%; }
  /* Очистить весь выбор одним кликом (см. clearSelectedBranches) — красный кружок с "×", как
     .chip-remove у отдельного чипа, только заметнее и всегда первым в строке "Выбрано", раз он
     сбрасывает ВСЁ, а не один чип. */
  .clear-all-btn { background: var(--vscode-charts-red); color: #fff; border: none; padding: 0; margin: 0 6px 0 0; font-size: 12px; font-weight: 700; width: 16px; height: 16px; display: inline-flex; align-items: center; justify-content: center; border-radius: 50%; cursor: pointer; vertical-align: middle; }
  .clear-all-btn:hover { filter: brightness(1.15); }
  .card-head .collapse-arrow { font-size: 10px; opacity: 0.7; width: 10px; display: inline-block; text-align: center; }
  .collapsible-body.collapsed { display: none; }
  /* "Rail" — дорожки веток слева от хронологии (см. renderItems/computeRail/drawRail): dev-"ствол"
     (лейн 0) и по одной дорожке на каждую показанную ветку, шириной RAIL_LANE_W каждая — фиксированный
     размер, не зависящий от ширины панели (поэтому не "разъезжается" на широком экране, в отличие от
     прежнего варианта на @gitgraph/js). Сами линии/точки/кривые ветвления-слияния рисуются ОДНИМ SVG
     поверх колонки-заглушки (.rail-spacer лишь резервирует горизонтальное место в каждой строке, теперь
     через CSS-переменную --rail-w — первый трек .chrono-grid-row, а не инлайновый style как раньше) —
     координаты по Y берутся из РЕАЛЬНОГО отрендеренного положения строк (см. drawRailNow: offsetTop/
     offsetHeight каждого .timeline-row), а не подгоняются под фиксированную высоту, поэтому переносы
     текста в колонке коммита (см. .chrono-grid-row) не ломают линии — ResizeObserver перерисовывает
     дорожку при любом изменении высоты строк, в т.ч. из-за ресайза окна. */
  #items { position: relative; }
  /* overflow-y без явного значения тут был БЫ не "visible", как можно подумать по тексту правила —
     по спеке CSS, если overflow-x задан НЕ visible, а overflow-y не указан, второй тоже вычисляется
     как auto, а не остаётся visible. У #items внутри лежит абсолютно позиционированный SVG-оверлей
     графа с overflow:visible (пунктирные "хвосты" веток намеренно на пару пикселей выходят за его
     верхний/нижний край, см. drawRail) — этот paint-overflow попадал в скроллируемую область
     .chrono-scroll и добавлял пустое место снизу таблицы вместе с ненужным вертикальным скроллом.
     overflow-y: hidden — явно отключает вертикальный скролл у этого контейнера (нужен только
     горизонтальный, см. min-width на #chronoInner), не влияя на видимость самой таблицы: её реальная
     высота и так равна высоте содержимого. */
  .chrono-scroll { overflow-x: auto; overflow-y: hidden; margin-top: 4px; }
  .timeline-row { border-bottom: 1px dashed var(--vscode-panel-border); }
  .timeline-row:last-child { border-bottom: none; }
  .timeline-row.timeline-row-hidden { min-height: 0; border-bottom: none; }
  /* Каждая "строка таблицы" хронологии (заголовок, .timeline-row коммита/контекста, футер-суммаризация
     ниже) — свой display:grid с ОДИНАКОВЫМ grid-template-columns, поэтому колонки визуально совпадают
     без единого общего grid-контейнера на все строки сразу (а значит без риска для rowCenters — каждый
     .timeline-row остаётся ровно одним элементом, как и раньше, просто теперь grid, а не flex внутри).
     Первая колонка — ширина графа (--rail-w, пишется в renderItems из railWidth(rail)); дальше:
     чекбокс+ветка (фиксированная — под .lane-label) · коммит (единственная гибкая, minmax(...,1fr) —
     именно она переносит текст при ресайзе, сужена — горизонтальный скролл при необходимости и так
     есть, растягивать эту колонку сверх нужного незачем) · дата · автор (второй строкой — +/-, см.
     renderItemRow; отдельной колонки "Изменения" больше нет). */
  .chrono-grid-row { display: grid; grid-template-columns: var(--rail-w, 18px) 152px minmax(160px, 1fr) 144px 124px; column-gap: 0; align-items: stretch; }
  .chrono-cell { padding: 3px 8px; min-width: 0; }
  .chrono-header-row { border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 4px; margin-bottom: 2px; }
  .chrono-header-cell { font-weight: 600; font-size: 11px; opacity: 0.75; text-transform: uppercase; letter-spacing: 0.02em; }
  .col-branch { display: flex; align-items: flex-start; gap: 6px; }
  /* Длинные имена веток (feature/very-long-task-name) переносятся на несколько строк, а не режутся
     эллипсисом — само имя ветки важно видеть целиком, а не только начало. Раньше .lane-label здесь
     наследовал flex:none/white-space:nowrap от базового правила (см. .lane-label — оно используется
     и для чипов в списке веток, где перенос не нужен) — из-за flex-shrink:0 чип не мог сжаться под
     ширину .chrono-cell и визуально наезжал на соседнюю колонку с коммитом, а не переносился внутри
     своей. min-width:0 обязателен — без него flex-item по умолчанию не может стать уже своего
     содержимого, и wrap так и не сработал бы. Высота строки при этом не фиксирована (см. .chrono-cell)
     — многострочная ветка просто раздвигает всю строку, как уже делает перенос темы коммита. */
  .col-branch .lane-label { flex: 1 1 auto; min-width: 0; white-space: normal; overflow-wrap: break-word; word-break: break-word; }
  .col-date { font-family: var(--vscode-editor-font-family); font-size: 11px; opacity: 0.8; white-space: nowrap; }
  .col-author { font-size: 11px; opacity: 0.8; }
  .col-author > div:first-child { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .col-author .diffstat { display: flex; gap: 4px; margin-top: 2px; font-family: var(--vscode-editor-font-family, monospace); }
  /* Контекстные/якорные коммиты dev-ветки — фон хронологии, не относятся ни к одной выбранной ветке:
     нет чекбокса, нет +/- (у CommitInfo нет insertions/deletions), приглушены визуально. */
  .timeline-row.chrono-context { opacity: 0.55; font-size: 11px; }
  .chrono-context .lane-label { background: transparent !important; color: var(--vscode-foreground) !important; border: 1px dashed var(--vscode-panel-border); }
  .chrono-summary-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px; margin-top: 6px; padding: 6px 8px; border-top: 1px solid var(--vscode-panel-border); font-size: 11px; opacity: 0.85; }
  .chrono-summary-row .diffstat { display: inline-flex; gap: 4px; }
  .chrono-summary-sep { opacity: 0.5; margin: 0 2px; }
  /* Невидимый маркер слияния при свёрнутых контекстных коммитах (см. renderItems) — нулевая высота
     и без разделителя, чтобы визуально ничем не отличаться от "полностью скрыто", но всё ещё
     присутствовать в DOM ради Y-координаты для кривой слияния на дорожке. */
  .timeline-row.timeline-row-hidden { min-height: 0; border-bottom: none; }
  .rail-overlay { position: absolute; top: 0; left: 0; pointer-events: none; }
  .rail-overlay .rail-line { stroke-width: 2; fill: none; transition: opacity 0.1s ease, stroke-width 0.1s ease; }
  .rail-overlay .rail-halo { fill: var(--vscode-editor-background, var(--vscode-sideBar-background)); }
  /* Наведение на точку коммита (см. wireRailHover) — тускнеет всё, кроме дорожки/точек этой же
     ветки, а её саму делает чуть заметнее (толще линия). Точки с data-branch — единственное, что
     реально ловит события мыши: остальная часть .rail-overlay остаётся pointer-events:none. */
  .rail-overlay circle[data-branch] { pointer-events: auto; cursor: pointer; transition: opacity 0.1s ease; }
  .rail-overlay [data-branch].rail-dim { opacity: 0.2; }
  .rail-overlay [data-branch].rail-hot { opacity: 1; }
  .rail-overlay .rail-line.rail-hot { stroke-width: 3.5; }
  .stale-branches { margin-top: 8px; }
  .stale-branch-row { font-size: 11px; padding: 3px 0; border-bottom: 1px dashed var(--vscode-panel-border); }
  .stale-add-btn { background: var(--vscode-charts-green); color: #000; border: none; border-radius: 50%; width: 16px; height: 16px; line-height: 16px; padding: 0; margin: 0 2px; font-size: 12px; font-weight: 700; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; }
  .stale-add-btn:hover { filter: brightness(1.15); }
  /* Уже добавлена в выбор (см. updateStaleAddButtons) — приглушённая, без cursor:pointer намёка на кликабельность. */
  .stale-add-btn.added, .stale-add-btn:disabled { background: transparent; color: var(--vscode-charts-green); cursor: default; opacity: 0.8; }
  .stale-add-btn.added:hover, .stale-add-btn:disabled:hover { filter: none; }
  .stale-branches-controls { margin-bottom: 4px; }
  .stale-branches-controls input[type="number"] { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 2px; padding: 1px 4px; }
  .cherry-cmd { margin-bottom: 10px; padding: 6px 8px; border: 1px solid var(--qr-card-border); border-radius: var(--qr-radius-sm); }
  .cherry-cmd-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 4px; }
  .cherry-cmd-label { font-size: 11px; opacity: 0.75; }
  .cherry-cmd-body { font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; line-height: 2; word-break: break-word; }
  .cherry-cmd-prefix { opacity: 0.8; margin-right: 4px; }
  /* Каждый sha — цветной "чип", как .lane-label в хронологии: тот же colorFor(branch), чтобы
     совпадало визуально. У конфликтного — фон красный (как .badge.conflict), а обводка — в цвет
     ветки, чтобы не терять связь с веткой даже когда фон перекрыт цветом конфликта. */
  .cherry-sha { display: inline-block; padding: 1px 6px; margin: 1px 3px 1px 0; border-radius: var(--qr-radius-sm); color: #000; text-decoration: none; border: 2px solid transparent; font-size: 11px; cursor: pointer; }
  .cherry-sha:hover { filter: brightness(1.12); text-decoration: underline; }
  .cherry-sha.conflict { background: var(--vscode-charts-red) !important; color: #fff; }
  /* Состояние "уже скопировано" — блёклый текст, чтобы не запутаться, какую команду уже брали. */
  .cherry-cmd.copied { opacity: 0.45; }
</style>
</head>
<body>
  <div class="app-header">
    <svg class="app-logo" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4 3 L4 13" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none"/>
      <path d="M4 6.2 C7 6.2 7 8 11 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none"/>
      <circle cx="4" cy="3" r="1.6" fill="currentColor"/>
      <circle cx="4" cy="13" r="1.6" fill="currentColor"/>
      <circle cx="12" cy="8" r="1.6" fill="currentColor"/>
    </svg>
    <h2>Qvarh Release Builder</h2>
  </div>
  <div class="app-subtitle">Сборка, проверка и выпуск релизов из локальных веток</div>

  <div id="error" style="display:none;">
    <span id="errorText"></span>
    <button id="errorCloseBtn" title="Закрыть">×</button>
  </div>

  <div class="card git-bar">
    <div class="field-inline">
      <label for="currentBranchSelect">Текущая ветка</label>
      <select id="currentBranchSelect"><option value="">…</option></select>
    </div>
    <div class="git-bar-actions">
      <button id="pullBtn" class="btn-blue" title="git pull для уже выбранной (текущей) ветки — переключиться на другую ветку можно селектом слева">Pull</button>
    </div>
  </div>

  <section class="card">
    <div class="card-head clickable" id="branchesHeader">
      <span class="card-num">1</span>
      <div class="card-head-text">
        <h3 class="card-title">Выберите ветки для релиза</h3>
        <div class="card-desc">Отметьте ветки, которые хотите включить в релиз.</div>
      </div>
      <div class="card-head-extra">
        <button id="refreshBtn" class="secondary small-btn">Обновить список веток</button>
        <span class="collapse-arrow" id="branchesArrow">▾</span>
      </div>
    </div>
    <div class="collapsible-body" id="branchesBody">
    <div class="field">
      <div class="search-field">
        <svg class="search-icon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="6.5" cy="6.5" r="4.5" stroke="currentColor" stroke-width="1.4" fill="none"/><line x1="10" y1="10" x2="14" y2="14" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
        <input type="text" id="branchFilter" placeholder="Фильтр по названию ветки, через пробел — несколько сразу" />
      </div>
    </div>
    <div class="filter-row">
      <label class="switch" title="Скрывает ветки, уже полностью выпущенные — проверка идёт git-запросом, поэтому реагирует не мгновенно">
        <input type="checkbox" id="hideInMainFilter" /><span class="track"></span> Скрыть уже в <span id="hideInMainFilterBranchName">main</span>
      </label>
      <label class="switch" title="qa, revert-pr-, chore/ и т.п. — см. настройку «Префиксы служебных веток»; по умолчанию скрыты">
        <input type="checkbox" id="hideServiceBranchesFilter" /><span class="track"></span> Показать служебные
      </label>
      <label class="limit-field">Показывать
        <select id="branchListLimitInput">
          <option value="25">25</option>
          <option value="50">50</option>
          <option value="100">100</option>
          <option value="200">200</option>
          <option value="500">500</option>
          <option value="1000000">Все</option>
        </select>
      </label>
    </div>
    <label style="display:inline-block; margin:6px 0;" title="Выбирает/снимает выбор со всех веток, показанных ниже — то есть с учётом текущего фильтра, а не вообще всех веток репозитория">
      <input type="checkbox" id="selectAllVisibleBranches" /> Выбрать все
    </label>
    <button id="toggleAllCommitsBtn" class="secondary small-btn" style="margin:6px 0 6px 8px;" data-mode="expand">▸ Показать коммиты в dev (для всех)</button>
    <div id="branchListHeaderRow" class="branch-grid-row branch-header-row" style="display:none;">
      <div class="branch-rail-spacer"></div>
      <div class="chrono-cell chrono-header-cell">Ветка и последний коммит</div>
      <div class="chrono-cell chrono-header-cell" style="text-align:right;">Изменения</div>
    </div>
    <div id="branchList"><div class="muted branch-list-loading">Загрузка веток…</div></div>
    <div id="branchListInfo" class="muted" style="margin-top:6px;">Загрузка списка веток…</div>
    <div id="selectedSummary" class="muted" style="margin-top:6px;"></div>

    <div class="button-row">
      <button id="buildPlanBtn">Построить хронологию выбранных веток</button>
    </div>
    </div>
  </section>

  <section class="card">
    <div class="card-head clickable" id="itemsHeader">
      <span class="card-num">2</span>
      <div class="card-head-text">
        <h3 class="card-title">Хронология коммитов</h3>
        <div class="card-desc">Проверьте порядок коммитов перед сборкой релиза.</div>
      </div>
      <div class="card-head-extra">
        <button id="rebuildSyncBtn" class="icon-btn sync-btn" style="display:none;" title="Выбор веток изменился с последней сборки хронологии — нажмите, чтобы перестроить">
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13 3v3.5h-3.5M3 13v-3.5h3.5" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="M3.5 8a4.5 4.5 0 0 1 7.6-3.2l1.9 1.7M12.5 8a4.5 4.5 0 0 1-7.6 3.2l-1.9-1.7" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <span id="conflictSummaryTop"></span>
        <button id="clearPlanBtn" class="secondary small-btn">Очистить</button>
        <span class="collapse-arrow" id="itemsArrow">▾</span>
      </div>
    </div>
    <div class="collapsible-body" id="itemsBody">
      <div class="button-row" style="margin-top:0;">
        <button id="toggleContextBtn" class="secondary small-btn" style="display:none;"></button>
      </div>
      <div id="staleBranches" class="stale-branches"></div>
      <div id="chronoScroll" class="chrono-scroll">
        <div id="chronoInner" class="chrono-inner">
          <div id="chronoHeaderRow" class="chrono-header-row chrono-grid-row" style="display:none;">
            <div class="rail-spacer"></div>
            <div class="chrono-cell chrono-header-cell">Ветка</div>
            <div class="chrono-cell chrono-header-cell">Коммит</div>
            <div class="chrono-cell chrono-header-cell">Дата</div>
            <div class="chrono-cell chrono-header-cell">Автор</div>
          </div>
          <div id="items"></div>
          <div id="chronoSummaryRow" class="chrono-summary-row"></div>
        </div>
      </div>
    </div>
  </section>

  <section class="card" id="cherryPickSection" style="display:none;">
    <div class="card-head clickable" id="cherryPickHeader">
      <span class="card-num">3</span>
      <div class="card-head-text">
        <h3 class="card-title">Команда для ручного cherry-pick</h3>
      </div>
      <div class="card-head-extra">
        <button id="resetCopiedBtn" class="secondary small-btn">Сбросить состояние копирования</button>
        <span class="collapse-arrow" id="cherryPickArrow">▾</span>
      </div>
    </div>
    <div class="collapsible-body" id="cherryPickBody">
    <div id="cherryPickCommands"></div>
    </div>
  </section>

  <section class="card">
    <div class="card-head clickable" id="buildHeader">
      <span class="card-num">4</span>
      <div class="card-head-text">
        <h3 class="card-title">Сборка релизной ветки</h3>
      </div>
      <div class="card-head-extra">
        <span class="collapse-arrow" id="buildArrow">▾</span>
      </div>
    </div>
    <div class="collapsible-body" id="buildBody">
    <div class="field field-row">
      <label>Дата релиза (для имени релизной ветки):</label>
      <input type="text" id="releaseDate" />
    </div>
    <div class="button-row">
      <button id="createBranchBtn" class="btn-blue">Создать релизную ветку</button>
      <span class="muted" id="releaseBranchStatus"></span>
    </div>
    <div class="muted" id="releaseBranchInfo"></div>

    <div class="button-row" style="margin-top:10px;">
      <button id="startBtn" disabled class="btn-green">Начать сборку</button>
      <button id="abortBtn" class="btn-red">Отменить сборку</button>
    </div>
    <div id="buildStatus" class="muted" style="margin-top:4px;"></div>
    <div class="button-row" id="publishRow" style="display:none; margin-top:10px;">
      <button id="publishBtn">Опубликовать релизную ветку</button>
    </div>
    </div>
  </section>

<script>
  const vscode = acquireVsCodeApi();
  // Настоящие имена основной/dev-ветки из конфига (см. session.ts postCurrentBranch) — везде, где
  // раньше было жёстко зашито "main"/"dev" в тексте бейджей/подсказок, используем эти переменные,
  // чтобы текст совпадал с реальными настройками проекта, а не всегда говорил буквально "main".
  // Разумные значения по умолчанию — на случай, если что-то отрендерится до первого сообщения currentBranch.
  let configMainBranch = 'main';
  let configDevBranch = 'dev';
  let staleBranchesLookbackReleases = 4;
  let releaseBranchPatternCount = null;
  let lastStaleHints = null;
  let currentBranches = [];
  let selectedRefs = new Set();
  let selectionInitialized = false;
  let expandedRefs = new Set();
  const branchCommitsCache = new Map();
  const branchNameByRef = new Map();
  let currentPlan = null;
  let shaToBranch = new Map();
  let limitInitialized = false;
  // Ключи (sha через запятую) команд из блока "cherry-pick", которые уже скопированы — только
  // чтобы визуально притушить их (см. .cherry-cmd.copied) и не запутаться, что уже брали; сбрасывается
  // при новой хронологии (planBuilt) и вручную кнопкой "Сбросить состояние копирования".
  const copiedCherryCmdKeys = new Set();
  // Точный статус "в main", посчитанный из реального списка коммитов ветки (после разворачивания) —
  // здесь уже видно ПО КАЖДОМУ коммиту, попал он в main или нет, поэтому можно отличить "частично"
  // от "полностью". До разворачивания используется приблизительный b.mainStatus с сервера (см. MainStatus в types.ts).
  const branchMainStatusOverride = new Map();
  // Агрегированный +/- и число файлов на ветку целиком (см. BranchDiffStat в types.ts) — досчитывается
  // в фоне тем же проходом, что и точный статус "в main" (см. session.ts refineBranchMainStatus/
  // computeMainStatusForBranches), приходит позже самого списка веток, поэтому до первого такого
  // сообщения строки списка это просто не показывают (renderDiffStatInline вернёт '' без записи здесь).
  const branchDiffStatByRef = new Map();

  // Цвет назначается ПОСЛЕДОВАТЕЛЬНО, в порядке первого обращения (а не хэшем от имени) — так
  // соседние по времени/лейну ветки почти всегда получают максимально разнесённые оттенки. Шаг в
  // 137.508° (золотой угол) — стандартный приём для генерации произвольного числа цветов, каждый
  // из которых по кругу HSL максимально далёк от всех предыдущих, а не только от соседа по индексу
  // (в отличие от прежней hash % PALETTE.length, где двум одновременно активным веткам ничто не
  // мешало получить соседние — визуально похожие — цвета из фиксированной палитры).
  const colorAssignments = new Map();
  let nextColorIndex = 0;
  function colorFor(name) {
    if (!colorAssignments.has(name)) {
      colorAssignments.set(name, nextColorIndex++);
    }
    const hue = (colorAssignments.get(name) * 137.508) % 360;
    return \`hsl(\${hue.toFixed(1)}, 68%, 60%)\`;
  }

  function mainStatusBadge(status) {
    if (status === 'full') return \`<span class="badge inmain">уже в \${configMainBranch}</span>\`;
    if (status === 'partial') return \`<span class="badge partial-inmain">частично в \${configMainBranch}</span>\`;
    return '';
  }

  function effectiveMainStatus(ref, fallback) {
    return branchMainStatusOverride.get(ref) || fallback;
  }

  // "+N"/"-M" числа изменённых строк (см. PlanItem.insertions/deletions). Раньше рисовались прямо на
  // графе (вертикальным текстом вдоль дорожки ветки) — при мелком шрифте и развороте в разные стороны
  // у "+" и "-" читать их было практически невозможно; сейчас у коммитов выбранных веток это отдельная
  // колонка .col-changes (см. renderItemRow), а не часть строки со ссылками. У context/anchor-коммитов
  // (CommitInfo, не PlanItem) полей insertions/deletions нет — для них рендерится пустая строка.
  function renderDiffStatInline(entity) {
    const insertions = entity.insertions || 0;
    const deletions = entity.deletions || 0;
    // filesChanged — только у агрегированной сводки по ветке целиком (см. branchDiffStatByRef/
    // BranchDiffStat в types.ts), у отдельного коммита (PlanItem/BranchCommitInfo) этого поля нет
    // и не будет — там же и так виден список конкретных файлов при разворачивании.
    const filesChanged = entity.filesChanged || 0;
    if (!insertions && !deletions && !filesChanged) return '';
    let out = '<span class="diffstat">';
    if (insertions) out += \`<span class="diffstat-add">+\${formatDiffCount(insertions)}</span>\`;
    if (deletions) out += \`<span class="diffstat-del">-\${formatDiffCount(deletions)}</span>\`;
    out += '</span>';
    if (filesChanged) out += \` <span class="muted">(\${filesChanged} файл(ов))</span>\`;
    return out;
  }

  // includeDiffStat=false — у коммитов выбранных веток (renderItemRow) диффstat теперь в СВОЕЙ колонке
  // .col-changes, поэтому здесь он лишний; у context/anchor-строк (нет своей колонки изменений — там
  // просто пустая ячейка, см. .col-changes в renderContextRow/renderAnchorRow) остаётся дефолт true,
  // хотя renderDiffStatInline для них и так вернёт '' (у CommitInfo нет insertions/deletions).
  function renderLinks(entity, includeDiffStat = true) {
    const links = [];
    if (entity.taskUrl) links.push(\`<a href="\${entity.taskUrl}" target="_blank" rel="noopener">Задача</a>\`);
    if (entity.prUrl) links.push(\`<a href="\${entity.prUrl}" target="_blank" rel="noopener">PR #\${entity.prNumber}</a>\`);
    if (entity.commitUrl) links.push(\`<a href="\${entity.commitUrl}" target="_blank" rel="noopener">коммит</a>\`);
    if (includeDiffStat) {
      const diffStat = renderDiffStatInline(entity);
      if (diffStat) links.push(diffStat);
    }
    return links.length ? \`<div class="links">\${links.join('')}</div>\` : '';
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  }

  function formatDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    const p2 = (n) => String(n).padStart(2, '0');
    return \`\${p2(d.getDate())}.\${p2(d.getMonth()+1)}.\${d.getFullYear()} \${p2(d.getHours())}:\${p2(d.getMinutes())}:\${p2(d.getSeconds())}\`;
  }

  function showError(message) {
    const el = document.getElementById('error');
    document.getElementById('errorText').textContent = message;
    el.style.display = message ? 'flex' : 'none';
    if (message) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  showError('');
  // Закрыть текущую ошибку вручную, не дожидаясь следующей (иначе она висит, пока её не сменит новая).
  document.getElementById('errorCloseBtn').addEventListener('click', () => showError(''));

  function todayIso() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
  }
  document.getElementById('releaseDate').value = todayIso();

  // Дизейблит "Создать релизную ветку", если ветка с именем для введённой даты уже существует
  // (см. session.ts onCheckReleaseDate/postReleaseDateCheck) — нет смысла создавать повторно,
  // нужно продолжать сборку уже имеющейся. Дебаунс — чтобы не слать сообщение на каждую нажатую
  // клавишу при вводе даты вручную.
  let releaseDateCheckDebounce = null;
  function requestReleaseDateCheck() {
    const value = document.getElementById('releaseDate').value.trim();
    vscode.postMessage({ command: 'checkReleaseDate', releaseDate: value });
  }
  document.getElementById('releaseDate').addEventListener('input', () => {
    clearTimeout(releaseDateCheckDebounce);
    releaseDateCheckDebounce = setTimeout(requestReleaseDateCheck, 200);
  });
  requestReleaseDateCheck();

  function deselectBranch(ref) {
    selectedRefs.delete(ref);
    updateSelectedSummary();
    renderBranches();
  }

  function clearSelectedBranches() {
    selectedRefs.clear();
    updateSelectedSummary();
    renderBranches();
  }

  function updateSelectedSummary() {
    const el = document.getElementById('selectedSummary');
    if (selectedRefs.size === 0) {
      el.textContent = 'Ветки не выбраны';
    } else {
      const chips = [...selectedRefs].map((ref) => {
        const name = branchNameByRef.get(ref) || ref;
        // Цвет чипа — тот же colorFor(name), что и у дорожки ветки на графе, чтобы выбор в списке и
        // сама хронология были визуально связаны (см. .cherry-sha — тот же приём для sha в командах).
        return \`<span class="chip" style="background:\${colorFor(name)};color:#000;">\${name} <button class="chip-remove" data-ref="\${ref}" title="Убрать из выбора">×</button></span>\`;
      }).join('');
      // Крестик очистки всего выбора — только когда есть что чистить (при 0 выбранных сам текст
      // уже другой, см. ветку выше, кнопке рядом с "Ветки не выбраны" просто нечего делать).
      el.innerHTML = \`<button id="clearSelectedBtn" class="clear-all-btn" title="Очистить выбранное">×</button> Выбрано (\${selectedRefs.size}): \${chips}\`;
      document.getElementById('clearSelectedBtn').addEventListener('click', clearSelectedBranches);

      [...el.querySelectorAll('.chip-remove')].forEach((btn) => {
        btn.addEventListener('click', (e) => deselectBranch(e.target.dataset.ref));
      });
    }
    updateSyncIndicator();
    updateStaleAddButtons();
  }

  // "Синхронизация" хронологии с текущим выбором веток (см. #rebuildSyncBtn в card-head
  // "Хронология коммитов") — сравнение по ИМЕНАМ веток (а не refs), потому что именно имена
  // реально лежат в уже построенном plan.items; зелёная — состав совпадает, красная — выбор с
  // последней сборки хронологии успел измениться (клик перестраивает, как "Построить хронологию").
  function computeSyncState() {
    if (!currentPlan) return null;
    const planBranches = new Set(currentPlan.items.map((i) => i.branch));
    const selectedBranches = new Set([...selectedRefs].map((ref) => branchNameByRef.get(ref) || ref));
    if (planBranches.size !== selectedBranches.size) return false;
    for (const b of planBranches) {
      if (!selectedBranches.has(b)) return false;
    }
    return true;
  }

  function updateSyncIndicator() {
    const btn = document.getElementById('rebuildSyncBtn');
    const inSync = computeSyncState();
    if (inSync === null) {
      btn.style.display = 'none';
      return;
    }
    btn.style.display = '';
    btn.classList.toggle('sync-bad', !inSync);
    btn.classList.toggle('sync-ok', inSync);
    btn.title = inSync
      ? 'Хронология соответствует текущему выбору веток'
      : 'Выбор веток изменился с последней сборки хронологии — нажмите, чтобы перестроить';
  }

  function renderBranchCommits(ref) {
    const entry = branchCommitsCache.get(ref);
    if (entry === 'loading') return '<div class="branch-commits muted inline-loading">Загрузка коммитов…</div>';
    if (!entry) return '';
    const { commits, truncated, forkedFrom } = entry;
    const forkedFromNote = forkedFrom
      ? \`<div class="branch-commits muted">Ветка заведена не от \${configDevBranch}, а от <b>\${escapeHtml(forkedFrom)}</b> — коммиты показаны относительно неё</div>\`
      : '';
    if (commits.length === 0) return forkedFromNote + \`<div class="branch-commits muted">Нет коммитов, отсутствующих в \${configDevBranch}-ветке (см. настройку Dev-ветка)</div>\`;
    const truncatedNote = truncated
      ? \`<div class="branch-commits muted">Показаны не все коммиты (их слишком много) — возможно, \${configDevBranch}-ветка сильно отстала или указана неверно в настройках</div>\`
      : '';
    return forkedFromNote + '<div class="branch-commits">' + commits.map((c) => \`
      <div class="branch-commit-row"><span class="sha">\${c.sha.slice(0,8)}</span> · \${formatDate(c.authorDate)} · \${c.authorName} · \${c.subject} \${c.alreadyInMain ? \`<span class="badge inmain">уже в \${configMainBranch}</span>\` : ''} \${renderLinks(c)}</div>
    \`).join('') + truncatedNote + '</div>';
  }

  // Прямая линия своего цвета на каждую ветку в списке (см. .branch-rail-overlay в CSS) — НЕ тот
  // же граф, что в хронологии (там реальные лейны/ветвления/слияния, см. computeRail/drawRail):
  // тут просто одна дорожка на весь список, без разбора кто от кого ветвился, только чтобы цвет
  // ветки был виден сразу слева, как визуальная привязка к остальным местам с тем же colorFor.
  // Каждый сегмент между двумя соседними точками красится в цвет НИЖНЕЙ (более новой) ветки.
  function drawBranchRail(branchNames, rowCenters) {
    const x = 11;
    const r = 4;
    const lines = [];
    const dots = [];
    branchNames.forEach((name, idx) => {
      const color = colorFor(name);
      if (idx > 0) {
        lines.push(\`<line x1="\${x}" y1="\${rowCenters[idx - 1]}" x2="\${x}" y2="\${rowCenters[idx]}" stroke="\${color}" stroke-width="2" />\`);
      }
      dots.push(\`<circle cx="\${x}" cy="\${rowCenters[idx]}" r="\${r}" fill="\${color}" />\`);
    });
    return lines.join('') + dots.join('');
  }

  let branchRailRenderGeneration = 0;
  let branchRailResizeObserver = null;

  function renderBranches() {
    const myGeneration = ++branchRailRenderGeneration;
    if (branchRailResizeObserver) {
      branchRailResizeObserver.disconnect();
      branchRailResizeObserver = null;
    }
    // "Скрыть уже в main" применяется на сервере ДО среза по лимиту (см. session.ts
    // sendBranchSlice) — сюда уже приходит нужный список, дополнительно фильтровать не нужно.
    const el = document.getElementById('branchList');
    document.getElementById('branchListHeaderRow').style.display = currentBranches.length > 0 ? '' : 'none';
    el.innerHTML = '<div class="branch-rail-overlay" id="branchRailOverlay"></div>' + (currentBranches.map((b) => {
      const expanded = expandedRefs.has(b.ref);
      const status = effectiveMainStatus(b.ref, b.mainStatus);
      // Агрегированный diffstat досчитывается фоном ПОСЛЕ самого списка (см. branchDiffStatByRef
      // выше) — своя колонка "Изменения" справа (см. .col-branch-diffstat), а не часть строки со
      // ссылками (includeDiffStat=false), как раньше. .has(), а не просто .get() || {} — нужно
      // отличить "уже посчитано, изменений реально 0" (пустая ячейка) от "фон ещё не досчитал"
      // (спиннер), иначе спиннер держался бы только на нулевых ветках вечно.
      const diffStatCell = branchDiffStatByRef.has(b.ref)
        ? renderDiffStatInline(branchDiffStatByRef.get(b.ref))
        : '<span class="inline-loading"></span>';
      return \`
      <div class="branch-grid-row branch-row \${b.isRemote ? 'remote' : ''}">
        <div class="branch-rail-spacer"></div>
        <div class="chrono-cell col-branch-info">
          <div class="branch-row-main">
            <input type="checkbox" class="branch-check" data-ref="\${b.ref}" \${selectedRefs.has(b.ref) ? 'checked' : ''} />
            <div class="branch-main">
              <div><span class="branch-name">\${b.name}</span> \${mainStatusBadge(status)}</div>
              <div class="muted sha">\${b.lastCommitSha ? b.lastCommitSha.slice(0,8) : ''} · \${formatDate(b.lastCommitDate)} · \${b.lastCommitAuthor} · \${b.lastCommitSubject}</div>
              \${renderLinks(b, false)}
              <button class="link expand-toggle" data-ref="\${b.ref}">\${expanded ? '▾ скрыть коммиты' : \`▸ показать коммиты (относительно \${configDevBranch}-ветки)\`}</button>
              \${expanded ? renderBranchCommits(b.ref) : ''}
            </div>
          </div>
        </div>
        <div class="chrono-cell col-branch-diffstat">\${diffStatCell}</div>
      </div>
    \`;
    }).join('') || \`<div class="muted" style="padding:6px 8px;">Ничего не найдено (проверьте фильтр или переключатели выше)</div>\`);

    [...el.querySelectorAll('.branch-check')].forEach((cb) => {
      cb.addEventListener('change', (e) => {
        if (e.target.checked) selectedRefs.add(e.target.dataset.ref);
        else selectedRefs.delete(e.target.dataset.ref);
        updateSelectedSummary();
      });
    });
    [...el.querySelectorAll('.expand-toggle')].forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const ref = e.target.dataset.ref;
        if (expandedRefs.has(ref)) {
          expandedRefs.delete(ref);
        } else {
          expandedRefs.add(ref);
          if (!branchCommitsCache.has(ref)) {
            branchCommitsCache.set(ref, 'loading');
            vscode.postMessage({ command: 'expandBranch', ref });
          }
        }
        renderBranches();
      });
    });

    // "Выбрать все" отражает состояние ПОКАЗАННЫХ веток (currentBranches — уже отфильтрованный/
    // урезанный лимитом срез с сервера, см. session.ts sendBranchSlice), а не вообще всех веток
    // репозитория — отмечен, только если ВСЕ показанные сейчас строки выбраны.
    document.getElementById('selectAllVisibleBranches').checked =
      currentBranches.length > 0 && currentBranches.every((b) => selectedRefs.has(b.ref));
    updateToggleAllCommitsBtn();

    // Тот же приём, что и в drawRailNow хронологии (см. ниже, renderItems): координаты по
    // офсетам реально отрендеренных строк, а не подгонка под фиксированную высоту — перенос текста
    // темы/имени ветки на несколько строк не ломает линию. #branchList сам скроллится и сам же
    // position:relative — оверлей — просто первый ребёнок, а не отдельный внешний контейнер.
    const drawBranchRailNow = () => {
      if (myGeneration !== branchRailRenderGeneration) return;
      const rowEls = [...el.querySelectorAll('.branch-row')];
      if (rowEls.length === 0) return;
      const rowCenters = rowEls.map((r) => r.offsetTop + r.offsetHeight / 2);
      const branchNames = currentBranches.map((b) => b.name);
      const overlay = document.getElementById('branchRailOverlay');
      if (!overlay) return;
      const containerHeight = el.scrollHeight;
      overlay.style.width = '22px';
      overlay.style.height = containerHeight + 'px';
      overlay.innerHTML = \`<svg width="22" height="\${containerHeight}" style="overflow:visible">\${drawBranchRail(branchNames, rowCenters)}</svg>\`;
    };
    drawBranchRailNow();
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(drawBranchRailNow);
    }
    if (typeof ResizeObserver !== 'undefined') {
      let resizeFrame = null;
      branchRailResizeObserver = new ResizeObserver(() => {
        if (resizeFrame !== null) return;
        resizeFrame = requestAnimationFrame(() => {
          resizeFrame = null;
          drawBranchRailNow();
        });
      });
      branchRailResizeObserver.observe(el);
    }
  }

  // Статический чекбокс (часть HTML-шаблона, не перерисовывается) — слушатель навешивается один
  // раз, а не внутри renderBranches(), иначе на каждый рендер списка веток накапливался бы ещё один.
  document.getElementById('selectAllVisibleBranches').addEventListener('change', (e) => {
    const checked = e.target.checked;
    for (const b of currentBranches) {
      if (checked) selectedRefs.add(b.ref);
      else selectedRefs.delete(b.ref);
    }
    updateSelectedSummary();
    renderBranches();
  });

  // Текст/режим пересчитывается КАЖДЫЙ рендер по факту (все ли ПОКАЗАННЫЕ ветки сейчас развёрнуты)
  // — тот же приём, что и у "Выбрать все" чуть выше, а не отдельный независимый флаг: иначе кнопка
  // могла бы разойтись с реальным состоянием, если пользователь сам развернул/свернул одну ветку
  // вручную (см. .expand-toggle).
  function updateToggleAllCommitsBtn() {
    const btn = document.getElementById('toggleAllCommitsBtn');
    const allExpanded = currentBranches.length > 0 && currentBranches.every((b) => expandedRefs.has(b.ref));
    btn.dataset.mode = allExpanded ? 'collapse' : 'expand';
    btn.textContent = allExpanded
      ? \`▾ Скрыть коммиты в \${configDevBranch} (для всех)\`
      : \`▸ Показать коммиты в \${configDevBranch} (для всех)\`;
  }
  document.getElementById('toggleAllCommitsBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    const expand = e.target.dataset.mode !== 'collapse';
    for (const b of currentBranches) {
      if (expand) {
        expandedRefs.add(b.ref);
        if (!branchCommitsCache.has(b.ref)) {
          branchCommitsCache.set(b.ref, 'loading');
          vscode.postMessage({ command: 'expandBranch', ref: b.ref });
        }
      } else {
        expandedRefs.delete(b.ref);
      }
    }
    renderBranches();
  });

  // Список опций селекта "Текущая ветка" — из того же currentBranches (уже отфильтрованный/
  // урезанный лимитом срез с сервера, см. session.ts sendBranchSlice), что и раньше питал datalist
  // свободного текстового поля "Pull ветку". Реальный ТЕКУЩИЙ checkout (currentBranchValue, см.
  // 'currentBranch' ниже) и настроенная основная/dev ветка гарантированно попадают в список, даже
  // если их не видно в текущем срезе (иначе выбор мог бы "потерять" ветку, на которой мы стоим).
  let currentBranchValue = '';
  // Последний ответ на 'checkReleaseDate' (см. onCheckReleaseDate в session.ts) — реактивно
  // пересчитывает disabled у "Создать релизную ветку" при ЛЮБОМ изменении currentBranchValue, а
  // не только когда сам сервер явно переспрашивает дату: onStartBuilding создаёт/чекаутит ветку и
  // шлёт свежий 'currentBranch', но НЕ переспрашивает checkReleaseDate заново — без этой реактивной
  // привязки кнопка молча оставалась активной до следующего изменения поля даты.
  let lastReleaseDateCheck = { branchName: null, exists: false };
  function updateCreateBranchBtnState() {
    document.getElementById('createBranchBtn').disabled =
      lastReleaseDateCheck.exists ||
      (!!lastReleaseDateCheck.branchName && currentBranchValue === lastReleaseDateCheck.branchName);
  }
  function renderCurrentBranchSelect() {
    const names = new Set(currentBranches.map((b) => b.name));
    [currentBranchValue, configMainBranch, configDevBranch].forEach((n) => n && names.add(n));
    const select = document.getElementById('currentBranchSelect');
    select.innerHTML = [...names].sort().map((n) => \`<option value="\${escapeHtml(n)}"\${n === currentBranchValue ? ' selected' : ''}>\${escapeHtml(n)}</option>\`).join('');
  }
  document.getElementById('currentBranchSelect').addEventListener('change', (e) => {
    showError('');
    vscode.postMessage({ command: 'switchBranch', branch: e.target.value });
  });

  let filterDebounce = null;
  document.getElementById('branchFilter').addEventListener('input', (e) => {
    clearTimeout(filterDebounce);
    const query = e.target.value;
    // Мгновенная обратная связь ДО завершения debounce/запроса — иначе непонятно, идёт ли поиск,
    // особенно если предыдущий запрос ещё не успел вернуться (см. обработку 'branches' ниже, где
    // это же поле сбрасывается настоящим результатом).
    document.getElementById('branchListInfo').innerHTML = '<span class="inline-loading">Поиск…</span>';
    filterDebounce = setTimeout(() => vscode.postMessage({ command: 'filterBranches', query }), 150);
  });
  // "Скрыть уже в main" и лимит показа применяются ВМЕСТЕ, одним вызовом (см. session.ts
  // sendBranchSlice) — но теперь оба реактивны, без кнопки "Применить": лимит — обычный select с
  // пресетами (сам по себе дискретный, debounce не нужен), "скрыть в main" и служебные — переключатели,
  // тоже дискретные события change, а не непрерывный ввод текста.
  function applyBranchFilters() {
    const limit = parseInt(document.getElementById('branchListLimitInput').value, 10);
    const hideAlreadyInMain = document.getElementById('hideInMainFilter').checked;
    showError('');
    document.getElementById('branchListInfo').innerHTML = '<span class="inline-loading">Обновление списка веток…</span>';
    vscode.postMessage({ command: 'setBranchListLimit', limit, hideAlreadyInMain });
  }
  document.getElementById('branchListLimitInput').addEventListener('change', applyBranchFilters);
  document.getElementById('hideInMainFilter').addEventListener('change', applyBranchFilters);
  // В отличие от "скрыть уже в main" (нужен git-вызов), это просто проверка префикса имени —
  // дёшево, применяется сразу же при переключении. Переключатель называется "Показать служебные"
  // (позитивная формулировка, включён = показаны), а сообщению на сервер всё ещё нужен hide —
  // поэтому здесь инвертируем.
  document.getElementById('hideServiceBranchesFilter').addEventListener('change', (e) => {
    document.getElementById('branchListInfo').innerHTML = '<span class="inline-loading">Обновление списка веток…</span>';
    vscode.postMessage({ command: 'setHideServiceBranches', hide: !e.target.checked });
  });
  function setRefreshBusy(busy) {
    const btn = document.getElementById('refreshBtn');
    btn.disabled = busy;
    btn.innerHTML = busy ? '<span class="inline-loading">Обновляем…</span>' : 'Обновить список веток';
  }
  function setPullBusy(busy) {
    const btn = document.getElementById('pullBtn');
    btn.disabled = busy;
    btn.innerHTML = busy ? '<span class="inline-loading">Pull…</span>' : 'Pull';
  }

  document.getElementById('refreshBtn').addEventListener('click', (e) => {
    e.stopPropagation(); // кнопка теперь внутри кликабельного заголовка карточки "Ветки"
    document.getElementById('branchListInfo').innerHTML = '<span class="inline-loading">Обновление списка веток…</span>';
    setRefreshBusy(true);
    vscode.postMessage({ command: 'refreshBranches' });
  });
  document.getElementById('abortBtn').addEventListener('click', () => vscode.postMessage({ command: 'abortBuild' }));

  // Если список веток долго не приходит — вероятно, в репозитории очень много веток и git-вызов идёт долго
  setTimeout(() => {
    if (currentBranches.length === 0) {
      document.getElementById('branchListInfo').textContent =
        'Список веток долго не появляется. Если в репозитории очень много веток, это может занять время — подождите, либо уменьшите лимит в настройках.';
    }
  }, 8000);
  // Переключение на другую ветку — отдельным селектом "Текущая ветка" выше (checkout только там).
  // Pull здесь применяется к уже выбранной ветке, без параметра имени и без checkout.
  document.getElementById('pullBtn').addEventListener('click', () => {
    showError('');
    setPullBusy(true);
    vscode.postMessage({ command: 'pullCurrentBranch' });
  });

  function setBuildPlanBusy(busy) {
    const btn = document.getElementById('buildPlanBtn');
    btn.disabled = busy;
    // Dry-run теперь запускается автоматически сразу после построения хронологии — один и тот же
    // busy-статус кнопки покрывает оба шага, отдельного индикатора для dry-run больше не нужно.
    btn.innerHTML = busy ? '<span class="inline-loading">Строим хронологию и проверяем конфликты…</span>' : 'Построить хронологию выбранных веток';
    // Пока строится (или перестраивается) хронология, иконка синхронизации крутится — тот же
    // сигнал "идёт работа", что и спиннер на кнопке, но там, где реально смотрят в процессе
    // перестроения (рядом с "Конфликты"), а не только на самой кнопке ниже.
    document.getElementById('rebuildSyncBtn').classList.toggle('spinning', busy);
  }

  function requestBuildPlan() {
    showError('');
    setBuildPlanBusy(true);
    vscode.postMessage({ command: 'buildPlan', selectedRefs: [...selectedRefs] });
  }
  document.getElementById('buildPlanBtn').addEventListener('click', requestBuildPlan);
  document.getElementById('rebuildSyncBtn').addEventListener('click', (e) => {
    e.stopPropagation(); // внутри кликабельного заголовка карточки, см. wireCollapsibleCard
    requestBuildPlan();
  });

  document.getElementById('clearPlanBtn').addEventListener('click', (e) => {
    e.stopPropagation(); // кнопка теперь внутри кликабельного заголовка карточки — иначе клик ещё и свернул/развернул бы её
    showError('');
    vscode.postMessage({ command: 'clearPlan' });
  });

  // Каждый пронумерованный блок сворачивается точно так же, как раньше умела только "Хронология
  // коммитов" (см. itemsHeader) — общий обработчик вместо четырёх копий одного и того же кода.
  function wireCollapsibleCard(headId, bodyId, arrowId) {
    const head = document.getElementById(headId);
    const body = document.getElementById(bodyId);
    const arrow = document.getElementById(arrowId);
    let collapsed = false;
    head.addEventListener('click', () => {
      collapsed = !collapsed;
      body.classList.toggle('collapsed', collapsed);
      arrow.textContent = collapsed ? '▸' : '▾';
    });
  }
  wireCollapsibleCard('branchesHeader', 'branchesBody', 'branchesArrow');
  wireCollapsibleCard('itemsHeader', 'itemsBody', 'itemsArrow');
  wireCollapsibleCard('cherryPickHeader', 'cherryPickBody', 'cherryPickArrow');
  wireCollapsibleCard('buildHeader', 'buildBody', 'buildArrow');

  // Номера у карточек (см. .card-num) не зашиты в разметку — блок "Команда для ручного
  // cherry-pick" показывается не всегда (только пока есть что применять вручную, см.
  // renderCherryPickCommands), и статичное "1 2 3 4" на месте скрытого блока превратилось бы в
  // сбивающее с толку "1 2 4". Пересчитывается по фактически видимым .card-num при каждом
  // изменении видимости блока cherry-pick.
  function renumberCards() {
    let n = 0;
    document.querySelectorAll('.card-num').forEach((el) => {
      const section = el.closest('section');
      if (section && section.style.display === 'none') return;
      n++;
      el.textContent = String(n);
    });
  }
  renumberCards();

  let contextCollapsed = true;
  document.getElementById('toggleContextBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    contextCollapsed = !contextCollapsed;
    renderItems();
  });

  document.getElementById('resetCopiedBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    copiedCherryCmdKeys.clear();
    renderCherryPickCommands();
  });

  // Инпут N живёт прямо в этом блоке (а не в настройках) — меняется по ходу работы с хронологией,
  // без похода в настройки, но НЕ пересчитывает уже показанный список сразу: значение учитывается
  // только со следующего нажатия "Построить хронологию" (см. onSetStaleBranchesLookback в session.ts).
  function renderStaleBranchesControls() {
    // Количество веток по шаблону релизной ветки (см. session.ts postReleaseBranchPatternCount) —
    // раньше отдельной строкой над списком веток, отдельно от самого окна поиска, которое им и
    // ограничено; показываем прямо тут, как "из скольких всего" — null, пока ответ ещё не пришёл.
    const totalNote = releaseBranchPatternCount !== null ? \` из \${releaseBranchPatternCount}\` : '';
    return \`<div class="stale-branches-controls muted">Окно поиска — последние
      <input type="number" id="staleBranchesLookbackInput" min="1" step="1" value="\${staleBranchesLookbackReleases}" style="width:3em;" />
      релиз(ов)\${totalNote}. Изменение применится при следующем построении хронологии.</div>\`;
  }

  function bindStaleBranchesLookbackInput() {
    const input = document.getElementById('staleBranchesLookbackInput');
    if (!input) return;
    input.addEventListener('change', () => {
      const value = parseInt(input.value, 10);
      if (!Number.isFinite(value) || value < 1) {
        input.value = String(staleBranchesLookbackReleases);
        return;
      }
      staleBranchesLookbackReleases = value;
      vscode.postMessage({ command: 'setStaleBranchesLookback', value });
    });
  }

  function renderStaleBranchesLoading() {
    document.getElementById('staleBranches').innerHTML = renderStaleBranchesControls() +
      '<div class="muted inline-loading">Проверяем, нет ли забытых или не выбранных в релиз веток…</div>';
    bindStaleBranchesLookbackInput();
  }

  // Два независимых сигнала под одной подсказкой (см. findStaleUnmergedBranches в planner.ts,
  // runFindStaleBranches в session.ts): (а) ветка отсоединилась от dev раньше самой ранней выбранной
  // в текущей хронологии ветки, (б) ветка просто не отмечена чекбоксом и не трогалась дольше "окна"
  // последних N релизов — в обоих случаях смысл один: "возможно, где-то забытая задача".
  function addStaleBranchToRelease(ref) {
    selectedRefs.add(ref);
    updateSelectedSummary();
    renderBranches();
  }

  // Реагирует на ЛЮБОЕ изменение selectedRefs (чекбоксы веток, chip-remove в "Выбрано", сам клик
  // по "+") — вызывается из updateSelectedSummary, единой точки, куда уже стекаются все такие
  // изменения. Не только "+" → "✓" при добавлении, но и обратно, если ветку потом убрали из
  // выбора (например, крестиком в чипе) — кнопка снова становится активной.
  function updateStaleAddButtons() {
    [...document.querySelectorAll('.stale-add-btn')].forEach((btn) => {
      const added = selectedRefs.has(btn.dataset.ref);
      btn.disabled = added;
      btn.classList.toggle('added', added);
      btn.textContent = added ? '✓' : '+';
    });
  }

  function renderStaleBranches(hints) {
    const el = document.getElementById('staleBranches');
    let body;
    if (!hints || hints.length === 0) {
      body = '<div class="muted">Забытых или давно не выбранных в релиз веток не нашлось.</div>';
    } else {
      body = '<div class="muted" style="margin:4px 0;">Отсоединились раньше самого свежего коммита среди уже выбранных веток в этой хронологии, либо не выбраны в релиз в пределах окна последних релизов, и ещё не выпущены — возможно, забыли:</div>' +
        hints.map((h) => {
          const link = h.commitUrl ? \`<a href="\${h.commitUrl}" target="_blank" rel="noopener">\${h.sha.slice(0,8)}</a>\` : h.sha.slice(0,8);
          const taskLink = h.taskUrl ? \` · <a href="\${h.taskUrl}" target="_blank" rel="noopener">задача</a>\` : '';
          // Цвет ветки — тот же colorFor, что и на графе хронологии/в чипах выбора, чтобы забытую
          // ветку сразу можно было визуально соотнести с остальной панелью. Кнопка "+" добавляет её
          // в выбор БЕЗ перестроения хронологии — оно, если нужно, отдельным действием (см. кнопку
          // синхронизации рядом с "Конфликты" — после добавления она станет красной). Начальное
          // disabled/"✓" — на случай, если ветка уже добавлена в предыдущий раз (см. updateStaleAddButtons).
          const alreadyAdded = selectedRefs.has(h.ref);
          return \`<div class="stale-branch-row">→ <span class="chip" style="background:\${colorFor(h.branch)};color:#000;">\${escapeHtml(h.branch)}</span> <button class="stale-add-btn\${alreadyAdded ? ' added' : ''}" data-ref="\${escapeHtml(h.ref)}" title="Добавить в релиз" \${alreadyAdded ? 'disabled' : ''}>\${alreadyAdded ? '✓' : '+'}</button> — «\${escapeHtml(h.subject)}», \${link} · \${escapeHtml(h.authorName)} · \${formatDate(h.authorDate)}\${taskLink}</div>\`;
        }).join('');
    }
    el.innerHTML = renderStaleBranchesControls() + body;
    [...el.querySelectorAll('.stale-add-btn')].forEach((btn) => {
      btn.addEventListener('click', () => addStaleBranchToRelease(btn.dataset.ref));
    });
    bindStaleBranchesLookbackInput();
  }

  document.getElementById('createBranchBtn').addEventListener('click', () => {
    showError('');
    vscode.postMessage({ command: 'startBuilding', releaseDate: document.getElementById('releaseDate').value.trim() });
  });

  // startBusy/publishBusy — busy-состояние самой длительной операции (реальный cherry-pick/push),
  // а не построения хронологии (то отдельно, см. setBuildPlanBusy) — пока идёт, кнопка недоступна
  // и показывает спиннер, чтобы не выглядело, будто расширение зависло.
  let startBusy = false;
  let publishBusy = false;

  document.getElementById('startBtn').addEventListener('click', () => {
    startBusy = true;
    document.getElementById('startBtn').innerHTML = '<span class="inline-loading">Собираем…</span>';
    updateBuildButtonsState();
    vscode.postMessage({ command: 'startAuto' });
  });
  document.getElementById('publishBtn').addEventListener('click', () => {
    publishBusy = true;
    document.getElementById('publishBtn').innerHTML = '<span class="inline-loading">Публикуем…</span>';
    updateBuildButtonsState();
    vscode.postMessage({ command: 'publishRelease' });
  });

  // Единый источник правды для состояния сборки — считается из currentPlan.items (included/applied),
  // а не из отдельного клиентского флага, поэтому всегда актуален и после полной пересборки плана
  // (planBuilt), и после каждого шага применения (см. 'progress' ниже, где applied проставляется
  // на конкретном item без пересборки всего плана).
  function updateBuildButtonsState() {
    const hasReleaseBranch = !!(currentPlan && currentPlan.releaseBranch);
    // releaseBranch сам по себе не значит "есть что собирать" — emptyPlanFor (см. session.ts)
    // заводит план с пустым items ещё до того, как хронология реально построена/восстановлена
    // (например, релизная ветка уже полностью выпущена в main — см. releaseBranchInfo). Без этой
    // проверки "Начать сборку" была бы активна и кликабельна, хотя нечего применять.
    const hasItems = hasReleaseBranch && currentPlan.items.length > 0;
    // Отдельно от hasItems: сама хронология может быть непустой, но ПОЛНОСТЬЮ уже применённой
    // (например, релизная ветка восстановлена по факту git-истории — см. tryReconstructPlanFromReleaseBranch
    // в session.ts — и все её коммиты уже отмечены applied, новых веток не добавляли) — applyAll
    // (executor.ts) в этом случае фильтрует всё до пустого списка и ничего не делает, поэтому кнопка
    // должна быть недоступна, а не просто "не пустая".
    const hasPending = hasItems && currentPlan.items.some((i) => i.included && !i.applied);
    const startBtn = document.getElementById('startBtn');
    startBtn.disabled = !hasPending || startBusy;
    if (!startBusy) {
      // Если что-то в плане уже реально применено (в т.ч. восстановлено при попадании на
      // существующую релизную ветку, см. planBuilt/applied) — "Продолжить сборку" точнее
      // отражает реальность, чем "Начать сборку". Пустая свежесозданная ветка — по дефолту
      // "Начать сборку" (hasItems=true, но applied ни у одного пункта ещё нет).
      startBtn.textContent = hasItems && currentPlan.items.some((i) => i.applied) ? 'Продолжить сборку' : 'Начать сборку';
    }
    document.getElementById('publishBtn').disabled = publishBusy;
    if (hasReleaseBranch) {
      document.getElementById('releaseBranchStatus').textContent = 'Релизная ветка: ' + currentPlan.releaseBranch;
    } else {
      // currentPlan.releaseBranch пуст просто потому, что сборка в ЭТОЙ сессии/плане ещё не
      // стартовала — это НЕ значит, что подходящей под введённую дату ветки нет в git вообще
      // (она вполне может уже существовать, например после перезапуска панели или перестроения
      // хронологии). Жёстко писать сюда "ещё не создана" тут же затирало верный ответ, который
      // уже пришёл через checkReleaseDate — вместо этого просто перезапрашиваем его заново, он
      // сам проставит правильный текст (см. releaseDateCheck ниже).
      requestReleaseDateCheck();
    }

    const statusEl = document.getElementById('buildStatus');
    const publishRow = document.getElementById('publishRow');
    if (!hasReleaseBranch) {
      statusEl.textContent = '';
      publishRow.style.display = 'none';
      return;
    }
    if (!hasItems) {
      // ПОЧЕМУ пусто (уже выпущена в main / просто пока пустая) объясняет releaseBranchInfo — здесь
      // нейтральный статус, без слова "отмеченных": это подразумевало бы, что коммиты есть, просто
      // не выбраны, а тут их вовсе нет.
      statusEl.textContent = 'В хронологии нет коммитов.';
      publishRow.style.display = 'none';
      return;
    }
    const included = currentPlan.items.filter((i) => i.included);
    const appliedCount = included.filter((i) => i.applied).length;
    const total = included.length;
    if (total === 0) {
      statusEl.textContent = 'В хронологии нет отмеченных коммитов.';
      publishRow.style.display = 'none';
    } else if (appliedCount === total) {
      statusEl.innerHTML = \`<span style="color:var(--vscode-charts-green);">✓ Релиз собран — применено \${total} из \${total} коммитов.</span>\`;
      publishRow.style.display = '';
    } else {
      statusEl.textContent = \`Применено \${appliedCount} из \${total} коммитов.\`;
      publishRow.style.display = 'none';
    }
  }

  // Реальный источник dry-run конфликта на файл — не догадка по пересечению файлов, а фактический
  // "кто последним менял этот файл" в состоянии worktree непосредственно перед конфликтом (main +
  // всё, что уже успешно применилось раньше в этом прогоне), см. GitService.lastCommitTouchingFile
  // и performDryRun. Если этот sha совпадает с одним из показанных коммитов хронологии — подписываем
  // веткой (shaToBranch), иначе это содержимое уже основной ветки.
  //
  // Дальше — подсказка, что делать: если сам конфликтующий коммит уже отмечен как "уже в main"
  // (badge alreadyInMain), самое простое решение — исключить его из релиза, а не разрешать
  // конфликт. Иначе смотрим possibleCauses (см. session.ts runDryRunOnCurrentPlan/findConflictCauses
  // в planner.ts) — коммиты с других, ещё не выбранных веток, тоже трогающие конфликтующий файл и
  // ещё не выпущенные: вероятная настоящая причина — забытая задача, а не противоречащие правки.
  // Если и там пусто — честно говорим, что причину найти не удалось и конфликт придётся разрешать вручную.
  function renderConflictDetails(item) {
    const sources = item.dryRunConflictSources || [];
    let details = '';
    if (sources.length === 0) {
      details = item.dryRunConflictFiles && item.dryRunConflictFiles.length
        ? \`<div class="conflict-details muted">Файлы: \${item.dryRunConflictFiles.join(', ')}</div>\`
        : '';
    } else {
      details = '<div class="conflict-details">' + sources.map((s) => {
        if (!s.sha) {
          return \`<div class="conflict-file"><b>\${s.file}</b> — файла нет в истории основной ветки (вероятно, его создаёт сам этот коммит)</div>\`;
        }
        const branch = shaToBranch.get(s.sha);
        const who = branch ? \`ветка <b>\${branch}</b>\` : 'уже в основной ветке';
        const link = s.commitUrl
          ? \`<a href="\${s.commitUrl}" target="_blank" rel="noopener">\${s.sha.slice(0,8)}</a>\`
          : s.sha.slice(0,8);
        return \`<div class="conflict-file"><b>\${s.file}</b> — последним менял: \${who}, \${link}\${s.subject ? ' «' + s.subject + '»' : ''}\${s.authorName ? ' · ' + s.authorName : ''}\${s.authorDate ? ' · ' + formatDate(s.authorDate) : ''}</div>\`;
      }).join('') + '</div>';
    }

    let hint = '';
    if (item.alreadyInMain) {
      hint = \`<div class="conflict-hint">Похоже, эта задача уже выпущена в \${configMainBranch} — возможно, проще просто исключить её из релиза, а не разрешать конфликт.</div>\`;
    } else {
      const allCauses = sources.flatMap((s) => (s.possibleCauses || []).map((c) => ({ ...c, file: s.file })));
      if (allCauses.length > 0) {
        const seen = new Set();
        const uniqueCauses = allCauses.filter((c) => (seen.has(c.branch) ? false : (seen.add(c.branch), true)));
        hint = '<div class="conflict-hint">Возможно, дело не в противоречащих правках, а в забытой задаче — эти ветки тоже меняют конфликтующий файл и ещё не выпущены:</div>' +
          uniqueCauses.map((c) => {
            const link = c.commitUrl ? \`<a href="\${c.commitUrl}" target="_blank" rel="noopener">\${c.sha.slice(0,8)}</a>\` : c.sha.slice(0,8);
            const taskLink = c.taskUrl ? \` · <a href="\${c.taskUrl}" target="_blank" rel="noopener">задача</a>\` : '';
            return \`<div class="conflict-cause">→ <b>\${escapeHtml(c.branch)}</b> — «\${escapeHtml(c.subject)}», \${link} · \${escapeHtml(c.authorName)} · \${formatDate(c.authorDate)}\${taskLink}</div>\`;
          }).join('');
      } else {
        hint = '<div class="conflict-hint muted">Других веток, трогающих этот файл и ещё не выпущенных, не нашлось — похоже, конфликт придётся разрешить вручную.</div>';
      }
    }

    return details + hint;
  }

  // Суммаризация под таблицей хронологии — только отмеченные чекбоксом (included) коммиты выбранных
  // веток; контекстные/якорные коммиты dev в счёт не идут (их и не может быть в currentPlan.items —
  // они собираются отдельно, см. renderContextRow/renderAnchorRow). Пересчитывается и при полном
  // рендере (renderItems), и при каждом клике по чекбоксу (см. updateChronologySummary), т.к.
  // included — клиентское состояние, меняющееся без пересборки хронологии на сервере.
  function renderChronologySummary(items) {
    const included = (items || []).filter((i) => i.included);
    if (included.length === 0) return '';
    const branches = new Set(included.map((i) => i.branch)).size;
    const authors = new Set(included.map((i) => i.authorName)).size;
    const insertions = included.reduce((sum, i) => sum + (i.insertions || 0), 0);
    const deletions = included.reduce((sum, i) => sum + (i.deletions || 0), 0);
    const files = new Set();
    included.forEach((i) => (i.files || []).forEach((f) => files.add(f)));
    const conflicts = included.filter((i) => i.dryRunStatus === 'conflict').length;
    const sep = '<span class="chrono-summary-sep">·</span>';
    const stats = [
      \`\${included.length} коммит(ов)\`,
      \`\${branches} веток\`,
      \`\${authors} авторов\`,
      \`<span class="diffstat"><span class="diffstat-add">+\${formatDiffCount(insertions)}</span><span class="diffstat-del">-\${formatDiffCount(deletions)}</span></span>\`,
      \`\${files.size} файлов\`,
    ];
    if (conflicts > 0) stats.push(\`<span class="badge conflict">⚠ \${conflicts} конфликт(ов)</span>\`);
    return stats.join(sep);
  }

  // Дубликат итога по конфликтам из футера (см. renderChronologySummary выше) прямо в заголовке
  // карточки "Хронология коммитов" — те же самые числа, просто видно сразу, не скролля вниз.
  function renderConflictSummaryTop(items) {
    if (!items || items.length === 0) return '';
    const conflicts = items.filter((i) => i.included && i.dryRunStatus === 'conflict').length;
    return conflicts > 0
      ? \`<span class="conflict-summary-top bad">Конфликты: \${conflicts} ⚠</span>\`
      : \`<span class="conflict-summary-top ok">Конфликты: 0 ✓</span>\`;
  }

  function updateChronologySummary() {
    const items = currentPlan ? currentPlan.items : [];
    document.getElementById('chronoSummaryRow').innerHTML = renderChronologySummary(items);
    document.getElementById('conflictSummaryTop').innerHTML = renderConflictSummaryTop(items);
  }

  function renderItemRow(item) {
    const color = colorFor(item.branch);
    let dryRunBadge = '';
    let conflictDetails = '';
    if (item.dryRunStatus === 'ok') dryRunBadge = '<span class="badge ok">конфликтов нет</span>';
    else if (item.dryRunStatus === 'empty') dryRunBadge = '<span class="badge inmain">уже применено (пустой cherry-pick)</span>';
    else if (item.dryRunStatus === 'conflict') {
      dryRunBadge = \`<span class="badge conflict">⚠ конфликт (\${item.dryRunConflictFiles.length} файл(ов))</span>\`;
      conflictDetails = renderConflictDetails(item);
    }
    const appliedBadge = item.applied ? '<span class="badge applied">применён</span>' : '';
    let overlapBadge = '';
    if (item.overlapsWith && item.overlapsWith.length) {
      const branches = [...new Set(item.overlapsWith.map((sha) => shaToBranch.get(sha)).filter(Boolean))];
      const label = branches.length ? branches.join(', ') : \`\${item.overlapsWith.length} коммит(ами) на других ветках\`;
      overlapBadge = \`<span class="badge overlap">пересекается с: \${label}</span>\`;
    }
    const inMainBadge = item.alreadyInMain ? \`<span class="badge inmain">уже в \${configMainBranch}</span>\` : '';
    return \`
      <div class="chrono-cell col-branch">
        <input type="checkbox" class="item-check" data-sha="\${item.sha}" \${item.included ? 'checked' : ''} \${item.applied ? 'disabled' : ''} />
        <span class="lane-label" style="background:\${color}">\${item.branch}</span>
      </div>
      <div class="chrono-cell col-commit">
        <div>\${item.subject}</div>
        <span class="sha">\${item.sha.slice(0,8)}</span>
        \${renderLinks(item, false)}
        <div>\${appliedBadge}\${dryRunBadge}\${overlapBadge}\${inMainBadge}</div>
        \${conflictDetails}
      </div>
      <div class="chrono-cell col-date">\${formatDate(item.authorDate)}</div>
      <div class="chrono-cell col-author" title="\${escapeHtml(item.authorName)}">
        <div>\${item.authorName}</div>
        \${renderDiffStatInline(item)}
      </div>
    \`;
  }

  // Общая часть renderContextRow/renderAnchorRow — те же 4 ячейки-колонки, что и у renderItemRow, но
  // без чекбокса (не относится ни к одной выбранной ветке) и без второй строки +/- в col-author (у
  // CommitInfo, в отличие от PlanItem, нет insertions/deletions — renderDiffStatInline и так вернёт
  // '' для них, но раз строки заведомо нет, не рендерим даже пустой контейнер) — subjectHtml
  // передаётся отдельно, это единственное, что отличает обычный контекстный коммит от "якорного"
  // (см. renderAnchorRow).
  function renderContextStyleRow(commit, subjectHtml) {
    return \`
      <div class="chrono-cell col-branch">
        <span class="lane-label">\${configDevBranch}</span>
      </div>
      <div class="chrono-cell col-commit">
        <div>\${subjectHtml}</div>
        <span class="sha">\${commit.sha.slice(0,8)}</span>
        \${renderLinks(commit)}
      </div>
      <div class="chrono-cell col-date">\${formatDate(commit.authorDate)}</div>
      <div class="chrono-cell col-author" title="\${escapeHtml(commit.authorName)}">\${commit.authorName}</div>
    \`;
  }

  function renderContextRow(commit) {
    return renderContextStyleRow(commit, commit.subject);
  }

  // Последний коммит dev ПЕРЕД началом хронологии — для ориентира, тот же стиль, что и обычные
  // контекстные коммиты, только с пояснением, почему он вообще тут (иначе непонятно, откуда взялся
  // коммит раньше даты самого первого пункта хронологии).
  function renderAnchorRow(commit) {
    return renderContextStyleRow(commit, \`\${commit.subject} <span class="muted">— последний коммит \${configDevBranch} перед началом хронологии</span>\`);
  }

  // "Rail" — дорожки веток слева от хронологии (см. drawRail — рисует их одним SVG). Лейн 0 всегда
  // зарезервирован под "ствол" dev (открыт на всю показанную историю — контекстные/якорный
  // коммиты и есть его настоящие коммиты). Каждая выбранная ветка получает свой лейн по порядку
  // первого появления среди items; лейн "открыт" от строки её первого коммита до строки, где
  // найден коммит слияния ЭТОЙ ветки обратно в dev, либо до конца показанного окна, если слияние
  // не нашлось — это и есть сигнал "ветка всё ещё не влита" прямо на графе, без отдельного текста.
  //
  // Раньше здесь ветка каждой строки-маркера слияния (mergeMarker) заново разбиралась из subject
  // регуляркой (тот же формат, что GitService.listMergeEvents искал по всей истории dev) — то
  // есть привязка к тексту БЫЛА ДВАЖДЫ: один раз на сервере (там уже топология, не текст, см.
  // listMergeEvents), и снова здесь, притом что сервер и так ЗНАЕТ, к какой ветке относится
  // событие (это ключ mergeEventsByBranch) — просто эта информация терялась при
  // Object.values(...).flat() в renderItems и восстанавливалась заново текстом. Теперь branch
  // приходит прямо в самой строке-маркере (см. renderItems), разбирать subject не нужно вообще.
  function computeRail(merged) {
    // Порядок первого появления веток среди 'item'-строк — нужен только чтобы знать, какие ветки
    // вообще есть, и как стабильный запасной порядок; конкретный НОМЕР лейна назначается позже,
    // отдельным проходом (см. ниже) на основе реальных временных диапазонов, а не порядка появления.
    const branchOrder = [];
    const seenBranches = new Set();
    merged.forEach((row) => {
      if (row.kind === 'item' && !seenBranches.has(row.item.branch)) {
        seenBranches.add(row.item.branch);
        branchOrder.push(row.item.branch);
      }
    });

    // ТОЛЬКО kind='mergeMarker' — построенные на клиенте из авторитетного ReleasePlan.mergeEventsByBranch
    // (см. renderItems), с уже проставленным row.branch — а не любая строка, чей subject случайно
    // похож на текст слияния. mergeMarker строится только из слияний, которые сервер уже
    // подтвердил как относящиеся к ЭТОЙ ветке по топологии (см. applyMergeEvents в session.ts) —
    // их может быть НЕСКОЛЬКО, если ветку мержили за её жизнь больше одного раза (часть коммитов
    // влита раньше отдельным PR, часть — позже).
    const mergeRowsByBranch = new Map();
    merged.forEach((row, idx) => {
      if (row.kind !== 'mergeMarker') return;
      if (!seenBranches.has(row.branch)) return;
      if (!mergeRowsByBranch.has(row.branch)) mergeRowsByBranch.set(row.branch, []);
      mergeRowsByBranch.get(row.branch).push(idx);
    });

    const ranges = new Map();
    for (const branch of branchOrder) {
      let start = null;
      let lastOwnRow = null;
      merged.forEach((row, idx) => {
        if (row.kind === 'item' && row.item.branch === branch) {
          if (start === null) start = idx;
          lastOwnRow = idx;
        }
      });
      // merged уже отсортирован по дате, поэтому строки-маркеры слияния встречаются в forEach выше в
      // хронологическом порядке — последний элемент этого массива и есть САМОЕ СВЕЖЕЕ слияние, оно
      // закрывает лейн ветки (mergedAtRow); все более ранние — просто точки-отметки на стволе по
      // пути (см. intermediateMergeRows в drawRail), сама дорожка ветки через них проходит не прерываясь.
      const mergeRows = mergeRowsByBranch.get(branch) || [];
      const mergedAtRow = mergeRows.length > 0 ? mergeRows[mergeRows.length - 1] : null;
      const intermediateMergeRows = mergeRows.slice(0, -1);
      ranges.set(branch, { start, end: lastOwnRow, mergedAtRow, intermediateMergeRows });
    }

    // Назначение лейнов — greedy упаковка интервалов (тот же приём, что в календарях/Gantt-чартах
    // для непересекающихся событий на одной "полосе"): ветки обрабатываются в порядке начала, и
    // каждая занимает МИНИМАЛЬНЫЙ лейн, чей предыдущий "жилец" уже закрылся (влился обратно в dev)
    // строго до её начала — а не всегда новый лейн по счётчику. Раньше здесь был монотонный
    // nextLane++ на каждую новую ветку, из-за чего дорожки только растущей "лесенкой" расходились
    // вправо, даже когда реального пересечения по времени не было (ветка создалась, залилась в dev,
    // потом уже следующая создалась) — визуально не имеет смысла, если ветки не жили параллельно.
    const totalRows = merged.length;
    const closeRowOf = (branch) => {
      const r = ranges.get(branch);
      return r.mergedAtRow !== null ? r.mergedAtRow : totalRows - 1;
    };
    const byStart = [...branchOrder].sort((a, b) => ranges.get(a).start - ranges.get(b).start);
    const laneOf = new Map();
    const laneClosedAt = []; // laneClosedAt[i] — строка, на которой закрылся текущий "жилец" лейна i
    for (const branch of byStart) {
      const start = ranges.get(branch).start;
      let lane = laneClosedAt.findIndex((closedAt) => closedAt < start);
      if (lane === -1) {
        lane = laneClosedAt.length;
        laneClosedAt.push(-1);
      }
      laneClosedAt[lane] = closeRowOf(branch);
      laneOf.set(branch, lane + 1); // +1: лейн 0 зарезервирован под ствол dev (см. laneX)
    }

    return { laneOf, ranges, mergeRowsByBranch };
  }

  const RAIL_LANE_W = 18;
  const RAIL_DOT_R = 4.5;
  // Сумма фиксированных колонок .chrono-grid-row (см. CSS) после графа — чекбокс+ветка(152) +
  // дата(144) + автор(124, там же второй строкой +/-, отдельной колонки "Изменения" больше нет) —
  // и минимальная ширина гибкой колонки коммита; вместе с --rail-w дают минимальную ширину таблицы
  // хронологии, ниже которой включается горизонтальный скролл (.chrono-scroll), а не сжатие/наезд
  // колонок. Держим как константы, а не пересчитываем grid-template-columns по частям, чтобы значения
  // тут и в CSS не могли разойтись незаметно.
  const CHRONO_FIXED_COLS_PX = 152 + 144 + 124;
  const CHRONO_COMMIT_MIN_PX = 160;

  // Максимальный НОМЕР лейна, а не rail.laneOf.size (число веток) — с переиспользованием лейнов
  // (см. computeRail) веток может быть больше, чем реально одновременно занятых дорожек, и ширину
  // не нужно раздувать под каждую ветку по отдельности.
  function railWidth(rail) {
    let maxLane = 0;
    for (const lane of rail.laneOf.values()) {
      if (lane > maxLane) maxLane = lane;
    }
    return (maxLane + 1) * RAIL_LANE_W;
  }

  function laneX(lane) {
    return lane * RAIL_LANE_W + RAIL_LANE_W / 2;
  }

  // Кубическая кривая с горизонтальными касательными на обоих концах — даёт характерный
  // "линзовидный" изгиб веток при ветвлении/слиянии (как в vscode-git-graph), а не резкий излом.
  function laneCurve(x0, y0, x1, y1) {
    const ymid = (y0 + y1) / 2;
    return \`M \${x0},\${y0} C \${x0},\${ymid} \${x1},\${ymid} \${x1},\${y1}\`;
  }

  function railDot(x, y, color, branch) {
    // Второй, более крупный круг цвета фона — "проталина" вокруг точки, чтобы пересекающие линии
    // других веток не проходили ПРЯМО СКВОЗЬ неё (аналог прежнего box-shadow-кольца на CSS-варианте).
    // data-branch — только когда точка реально принадлежит (или отмечает слияние) конкретной ветке;
    // используется наведением мыши, чтобы подсветить всю ветку целиком (см. wireRailHover).
    const dataAttr = branch ? \` data-branch="\${branch}"\` : '';
    return \`<circle cx="\${x}" cy="\${y}" r="\${RAIL_DOT_R + 2}" class="rail-halo"\${dataAttr} /><circle cx="\${x}" cy="\${y}" r="\${RAIL_DOT_R}" fill="\${color}"\${dataAttr} />\`;
  }

  // Большие числа (редкий, но реальный случай — squash-коммит на сотни строк) не должны раздувать
  // строку — округляем до "1.2k" вместо полного числа, а не просто обрезаем цифры. Раньше эти числа
  // рисовались прямо на графе (вертикальным текстом вдоль дорожки ветки), но при мелком шрифте и
  // развороте в разные стороны у "+" и "-" читать их было практически невозможно — перенесены в
  // конец текстовой строки коммита, к остальным ссылкам (см. renderLinks/renderDiffStatInline).
  function formatDiffCount(n) {
    if (n < 1000) return String(n);
    if (n < 10000) return (n / 1000).toFixed(1).replace(/\\.0$/, '') + 'k';
    return Math.round(n / 1000) + 'k';
  }

  // Наведение мыши на любую точку коммита/слияния с data-branch подсвечивает ВСЮ дорожку этой ветки
  // (её линию/кривые целиком + все её точки, включая точки слияния на стволе), а не только саму
  // точку под курсором — остальные ветки тускнеют, ствол остаётся как есть. Вызывается заново после
  // каждой перерисовки .rail-overlay (innerHTML полностью заменяется, поэтому старые слушатели уже
  // не существуют — переподписываться нужно каждый раз).
  function wireRailHover(railOverlay) {
    const svg = railOverlay.querySelector('svg');
    if (!svg) return;
    const tagged = [...svg.querySelectorAll('[data-branch]')];
    const dots = svg.querySelectorAll('circle[data-branch]');
    dots.forEach((dot) => {
      dot.addEventListener('mouseenter', () => {
        const branch = dot.dataset.branch;
        tagged.forEach((el) => {
          const match = el.dataset.branch === branch;
          el.classList.toggle('rail-hot', match);
          el.classList.toggle('rail-dim', !match);
        });
      });
      dot.addEventListener('mouseleave', () => {
        tagged.forEach((el) => el.classList.remove('rail-hot', 'rail-dim'));
      });
    });
  }

  // Рисует один SVG-оверлей на всю показанную хронологию сразу (а не по ячейке на строку), беря
  // реальные Y-координаты центров строк (см. renderItems — измеряются ПОСЛЕ рендера, поэтому перенос
  // текста темы коммита на несколько строк не ломает геометрию). Линии рисуются раньше точек одним
  // общим проходом, чтобы кривая ветвления/слияния другой дорожки не перекрывала уже нарисованную
  // точку — точки должны быть видны поверх любых пересекающих их линий.
  function drawRail(rail, merged, rowCenters, containerHeight) {
    const totalRows = merged.length;
    const trunkX = laneX(0);
    const lastY = rowCenters[totalRows - 1];
    const trunkColor = 'var(--vscode-descriptionForeground)';
    const lines = [];
    const dots = [];

    // Ствол dev — как и любая ветка, продолжается и ЗА пределами показанного окна (та же
    // пунктирная "шапка" сверху, что у веток без видимой точки ветвления, см. ниже) — раньше он
    // просто начинался вплотную к первой строке, без этого сигнала "тут не всё, есть история раньше".
    lines.push(\`<path d="M \${trunkX},-2 L \${trunkX},\${rowCenters[0]}" stroke="\${trunkColor}" stroke-dasharray="3 3" class="rail-line" />\`);
    lines.push(\`<path d="M \${trunkX},\${rowCenters[0]} L \${trunkX},\${lastY}" stroke="\${trunkColor}" class="rail-line" />\`);
    // Строка ПЕРЕД первым коммитом ветки (её "якорь" ответвления от dev, см. кривую ниже) — не
    // всегда контекстный/anchor-коммит dev: если рядом выбрана ЕЩЁ одна ветка, этой строкой в общей
    // хронологии вполне может оказаться СВОЙ коммит другой ветки (её kind='item', а не context) — а
    // цикл ниже раньше пропускал ЛЮБУЮ item-строку целиком, ещё до проверки на якорь. Из-за этого
    // кривая ответвления упиралась в ствол в точке без единой точки-маркера — визуально "куда-то в
    // пустоту", а не в видимый узел ветвления. Собираем такие якоря заранее, отдельным проходом.
    const branchOffAnchorRow = new Map(); // idx -> ветка, которая ответвляется от dev сразу ПОСЛЕ этой строки
    for (const [branch, range] of rail.ranges) {
      if (range.start !== null && range.start > 0) {
        branchOffAnchorRow.set(range.start - 1, branch);
      }
    }
    merged.forEach((row, idx) => {
      let color = trunkColor;
      let dotBranch = null;
      for (const [branch, range] of rail.ranges) {
        // Финальное (закрывающее лейн) слияние — как и раньше; плюс любое более раннее слияние ЭТОЙ
        // ЖЕ ветки (см. intermediateMergeRows в computeRail — ветка, которую мержили несколько раз за
        // её жизнь) тоже отмечается точкой на стволе, просто не закрывает дорожку.
        if (range.mergedAtRow === idx || range.intermediateMergeRows.includes(idx)) {
          color = colorFor(branch);
          dotBranch = branch;
          break;
        }
      }
      if (!dotBranch && branchOffAnchorRow.has(idx)) {
        // Точка ответвления — это ещё коммит САМОГО dev (ветка от него только оттолкнётся кривой
        // на следующей строке, см. выше laneCurve(trunkX, ..., x, ...)), поэтому и красится в цвет
        // ствола, как и сама кривая ответвления (см. её trunkColor чуть ниже) — а не в цвет ветки,
        // которой на этом коммите ещё физически не существует.
        dotBranch = branchOffAnchorRow.get(idx);
        color = trunkColor;
      }
      // Обычный контекстный/anchor-коммит dev — точка всегда нужна (он и есть настоящий коммит
      // ствола). Чужой item другой ветки — точка на СТВОЛЕ нужна только если это чей-то якорь
      // ответвления; иначе здесь просто нет ничего своего у dev, дублировать точку не нужно (у
      // самого коммита уже есть точка на его собственной дорожке, см. цикл по веткам ниже).
      if (row.kind === 'item' && !dotBranch) return;
      dots.push(railDot(trunkX, rowCenters[idx], color, dotBranch));
    });

    for (const [branch, lane] of [...rail.laneOf.entries()].sort((a, b) => a[1] - b[1])) {
      const range = rail.ranges.get(branch);
      if (range.start === null) continue;
      const x = laneX(lane);
      const color = colorFor(branch);
      const isMerged = range.mergedAtRow !== null;
      const vertEndIdx = isMerged ? Math.max(range.start, range.mergedAtRow - 1) : totalRows - 1;

      // Кривая ветвления от ствола — только если есть строка ДО первого коммита ветки, от которой
      // можно оттолкнуться. Если её нет (первая показанная строка вообще — уже это самое
      // ответвление; например контекстные коммиты dev свёрнуты и точка ветвления вместе с ними),
      // симметрично нижнему "хвосту" у невлитых веток дорожка обрывается пунктиром за ВЕРХНИЙ край —
      // сигнал "ветвление было раньше показанного окна", а не оборванная на середине линия.
      //
      // Цвет этой кривой — trunkColor (цвет dev), а не свой цвет ветки: так же, как в Bitbucket,
      // "начало ответвления" красится в цвет ветки, ОТ КОТОРОЙ создаётся новая — обычно это dev.
      // Свой цвет ветки появляется дальше, начиная с её собственной дорожки/точек.
      if (range.start > 0) {
        lines.push(\`<path d="\${laneCurve(trunkX, rowCenters[range.start - 1], x, rowCenters[range.start])}" stroke="\${trunkColor}" class="rail-line" data-branch="\${branch}" />\`);
      } else {
        // Небольшой выступ (плюс отступ #items сверху — см. CSS) — раньше заезжал на строку с
        // кнопкой "показать/скрыть контекстные коммиты dev", расположенную прямо над списком.
        lines.push(\`<path d="M \${x},-2 L \${x},\${rowCenters[range.start]}" stroke="\${color}" stroke-dasharray="3 3" class="rail-line" data-branch="\${branch}" />\`);
      }
      // Основная дорожка ветки — ОДНА непрерывная линия на своём лейне от первого коммита до
      // последнего (или до финального слияния), не прерывающаяся промежуточными слияниями. Раньше
      // линия буквально "заходила" на ствол в промежуточном слиянии и возвращалась на свой лейн
      // СЛЕДУЮЩЕЙ строкой (mergeIdx + 1) — но следующая строка — это просто следующая по дате
      // запись в общем списке, а НЕ обязательно следующий свой коммит ветки: если между двумя
      // слияниями одной и той же ветки в хронологии оказывался посторонний коммит dev (обычное
      // дело — работа над задачей растянулась на несколько раундов, и между ними dev жил дальше),
      // дорожка визуально "стояла" на стволе все эти строки и снова "отделялась" от dev прямо на
      // этом чужом коммите — то есть повторное ветвление выглядело так, будто идёт от dev, а не от
      // собственного первого коммита ветки (реальный баг, найденный на примере feature/DOS-2841 с
      // двумя вливаниями). Промежуточное слияние теперь рисуется отдельным "усом" (лёгкий изгиб к
      // стволу) ПОВЕРХ этой непрерывной линии, а не как часть её пути.
      if (vertEndIdx > range.start) {
        lines.push(\`<path d="M \${x},\${rowCenters[range.start]} L \${x},\${rowCenters[vertEndIdx]}" stroke="\${color}" class="rail-line" data-branch="\${branch}" />\`);
      }
      for (const mergeIdx of range.intermediateMergeRows) {
        // Только "ус" ВХОДА в промежуточное слияние (свой коммит перед ним → ствол на строке
        // слияния) — ветка реально влилась в dev именно этим PR. "Уса" ВОЗВРАТА со ствола обратно
        // на лейн больше нет: следующий свой коммит ветки и так уже соединён напрямую сплошной
        // линией выше (см. комментарий про непрерывную дорожку) — рисовать вдобавок кривую
        // ствол→лейн в ту же самую точку означало ответвление НАЧИНАЕТСЯ ОТ СТВОЛА визуально
        // неотличимо от настоящего нового ветвления, хотя на деле это тот же самый коммит,
        // просто ещё раз влитый позже (найдено на реальных двух PR feature/DOS-2841: #1661 и #1662).
        const outFrom = Math.max(range.start, mergeIdx - 1);
        if (outFrom !== mergeIdx) {
          lines.push(\`<path d="\${laneCurve(x, rowCenters[outFrom], trunkX, rowCenters[mergeIdx])}" stroke="\${color}" class="rail-line" data-branch="\${branch}" />\`);
        }
      }
      if (isMerged) {
        lines.push(\`<path d="\${laneCurve(x, rowCenters[vertEndIdx], trunkX, rowCenters[range.mergedAtRow])}" stroke="\${color}" class="rail-line" data-branch="\${branch}" />\`);
      } else {
        // Ветка ещё не влита — дорожка обрывается пунктирным "хвостом" ЗА нижний край видимой
        // хронологии, а не точкой в никуда: сигнал "продолжение есть, но оно вне показанного окна",
        // а не оборванная на середине строки линия.
        lines.push(\`<path d="M \${x},\${lastY} L \${x},\${containerHeight + 4}" stroke="\${color}" stroke-dasharray="3 3" class="rail-line" data-branch="\${branch}" />\`);
      }

      merged.forEach((row, idx) => {
        if (row.kind === 'item' && row.item.branch === branch) {
          dots.push(railDot(x, rowCenters[idx], color, branch));
        }
      });
    }

    return lines.join('') + dots.join('');
  }

  // Счётчик перерисовок дорожки — см. использование ниже, после измерения rowCenters: пока webview
  // грузит нужный шрифт, document.fonts.ready ещё не выполнен, и если за это время renderItems()
  // успеет вызваться СНОВА (например, пользователь быстро свернул/развернул контекстные коммиты),
  // устаревший (уже неактуальный) отложенный проход измерения не должен перерисовать поверх нового.
  let railRenderGeneration = 0;
  // Единственный ResizeObserver дорожки — разъединяем предыдущий на каждый renderItems(), иначе при
  // повторных вызовах (сворачивание контекстных коммитов, применение плана и т.п.) их накопилось бы
  // несколько одновременно, каждый перерисовывающий поверх остальных.
  let railResizeObserver = null;

  function renderItems() {
    const myGeneration = ++railRenderGeneration;
    if (railResizeObserver) {
      railResizeObserver.disconnect();
      railResizeObserver = null;
    }
    const el = document.getElementById('items');
    const toggleBtn = document.getElementById('toggleContextBtn');
    if (!currentPlan || currentPlan.items.length === 0) {
      el.innerHTML = '<div class="muted">Постройте хронологию, чтобы увидеть коммиты</div>';
      toggleBtn.style.display = 'none';
      document.getElementById('chronoHeaderRow').style.display = 'none';
      updateChronologySummary();
      renderCherryPickCommands();
      return;
    }
    document.getElementById('chronoHeaderRow').style.display = '';

    shaToBranch = new Map(currentPlan.items.map((i) => [i.sha, i.branch]));

    const contextCommits = currentPlan.contextCommits || [];
    const anchorCommit = currentPlan.anchorCommit || null;
    if (contextCommits.length > 0 || anchorCommit) {
      toggleBtn.style.display = 'inline-block';
      toggleBtn.textContent = contextCollapsed
        ? \`▸ показать контекстные коммиты \${configDevBranch} (\${contextCommits.length}\${currentPlan.contextCommitsTruncated ? '+' : ''})\`
        : \`▾ скрыть контекстные коммиты \${configDevBranch}\`;
    } else {
      toggleBtn.style.display = 'none';
    }

    // Сворачивание контекстных коммитов dev работает ровно как и раньше — полностью прячет и их,
    // и якорный коммит; это не трогаем.
    const visibleContextCommits = contextCollapsed ? [] : contextCommits;

    // Реальный коммит слияния каждой показанной ветки обратно в dev (см. ReleasePlan.mergeEventsByBranch
    // в types.ts) — авторитетные данные с сервера (тот же git-запрос, что и для бейджа PR), а НЕ
    // попытка угадать точку слияния, разбирая subject уже загруженных контекстных коммитов: тот же
    // коммит не гарантированно среди них (окно дат, лимит, свёрнутый список) — из-за чего влитые
    // ветки визуально выглядели "ещё не влитыми". Строка слияния добавляется В ЛЮБОМ СЛУЧАЕ (кроме
    // дублирования — см. дедуп ниже), но при свёрнутых контекстных коммитах рендерится НЕВИДИМОЙ
    // (нулевой высоты, без текста, kind='mergeMarker' — см. renderMergeMarkerRow): пользователю она
    // не показывается, но остаётся в DOM, поэтому у дорожки есть настоящая Y-координата, куда
    // упереть кривую слияния, а сворачивание при этом всё равно ведёт себя как полное скрытие.
    // Ветка может быть смёржена НЕСКОЛЬКО РАЗ за свою жизнь (часть коммитов влита раньше отдельным
    // PR, часть — позже) — mergeEventsByBranch[branch] тогда содержит больше одного слияния, и на
    // дорожке появляется отдельная точка на стволе под каждое из них, а не только под последнее.
    const mergeEventsByBranch = currentPlan.mergeEventsByBranch || {};
    // branch — прямо из ключа mergeEventsByBranch, а не восстанавливается позже парсингом subject
    // (см. computeRail): сервер и так знает, к какой ветке относится каждое событие, Object.entries
    // вместо Object.values сохраняет эту связь, а не теряет её на полпути.
    const mergeMarkerRows = Object.entries(mergeEventsByBranch).flatMap(([branch, events]) =>
      events.map((ev) => ({
        kind: 'mergeMarker',
        date: ev.authorDate,
        branch,
        commit: { sha: ev.sha, subject: ev.subject, authorDate: ev.authorDate, authorName: ev.authorName, taskUrl: ev.taskUrl, prUrl: ev.prUrl, prNumber: ev.prNumber, commitUrl: ev.commitUrl },
      }))
    );
    const mergeEventShas = new Set(mergeMarkerRows.map((row) => row.commit.sha));
    // Тот же коммит не должен показываться дважды, когда контекстные коммиты развёрнуты — один раз
    // обычной серой строкой (без PR-ссылки) и второй раз как "маркер слияния" (с ней); оставляем
    // только вторую, более информативную версию.
    const dedupedContextCommits = visibleContextCommits.filter((c) => !mergeEventShas.has(c.sha));

    const merged = [
      ...currentPlan.items.map((item) => ({ kind: 'item', date: item.authorDate, item })),
      ...dedupedContextCommits.map((c) => ({ kind: 'context', date: c.authorDate, commit: c })),
      ...mergeMarkerRows,
      ...(contextCollapsed || !anchorCommit ? [] : [{ kind: 'anchor', date: anchorCommit.authorDate, commit: anchorCommit }]),
    ].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    const rail = computeRail(merged);
    const railW = railWidth(rail);

    // --rail-w приводит первую колонку .chrono-grid-row (заголовок, строки, футер — везде одно и то
    // же правило) к той же ширине, что и сам SVG-граф ниже; minWidth — порог, ниже которого фиксированные
    // колонки не могут сжаться дальше, поэтому .chrono-scroll включает горизонтальный скролл вместо
    // наезда колонок друг на друга (см. CHRONO_FIXED_COLS_PX/CHRONO_COMMIT_MIN_PX выше).
    const chronoInner = document.getElementById('chronoInner');
    chronoInner.style.setProperty('--rail-w', railW + 'px');
    chronoInner.style.minWidth = (railW + CHRONO_FIXED_COLS_PX + CHRONO_COMMIT_MIN_PX) + 'px';

    el.innerHTML =
      '<div class="rail-overlay" id="railOverlay"></div>' +
      merged
        .map((entry) => {
          if (entry.kind === 'item') return \`<div class="timeline-row chrono-grid-row"><div class="rail-spacer"></div>\${renderItemRow(entry.item)}</div>\`;
          if (entry.kind === 'anchor') return \`<div class="timeline-row chrono-grid-row chrono-context"><div class="rail-spacer"></div>\${renderAnchorRow(entry.commit)}</div>\`;
          if (entry.kind === 'mergeMarker' && contextCollapsed) {
            // Невидимая строка-маркер: нулевая высота, без текста, без разделителя — только чтобы у
            // дорожки была Y-координата для кривой слияния, пока контекстные коммиты свёрнуты.
            // Без chrono-grid-row — она невидима, grid-раскладка ей ни для чего не нужна.
            return \`<div class="timeline-row timeline-row-hidden"><div class="rail-spacer"></div></div>\`;
          }
          return \`<div class="timeline-row chrono-grid-row chrono-context"><div class="rail-spacer"></div>\${renderContextRow(entry.commit)}</div>\`;
        })
        .join('');

    // Координаты строк известны только ПОСЛЕ того, как они реально легли в разметку (перенос текста
    // темы коммита на 1-2 строки меняет высоту непредсказуемо) — поэтому SVG дорисовывается вторым
    // проходом, читая offsetTop/offsetHeight уже вставленных строк, а не подгоняется под фиксированную
    // высоту ячейки, как в прежнем чисто-CSS варианте.
    const drawRailNow = () => {
      if (myGeneration !== railRenderGeneration) return;
      const rowEls = [...el.querySelectorAll('.timeline-row')];
      const rowCenters = rowEls.map((r) => r.offsetTop + r.offsetHeight / 2);
      const containerHeight = el.scrollHeight;
      const railOverlay = document.getElementById('railOverlay');
      if (!railOverlay) return;
      railOverlay.style.width = railW + 'px';
      railOverlay.style.height = containerHeight + 'px';
      // overflow:visible — иначе браузер по умолчанию обрезает root <svg> точно по width/height, а
      // пунктирные "хвосты" веток (см. drawRail) намеренно выходят за верхний/нижний край на пару пикселей.
      railOverlay.innerHTML = \`<svg width="\${railW}" height="\${containerHeight}" style="overflow:visible">\${drawRail(rail, merged, rowCenters, containerHeight)}</svg>\`;
      wireRailHover(railOverlay);
    };
    drawRailNow();
    // Если нужный шрифт (moноширинный для sha/дат и т.п.) в момент первой отрисовки ещё не
    // подгрузился, браузер посчитал offsetTop/offsetHeight по временному fallback-шрифту — после
    // подгрузки строки могут чуть сдвинуться по высоте, и точки на дорожке "уезжают" относительно
    // текста. document.fonts.ready гарантированно срабатывает уже после того, как шрифты готовы,
    // поэтому пересчитываем ещё раз тогда — railRenderGeneration защищает от перезаписи уже более
    // новой отрисовки, если renderItems() успели вызвать повторно, пока мы ждали шрифты.
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(drawRailNow);
    }

    // Ресайз панели (перетаскивание границы редактора, смена ширины окна VS Code и т.п.) меняет
    // ширину #items, из-за чего тема коммита может перенестись на другое число строк — высоты строк
    // меняются, а без пересчёта дорожка осталась бы нарисованной по старым, уже неверным координатам
    // ("съезжает" относительно текста). requestAnimationFrame схлопывает частые срабатывания подряд
    // (ResizeObserver может стрелять много раз за один плавный ресайз) в одну перерисовку за кадр.
    if (typeof ResizeObserver !== 'undefined') {
      let resizeFrame = null;
      railResizeObserver = new ResizeObserver(() => {
        if (resizeFrame !== null) return;
        resizeFrame = requestAnimationFrame(() => {
          resizeFrame = null;
          drawRailNow();
        });
      });
      railResizeObserver.observe(el);
    }

    [...el.querySelectorAll('.item-check')].forEach((cb) => {
      cb.addEventListener('change', (e) => {
        const sha = e.target.dataset.sha;
        const included = e.target.checked;
        // Сервер (onToggleItem) не отвечает новым planBuilt на каждый чекбокс — только сохраняет
        // выбор — поэтому включённость в currentPlan обновляем тут же сами, иначе блок cherry-pick
        // ниже (который читает currentPlan.items) не заметил бы изменения до следующей полной
        // пересборки хронологии.
        const item = currentPlan.items.find((i) => i.sha === sha);
        if (item) item.included = included;
        vscode.postMessage({ command: 'toggleItem', sha, included });
        renderCherryPickCommands();
        updateChronologySummary();
      });
    });

    renderCherryPickCommands();
    updateChronologySummary();
  }

  function buildCherryPickSegments(items) {
    // Разбиваем на отдельные команды по каждому конфликтному коммиту: команда включает его как
    // ПОСЛЕДНИЙ элемент (примените её, разрешите конфликт в редакторе), следующая команда начинается
    // со следующего коммита — так после разрешения конфликта понятно, какую команду брать дальше,
    // вместо одной команды на всю хронологию, которая молча остановится где-то посередине.
    const segments = [];
    let current = [];
    for (const item of items) {
      current.push(item);
      if (item.dryRunStatus === 'conflict') {
        segments.push(current);
        current = [];
      }
    }
    if (current.length > 0) segments.push(current);
    return segments;
  }

  function cherryCmdKey(segment) {
    return segment.map((i) => i.sha).join(',');
  }

  function renderCherryPickCommands() {
    const section = document.getElementById('cherryPickSection');
    const el = document.getElementById('cherryPickCommands');
    // Только то, что реально ещё предстоит применить: уже применённые (см. built-in "Начать
    // сборку"/"Следующий шаг") коммиты повторно cherry-pick'ать не нужно — команда для тех, кто
    // хочет провести (или дособрать) оставшуюся часть релиза вручную.
    const items = currentPlan ? currentPlan.items.filter((i) => i.included && !i.applied) : [];
    if (items.length === 0) {
      section.style.display = 'none';
      el.innerHTML = '';
      renumberCards();
      return;
    }
    section.style.display = 'block';
    renumberCards();

    const segments = buildCherryPickSegments(items);
    el.innerHTML = segments
      .map((segment, idx) => {
        const key = cherryCmdKey(segment);
        const copied = copiedCherryCmdKeys.has(key);
        const endsInConflict = segment[segment.length - 1].dryRunStatus === 'conflict';
        const label = segments.length > 1 ? \`Команда \${idx + 1} из \${segments.length}\` : 'Команда';
        const tokens = segment
          .map((item) => {
            const color = colorFor(item.branch);
            const isConflict = item.dryRunStatus === 'conflict';
            const cls = isConflict ? 'cherry-sha conflict' : 'cherry-sha';
            const style = isConflict ? \`border-color:\${color}\` : \`background:\${color}\`;
            const shaLabel = item.sha.slice(0, 8);
            const title = escapeHtml(item.branch);
            return item.commitUrl
              ? \`<a class="\${cls}" style="\${style}" href="\${item.commitUrl}" target="_blank" rel="noopener" title="\${title}">\${shaLabel}</a>\`
              : \`<span class="\${cls}" style="\${style}" title="\${title}">\${shaLabel}</span>\`;
          })
          // Реальный пробел-текст между чипами, а не только CSS margin — иначе выделение мышкой
          // и Ctrl+C прямо из панели (в обход кнопки "Копировать") склеивает соседние sha без
          // пробела (margin — это только визуальный отступ, не текстовый узел).
          .join(' ');
        const plainCmd = 'git cherry-pick ' + segment.map((i) => i.sha).join(' ');
        return \`
          <div class="cherry-cmd \${copied ? 'copied' : ''}">
            <div class="cherry-cmd-header">
              <span class="cherry-cmd-label">\${label}\${endsInConflict ? ' — заканчивается конфликтом' : ''}</span>
              <button class="secondary cherry-copy-btn" data-cmd="\${escapeHtml(plainCmd)}" data-key="\${escapeHtml(key)}">Копировать</button>
            </div>
            <div class="cherry-cmd-body"><span class="cherry-cmd-prefix">git cherry-pick</span> \${tokens}</div>
          </div>
        \`;
      })
      .join('');

    [...el.querySelectorAll('.cherry-copy-btn')].forEach((btn) => {
      btn.addEventListener('click', () => {
        const cmd = btn.dataset.cmd;
        const key = btn.dataset.key;
        navigator.clipboard.writeText(cmd).then(() => {
          copiedCherryCmdKeys.add(key);
          renderCherryPickCommands();
        });
      });
    });
  }

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.command === 'resetForNewContext') {
      // Панель переключилась на другой проект (или на "текущий workspace") — см. ReleasePanel.createOrShow.
      // Сама панель (её HTML/скрипт) не перезагружается при переключении, поэтому список веток,
      // хронология и команда cherry-pick с ПРЕЖНЕГО проекта иначе остались бы висеть на экране,
      // пока не пришли бы данные нового — выглядело бы так, будто это уже ветки нового проекта.
      currentBranches = [];
      selectedRefs = new Set();
      selectionInitialized = false;
      limitInitialized = false;
      currentPlan = null;
      shaToBranch = new Map();
      document.getElementById('releaseBranchInfo').innerHTML = '';
      releaseBranchPatternCount = null;
      lastReleaseDateCheck = { branchName: null, exists: false };
      updateCreateBranchBtnState();
      showError('');
      document.getElementById('branchList').innerHTML = '<div class="muted branch-list-loading">Загрузка веток…</div>';
      document.getElementById('branchListInfo').textContent = 'Загрузка списка веток…';
      lastStaleHints = null;
      document.getElementById('staleBranches').innerHTML = '';
      copiedCherryCmdKeys.clear();
      // Ещё не отправленный запрос фильтрации с ПРЕЖНИМ текстом (debounce) — иначе он всё равно
      // долетит до сервера через 150мс и применится уже к новому проекту.
      clearTimeout(filterDebounce);
      document.getElementById('branchFilter').value = '';
      // Чекбоксы "скрыть в main"/"скрыть служебные" — состояние конкретной ReleaseSession
      // (hideAlreadyInMain/hideServiceBranches), у новой она всегда стартует со значений по
      // умолчанию (false); без сброса чекбоксы визуально остаются отмеченными от прежнего проекта,
      // хотя реально уже ничего не скрывают.
      document.getElementById('hideInMainFilter').checked = false;
      document.getElementById('hideServiceBranchesFilter').checked = false;
      // Кэши/назначения цветов ключуются по имени ветки/ref — у другого проекта (другой репозиторий)
      // те же имена/refs вполне могут существовать (например, одноимённая задача), и без сброса под
      // ними оказались бы данные ЧУЖОГО репозитория (коммиты, статус "в main", даже цвет дорожки).
      expandedRefs = new Set();
      branchCommitsCache.clear();
      branchNameByRef.clear();
      branchMainStatusOverride.clear();
      branchDiffStatByRef.clear();
      colorAssignments.clear();
      nextColorIndex = 0;
      // selectedRefs уже пуст (см. выше), но #selectedSummary никто не перерисовал — чипы
      // выбранных веток ПРЕЖНЕГО проекта оставались видны на экране до следующего 'branches'
      // (который сам зовёт updateSelectedSummary), т.е. до конца загрузки списка веток нового
      // проекта — визуальный артефакт вводил в заблуждение (будто эти ветки выбраны и сейчас).
      updateSelectedSummary();
      renderItems();
      updateBuildButtonsState();
    } else if (msg.command === 'currentBranch') {
      currentBranchValue = msg.current;
      renderCurrentBranchSelect();
      updateCreateBranchBtnState();
      configMainBranch = msg.mainBranch;
      configDevBranch = msg.devBranch;
      staleBranchesLookbackReleases = msg.staleBranchesLookbackReleases;
      document.getElementById('hideInMainFilterBranchName').textContent = configMainBranch;
      setPullBusy(false);
      // Блок "Забытые ветки" ещё не показан на этот момент (хронология не построена) — просто
      // запоминаем значение для инпута, который появится вместе с самим блоком (см. renderStaleBranches*).
    } else if (msg.command === 'branches') {
      setRefreshBusy(false);
      // Первый ответ 'branches' — надёжный признак, что this.fullBranches на сервере уже
      // загружен: перепроверяем дату релиза именно теперь, а не только сразу при загрузке
      // скрипта (тот самый первый запрос мог улететь раньше, чем сервер успел построить список
      // веток, и вернуться с заведомо пустым/неполным результатом).
      requestReleaseDateCheck();
      if (msg.info.refreshedGitState) {
        // Pull/явный "Обновить список веток" — состояние репозитория могло измениться (например,
        // ветка, которой не было в main, теперь там есть после Pull master). Уточнённый статус "в
        // main" с ФОНОВОГО прохода ДО этого момента (branchMainStatusOverride) мог считаться по
        // устаревшему состоянию и был бы приоритетнее свежего b.mainStatus ниже (см.
        // effectiveMainStatus) — сбрасываем, фоновый проход подтянет точный статус заново.
        branchMainStatusOverride.clear();
        branchDiffStatByRef.clear();
      }
      currentBranches = msg.branches;
      for (const b of msg.branches) branchNameByRef.set(b.ref, b.name);
      // Выбор веток — состояние клиента; из сервера принимаем его только один раз при первом
      // открытии панели (там же восстанавливается ранее сохранённый выбор). Иначе повторная
      // фильтрация/обновление списка веток стирало бы уже отмеченные пользователем чекбоксы.
      if (!selectionInitialized) {
        selectedRefs = new Set(msg.selectedRefs);
        selectionInitialized = true;
      }
      renderBranches();
      renderCurrentBranchSelect();
      updateSelectedSummary();
      const info = msg.info;
      if (!limitInitialized) {
        const limitSelect = document.getElementById('branchListLimitInput');
        limitSelect.value = String(info.limit);
        // Сохранённый лимит может не совпасть ни с одним пресетом (например, задан ещё до перехода
        // на select с фиксированными вариантами) — тогда .value молча становится пустым, и селект
        // выглядит "сломанным" (ничего не выбрано). Добавляем недостающий вариант, а не округляем
        // до ближайшего пресета — иначе следующий же реактивный change тихо подрезал бы лимит,
        // который пользователь когда-то намеренно указал.
        if (limitSelect.value !== String(info.limit)) {
          limitSelect.insertAdjacentHTML('beforeend', \`<option value="\${info.limit}" selected>\${info.limit}</option>\`);
        }
        limitInitialized = true;
      }
      const infoEl = document.getElementById('branchListInfo');
      if (info.totalBranches === 0) {
        infoEl.textContent = 'В репозитории не найдено веток.';
      } else if (info.truncated) {
        infoEl.textContent = \`Показано \${msg.branches.length} из \${info.totalMatches} совпадений (всего веток в репозитории: \${info.totalBranches}).\`;
      } else {
        infoEl.textContent = \`Показано \${msg.branches.length} из \${info.totalBranches} веток.\`;
      }
    } else if (msg.command === 'branchMainStatus') {
      // Точный статус, досчитанный в фоне (см. session.ts refineBranchMainStatus) — просто
      // обновляем override той же картой, что и ручное разворачивание коммитов ветки использует.
      for (const [ref, status] of Object.entries(msg.statusByRef)) {
        branchMainStatusOverride.set(ref, status);
      }
      renderBranches();
    } else if (msg.command === 'branchDiffStats') {
      // Агрегированная сводка +/- и число файлов, тем же фоновым проходом, что и branchMainStatus
      // выше (см. session.ts runBranchMainStatusRefinePass) — приходит отдельным сообщением, чтобы
      // не завязывать формат branchMainStatus на неё.
      for (const [ref, stat] of Object.entries(msg.diffStatByRef)) {
        branchDiffStatByRef.set(ref, stat);
      }
      renderBranches();
    } else if (msg.command === 'branchCommits') {
      branchCommitsCache.set(msg.ref, { commits: msg.commits, truncated: msg.truncated, forkedFrom: msg.forkedFrom });
      // Точный статус по факту разворачивания: видно КАЖДЫЙ коммит ветки, поэтому можно отличить
      // "часть коммитов уже в main" от "полностью"/"совсем нет" — точнее приблизительного статуса с сервера.
      if (msg.commits.length > 0) {
        const matched = msg.commits.filter((c) => c.alreadyInMain).length;
        branchMainStatusOverride.set(msg.ref, matched === 0 ? 'none' : matched === msg.commits.length ? 'full' : 'partial');
      }
      renderBranches();
    } else if (msg.command === 'selectedRefs') {
      // Сервер сам поменял выбор ПОСЛЕ первого 'branches' (реконструкция хронологии по
      // существующей релизной ветке, см. session.ts tryReconstructPlanFromReleaseBranch) —
      // безусловно перезаписываем клиентское selectedRefs, а не только при первом открытии.
      selectedRefs = new Set(msg.refs);
      selectionInitialized = true;
      renderBranches();
      updateSelectedSummary();
    } else if (msg.command === 'planBuilding') {
      // Сессия сама (пере)строит хронологию — попадание на уже существующую релизную ветку (см.
      // session.ts prepareReleaseBranchAdoption), а не клик по кнопке. planBuilt/error ниже гасят
      // тот же индикатор как обычно.
      setBuildPlanBusy(true);
    } else if (msg.command === 'planBuilt') {
      setBuildPlanBusy(false);
      currentPlan = msg.plan;
      lastStaleHints = null;
      document.getElementById('staleBranches').innerHTML = '';
      // Подсказка "что уже реально в ветке" (см. releaseBranchInfo ниже) была на случай ОТСУТСТВИЯ
      // полного плана — раз он появился (даже пустой, только с releaseBranch), она уже не нужна.
      document.getElementById('releaseBranchInfo').innerHTML = '';
      copiedCherryCmdKeys.clear();
      renderItems();
      updateBuildButtonsState();
      updateSyncIndicator();
    } else if (msg.command === 'releaseBranchPatternCount') {
      releaseBranchPatternCount = msg.count;
      // Число входит прямо в текст окна поиска забытых веток (см. renderStaleBranchesControls) —
      // перерисовываем тот же блок, что уже показан. Это сообщение шлётся при КАЖДОМ обновлении
      // списка веток (см. session.ts refreshBranches), в т.ч. сразу при открытии панели, задолго
      // до первой постройки хронологии — currentPlan тут проверяем специально: без него
      // renderStaleBranchesLoading() показывал бы "Проверяем..." для скана, который на самом деле
      // ещё даже не запускался (сам скан стартует только внутри rebuildPlan, см. session.ts).
      if (currentPlan) {
        if (lastStaleHints !== null) renderStaleBranches(lastStaleHints);
        else renderStaleBranchesLoading();
      }
    } else if (msg.command === 'releaseDateCheck') {
      // Не трогаем текст статуса, если уже есть готовый план (см. updateBuildButtonsState — там
      // же он сам покажет "Релизная ветка: X"/прогресс сборки) — иначе просмотр другой даты в поле
      // затирал бы актуальный статус уже идущей сборки текстом про эту, ещё не выбранную дату.
      lastReleaseDateCheck = { branchName: msg.branchName, exists: msg.exists };
      updateCreateBranchBtnState();
      const ready = !!(currentPlan && currentPlan.releaseBranch);
      if (!ready) {
        document.getElementById('releaseBranchStatus').textContent = msg.exists
          ? \`Ветка "\${msg.branchName}" уже существует — используйте «Начать сборку»\`
          : 'Релизная ветка ещё не создана';
      }
    } else if (msg.command === 'releaseBranchInfo') {
      const el = document.getElementById('releaseBranchInfo');
      if (!msg.commits || msg.commits.length === 0) {
        // note объясняет, ПОЧЕМУ пусто — уже полностью выпущена в main, или просто пока ничего не
        // собрано (см. session.ts loadReleaseBranchOwnCommits) — без него молчание выглядит так,
        // будто расширение просто не нашло ветку/зависло, хотя на самом деле ей нечего показать.
        el.innerHTML = msg.note ? \`<div class="muted">\${escapeHtml(msg.note)}</div>\` : '';
      } else {
        const rows = msg.commits.map((c) => {
          const link = c.commitUrl ? \`<a href="\${c.commitUrl}" target="_blank" rel="noopener">\${c.sha.slice(0,8)}</a>\` : c.sha.slice(0,8);
          const taskLink = c.taskUrl ? \` · <a href="\${c.taskUrl}" target="_blank" rel="noopener">задача</a>\` : '';
          return \`<div>→ «\${escapeHtml(c.subject)}», \${link} · \${escapeHtml(c.authorName)} · \${formatDate(c.authorDate)}\${taskLink}</div>\`;
        }).join('');
        el.innerHTML = \`<div>Уже в ветке \${escapeHtml(msg.releaseBranch)} (плана нет — выберите те же ветки и постройте хронологию, чтобы увидеть полную картину):</div>\${rows}\`;
      }
    } else if (msg.command === 'staleBranchesLoading') {
      renderStaleBranchesLoading();
    } else if (msg.command === 'staleBranches') {
      lastStaleHints = msg.hints;
      // Забытая ветка обычно не входит в текущий (отфильтрованный/урезанный лимитом) срез
      // currentBranches — без этого её ref не попал бы в branchNameByRef, и после "Добавить в
      // релиз" чип в "Выбрано" показывал бы голый ref вместо чистого имени ветки.
      for (const h of msg.hints) branchNameByRef.set(h.ref, h.branch);
      renderStaleBranches(msg.hints);
    } else if (msg.command === 'progress') {
      if (!currentPlan) return;
      const ev = msg.event;
      if (ev.type === 'applied') {
        const found = currentPlan.items.find((i) => i.sha === ev.item.sha);
        if (found) found.applied = true;
        renderItems();
        updateBuildButtonsState();
      } else if (ev.type === 'conflict') {
        // Терминальное состояние этого вызова onStartAuto() — сервер уже вернул промис, кнопка не занята.
        startBusy = false;
        showError(
          'Конфликт на коммите ' + ev.item.sha.slice(0,8) + ' ("' + ev.item.subject + '"). ' +
          'Разрешите конфликт в файлах репозитория и нажмите "Начать сборку" ещё раз — сборка продолжится с этого же места.'
        );
        updateBuildButtonsState();
      } else if (ev.type === 'done') {
        startBusy = false;
        showError('');
        updateBuildButtonsState();
      }
    } else if (msg.command === 'published') {
      publishBusy = false;
      updateBuildButtonsState();
      document.getElementById('buildStatus').innerHTML =
        '<span style="color:var(--vscode-charts-green);">✓ Релизная ветка опубликована (запушена в remote).</span>';
    } else if (msg.command === 'error') {
      setBuildPlanBusy(false);
      setRefreshBusy(false);
      setPullBusy(false);
      // startAuto/publishRelease бросили исключение — их промис на сервере уже завершился этой
      // ошибкой, кнопки не должны оставаться занятыми навсегда.
      startBusy = false;
      publishBusy = false;
      updateBuildButtonsState();
      showError(msg.message);
    }
  });

  vscode.postMessage({ command: 'refreshBranches' });
</script>
</body>
</html>`;
  }
}
