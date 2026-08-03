import * as vscode from 'vscode';
import { BranchRef, CommitInfo, MainStatus, ReleasePlan, StaleBranchHint } from '../core/types';
import { ExecutorEvent } from '../core/executor';

export interface BranchListInfo {
  totalMatches: number;
  totalBranches: number;
  truncated: boolean;
  /** Текущий лимит показа веток — чтобы панель могла предзаполнить своё поле "Показывать веток". */
  limit: number;
}

export interface ReleasePanelHost {
  onRefreshBranches(): Promise<void>;
  onFilterBranches(query: string): Promise<void>;
  onSetBranchListLimit(limit: number, hideAlreadyInMain: boolean): Promise<void>;
  onSetHideServiceBranches(hide: boolean): Promise<void>;
  onPullBranch(branchName: string): Promise<void>;
  onExpandBranch(ref: string): Promise<void>;
  onBuildPlan(selectedRefs: string[]): Promise<void>;
  onClearPlan(): Promise<void>;
  onToggleItem(sha: string, included: boolean): Promise<void>;
  onStartBuilding(releaseDate: string): Promise<void>;
  onStartAuto(): Promise<void>;
  onStepNext(): Promise<void>;
  onContinueConflict(): Promise<void>;
  onSkipConflict(): Promise<void>;
  onAbortBuild(): Promise<void>;
}

export class ReleasePanel {
  public static current: ReleasePanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];

  static createOrShow(extensionUri: vscode.Uri, host: ReleasePanelHost): ReleasePanel {
    if (ReleasePanel.current) {
      ReleasePanel.current.panel.reveal();
      ReleasePanel.current.host = host;
      return ReleasePanel.current;
    }
    const panel = vscode.window.createWebviewPanel('qvarhRelease', 'Qvarh Release Builder', vscode.ViewColumn.One, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [extensionUri],
    });
    ReleasePanel.current = new ReleasePanel(panel, host, extensionUri);
    return ReleasePanel.current;
  }

  private constructor(panel: vscode.WebviewPanel, private host: ReleasePanelHost, private readonly extensionUri: vscode.Uri) {
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
            case 'pullBranch':
              await this.host.onPullBranch(message.branch);
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
            case 'startAuto':
              await this.host.onStartAuto();
              break;
            case 'stepNext':
              await this.host.onStepNext();
              break;
            case 'continueConflict':
              await this.host.onContinueConflict();
              break;
            case 'skipConflict':
              await this.host.onSkipConflict();
              break;
            case 'abortBuild':
              await this.host.onAbortBuild();
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

  postCurrentBranch(current: string, mainBranch: string, devBranch: string): void {
    this.panel.webview.postMessage({ command: 'currentBranch', current, mainBranch, devBranch });
  }

  postBranches(branches: BranchRef[], selectedRefs: string[], info: BranchListInfo): void {
    this.panel.webview.postMessage({ command: 'branches', branches, selectedRefs, info });
  }

  postBranchCommits(ref: string, commits: CommitInfo[], truncated: boolean, forkedFrom: string | null = null): void {
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

  postPlan(plan: ReleasePlan | null): void {
    this.panel.webview.postMessage({ command: 'planBuilt', plan });
  }

  postProgress(event: ExecutorEvent): void {
    this.panel.webview.postMessage({ command: 'progress', event });
  }

  postError(message: string): void {
    this.panel.webview.postMessage({ command: 'error', message });
  }

  dispose(): void {
    ReleasePanel.current = undefined;
    this.panel.dispose();
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }

  private renderHtml(): string {
    const logoUri = this.panel.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'icon.png'));
    return /* html */ `<!doctype html>
<html lang="ru">
<head>
<meta charset="UTF-8" />
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 12px; }
  .header { display: flex; align-items: center; gap: 8px; }
  .header img { width: 24px; height: 24px; flex: none; display: block; }
  .header h2 { margin: 0; line-height: 24px; }
  h3 { margin-bottom: 6px; }
  section { margin-bottom: 18px; padding-bottom: 14px; border-bottom: 1px solid var(--vscode-panel-border); }
  * { box-sizing: border-box; }
  input[type=text] { width: 100%; max-width: 260px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 4px; }
  .field { margin-bottom: 8px; }
  .field label { display: block; margin-bottom: 2px; }
  .button-row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-top: 8px; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 12px; cursor: pointer; margin-right: 6px; margin-bottom: 6px; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button.link { background: none; color: var(--vscode-textLink-foreground); padding: 0; margin: 0; text-decoration: underline; font-size: 11px; }
  .links a { color: var(--vscode-textLink-foreground); text-decoration: none; margin-right: 8px; font-size: 11px; }
  .links a:hover { text-decoration: underline; }
  button:disabled { opacity: 0.5; cursor: default; }
  #branchList { height: 280px; min-height: 120px; resize: vertical; overflow-y: auto; overflow-x: hidden; border: 1px solid var(--vscode-panel-border); padding: 4px; margin-top: 6px; }
  .branch-row { padding: 3px 0; border-bottom: 1px dashed var(--vscode-panel-border); }
  .branch-row-main { display: flex; align-items: flex-start; gap: 8px; }
  .branch-row.remote .branch-name::after { content: " (remote)"; opacity: 0.5; font-size: 10px; }
  .dot { width: 10px; height: 10px; border-radius: 50%; flex: none; margin-top: 3px; }
  .lane-label { font-size: 11px; padding: 1px 6px; border-radius: 3px; color: #000; flex: none; min-width: 90px; text-align: center; }
  .item-row { display: flex; align-items: flex-start; gap: 8px; padding: 3px 0; border-bottom: 1px dashed var(--vscode-panel-border); }
  .item-main, .branch-main { flex: 1; }
  .sha { font-family: var(--vscode-editor-font-family); font-size: 11px; opacity: 0.8; }
  .muted { opacity: 0.7; font-size: 12px; }
  .badge { font-size: 11px; padding: 1px 6px; border-radius: 3px; margin-right: 4px; display: inline-block; margin-top: 2px; }
  .badge.overlap { background: var(--vscode-charts-orange); color: #000; }
  .badge.ok { background: var(--vscode-charts-green); color: #000; }
  .badge.conflict { background: var(--vscode-charts-red); color: #fff; }
  .badge.applied { background: var(--vscode-charts-blue); color: #fff; }
  .badge.inmain { background: var(--vscode-charts-purple, #B37FEB); color: #000; }
  .badge.partial-inmain { background: var(--vscode-charts-yellow, #E2C08D); color: #000; }
  .chip { display: inline-block; font-size: 11px; padding: 2px 8px; border-radius: 10px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); margin: 2px 4px 2px 0; }
  .mode-toggle label { margin-right: 14px; }
  #error { display: flex; align-items: flex-start; gap: 8px; color: var(--vscode-errorForeground); background: var(--vscode-inputValidation-errorBackground, transparent); border: 1px solid var(--vscode-inputValidation-errorBorder, transparent); padding: 6px; border-radius: 3px; min-height: 1em; }
  #errorText { white-space: pre-wrap; flex: 1; }
  #errorCloseBtn { background: none; border: none; color: inherit; cursor: pointer; padding: 0; margin: 0; font-size: 14px; line-height: 1; opacity: 0.7; }
  #errorCloseBtn:hover { opacity: 1; }
  .branch-commits { margin: 4px 0 4px 24px; padding-left: 8px; border-left: 2px solid var(--vscode-panel-border); }
  .branch-commit-row { font-size: 11px; padding: 2px 0; }
  .conflict-details { margin-top: 4px; padding-left: 8px; border-left: 2px solid var(--vscode-charts-red); }
  .conflict-file { font-size: 11px; padding: 2px 0; }
  .conflict-hint { font-size: 11px; padding: 3px 0; }
  .conflict-cause { font-size: 11px; padding: 2px 0 2px 8px; }
  .git-status { display: flex; gap: 16px; align-items: center; flex-wrap: wrap; }
  .pull-row { display: flex; gap: 6px; align-items: center; margin-top: 6px; flex-wrap: wrap; }
  .filter-row { display: flex; gap: 10px; align-items: center; margin-top: 6px; flex-wrap: wrap; font-size: 12px; }
  .filter-row label { display: flex; align-items: center; gap: 3px; white-space: nowrap; cursor: default; }
  .filter-row input[type=text] { width: 56px; max-width: 56px; }
  .branch-list-loading, .inline-loading { display: flex; align-items: center; gap: 6px; }
  .branch-list-loading { padding: 8px 0; }
  .branch-list-loading::before, .inline-loading::before {
    content: ''; width: 10px; height: 10px; border-radius: 50%; flex: none;
    border: 2px solid var(--vscode-panel-border); border-top-color: var(--vscode-foreground);
    animation: qvarh-spin 0.8s linear infinite;
  }
  @keyframes qvarh-spin { to { transform: rotate(360deg); } }
  .chip-remove { background: none; border: none; color: inherit; cursor: pointer; padding: 0 0 0 4px; margin: 0; font-size: 12px; }
  .section-header { display: flex; align-items: center; gap: 8px; cursor: pointer; user-select: none; }
  .section-header .collapse-arrow { font-size: 10px; opacity: 0.7; width: 10px; display: inline-block; }
  .collapsible-body.collapsed { display: none; }
  .context-row { display: flex; align-items: flex-start; gap: 8px; padding: 2px 0; opacity: 0.55; font-size: 11px; }
  .context-row .lane-label { background: transparent !important; color: var(--vscode-foreground) !important; border: 1px dashed var(--vscode-panel-border); min-width: 90px; }
  /* "Rail" — дорожки веток слева от хронологии (см. renderItems/computeRail/drawRail): dev-"ствол"
     (лейн 0) и по одной дорожке на каждую показанную ветку, шириной RAIL_LANE_W каждая — фиксированный
     размер, не зависящий от ширины панели (поэтому не "разъезжается" на широком экране, в отличие от
     прежнего варианта на @gitgraph/js). Сами линии/точки/кривые ветвления-слияния рисуются ОДНИМ SVG
     поверх колонки-заглушки (.rail-spacer лишь резервирует горизонтальное место в каждой строке) —
     координаты по Y берутся из РЕАЛЬНОГО отрендеренного положения строк (см. measureRowCenters), а
     не подгоняются под фиксированную высоту, поэтому переносы текста в теме коммита не ломают линии. */
  #items { position: relative; margin-top: 4px; }
  .timeline-row { display: flex; align-items: stretch; border-bottom: 1px dashed var(--vscode-panel-border); }
  .timeline-row:last-child { border-bottom: none; }
  .timeline-row .item-row, .timeline-row .context-row { border-bottom: none; flex: 1; min-width: 0; }
  .rail-spacer { flex: none; }
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
  .cherry-pick-section { margin-top: 10px; }
  .section-header-static { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
  .cherry-cmd { margin-bottom: 10px; padding: 6px 8px; border: 1px solid var(--vscode-panel-border); border-radius: 3px; }
  .cherry-cmd-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 4px; }
  .cherry-cmd-label { font-size: 11px; opacity: 0.75; }
  .cherry-cmd-body { font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; line-height: 2; word-break: break-word; }
  .cherry-cmd-prefix { opacity: 0.8; margin-right: 4px; }
  /* Каждый sha — цветной "чип", как .lane-label в хронологии: тот же colorFor(branch), чтобы
     совпадало визуально. У конфликтного — фон красный (как .badge.conflict), а обводка — в цвет
     ветки, чтобы не терять связь с веткой даже когда фон перекрыт цветом конфликта. */
  .cherry-sha { display: inline-block; padding: 1px 6px; margin: 1px 3px 1px 0; border-radius: 10px; color: #000; text-decoration: none; border: 2px solid transparent; font-size: 11px; cursor: pointer; }
  .cherry-sha:hover { filter: brightness(1.12); text-decoration: underline; }
  .cherry-sha.conflict { background: var(--vscode-charts-red) !important; color: #fff; }
  /* Состояние "уже скопировано" — блёклый текст, чтобы не запутаться, какую команду уже брали. */
  .cherry-cmd.copied { opacity: 0.45; }
</style>
</head>
<body>
  <div class="header">
    <img src="${logoUri}" alt="" />
    <h2>Qvarh Release Builder</h2>
  </div>
  <div class="muted" style="margin-bottom:10px;">Git local: локальный релиз по выбранным коммитам</div>

  <div id="error" style="display:none;">
    <span id="errorText"></span>
    <button id="errorCloseBtn" title="Закрыть">×</button>
  </div>

  <section>
    <h3>Git</h3>
    <div class="git-status">
      <div>Текущая ветка: <b id="currentBranchName">…</b></div>
      <div>Основная ветка (для релиза): <b id="mainBranchName">…</b></div>
      <button id="refreshBtn" class="secondary">Обновить список веток</button>
    </div>
    <div class="pull-row">
      <label>Pull ветку:</label>
      <input type="text" id="pullBranchInput" list="branchNamesList" placeholder="имя основной или dev-ветки" />
      <datalist id="branchNamesList"></datalist>
      <button id="pullBtn" class="secondary">Pull (checkout + pull)</button>
    </div>
  </section>

  <section>
    <h3>Ветки</h3>
    <div class="field">
      <label>Фильтр (по названию ветки, через пробел — несколько сразу):</label>
      <input type="text" id="branchFilter" placeholder="PROJ-123 PROJ-456" />
    </div>
    <div class="filter-row">
      <label title="Применяется вместе с лимитом показа по кнопке «Применить» — скрытие происходит ДО среза по лимиту"><input type="checkbox" id="hideInMainFilter" /> Скрыть в <span id="hideInMainFilterBranchName">main</span></label>
      <label title="Скрыть qa, revert-pr-, chore/ и т.п. — см. настройку «Префиксы служебных веток». Применяется сразу"><input type="checkbox" id="hideServiceBranchesFilter" /> Скрыть служебные</label>
      <label>Показывать: <input type="text" id="branchListLimitInput" inputmode="numeric" pattern="[0-9]*" /></label>
      <button id="branchListLimitBtn" class="secondary" title="Применяет флажок «Скрыть в main» и лимит показа вместе">Применить</button>
    </div>
    <div id="branchListInfo" class="muted">Загрузка списка веток…</div>
    <div id="branchList"><div class="muted branch-list-loading">Загрузка веток…</div></div>
    <div id="selectedSummary" class="muted" style="margin-top:6px;"></div>

    <div class="button-row">
      <button id="buildPlanBtn">Построить хронологию выбранных веток</button>
      <button id="clearPlanBtn" class="secondary">Очистить</button>
    </div>
    <div class="muted" style="margin-top:2px;">Проверка на конфликты запускается автоматически сразу после построения хронологии.</div>
  </section>

  <section>
    <div class="section-header" id="itemsHeader">
      <span class="collapse-arrow" id="itemsArrow">▾</span>
      <h3 style="margin:0;">Хронология коммитов</h3>
    </div>
    <div class="collapsible-body" id="itemsBody">
      <div class="button-row" style="margin-top:0;">
        <button id="toggleContextBtn" class="link" style="display:none;"></button>
      </div>
      <div id="items"></div>
      <div id="staleBranches" class="stale-branches"></div>
      <div id="cherryPickSection" class="cherry-pick-section" style="display:none;">
        <div class="section-header-static">
          <h4 style="margin:0;">Команда для ручного cherry-pick</h4>
          <button id="resetCopiedBtn" class="link">Сбросить состояние копирования</button>
        </div>
        <div class="muted" style="margin:2px 0 6px;">
          В порядке хронологии; на каждом конфликтном коммите (обводка цвета его ветки) команда обрывается — примените её,
          разрешите конфликт, затем скопируйте и выполните следующую.
        </div>
        <div id="cherryPickCommands"></div>
      </div>
    </div>
  </section>

  <section>
    <h3>Сборка релизной ветки</h3>
    <div class="field">
      <label>Дата релиза (для имени релизной ветки):</label>
      <input type="text" id="releaseDate" />
    </div>
    <div class="button-row">
      <button id="createBranchBtn">Создать релизную ветку</button>
      <span class="muted" id="releaseBranchStatus"></span>
    </div>

    <div class="mode-toggle" style="margin-top:10px;">
      <label><input type="radio" name="mode" value="auto" checked /> Авто (всё подряд до первого конфликта)</label>
      <label><input type="radio" name="mode" value="manual" /> Пошагово вручную</label>
    </div>
    <div class="button-row">
      <button id="startBtn" disabled>Начать сборку</button>
      <button id="stepBtn" class="secondary" disabled>Следующий шаг</button>
      <button id="continueBtn" class="secondary">Продолжить после конфликта</button>
      <button id="skipBtn" class="secondary">Пропустить конфликтующий пункт</button>
      <button id="abortBtn" class="secondary">Отменить сборку (cherry-pick --abort)</button>
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

  function renderLinks(entity) {
    const links = [];
    if (entity.taskUrl) links.push(\`<a href="\${entity.taskUrl}" target="_blank" rel="noopener">Задача</a>\`);
    if (entity.prUrl) links.push(\`<a href="\${entity.prUrl}" target="_blank" rel="noopener">PR #\${entity.prNumber}</a>\`);
    if (entity.commitUrl) links.push(\`<a href="\${entity.commitUrl}" target="_blank" rel="noopener">коммит</a>\`);
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

  function deselectBranch(ref) {
    selectedRefs.delete(ref);
    updateSelectedSummary();
    renderBranches();
  }

  function updateSelectedSummary() {
    const el = document.getElementById('selectedSummary');
    if (selectedRefs.size === 0) {
      el.textContent = 'Ветки не выбраны';
      return;
    }
    el.innerHTML = 'Выбрано: ' + [...selectedRefs].map((ref) => {
      const name = branchNameByRef.get(ref) || ref;
      return \`<span class="chip">\${name} <button class="chip-remove" data-ref="\${ref}" title="Убрать из выбора">×</button></span>\`;
    }).join('');

    [...el.querySelectorAll('.chip-remove')].forEach((btn) => {
      btn.addEventListener('click', (e) => deselectBranch(e.target.dataset.ref));
    });
  }

  function renderBranchCommits(ref) {
    const entry = branchCommitsCache.get(ref);
    if (entry === 'loading') return '<div class="branch-commits muted">Загрузка коммитов…</div>';
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

  function renderBranches() {
    // "Скрыть уже в main" применяется на сервере ДО среза по лимиту (см. session.ts
    // sendBranchSlice) — сюда уже приходит нужный список, дополнительно фильтровать не нужно.
    const el = document.getElementById('branchList');
    el.innerHTML = currentBranches.map((b) => {
      const expanded = expandedRefs.has(b.ref);
      const status = effectiveMainStatus(b.ref, b.mainStatus);
      return \`
      <div class="branch-row \${b.isRemote ? 'remote' : ''}">
        <div class="branch-row-main">
          <input type="checkbox" class="branch-check" data-ref="\${b.ref}" \${selectedRefs.has(b.ref) ? 'checked' : ''} />
          <span class="dot" style="background:\${colorFor(b.name)}"></span>
          <div class="branch-main">
            <div><span class="branch-name">\${b.name}</span> \${mainStatusBadge(status)}</div>
            <div class="muted sha">\${b.lastCommitSha ? b.lastCommitSha.slice(0,8) : ''} · \${formatDate(b.lastCommitDate)} · \${b.lastCommitAuthor} · \${b.lastCommitSubject}</div>
            \${renderLinks(b)}
            <button class="link expand-toggle" data-ref="\${b.ref}">\${expanded ? '▾ скрыть коммиты' : \`▸ показать коммиты (относительно \${configDevBranch}-ветки)\`}</button>
            \${expanded ? renderBranchCommits(b.ref) : ''}
          </div>
        </div>
      </div>
    \`;
    }).join('') || \`<div class="muted">Ничего не найдено (проверьте фильтр или флажок "Скрыть уже в \${configMainBranch}")</div>\`;

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
  }

  function renderBranchNamesList() {
    document.getElementById('branchNamesList').innerHTML = currentBranches.map((b) => \`<option value="\${b.name}">\`).join('');
  }

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
  // Только цифры — не полагаемся на type="number" (в нём по-прежнему можно набрать "e", "+", "-", ".")
  document.getElementById('branchListLimitInput').addEventListener('input', (e) => {
    const digitsOnly = e.target.value.replace(/[^0-9]/g, '');
    if (digitsOnly !== e.target.value) e.target.value = digitsOnly;
  });
  function setBranchListLimitBusy(busy) {
    const btn = document.getElementById('branchListLimitBtn');
    btn.disabled = busy;
    btn.textContent = busy ? 'Применяем…' : 'Применить';
  }
  // Чекбокс "скрыть уже в main" и лимит показа применяются ВМЕСТЕ, одним действием — фильтрация
  // по main теперь серверная и должна происходить ДО среза по лимиту (см. session.ts
  // sendBranchSlice), поэтому мгновенного эффекта у одного чекбокса больше нет.
  document.getElementById('branchListLimitBtn').addEventListener('click', () => {
    const limit = parseInt(document.getElementById('branchListLimitInput').value, 10);
    if (!limit || limit <= 0) return;
    const hideAlreadyInMain = document.getElementById('hideInMainFilter').checked;
    showError('');
    setBranchListLimitBusy(true);
    vscode.postMessage({ command: 'setBranchListLimit', limit, hideAlreadyInMain });
  });
  // В отличие от "скрыть уже в main" (нужен git-вызов, поэтому по кнопке "Применить"), это просто
  // проверка префикса имени — дёшево, применяется сразу же при переключении чекбокса.
  document.getElementById('hideServiceBranchesFilter').addEventListener('change', (e) => {
    document.getElementById('branchListInfo').textContent = 'Обновление списка веток…';
    vscode.postMessage({ command: 'setHideServiceBranches', hide: e.target.checked });
  });
  function setRefreshBusy(busy) {
    const btn = document.getElementById('refreshBtn');
    btn.disabled = busy;
    btn.textContent = busy ? 'Обновляем…' : 'Обновить список веток';
  }
  function setPullBusy(busy) {
    const btn = document.getElementById('pullBtn');
    btn.disabled = busy;
    btn.textContent = busy ? 'Pull…' : 'Pull (checkout + pull)';
  }

  document.getElementById('refreshBtn').addEventListener('click', () => {
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
  document.getElementById('pullBtn').addEventListener('click', () => {
    showError('');
    const branch = document.getElementById('pullBranchInput').value.trim();
    if (!branch) return;
    setPullBusy(true);
    vscode.postMessage({ command: 'pullBranch', branch });
  });

  function setBuildPlanBusy(busy) {
    const btn = document.getElementById('buildPlanBtn');
    btn.disabled = busy;
    // Dry-run теперь запускается автоматически сразу после построения хронологии — один и тот же
    // busy-статус кнопки покрывает оба шага, отдельного индикатора для dry-run больше не нужно.
    btn.textContent = busy ? 'Строим хронологию и проверяем конфликты…' : 'Построить хронологию выбранных веток';
  }

  document.getElementById('buildPlanBtn').addEventListener('click', () => {
    showError('');
    setBuildPlanBusy(true);
    vscode.postMessage({ command: 'buildPlan', selectedRefs: [...selectedRefs] });
  });

  document.getElementById('clearPlanBtn').addEventListener('click', () => {
    showError('');
    vscode.postMessage({ command: 'clearPlan' });
  });

  let itemsCollapsed = false;
  document.getElementById('itemsHeader').addEventListener('click', () => {
    itemsCollapsed = !itemsCollapsed;
    document.getElementById('itemsBody').classList.toggle('collapsed', itemsCollapsed);
    document.getElementById('itemsArrow').textContent = itemsCollapsed ? '▸' : '▾';
  });

  let contextCollapsed = false;
  document.getElementById('toggleContextBtn').addEventListener('click', () => {
    contextCollapsed = !contextCollapsed;
    renderItems();
  });

  document.getElementById('resetCopiedBtn').addEventListener('click', () => {
    copiedCherryCmdKeys.clear();
    renderCherryPickCommands();
  });

  function renderStaleBranchesLoading() {
    document.getElementById('staleBranches').innerHTML = '<div class="muted inline-loading">Проверяем, нет ли более старых невлитых веток…</div>';
  }

  function renderStaleBranches(hints) {
    const el = document.getElementById('staleBranches');
    if (!hints || hints.length === 0) {
      el.innerHTML = '<div class="muted">Более старых невлитых веток не нашлось.</div>';
      return;
    }
    el.innerHTML = '<div class="muted" style="margin-bottom:4px;">Отсоединились раньше самой ранней ветки в этой хронологии и ещё не выпущены — возможно, забыли:</div>' +
      hints.map((h) => {
        const link = h.commitUrl ? \`<a href="\${h.commitUrl}" target="_blank" rel="noopener">\${h.sha.slice(0,8)}</a>\` : h.sha.slice(0,8);
        return \`<div class="stale-branch-row">→ <b>\${escapeHtml(h.branch)}</b> — «\${escapeHtml(h.subject)}», \${link} · \${escapeHtml(h.authorName)} · \${formatDate(h.authorDate)}</div>\`;
      }).join('');
  }

  document.getElementById('createBranchBtn').addEventListener('click', () => {
    showError('');
    vscode.postMessage({ command: 'startBuilding', releaseDate: document.getElementById('releaseDate').value.trim() });
  });

  document.getElementById('startBtn').addEventListener('click', () => vscode.postMessage({ command: 'startAuto' }));
  document.getElementById('stepBtn').addEventListener('click', () => vscode.postMessage({ command: 'stepNext' }));
  document.getElementById('continueBtn').addEventListener('click', () => vscode.postMessage({ command: 'continueConflict' }));
  document.getElementById('skipBtn').addEventListener('click', () => vscode.postMessage({ command: 'skipConflict' }));

  function updateBuildButtonsState() {
    const ready = !!(currentPlan && currentPlan.releaseBranch);
    document.getElementById('startBtn').disabled = !ready;
    document.getElementById('stepBtn').disabled = !ready;
    document.getElementById('releaseBranchStatus').textContent = ready
      ? 'Релизная ветка: ' + currentPlan.releaseBranch
      : 'Релизная ветка ещё не создана';
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
      hint = \`<div class="conflict-hint">Похоже, эта задача уже выпущена в \${configMainBranch} (см. бейдж «уже в \${configMainBranch}») — возможно, проще просто исключить её из релиза (снять галочку), а не разрешать конфликт.</div>\`;
    } else {
      const allCauses = sources.flatMap((s) => (s.possibleCauses || []).map((c) => ({ ...c, file: s.file })));
      if (allCauses.length > 0) {
        const seen = new Set();
        const uniqueCauses = allCauses.filter((c) => (seen.has(c.branch) ? false : (seen.add(c.branch), true)));
        hint = '<div class="conflict-hint">Возможно, дело не в противоречащих правках, а в забытой задаче — эти ветки тоже меняют конфликтующий файл и ещё не выпущены:</div>' +
          uniqueCauses.map((c) => {
            const link = c.commitUrl ? \`<a href="\${c.commitUrl}" target="_blank" rel="noopener">\${c.sha.slice(0,8)}</a>\` : c.sha.slice(0,8);
            return \`<div class="conflict-cause">→ <b>\${escapeHtml(c.branch)}</b> — «\${escapeHtml(c.subject)}», \${link} · \${escapeHtml(c.authorName)} · \${formatDate(c.authorDate)}</div>\`;
          }).join('');
      } else {
        hint = '<div class="conflict-hint muted">Других веток, трогающих этот файл и ещё не выпущенных, не нашлось — похоже, конфликт придётся разрешить вручную.</div>';
      }
    }

    return details + hint;
  }

  function renderItemRow(item) {
    const color = colorFor(item.branch);
    let dryRunBadge = '';
    let conflictDetails = '';
    if (item.dryRunStatus === 'ok') dryRunBadge = '<span class="badge ok">конфликтов нет</span>';
    else if (item.dryRunStatus === 'empty') dryRunBadge = '<span class="badge inmain">уже применено (пустой cherry-pick)</span>';
    else if (item.dryRunStatus === 'conflict') {
      dryRunBadge = \`<span class="badge conflict">конфликт (\${item.dryRunConflictFiles.length} файл(ов))</span>\`;
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
      <div class="item-row">
        <input type="checkbox" class="item-check" data-sha="\${item.sha}" \${item.included ? 'checked' : ''} \${item.applied ? 'disabled' : ''} />
        <span class="lane-label" style="background:\${color}">\${item.branch}</span>
        <div class="item-main">
          <div>\${item.subject}</div>
          <div class="sha">\${item.sha.slice(0,8)} · \${item.authorName} · \${formatDate(item.authorDate)}</div>
          \${renderLinks(item)}
          <div>\${appliedBadge}\${dryRunBadge}\${overlapBadge}\${inMainBadge}</div>
          \${conflictDetails}
        </div>
      </div>
    \`;
  }

  function renderContextRow(commit) {
    return \`
      <div class="context-row">
        <span class="lane-label">\${configDevBranch}</span>
        <div class="item-main">
          <div>\${commit.subject}</div>
          <div class="sha">\${commit.sha.slice(0,8)} · \${commit.authorName} · \${formatDate(commit.authorDate)}</div>
          \${renderLinks(commit)}
        </div>
      </div>
    \`;
  }

  // Последний коммит dev ПЕРЕД началом хронологии — для ориентира, тот же стиль, что и обычные
  // контекстные коммиты, только с пояснением, почему он вообще тут (иначе непонятно, откуда взялся
  // коммит раньше даты самого первого пункта хронологии).
  function renderAnchorRow(commit) {
    return \`
      <div class="context-row">
        <span class="lane-label">\${configDevBranch}</span>
        <div class="item-main">
          <div>\${commit.subject} <span class="muted">— последний коммит \${configDevBranch} перед началом хронологии</span></div>
          <div class="sha">\${commit.sha.slice(0,8)} · \${commit.authorName} · \${formatDate(commit.authorDate)}</div>
          \${renderLinks(commit)}
        </div>
      </div>
    \`;
  }

  // "Rail" — дорожки веток слева от хронологии (см. drawRail — рисует их одним SVG). Лейн 0 всегда
  // зарезервирован под "ствол" dev (открыт на всю показанную историю — контекстные/якорный
  // коммиты и есть его настоящие коммиты). Каждая выбранная ветка получает свой лейн по порядку
  // первого появления среди items; лейн "открыт" от строки её первого коммита до строки, где
  // найден коммит слияния ЭТОЙ ветки обратно в dev (см. MERGE_SUBJECT_RE — тот же формат subject,
  // что и GitService.listMergeEvents), либо до конца показанного окна, если слияние не нашлось —
  // это и есть сигнал "ветка всё ещё не влита" прямо на графе, без отдельного текста.
  // ВАЖНО: этот кусок — часть ОДНОГО большого TS-темплейта в renderHtml() (весь HTML/JS панели —
  // одна строка-темплейт), поэтому обратные слэши здесь нужно ЭКРАНИРОВАТЬ ДВОЙНЫМ слэшем — иначе
  // компилятор съедает одиночный "\" ещё на этапе сборки САМОГО расширения (до того, как этот текст
  // вообще попадёт в браузер), и на выходе в собранном dist/extension.js регулярка превращается в
  // /^Merged in (S+) (pull request #(d+))/ — без единого реального \S/\(/\d/\) — поэтому НИЧЕГО не
  // матчилось, хотя сам исходный текст (и любой юнит-тест, читающий .ts-файл текстом, а не через
  // компилятор) выглядел абсолютно корректным. Отсюда и не находился mergedAtRow ни для одной ветки.
  const MERGE_SUBJECT_RE = /^Merged in (\\S+) \\(pull request #(\\d+)\\)/;

  function computeRail(merged) {
    const laneOf = new Map();
    let nextLane = 1;
    merged.forEach((row) => {
      if (row.kind === 'item' && !laneOf.has(row.item.branch)) {
        laneOf.set(row.item.branch, nextLane++);
      }
    });

    // ТОЛЬКО kind='mergeMarker' — построенные на клиенте из авторитетного ReleasePlan.mergeEventsByBranch
    // (см. renderItems), а не любая строка, чей subject случайно похож на "Merged in X (PR #N)".
    // Если имя ветки когда-то уже использовалось раньше (например, старая, другая по смыслу задача
    // была заведена на ветке с тем же именем и уже смёржена) — её СТАРЫЙ merge-коммит вполне может
    // сидеть среди обычных контекстных коммитов dev (findContextCommits ничего не знает про повторное
    // использование имён веток) и тоже матчиться регуляркой; раньше это приводило к тому, что дорожка
    // хватала первый попавшийся (более старый, а не текущий) merge и закрывала лейн ветки СЛИШКОМ
    // РАНО. mergeMarker строится только из слияний, которые сервер уже подтвердил как относящиеся к
    // ЭТОЙ ветке (см. applyMergeEvents в session.ts) — их может быть НЕСКОЛЬКО, если ветку мержили
    // за её жизнь больше одного раза (часть коммитов влита раньше отдельным PR, часть — позже).
    const mergeRowsByBranch = new Map();
    merged.forEach((row, idx) => {
      if (row.kind !== 'mergeMarker') return;
      const m = MERGE_SUBJECT_RE.exec((row.commit.subject || '').trim());
      if (m && laneOf.has(m[1])) {
        if (!mergeRowsByBranch.has(m[1])) mergeRowsByBranch.set(m[1], []);
        mergeRowsByBranch.get(m[1]).push(idx);
      }
    });

    const ranges = new Map();
    for (const branch of laneOf.keys()) {
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

    return { laneOf, ranges, mergeRowsByBranch };
  }

  const RAIL_LANE_W = 18;
  const RAIL_DOT_R = 4.5;

  function railWidth(rail) {
    return (rail.laneOf.size + 1) * RAIL_LANE_W;
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

    lines.push(\`<path d="M \${trunkX},\${rowCenters[0]} L \${trunkX},\${lastY}" stroke="\${trunkColor}" class="rail-line" />\`);
    merged.forEach((row, idx) => {
      if (row.kind === 'item') return;
      let color = trunkColor;
      let mergeBranch = null;
      for (const [branch, range] of rail.ranges) {
        // Финальное (закрывающее лейн) слияние — как и раньше; плюс любое более раннее слияние ЭТОЙ
        // ЖЕ ветки (см. intermediateMergeRows в computeRail — ветка, которую мержили несколько раз за
        // её жизнь) тоже отмечается точкой на стволе, просто не закрывает дорожку.
        if (range.mergedAtRow === idx || range.intermediateMergeRows.includes(idx)) {
          color = colorFor(branch);
          mergeBranch = branch;
          break;
        }
      }
      dots.push(railDot(trunkX, rowCenters[idx], color, mergeBranch));
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
      if (range.start > 0) {
        lines.push(\`<path d="\${laneCurve(trunkX, rowCenters[range.start - 1], x, rowCenters[range.start])}" stroke="\${color}" class="rail-line" data-branch="\${branch}" />\`);
      } else {
        // Небольшой выступ (плюс отступ #items сверху — см. CSS) — раньше заезжал на строку с
        // кнопкой "показать/скрыть контекстные коммиты dev", расположенную прямо над списком.
        lines.push(\`<path d="M \${x},-2 L \${x},\${rowCenters[range.start]}" stroke="\${color}" stroke-dasharray="3 3" class="rail-line" data-branch="\${branch}" />\`);
      }
      // Между стартом и финальным слиянием дорожка идёт прямой линией на СВОЕЙ дорожке, но на каждом
      // промежуточном слиянии (см. intermediateMergeRows в computeRail — ветку мержили больше одного
      // раза за её жизнь) ненадолго "заходит" на ствол и возвращается обратно — та же кривая, что и у
      // финального слияния, просто без закрытия лейна: дальше дорожка продолжается как ни в чём не бывало.
      let cursor = range.start;
      for (const mergeIdx of range.intermediateMergeRows) {
        const outFrom = Math.max(cursor, mergeIdx - 1);
        if (outFrom > cursor) {
          lines.push(\`<path d="M \${x},\${rowCenters[cursor]} L \${x},\${rowCenters[outFrom]}" stroke="\${color}" class="rail-line" data-branch="\${branch}" />\`);
        }
        lines.push(\`<path d="\${laneCurve(x, rowCenters[outFrom], trunkX, rowCenters[mergeIdx])}" stroke="\${color}" class="rail-line" data-branch="\${branch}" />\`);
        const backTo = Math.min(mergeIdx + 1, vertEndIdx);
        lines.push(\`<path d="\${laneCurve(trunkX, rowCenters[mergeIdx], x, rowCenters[backTo])}" stroke="\${color}" class="rail-line" data-branch="\${branch}" />\`);
        cursor = backTo;
      }
      if (vertEndIdx > cursor) {
        lines.push(\`<path d="M \${x},\${rowCenters[cursor]} L \${x},\${rowCenters[vertEndIdx]}" stroke="\${color}" class="rail-line" data-branch="\${branch}" />\`);
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
      renderCherryPickCommands();
      return;
    }

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
    const allMergeEvents = Object.values(mergeEventsByBranch).flat();
    const mergeEventShas = new Set(allMergeEvents.map((ev) => ev.sha));
    const mergeMarkerRows = allMergeEvents.map((ev) => ({
      kind: 'mergeMarker',
      date: ev.authorDate,
      commit: { sha: ev.sha, subject: ev.subject, authorDate: ev.authorDate, authorName: ev.authorName, taskUrl: ev.taskUrl, prUrl: ev.prUrl, prNumber: ev.prNumber, commitUrl: ev.commitUrl },
    }));
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

    el.innerHTML =
      '<div class="rail-overlay" id="railOverlay"></div>' +
      merged
        .map((entry) => {
          if (entry.kind === 'item') return \`<div class="timeline-row"><div class="rail-spacer" style="width:\${railW}px"></div>\${renderItemRow(entry.item)}</div>\`;
          if (entry.kind === 'anchor') return \`<div class="timeline-row"><div class="rail-spacer" style="width:\${railW}px"></div>\${renderAnchorRow(entry.commit)}</div>\`;
          if (entry.kind === 'mergeMarker' && contextCollapsed) {
            // Невидимая строка-маркер: нулевая высота, без текста, без разделителя — только чтобы у
            // дорожки была Y-координата для кривой слияния, пока контекстные коммиты свёрнуты.
            return \`<div class="timeline-row timeline-row-hidden"><div class="rail-spacer" style="width:\${railW}px"></div></div>\`;
          }
          return \`<div class="timeline-row"><div class="rail-spacer" style="width:\${railW}px"></div>\${renderContextRow(entry.commit)}</div>\`;
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
      });
    });

    renderCherryPickCommands();
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
      return;
    }
    section.style.display = 'block';

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
    if (msg.command === 'currentBranch') {
      document.getElementById('currentBranchName').textContent = msg.current;
      document.getElementById('mainBranchName').textContent = msg.mainBranch;
      configMainBranch = msg.mainBranch;
      configDevBranch = msg.devBranch;
      document.getElementById('hideInMainFilterBranchName').textContent = configMainBranch;
      document.getElementById('branchListLimitBtn').title = \`Применяет флажок «Скрыть в \${configMainBranch}» и лимит показа вместе\`;
      setPullBusy(false);
    } else if (msg.command === 'branches') {
      setBranchListLimitBusy(false);
      setRefreshBusy(false);
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
      renderBranchNamesList();
      updateSelectedSummary();
      const info = msg.info;
      if (!limitInitialized) {
        document.getElementById('branchListLimitInput').value = String(info.limit);
        limitInitialized = true;
      }
      const infoEl = document.getElementById('branchListInfo');
      if (info.totalBranches === 0) {
        infoEl.textContent = 'В репозитории не найдено веток.';
      } else if (info.truncated) {
        infoEl.textContent = \`Показано \${msg.branches.length} из \${info.totalMatches} совпадений (всего веток в репозитории: \${info.totalBranches}). Уточните фильтр или увеличьте лимит в настройках.\`;
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
    } else if (msg.command === 'branchCommits') {
      branchCommitsCache.set(msg.ref, { commits: msg.commits, truncated: msg.truncated, forkedFrom: msg.forkedFrom });
      // Точный статус по факту разворачивания: видно КАЖДЫЙ коммит ветки, поэтому можно отличить
      // "часть коммитов уже в main" от "полностью"/"совсем нет" — точнее приблизительного статуса с сервера.
      if (msg.commits.length > 0) {
        const matched = msg.commits.filter((c) => c.alreadyInMain).length;
        branchMainStatusOverride.set(msg.ref, matched === 0 ? 'none' : matched === msg.commits.length ? 'full' : 'partial');
      }
      renderBranches();
    } else if (msg.command === 'planBuilt') {
      setBuildPlanBusy(false);
      currentPlan = msg.plan;
      document.getElementById('staleBranches').innerHTML = '';
      copiedCherryCmdKeys.clear();
      renderItems();
      updateBuildButtonsState();
    } else if (msg.command === 'staleBranchesLoading') {
      renderStaleBranchesLoading();
    } else if (msg.command === 'staleBranches') {
      renderStaleBranches(msg.hints);
    } else if (msg.command === 'progress') {
      if (!currentPlan) return;
      const ev = msg.event;
      if (ev.type === 'applied') {
        const found = currentPlan.items.find((i) => i.sha === ev.item.sha);
        if (found) found.applied = true;
        renderItems();
      } else if (ev.type === 'conflict') {
        showError(
          'Конфликт на пункте ' + ev.item.sha.slice(0,8) + ' ("' + ev.item.subject + '"). ' +
          'Разрешите конфликт в файлах репозитория, затем нажмите "Продолжить после конфликта".'
        );
      } else if (ev.type === 'done') {
        showError('');
      }
    } else if (msg.command === 'error') {
      setBuildPlanBusy(false);
      setBranchListLimitBusy(false);
      setRefreshBusy(false);
      setPullBusy(false);
      showError(msg.message);
    }
  });

  vscode.postMessage({ command: 'refreshBranches' });
</script>
</body>
</html>`;
  }
}
