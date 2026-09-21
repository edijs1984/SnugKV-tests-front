import express from 'express'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'

type Config = {
  profile: string
  host: string
  port: number
  server: string
  keys: number
  getOps: number
  workers: number
  pipeline: number
  settleMs: number
  seed: number
}

type Job = {
  id: string
  status: 'running' | 'done' | 'failed'
  command: string
  log: string
  error?: string
  startedAt: string
  finishedAt?: string
  results?: unknown
}

const profiles = new Set([
  'session-json', 'api-json', 'cache-json', 'counter', 'uuid',
  'text', 'repetitive', 'compressed', 'random',
])

const app = express()
app.use(express.json({ limit: '64kb' }))

const jobs = new Map<string, Job>()
const repo = resolve(process.env.SNUGKV_REPO ?? '../SnugKV')
const script = join(repo, 'scripts/bench/bench-one.sh')
const runs = resolve(process.env.BENCH_RUNS_DIR ?? './runs')
mkdirSync(runs, { recursive: true })

function positiveInt(value: unknown, fallback: number, max: number) {
  const n = Number(value)
  return Number.isInteger(n) && n > 0 && n <= max ? n : fallback
}

function sanitize(body: Partial<Config>): Config {
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

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    snugkvRepo: repo,
    benchmarkScriptFound: existsSync(script),
  })
})

app.post('/api/jobs', (req, res) => {
  if (!existsSync(script)) {
    return res.status(500).json({
      error: `Benchmark script not found at ${script}. Set SNUGKV_REPO=/path/to/SnugKV.`,
    })
  }

  const c = sanitize(req.body)
  const id = randomUUID()
  const out = join(runs, id)
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

  const command = ['bash', ...args].join(' ')
  const job: Job = {
    id,
    status: 'running',
    command,
    log: '',
    startedAt: new Date().toISOString(),
  }
  jobs.set(id, job)

  const child = spawn('bash', args, { cwd: repo, env: process.env })

  const append = (chunk: Buffer) => {
    job.log += chunk.toString()
    if (job.log.length > 250_000) job.log = job.log.slice(-250_000)
  }
  child.stdout.on('data', append)
  child.stderr.on('data', append)

  child.on('error', error => {
    job.status = 'failed'
    job.error = error.message
    job.finishedAt = new Date().toISOString()
  })

  child.on('close', code => {
    job.finishedAt = new Date().toISOString()
    if (code !== 0) {
      job.status = 'failed'
      job.error = `Benchmark exited with code ${code}`
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
  })

  res.status(202).json(job)
})

app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id)
  if (!job) return res.status(404).json({ error: 'Unknown job' })
  res.json(job)
})

const port = Number(process.env.PORT || 8787)
app.listen(port, '127.0.0.1', () => {
  console.log(`SnugKV benchmark API: http://127.0.0.1:${port}`)
  console.log(`SnugKV repo: ${repo}`)
})
