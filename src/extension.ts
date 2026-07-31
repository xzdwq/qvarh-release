import * as vscode from 'vscode';
import { readProjects } from './config';
import { ReleaseSession } from './session';
import { SettingsViewProvider } from './ui/settingsView';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('qvarhRelease.settingsView', new SettingsViewProvider()),

    vscode.commands.registerCommand('qvarhRelease.startRelease', async () => {
      try {
        const session = new ReleaseSession(context);
        await session.start(context.extensionUri);
      } catch (err: any) {
        vscode.window.showErrorMessage(`Qvarh Release: ${err?.message ?? err}`);
      }
    }),

    vscode.commands.registerCommand('qvarhRelease.continueRelease', async () => {
      try {
        const session = new ReleaseSession(context);
        await session.resume(context.extensionUri);
      } catch (err: any) {
        vscode.window.showErrorMessage(`Qvarh Release: ${err?.message ?? err}`);
      }
    }),

    // Запуск сборки для КОНКРЕТНОГО сохранённого профиля проекта (см. "Проекты" в боковой панели)
    // — минуя единственный текущий конфиг и открытый workspace, сразу с настройками этого профиля.
    vscode.commands.registerCommand('qvarhRelease.startReleaseForProject', async (projectId: string) => {
      try {
        const project = readProjects().find((p) => p.id === projectId);
        if (!project) {
          throw new Error(`Профиль проекта не найден (id=${projectId}) — возможно, он был удалён или изменён в другом окне.`);
        }
        const session = new ReleaseSession(context);
        await session.start(context.extensionUri, project);
      } catch (err: any) {
        vscode.window.showErrorMessage(`Qvarh Release: ${err?.message ?? err}`);
      }
    })
  );
}

export function deactivate(): void {}
