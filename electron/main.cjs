const { app, BrowserWindow, ipcMain, dialog } = require('electron')
const { spawn, spawnSync } = require('node:child_process')
const { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } = require('node:fs')
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
let activeValidation = null
let activeValidationCancelled = false
let activeServer = null


const validationSuites = [
  {
    id: 'full-release',
    label: 'Full Release Validation',
    description: 'Full Go tests, race detector, vet, RESP fuzz, Redis 8.2 differential, durability and cluster recovery.',
    category: 'release',
    destructive: true,
  },
  {
    id: 'go-test',
    label: 'Go Test',
    description: 'Run the complete Go test suite once.',
    category: 'release',
  },
  {
    id: 'go-race',
    label: 'Race Detector',
    description: 'Run the complete Go test suite with the race detector.',
    category: 'release',
  },
  {
    id: 'go-vet',
    label: 'Go Vet',
    description: 'Static analysis across all Go packages.',
    category: 'release',
  },
  {
    id: 'resp-fuzz',
    label: 'RESP Fuzz',
    description: 'Fuzz the RESP command decoder for 60 seconds.',
    category: 'release',
  },
  {
    id: 'redis82-differential',
    label: 'Redis 8.2 Differential',
    description: 'Cross-restore, Function RDB, MIGRATE and RESP3 client compatibility against Redis 8.2.',
    category: 'release',
    destructive: true,
  },
  {
    id: 'durability',
    label: 'Durability Matrix',
    description: 'AOF, snapshots, rewrite, restart, replication persistence and durability fuzz gates.',
    category: 'release',
    destructive: true,
  },
  {
    id: 'cluster-recovery',
    label: 'Cluster Recovery Matrix',
    description: 'Run all retained cluster restart, partition, failover, migration and corruption recovery cases.',
    category: 'release',
    destructive: true,
  },
  {
    id: 'cluster-corrupt-replica',
    label: 'Corrupt Replica Recovery',
    description: 'Corrupt replica AOF, require fail-closed behavior, rebuild from primary and verify restart.',
    category: 'release',
    destructive: true,
  },
  {
    id: 'cluster-persistence-failure',
    label: 'Persistence Failure Recovery',
    description: 'Force AOF rewrite failure, verify live durability, recover rewrite and hard-restart.',
    category: 'release',
    destructive: true,
  },
  {
    id: 'cli-command-matrix',
    label: 'CLI Command Matrix',
    description: 'End-to-end redis-cli coverage for core commands plus feature-aware JSON, search, functions, persistence and cluster commands.',
    category: 'cli',
    destructive: true,
  },
  {
    id: 'full-soak',
    label: 'Full Soak',
    description: 'Run mixed workload soak followed by the distributed cluster chaos soak for the selected duration.',
    category: 'soak',
    destructive: true,
    configurable: true,
    defaultDurationSeconds: 600,
  },
  {
    id: 'distributed-soak',
    label: 'Distributed Chaos Soak',
    description: 'Repeated rebalance, restart, failover, recovery, partition, persistence and corruption chaos cases.',
    category: 'soak',
    destructive: true,
    configurable: true,
    defaultDurationSeconds: 600,
  },
  {
    id: 'mixed-soak',
    label: 'Mixed Workload Soak',
    description: 'Long-running in-process correctness, TTL churn, optimizer and memory-growth workload.',
    category: 'soak',
    configurable: true,
    defaultDurationSeconds: 600,
  },
]

const validationSuiteIds = new Set(validationSuites.map(suite => suite.id))

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
  const current = String(process.env.PATH || '').split(':').filter(Boolean)
  const fallback = [
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/local/sbin',
    '/usr/sbin',
    '/sbin',
    '/usr/local/go/bin',
    join(os.homedir(), 'go', 'bin'),
  ]
  const env = {
    ...process.env,
    PATH: [...new Set([...current, ...fallback])].join(':'),
  }

  // A stale inherited GOROOT can make a perfectly valid Go binary load
  // the standard library from the wrong installation.
  delete env.GOROOT
  return env
}

function executableFromPath(name) {
  const dirs = String(process.env.PATH || '').split(':').filter(Boolean)
  for (const dir of dirs) {
    const candidate = join(dir, name)
    if (existsSync(candidate)) return candidate
  }
  return null
}

function firstExecutable(candidates) {
  for (const candidate of candidates) {
    if (!candidate) continue
    if (!candidate.includes('/') || existsSync(candidate)) return candidate
  }
  return candidates[candidates.length - 1]
}

function bashPath() {
  return firstExecutable([executableFromPath('bash'), '/bin/bash', '/usr/bin/bash', 'bash'])
}

function loginShellExecutable(name) {
  try {
    const result = spawnSync('/bin/bash', ['-lc', `command -v ${name}`], {
      env: runtimeEnv(),
      encoding: 'utf8',
      timeout: 3000,
    })
    if (result.status !== 0) return null
    const value = String(result.stdout || '').trim().split('\n')[0]
    return value || null
  } catch {
    return null
  }
}

function goPath() {
  return firstExecutable([
    process.env.SNUGKV_GO_BIN,
    join(os.homedir(), 'Downloads', 'go1.27.1.linux-amd64', 'go', 'bin', 'go'),
    loginShellExecutable('go'),
    executableFromPath('go'),
    '/usr/local/go/bin/go',
    '/usr/bin/go',
    '/usr/local/bin/go',
    join(os.homedir(), '.local', 'go', 'bin', 'go'),
    join(os.homedir(), 'go', 'bin', 'go'),
    'go',
  ])
}

function redisServerPath() {
  return firstExecutable([executableFromPath('redis-server'), '/usr/bin/redis-server', '/usr/local/bin/redis-server', 'redis-server'])
}

function redisCliPath() {
  return firstExecutable([executableFromPath('redis-cli'), '/usr/bin/redis-cli', '/usr/local/bin/redis-cli', 'redis-cli'])
}

function requireActiveDbServer() {
  if (!activeServer?.port) throw new Error('Start a local Redis or SnugKV server first')
  return { host: '127.0.0.1', port: activeServer.port }
}

function cleanDbText(value, max = 4096) {
  return String(value ?? '').slice(0, max)
}

function shellDisplayArg(value) {
  const text = String(value)
  if (/^[a-zA-Z0-9_:.*/@+-]+$/.test(text)) return text
  return "'" + text.replace(/'/g, "'\\''") + "'"
}

function dbCommandDisplay(args) {
  const db = requireActiveDbServer()
  return ['redis-cli', '-h', db.host, '-p', String(db.port), ...args].map(shellDisplayArg).join(' ')
}

function runDbCli(args, options = {}) {
  const db = requireActiveDbServer()
  const result = spawnSync(redisCliPath(), ['--raw', '-h', db.host, '-p', String(db.port), ...args.map(String)], {
    env: runtimeEnv(),
    encoding: 'utf8',
    timeout: options.timeout ?? 8000,
    maxBuffer: 8 * 1024 * 1024,
  })
  if (result.error) throw result.error
  const stdout = String(result.stdout || '').replace(/\r/g, '').replace(/\n$/, '')
  const stderr = String(result.stderr || '').trim()
  if (result.status !== 0) throw new Error(stderr || stdout || `redis-cli exited with code ${result.status}`)
  if (stdout.startsWith('ERR ')) throw new Error(stdout)
  return stdout
}

function dbLines(output) {
  if (!output) return []
  return String(output).split('\n')
}

function dbPairs(lines) {
  const result = []
  for (let i = 0; i < lines.length; i += 2) result.push({ field: lines[i], value: lines[i + 1] ?? '' })
  return result
}

function fuserPath() {
  return firstExecutable([executableFromPath('fuser'), '/usr/bin/fuser', '/bin/fuser', 'fuser'])
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
    optimizerMode: body.optimizerMode === 'sidecar' ? 'sidecar' : 'dedicated',
  }
}


function sanitizeValidationOptions(body = {}) {
  return {
    durationSeconds: positiveInt(body.durationSeconds, 600, 7 * 24 * 60 * 60),
    caseTimeoutSeconds: positiveInt(body.caseTimeoutSeconds, 480, 3600),
    keys: positiveInt(body.keys, 100000, 100000000),
    workers: positiveInt(body.workers, 4, 256),
    valueBytes: positiveInt(body.valueBytes, 512, 1024 * 1024),
    seed: Number.isSafeInteger(Number(body.seed)) ? Number(body.seed) : 1,
  }
}

function emitValidation(job) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('validation:update', job)
  }
}

function validationCommand(suiteId, options) {
  switch (suiteId) {
    case 'go-test':
      return 'go test ./... -count=1'
    case 'go-race':
      return 'go test -race ./... -count=1'
    case 'go-vet':
      return 'go vet ./...'
    case 'resp-fuzz':
      return "go test ./internal/resp -run=^$ -fuzz=FuzzReadCommand -fuzztime=60s"
    case 'redis82-differential':
      return 'bash scripts/release/run-redis82-differential-gates.sh'
    case 'cli-command-matrix':
      return `SNUGKV_REPO=${JSON.stringify(snugRepo())} bash ${JSON.stringify(join(__dirname, '..', 'scripts', 'run-cli-command-matrix.sh'))}`
    case 'durability':
      return 'bash scripts/release/run-durability-gates.sh'
    case 'cluster-recovery':
      return 'bash scripts/cluster-recovery-matrix.sh'
    case 'cluster-corrupt-replica':
      return 'bash scripts/cluster-chaos-corrupt-replica.sh'
    case 'cluster-persistence-failure':
      return 'bash scripts/cluster-chaos-persistence-failure.sh'
    case 'full-soak':
      return [
        'go run -buildvcs=false ./cmd/snugsoak',
        `-duration ${options.durationSeconds}s`,
        `-keys ${options.keys}`,
        `-workers ${options.workers}`,
        `-bytes ${options.valueBytes}`,
        `-seed ${options.seed}`,
        '&& bash scripts/cluster-distributed-soak.sh',
      ].join(' ')
    case 'distributed-soak':
      return 'bash scripts/cluster-distributed-soak.sh'
    case 'mixed-soak':
      return [
        'go run -buildvcs=false ./cmd/snugsoak',
        `-duration ${options.durationSeconds}s`,
        `-keys ${options.keys}`,
        `-workers ${options.workers}`,
        `-bytes ${options.valueBytes}`,
        `-seed ${options.seed}`,
      ].join(' ')
    case 'full-release':
      return [
        'go test ./... -count=1',
        'go test -race ./... -count=1',
        'go vet ./...',
        "go test ./internal/resp -run=^$ -fuzz=FuzzReadCommand -fuzztime=60s",
        'bash scripts/release/run-redis82-differential-gates.sh',
        'bash scripts/release/run-durability-gates.sh',
        'bash scripts/cluster-recovery-matrix.sh',
      ].join(' && ')
    default:
      throw new Error(`Unknown validation suite: ${suiteId}`)
  }
}

function stopProcessTree(child) {
  if (!child || child.killed) return
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, 'SIGTERM')
      return
    } catch {
      // Fall through to the direct child when the process group is already gone.
    }
  }
  child.kill('SIGTERM')
}

function emit(job) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('bench:update', job)
  }
}

function historyPath() {
  return join(app.getPath('userData'), 'best-results.json')
}

function historyResetPath() {
  return join(app.getPath('userData'), 'best-results-reset.json')
}

function loadHistoryResets() {
  try {
    if (!existsSync(historyResetPath())) return {}
    return JSON.parse(readFileSync(historyResetPath(), 'utf8'))
  } catch {
    return {}
  }
}

function resetCutoff(profile) {
  const resets = loadHistoryResets()
  const value = Date.parse(String(resets[profile] || ''))
  return Number.isFinite(value) ? value : 0
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
  const cutoff = resetCutoff(profile)
  if (!existsSync(root)) return best

  let dirs = []
  try {
    dirs = readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory())
  } catch {
    return best
  }

  for (const entry of dirs) {
    const dir = join(root, entry.name)
    if (cutoff > 0) {
      try {
        if (statSync(dir).mtimeMs <= cutoff) continue
      } catch {
        continue
      }
    }
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
  const cutoff = resetCutoff(profile)

  for (const key of ['redis', 'snug-raw', 'snug-opt']) {
    const record = profileSaved[key]
    if (!record) continue
    if (cutoff > 0 && Date.parse(String(record.lastUpdated || '')) <= cutoff) continue
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

async function startManagedServer(request) {
  if (activeChild) throw new Error('Cannot switch database server while a benchmark is running')
  if (activeValidation) throw new Error('Cannot switch database server while validation is running')
  const kind = typeof request === 'string' ? request : request?.kind
  const optimizerMode = request?.optimizerMode === 'sidecar' ? 'sidecar' : 'dedicated'
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
      args.push(
        '-encoding=true',
        '-compression=true',
        '-json-shape=true',
        '-optimizer-mode', optimizerMode,
      )
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

  activeServer = {
    kind,
    child,
    port: def.port,
    label: def.label,
    optimizerMode: kind === 'snug-opt' ? optimizerMode : undefined,
  }

  child.once('exit', () => {
    if (activeServer?.child === child) activeServer = null
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('server:update', {
        running: false,
        kind,
        port: def.port,
        label: def.label,
        optimizerMode: kind === 'snug-opt' ? optimizerMode : undefined,
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
    optimizerMode: kind === 'snug-opt' ? optimizerMode : undefined,
  }
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('server:update', status)
  return status
}

ipcMain.handle('server:start', async (_event, request) => startManagedServer(request))
ipcMain.handle('server:stop', async () => {
  if (activeChild) throw new Error('Cannot stop database server while a benchmark is running')
  if (activeValidation) throw new Error('Cannot stop database server while validation is running')
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
    optimizerMode: activeServer.optimizerMode,
  }
})


ipcMain.handle('db:list-keys', (_event, request = {}) => {
  const db = requireActiveDbServer()
  const pattern = cleanDbText(request.pattern || '*', 256) || '*'
  const count = positiveInt(request.count, 300, 1000)
  const scan = spawnSync(redisCliPath(), ['--raw', '-h', db.host, '-p', String(db.port), '--scan', '--pattern', pattern, '--count', String(count)], {
    env: runtimeEnv(),
    encoding: 'utf8',
    timeout: 10000,
    maxBuffer: 8 * 1024 * 1024,
  })
  if (scan.error) throw scan.error
  if (scan.status !== 0) throw new Error(String(scan.stderr || scan.stdout || 'SCAN failed').trim())

  const names = dbLines(String(scan.stdout || '').replace(/\r/g, '').trim()).filter(Boolean).slice(0, count)
  const keys = names.map(key => {
    let type = 'unknown'
    try { type = runDbCli(['TYPE', key]) || 'unknown' } catch {}
    return { key, type }
  })
  return {
    keys,
    command: ['redis-cli', '-h', db.host, '-p', String(db.port), '--scan', '--pattern', shellDisplayArg(pattern), '--count', String(count)].join(' '),
  }
})

ipcMain.handle('db:get-key', (_event, request = {}) => {
  const key = cleanDbText(request.key, 4096)
  if (!key) throw new Error('Key is required')

  const type = runDbCli(['TYPE', key])
  if (!type || type === 'none') throw new Error('Key no longer exists')
  const ttl = Number(runDbCli(['TTL', key]))
  let value
  let length
  let command = dbCommandDisplay(['TYPE', key])

  if (type === 'string') {
    value = runDbCli(['GET', key])
    length = Number(runDbCli(['STRLEN', key]))
    command = dbCommandDisplay(['GET', key])
  } else if (type === 'hash') {
    const lines = dbLines(runDbCli(['HGETALL', key]))
    value = dbPairs(lines)
    length = Number(runDbCli(['HLEN', key]))
    command = dbCommandDisplay(['HGETALL', key])
  } else if (type === 'list') {
    value = dbLines(runDbCli(['LRANGE', key, '0', '-1']))
    length = Number(runDbCli(['LLEN', key]))
    command = dbCommandDisplay(['LRANGE', key, '0', '-1'])
  } else if (type === 'set') {
    value = dbLines(runDbCli(['SMEMBERS', key]))
    length = Number(runDbCli(['SCARD', key]))
    command = dbCommandDisplay(['SMEMBERS', key])
  } else if (type === 'zset') {
    const lines = dbLines(runDbCli(['ZRANGE', key, '0', '-1', 'WITHSCORES']))
    value = []
    for (let i = 0; i < lines.length; i += 2) value.push({ member: lines[i], score: lines[i + 1] ?? '' })
    length = Number(runDbCli(['ZCARD', key]))
    command = dbCommandDisplay(['ZRANGE', key, '0', '-1', 'WITHSCORES'])
  } else if (type.toLowerCase().includes('json') || type === 'ReJSON-RL') {
    const raw = runDbCli(['JSON.GET', key, '$'])
    try { value = JSON.parse(raw) } catch { value = raw }
    command = dbCommandDisplay(['JSON.GET', key, '$'])
  } else {
    try {
      value = runDbCli(['GET', key])
      command = dbCommandDisplay(['GET', key])
    } catch {
      value = `Preview is not implemented for type: ${type}`
    }
  }

  let encoding
  let memoryBytes
  try { encoding = runDbCli(['OBJECT', 'ENCODING', key]) || undefined } catch {}
  try {
    const rawMemory = Number(runDbCli(['MEMORY', 'USAGE', key]))
    if (Number.isFinite(rawMemory)) memoryBytes = rawMemory
  } catch {}

  return {
    key,
    type,
    ttl: Number.isFinite(ttl) ? ttl : -1,
    length,
    encoding,
    memoryBytes,
    value,
    command,
  }
})

ipcMain.handle('db:set-string', (_event, request = {}) => {
  const key = cleanDbText(request.key, 4096)
  const value = cleanDbText(request.value, 8 * 1024 * 1024)
  if (!key) throw new Error('Key is required')
  runDbCli(['SET', key, value])
  return { ok: true, command: dbCommandDisplay(['SET', key, value]) }
})

ipcMain.handle('db:set-ttl', (_event, request = {}) => {
  const key = cleanDbText(request.key, 4096)
  if (!key) throw new Error('Key is required')
  if (request.seconds === null || request.seconds === undefined || request.seconds === '') {
    runDbCli(['PERSIST', key])
    return { ok: true, command: dbCommandDisplay(['PERSIST', key]) }
  }
  const seconds = positiveInt(request.seconds, 60, 365 * 24 * 60 * 60)
  runDbCli(['EXPIRE', key, String(seconds)])
  return { ok: true, command: dbCommandDisplay(['EXPIRE', key, String(seconds)]) }
})

ipcMain.handle('db:delete-key', (_event, request = {}) => {
  const key = cleanDbText(request.key, 4096)
  if (!key) throw new Error('Key is required')
  runDbCli(['DEL', key])
  return { ok: true, command: dbCommandDisplay(['DEL', key]) }
})

ipcMain.handle('db:create-example', (_event, request = {}) => {
  const key = cleanDbText(request.key, 4096)
  const kind = String(request.kind || '')
  if (!key) throw new Error('Key is required')
  if (!['string', 'hash', 'list', 'set', 'zset', 'json'].includes(kind)) throw new Error('Unsupported example type')

  runDbCli(['DEL', key])
  let args
  if (kind === 'string') args = ['SET', key, 'Hello from SnugKV']
  if (kind === 'hash') args = ['HSET', key, 'name', 'Ada', 'role', 'engineer', 'active', 'true']
  if (kind === 'list') args = ['RPUSH', key, 'queued', 'processing', 'done']
  if (kind === 'set') args = ['SADD', key, 'redis', 'snugkv', 'database']
  if (kind === 'zset') args = ['ZADD', key, '1200', 'alice', '950', 'bob', '740', 'carol']
  if (kind === 'json') args = ['JSON.SET', key, '$', JSON.stringify({ name: 'Ada', role: 'engineer', skills: ['Go', 'TypeScript'], active: true })]

  runDbCli(args)
  return { ok: true, command: dbCommandDisplay(args) }
})

ipcMain.handle('db:mutate', (_event, request = {}) => {
  const action = String(request.action || '')
  const key = cleanDbText(request.key, 4096)
  if (!key) throw new Error('Key is required')

  let args
  if (action === 'hash-set') {
    const field = cleanDbText(request.field, 4096)
    if (!field) throw new Error('Field is required')
    args = ['HSET', key, field, cleanDbText(request.value, 8 * 1024 * 1024)]
  } else if (action === 'hash-del') {
    const field = cleanDbText(request.field, 4096)
    if (!field) throw new Error('Field is required')
    args = ['HDEL', key, field]
  } else if (action === 'list-push') {
    args = [request.side === 'left' ? 'LPUSH' : 'RPUSH', key, cleanDbText(request.value, 8 * 1024 * 1024)]
  } else if (action === 'list-set') {
    const index = Number(request.index)
    if (!Number.isInteger(index)) throw new Error('List index must be an integer')
    args = ['LSET', key, String(index), cleanDbText(request.value, 8 * 1024 * 1024)]
  } else if (action === 'list-del-index') {
    const index = Number(request.index)
    if (!Number.isInteger(index)) throw new Error('List index must be an integer')
    const marker = `__snugkv_delete_${randomUUID()}__`
    runDbCli(['LSET', key, String(index), marker])
    runDbCli(['LREM', key, '1', marker])
    return { ok: true, command: dbCommandDisplay(['LREM', key, '1', marker]) }
  } else if (action === 'set-add') {
    args = ['SADD', key, cleanDbText(request.value, 8 * 1024 * 1024)]
  } else if (action === 'set-del') {
    args = ['SREM', key, cleanDbText(request.value, 8 * 1024 * 1024)]
  } else if (action === 'zset-set') {
    const score = Number(request.score)
    if (!Number.isFinite(score)) throw new Error('Score must be a number')
    const member = cleanDbText(request.member, 8 * 1024 * 1024)
    if (!member) throw new Error('Member is required')
    args = ['ZADD', key, String(score), member]
  } else if (action === 'zset-del') {
    const member = cleanDbText(request.member, 8 * 1024 * 1024)
    if (!member) throw new Error('Member is required')
    args = ['ZREM', key, member]
  } else if (action === 'json-set-root') {
    const raw = cleanDbText(request.value, 8 * 1024 * 1024)
    try { JSON.parse(raw) } catch { throw new Error('JSON value is invalid') }
    args = ['JSON.SET', key, '$', raw]
  } else {
    throw new Error('Unsupported database mutation')
  }

  runDbCli(args)
  return { ok: true, command: dbCommandDisplay(args) }
})

ipcMain.handle('db:bulk', (_event, request = {}) => {
  const action = String(request.action || '')
  const keys = Array.isArray(request.keys)
    ? request.keys.map(key => cleanDbText(key, 4096)).filter(Boolean).slice(0, 500)
    : []
  if (!keys.length) throw new Error('Select at least one key')

  let affected = 0
  let command = ''
  if (action === 'delete') {
    for (const key of keys) affected += Number(runDbCli(['DEL', key])) || 0
    command = dbCommandDisplay(['DEL', ...keys])
  } else if (action === 'expire') {
    const seconds = positiveInt(request.seconds, 60, 365 * 24 * 60 * 60)
    for (const key of keys) affected += Number(runDbCli(['EXPIRE', key, String(seconds)])) || 0
    command = dbCommandDisplay(['EXPIRE', '<each selected key>', String(seconds)])
  } else if (action === 'persist') {
    for (const key of keys) affected += Number(runDbCli(['PERSIST', key])) || 0
    command = dbCommandDisplay(['PERSIST', '<each selected key>'])
  } else {
    throw new Error('Unsupported bulk action')
  }
  return { ok: true, command, affected }
})

ipcMain.handle('db:command', (_event, request = {}) => {
  const action = String(request.action || '')
  const key = cleanDbText(request.key, 4096)
  if (!key) throw new Error('Key is required')

  let args
  if (action === 'get') args = ['GET', key]
  else if (action === 'type') args = ['TYPE', key]
  else if (action === 'ttl') args = ['TTL', key]
  else if (action === 'exists') args = ['EXISTS', key]
  else if (action === 'incr') {
    const amount = Number(request.amount)
    if (!Number.isSafeInteger(amount)) throw new Error('Increment must be an integer')
    args = amount === 1 ? ['INCR', key] : ['INCRBY', key, String(amount)]
  } else if (action === 'set') {
    args = ['SET', key, cleanDbText(request.value, 8 * 1024 * 1024)]
  } else if (action === 'delete') {
    args = ['DEL', key]
  } else if (action === 'expire') {
    const seconds = positiveInt(request.seconds, 60, 365 * 24 * 60 * 60)
    args = ['EXPIRE', key, String(seconds)]
  } else if (action === 'hget') {
    const field = cleanDbText(request.field, 4096)
    if (!field) throw new Error('Field is required')
    args = ['HGET', key, field]
  } else if (action === 'hset') {
    const field = cleanDbText(request.field, 4096)
    if (!field) throw new Error('Field is required')
    args = ['HSET', key, field, cleanDbText(request.value, 8 * 1024 * 1024)]
  } else if (action === 'lpush' || action === 'rpush') {
    args = [action === 'lpush' ? 'LPUSH' : 'RPUSH', key, cleanDbText(request.value, 8 * 1024 * 1024)]
  } else if (action === 'sadd') {
    args = ['SADD', key, cleanDbText(request.value, 8 * 1024 * 1024)]
  } else if (action === 'zadd') {
    const member = cleanDbText(request.member, 8 * 1024 * 1024)
    if (!member) throw new Error('Member is required')
    const score = Number(request.score)
    if (!Number.isFinite(score)) throw new Error('Score must be a number')
    args = ['ZADD', key, String(score), member]
  } else {
    throw new Error('Unsupported command builder action')
  }

  const result = runDbCli(args)
  return { ok: true, command: dbCommandDisplay(args), result }
})

ipcMain.handle('history:get', (_event, profile) => {
  if (!profiles.has(String(profile))) return emptyBest()
  return bestResultsForProfile(String(profile))
})

ipcMain.handle('history:reset', (_event, profile) => {
  const normalized = String(profile)
  if (!profiles.has(normalized)) throw new Error('Unknown benchmark profile')

  const now = new Date().toISOString()
  const resets = loadHistoryResets()
  resets[normalized] = now
  writeFileSync(historyResetPath(), JSON.stringify(resets, null, 2) + '\n')

  const history = loadSavedHistory()
  if (history[normalized]) {
    delete history[normalized]
    saveHistory(history)
  }

  const best = emptyBest()
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('history:update', { profile: normalized, best })
  }
  return best
})


ipcMain.handle('validation:suites', () => validationSuites)

ipcMain.handle('validation:start', async (_event, request = {}) => {
  if (activeValidation) throw new Error('A validation suite is already running')
  if (activeChild) throw new Error('Cannot start validation while a benchmark is running')

  const suiteId = String(request.suiteId || '')
  if (!validationSuiteIds.has(suiteId)) throw new Error('Unknown validation suite')

  const suite = validationSuites.find(item => item.id === suiteId)
  const options = sanitizeValidationOptions(request.options)

  // Release/chaos suites own their local ports. Stop any server managed by the
  // benchmark tab first so Redis 6390 / SnugKV ports cannot collide.
  if (activeServer) await killBenchmarkPorts()

  const command = validationCommand(suiteId, options)
  const id = randomUUID()
  const job = {
    id,
    suiteId,
    suiteLabel: suite.label,
    status: 'running',
    command,
    log: '',
    startedAt: new Date().toISOString(),
    options,
  }

  const env = {
    ...runtimeEnv(),
    SNUGKV_GO_BIN: goPath(),
  }
  if (suiteId === 'distributed-soak' || suiteId === 'full-soak') {
    env.DURATION_SECONDS = String(options.durationSeconds)
    env.CASE_TIMEOUT_SECONDS = String(options.caseTimeoutSeconds)
    env.OUT = join(app.getPath('userData'), `validation-${id}.jsonl`)
    env.LOG_DIR = join(app.getPath('userData'), `validation-${id}-logs`)
  }

  activeValidationCancelled = false
  const child = spawn(bashPath(), ['-lc', command], {
    cwd: snugRepo(),
    env,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  activeValidation = child

  const append = chunk => {
    job.log += chunk.toString()
    if (job.log.length > 800_000) job.log = job.log.slice(-800_000)
    emitValidation(job)
  }
  child.stdout?.on('data', append)
  child.stderr?.on('data', append)

  child.once('error', error => {
    job.status = 'failed'
    job.error = error.message
    job.finishedAt = new Date().toISOString()
    activeValidation = null
    emitValidation(job)
  })

  child.once('close', code => {
    job.finishedAt = new Date().toISOString()
    job.exitCode = Number.isInteger(code) ? code : undefined
    if (job.status === 'running') {
      if (activeValidationCancelled) {
        job.status = 'cancelled'
      } else {
        job.status = code === 0 ? 'done' : 'failed'
        if (code !== 0) job.error = `Validation exited with code ${code}`
      }
    }
    activeValidation = null
    activeValidationCancelled = false
    emitValidation(job)
  })

  emitValidation(job)
  return job
})

ipcMain.handle('validation:cancel', () => {
  if (!activeValidation) return false
  activeValidationCancelled = true
  stopProcessTree(activeValidation)
  return true
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
  if (activeValidation) {
    throw new Error('Cannot start a benchmark while validation is running')
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
    config: c,
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

  let progressBuffer = ''
  const append = chunk => {
    const text = chunk.toString()
    job.log += text
    if (job.log.length > 300_000) job.log = job.log.slice(-300_000)
    emit(job)
  }

  const appendProgress = chunk => {
    const text = chunk.toString()
    progressBuffer += text
    const lines = progressBuffer.split('\n')
    progressBuffer = lines.pop() || ''

    const visible = []
    for (const line of lines) {
      if (!line.startsWith('BENCH_PROGRESS ')) {
        visible.push(line)
        continue
      }
      try {
        const progress = JSON.parse(line.slice('BENCH_PROGRESS '.length))
        if (!job.optimization?.start_used_memory) {
          progress.start_used_memory = progress.used_memory
        } else {
          progress.start_used_memory = job.optimization.start_used_memory
        }
        job.optimization = progress
      } catch {
        visible.push(line)
      }
    }

    if (visible.length) {
      job.log += visible.join('\n') + '\n'
      if (job.log.length > 300_000) job.log = job.log.slice(-300_000)
    }

    emit(job)
  }

  child.stdout.on('data', append)
  child.stderr.on('data', appendProgress)

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
  if (activeValidation) stopProcessTree(activeValidation)
  if (activeServer?.child) activeServer.child.kill('SIGTERM')
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
