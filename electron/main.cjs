const { app, BrowserWindow, ipcMain, dialog } = require('electron')
const { spawn } = require('node:child_process')
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const { randomUUID } = require('node:crypto')
const { join, resolve } = require('node:path')

const profiles = new Set([
  'session-json', 'api-json', 'cache-json', 'counter', 'uuid',
  'text', 'repetitive', 'compressed', 'random',
])

let mainWindow
let activeChild = null

function snugRepo() {
  return resolve(process.env.SNUGKV_REPO || join(process.cwd(), '..', 'SnugKV'))
}

function scriptPath() {
  return join(snugRepo(), 'scripts', 'bench', 'bench-one.sh')
}

function positiveInt(value, fallback, max) {
  const n = Number(value)
  return Number.isInteger(n) && n > 0 && n <= max ? n : fallback
}

function sanitize(body = {}) {
  return {
    profile: profiles.has(String(body.profile)) ? String(body.profile) : 'uuid',
    host: String(body.host || '127.0.0.1'),
    port: positiveInt(body.port, 6379, 65535),
    server: String(body.server || 'server').replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 40) || 'server',
    keys: positiveInt(body.keys, 1_000_000, 100_000_000),
    getOps: positiveInt(body.getOps, 2_000_000, 500_000_000),
    workers: positiveInt(body.workers, 8, 256),
    pipeline: positiveInt(body.pipeline, 256, 8192),
    settleMs: Math.max(0, Math.min(Number(body.settleMs) || 0, 600_000)),
    seed: Number.isSafeInteger(Number(body.seed)) ? Number(body.seed) : 1,
  }
}

function emit(job) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('bench:update', job)
  }
}

ipcMain.handle('bench:environment', () => ({
  snugkvRepo: snugRepo(),
  script: scriptPath(),
  scriptFound: existsSync(scriptPath()),
}))

ipcMain.handle('bench:start', async (_event, rawConfig) => {
  if (activeChild) {
    throw new Error('A benchmark is already running')
  }

  const script = scriptPath()
  if (!existsSync(script)) {
    throw new Error(`Benchmark script not found at ${script}. Set SNUGKV_REPO to your SnugKV checkout.`)
  }

  const c = sanitize(rawConfig)
  const id = randomUUID()
  const out = join(app.getPath('userData'), 'runs', id)
  mkdirSync(out, { recursive: true })

  const args = [
    script,
    c.profile,
    '-p', String(c.port),
    '-h', c.host,
    '-s', c.server,
    '-k', String(c.keys),
    '-g', String(c.getOps),
    '-w', String(c.workers),
    '-P', String(c.pipeline),
    '--settle-ms', String(c.settleMs),
    '--seed', String(c.seed),
    '-o', out,
  ]

  const job = {
    id,
    status: 'running',
    command: ['bash', ...args].join(' '),
    log: '',
    startedAt: new Date().toISOString(),
  }

  const child = spawn('bash', args, {
    cwd: snugRepo(),
    env: process.env,
  })
  activeChild = child

  const append = chunk => {
    job.log += chunk.toString()
    if (job.log.length > 300_000) job.log = job.log.slice(-300_000)
    emit(job)
  }

  child.stdout.on('data', append)
  child.stderr.on('data', append)

  child.on('error', error => {
    job.status = 'failed'
    job.error = error.message
    job.finishedAt = new Date().toISOString()
    activeChild = null
    emit(job)
  })

  child.on('close', code => {
    job.finishedAt = new Date().toISOString()
    activeChild = null

    if (code !== 0) {
      job.status = 'failed'
      job.error = `Benchmark exited with code ${code}`
      emit(job)
      return
    }

    try {
      const load = JSON.parse(readFileSync(join(out, 'load.json'), 'utf8'))
      const get = JSON.parse(readFileSync(join(out, 'get.json'), 'utf8'))
      job.results = { load, get }
      job.status = 'done'
    } catch (error) {
      job.status = 'failed'
      job.error = error instanceof Error ? error.message : String(error)
    }

    emit(job)
  })

  return job
})

ipcMain.handle('bench:cancel', () => {
  if (!activeChild) return false
  activeChild.kill('SIGTERM')
  return true
})

ipcMain.handle('bench:save', async (_event, payload) => {
  const suggested = payload?.filename || 'snugkv-benchmark.json'
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Save benchmark result',
    defaultPath: suggested,
    filters: [{ name: 'JSON', extensions: ['json'] }],
  })
  if (result.canceled || !result.filePath) return { saved: false }
  writeFileSync(result.filePath, JSON.stringify(payload.data, null, 2) + '\n')
  return { saved: true, path: result.filePath }
})

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1050,
    minHeight: 700,
    backgroundColor: '#090c10',
    title: 'SnugKV Benchmark Lab',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  if (app.isPackaged) {
    mainWindow.loadFile(join(__dirname, '..', 'dist', 'index.html'))
  } else {
    mainWindow.loadURL(process.env.ELECTRON_START_URL || 'http://127.0.0.1:5173')
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  }
}

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
