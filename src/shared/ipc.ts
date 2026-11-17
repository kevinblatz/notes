/** IPC channel names shared by the main process and the preload bridge. */
export const IPC = {
  snapshot: 'tn:snapshot',
  createNote: 'tn:note:create',
  saveNote: 'tn:note:save',
  discardNote: 'tn:note:discard',
  trashNote: 'tn:note:trash',
  restoreNote: 'tn:note:restore',
  listTrash: 'tn:trash:list',
  purge: 'tn:trash:purge',
  saveLayout: 'tn:layout:save',
  setPins: 'tn:pins:set',
  importImage: 'tn:image:import',
  setPreferences: 'tn:prefs:set',
  setShortcut: 'tn:shortcut:set',
  suspendShortcut: 'tn:shortcut:suspend',
  windowAction: 'tn:window:action',
  setSession: 'tn:session:set',
  exportBackup: 'tn:backup:export',
  inspectBackup: 'tn:backup:inspect',
  runImport: 'tn:backup:import',
  openExternal: 'tn:open-external',
  openDataFolder: 'tn:open-data-folder',
  showInFolder: 'tn:show-in-folder',
  edit: 'tn:edit',
  flushDone: 'tn:flush-done',
  /** main -> window */
  event: 'tn:event'
} as const

export type WindowAction = 'hide' | 'minimize' | 'toggle-maximize' | 'quit' | 'dock-left' | 'dock-right'
