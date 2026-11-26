/** Optional "launch when Windows starts". Off unless the user turns it on. */
import { app } from 'electron'

export const AUTOSTART_ARG = '--autostart'

function target(): { path: string; args: string[] } {
  // A portable build unpacks itself to a temp folder; the real executable is named here.
  const portable = process.env.PORTABLE_EXECUTABLE_FILE
  return { path: portable && portable.length > 0 ? portable : process.execPath, args: [AUTOSTART_ARG] }
}

export function autostartSupported(): boolean {
  return app.isPackaged && (process.platform === 'win32' || process.platform === 'darwin')
}

export function applyAutostart(enabled: boolean): void {
  if (!autostartSupported()) return
  const { path, args } = target()
  app.setLoginItemSettings({ openAtLogin: enabled, path, args })
}

export function readAutostart(): boolean {
  if (!autostartSupported()) return false
  const { path, args } = target()
  return app.getLoginItemSettings({ path, args }).openAtLogin
}
