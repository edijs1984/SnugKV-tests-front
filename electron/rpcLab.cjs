'use strict'

// RPC cache lab: runs the SnugKV repo's rpccache proxy and `rpcbench wallets`
// simulation once per selected cache backend (SnugKV, Redis) so the results can
// be compared. Everything runs on private loopback ports, separate from the
// servers the Benchmark tab manages. This module has no Electron dependency so
// it can be tested from a plain Node script.

const { spawn } = require('node:child_process')
const net = require('node:net')
const http = require('node:http')
const { join } = require('node:path')
const { mkdirSync } = require('node:fs')

const PORTS = { node: 19100, proxy: 18899, snug: 16383, redis: 16379 }
const CACHE_LABELS = { snug: 'SnugKV', redis: 'Redis' }

function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function clampFloat(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function sanitizeRpcConfig(body = {}) {
  const caches = ['snug', 'redis'].filter(kind => Array.isArray(body.caches) && body.caches.includes(kind))
  return {
    chain: body.chain === 'evm' ? 'evm' : 'solana',
    caches: caches.length ? caches : ['snug', 'redis'],
    users: clampInt(body.users, 1, 5000, 200),
    durationSeconds: clampInt(body.durationSeconds, 5, 600, 30),
    refreshMs: clampInt(body.refreshMs, 200, 60000, 3000),
    watched: clampInt(body.watched, 1, 100, 15),
    popular: clampInt(body.popular, 10, 200000, 200),
    popularReads: clampInt(body.popularReads, 0, 50, 5),
    overlap: clampFloat(body.overlap, 0, 1, 0.5),
    skew: clampFloat(body.skew, 1.01, 3, 1.2),
    cacheTtlSeconds: clampInt(body.cacheTtlSeconds, 0, 86400, 0),
    blockTimeMs: clampInt(body.blockTimeMs, 0, 60000, 0),
    settleSeconds: clampInt(body.settleSeconds, 0, 120, 8),
    checkRate: clampFloat(body.checkRate, 0, 1, 0.2),
    seed: clampInt(body.seed, 0, 1_000_000, 1),
  }
}

function walletArgs(config, cacheAddr) {
  return [
    'wallets',
    '-chain', config.chain,
    '-url', `http://127.0.0.1:${PORTS.proxy}`,
    '-direct', `http://127.0.0.1:${PORTS.node}`,
    '-upstream-stats', `http://127.0.0.1:${PORTS.node}`,
    '-cache', cacheAddr,
    '-wait', `${config.settleSeconds}s`,
    '-users', String(config.users),
    '-duration', `${config.durationSeconds}s`,
    '-refresh', `${config.refreshMs}ms`,
    '-watched', String(config.watched),
    '-popular', String(config.popular),
    '-popular-reads', String(config.popularReads),
    '-overlap', String(config.overlap),
    '-skew', String(config.skew),
    '-check-rate', String(config.checkRate),
    '-seed', String(config.seed),
  ]
}

function nodeArgs(config) {
  const args = ['upstream', '-chain', config.chain, '-listen', `127.0.0.1:${PORTS.node}`, '-advance']
  if (config.blockTimeMs > 0) args.push('-slot-time', `${config.blockTimeMs}ms`)
  return args
}

function proxyArgs(config, cacheAddr) {
  const args = [
    '-chain', config.chain,
    '-listen', `127.0.0.1:${PORTS.proxy}`,
    '-upstream', `http://127.0.0.1:${PORTS.node}`,
    '-cache', cacheAddr,
  ]
  if (config.cacheTtlSeconds > 0) {
    const ttl = `${config.cacheTtlSeconds}s`
    args.push('-ttl-state', ttl, '-ttl-recent', ttl, '-ttl-tip', ttl)
  }
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

// Reads the proxy's /metrics into { name: number } for the plain counters.
function fetchMetrics(port) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: '/metrics', timeout: 2000 }, res => {
      let body = ''
      res.on('data', chunk => { body += chunk })
      res.on('end', () => {
        const out = {}
        for (const line of body.split('\n')) {
          const match = /^(rpccache_[a-z_]+) (\d+)$/.exec(line.trim())
          if (match) out[match[1].replace(/^rpccache_/, '').replace(/_total$/, '')] = Number(match[2])
        }
        resolve(out)
      })
    })
    req.on('timeout', () => { req.destroy(); resolve({}) })
    req.on('error', () => resolve({}))
  })
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Runs the comparison.
 * ctx: { repo, go, env, binDir, redisServer, emit(job), isCancelled(), registerStop(fn) }
 * Resolves with the final job fields; throws only for setup problems the
 * caller should report as a failure.
 */
async function runRpcLab(rawConfig, ctx) {
  const config = sanitizeRpcConfig(rawConfig)
  const children = new Set()
  const job = {
    config,
    results: [],
    log: '',
    stage: 'Preparing',
    commands: [],
  }
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
    const child = spawn(command, args, {
      cwd: opts.cwd || ctx.repo,
      env: ctx.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    children.add(child)
    child.stderr.on('data', chunk => {
      logs.push(chunk.toString())
      if (logs.length > 60) logs.shift()
    })
    child.stdout.on('data', chunk => {
      if (opts.captureStdout) opts.captureStdout(chunk)
      else {
        logs.push(chunk.toString())
        if (logs.length > 60) logs.shift()
      }
    })
    child.once('exit', () => children.delete(child))
    child.once('error', error => logs.push(String(error)))
    job.commands.push(`${name}: ${[command, ...args].join(' ')}`)
    return { child, logs }
  }

  const stopAll = async () => {
    const running = [...children]
    for (const child of running) {
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
    stage('Building SnugKV, rpccache and rpcbench')
    const snug = await build('snugkv', './cmd/snugkv')
    const proxyBin = await build('rpccache', './cmd/rpccache')
    const bench = await build('rpcbench', './cmd/rpcbench')

    for (const kind of config.caches) {
      if (ctx.isCancelled()) break
      const label = CACHE_LABELS[kind]
      const cacheAddr = `127.0.0.1:${PORTS[kind]}`

      stage(`${label}: starting cache, node and proxy`)
      const cache = kind === 'redis'
        ? start(`${label} cache`, ctx.redisServer, [
          '--bind', '127.0.0.1', '--port', String(PORTS.redis),
          '--save', '', '--appendonly', 'no', '--protected-mode', 'no',
        ])
        : start(`${label} cache`, snug, [
          '-listen', cacheAddr, '-admin-listen', '', '-encoding', '-compression', '-json-shape',
        ])
      await waitForPort(PORTS[kind], cache.child, cache.logs)

      const node = start('fake node', bench, nodeArgs(config))
      await waitForPort(PORTS.node, node.child, node.logs)
      const proxy = start('rpccache', proxyBin, proxyArgs(config, cacheAddr))
      await waitForPort(PORTS.proxy, proxy.child, proxy.logs)
      if (ctx.isCancelled()) { await stopAll(); break }

      stage(`${label}: ${config.users} users for ${config.durationSeconds}s (+${config.settleSeconds}s settle)`)
      let stdout = ''
      const run = start('rpcbench wallets', bench, walletArgs(config, cacheAddr), {
        captureStdout: chunk => { stdout += chunk.toString() },
      })
      const code = await new Promise(resolve => run.child.once('close', resolve))
      // The proxy's own counters say whether the cache answered in time; a cache
      // that times out is skipped and its misses go to the node.
      const proxyMetrics = await fetchMetrics(PORTS.proxy)
      await stopAll()
      if (ctx.isCancelled()) break
      if (code !== 0) throw new Error(`rpcbench wallets exited with code ${code}\n${run.logs.join('').trim()}`)

      let result
      try {
        result = JSON.parse(stdout)
      } catch {
        throw new Error(`could not read rpcbench output:\n${stdout.slice(0, 2000)}`)
      }
      job.results = [...job.results, { cache: kind, label, result, proxy: proxyMetrics }]
      push(`${label}: ${result.rpc_calls} calls, ${(result.answered_without_node * 100).toFixed(1)}% answered without the node\n`)
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

module.exports = { runRpcLab, sanitizeRpcConfig, PORTS }
