'use strict'

// Pub/Sub lab: builds the SnugKV repo's server and `pubsubbench`, then runs the
// same fan-out scenario against each selected server (SnugKV, Redis) on private
// loopback ports so the results can be compared. No Electron dependency, so it
// can be tested from a plain Node script.

const { spawn } = require('node:child_process')
const net = require('node:net')
const { join } = require('node:path')
const { mkdirSync } = require('node:fs')

const PORTS = { snug: 16384, redis: 16380 }
const LABELS = { snug: 'SnugKV', redis: 'Redis' }

function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function sanitizePubSubConfig(body = {}) {
  const servers = ['snug', 'redis'].filter(kind => Array.isArray(body.servers) && body.servers.includes(kind))
  return {
    servers: servers.length ? servers : ['snug', 'redis'],
    subscribers: clampInt(body.subscribers, 1, 5000, 200),
    stuck: clampInt(body.stuck, 0, 200, 0),
    channels: clampInt(body.channels, 1, 1000, 10),
    publishers: clampInt(body.publishers, 1, 64, 4),
    payloadBytes: clampInt(body.payloadBytes, 24, 1 << 20, 256),
    rate: clampInt(body.rate, 0, 200000, 500),
    durationSeconds: clampInt(body.durationSeconds, 3, 300, 15),
    pattern: Boolean(body.pattern),
    // SnugKV delivery policy.
    sendAttempts: clampInt(body.sendAttempts, 1, 100, 5),
    sendTimeoutMs: clampInt(body.sendTimeoutMs, 1, 60000, 1000),
    queueSize: clampInt(body.queueSize, 1, 1 << 20, 1024),
  }
}

function benchArgs(config, port) {
  const args = [
    '-addr', `127.0.0.1:${port}`,
    '-subs', String(config.subscribers),
    '-stuck', String(config.stuck),
    '-channels', String(config.channels),
    '-publishers', String(config.publishers),
    '-size', String(config.payloadBytes),
    '-rate', String(config.rate),
    '-duration', `${config.durationSeconds}s`,
  ]
  if (config.pattern) args.push('-pattern')
  return args
}

function waitForPort(port, child, logs, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs
    let exited = false
    child.once('exit', () => { exited = true })
    const attempt = () => {
      if (exited) return reject(new Error(`process exited before listening on ${port}\n${logs.join('').trim()}`))
      const socket = net.createConnection({ host: '127.0.0.1', port })
      socket.setTimeout(500)
      const fail = () => {
        socket.destroy()
        if (Date.now() >= deadline) reject(new Error(`timed out waiting for port ${port}\n${logs.join('').trim()}`))
        else setTimeout(attempt, 100)
      }
      socket.once('connect', () => { socket.end(); resolve() })
      socket.once('error', fail)
      socket.once('timeout', fail)
    }
    attempt()
  })
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * ctx: { repo, go, env, binDir, redisServer, emit(job), isCancelled(), registerStop(fn) }
 */
async function runPubSubLab(rawConfig, ctx) {
  const config = sanitizePubSubConfig(rawConfig)
  const children = new Set()
  const job = { config, results: [], log: '', stage: 'Preparing', commands: [] }
  const push = (text = '') => {
    job.log += text
    if (job.log.length > 400_000) job.log = job.log.slice(-400_000)
    ctx.emit({ ...job })
  }
  const stage = text => {
    job.stage = text
    push(`\n== ${text}\n`)
  }

  const start = (name, command, args, opts = {}) => {
    const logs = []
    const child = spawn(command, args, { cwd: ctx.repo, env: ctx.env, stdio: ['ignore', 'pipe', 'pipe'] })
    children.add(child)
    child.stderr.on('data', chunk => { logs.push(chunk.toString()); if (logs.length > 60) logs.shift() })
    child.stdout.on('data', chunk => {
      if (opts.captureStdout) opts.captureStdout(chunk)
      else { logs.push(chunk.toString()); if (logs.length > 60) logs.shift() }
    })
    child.once('exit', () => children.delete(child))
    child.once('error', error => logs.push(String(error)))
    job.commands.push(`${name}: ${[command, ...args].join(' ')}`)
    return { child, logs }
  }

  const stopAll = async () => {
    for (const child of [...children]) {
      try { child.kill('SIGTERM') } catch { /* already gone */ }
    }
    const deadline = Date.now() + 3000
    while (children.size && Date.now() < deadline) await sleep(50)
    for (const child of [...children]) {
      try { child.kill('SIGKILL') } catch { /* already gone */ }
    }
    await sleep(150)
  }
  if (ctx.registerStop) ctx.registerStop(stopAll)

  const build = (name, pkg) => new Promise((resolve, reject) => {
    mkdirSync(ctx.binDir, { recursive: true })
    const out = join(ctx.binDir, process.platform === 'win32' ? `${name}.exe` : name)
    const child = spawn(ctx.go, ['build', '-o', out, pkg], { cwd: ctx.repo, env: ctx.env, stdio: ['ignore', 'pipe', 'pipe'] })
    children.add(child)
    let output = ''
    child.stdout.on('data', c => { output += c })
    child.stderr.on('data', c => { output += c })
    child.once('error', reject)
    child.once('close', code => {
      children.delete(child)
      if (code === 0) resolve(out)
      else reject(new Error(`go build ${pkg} failed: ${output.trim()}`))
    })
  })

  try {
    stage('Building SnugKV and pubsubbench')
    const snug = config.servers.includes('snug') ? await build('snugkv', './cmd/snugkv') : null
    const bench = await build('pubsubbench', './cmd/pubsubbench')

    for (const kind of config.servers) {
      if (ctx.isCancelled()) break
      const label = LABELS[kind]
      const port = PORTS[kind]
      stage(`${label}: starting server`)
      const server = kind === 'redis'
        ? start(`${label} server`, ctx.redisServer, ['--bind', '127.0.0.1', '--port', String(port), '--save', '', '--appendonly', 'no', '--protected-mode', 'no'])
        : start(`${label} server`, snug, [
          '-listen', `127.0.0.1:${port}`, '-admin-listen', '',
          '-pubsub-send-attempts', String(config.sendAttempts),
          '-pubsub-send-timeout-ms', String(config.sendTimeoutMs),
          '-pubsub-queue-size', String(config.queueSize),
        ])
      await waitForPort(port, server.child, server.logs)
      if (ctx.isCancelled()) { await stopAll(); break }

      stage(`${label}: ${config.subscribers} subscribers${config.stuck ? ` + ${config.stuck} that never read` : ''}, ${config.durationSeconds}s`)
      let stdout = ''
      const run = start('pubsubbench', bench, benchArgs(config, port), { captureStdout: chunk => { stdout += chunk.toString() } })
      const code = await new Promise(resolve => run.child.once('close', resolve))
      await stopAll()
      if (ctx.isCancelled()) break
      if (code !== 0) throw new Error(`pubsubbench exited with code ${code}\n${run.logs.join('').trim()}`)

      let result
      try {
        result = JSON.parse(stdout)
      } catch {
        throw new Error(`could not read pubsubbench output:\n${stdout.slice(0, 2000)}`)
      }
      job.results = [...job.results, { server: kind, label, result }]
      push(`${label}: ${(result.delivered_share * 100).toFixed(1)}% delivered, ${Math.round(result.deliveries_per_sec)} deliveries/s, publish p99 ${result.publish_p99_ms.toFixed(2)} ms\n`)
    }
    job.status = ctx.isCancelled() ? 'cancelled' : 'done'
  } catch (error) {
    job.status = ctx.isCancelled() ? 'cancelled' : 'failed'
    if (job.status === 'failed') job.error = error instanceof Error ? error.message : String(error)
  } finally {
    await stopAll()
  }
  job.stage = job.status === 'done' ? 'Done' : job.status === 'cancelled' ? 'Cancelled' : 'Failed'
  return job
}

module.exports = { runPubSubLab, sanitizePubSubConfig, PORTS }
