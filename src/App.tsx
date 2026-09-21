import { useEffect, useMemo, useState } from 'react'
import type { BenchmarkConfig, Job } from './types'

const profiles = [
  ['cache-json', 'Cached request/response JSON · 1024 B'],
  ['session-json', 'Session JSON · 384 B'],
  ['api-json', 'API JSON · 768 B'],
  ['counter', 'Counter · 10 B'],
  ['uuid', 'UUID · 36 B'],
  ['text', 'Application text · 256 B'],
  ['repetitive', 'Compressible control · 256 B'],
  ['compressed', 'Already-compressed control · 256 B'],
  ['random', 'Incompressible control · 256 B'],
]

const initial: BenchmarkConfig = {
  profile: 'uuid',
  host: '127.0.0.1',
  port: 6390,
  server: 'redis',
  keys: 1_000_000,
  getOps: 2_000_000,
  workers: 8,
  pipeline: 256,
  settleMs: 10_000,
  seed: 1,
}

const nf = new Intl.NumberFormat('en-US')
const speed = (n: number) => `${nf.format(Math.round(n))}/s`
const us = (ns: number) => `${(ns / 1000).toFixed(2)} μs`
const bytes = (n: number) => nf.format(Math.round(n))

function App() {
  const [config, setConfig] = useState(initial)
  const [job, setJob] = useState<Job | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)

  const command = useMemo(() => {
    return [
      `bash scripts/bench/bench-one.sh ${config.profile}`,
      `-p ${config.port}`,
      `-h ${config.host}`,
      `-s ${config.server}`,
      `-k ${config.keys}`,
      `-g ${config.getOps}`,
      `-w ${config.workers}`,
      `-P ${config.pipeline}`,
      `--settle-ms ${config.settleMs}`,
      `--seed ${config.seed}`,
    ].join(' ')
  }, [config])

  useEffect(() => {
    return window.snugBench.onUpdate((next: Job) => {
      setJob(next)
      if (next.status !== 'running') setBusy(false)
    })
  }, [])

  async function run() {
    setBusy(true)
    setCopied(false)
    setJob(null)
    try {
      const data = await window.snugBench.start(config)
      setJob(data)
    } catch (error) {
      setBusy(false)
      alert(error instanceof Error ? error.message : String(error))
    }
  }

  async function copyResults() {
    if (!job?.results) return
    await navigator.clipboard.writeText(JSON.stringify({
      config,
      results: job.results,
    }, null, 2))
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  async function downloadResults() {
    if (!job?.results) return
    await window.snugBench.save({
      filename: `snugkv-${config.profile}-${config.server}-${Date.now()}.json`,
      data: { config, results: job.results },
    })
  }

  function field<K extends keyof BenchmarkConfig>(key: K, value: BenchmarkConfig[K]) {
    setConfig(prev => ({ ...prev, [key]: value }))
  }

  const r = job?.results

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <div className="eyebrow">SNUGKV / BENCHMARK LAB</div>
          <h1>Redis-compatible benchmark runner</h1>
          <p>Run one published SnugKV profile against any server you start yourself.</p>
        </div>
        <div className={`status ${job?.status ?? 'idle'}`}>
          <span />
          {job?.status ?? 'idle'}
        </div>
      </header>

      <section className="grid">
        <div className="panel config-panel">
          <div className="section-title">
            <h2>Test configuration</h2>
            <small>Target database is flushed before LOAD.</small>
          </div>

          <label className="field wide">
            <span>Profile</span>
            <select value={config.profile} onChange={e => field('profile', e.target.value)}>
              {profiles.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>

          <div className="form-grid">
            <label className="field"><span>Host</span><input value={config.host} onChange={e => field('host', e.target.value)} /></label>
            <label className="field"><span>Port</span><input type="number" value={config.port} onChange={e => field('port', +e.target.value)} /></label>
            <label className="field"><span>Result label</span><input value={config.server} onChange={e => field('server', e.target.value)} /></label>
            <label className="field"><span>Keys</span><input type="number" value={config.keys} onChange={e => field('keys', +e.target.value)} /></label>
            <label className="field"><span>GET operations</span><input type="number" value={config.getOps} onChange={e => field('getOps', +e.target.value)} /></label>
            <label className="field"><span>Workers</span><input type="number" value={config.workers} onChange={e => field('workers', +e.target.value)} /></label>
            <label className="field"><span>Pipeline</span><input type="number" value={config.pipeline} onChange={e => field('pipeline', +e.target.value)} /></label>
            <label className="field"><span>Settle (ms)</span><input type="number" value={config.settleMs} onChange={e => field('settleMs', +e.target.value)} /></label>
            <label className="field"><span>Seed</span><input type="number" value={config.seed} onChange={e => field('seed', +e.target.value)} /></label>
          </div>

          <div className="command">
            <span>CLI equivalent</span>
            <code>{command}</code>
          </div>

          <div className="run-row">
            <button className="run-button" disabled={busy} onClick={run}>
              {busy ? 'Benchmark running…' : 'Run benchmark'}
            </button>
            {busy && <button className="cancel-button" onClick={() => window.snugBench.cancel()}>Cancel</button>}
          </div>
        </div>

        <div className="panel results-panel">
          <div className="section-title">
            <h2>Results</h2>
            {r && <div className="actions">
              <button onClick={copyResults}>{copied ? 'Copied' : 'Copy JSON'}</button>
              <button onClick={downloadResults}>Download</button>
            </div>}
          </div>

          {!r && <div className="empty">
            <div className="empty-mark">↗</div>
            <strong>No result yet</strong>
            <span>Start a benchmark to populate SET, GET, latency and memory metrics.</span>
          </div>}

          {r && <div className="metrics">
            <article><span>SET throughput</span><strong>{speed(r.load.ops_per_second)}</strong><small>p95 {us(r.load.p95_ns)}</small></article>
            <article><span>GET throughput</span><strong>{speed(r.get.ops_per_second)}</strong><small>p95 {us(r.get.p95_ns)}</small></article>
            <article><span>Memory / key</span><strong>{r.load.bytes_per_key_delta.toFixed(2)} B</strong><small>{bytes(r.load.used_memory_delta)} B delta</small></article>
            <article><span>Dataset</span><strong>{nf.format(r.load.keys)}</strong><small>{r.load.value_bytes} B values</small></article>
          </div>}

          {job?.error && <div className="error-box">{job.error}</div>}

          <div className="log-wrap">
            <div className="log-title">Live output</div>
            <pre>{job?.log || 'Waiting for benchmark…'}</pre>
          </div>
        </div>
      </section>
    </main>
  )
}

export default App
