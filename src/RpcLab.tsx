import { useEffect, useMemo, useState } from 'react'
import type { RpcCacheKind, RpcChain, RpcLabConfig, RpcLabJob, RpcWalletResult } from './types'

const defaults: RpcLabConfig = {
  chain: 'solana',
  caches: ['snug', 'redis'],
  users: 200,
  durationSeconds: 30,
  refreshMs: 3000,
  watched: 15,
  popular: 200,
  popularReads: 5,
  overlap: 0.5,
  skew: 1.2,
  cacheTtlSeconds: 0,
  blockTimeMs: 0,
  settleSeconds: 8,
  checkRate: 0.2,
  seed: 1,
}

type Preset = { id: string; label: string; description: string; patch: Partial<RpcLabConfig> }

const presets: Preset[] = [
  {
    id: 'quick',
    label: 'Quick check',
    description: '100 users for 15 s with the proxy\'s normal 1 s cache times. Shows the hit rate and how stale answers get.',
    patch: { users: 100, durationSeconds: 15, refreshMs: 3000, popular: 200, cacheTtlSeconds: 0, settleSeconds: 5 },
  },
  {
    id: 'wallet',
    label: 'Wallet app',
    description: '200 users refreshing every 3 s, half of each user\'s accounts shared with others.',
    patch: { users: 200, durationSeconds: 30, refreshMs: 3000, popular: 200, overlap: 0.5, cacheTtlSeconds: 0, settleSeconds: 8 },
  },
  {
    id: 'memory',
    label: 'Cache memory',
    description: 'Thousands of entries held for 10 minutes, then a long wait for SnugKV\'s optimizer. Use this one to compare bytes per entry.',
    patch: { users: 2000, durationSeconds: 40, refreshMs: 2000, popular: 5000, overlap: 0.5, cacheTtlSeconds: 600, settleSeconds: 45 },
  },
  {
    id: 'load',
    label: 'Heavy load',
    description: '1,000 users refreshing twice a second. Compares latency and throughput.',
    patch: { users: 1000, durationSeconds: 30, refreshMs: 500, popular: 1000, cacheTtlSeconds: 0, settleSeconds: 5 },
  },
]

const MIN_ENTRIES_FOR_MEMORY = 3000

function pct(value: number | undefined, digits = 1) {
  return value === undefined || Number.isNaN(value) ? '—' : `${(value * 100).toFixed(digits)}%`
}

function num(value: number | undefined, digits = 0) {
  return value === undefined || Number.isNaN(value) ? '—' : value.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits })
}

function mib(bytes: number | undefined) {
  return bytes === undefined ? '—' : `${(bytes / 1048576).toFixed(2)} MiB`
}

type Row = {
  label: string
  hint?: string
  value: (r: RpcWalletResult, p?: Record<string, number>) => number | undefined
  format: (v: number | undefined) => string
  /** Which direction is better, to colour the difference. */
  better?: 'lower' | 'higher'
}

const rows: Row[] = [
  { label: 'Answered without the node', hint: 'hits plus calls that shared another call', value: r => r.answered_without_node, format: v => pct(v), better: 'higher' },
  { label: 'Calls per second', value: r => r.calls_per_sec, format: v => num(v), better: 'higher' },
  { label: 'Latency p50', value: r => r.p50_ms, format: v => `${num(v, 2)} ms`, better: 'lower' },
  { label: 'Latency p99', value: r => r.p99_ms, format: v => `${num(v, 1)} ms`, better: 'lower' },
  { label: 'Stale answers', hint: 'share of checked reads that differed from the node', value: r => r.staleness?.stale_share, format: v => pct(v) },
  { label: 'Entries at peak', value: r => r.cache_peak_entries, format: v => num(v) },
  { label: 'Cache memory at peak', value: r => r.cache_peak_bytes, format: mib, better: 'lower' },
  { label: 'Bytes per entry at peak', value: r => r.cache_bytes_per_entry_at_peak, format: v => (v === undefined ? '—' : `${num(v)} B`), better: 'lower' },
  { label: 'Cache memory after settling', hint: 'after SnugKV\'s optimizer had time to run', value: r => r.cache_bytes_after_wait, format: mib, better: 'lower' },
  { label: 'Cache errors', hint: 'cache calls the proxy gave up on and sent to the node instead', value: (_r, p) => p?.cache_errors, format: v => num(v), better: 'lower' },
  { label: 'Cache pool busy', hint: 'calls that found every cache connection in use', value: (_r, p) => p?.cache_busy, format: v => num(v), better: 'lower' },
]

export default function RpcLab() {
  const [config, setConfig] = useState<RpcLabConfig>(defaults)
  const [preset, setPreset] = useState<string>('wallet')
  const [job, setJob] = useState<RpcLabJob | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => window.snugBench.onRpcUpdate(next => setJob(next)), [])

  const busy = job?.status === 'running'
  const set = <K extends keyof RpcLabConfig>(key: K, value: RpcLabConfig[K]) => {
    setPreset('')
    setConfig(prev => ({ ...prev, [key]: value }))
  }

  function choosePreset(next: Preset) {
    setPreset(next.id)
    setConfig(prev => ({ ...prev, ...next.patch }))
  }

  function toggleCache(kind: RpcCacheKind) {
    setConfig(prev => {
      const has = prev.caches.includes(kind)
      const caches = has ? prev.caches.filter(item => item !== kind) : [...prev.caches, kind]
      return { ...prev, caches: caches.length ? caches : prev.caches }
    })
  }

  async function run() {
    setError(null)
    setJob(null)
    try {
      setJob(await window.snugBench.startRpcLab(config))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function copyJson() {
    if (job) await navigator.clipboard.writeText(JSON.stringify({ config: job.config, results: job.results }, null, 2))
  }

  async function saveJson() {
    if (!job) return
    await window.snugBench.save({
      filename: `rpc-cache-${job.config.chain}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`,
      data: { config: job.config, results: job.results, commands: job.commands },
    })
  }

  const results = job?.results ?? []
  const byKind = (kind: RpcCacheKind) => results.find(item => item.cache === kind)
  const snug = byKind('snug')
  const redis = byKind('redis')
  const methods = useMemo(() => {
    const names = new Set<string>()
    results.forEach(item => Object.keys(item.result.methods ?? {}).forEach(name => names.add(name)))
    return [...names].sort()
  }, [results])

  const tooFew = results.some(item => (item.result.cache_peak_entries ?? 0) < MIN_ENTRIES_FOR_MEMORY)
  const chainWord = config.chain === 'evm' ? 'block' : 'slot'

  return (
    <section className="validation-lab rpc-lab">
      <aside className="validation-sidebar">
        <div className="validation-sidebar-head">
          <span className="eyebrow">rpccache simulation</span>
          <h2>RPC cache</h2>
          <p>Simulated wallet users read through the caching proxy. Each cache backend gets the same traffic, one after the other, on private ports.</p>
        </div>

        <div className="validation-group">
          <div className="validation-group-title">Chain</div>
          <div className="rpc-toggle">
            {(['solana', 'evm'] as RpcChain[]).map(chain => (
              <button
                key={chain}
                className={config.chain === chain ? 'active' : ''}
                disabled={busy}
                onClick={() => set('chain', chain)}
              >
                {chain === 'solana' ? 'Solana' : 'EVM'}
              </button>
            ))}
          </div>
        </div>

        <div className="validation-group">
          <div className="validation-group-title">Cache backends</div>
          <div className="rpc-toggle">
            {(['snug', 'redis'] as RpcCacheKind[]).map(kind => (
              <button
                key={kind}
                className={config.caches.includes(kind) ? 'active' : ''}
                disabled={busy}
                onClick={() => toggleCache(kind)}
              >
                {kind === 'snug' ? 'SnugKV' : 'Redis'}
              </button>
            ))}
          </div>
        </div>

        <div className="validation-group">
          <div className="validation-group-title">Presets</div>
          {presets.map(item => (
            <button
              key={item.id}
              className={preset === item.id ? 'validation-suite active' : 'validation-suite'}
              disabled={busy}
              onClick={() => choosePreset(item)}
            >
              <span>{item.label}</span>
              <small>{item.description}</small>
            </button>
          ))}
        </div>
      </aside>

      <div className="validation-main">
        <div className="validation-hero">
          <div>
            <span className="eyebrow">{config.chain === 'evm' ? 'Ethereum-style workload' : 'Solana workload'}</span>
            <h1>{config.caches.length > 1 ? 'SnugKV vs Redis as the RPC cache' : `${config.caches[0] === 'snug' ? 'SnugKV' : 'Redis'} as the RPC cache`}</h1>
            <p>
              {config.chain === 'evm'
                ? 'Each refresh reads the block number and gas price, the owner\'s balance, a batch of token balances and a few popular contracts.'
                : 'Each refresh reads the slot, one getMultipleAccounts for the user\'s accounts, the owner\'s balance and a few popular accounts.'}
              {' '}Generated data on a fake node: the numbers show how the cache behaves for this traffic pattern, not what real users would see.
            </p>
          </div>
          <div className={`validation-status ${job?.status ?? 'idle'}`}>
            <i />
            <span>{busy ? job?.stage : job?.status ?? 'idle'}</span>
          </div>
        </div>

        <div className="validation-options rpc-options">
          <label><span>Users</span><input type="number" min={1} max={5000} value={config.users} disabled={busy} onChange={e => set('users', Number(e.target.value))} /></label>
          <label><span>Duration (s)</span><input type="number" min={5} max={600} value={config.durationSeconds} disabled={busy} onChange={e => set('durationSeconds', Number(e.target.value))} /></label>
          <label><span>Refresh every (ms)</span><input type="number" min={200} max={60000} step={100} value={config.refreshMs} disabled={busy} onChange={e => set('refreshMs', Number(e.target.value))} /></label>
          <label><span>Accounts per user</span><input type="number" min={1} max={100} value={config.watched} disabled={busy} onChange={e => set('watched', Number(e.target.value))} /></label>
          <label><span>Popular pool</span><input type="number" min={10} max={200000} value={config.popular} disabled={busy} onChange={e => set('popular', Number(e.target.value))} /></label>
          <label><span>Popular reads / refresh</span><input type="number" min={0} max={50} value={config.popularReads} disabled={busy} onChange={e => set('popularReads', Number(e.target.value))} /></label>
          <label><span>Shared share (0–1)</span><input type="number" min={0} max={1} step={0.1} value={config.overlap} disabled={busy} onChange={e => set('overlap', Number(e.target.value))} /></label>
          <label><span>Popularity skew</span><input type="number" min={1.01} max={3} step={0.1} value={config.skew} disabled={busy} onChange={e => set('skew', Number(e.target.value))} /></label>
          <label>
            <span>Cache time (s, 0 = default)</span>
            <input type="number" min={0} max={86400} value={config.cacheTtlSeconds} disabled={busy} onChange={e => set('cacheTtlSeconds', Number(e.target.value))} />
          </label>
          <label>
            <span>{chainWord === 'block' ? 'Block' : 'Slot'} time (ms, 0 = default)</span>
            <input type="number" min={0} max={60000} step={100} value={config.blockTimeMs} disabled={busy} onChange={e => set('blockTimeMs', Number(e.target.value))} />
          </label>
          <label><span>Settle before memory (s)</span><input type="number" min={0} max={120} value={config.settleSeconds} disabled={busy} onChange={e => set('settleSeconds', Number(e.target.value))} /></label>
          <label><span>Freshness checks (0–1)</span><input type="number" min={0} max={1} step={0.1} value={config.checkRate} disabled={busy} onChange={e => set('checkRate', Number(e.target.value))} /></label>
        </div>

        <div className="validation-warning">
          Starts SnugKV, Redis, a fake node and the proxy on ports 16379, 16383, 19100 and 18899, then stops them. Your managed servers are not touched. The cache is cleared by starting fresh each time.
        </div>

        {error && <div className="app-error-banner validation-error"><strong>Action failed</strong><span>{error}</span></div>}

        <div className="validation-actions">
          <button className="primary-run" disabled={busy} onClick={run}>
            <span className="play-icon">▶</span>
            {busy ? 'Running…' : 'Run comparison'}
          </button>
          {busy && <button className="secondary-stop" onClick={() => window.snugBench.cancelRpcLab()}>Cancel</button>}
          {results.length > 0 && <button className="validation-copy" onClick={copyJson}>Copy JSON</button>}
          {results.length > 0 && <button className="validation-copy" onClick={saveJson}>Save JSON</button>}
        </div>

        {job?.error && <div className="app-error-banner validation-error"><strong>Run failed</strong><span>{job.error}</span></div>}

        {results.length > 0 && (
          <div className="rpc-results">
            <h3>Comparison</h3>
            <table className="rpc-table">
              <thead>
                <tr>
                  <th>Measure</th>
                  {results.map(item => <th key={item.cache} className={item.cache === 'snug' ? 'is-snug' : ''}>{item.label}</th>)}
                  {snug && redis && <th>SnugKV vs Redis</th>}
                </tr>
              </thead>
              <tbody>
                {rows.map(row => {
                  const a = snug ? row.value(snug.result, snug.proxy) : undefined
                  const b = redis ? row.value(redis.result, redis.proxy) : undefined
                  let diff = ''
                  let tone = ''
                  if (snug && redis && a !== undefined && b !== undefined && b !== 0) {
                    const change = (a - b) / b
                    diff = `${change > 0 ? '+' : ''}${(change * 100).toFixed(1)}%`
                    if (row.better && Math.abs(change) >= 0.03) {
                      const good = row.better === 'lower' ? change < 0 : change > 0
                      tone = good ? 'good' : 'bad'
                    }
                  }
                  return (
                    <tr key={row.label}>
                      <td>{row.label}{row.hint && <small>{row.hint}</small>}</td>
                      {results.map(item => <td key={item.cache}>{row.format(row.value(item.result, item.proxy))}</td>)}
                      {snug && redis && <td className={`rpc-diff ${tone}`}>{diff || '—'}</td>}
                    </tr>
                  )
                })}
              </tbody>
            </table>
            {results.some(item => (item.proxy?.cache_errors ?? 0) > 0) && (
              <p className="rpc-note">
                The proxy gave up on some cache calls and asked the node instead, so these caches did not see equal traffic. Compare hit rates with care.
              </p>
            )}
            {tooFew && (
              <p className="rpc-note">
                Fewer than {MIN_ENTRIES_FOR_MEMORY.toLocaleString()} cached entries at the peak. A server's fixed overhead dominates bytes per entry at that size, so do not compare memory from this run. The Cache memory preset holds enough entries.
              </p>
            )}
            {results.some(item => item.result.staleness?.lag_slots_p50 !== undefined) && (
              <p className="rpc-note">
                When a cached answer was stale it was {results.map(item => `${num(item.result.staleness?.lag_slots_p50)} ${chainWord}s (median, ${item.label})`).join(' and ')} behind the node.
              </p>
            )}

            <h3>Bytes per cached entry at peak</h3>
            <div className="rpc-bars">
              {results.map(item => {
                const value = item.result.cache_bytes_per_entry_at_peak ?? 0
                const max = Math.max(...results.map(other => other.result.cache_bytes_per_entry_at_peak ?? 0), 1)
                return (
                  <div className="rpc-bar-row" key={item.cache}>
                    <span>{item.label}</span>
                    <div className="rpc-bar-track"><div className={`rpc-bar ${item.cache}`} style={{ width: `${(value / max) * 100}%` }} /></div>
                    <strong>{num(value)} B</strong>
                  </div>
                )
              })}
            </div>

            {methods.length > 0 && (
              <>
                <h3>By method: calls answered without the node</h3>
                <table className="rpc-table">
                  <thead>
                    <tr>
                      <th>Method</th>
                      <th>Calls</th>
                      {results.map(item => <th key={item.cache}>{item.label}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {methods.map(name => (
                      <tr key={name}>
                        <td>{name}</td>
                        <td>{num(results[0]?.result.methods?.[name]?.calls)}</td>
                        {results.map(item => <td key={item.cache}>{pct(item.result.methods?.[name]?.answered_without_node)}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="rpc-note">Reads that are unique to one user (their balance, their own account list) cannot be answered from the cache, whichever backend holds it. Only reads many users share can.</p>
              </>
            )}
          </div>
        )}

        <div className="validation-console">
          <div className="console-head">
            <div>
              <strong>Run output</strong>
              <span>{job?.commands?.length ? 'The commands this run executed are listed below the log.' : 'Choose a preset and run.'}</span>
            </div>
            {job?.startedAt && <span className="validation-time">{new Date(job.startedAt).toLocaleString()}</span>}
          </div>
          <pre className="validation-console-body">{job?.log || 'Ready.'}</pre>
          {job?.commands?.length ? <pre className="validation-console-body rpc-commands">{job.commands.join('\n')}</pre> : null}
        </div>
      </div>
    </section>
  )
}
