import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'
app.whenReady().then(() => {
  const win = new BrowserWindow({ webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: true } })
  void win.loadFile(join(__dirname, '../renderer/index.html'))
})
