const { app, BrowserWindow, ipcMain, dialog } = require('electron')
const { spawn, spawnSync } = require('node:child_process')
const { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } = require('node:fs')
const { randomUUID } = require('node:crypto')
const { join, resolve } = require('node:path')
const os = require('node:os')
const net = require('node:net')
const http = require('node:http')

const profiles = new Set([
  'session-json', 'api-json', 'cache-json', 'counter', 'uuid',
  'text', 'repetitive', 'compressed', 'random',
  'hash-small', 'hash-medium', 'hash-large',
  'list-small', 'list-medium', 'list-large',
  'set-small', 'set-medium', 'set-large',
  'zset-small', 'zset-medium', 'zset-large',
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

const valueShapeToProfile = {
  'hash-10': 'hash-small',
  'hash-100': 'hash-medium',
  'hash-1000': 'hash-large',
  'list-10': 'list-small',
  'list-100': 'list-medium',
  'list-1000': 'list-large',
  'set-10': 'set-small',
  'set-100': 'set-medium',
  'set-1000': 'set-large',
  'zset-10': 'zset-small',
  'zset-100': 'zset-medium',
  'zset-1000': 'zset-large',
}

function canonicalProfile(value) {
  const raw = String(value || '')
  return valueShapeToProfile[raw] || raw
}

const serverDefs = {
  redis: {
    label: 'redis',
    port: 6390,
  },
  snug: {
    label: 'snug',
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
    // Measured passes per benchmark: 1 for matrix runs (Run all / Run selected),
    // user-selected (default 3, up to 50) for the single-benchmark view.
    repetitions: positiveInt(body.repetitions, 3, 50),
    // Matrix runs skip the SnugKV profile replay so the database keeps the
    // full data set that was measured.
    profileReplay: body.profileReplay !== false,
    // Diagnostics (CPU/heap/mutex profiling during the run, the profile replay
    // and the post-run pprof reports) are SnugKV-only and slow the run down.
    diagnostics: body.diagnostics !== false,
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
  if (value === 'snug' || value === 'snug-raw' || value === 'snug-opt' || value === 'snug-mod') return 'snug'
  return null
}

function emptyBest() {
  return {
    redis: null,
    snug: null,
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
function mergeLegacySnugHistory(profileSaved = {}) {
  const records = [profileSaved.snug, profileSaved['snug-opt'], profileSaved['snug-raw']].filter(Boolean)
  if (!records.length) return null

  return records.reduce((merged, record) => {
    if (!merged) return { ...record }
    merged.bestSet = Math.max(merged.bestSet || 0, record.bestSet || 0)
    merged.bestGet = Math.max(merged.bestGet || 0, record.bestGet || 0)
    const values = [merged.lowestBytesPerKey, record.lowestBytesPerKey].filter(v => Number.isFinite(v) && v > 0)
    merged.lowestBytesPerKey = values.length ? Math.min(...values) : Number.POSITIVE_INFINITY
    merged.runs = Math.max(merged.runs || 0, record.runs || 0)
    if (record.lastUpdated && (!merged.lastUpdated || record.lastUpdated > merged.lastUpdated)) {
      merged.lastUpdated = record.lastUpdated
      merged.source = record.source
    }
    return merged
  }, null)
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
      if (canonicalProfile(load.value_shape) !== profile || canonicalProfile(get.value_shape) !== profile) continue
      const key = normalizeServerLabel(load.server)
      if (!key) continue
      best[key] = mergeBest(best[key], load, get, 'cli')
    } catch {
      // Ignore incomplete or manually edited benchmark directories.
    }
  }

  return best
}

function scanElectronRunHistory(profile) {
  const best = emptyBest()
  const root = join(app.getPath('userData'), 'runs')
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
      if (canonicalProfile(load.value_shape) !== profile || canonicalProfile(get.value_shape) !== profile) continue
      const key = normalizeServerLabel(load.server)
      if (!key) continue
      best[key] = mergeBest(best[key], load, get, 'electron')
    } catch {
      // Ignore incomplete run directories.
    }
  }

  return best
}

function mergeBestResultSets(target, source) {
  for (const key of ['redis', 'snug']) {
    const record = source[key]
    if (!record) continue
    const current = target[key]
    if (!current) {
      target[key] = { ...record }
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
  return target
}

function bestResultsForProfile(profile) {
  const result = scanCliHistory(profile)
  mergeBestResultSets(result, scanElectronRunHistory(profile))
  const saved = loadSavedHistory()
  const cutoff = resetCutoff(profile)

  const matchingSaved = Object.entries(saved)
    .filter(([rawProfile]) => canonicalProfile(rawProfile) === profile)
    .map(([, records]) => records || {})

  const migratedSaved = {
    redis: matchingSaved.reduce((best, records) => {
      const record = records.redis
      if (!record) return best
      if (!best) return { ...record }
      best.bestSet = Math.max(best.bestSet || 0, record.bestSet || 0)
      best.bestGet = Math.max(best.bestGet || 0, record.bestGet || 0)
      const values = [best.lowestBytesPerKey, record.lowestBytesPerKey].filter(v => Number.isFinite(v) && v > 0)
      best.lowestBytesPerKey = values.length ? Math.min(...values) : Number.POSITIVE_INFINITY
      best.runs = Math.max(best.runs || 0, record.runs || 0)
      return best
    }, null),
    snug: matchingSaved.reduce((best, records) => {
      const record = mergeLegacySnugHistory(records)
      if (!record) return best
      if (!best) return { ...record }
      best.bestSet = Math.max(best.bestSet || 0, record.bestSet || 0)
      best.bestGet = Math.max(best.bestGet || 0, record.bestGet || 0)
      const values = [best.lowestBytesPerKey, record.lowestBytesPerKey].filter(v => Number.isFinite(v) && v > 0)
      best.lowestBytesPerKey = values.length ? Math.min(...values) : Number.POSITIVE_INFINITY
      best.runs = Math.max(best.runs || 0, record.runs || 0)
      return best
    }, null),
  }

  for (const key of ['redis', 'snug']) {
    const record = migratedSaved[key]
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
  const profile = canonicalProfile(load?.value_shape)
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


function runCliDiagnostic(host, port, args, timeout = 8000) {
  try {
    const result = spawnSync(redisCliPath(), ['--raw', '-h', host, '-p', String(port), ...args.map(String)], {
      env: runtimeEnv(),
      encoding: 'utf8',
      timeout,
      maxBuffer: 16 * 1024 * 1024,
    })
    const stdout = String(result.stdout || '').replace(/\r/g, '').trim()
    const stderr = String(result.stderr || '').trim()
    return {
      ok: result.status === 0 && !stdout.startsWith('ERR '),
      exitCode: Number.isInteger(result.status) ? result.status : null,
      stdout,
      stderr,
    }
  } catch (error) {
    return { ok: false, exitCode: null, stdout: '', stderr: error instanceof Error ? error.message : String(error) }
  }
}

function benchmarkServerPid(config) {
  const managedPid = activeServer?.child?.pid
  if (managedPid && Number(activeServer?.port) === Number(config.port)) {
    return managedPid
  }
  if (process.platform !== 'linux') return null
  try {
    const result = spawnSync(fuserPath(), ['-n', 'tcp', String(config.port)], {
      env: runtimeEnv(),
      encoding: 'utf8',
      timeout: 3000,
    })
    const combined = `${result.stdout || ''}\n${result.stderr || ''}`
    const numbers = [...combined.matchAll(/\b(\d+)\b/g)].map(match => Number(match[1]))
    return numbers.find(value => value > 1 && value !== Number(config.port)) ?? null
  } catch {
    return null
  }
}

function readProcMetrics(pid) {
  if (!pid || process.platform !== 'linux') return null
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8')
    const io = readFileSync(`/proc/${pid}/io`, 'utf8')
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const values = {}
    for (const line of status.split('\n')) {
      const m = line.match(/^([A-Za-z_]+):\s+([0-9]+)/)
      if (m) values[m[1]] = Number(m[2])
    }
    const ioValues = {}
    for (const line of io.split('\n')) {
      const m = line.match(/^([a-z_]+):\s+([0-9]+)/)
      if (m) ioValues[m[1]] = Number(m[2])
    }
    const close = stat.lastIndexOf(')')
    const fields = close >= 0 ? stat.slice(close + 2).trim().split(/\s+/) : []
    return {
      rss_kb: values.VmRSS ?? null,
      peak_rss_kb: values.VmHWM ?? null,
      virtual_kb: values.VmSize ?? null,
      threads: values.Threads ?? null,
      voluntary_context_switches: values.voluntary_ctxt_switches ?? null,
      nonvoluntary_context_switches: values.nonvoluntary_ctxt_switches ?? null,
      cpu_user_ticks: fields.length > 12 ? Number(fields[11]) : null,
      cpu_system_ticks: fields.length > 12 ? Number(fields[12]) : null,
      read_bytes: ioValues.read_bytes ?? null,
      write_bytes: ioValues.write_bytes ?? null,
      read_syscalls: ioValues.syscr ?? null,
      write_syscalls: ioValues.syscw ?? null,
    }
  } catch {
    return null
  }
}

function systemMetrics() {
  return {
    loadavg: os.loadavg(),
    free_memory_bytes: os.freemem(),
    total_memory_bytes: os.totalmem(),
    cpus: os.cpus().length,
  }
}

function diagnosticSnapshot(config) {
  const base = {
    capturedAt: new Date().toISOString(),
    process: readProcMetrics(benchmarkServerPid(config)),
    system: systemMetrics(),
    dbsize: runCliDiagnostic(config.host, config.port, ['DBSIZE']),
    role: runCliDiagnostic(config.host, config.port, ['ROLE']),
    info_server: runCliDiagnostic(config.host, config.port, ['INFO', 'server']),
    info_cpu: runCliDiagnostic(config.host, config.port, ['INFO', 'cpu']),
    info_memory: runCliDiagnostic(config.host, config.port, ['INFO', 'memory']),
    info_stats: runCliDiagnostic(config.host, config.port, ['INFO', 'stats']),
    info_persistence: runCliDiagnostic(config.host, config.port, ['INFO', 'persistence']),
    info_replication: runCliDiagnostic(config.host, config.port, ['INFO', 'replication']),
    info_commandstats: runCliDiagnostic(config.host, config.port, ['INFO', 'commandstats']),
  }
  if (normalizeServerLabel(config.server) === 'snug') {
    base.snug_stats = runCliDiagnostic(config.host, config.port, ['SNUG.STATS'])
  }
  return base
}

function startPprofTop(config, mode, seconds = 5) {
  if (normalizeServerLabel(config?.server) !== 'snug') {
    return Promise.resolve({ ok: false, skipped: true, reason: 'not snug' })
  }

  let args
  if (mode === 'cpu') {
    args = ['tool', 'pprof', '-top', '-nodecount=40', `http://127.0.0.1:6060/debug/pprof/profile?seconds=${seconds}`]
  } else if (mode === 'alloc') {
    args = ['tool', 'pprof', '-top', '-nodecount=40', '-sample_index=alloc_space', 'http://127.0.0.1:6060/debug/pprof/heap']
  } else {
    args = ['tool', 'pprof', '-top', '-nodecount=40', 'http://127.0.0.1:6060/debug/pprof/heap']
  }

  return new Promise(resolveTop => {
    const child = spawn(goPath(), args, {
      cwd: snugRepo(),
      env: runtimeEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout?.on('data', chunk => { output += chunk.toString() })
    child.stderr?.on('data', chunk => { output += chunk.toString() })
    child.once('error', error => resolveTop({ ok: false, output, error: error.message }))
    child.once('close', code => resolveTop({ ok: code === 0, exitCode: code, output: output.trim() }))
  })
}

// ---- Automatic profiling of the measured run -------------------------------
// Captures raw CPU profiles in consecutive windows while the benchmark runs,
// then mutex/block/heap/allocs/goroutine afterwards, and renders flat/cum
// tables so nothing has to be collected by hand in a terminal.
const PPROF_BASE = 'http://127.0.0.1:6060/debug/pprof'

function downloadTo(url, file, timeoutMs) {
  return new Promise(resolveDl => {
    const req = http.get(url, res => {
      if (res.statusCode !== 200) {
        res.resume()
        resolveDl(false)
        return
      }
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        try { writeFileSync(file, Buffer.concat(chunks)); resolveDl(true) } catch { resolveDl(false) }
      })
      res.on('error', () => resolveDl(false))
    })
    req.setTimeout(timeoutMs, () => { req.destroy(); resolveDl(false) })
    req.on('error', () => resolveDl(false))
  })
}

function startRunProfiler(config, out) {
  const state = { files: [], stopped: false, done: null }
  if (normalizeServerLabel(config?.server) !== 'snug' || config?.diagnostics === false) {
    state.done = Promise.resolve()
    return state
  }
  const windowSeconds = 10
  state.done = (async () => {
    for (let i = 1; !state.stopped; i++) {
      const file = join(out, `cpu-${String(i).padStart(2, '0')}.pprof`)
      const ok = await downloadTo(`${PPROF_BASE}/profile?seconds=${windowSeconds}`, file, (windowSeconds + 15) * 1000)
      if (ok) state.files.push(file)
      else await new Promise(r => setTimeout(r, 1000))
    }
  })()
  return state
}

function pprofText(args) {
  return new Promise(resolveTop => {
    const child = spawn(goPath(), ['tool', 'pprof', ...args], {
      cwd: snugRepo(),
      env: runtimeEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout?.on('data', c => { output += c.toString() })
    child.stderr?.on('data', c => { output += c.toString() })
    child.once('error', e => resolveTop({ ok: false, output: e.message }))
    child.once('close', code => resolveTop({ ok: code === 0, output: output.trim() }))
  })
}

async function finishRunProfiler(state, config, out) {
  if (normalizeServerLabel(config?.server) !== 'snug' || config?.diagnostics === false) {
    return { skipped: true, reason: config?.diagnostics === false ? 'diagnostics off' : 'not snug' }
  }
  state.stopped = true
  await state.done
  const result = { runDir: out, cpuFiles: state.files }

  const extra = {}
  for (const [name, path] of [['mutex', 'mutex'], ['block', 'block'], ['allocs', 'allocs'], ['heap', 'heap']]) {
    const file = join(out, `${name}.pprof`)
    if (await downloadTo(`${PPROF_BASE}/${path}`, file, 20000)) extra[name] = file
  }
  const goroutineFile = join(out, 'goroutine.txt')
  await downloadTo(`${PPROF_BASE}/goroutine?debug=1`, goroutineFile, 10000)
  try {
    const text = readFileSync(goroutineFile, 'utf8')
    result.goroutines = text.split('\n', 1)[0]
  } catch {}

  if (state.files.length) {
    result.cpuFlat = await pprofText(['-top', '-nodecount=30', ...state.files])
    result.cpuCum = await pprofText(['-top', '-cum', '-nodecount=30', ...state.files])
    result.cpuScore = await pprofText(['-top', '-nodecount=20', '-focus=Score|ZScore|zsetScore|Get', ...state.files])
  }
  if (extra.mutex) result.mutex = await pprofText(['-top', '-nodecount=15', '-sample_index=delay', extra.mutex])
  if (extra.block) result.block = await pprofText(['-top', '-nodecount=15', '-sample_index=delay', extra.block])
  if (extra.allocs) result.allocObjects = await pprofText(['-top', '-nodecount=20', '-sample_index=alloc_objects', extra.allocs])
  return result
}

async function runMeasuredRepetition(config, parentOut, index) {
  const out = join(parentOut, `repeat-${index}`)
  mkdirSync(out, { recursive: true })
  const args = [
    scriptPath(),
    config.profile,
    '-p', String(config.port),
    '-h', config.host,
    '-s', config.server,
    '-k', String(config.keys),
    '-g', String(config.getOps),
    '-w', String(config.workers),
    '-P', String(config.pipeline),
    '--settle-ms', String(config.settleMs),
    '--seed', String(config.seed),
    '-o', out,
  ]

  const startedAt = new Date().toISOString()
  const result = await new Promise(resolveRun => {
    const child = spawn(bashPath(), args, {
      cwd: snugRepo(),
      env: {
        ...runtimeEnv(),
        SNUGKV_GO_BIN: goPath(),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout?.on('data', chunk => { output += chunk.toString() })
    child.stderr?.on('data', chunk => { output += chunk.toString() })
    child.once('error', error => resolveRun({
      ok: false,
      exitCode: null,
      output,
      error: error.message,
    }))
    child.once('close', code => resolveRun({
      ok: code === 0,
      exitCode: code,
      output: output.trim(),
    }))
  })

  let load = null
  let get = null
  try { load = JSON.parse(readFileSync(join(out, 'load.json'), 'utf8')) } catch {}
  try { get = JSON.parse(readFileSync(join(out, 'get.json'), 'utf8')) } catch {}

  return {
    index,
    startedAt,
    finishedAt: new Date().toISOString(),
    runDir: out,
    command: ['bash', ...args].join(' '),
    result,
    load,
    get,
  }
}

function summarizeRepetitions(repetitions) {
  const valid = repetitions.filter(item => item?.load?.ops_per_second && item?.get?.ops_per_second)
  const summarizeMetric = (path) => {
    const values = valid.map(item => {
      const value = path === 'load'
        ? Number(item.load.ops_per_second)
        : Number(item.get.ops_per_second)
      return { index: item.index, value }
    }).sort((a, b) => a.value - b.value)
    if (!values.length) return null
    const middle = values[Math.floor(values.length / 2)]
    return {
      min: values[0],
      median: middle,
      max: values[values.length - 1],
      spread_pct: values[0].value > 0
        ? ((values[values.length - 1].value - values[0].value) / values[0].value) * 100
        : null,
    }
  }
  return {
    count: valid.length,
    write_ops_per_second: summarizeMetric('load'),
    read_ops_per_second: summarizeMetric('get'),
  }
}

function structuredProfileSpec(profile) {
  const match = /^(hash|list|set|zset)-(small|medium|large)$/.exec(profile)
  if (!match) return null
  const cardinality = match[2] === 'small' ? 10 : match[2] === 'medium' ? 100 : 1000
  return {
    type: match[1],
    cardinality,
    valueBytes: match[1] === 'set' || match[1] === 'zset' ? 24 : 64,
  }
}

async function runReadOnlyProfile(config, items, ops) {
  const spec = structuredProfileSpec(config.profile)
  const addr = `${config.host}:${config.port}`
  const args = spec
    ? [
        '-server', config.server,
        '-addr', addr,
        '-mode', 'read',
        '-type', spec.type,
        '-items', String(items),
        '-cardinality', String(spec.cardinality),
        '-ops', String(ops),
        '-workers', String(config.workers),
        '-pipeline', String(config.pipeline),
        '-value-bytes', String(spec.valueBytes),
        '-seed', String(config.seed),
      ]
    : [
        '-server', config.server,
        '-addr', addr,
        '-workload', 'get',
        '-keys', String(items),
        '-ops', String(ops),
        '-workers', String(config.workers),
        '-pipeline', String(config.pipeline),
        '-value-bytes', String(config.profile === 'counter' ? 10 :
          config.profile === 'uuid' ? 36 :
          config.profile === 'ulid' ? 26 :
          config.profile === 'session-json' ? 384 :
          config.profile === 'api-json' ? 768 :
          config.profile === 'cache-json' ? 1024 : 256),
        '-value-shape', config.profile,
        '-seed', String(config.seed),
      ]
  const command = spec ? '/tmp/redisstructurebench' : '/tmp/rediswirebench'

  const cpuPromise = startPprofTop(config, 'cpu', 5)
  const run = await new Promise(resolveRun => {
    const child = spawn(command, args, {
      cwd: snugRepo(),
      env: runtimeEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout?.on('data', chunk => { output += chunk.toString() })
    child.stderr?.on('data', chunk => { output += chunk.toString() })
    child.once('error', error => resolveRun({
      ok: false,
      exitCode: null,
      output,
      error: error.message,
    }))
    child.once('close', code => resolveRun({
      ok: code === 0,
      exitCode: code,
      output: output.trim(),
    }))
  })
  const cpu = await cpuPromise

  let result = null
  if (run.ok && run.output) {
    try {
      const lines = run.output.trim().split(/\r?\n/)
      result = JSON.parse(lines[lines.length - 1])
    } catch {}
  }

  return {
    command: [command, ...args].join(' '),
    ops,
    run,
    result,
    cpu,
  }
}

async function runSnugProfileReplay(config, parentOut) {
  if (normalizeServerLabel(config.server) !== 'snug') {
    return {
      skipped: true,
      reason: 'not snug',
      cpu: { ok: false, skipped: true, reason: 'not snug' },
      output: '',
    }
  }

  if (config.diagnostics === false || config.profileReplay === false) {
    return {
      skipped: true,
      reason: 'disabled for matrix runs',
      cpu: { ok: false, skipped: true, reason: 'disabled for matrix runs' },
      output: '',
    }
  }

  const replayOut = join(parentOut, 'profile-replay')
  mkdirSync(replayOut, { recursive: true })
  const replayKeys = Math.min(config.keys, 500000)
  const replayGetOps = Math.min(config.getOps, 1000000)
  const replayArgs = [
    scriptPath(),
    config.profile,
    '-p', String(config.port),
    '-h', config.host,
    '-s', config.server,
    '-k', String(replayKeys),
    '-g', String(replayGetOps),
    '-w', String(config.workers),
    '-P', String(config.pipeline),
    '--settle-ms', '0',
    '--seed', String(config.seed),
    '-o', replayOut,
  ]

  const cpuPromise = startPprofTop(config, 'cpu', 5)
  const replay = await new Promise(resolveReplay => {
    const child = spawn(bashPath(), replayArgs, {
      cwd: snugRepo(),
      env: {
        ...runtimeEnv(),
        SNUGKV_GO_BIN: goPath(),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout?.on('data', chunk => { output += chunk.toString() })
    child.stderr?.on('data', chunk => { output += chunk.toString() })
    child.once('error', error => resolveReplay({ ok: false, exitCode: null, output, error: error.message }))
    child.once('close', code => resolveReplay({ ok: code === 0, exitCode: code, output: output.trim() }))
  })
  const cpu = await cpuPromise

  let load = null
  let get = null
  try { load = JSON.parse(readFileSync(join(replayOut, 'load.json'), 'utf8')) } catch {}
  try { get = JSON.parse(readFileSync(join(replayOut, 'get.json'), 'utf8')) } catch {}

  const readProfileOps = Math.min(
    5000000,
    Math.max(2000000, replayGetOps * 2, Number(config.getOps) || 0),
  )
  const readProfile = replay.ok
    ? await runReadOnlyProfile(config, replayKeys, readProfileOps)
    : {
        command: '',
        ops: readProfileOps,
        run: { ok: false, skipped: true, reason: 'profile replay failed' },
        result: null,
        cpu: { ok: false, skipped: true, reason: 'profile replay failed' },
      }

  return {
    skipped: false,
    runDir: replayOut,
    keys: replayKeys,
    getOps: replayGetOps,
    command: ['bash', ...replayArgs].join(' '),
    replay,
    cpu,
    readCpu: readProfile.cpu,
    readProfile,
    load,
    get,
  }
}

function diagnosticsSummary(diagnostics) {
  const lines = [
    '',
    '===== DIAGNOSTICS =====',
    `run_dir: ${diagnostics.artifacts.runDir}`,
    `server: ${diagnostics.server.kind} pid=${diagnostics.server.pid ?? 'n/a'}`,
    `samples: ${diagnostics.processSamples.length}`,
  ]
  const reps = diagnostics.repetitionSummary
  if (reps?.write_ops_per_second) {
    lines.push(
      `write_repetitions: min=${Math.round(reps.write_ops_per_second.min.value)} median=${Math.round(reps.write_ops_per_second.median.value)} max=${Math.round(reps.write_ops_per_second.max.value)} spread=${reps.write_ops_per_second.spread_pct.toFixed(2)}%`
    )
  }
  if (reps?.read_ops_per_second) {
    lines.push(
      `read_repetitions: min=${Math.round(reps.read_ops_per_second.min.value)} median=${Math.round(reps.read_ops_per_second.median.value)} max=${Math.round(reps.read_ops_per_second.max.value)} spread=${reps.read_ops_per_second.spread_pct.toFixed(2)}%`
    )
  }
  const after = diagnostics.snapshots.afterMeasured
  if (after?.process?.rss_kb != null) lines.push(`process_rss_after_measured: ${after.process.rss_kb} kB`)
  if (after?.process?.peak_rss_kb != null) lines.push(`process_peak_rss: ${after.process.peak_rss_kb} kB`)
  if (after?.snug_stats?.stdout) {
    lines.push('', '--- SNUG.STATS (after measured run) ---', after.snug_stats.stdout)
  }
  const rp = diagnostics.profiling.run
  if (rp && !rp.skipped) {
    lines.push('', `--- RUN PROFILES (raw files in ${rp.runDir}: cpu-*.pprof mutex.pprof block.pprof allocs.pprof heap.pprof) ---`)
    if (rp.goroutines) lines.push(rp.goroutines)
    const sections = [
      ['CPU FLAT (during run)', rp.cpuFlat], ['CPU CUM (during run)', rp.cpuCum],
      ['CPU READ-PATH FOCUS', rp.cpuScore], ['MUTEX DELAY', rp.mutex],
      ['BLOCK DELAY', rp.block], ['ALLOC OBJECTS', rp.allocObjects],
    ]
    for (const [title, part] of sections) {
      if (part?.output) lines.push('', `--- ${title} ---`, part.output)
    }
  }
  if (diagnostics.profiling.cpu?.output) {
    lines.push('', '--- LOAD CPU PPROF TOP ---', diagnostics.profiling.cpu.output)
  }
  if (diagnostics.profiling.replay?.readCpu?.output) {
    lines.push('', '--- READ CPU PPROF TOP ---', diagnostics.profiling.replay.readCpu.output)
  }
  if (diagnostics.profiling.heap?.output) {
    lines.push('', '--- HEAP PPROF TOP ---', diagnostics.profiling.heap.output)
  }
  if (diagnostics.profiling.alloc?.output) {
    lines.push('', '--- ALLOC PPROF TOP ---', diagnostics.profiling.alloc.output)
  }
  lines.push('===== END DIAGNOSTICS =====', '')
  return lines.join('\n')
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
      await runCommand(fuserPath(), ['-k', '6390/tcp', '6383/tcp', '6060/tcp'], { env: runtimeEnv() })
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
      '-pprof-listen', '127.0.0.1:6060',
    ]
    args.push('-optimizer-mode', optimizerMode)
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
    optimizerMode: kind === 'snug' ? optimizerMode : undefined,
    logs,
  }

  child.once('exit', () => {
    if (activeServer?.child === child) activeServer = null
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('server:update', {
        running: false,
        kind,
        port: def.port,
        label: def.label,
        optimizerMode: kind === 'snug' ? optimizerMode : undefined,
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
    optimizerMode: kind === 'snug' ? optimizerMode : undefined,
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
  const count = positiveInt(request.count, 200, 500)

  // Do one bounded SCAN page instead of redis-cli --scan. The latter walks the
  // entire keyspace before returning and can easily time out on large databases.
  const output = runDbCli(['SCAN', '0', 'MATCH', pattern, 'COUNT', String(count)], { timeout: 5000 })
  const lines = dbLines(output).filter(line => line !== '')
  const cursor = lines.shift() || '0'
  const names = lines.slice(0, count)

  // Do not spawn one redis-cli process per key just to obtain TYPE. Exact type
  // is fetched by db:get-key when a key is opened.
  const keys = names.map(key => ({ key, type: 'unknown' }))

  return {
    keys,
    cursor,
    command: dbCommandDisplay(['SCAN', '0', 'MATCH', pattern, 'COUNT', String(count)]),
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

function dbQuoteArg(value) {
  const text = String(value)
  let out = '"'
  for (const ch of Buffer.from(text, 'utf8')) {
    if (ch === 0x22) out += '\\"'
    else if (ch === 0x5c) out += '\\\\'
    else if (ch >= 0x20 && ch < 0x7f) out += String.fromCharCode(ch)
    else out += '\\x' + ch.toString(16).padStart(2, '0')
  }
  return out + '"'
}

// Run many commands through ONE redis-cli process (stdin mode). Returns raw reply lines.
function runDbPipe(commands, options = {}) {
  const db = requireActiveDbServer()
  const input = commands.map(args => args.map(dbQuoteArg).join(' ')).join('\n') + '\n'
  const result = spawnSync(redisCliPath(), ['--raw', '-h', db.host, '-p', String(db.port)], {
    env: runtimeEnv(),
    encoding: 'utf8',
    input,
    timeout: options.timeout ?? 60000,
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(String(result.stderr || result.stdout || `redis-cli exited with code ${result.status}`).trim())
  return String(result.stdout || '').replace(/\r/g, '').split('\n')
}

function dbInfoMap(text) {
  const map = {}
  for (const line of dbLines(text)) {
    const i = line.indexOf(':')
    if (i > 0 && !line.startsWith('#')) map[line.slice(0, i)] = line.slice(i + 1)
  }
  return map
}

const DB_PIPELINE_COMMANDS = new Set(['SET', 'INCR', 'INCRBY', 'HSET', 'RPUSH', 'LPUSH', 'SADD', 'ZADD', 'JSON.SET', 'DEL', 'EXPIRE'])

ipcMain.handle('db:overview', () => {
  const db = requireActiveDbServer()
  const out = { host: db.host, port: db.port, keys: 0, usedMemory: null, peakMemory: null, maxMemory: null, commands: null, uptimeSeconds: null, clients: null, version: null, at: Date.now() }
  out.keys = Number(runDbCli(['DBSIZE'], { timeout: 4000 })) || 0
  try {
    const info = dbInfoMap(runDbCli(['INFO'], { timeout: 4000 }))
    const num = key => (info[key] !== undefined && Number.isFinite(Number(info[key])) ? Number(info[key]) : null)
    out.usedMemory = num('used_memory')
    out.peakMemory = num('used_memory_peak')
    out.maxMemory = num('maxmemory')
    out.commands = num('total_commands_processed')
    out.uptimeSeconds = num('uptime_in_seconds')
    out.clients = num('connected_clients')
    out.version = info.redis_version || info.snugkv_version || null
  } catch {
    // INFO is optional; DBSIZE alone is still useful.
  }
  return out
})

ipcMain.handle('db:scan', (_event, request = {}) => {
  requireActiveDbServer()
  const pattern = cleanDbText(request.pattern || '*', 256) || '*'
  const count = positiveInt(request.count, 100, 500)
  const cursorIn = /^\d+$/.test(String(request.cursor ?? '0')) ? String(request.cursor ?? '0') : '0'
  const lines = dbLines(runDbCli(['SCAN', cursorIn, 'MATCH', pattern, 'COUNT', String(count)], { timeout: 8000 })).filter(l => l !== '')
  const cursor = lines.shift() || '0'
  const names = lines.slice(0, count)
  const keys = []
  if (names.length) {
    const reply = runDbPipe(names.flatMap(key => [['TYPE', key], ['TTL', key], ['MEMORY', 'USAGE', key]]), { timeout: 15000 })
    names.forEach((key, i) => {
      const memory = Number(reply[i * 3 + 2])
      const ttl = Number(reply[i * 3 + 1])
      keys.push({
        key,
        type: reply[i * 3] || 'unknown',
        ttl: Number.isFinite(ttl) ? ttl : -1,
        memoryBytes: Number.isFinite(memory) && reply[i * 3 + 2] !== '' ? memory : undefined,
      })
    })
  }
  return { keys, cursor, command: dbCommandDisplay(['SCAN', cursorIn, 'MATCH', pattern, 'COUNT', String(count)]) }
})

ipcMain.handle('db:pipeline', (_event, request = {}) => {
  requireActiveDbServer()
  const commands = Array.isArray(request.commands) ? request.commands : []
  if (!commands.length) throw new Error('No commands to run')
  if (commands.length > 5000) throw new Error('Too many commands in one batch (max 5000)')
  const clean = commands.map(args => {
    if (!Array.isArray(args) || !args.length) throw new Error('Invalid command')
    const list = args.map(arg => cleanDbText(arg, 8 * 1024 * 1024))
    if (!DB_PIPELINE_COMMANDS.has(list[0].toUpperCase())) throw new Error(`Command not allowed: ${list[0]}`)
    return list
  })
  const started = Date.now()
  const reply = runDbPipe(clean)
  const errors = reply.filter(line => /^(ERR|WRONGTYPE|NOPERM|OOM|MISCONF|EXECABORT)\b/.test(line))
  return { ok: errors.length === 0, sent: clean.length, errors: errors.length, firstError: errors[0] || null, elapsedMs: Date.now() - started }
})

ipcMain.handle('db:flush', () => {
  runDbCli(['FLUSHDB'])
  return { ok: true, command: dbCommandDisplay(['FLUSHDB']) }
})

ipcMain.handle('history:get', (_event, profile) => {
  const normalized = canonicalProfile(profile)
  if (!profiles.has(normalized)) return emptyBest()
  return bestResultsForProfile(normalized)
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

  const diagnosticsStartedAt = Date.now()
  const diagnosticsBefore = diagnosticSnapshot(c)
  const processSamples = []
  const sampleProcess = () => {
    const proc = readProcMetrics(benchmarkServerPid(c))
    processSamples.push({
      elapsed_ms: Date.now() - diagnosticsStartedAt,
      process: proc,
      system: systemMetrics(),
    })
    if (processSamples.length > 1200) processSamples.shift()
  }
  sampleProcess()
  const sampleTimer = setInterval(sampleProcess, 250)

  const child = spawn(bashPath(), args, {
    cwd: snugRepo(),
    env: {
      ...runtimeEnv(),
      SNUGKV_GO_BIN: goPath(),
    },
  })
  activeChild = child
  const runProfiler = startRunProfiler(c, out)

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
    runProfiler.stopped = true
    job.status = 'failed'
    job.error = error.message
    job.finishedAt = new Date().toISOString()
    activeChild = null
    emit(job)
  })

  child.on('close', async code => {
    clearInterval(sampleTimer)
    sampleProcess()
    job.finishedAt = new Date().toISOString()
    activeChild = null

    if (code !== 0) {
      runProfiler.stopped = true
      job.status = 'failed'
      job.error = `Benchmark exited with code ${code}`
      emit(job)
      return
    }

    let benchmarkSucceeded = false
    try {
      const load = JSON.parse(readFileSync(join(out, 'load.json'), 'utf8'))
      const get = JSON.parse(readFileSync(join(out, 'get.json'), 'utf8'))
      job.results = { load, get }
      benchmarkSucceeded = true
      recordCompletedResult(load, get)
    } catch (error) {
      job.status = 'failed'
      job.error = error instanceof Error ? error.message : String(error)
    }

    const measuredRepetitions = [{
      index: 1,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      runDir: out,
      command: job.command,
      result: { ok: benchmarkSucceeded, exitCode: code },
      load: job.results?.load ?? null,
      get: job.results?.get ?? null,
    }]

    if (benchmarkSucceeded) {
      for (let repeatIndex = 2; repeatIndex <= c.repetitions; repeatIndex++) {
        job.log += `\n===== MEASURED REPETITION ${repeatIndex}/${c.repetitions} =====\n`
        emit(job)
        const repeated = await runMeasuredRepetition(c, out, repeatIndex)
        measuredRepetitions.push(repeated)
        if (repeated.result?.output) {
          job.log += repeated.result.output + '\n'
          if (job.log.length > 800_000) job.log = job.log.slice(-800_000)
        }
        if (!repeated.result?.ok) {
          job.log += `repetition ${repeatIndex} failed: ${repeated.result?.error || repeated.result?.exitCode || 'unknown error'}\n`
          break
        }
      }
    }

    const runProfile = await finishRunProfiler(runProfiler, c, out)
    const repetitionSummary = summarizeRepetitions(measuredRepetitions)
    const diagnosticsAfterMeasured = diagnosticSnapshot(c)
    const profilingReplay = await runSnugProfileReplay(c, out)
    const diagnosticsAfterProfilingReplay = normalizeServerLabel(c.server) === 'snug'
      ? diagnosticSnapshot(c)
      : null
    const heap = normalizeServerLabel(c.server) === 'snug' && c.diagnostics !== false
      ? await startPprofTop(c, 'heap')
      : { ok: false, skipped: true, reason: 'not snug' }
    const alloc = normalizeServerLabel(c.server) === 'snug' && c.diagnostics !== false
      ? await startPprofTop(c, 'alloc')
      : { ok: false, skipped: true, reason: 'not snug' }

    const diagnostics = {
      schemaVersion: 1,
      runId: id,
      profile: c.profile,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      durationMs: Date.now() - diagnosticsStartedAt,
      command: job.command,
      config: c,
      server: {
        kind: normalizeServerLabel(c.server),
        label: c.server,
        pid: benchmarkServerPid(c),
        optimizerMode: activeServer?.optimizerMode ?? null,
        logTail: Array.isArray(activeServer?.logs) ? activeServer.logs.join('').slice(-100000) : '',
      },
      environment: {
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        electron: process.versions.electron,
        cpus: os.cpus().map(cpu => cpu.model),
        totalMemoryBytes: os.totalmem(),
      },
      artifacts: {
        runDir: out,
        loadJson: join(out, 'load.json'),
        getJson: join(out, 'get.json'),
        diagnosticsJson: join(out, 'diagnostics.json'),
      },
      snapshots: {
        before: diagnosticsBefore,
        afterMeasured: diagnosticsAfterMeasured,
        afterProfilingReplay: diagnosticsAfterProfilingReplay,
      },
      processSamples,
      measuredRepetitions,
      repetitionSummary,
      profiling: {
        cpu: profilingReplay.cpu,
        heap,
        alloc,
        replay: profilingReplay,
        run: runProfile,
      },
      benchmark: job.results ?? null,
    }
    job.diagnostics = diagnostics
    writeFileSync(join(out, 'diagnostics.json'), JSON.stringify(diagnostics, null, 2) + '\n')
    job.log += diagnosticsSummary(diagnostics)
    if (job.log.length > 800_000) job.log = job.log.slice(-800_000)

    if (benchmarkSucceeded) {
      job.status = 'done'
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

ipcMain.handle('bench:save-text', async (_event, payload) => {
  const type = payload?.type === 'csv' ? 'csv' : 'txt'
  const suggested = payload?.filename || `snugkv-benchmark.${type}`
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Save benchmark export',
    defaultPath: suggested,
    filters: type === 'csv'
      ? [{ name: 'CSV', extensions: ['csv'] }]
      : [{ name: 'Text', extensions: ['txt'] }],
  })
  if (result.canceled || !result.filePath) return { saved: false }
  writeFileSync(result.filePath, String(payload?.data ?? ''))
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
