const { app, BrowserWindow, ipcMain, dialog } = require('electron')
const { spawn } = require('node:child_process')
const { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } = require('node:fs')
const { randomUUID } = require('node:crypto')
const { join, resolve } = require('node:path')
const os = require('node:os')
const net = require('node:net')

const profiles = new Set([
  'session-json', 'api-json', 'cache-json', 'counter', 'uuid',
  'text', 'repetitive', 'compressed', 'random',
])

let mainWindow
let activeChild = null
let activeServer = null

const serverDefs = {
  redis: {
    label: 'redis',
    port: 6390,
  },
  'snug-raw': {
    label: 'snug-raw',
    port: 6382,
  },
  'snug-opt': {
    label: 'snug-opt',
    port: 6383,
  },
}

function snugRepo() {
  if (process.env.SNUGKV_REPO) return resolve(process.env.SNUGKV_REPO)

  const candidates = [
    join(os.homedir(), 'Downloads', 'SnugKV'),
    join(process.cwd(), '..', 'SnugKV'),
    join(process.cwd(), 'SnugKV'),
  ]

  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'scripts', 'bench', 'bench-one.sh'))) {
      return resolve(candidate)
    }
  }

  return resolve(join(os.homedir(), 'Downloads', 'SnugKV'))
}

function scriptPath() {
  return join(snugRepo(), 'scripts', 'bench', 'bench-one.sh')
}
function runtimeEnv() {
  const extra = [
    '/usr/local/go/bin',
    join(os.homedir(), 'go', 'bin'),
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/local/sbin',
    '/usr/sbin',
    '/sbin',
  ]
  const current = String(process.env.PATH || '').split(':').filter(Boolean)
  return {
    ...process.env,
    PATH: [...new Set([...extra, ...current])].join(':'),
  }
}

function firstExecutable(candidates) {
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate
  }
  return candidates[candidates.length - 1]
}

function bashPath() {
  return firstExecutable(['/bin/bash', '/usr/bin/bash', 'bash'])
}

function goPath() {
  return firstExecutable([
    '/usr/local/go/bin/go',
    '/usr/bin/go',
    join(os.homedir(), 'go', 'bin', 'go'),
    'go',
  ])
}

function redisServerPath() {
  return firstExecutable(['/usr/bin/redis-server', '/usr/local/bin/redis-server', 'redis-server'])
}

function fuserPath() {
  return firstExecutable(['/usr/bin/fuser', '/bin/fuser', 'fuser'])
}

function windowIconPath() {
  return join(__dirname, '..', 'build', 'icons', '512x512.png')
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

function historyPath() {
  return join(app.getPath('userData'), 'best-results.json')
}

function normalizeServerLabel(label) {
  const value = String(label || '').toLowerCase().replace(/_/g, '-')
  if (value === 'redis') return 'redis'
  if (value === 'snug-raw') return 'snug-raw'
  if (value === 'snug-opt' || value === 'snug-mod') return 'snug-opt'
  return null
}

function emptyBest() {
  return {
    redis: null,
    'snug-raw': null,
    'snug-opt': null,
  }
}

function loadSavedHistory() {
  try {
    if (!existsSync(historyPath())) return {}
    return JSON.parse(readFileSync(historyPath(), 'utf8'))
  } catch {
    return {}
  }
}

function saveHistory(history) {
  writeFileSync(historyPath(), JSON.stringify(history, null, 2) + '\n')
}

function mergeBest(current, load, get, source) {
  if (!load || !get) return current
  const candidate = current || {
    bestSet: 0,
    bestGet: 0,
    lowestBytesPerKey: Number.POSITIVE_INFINITY,
    runs: 0,
    lastUpdated: null,
    source: null,
  }

  candidate.bestSet = Math.max(candidate.bestSet || 0, Number(load.ops_per_second) || 0)
  candidate.bestGet = Math.max(candidate.bestGet || 0, Number(get.ops_per_second) || 0)
  const bpk = Number(load.bytes_per_key_delta)
  if (Number.isFinite(bpk) && bpk > 0) {
    candidate.lowestBytesPerKey = Math.min(
      Number.isFinite(candidate.lowestBytesPerKey) ? candidate.lowestBytesPerKey : Number.POSITIVE_INFINITY,
      bpk,
    )
  }
  candidate.runs = (candidate.runs || 0) + 1
  candidate.lastUpdated = new Date().toISOString()
  candidate.source = source
  return candidate
}

function scanCliHistory(profile) {
  const best = emptyBest()
  const root = join(snugRepo(), 'benchmark-results')
  if (!existsSync(root)) return best

  let dirs = []
  try {
    dirs = readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory())
  } catch {
    return best
  }

  for (const entry of dirs) {
    const dir = join(root, entry.name)
    const loadPath = join(dir, 'load.json')
    const getPath = join(dir, 'get.json')
    if (!existsSync(loadPath) || !existsSync(getPath)) continue

    try {
      const load = JSON.parse(readFileSync(loadPath, 'utf8'))
      const get = JSON.parse(readFileSync(getPath, 'utf8'))
      if (load.value_shape !== profile || get.value_shape !== profile) continue
      const key = normalizeServerLabel(load.server)
      if (!key) continue
      best[key] = mergeBest(best[key], load, get, 'cli')
    } catch {
      // Ignore incomplete or manually edited benchmark directories.
    }
  }

  return best
}

function bestResultsForProfile(profile) {
  const result = scanCliHistory(profile)
  const saved = loadSavedHistory()
  const profileSaved = saved[profile] || {}

  for (const key of ['redis', 'snug-raw', 'snug-opt']) {
    const record = profileSaved[key]
    if (!record) continue
    const current = result[key]
    if (!current) {
      result[key] = record
      continue
    }
    current.bestSet = Math.max(current.bestSet || 0, record.bestSet || 0)
    current.bestGet = Math.max(current.bestGet || 0, record.bestGet || 0)
    const values = [current.lowestBytesPerKey, record.lowestBytesPerKey].filter(v => Number.isFinite(v) && v > 0)
    current.lowestBytesPerKey = values.length ? Math.min(...values) : Number.POSITIVE_INFINITY
    current.runs = Math.max(current.runs || 0, record.runs || 0)
    if (record.lastUpdated && (!current.lastUpdated || record.lastUpdated > current.lastUpdated)) {
      current.lastUpdated = record.lastUpdated
      current.source = record.source
    }
  }

  return result
}

function recordCompletedResult(load, get) {
  const profile = load?.value_shape
  const key = normalizeServerLabel(load?.server)
  if (!profile || !key) return

  const history = loadSavedHistory()
  if (!history[profile]) history[profile] = {}
  history[profile][key] = mergeBest(history[profile][key], load, get, 'electron')
  saveHistory(history)

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('history:update', {
      profile,
      best: bestResultsForProfile(profile),
    })
  }
}

function waitForPort(host, port, timeoutMs = 10000) {
  return new Promise((resolveReady, rejectReady) => {
    const deadline = Date.now() + timeoutMs

    const attempt = () => {
      const socket = net.createConnection({ host, port })
      socket.setTimeout(500)

      const fail = () => {
        socket.destroy()
        if (Date.now() >= deadline) {
          rejectReady(new Error(`Timed out waiting for ${host}:${port}`))
        } else {
          setTimeout(attempt, 100)
        }
      }

      socket.once('connect', () => {
        socket.end()
        resolveReady()
      })
      socket.once('error', fail)
      socket.once('timeout', fail)
    }

    attempt()
  })
}

function runCommand(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout?.on('data', chunk => { output += chunk.toString() })
    child.stderr?.on('data', chunk => { output += chunk.toString() })
    child.once('error', rejectRun)
    child.once('close', code => {
      if (code === 0) resolveRun(output)
      else rejectRun(new Error(`${command} exited with code ${code}: ${output.trim()}`))
    })
  })
}

async function killBenchmarkPorts() {
  if (activeServer?.child && !activeServer.child.killed) {
    activeServer.child.kill('SIGTERM')
  }
  activeServer = null

  if (process.platform === 'linux') {
    try {
      await runCommand(fuserPath(), ['-k', '6390/tcp', '6382/tcp', '6383/tcp'], { env: runtimeEnv() })
    } catch {
      // fuser exits non-zero when no process owns a port; that is fine.
    }
    return
  }

  // On non-Linux platforms we only terminate processes started by this app.
}

async function buildSnugBinary() {
  const binDir = join(app.getPath('userData'), 'bin')
  mkdirSync(binDir, { recursive: true })
  const binary = join(binDir, process.platform === 'win32' ? 'snugkv.exe' : 'snugkv')
  await runCommand(goPath(), ['build', '-o', binary, './cmd/snugkv'], { cwd: snugRepo(), env: runtimeEnv() })
  return binary
}

async function startManagedServer(kind) {
  if (activeChild) throw new Error('Cannot switch database server while a benchmark is running')
  const def = serverDefs[kind]
  if (!def) throw new Error(`Unknown server kind: ${kind}`)

  await killBenchmarkPorts()

  let command
  let args
  let cwd = snugRepo()

  if (kind === 'redis') {
    command = redisServerPath()
    args = [
      '--bind', '127.0.0.1',
      '--port', String(def.port),
      '--save', '',
      '--appendonly', 'no',
      '--protected-mode', 'no',
    ]
    cwd = process.cwd()
  } else {
    command = await buildSnugBinary()
    args = [
      '-listen', `127.0.0.1:${def.port}`,
      '-admin-listen', '',
      '-pprof-listen', '',
    ]
    if (kind === 'snug-raw') {
      args.push('-encoding=false', '-compression=false', '-json-shape=false')
    } else {
      args.push('-encoding=true', '-compression=true', '-json-shape=true')
    }
  }

  const child = spawn(command, args, {
    cwd,
    env: runtimeEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const logs = []
  const append = chunk => {
    logs.push(chunk.toString())
    if (logs.length > 100) logs.shift()
  }
  child.stdout.on('data', append)
  child.stderr.on('data', append)

  activeServer = { kind, child, port: def.port, label: def.label }

  child.once('exit', () => {
    if (activeServer?.child === child) activeServer = null
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('server:update', {
        running: false,
        kind,
        port: def.port,
        label: def.label,
      })
    }
  })

  try {
    await waitForPort('127.0.0.1', def.port, 15000)
  } catch (error) {
    child.kill('SIGTERM')
    activeServer = null
    const detail = logs.join('').trim()
    throw new Error(`${error.message}${detail ? `\n${detail}` : ''}`)
  }

  const status = {
    running: true,
    kind,
    port: def.port,
    label: def.label,
  }
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('server:update', status)
  return status
}

ipcMain.handle('server:start', async (_event, kind) => startManagedServer(kind))
ipcMain.handle('server:stop', async () => {
  if (activeChild) throw new Error('Cannot stop database server while a benchmark is running')
  await killBenchmarkPorts()
  const status = { running: false }
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('server:update', status)
  return status
})
ipcMain.handle('server:status', () => {
  if (!activeServer) return { running: false }
  return {
    running: true,
    kind: activeServer.kind,
    port: activeServer.port,
    label: activeServer.label,
  }
})

ipcMain.handle('history:get', (_event, profile) => {
  if (!profiles.has(String(profile))) return emptyBest()
  return bestResultsForProfile(String(profile))
})

ipcMain.handle('bench:environment', () => ({
  snugkvRepo: snugRepo(),
  script: scriptPath(),
  scriptFound: existsSync(scriptPath()),
  bash: bashPath(),
  go: goPath(),
  redisServer: redisServerPath(),
  fuser: fuserPath(),
  path: runtimeEnv().PATH,
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

  const child = spawn(bashPath(), args, {
    cwd: snugRepo(),
    env: {
      ...runtimeEnv(),
      SNUGKV_GO_BIN: goPath(),
    },
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
      recordCompletedResult(load, get)
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
    title: 'Skv Benchmark Lab',
    icon: windowIconPath(),
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  mainWindow.removeMenu()

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

app.on('before-quit', () => {
  if (activeChild) activeChild.kill('SIGTERM')
  if (activeServer?.child) activeServer.child.kill('SIGTERM')
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
