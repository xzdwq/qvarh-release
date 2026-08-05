import * as vscode from 'vscode';

/**
 * "Какой проект сейчас открыт в панели сборки релиза" — общее состояние между ReleasePanel и
 * SettingsViewProvider (см. project-row highlight в settingsView.ts), вынесенное в отдельный
 * модуль, а не импортом одного файла в другой напрямую: ReleasePanel уже мог бы понадобиться
 * settingsView.ts (например, чтобы дёрнуть createOrShow), и наоборот — обратная связь через общий
 * нейтральный модуль без риска цикличных импортов.
 */
const emitter = new vscode.EventEmitter<string | undefined>();
export const onActiveProjectChanged = emitter.event;

let activeProjectId: string | undefined;

/** undefined — открыт "текущий workspace" без сохранённого профиля, либо панель вообще закрыта. */
export function getActiveProjectId(): string | undefined {
  return activeProjectId;
}

export function setActiveProjectId(id: string | undefined): void {
  if (activeProjectId === id) return;
  activeProjectId = id;
  emitter.fire(id);
}
