import { useEffect, useState } from 'react'
import type { PubSubLabConfig, PubSubLabJob, PubSubResult, PubSubServerKind } from './types'

const defaults: PubSubLabConfig = {
  servers: ['snug', 'redis'],
  subscribers: 200,
  stuck: 0,
  channels: 10,
  publishers: 4,
  payloadBytes: 256,
  rate: 500,
  durationSeconds: 15,
  pattern: false,
  sendAttempts: 5,
  sendTimeoutMs: 1000,
  queueSize: 1024,
}

type Preset = { id: string; label: string; description: string; patch: Partial<PubSubLabConfig> }

const presets: Preset[] = [
  {
    id: 'fanout',
    label: 'Fan-out',
    description: '500 subscribers on 10 channels, 500 messages a second of 256 bytes. Compares delivery rate and latency.',
    patch: { subscribers: 500, stuck: 0, channels: 10, publishers: 4, payloadBytes: 256, rate: 500, durationSeconds: 15, pattern: false },
  },
  {
    id: 'slow',
    label: 'Subscribers that stop reading',
    description: '50 healthy subscribers and 3 that never read, 64 KB messages. Shows whether a stuck client slows publishers and whether the server drops it.',
    patch: { subscribers: 50, stuck: 3, channels: 10, publishers: 4, payloadBytes: 65536, rate: 200, durationSeconds: 15, pattern: false },
  },
  {
    id: 'pattern',
    label: 'Pattern subscriptions',
    description: 'Same as fan-out, but every subscriber uses PSUBSCRIBE with a glob.',
    patch: { subscribers: 500, stuck: 0, channels: 10, publishers: 4, payloadBytes: 256, rate: 500, durationSeconds: 15, pattern: true },
  },
  {
    id: 'max',
    label: 'As fast as possible',
    description: '200 subscribers, publishers without a rate limit. Finds the throughput ceiling.',
    patch: { subscribers: 200, stuck: 0, channels: 10, publishers: 8, payloadBytes: 256, rate: 0, durationSeconds: 15, pattern: false },
  },
]

function num(value: number | undefined, digits = 0) {
  return value === undefined || Number.isNaN(value) ? '—' : value.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits })
}

function mib(bytes: number | undefined) {
  return bytes === undefined ? '—' : `${(bytes / 1048576).toFixed(1)} MiB`
}

type Row = {
  label: string
  hint?: string
  value: (r: PubSubResult) => number | undefined
  format: (v: number | undefined, r: PubSubResult) => string
  better?: 'lower' | 'higher'
  only?: (r: PubSubResult) => boolean
}

const rows: Row[] = [
  { label: 'Deliveries per second', value: r => r.deliveries_per_sec, format: v => num(v), better: 'higher' },
  { label: 'Delivered', hint: 'share of expected deliveries to healthy subscribers', value: r => r.delivered_share, format: v => (v === undefined ? '—' : `${(v * 100).toFixed(2)}%`), better: 'higher' },
  { label: 'Delivery latency p50', value: r => r.delivery_p50_ms, format: v => `${num(v, 2)} ms`, better: 'lower' },
  { label: 'Delivery latency p99', value: r => r.delivery_p99_ms, format: v => `${num(v, 2)} ms`, better: 'lower' },
  { label: 'Delivery latency max', value: r => r.delivery_max_ms, format: v => `${num(v, 1)} ms`, better: 'lower' },
  { label: 'Publish per second', value: r => r.publish_per_sec, format: v => num(v), better: 'higher' },
  { label: 'PUBLISH latency p50', value: r => r.publish_p50_ms, format: v => `${num(v, 2)} ms`, better: 'lower' },
  { label: 'PUBLISH latency p99', value: r => r.publish_p99_ms, format: v => `${num(v, 2)} ms`, better: 'lower' },
  { label: 'PUBLISH latency max', hint: 'a stuck subscriber that blocks the server shows up here', value: r => r.publish_max_ms, format: v => `${num(v, 1)} ms`, better: 'lower' },
  { label: 'Healthy subscribers disconnected', value: r => r.healthy_disconnected, format: v => num(v), better: 'lower' },
  { label: 'Stuck subscribers disconnected', hint: 'by the server, of those that never read', value: r => r.stuck_dropped, format: (v, r) => `${num(v)} of ${num(r.stuck_subscribers)}`, only: r => r.stuck_subscribers > 0 },
  { label: 'Held for stuck subscribers', hint: 'bytes the server had queued for them', value: r => r.stuck_bytes_buffered, format: v => mib(v), better: 'lower', only: r => r.stuck_subscribers > 0 },
  { label: 'PUBLISH errors', value: r => r.publish_errors, format: v => num(v), better: 'lower' },
]

export default function PubSubLab() {
  const [config, setConfig] = useState<PubSubLabConfig>(defaults)
  const [preset, setPreset] = useState<string>('fanout')
  const [job, setJob] = useState<PubSubLabJob | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => window.snugBench.onPubSubUpdate(next => setJob(next)), [])

  const busy = job?.status === 'running'
  const set = <K extends keyof PubSubLabConfig>(key: K, value: PubSubLabConfig[K]) => {
    setPreset('')
    setConfig(prev => ({ ...prev, [key]: value }))
  }

  function toggleServer(kind: PubSubServerKind) {
    setConfig(prev => {
      const has = prev.servers.includes(kind)
      const servers = has ? prev.servers.filter(item => item !== kind) : [...prev.servers, kind]
      return { ...prev, servers: servers.length ? servers : prev.servers }
    })
  }

  async function run() {
    setError(null)
    setJob(null)
    try {
      setJob(await window.snugBench.startPubSubLab(config))
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
      filename: `pubsub-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`,
      data: { config: job.config, results: job.results, commands: job.commands },
    })
  }

  const results = job?.results ?? []
  const snug = results.find(item => item.server === 'snug')
  const redis = results.find(item => item.server === 'redis')
  const problems = results.filter(item => item.result.first_problem)
  const hasStuck = config.stuck > 0

  return (
    <section className="validation-lab rpc-lab">
      <aside className="validation-sidebar">
        <div className="validation-sidebar-head">
          <span className="eyebrow">pubsubbench</span>
          <h2>Pub/Sub</h2>
          <p>Subscribers and publishers on loopback, the same scenario for each server, one after the other, on private ports.</p>
        </div>

        <div className="validation-group">
          <div className="validation-group-title">Servers</div>
          <div className="rpc-toggle">
            {(['snug', 'redis'] as PubSubServerKind[]).map(kind => (
              <button key={kind} className={config.servers.includes(kind) ? 'active' : ''} disabled={busy} onClick={() => toggleServer(kind)}>
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
              onClick={() => { setPreset(item.id); setConfig(prev => ({ ...prev, ...item.patch })) }}
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
            <span className="eyebrow">Publish / subscribe</span>
            <h1>{config.servers.length > 1 ? 'SnugKV vs Redis Pub/Sub' : `${config.servers[0] === 'snug' ? 'SnugKV' : 'Redis'} Pub/Sub`}</h1>
            <p>
              Each message carries a timestamp, so delivery latency is measured at the subscriber. Subscribers that never read test what the server does when a client stops accepting messages: SnugKV retries, then disconnects it. Redis queues messages for it until a buffer limit.
            </p>
          </div>
          <div className={`validation-status ${job?.status ?? 'idle'}`}>
            <i />
            <span>{busy ? job?.stage : job?.status ?? 'idle'}</span>
          </div>
        </div>

        <div className="validation-options rpc-options">
          <label><span>Subscribers</span><input type="number" min={1} max={5000} value={config.subscribers} disabled={busy} onChange={e => set('subscribers', Number(e.target.value))} /></label>
          <label><span>Never read</span><input type="number" min={0} max={200} value={config.stuck} disabled={busy} onChange={e => set('stuck', Number(e.target.value))} /></label>
          <label><span>Channels</span><input type="number" min={1} max={1000} value={config.channels} disabled={busy} onChange={e => set('channels', Number(e.target.value))} /></label>
          <label><span>Publishers</span><input type="number" min={1} max={64} value={config.publishers} disabled={busy} onChange={e => set('publishers', Number(e.target.value))} /></label>
          <label><span>Message size (bytes)</span><input type="number" min={24} max={1048576} value={config.payloadBytes} disabled={busy} onChange={e => set('payloadBytes', Number(e.target.value))} /></label>
          <label><span>PUBLISH per second (0 = max)</span><input type="number" min={0} max={200000} value={config.rate} disabled={busy} onChange={e => set('rate', Number(e.target.value))} /></label>
          <label><span>Duration (s)</span><input type="number" min={3} max={300} value={config.durationSeconds} disabled={busy} onChange={e => set('durationSeconds', Number(e.target.value))} /></label>
          <label>
            <span>Subscribe with</span>
            <select value={config.pattern ? 'p' : 's'} disabled={busy} onChange={e => set('pattern', e.target.value === 'p')}>
              <option value="s">SUBSCRIBE</option>
              <option value="p">PSUBSCRIBE</option>
            </select>
          </label>
          <label><span>SnugKV: attempts before drop</span><input type="number" min={1} max={100} value={config.sendAttempts} disabled={busy} onChange={e => set('sendAttempts', Number(e.target.value))} /></label>
          <label><span>SnugKV: attempt timeout (ms)</span><input type="number" min={1} max={60000} value={config.sendTimeoutMs} disabled={busy} onChange={e => set('sendTimeoutMs', Number(e.target.value))} /></label>
          <label><span>SnugKV: queue per subscriber</span><input type="number" min={1} max={1048576} value={config.queueSize} disabled={busy} onChange={e => set('queueSize', Number(e.target.value))} /></label>
        </div>

        <div className="validation-warning">
          Starts SnugKV and Redis on ports 16384 and 16380, then stops them. Your managed servers are not touched. The SnugKV build must include the Pub/Sub queue (the three SnugKV options above are flags of that build).
        </div>

        {error && <div className="app-error-banner validation-error"><strong>Action failed</strong><span>{error}</span></div>}

        <div className="validation-actions">
          <button className="primary-run" disabled={busy} onClick={run}>
            <span className="play-icon">▶</span>
            {busy ? 'Running…' : 'Run comparison'}
          </button>
          {busy && <button className="secondary-stop" onClick={() => window.snugBench.cancelPubSubLab()}>Cancel</button>}
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
                  {results.map(item => <th key={item.server} className={item.server === 'snug' ? 'is-snug' : ''}>{item.label}</th>)}
                  {snug && redis && <th>SnugKV vs Redis</th>}
                </tr>
              </thead>
              <tbody>
                {rows.filter(row => !row.only || results.some(item => row.only!(item.result))).map(row => {
                  const a = snug ? row.value(snug.result) : undefined
                  const b = redis ? row.value(redis.result) : undefined
                  let diff = ''
                  let tone = ''
                  if (snug && redis && a !== undefined && b !== undefined && b !== 0 && row.better) {
                    const change = (a - b) / b
                    diff = `${change > 0 ? '+' : ''}${(change * 100).toFixed(1)}%`
                    if (Math.abs(change) >= 0.03) {
                      const good = row.better === 'lower' ? change < 0 : change > 0
                      tone = good ? 'good' : 'bad'
                    }
                  }
                  return (
                    <tr key={row.label}>
                      <td>{row.label}{row.hint && <small>{row.hint}</small>}</td>
                      {results.map(item => <td key={item.server}>{row.format(row.value(item.result), item.result)}</td>)}
                      {snug && redis && <td className={`rpc-diff ${tone}`}>{diff || '—'}</td>}
                    </tr>
                  )
                })}
              </tbody>
            </table>
            {hasStuck && (
              <p className="rpc-note">
                A server that does not disconnect a client that stopped reading keeps queueing messages for it, which costs memory. Redis disconnects such a client only after its output buffer passes a limit (8 MB for 60 s, or 32 MB at once), so a short run can end with the client still connected.
              </p>
            )}
            {results.some(item => item.result.delivered_share < 0.999) && (
              <p className="rpc-note">
                Fewer than all messages reached the healthy subscribers. Pub/Sub does not store messages for a subscriber that is not keeping up, so share below 100% means the subscribers or the machine could not keep pace with the publish rate.
              </p>
            )}
            {problems.length > 0 && (
              <p className="rpc-note">
                {problems.map(item => `${item.label}: ${item.result.first_problem}`).join(' · ')}
              </p>
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
