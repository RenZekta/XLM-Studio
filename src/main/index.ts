import { app, shell, BrowserWindow } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { registerIpcHandlers, cleanupAllProcesses, getRunningProcessCount } from './ipc'
import { existsSync } from 'fs'
function resolveIcon(): string | undefined {
  const candidates = [
    join(process.cwd(), 'assets', 'icon.png'),                  
    join(__dirname, '../../assets/icon.png'),                    
    join(app.getAppPath(), 'assets', 'icon.png')                 
  ]
  return candidates.find(existsSync)
}
function createWindow(): void {
  const icon = resolveIcon()
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
app.whenReady().then(() => {
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
// (previously a child could keep port 1234 alive, forcing a Task Manager kill).
// `before-quit` fires before the app actually exits; we block the quit briefly
// to let killProcessTree do its job, then re-quit.
let _cleaningUp = false
app.on('before-quit', (event) => {
  if (_cleaningUp) return
  if (getRunningProcessCount() > 0) {
    _cleaningUp = true
    event.preventDefault()
    cleanupAllProcesses().finally(() => {
      _cleaningUp = false
      app.quit()
    })
  }
})
