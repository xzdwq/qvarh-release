import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { parseNonTaskBranchPrefixes, readProjects, saveProjects } from '../config';
import { ProjectProfile } from '../core/types';

export class SettingsViewProvider implements vscode.WebviewViewProvider {
  resolveWebviewView(webviewView: vscode.WebviewView): void {
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.renderHtml();

    webviewView.webview.onDidReceiveMessage(async (message) => {
      try {
        switch (message.command) {
          case 'ready':
            this.postProjects(webviewView.webview);
            break;
          case 'saveProject':
            await this.saveProject(message.id ?? null, message.values, message.checkboxes ?? {});
            this.postProjects(webviewView.webview);
            webviewView.webview.postMessage({ command: 'saved' });
            break;
          case 'deleteProject':
            await this.deleteProject(message.id);
            this.postProjects(webviewView.webview);
            break;
          case 'startReleaseForProject':
            await vscode.commands.executeCommand('qvarhRelease.startReleaseForProject', message.id);
            break;
        }
      } catch (err: any) {
        webviewView.webview.postMessage({ command: 'error', message: err?.message ?? String(err) });
      }
    });

    this.postProjects(webviewView.webview);
  }

  private postProjects(webview: vscode.Webview): void {
    const projects = readProjects().map((p) => ({ ...p, nonTaskBranchPrefixes: p.nonTaskBranchPrefixes.join(', ') }));
    webview.postMessage({ command: 'projects', projects });
  }

  /** id === null — новый профиль (генерируем стабильный id); иначе обновляем существующий по id. */
  private async saveProject(
    id: string | null,
    values: Record<string, string>,
    checkboxes: Record<string, boolean>
  ): Promise<void> {
    if (!values.name?.trim()) {
      throw new Error('Укажите имя проекта.');
    }
    if (!values.repositoryPath?.trim()) {
      throw new Error('Укажите путь к репозиторию проекта.');
    }
    const limitRaw = Number(values.branchListLimit);
    const branchListLimit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 100;

    const profile: ProjectProfile = {
      id: id ?? crypto.randomUUID(),
      name: values.name.trim(),
      repositoryPath: values.repositoryPath.trim(),
      mainBranch: values.mainBranch?.trim() || 'main',
      devBranch: values.devBranch?.trim() || 'dev',
      remoteName: values.remoteName?.trim() || 'origin',
      releaseBranchPattern: values.releaseBranchPattern?.trim() || 'release/release-{date}',
      branchListLimit,
      nonTaskBranchPrefixes: parseNonTaskBranchPrefixes(values.nonTaskBranchPrefixes ?? ''),
      hideDuplicateRemoteBranches: checkboxes.hideDuplicateRemoteBranches ?? true,
      taskTrackerBaseUrl: values.taskTrackerBaseUrl?.trim() ?? '',
      bitbucketWorkspace: values.bitbucketWorkspace?.trim() ?? '',
      bitbucketRepoSlug: values.bitbucketRepoSlug?.trim() ?? '',
    };

    const projects = readProjects();
    const index = projects.findIndex((p) => p.id === profile.id);
    if (index >= 0) {
      projects[index] = profile;
    } else {
      projects.push(profile);
    }
    await saveProjects(projects);
  }

  private async deleteProject(id: string): Promise<void> {
    const projects = readProjects().filter((p) => p.id !== id);
    await saveProjects(projects);
  }

  private renderHtml(): string {
    return /* html */ `<!doctype html>
<html lang="ru">
<head>
<meta charset="UTF-8" />
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); font-size: 12px; padding: 12px; }
  h3 {
    margin: 0 0 4px; font-size: 11px; text-transform: uppercase; opacity: 0.75; letter-spacing: 0.06em;
    color: var(--vscode-textLink-foreground);
  }
  h4 {
    margin: 14px 0 4px; font-size: 10px; text-transform: uppercase; opacity: 0.6; letter-spacing: 0.05em;
  }
  h4:first-of-type { margin-top: 4px; }
  label { display: block; margin-top: 8px; margin-bottom: 2px; opacity: 0.9; }
  input[type=text] {
    width: 100%; box-sizing: border-box; background: var(--vscode-input-background);
    color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 3px; padding: 4px 6px;
  }
  input[type=text]:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .checkbox-field { display: flex; align-items: center; gap: 6px; margin-top: 10px; }
  .checkbox-field label { margin: 0; }
  .hint { opacity: 0.65; font-size: 11px; margin-top: 4px; line-height: 1.4; }
  button {
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border: none; border-radius: 3px; padding: 6px 10px; cursor: pointer; margin-top: 4px;
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  button:disabled:hover { background: var(--vscode-button-background); }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button.danger { background: var(--vscode-inputValidation-errorBorder); color: #fff; }
  .actions { display: flex; flex-direction: column; gap: 6px; margin-top: 10px; }
  #savedFlash { color: var(--vscode-charts-green); font-size: 11px; height: 14px; }
  #errorFlash { color: var(--vscode-errorForeground); font-size: 11px; white-space: pre-wrap; }
  hr { border: none; border-top: 1px solid var(--vscode-panel-border); margin: 16px 0; }

  .panel-header { margin-bottom: 10px; }
  .panel-header .hint { margin-top: 2px; }

  .projects-list { margin-top: 8px; display: flex; flex-direction: column; gap: 6px; }
  .project-row {
    display: flex; align-items: center; gap: 6px; padding: 7px 8px;
    border: 1px solid var(--vscode-panel-border); border-radius: 6px;
    background: var(--vscode-list-hoverBackground, transparent);
  }
  .project-row-info { flex: 1; min-width: 0; }
  .project-row-name { font-weight: 600; }
  .project-row-path { opacity: 0.65; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .project-row button { margin: 0; padding: 4px 8px; font-size: 12px; line-height: 1; border-radius: 4px; }
  .project-row.confirm-row { background: transparent; border-color: var(--vscode-inputValidation-errorBorder); }
  .project-row.confirm-row .project-row-info { font-size: 11px; line-height: 1.4; color: var(--vscode-errorForeground); }

  .project-form {
    margin-top: 10px; padding: 10px; border-radius: 6px;
    background: var(--vscode-editorWidget-background, transparent);
    border: 1px solid var(--vscode-panel-border);
  }
  .project-form-title { font-weight: 600; margin-bottom: 4px; }
</style>
</head>
<body>

  <div class="panel-header">
    <h3>Проекты</h3>
    <div class="hint">Профиль репозитория — путь на диске и настройки веток/ссылок. Кнопка 🚀 у проекта сразу открывает панель сборки для него, независимо от того, какой workspace открыт сейчас.</div>
  </div>

  <div id="projectsList" class="projects-list"></div>

  <div id="projectForm" class="project-form" style="display:none;">
    <div id="projectFormTitle" class="project-form-title">Новый проект</div>

    <label>Имя проекта</label>
    <input type="text" id="proj_name" placeholder="my-project" />
    <label>Путь к репозиторию</label>
    <input type="text" id="proj_repositoryPath" placeholder="C:\\path\\to\\repo" />

    <h4>Git</h4>
    <label>Основная ветка (от неё создаётся релизная)</label>
    <input type="text" id="proj_mainBranch" placeholder="main" />
    <label>Dev-ветка (от неё создаются feature/fix-ветки)</label>
    <input type="text" id="proj_devBranch" placeholder="dev" />
    <label>Remote</label>
    <input type="text" id="proj_remoteName" placeholder="origin" />
    <label>Шаблон релизной ветки ({date})</label>
    <input type="text" id="proj_releaseBranchPattern" placeholder="release/release-{date}" />
    <label>Сколько веток показывать по умолчанию</label>
    <input type="text" id="proj_branchListLimit" placeholder="100" />
    <label>Префиксы служебных веток (через запятую)</label>
    <input type="text" id="proj_nonTaskBranchPrefixes" placeholder="qa, revert-pr-, chore/" />
    <div class="checkbox-field">
      <input type="checkbox" id="proj_hideDuplicateRemoteBranches" />
      <label for="proj_hideDuplicateRemoteBranches">Скрывать remote-ветку, если есть локальная с тем же именем</label>
    </div>

    <h4>Ссылки</h4>
    <label>Базовый URL задачи в таск-трекере</label>
    <input type="text" id="proj_taskTrackerBaseUrl" placeholder="https://your-company.atlassian.net/browse" />
    <label>Bitbucket workspace</label>
    <input type="text" id="proj_bitbucketWorkspace" placeholder="my-workspace" />
    <label>Bitbucket repo slug</label>
    <input type="text" id="proj_bitbucketRepoSlug" placeholder="my-repo" />

    <div class="actions">
      <button id="projSaveBtn">Сохранить проект</button>
      <button id="projCancelBtn" class="secondary">Отмена</button>
    </div>
  </div>

  <div class="actions">
    <button id="projAddBtn" class="secondary">+ Добавить проект</button>
    <div id="savedFlash"></div>
  </div>

  <div id="errorFlash"></div>

<script>
  const vscode = acquireVsCodeApi();
  const PROJECT_FIELDS = ['name','repositoryPath','mainBranch','devBranch','remoteName','releaseBranchPattern','branchListLimit','nonTaskBranchPrefixes','taskTrackerBaseUrl','bitbucketWorkspace','bitbucketRepoSlug'];
  const PROJECT_CHECKBOX_FIELDS = ['hideDuplicateRemoteBranches'];

  let projects = [];
  let editingProjectId = null;
  let pendingDeleteId = null;

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  }

  function isProjectFormOpen() {
    return document.getElementById('projectForm').style.display !== 'none';
  }

  function renderProjectsList() {
    const el = document.getElementById('projectsList');
    if (projects.length === 0) {
      el.innerHTML = '<div class="hint">Проектов пока нет — добавьте первый ниже.</div>';
      return;
    }
    // Пока открыта форма редактирования/добавления проекта, "🚀 Собрать релизную ветку" для ЛЮБОГО
    // проекта заблокирована — иначе легко случайно запустить сборку со старыми настройками, пока
    // редактируешь текущие и ещё не сохранил (или просто забыл, что форма всё ещё открыта).
    const formOpen = isProjectFormOpen();
    el.innerHTML = projects.map((p) => {
      if (p.id === pendingDeleteId) {
        return \`
          <div class="project-row confirm-row">
            <div class="project-row-info">Удалить «\${escapeHtml(p.name)}»? Сам репозиторий на диске не тронется — сотрётся только сохранённый профиль настроек.</div>
            <button class="danger" data-action="confirm-delete" data-id="\${p.id}">Да, удалить</button>
            <button class="secondary" data-action="cancel-delete" data-id="\${p.id}">Отмена</button>
          </div>
        \`;
      }
      const startTitle = formOpen ? 'Сначала закройте форму редактирования проекта' : 'Собрать релизную ветку для этого проекта';
      return \`
      <div class="project-row">
        <div class="project-row-info">
          <div class="project-row-name">\${escapeHtml(p.name)}</div>
          <div class="project-row-path">\${escapeHtml(p.repositoryPath)}</div>
        </div>
        <button data-action="start" data-id="\${p.id}" title="\${startTitle}" \${formOpen ? 'disabled' : ''}>🚀</button>
        <button class="secondary" data-action="edit" data-id="\${p.id}" title="Изменить">✎</button>
        <button class="secondary" data-action="delete" data-id="\${p.id}" title="Удалить">✕</button>
      </div>
    \`;
    }).join('');

    el.querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.id;
        const action = btn.dataset.action;
        const project = projects.find((p) => p.id === id);
        if (!project) return;
        if (action === 'start') {
          vscode.postMessage({ command: 'startReleaseForProject', id });
        } else if (action === 'edit') {
          // Повторный клик на "✎" уже редактируемого проекта закрывает форму — точно так же, как
          // кнопка "Отмена", а не открывает её заново поверх самой себя.
          if (editingProjectId === id && isProjectFormOpen()) {
            hideProjectForm();
            return;
          }
          editingProjectId = id;
          document.getElementById('projectFormTitle').textContent = 'Изменить проект «' + project.name + '»';
          for (const f of PROJECT_FIELDS) {
            const input = document.getElementById('proj_' + f);
            if (input) input.value = project[f] ?? '';
          }
          for (const f of PROJECT_CHECKBOX_FIELDS) {
            const input = document.getElementById('proj_' + f);
            if (input) input.checked = project[f] !== false;
          }
          document.getElementById('projectForm').style.display = 'block';
          renderProjectsList();
        } else if (action === 'delete') {
          pendingDeleteId = id;
          renderProjectsList();
        } else if (action === 'cancel-delete') {
          pendingDeleteId = null;
          renderProjectsList();
        } else if (action === 'confirm-delete') {
          pendingDeleteId = null;
          vscode.postMessage({ command: 'deleteProject', id });
        }
      });
    });
  }

  function hideProjectForm() {
    editingProjectId = null;
    document.getElementById('projectForm').style.display = 'none';
    document.getElementById('projectFormTitle').textContent = 'Новый проект';
    for (const f of PROJECT_FIELDS) {
      const input = document.getElementById('proj_' + f);
      if (input) input.value = '';
    }
    for (const f of PROJECT_CHECKBOX_FIELDS) {
      const input = document.getElementById('proj_' + f);
      if (input) input.checked = true;
    }
    renderProjectsList();
  }

  document.getElementById('projAddBtn').addEventListener('click', () => {
    hideProjectForm();
    document.getElementById('projectForm').style.display = 'block';
    renderProjectsList();
  });
  document.getElementById('projCancelBtn').addEventListener('click', () => {
    hideProjectForm();
  });
  document.getElementById('projSaveBtn').addEventListener('click', () => {
    document.getElementById('errorFlash').textContent = '';
    const values = {};
    for (const f of PROJECT_FIELDS) {
      values[f] = document.getElementById('proj_' + f).value.trim();
    }
    const checkboxes = {};
    for (const f of PROJECT_CHECKBOX_FIELDS) {
      checkboxes[f] = document.getElementById('proj_' + f).checked;
    }
    vscode.postMessage({ command: 'saveProject', id: editingProjectId, values, checkboxes });
    hideProjectForm();
  });

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.command === 'projects') {
      projects = msg.projects;
      renderProjectsList();
    } else if (msg.command === 'saved') {
      const flash = document.getElementById('savedFlash');
      flash.textContent = 'Сохранено';
      setTimeout(() => { flash.textContent = ''; }, 2000);
    } else if (msg.command === 'error') {
      document.getElementById('errorFlash').textContent = msg.message;
    }
  });

  vscode.postMessage({ command: 'ready' });
</script>
</body>
</html>`;
  }
}
