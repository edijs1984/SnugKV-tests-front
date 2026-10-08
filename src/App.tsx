import { useEffect, useMemo, useState } from 'react'
import { MemoryRadar } from './MemoryRadar'
import type { BenchmarkConfig, Job, ServerStatus, ProfileBestResults, AllProfileBestResults } from './types'

const profiles = [
  ['cache-json', 'Cached request/response JSON · 1024 B'],
  ['session-json', 'Session JSON · 384 B'],
  ['api-json', 'API JSON · 768 B'],
  ['counter', 'Counter · 10 B'],
  ['uuid', 'UUID · 36 B'],
  ['ulid', 'ULID · 26 B'],
  ['text', 'Application text · 256 B'],
  ['repetitive', 'Compressible control · 256 B'],
  ['compressed', 'Already-compressed control · 256 B'],
  ['random', 'Incompressible control · 256 B'],
  ['hash-small', 'Hash · 10 fields'],
  ['hash-medium', 'Hash · 100 fields'],
  ['hash-large', 'Hash · 1,000 fields'],
  ['list-small', 'List · 10 items'],
  ['list-medium', 'List · 100 items'],
  ['list-large', 'List · 1,000 items'],
  ['set-small', 'Set · 10 members'],
  ['set-medium', 'Set · 100 members'],
  ['set-large', 'Set · 1,000 members'],
  ['zset-small', 'Sorted set · 10 members'],
  ['zset-medium', 'Sorted set · 100 members'],
  ['zset-large', 'Sorted set · 1,000 members'],
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
  settleMs: 0,
  seed: 1,
  optimizerMode: 'dedicated',
}

const nf = new Intl.NumberFormat('en-US')
const speed = (n: number) => `${nf.format(Math.round(n))}/s`
const us = (ns: number) => `${(ns / 1000).toFixed(2)} μs`
const bytes = (n: number) => nf.format(Math.round(n))

function historyServerKey(label: string): keyof ProfileBestResults | null {
  const value = String(label || '').toLowerCase().replace(/_/g, '-')
  if (value === 'redis') return 'redis'
  if (value === 'snug-raw') return 'snug-raw'
  if (value === 'snug' || value === 'snug-opt' || value === 'snug-mod') return 'snug-opt'
  return null
}

function mergeCompletedJobIntoBests(
  previous: AllProfileBestResults,
  job: Job,
): AllProfileBestResults {
  if (job.status !== 'done' || !job.results || !job.config) return previous

  const profile = job.config.profile
  const key = historyServerKey(job.results.load.server || job.config.server)
  if (!key) return previous

  const currentProfile: ProfileBestResults = previous[profile] ?? {
    redis: null,
    'snug-raw': null,
    'snug-opt': null,
  }
  const current = currentProfile[key]
  const load = job.results.load
  const get = job.results.get
  const bpk = Number(load.bytes_per_key_delta)

  const nextRecord = {
    bestSet: Math.max(current?.bestSet ?? 0, Number(load.ops_per_second) || 0),
    bestGet: Math.max(current?.bestGet ?? 0, Number(get.ops_per_second) || 0),
    lowestBytesPerKey:
      Number.isFinite(bpk) && bpk > 0
        ? Math.min(current?.lowestBytesPerKey ?? Number.POSITIVE_INFINITY, bpk)
        : current?.lowestBytesPerKey ?? Number.POSITIVE_INFINITY,
    runs: (current?.runs ?? 0) + 1,
    lastUpdated: new Date().toISOString(),
    source: 'electron' as const,
  }

  return {
    ...previous,
    [profile]: {
      ...currentProfile,
      [key]: nextRecord,
    },
  }
}

function App() {
  const [config, setConfig] = useState(initial)
  const [job, setJob] = useState<Job | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [serverStatus, setServerStatus] = useState<ServerStatus>({ running: false })
  const [serverBusy, setServerBusy] = useState(false)
  const [appError, setAppError] = useState<string | null>(null)
  const [bestCopied, setBestCopied] = useState(false)
  const [resettingBest, setResettingBest] = useState(false)
  const [best, setBest] = useState<ProfileBestResults>({
    redis: null,
    'snug-raw': null,
    'snug-opt': null,
  })
  const [view, setView] = useState<'run' | 'charts'>('run')
  const [allBest, setAllBest] = useState<AllProfileBestResults>({})

  useEffect(() => {
    window.snugBench.bestResults(config.profile).then(setBest)
    window.snugBench.allBestResults().then(setAllBest)
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
      if (next.status === 'done' && next.results && next.config) {
        setAllBest(prev => mergeCompletedJobIntoBests(prev, next))
        if (next.config.profile === config.profile) {
          window.snugBench.bestResults(next.config.profile).then(setBest).catch(() => {})
        }
        window.snugBench.allBestResults().then(setAllBest).catch(() => {})
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
      setAllBest(prev => ({ ...prev, [payload.profile]: payload.best }))
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

  async function startServer(kind: 'redis' | 'snug-opt') {
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
      setAllBest(prev => ({ ...prev, [config.profile]: next }))
    } catch (error) {
      setAppError(error instanceof Error ? error.message : String(error))
    } finally {
      setResettingBest(false)
    }
  }

  async function copyProfileBests() {
    const profileLabel = profiles.find(([value]) => value === config.profile)?.[1] ?? config.profile
    const rows = [
      ['redis', 'Redis'],
      ['snug-opt', 'SnugKV'],
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
        lines.push(`  best SET/s: ${Math.round(result.bestSet)}`)
        lines.push(`  best GET/s: ${Math.round(result.bestGet)}`)
        lines.push(`  lowest bytes/key: ${Number.isFinite(result.lowestBytesPerKey) ? result.lowestBytesPerKey.toFixed(2) : 'n/a'}`)
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
    }, null, 2))
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  async function downloadResults() {
    if (!job?.results) return
    await window.snugBench.save({
      filename: `snugkv-${(job.config ?? config).profile}-${(job.config ?? config).server}-${Date.now()}.json`,
      data: { config: job.config ?? config, results: job.results },
    })
  }

  function field<K extends keyof BenchmarkConfig>(key: K, value: BenchmarkConfig[K]) {
    setConfig(prev => ({ ...prev, [key]: value }))
  }

  const r = job?.results
  const runConfig = job?.config ?? config
  const selectedProfileLabel = profiles.find(([value]) => value === config.profile)?.[1] ?? config.profile
  const activeMode = serverStatus.kind
  const encodingOn = activeMode === 'snug-opt'
  const compressionOn = activeMode === 'snug-opt'
  const jsonShapeOn = activeMode === 'snug-opt'
  const optimization = job?.optimization
  const optimizing = busy && activeMode === 'snug-opt' && optimization
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
          <div className="brand-subtitle">Benchmark Lab</div>
        </div>

        <div className={`app-status ${job?.status ?? 'idle'}`}>
          <span className="status-dot" />
          <span>{job?.status ?? 'idle'}</span>
        </div>
      </header>

      <section className="workspace">
        <div className="main-area">
          <div className="server-strip">
            <div className="server-switches">
              {([
                ['redis', 'Redis'],
                ['snug-opt', 'SnugKV'],
              ] as const).map(([kind, label]) => (
                <button
                  key={kind}
                  className={activeMode === kind ? 'server-choice active' : 'server-choice'}
                  disabled={serverBusy || busy}
                  onClick={() => startServer(kind)}
                >
                  {label}
                </button>
              ))}
            </div>

            <div className="view-tabs">
              <button className={view === 'run' ? 'active' : ''} onClick={() => setView('run')}>Benchmark</button>
              <button className={view === 'charts' ? 'active' : ''} onClick={() => setView('charts')}>Charts</button>
            </div>

            <div className="server-state">
              <span>{serverStatus.running ? `${config.host}:${serverStatus.port}` : 'No local server'}</span>
              {serverStatus.running && (
                <button
                  className="mode-pill"
                  disabled={serverBusy || busy}
                  onClick={stopServer}
                  title="Stop server"
                >
                  {activeMode === 'snug-opt'
                    ? `SNUGKV · ${(serverStatus.optimizerMode ?? 'dedicated').toUpperCase()}`
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

          {view === 'charts' ? (
            <div className="charts-view">
              {(['memory', 'set', 'get'] as const).map(m => (
                <MemoryRadar key={m} metric={m} profiles={profiles as unknown as string[][]} allBest={allBest} />
              ))}
            </div>
          ) : (
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

              <div className="optimizer-mode-block">
                <span className="optimizer-mode-label">Optimizer mode</span>
                <div className="optimizer-mode-switch">
                  {(['dedicated', 'sidecar'] as const).map(mode => (
                    <button
                      key={mode}
                      type="button"
                      className={(config.optimizerMode ?? 'dedicated') === mode ? 'active' : ''}
                      disabled={busy || serverBusy}
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
                  {activeMode === 'snug-opt' &&
                    serverStatus.optimizerMode &&
                    serverStatus.optimizerMode !== (config.optimizerMode ?? 'dedicated')
                    ? ' Restart SnugKV to apply.'
                    : ''}
                </small>
              </div>

              <div className="feature-list">
                <div className={encodingOn ? 'feature-row on' : 'feature-row'}>
                  <span className="feature-toggle"><i /></span>
                  <span>Encoding</span>
                </div>
                <div className={compressionOn ? 'feature-row on' : 'feature-row'}>
                  <span className="feature-toggle"><i /></span>
                  <span>Compression</span>
                </div>
                <div className={jsonShapeOn ? 'feature-row on' : 'feature-row'}>
                  <span className="feature-toggle"><i /></span>
                  <span>JSON shape</span>
                </div>
              </div>

              <details className="advanced-box">
                <summary>Advanced</summary>
                <div className="advanced-grid">
                  <label><span>GET ops</span><input type="number" value={config.getOps} onChange={e => field('getOps', +e.target.value)} /></label>
                  <label><span>Settle ms</span><input type="number" value={config.settleMs} onChange={e => field('settleMs', +e.target.value)} /></label>
                  <label><span>Seed</span><input type="number" value={config.seed} onChange={e => field('seed', +e.target.value)} /></label>
                  <label><span>Host</span><input value={config.host} onChange={e => field('host', e.target.value)} /></label>
                  <label><span>Port</span><input type="number" value={config.port} onChange={e => field('port', +e.target.value)} /></label>
                  <label><span>Label</span><input value={config.server} onChange={e => field('server', e.target.value)} /></label>
                </div>
                <div className="cli-preview">{command}</div>
              </details>

              <div className="run-actions">
                <button className="primary-run" disabled={busy || !serverStatus.running} onClick={run}>
                  <span className="play-icon">▶</span>
                  {busy ? 'Benchmark running…' : 'Run benchmark'}
                </button>
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
                  <span>SET</span>
                  <strong>{r ? nf.format(Math.round(r.load.ops_per_second)) : '—'}</strong>
                  <small>ops/s{r ? ` · p95 ${us(r.load.p95_ns)}` : ''}</small>
                </article>
                <article className="metric-tile">
                  <span>GET</span>
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
                  <span>Bytes/key</span>
                  <strong>{r ? r.load.bytes_per_key_delta.toFixed(2) : '—'}</strong>
                  <small>
                    {r
                      ? r.load.bytes_per_key_post_workload !== undefined
                        ? `final · hot ${r.load.bytes_per_key_post_workload.toFixed(2)} B${r.load.converge_ms ? ` · ${r.load.converged ? 'converged' : 'timeout'}` : ''}`
                        : 'B/key'
                      : 'B/key'}
                  </small>
                </article>
              </div>
            </section>
          </div>
          )}
        </div>

        <aside className="best-sidebar">
          <div className="best-sidebar-head">
            <div>
              <h2>All-time bests</h2>
              <span>All benchmark types · selected profile highlighted</span>
            </div>
            <div className="best-head-actions">
              <button className="reset-bests-btn" disabled={resettingBest} onClick={resetProfileBests}>
                {resettingBest ? 'Resetting…' : 'Reset selected'}
              </button>
              <button className="copy-all-btn" onClick={copyProfileBests}>
                <span>⧉</span>
                {bestCopied ? 'Copied' : 'Copy selected'}
              </button>
            </div>
          </div>

          <div className="best-list all-profiles">
            {profiles.map(([profileKey, profileLabel]) => {
              const profileBest = allBest[profileKey] ?? {
                redis: null,
                'snug-raw': null,
                'snug-opt': null,
              }
              const hasAny = Boolean(profileBest.redis || profileBest['snug-opt'])
              return (
                <section
                  className={profileKey === config.profile ? 'best-profile-group selected' : 'best-profile-group'}
                  key={profileKey}
                >
                  <div className="best-profile-title">
                    <strong>{profileLabel}</strong>
                    {!hasAny && <span>No runs yet</span>}
                  </div>
                  {hasAny && (
                    <table className="best-table">
                      <thead>
                        <tr><th></th><th>SET/s</th><th>GET/s</th><th>B/item</th></tr>
                      </thead>
                      <tbody>
                        {([['redis', 'Redis'], ['snug-opt', 'SnugKV']] as const).map(([key, label]) => {
                          const result = profileBest[key]
                          if (!result) return null
                          const other = profileBest[key === 'redis' ? 'snug-opt' : 'redis']
                          const better = (mine: number, theirs: number | undefined, lower: boolean) =>
                            theirs !== undefined && (lower ? mine < theirs : mine > theirs) ? 'win' : undefined
                          return (
                            <tr key={key}>
                              <td><span className={`result-dot ${key}`} />{label}</td>
                              <td className={better(result.bestSet, other?.bestSet, false)}>{nf.format(Math.round(result.bestSet))}</td>
                              <td className={better(result.bestGet, other?.bestGet, false)}>{nf.format(Math.round(result.bestGet))}</td>
                              <td className={better(result.lowestBytesPerKey, other?.lowestBytesPerKey, true)}>{Number.isFinite(result.lowestBytesPerKey) ? result.lowestBytesPerKey.toFixed(1) : '—'}</td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  )}
                </section>
              )
            })}
          </div>
        </aside>
      </section>

      <footer className="app-footer">
        <div><span>Skv</span><span>v0.1.7</span></div>
        <div><span>SnugKV Benchmark Lab</span><span className="local-indicator" /> <span>Local</span></div>
      </footer>
    </main>
  )
}

export default App
