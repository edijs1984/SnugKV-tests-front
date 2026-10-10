import { useEffect, useMemo, useState } from 'react'
import type { BenchmarkConfig, Job, ServerStatus, ProfileBestResults } from './types'
import ValidationLab from './ValidationLab'
import RpcLab from './RpcLab'
import PubSubTab from './PubSubTab'
import DatabaseBrowser from './DatabaseBrowser'
import BenchmarkMatrix from './BenchmarkMatrix'
import PipelineSweep from './PipelineSweep'

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
  ['eth-hash', 'Ethereum tx hash · 0x + 64 hex'],
  ['eth-address', 'Ethereum address · mixed-case hex'],
  ['sol-pubkey', 'Solana public key · base58'],
  ['sol-signature', 'Solana signature · base58'],
  ['uint256', 'uint256 balance · decimal'],
  ['sol-token-account', 'Solana token account · 165 B binary'],
  ['sol-token-account-b64', 'Solana token account · base64 (220 chars)'],
  ['hex-key', 'Hash keys · 64 hex chars as the key'],
  ['address-key', 'Address keys · 0x + 40 hex, mixed case'],
  ['hash-small', 'Hash · 10 fields/key · 64 B values'],
  ['hash-medium', 'Hash · 100 fields/key · 64 B values'],
  ['hash-large', 'Hash · 1000 fields/key · 64 B values'],
  ['list-small', 'List · 10 items/key · 64 B values'],
  ['list-medium', 'List · 100 items/key · 64 B values'],
  ['list-large', 'List · 1000 items/key · 64 B values'],
  ['set-small', 'Set · 10 members/key'],
  ['set-medium', 'Set · 100 members/key'],
  ['set-large', 'Set · 1000 members/key'],
  ['zset-small', 'Sorted set · 10 members/key'],
  ['zset-medium', 'Sorted set · 100 members/key'],
  ['zset-large', 'Sorted set · 1000 members/key'],
] as const

const initial: BenchmarkConfig = {
  profile: 'uuid',
  host: '127.0.0.1',
  port: 6390,
  server: 'redis',
  keys: 1_000_000,
  getOps: 2_000_000,
  workers: 8,
  pipeline: 256,
  settleMs: 0,
  seed: 1,
  optimizerMode: 'dedicated',
  repetitions: 3,
  diagnostics: true,
}

const nf = new Intl.NumberFormat('en-US')
const speed = (n: number) => `${nf.format(Math.round(n))}/s`
const us = (ns: number) => `${(ns / 1000).toFixed(2)} μs`
const bytes = (n: number) => nf.format(Math.round(n))

function mergeCompletedJobIntoBest(
  previous: ProfileBestResults,
  job: Job,
): ProfileBestResults {
  if (job.status !== 'done' || !job.results || !job.config) return previous

  const server = String(job.results.load.server || job.config.server).toLowerCase()
  const key: keyof ProfileBestResults | null =
    server === 'redis'
      ? 'redis'
      : (server === 'snug' || server === 'snug-opt' || server === 'snug-mod' || server === 'snug-raw')
        ? 'snug'
        : null

  if (!key) return previous

  const current = previous[key]
  const load = job.results.load
  const get = job.results.get
  const bpk = Number(load.bytes_per_key_delta)

  return {
    ...previous,
    [key]: {
      bestSet: Math.max(current?.bestSet ?? 0, Number(load.ops_per_second) || 0),
      bestGet: Math.max(current?.bestGet ?? 0, Number(get.ops_per_second) || 0),
      lowestBytesPerKey:
        Number.isFinite(bpk) && bpk > 0
          ? Math.min(current?.lowestBytesPerKey ?? Number.POSITIVE_INFINITY, bpk)
          : current?.lowestBytesPerKey ?? Number.POSITIVE_INFINITY,
      runs: (current?.runs ?? 0) + 1,
      lastUpdated: new Date().toISOString(),
      source: 'electron',
    },
  }
}

function seconds(ms: number) {
  return `${(Math.max(0, ms) / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`
}

// Live elapsed time while a benchmark runs, and a breakdown once it finished.
function RunTimer({ job, busy, now }: { job: Job | null; busy: boolean; now: number }) {
  if (!job?.startedAt) return null
  const started = Date.parse(job.startedAt)
  if (busy) {
    const phase = job.optimization ? ' · settling memory' : ''
    return <span className="run-timer">⏱ {seconds(now - started)}{phase}</span>
  }
  if (!job.finishedAt) return null
  const total = Date.parse(job.finishedAt) - started
  const load = job.results?.load
  const get = job.results?.get
  const parts = [`total ${seconds(total)}`]
  if (load?.duration_ns) parts.push(`write ${seconds(load.duration_ns / 1e6)}`)
  if (get?.duration_ns) parts.push(`read ${seconds(get.duration_ns / 1e6)}`)
  if (load?.convergence_elapsed_ms) parts.push(`memory settle ${seconds(load.convergence_elapsed_ms)}`)
  return <span className="run-timer">⏱ {parts.join(' · ')}</span>
}

function App() {
  const [activeTab, setActiveTab] = useState<'benchmark' | 'database' | 'validation' | 'rpc' | 'pubsub'>('benchmark')
  const [config, setConfig] = useState(initial)
  const [job, setJob] = useState<Job | null>(null)
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const [matrixBusy, setMatrixBusy] = useState(false)
  const [sweepBusy, setSweepBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [serverStatus, setServerStatus] = useState<ServerStatus>({ running: false })
  const [serverBusy, setServerBusy] = useState(false)
  const [appError, setAppError] = useState<string | null>(null)
  const [bestCopied, setBestCopied] = useState(false)
  const [resettingBest, setResettingBest] = useState(false)
  const [statsEpoch, setStatsEpoch] = useState(0)
  const [clearingStats, setClearingStats] = useState(false)
  const [best, setBest] = useState<ProfileBestResults>({
    redis: null,
    snug: null,
  })

  useEffect(() => {
    window.snugBench.bestResults(config.profile).then(setBest)
  }, [config.profile])

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
    const offBench = window.snugBench.onUpdate((next: Job) => {
      setJob(next)
      if (next.status === 'done' && next.results && next.config?.profile === config.profile) {
        setBest(prev => mergeCompletedJobIntoBest(prev, next))
      }
      if (next.status !== 'running') setBusy(false)
    })
    const offServer = window.snugBench.onServerUpdate((next: ServerStatus) => {
      setServerStatus(next)
      setServerBusy(false)
      if (next.running && next.port && next.label) {
        setConfig(prev => ({ ...prev, host: '127.0.0.1', port: next.port!, server: next.label! }))
      }
    })
    const offHistory = window.snugBench.onHistoryUpdate(payload => {
      if (payload.profile === config.profile) setBest(payload.best)
    })
    window.snugBench.serverStatus().then(next => {
      setServerStatus(next)
      if (next.running && next.port && next.label) {
        setConfig(prev => ({ ...prev, host: '127.0.0.1', port: next.port!, server: next.label! }))
      }
    })
    return () => {
      offBench()
      offServer()
      offHistory()
    }
  }, [config.profile])

  async function startServer(kind: 'redis' | 'snug') {
    setServerBusy(true)
    setAppError(null)
    try {
      const next = await window.snugBench.startServer(kind, config.optimizerMode ?? 'dedicated')
      setServerStatus(next)
      if (next.port && next.label) {
        setConfig(prev => ({ ...prev, host: '127.0.0.1', port: next.port!, server: next.label! }))
      }
    } catch (error) {
      setServerBusy(false)
      setAppError(error instanceof Error ? error.message : String(error))
    }
  }

  async function stopServer() {
    setServerBusy(true)
    try {
      const next = await window.snugBench.stopServer()
      setServerStatus(next)
    } catch (error) {
      setAppError(error instanceof Error ? error.message : String(error))
    } finally {
      setServerBusy(false)
    }
  }

  useEffect(() => {
    if (!busy) return
    const timer = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(timer)
  }, [busy])

  async function run() {
    setBusy(true)
    setAppError(null)
    setCopied(false)
    setJob(null)
    try {
      const data = await window.snugBench.start(config)
      setJob(data)
    } catch (error) {
      setBusy(false)
      setAppError(error instanceof Error ? error.message : String(error))
    }
  }

  async function resetProfileBests() {
    const profileLabel = profiles.find(([value]) => value === config.profile)?.[1] ?? config.profile
    if (!window.confirm(`Reset all recorded best results for ${profileLabel}? Raw benchmark files will be kept.`)) return

    setResettingBest(true)
    setAppError(null)
    try {
      const next = await window.snugBench.resetBestResults(config.profile)
      setBest(next)
    } catch (error) {
      setAppError(error instanceof Error ? error.message : String(error))
    } finally {
      setResettingBest(false)
    }
  }

  async function clearAllStatistics() {
    if (!window.confirm('Clear all statistics?\n\nThis resets the recorded best results for every profile and clears the matrix and sweep results on screen, so you can start fresh. Raw benchmark files on disk are kept.')) return

    setClearingStats(true)
    setAppError(null)
    try {
      await window.snugBench.resetAllStatistics()
      setBest({ redis: null, snug: null })
      setJob(null)
      setStatsEpoch(epoch => epoch + 1)
    } catch (error) {
      setAppError(error instanceof Error ? error.message : String(error))
    } finally {
      setClearingStats(false)
    }
  }

  async function copyProfileBests() {
    const profileLabel = profiles.find(([value]) => value === config.profile)?.[1] ?? config.profile
    const rows = [
      ['redis', 'Redis'],
      ['snug', 'SnugKV'],
    ] as const

    const lines = [
      `SnugKV benchmark bests — ${profileLabel}`,
      '',
    ]

    for (const [key, label] of rows) {
      const result = best[key]
      lines.push(label)
      if (!result) {
        lines.push('  no recorded result')
      } else {
        lines.push(`  best WRITE/s: ${Math.round(result.bestSet)}`)
        lines.push(`  best READ/s: ${Math.round(result.bestGet)}`)
        lines.push(`  lowest bytes/unit: ${Number.isFinite(result.lowestBytesPerKey) ? result.lowestBytesPerKey.toFixed(2) : 'n/a'}`)
        lines.push(`  runs: ${result.runs}`)
      }
      lines.push('')
    }

    await navigator.clipboard.writeText(lines.join('\n').trim())
    setBestCopied(true)
    setTimeout(() => setBestCopied(false), 1500)
  }

  async function copyResults() {
    if (!job?.results) return
    await navigator.clipboard.writeText(JSON.stringify({
      config: job.config ?? config,
      results: job.results,
      diagnostics: job.diagnostics ?? null,
    }, null, 2))
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  async function downloadResults() {
    if (!job?.results) return
    await window.snugBench.save({
      filename: `snugkv-${(job.config ?? config).profile}-${(job.config ?? config).server}-${Date.now()}.json`,
      data: {
        config: job.config ?? config,
        results: job.results,
        diagnostics: job.diagnostics ?? null,
      },
    })
  }

  function field<K extends keyof BenchmarkConfig>(key: K, value: BenchmarkConfig[K]) {
    setConfig(prev => ({ ...prev, [key]: value }))
  }

  const r = job?.results
  const runConfig = job?.config ?? config
  const selectedProfileLabel = profiles.find(([value]) => value === config.profile)?.[1] ?? config.profile
  const activeMode = serverStatus.kind
  const adaptiveOn = activeMode === 'snug'
  const optimization = job?.optimization
  const optimizing = busy && adaptiveOn && optimization
  const optimizationStartMB = optimization?.start_used_memory ? optimization.start_used_memory / 1024 / 1024 : 0
  const optimizationCurrentMB = optimization?.used_memory ? optimization.used_memory / 1024 / 1024 : 0
  const optimizationSavedMB = optimization ? Math.max(0, optimizationStartMB - optimizationCurrentMB) : 0
  const rewrittenRun = Number(optimization?.optimizer_rewritten_run || 0)
  const optimizationProgress = optimization && runConfig.keys > 0
    ? Math.min(100, (rewrittenRun / runConfig.keys) * 100)
    : 0
  const estimatedFinalMB = optimization?.estimated_final_memory
    ? optimization.estimated_final_memory / 1024 / 1024
    : 0

  return (
    <main className="app-shell">
      <header className="app-header">
        <div className="brand-lockup">
          <div className="skv-logo" aria-label="Skv">
            <span>S</span><span>k</span><span>v</span>
          </div>
          <div className="brand-divider" />
          <div className="brand-subtitle">SnugKV Desktop Studio</div>
        </div>

        <nav className="top-tabs" aria-label="Workspace">
          <button
            className={activeTab === 'benchmark' ? 'active' : ''}
            onClick={() => setActiveTab('benchmark')}
          >
            Benchmark
          </button>
          <button
            className={activeTab === 'database' ? 'active' : ''}
            onClick={() => setActiveTab('database')}
          >
            Database
          </button>
          <button
            className={activeTab === 'validation' ? 'active' : ''}
            onClick={() => setActiveTab('validation')}
          >
            Tests & Soak
          </button>
          <button
            className={activeTab === 'rpc' ? 'active' : ''}
            onClick={() => setActiveTab('rpc')}
          >
            RPC cache
          </button>
          <button
            className={activeTab === 'pubsub' ? 'active' : ''}
            onClick={() => setActiveTab('pubsub')}
          >
            Pub/Sub
          </button>
        </nav>

        <button
          className="clear-stats-btn"
          disabled={clearingStats || busy || matrixBusy || sweepBusy}
          onClick={clearAllStatistics}
          title="Reset every recorded best result and clear matrix and sweep results"
        >
          {clearingStats ? 'Clearing…' : 'Clear all statistics'}
        </button>

        <div className={`app-status ${activeTab === 'benchmark' ? (job?.status ?? 'idle') : 'idle'}`}>
          <span className="status-dot" />
          <span>{activeTab === 'benchmark' ? (job?.status ?? 'idle') : activeTab === 'database' ? (serverStatus.running ? 'connected' : 'offline') : activeTab === 'rpc' ? 'rpc cache' : activeTab === 'pubsub' ? 'pub/sub' : 'validation'}</span>
        </div>
      </header>

      {activeTab === 'benchmark' ? (
      <section className="workspace">
        <div className="main-area">
          <div className="server-strip">
            <div className="server-switches">
              {([
                ['redis', 'Redis'],
                ['snug', 'SnugKV'],
              ] as const).map(([kind, label]) => (
                <button
                  key={kind}
                  className={activeMode === kind ? 'server-choice active' : 'server-choice'}
                  disabled={serverBusy || busy || matrixBusy || sweepBusy}
                  onClick={() => startServer(kind)}
                >
                  {label}
                </button>
              ))}
            </div>

            <div className="server-state">
              <span>{serverStatus.running ? `${config.host}:${serverStatus.port}` : 'No local server'}</span>
              {serverStatus.running && (
                <button
                  className="mode-pill"
                  disabled={serverBusy || busy || matrixBusy || sweepBusy}
                  onClick={stopServer}
                  title="Stop server"
                >
                  {activeMode === 'snug'
                    ? `ADAPTIVE · ${(serverStatus.optimizerMode ?? 'dedicated').toUpperCase()}`
                    : 'REDIS'}
                </button>
              )}
            </div>
          </div>

          {appError && (
            <div className="app-error-banner">
              <strong>Action failed</strong>
              <span>{appError}</span>
              <button onClick={() => setAppError(null)}>×</button>
            </div>
          )}

          <div className="bench-layout">
            <section className="config-column">
              <label className="compact-field">
                <span>Profile</span>
                <select value={config.profile} onChange={e => field('profile', e.target.value)}>
                  {profiles.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </label>

              <label className="compact-field">
                <span>Keys</span>
                <input type="number" value={config.keys} onChange={e => field('keys', +e.target.value)} />
              </label>

              <label className="compact-field">
                <span>Workers</span>
                <input type="number" value={config.workers} onChange={e => field('workers', +e.target.value)} />
              </label>

              <label className="compact-field">
                <span>Pipeline</span>
                <input type="number" value={config.pipeline} onChange={e => field('pipeline', +e.target.value)} />
              </label>

              <label className="compact-field">
                <span>Runs</span>
                <input type="number" min={1} max={50} value={config.repetitions ?? 3} onChange={e => field('repetitions', Math.max(1, Math.min(50, Math.round(+e.target.value) || 1)))} />
              </label>

              <label className="compact-field" title="SnugKV only: CPU/heap profiling during the run plus a profile replay afterwards. Slower, and profiling adds overhead to the measured run.">
                <span>Diagnostics</span>
                <input type="checkbox" checked={config.diagnostics !== false} onChange={e => field('diagnostics', e.target.checked)} />
              </label>

              <div className="optimizer-mode-block">
                <span className="optimizer-mode-label">Optimizer mode</span>
                <div className="optimizer-mode-switch">
                  {(['dedicated', 'sidecar'] as const).map(mode => (
                    <button
                      key={mode}
                      type="button"
                      className={(config.optimizerMode ?? 'dedicated') === mode ? 'active' : ''}
                      disabled={busy || serverBusy || matrixBusy}
                      onClick={() => field('optimizerMode', mode)}
                    >
                      {mode === 'dedicated' ? 'Dedicated' : 'Sidecar'}
                    </button>
                  ))}
                </div>
                <small>
                  {(config.optimizerMode ?? 'dedicated') === 'dedicated'
                    ? 'Uses the host aggressively for SnugKV.'
                    : 'Leaves CPU and memory headroom for colocated apps.'}
                  {activeMode === 'snug' &&
                    serverStatus.optimizerMode &&
                    serverStatus.optimizerMode !== (config.optimizerMode ?? 'dedicated')
                    ? ' Restart SnugKV to apply.'
                    : ''}
                </small>
              </div>

              <details className="advanced-box">
                <summary>Advanced</summary>
                <div className="advanced-grid">
                  <label><span>Read ops</span><input type="number" value={config.getOps} onChange={e => field('getOps', +e.target.value)} /></label>
                  <label><span>Settle ms</span><input type="number" value={config.settleMs} onChange={e => field('settleMs', +e.target.value)} /></label>
                  <label><span>Seed</span><input type="number" value={config.seed} onChange={e => field('seed', +e.target.value)} /></label>
                  <label><span>Host</span><input value={config.host} onChange={e => field('host', e.target.value)} /></label>
                  <label><span>Port</span><input type="number" value={config.port} onChange={e => field('port', +e.target.value)} /></label>
                  <label><span>Label</span><input value={config.server} onChange={e => field('server', e.target.value)} /></label>
                </div>
                <div className="cli-preview">{command}</div>
              </details>

              <div className="run-actions">
                <button className="primary-run" disabled={busy || matrixBusy || sweepBusy || !serverStatus.running} onClick={run}>
                  <span className="play-icon">▶</span>
                  {busy ? 'Benchmark running…' : 'Run benchmark'}
                </button>
                {(busy || job?.startedAt) && <RunTimer job={job} busy={busy} now={now} />}
                {busy && <button className="secondary-stop" onClick={() => window.snugBench.cancel()}>Cancel</button>}
              </div>
            </section>

            <section className="results-workspace">
              {optimizing && (
                <div className="optimization-card">
                  <div className="optimization-head">
                    <div>
                      <span className="optimization-pulse" />
                      <strong>Optimizing SnugKV</strong>
                    </div>
                    <span>{optimizationProgress.toFixed(1)}%</span>
                  </div>

                  <div className="optimization-memory">
                    <strong>{optimizationCurrentMB.toFixed(1)} MB</strong>
                    <span>
                      from {optimizationStartMB.toFixed(1)} MB
                      {optimizationSavedMB > 0 ? ` · saved ${optimizationSavedMB.toFixed(1)} MB` : ''}
                      {estimatedFinalMB > 0 ? ` · est. final ${estimatedFinalMB.toFixed(1)} MB` : ''}
                    </span>
                  </div>

                  <div className="optimization-bar" aria-label="Optimization progress">
                    <i style={{ width: `${optimizationProgress}%` }} />
                  </div>
                  {optimization?.estimated_final_bytes_per_key !== undefined && (
                    <div className="optimization-estimate">
                      Estimated final <b>{optimization.estimated_final_bytes_per_key.toFixed(1)} B/key</b>
                    </div>
                  )}

                  <div className="optimization-stats">
                    <span>Rewritten <b>{nf.format(rewrittenRun)}</b> / {nf.format(runConfig.keys)}</span>
                    <span>Queue <b>{nf.format(Number(optimization.optimizer_queue_depth || 0))}</b></span>
                    {optimization.arena_payload_bytes !== undefined && (
                      <span>Payload <b>{(optimization.arena_payload_bytes / 1024 / 1024).toFixed(1)} MB</b></span>
                    )}
                    <span>{(optimization.elapsed_ms / 1000).toFixed(0)}s</span>
                  </div>
                </div>
              )}

              <div className="console-card">
                <div className="console-head">
                  <div>
                    <strong>Output</strong>
                    <span>{selectedProfileLabel}</span>
                  </div>
                  <div className="console-actions">
                    {r && <button onClick={copyResults}>{copied ? 'Copied' : 'Copy JSON'}</button>}
                    {r && <button onClick={downloadResults}>Save</button>}
                  </div>
                </div>
                <pre className="console-body">{job?.log || 'Ready to run.'}</pre>
                {job?.error && <div className="inline-error">{job.error}</div>}
              </div>

              <div className="metric-row">
                <article className="metric-tile">
                  <span>WRITE</span>
                  <strong>{r ? nf.format(Math.round(r.load.ops_per_second)) : '—'}</strong>
                  <small>ops/s{r ? ` · p95 ${us(r.load.p95_ns)}` : ''}</small>
                </article>
                <article className="metric-tile">
                  <span>READ</span>
                  <strong>{r ? nf.format(Math.round(r.get.ops_per_second)) : '—'}</strong>
                  <small>ops/s{r ? ` · p95 ${us(r.get.p95_ns)}` : ''}</small>
                </article>
                <article className="metric-tile">
                  <span>Memory</span>
                  <strong>{r ? `${(r.load.used_memory_delta / 1024 / 1024).toFixed(1)}` : '—'}</strong>
                  <small>
                    {r
                      ? r.load.used_memory_post_workload_delta !== undefined
                        ? `final MB · hot ${(r.load.used_memory_post_workload_delta / 1024 / 1024).toFixed(1)} MB`
                        : 'MB delta'
                      : 'MB delta'}
                  </small>
                </article>
                <article className="metric-tile">
                  <span>Bytes/unit</span>
                  <strong>{r ? r.load.bytes_per_key_delta.toFixed(2) : '—'}</strong>
                  <small>
                    {r
                      ? r.load.bytes_per_key_post_workload !== undefined
                        ? `final · hot ${r.load.bytes_per_key_post_workload.toFixed(2)} B${r.load.converge_ms ? ` · ${r.load.converged ? 'converged' : 'timeout'}` : ''}`
                        : 'B/unit'
                      : 'B/unit'}
                  </small>
                </article>
              </div>
            </section>
          </div>

        </div>

        <aside className="best-sidebar">
          <div className="best-sidebar-head">
            <div>
              <h2>Best results</h2>
              <span>{selectedProfileLabel}</span>
            </div>
            <div className="best-head-actions">
              <button className="reset-bests-btn" disabled={resettingBest} onClick={resetProfileBests}>
                {resettingBest ? 'Resetting…' : 'Reset bests'}
              </button>
              <button className="copy-all-btn" onClick={copyProfileBests}>
                <span>⧉</span>
                {bestCopied ? 'Copied' : 'Copy all'}
              </button>
            </div>
          </div>

          <div className="best-list">
            {([
              ['redis', 'Redis'],
              ['snug', 'SnugKV'],
            ] as const).map(([key, label]) => {
              const result = best[key]
              return (
                <article className="best-result-card" key={key}>
                  <div className="best-result-title">
                    <span className={`result-dot ${key}`} />
                    <strong>{label}</strong>
                  </div>
                  {result ? (
                    <dl>
                      <div><dt>Best WRITE</dt><dd>{nf.format(Math.round(result.bestSet))} /s</dd></div>
                      <div><dt>Best READ</dt><dd>{nf.format(Math.round(result.bestGet))} /s</dd></div>
                      <div><dt>Lowest B/unit</dt><dd>{Number.isFinite(result.lowestBytesPerKey) ? result.lowestBytesPerKey.toFixed(2) : '—'} B</dd></div>
                      <div><dt>Runs</dt><dd>{result.runs}</dd></div>
                    </dl>
                  ) : (
                    <div className="no-best">No recorded result</div>
                  )}
                </article>
              )
            })}
          </div>
        </aside>

        <div className="benchmark-wide-bottom">
          <PipelineSweep
            key={`sweep-${statsEpoch}`}
            baseConfig={config}
            disabled={busy || serverBusy || matrixBusy}
            onRunningChange={setSweepBusy}
          />

          <BenchmarkMatrix
            key={`matrix-${statsEpoch}`}
            profiles={profiles}
            baseConfig={config}
            disabled={busy || serverBusy || matrixBusy || sweepBusy}
            onRunningChange={setMatrixBusy}
          />
        </div>
      </section>
      ) : activeTab === 'database' ? (
        <DatabaseBrowser serverStatus={serverStatus} />
      ) : activeTab === 'rpc' ? (
        <RpcLab />
      ) : activeTab === 'pubsub' ? (
        <PubSubTab />
      ) : (
        <ValidationLab />
      )}

      <footer className="app-footer">
        <div><span>Skv</span><span>v0.2.0</span></div>
        <div><span>SnugKV Benchmark Lab</span><span className="local-indicator" /> <span>Local</span></div>
      </footer>
    </main>
  )
}

export default App
