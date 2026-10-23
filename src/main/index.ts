import { app, shell, BrowserWindow } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { registerIpcHandlers, cleanupAllProcesses, getRunningProcessCount } from './ipc'
import { shutdownMcpLayer } from './mcpServer'
import { resolveAppIcon } from './appIcon'
function createWindow(): void {
  const icon = resolveAppIcon()
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#f5f5f5',
    ...(icon ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })
  mainWindow.webContents.setWindowOpenHandler((details) => {
    if (details.url.startsWith('https:') || details.url.startsWith('http:')) {
      shell.openExternal(details.url)
    }
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://') && !url.includes('localhost:') && !url.includes('127.0.0.1:')) {
      event.preventDefault()
    }
  })
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}
// One XLM Studio per user-data directory. A second instance would fight the
// first over the MCP port, llama-server ports and the same settings/template
// JSON files, so it quits right away and the running one is brought forward.
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  })
}
app.whenReady().then(() => {
  if (!gotSingleInstanceLock) return
  // Rebrand to XLM Studio — unique app user model id + standalone data dir.
  electronApp.setAppUserModelId('com.renzekta.xlmstudio')
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })
  registerIpcHandlers()
  createWindow()
  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// Before quitting, kill every still-running
// llama-server process tree so no orphan survives after XLM Studio closes
// and keeps a port (e.g. 1234) alive.
// `before-quit` fires before the app actually exits; we block the quit briefly
// to let killProcessTree do its job, then re-quit.
let _cleaningUp = false
app.on('before-quit', (event) => {
  if (_cleaningUp || !gotSingleInstanceLock) return
  shutdownMcpLayer().catch(() => {})
  if (getRunningProcessCount() > 0) {
    _cleaningUp = true
    event.preventDefault()
    cleanupAllProcesses().finally(() => {
      _cleaningUp = false
      app.quit()
    })
  }
})
