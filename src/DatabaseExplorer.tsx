import { useEffect, useMemo, useState } from 'react'
import type { DbKeyDetails, DbKeySummary, ServerStatus } from './types'

type Props = {
  serverStatus: ServerStatus
}

type DataKind = 'string' | 'hash' | 'list' | 'set' | 'zset' | 'json'

const examples: Array<{ kind: DataKind; label: string; key: string; hint: string }> = [
  { kind: 'string', label: 'String', key: 'demo:greeting', hint: 'Simple cache value, token, flag or counter.' },
  { kind: 'hash', label: 'Hash', key: 'demo:user:42', hint: 'Object-like fields such as a user profile.' },
  { kind: 'list', label: 'List', key: 'demo:queue', hint: 'Ordered queue, feed or recent activity.' },
  { kind: 'set', label: 'Set', key: 'demo:tags', hint: 'Unique unordered members.' },
  { kind: 'zset', label: 'Sorted set', key: 'demo:leaderboard', hint: 'Members ordered by numeric score.' },
  { kind: 'json', label: 'JSON', key: 'demo:json:user', hint: 'Structured JSON document when JSON commands are available.' },
]

function valuePreview(details: DbKeyDetails | null) {
  if (!details) return ''
  if (typeof details.value === 'string') return details.value
  return JSON.stringify(details.value, null, 2)
}

export default function DatabaseExplorer({ serverStatus }: Props) {
  const [pattern, setPattern] = useState('*')
  const [keys, setKeys] = useState<DbKeySummary[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [details, setDetails] = useState<DbKeyDetails | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [ttl, setTtl] = useState('')
  const [stringValue, setStringValue] = useState('')
  const [newKey, setNewKey] = useState('demo:greeting')
  const [exampleKind, setExampleKind] = useState<DataKind>('string')
  const [lastCommand, setLastCommand] = useState('')

  const connected = serverStatus.running && !!serverStatus.port
  const serverLabel = connected
    ? `${serverStatus.label ?? serverStatus.kind ?? 'server'} · 127.0.0.1:${serverStatus.port}`
    : 'No local database connected'

  async function refresh(nextPattern = pattern) {
    if (!connected) return
    setBusy(true)
    setError(null)
    try {
      const result = await window.snugBench.dbListKeys({ pattern: nextPattern, count: 300 })
      setKeys(result.keys)
      setLastCommand(result.command)
      if (selected && !result.keys.some(item => item.key === selected)) {
        setSelected(null)
        setDetails(null)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function openKey(key: string) {
    setSelected(key)
    setBusy(true)
    setError(null)
    try {
      const result = await window.snugBench.dbGetKey({ key })
      setDetails(result)
      setTtl(result.ttl >= 0 ? String(result.ttl) : '')
      setStringValue(typeof result.value === 'string' ? result.value : '')
      setLastCommand(result.command)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setDetails(null)
    } finally {
      setBusy(false)
    }
  }

  async function saveString() {
    if (!selected) return
    setBusy(true)
    setError(null)
    try {
      const result = await window.snugBench.dbSetString({ key: selected, value: stringValue })
      setLastCommand(result.command)
      await openKey(selected)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function applyTtl() {
    if (!selected) return
    setBusy(true)
    setError(null)
    try {
      const seconds = ttl.trim() === '' ? null : Number(ttl)
      const result = await window.snugBench.dbSetTtl({ key: selected, seconds })
      setLastCommand(result.command)
      await openKey(selected)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function removeKey() {
    if (!selected || !window.confirm(`Delete ${selected}?`)) return
    setBusy(true)
    setError(null)
    try {
      const result = await window.snugBench.dbDeleteKey({ key: selected })
      setLastCommand(result.command)
      setSelected(null)
      setDetails(null)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function createExample() {
    if (!newKey.trim()) return
    setBusy(true)
    setError(null)
    try {
      const result = await window.snugBench.dbCreateExample({ key: newKey.trim(), kind: exampleKind })
      setLastCommand(result.command)
      await refresh()
      await openKey(newKey.trim())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (connected) refresh('*')
    else {
      setKeys([])
      setSelected(null)
      setDetails(null)
    }
  }, [serverStatus.running, serverStatus.port])

  const typeDescription = useMemo(() => {
    switch (details?.type) {
      case 'string': return 'A single value. Good for cache entries, counters, tokens and flags.'
      case 'hash': return 'A field/value object stored under one key.'
      case 'list': return 'An ordered sequence. Useful for queues and recent activity.'
      case 'set': return 'An unordered collection of unique values.'
      case 'zset': return 'A unique collection ordered by numeric score.'
      case 'ReJSON-RL':
      case 'json': return 'A structured JSON document with path-based reads and updates.'
      default: return details ? 'This key type is shown in raw form.' : 'Choose a key to inspect it.'
    }
  }, [details])

  return (
    <section className="db-explorer">
      <aside className="db-sidebar">
        <div className="db-sidebar-head">
          <span className="eyebrow">Visual database browser</span>
          <h2>Database</h2>
          <p>{serverLabel}</p>
        </div>

        <div className="db-search-row">
          <input
            value={pattern}
            disabled={!connected || busy}
            onChange={e => setPattern(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') refresh() }}
            placeholder="Pattern, e.g. user:*"
          />
          <button disabled={!connected || busy} onClick={() => refresh()}>Search</button>
        </div>

        <div className="db-key-count">{keys.length} keys shown</div>
        <div className="db-key-list">
          {!connected && <div className="db-empty">Start Redis or SnugKV from the Benchmark tab first.</div>}
          {connected && !keys.length && !busy && <div className="db-empty">No matching keys.</div>}
          {keys.map(item => (
            <button
              key={item.key}
              className={selected === item.key ? 'db-key active' : 'db-key'}
              onClick={() => openKey(item.key)}
            >
              <span className="db-key-name">{item.key}</span>
              <span className={`db-type db-type-${item.type}`}>{item.type}</span>
            </button>
          ))}
        </div>
      </aside>

      <main className="db-main">
        <div className="db-hero">
          <div>
            <span className="eyebrow">RedisInsight-style workflow</span>
            <h1>{details?.key ?? 'Explore your data visually'}</h1>
            <p>{typeDescription}</p>
          </div>
          <button className="db-refresh" disabled={!connected || busy} onClick={() => selected ? openKey(selected) : refresh()}>
            ↻ Refresh
          </button>
        </div>

        {error && <div className="app-error-banner db-error"><strong>Database error</strong><span>{error}</span><button onClick={() => setError(null)}>×</button></div>}

        {!details ? (
          <div className="db-welcome-grid">
            <section className="db-card db-create-card">
              <span className="eyebrow">Learn by creating</span>
              <h3>Create example data</h3>
              <p>Pick a data type and SnugKV will create a realistic example, then show the command that produced it.</p>
              <label>
                <span>Data type</span>
                <select value={exampleKind} onChange={e => {
                  const kind = e.target.value as DataKind
                  setExampleKind(kind)
                  setNewKey(examples.find(item => item.kind === kind)?.key ?? 'demo:key')
                }}>
                  {examples.map(item => <option key={item.kind} value={item.kind}>{item.label}</option>)}
                </select>
              </label>
              <label>
                <span>Key name</span>
                <input value={newKey} onChange={e => setNewKey(e.target.value)} />
              </label>
              <div className="db-example-hint">{examples.find(item => item.kind === exampleKind)?.hint}</div>
              <button className="primary-run" disabled={!connected || busy} onClick={createExample}>Create example</button>
            </section>

            <section className="db-card">
              <span className="eyebrow">Data types</span>
              <h3>What should I use?</h3>
              <div className="db-type-guide">
                {examples.map(item => (
                  <button key={item.kind} onClick={() => { setExampleKind(item.kind); setNewKey(item.key) }}>
                    <strong>{item.label}</strong>
                    <span>{item.hint}</span>
                  </button>
                ))}
              </div>
            </section>
          </div>
        ) : (
          <>
            <div className="db-meta-grid">
              <article><span>Type</span><strong>{details.type}</strong></article>
              <article><span>TTL</span><strong>{details.ttl < 0 ? 'No expiry' : `${details.ttl}s`}</strong></article>
              <article><span>Size</span><strong>{details.length ?? '—'}</strong></article>
              <article><span>Encoding</span><strong>{details.encoding ?? 'automatic'}</strong></article>
            </div>

            <section className="db-card db-value-card">
              <div className="db-card-head">
                <div><span className="eyebrow">Value inspector</span><h3>{details.type}</h3></div>
                <button className="danger-button" onClick={removeKey} disabled={busy}>Delete key</button>
              </div>

              {details.type === 'string' ? (
                <div className="db-string-editor">
                  <textarea value={stringValue} onChange={e => setStringValue(e.target.value)} />
                  <button className="primary-run" disabled={busy} onClick={saveString}>Save value</button>
                </div>
              ) : (
                <pre className="db-value-preview">{valuePreview(details)}</pre>
              )}
            </section>

            <section className="db-card db-ttl-card">
              <div>
                <span className="eyebrow">Expiration</span>
                <h3>Time to live</h3>
                <p>Leave empty to persist forever, or enter seconds until this key expires.</p>
              </div>
              <div className="db-ttl-controls">
                <input type="number" min="1" placeholder="No expiry" value={ttl} onChange={e => setTtl(e.target.value)} />
                <button onClick={applyTtl} disabled={busy}>Apply TTL</button>
              </div>
            </section>
          </>
        )}

        <section className="db-command-card">
          <div>
            <span className="eyebrow">Under the hood</span>
            <h3>Command equivalent</h3>
            <p>You do not need to memorize commands. The UI shows what it used so you can learn gradually.</p>
          </div>
          <code>{lastCommand || 'Select or create data to see the equivalent command.'}</code>
        </section>
      </main>
    </section>
  )
}
