import { useCallback, useEffect, useMemo, useState } from 'react'
import type { DbKeyDetails, DbMutation, DbOverview, DbScanKey, ServerStatus } from './types'
import { formatCommand, samples, type SampleKind } from './dbSamples'

type Props = { serverStatus: ServerStatus }

const nf = new Intl.NumberFormat('en-US')
const REFRESH_CHOICES = [
  { label: 'Off', ms: 0 },
  { label: '2 s', ms: 2000 },
  { label: '5 s', ms: 5000 },
  { label: '10 s', ms: 10000 },
]
const COUNT_CHOICES = [1, 10, 100, 1000, 10000, 100000]
const PAGE = 100

function formatBytes(bytes?: number | null) {
  if (bytes === undefined || bytes === null) return '—'
  if (bytes < 1024) return `${nf.format(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function formatTtl(ttl: number) {
  if (ttl < 0) return '—'
  if (ttl < 120) return `${ttl}s`
  if (ttl < 7200) return `${Math.round(ttl / 60)}m`
  return `${(ttl / 3600).toFixed(1)}h`
}

export default function DatabaseBrowser({ serverStatus }: Props) {
  const connected = serverStatus.running && !!serverStatus.port
  const serverName = serverStatus.kind === 'redis' ? 'Redis' : 'SnugKV'

  // ── live overview ────────────────────────────────────────────────────────
  const [overview, setOverview] = useState<DbOverview | null>(null)
  const [refreshMs, setRefreshMs] = useState(5000)
  const [now, setNow] = useState(Date.now())
  const [error, setError] = useState<string | null>(null)

  const loadOverview = useCallback(async () => {
    if (!connected) return
    try {
      const next = await window.snugBench.dbOverview()
      setOverview(next)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [connected])

  useEffect(() => {
    setOverview(null)
    if (connected) loadOverview()
  }, [connected, serverStatus.port, loadOverview])

  useEffect(() => {
    if (!connected || !refreshMs) return
    const id = window.setInterval(loadOverview, refreshMs)
    return () => window.clearInterval(id)
  }, [connected, refreshMs, loadOverview])

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [])

  // ── key table ────────────────────────────────────────────────────────────
  const [pattern, setPattern] = useState('*')
  const [keys, setKeys] = useState<DbScanKey[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [typeFilter, setTypeFilter] = useState('all')
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [scanning, setScanning] = useState(false)
  const [bulkTtl, setBulkTtl] = useState('3600')

  const scan = useCallback(async (reset: boolean, patternValue = pattern) => {
    if (!connected) return
    setScanning(true)
    try {
      let cur = reset ? '0' : cursor ?? '0'
      let collected: DbScanKey[] = []
      // A SCAN page can legitimately come back short or empty; keep going until a page is filled.
      for (let guard = 0; guard < 40 && collected.length < PAGE; guard++) {
        const res = await window.snugBench.dbScan({ cursor: cur, pattern: patternValue || '*', count: PAGE })
        collected = collected.concat(res.keys)
        cur = res.cursor
        if (cur === '0') break
      }
      setKeys(prev => (reset ? collected : [...prev, ...collected.filter(k => !prev.some(p => p.key === k.key))]))
      setCursor(cur === '0' ? null : cur)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setScanning(false)
    }
  }, [connected, cursor, pattern])

  // Reload from the top when the connection changes or the total key count changes.
  const totalKeys = overview?.keys
  useEffect(() => {
    if (!connected) {
      setKeys([])
      setCursor(null)
      setChecked(new Set())
      return
    }
    scan(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, serverStatus.port, totalKeys])

  const typeCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    keys.forEach(k => { counts[k.type] = (counts[k.type] ?? 0) + 1 })
    return counts
  }, [keys])
  const visibleKeys = useMemo(() => keys.filter(k => typeFilter === 'all' || k.type === typeFilter), [keys, typeFilter])

  function toggle(key: string) {
    setChecked(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  async function bulk(action: 'delete' | 'expire' | 'persist') {
    const list = [...checked]
    if (!list.length) return
    if (action === 'delete' && !window.confirm(`Delete ${list.length} keys?`)) return
    try {
      await window.snugBench.dbBulk(action === 'expire'
        ? { action, keys: list, seconds: Number(bulkTtl) }
        : { action, keys: list })
      if (action === 'delete') setChecked(new Set())
      await Promise.all([loadOverview(), scan(true)])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  // ── add data ─────────────────────────────────────────────────────────────
  const [kind, setKind] = useState<SampleKind>('hash')
  const sample = samples.find(s => s.kind === kind)!
  const [prefix, setPrefix] = useState(sample.defaultPrefix)
  const [count, setCount] = useState(100)
  const [expire, setExpire] = useState('')
  const [adding, setAdding] = useState(false)
  const [progress, setProgress] = useState(0)
  const [addResult, setAddResult] = useState<string | null>(null)

  useEffect(() => { setPrefix(sample.defaultPrefix) }, [sample.defaultPrefix])

  const preview = useMemo(() => sample.build(`${prefix}:1`, 1), [sample, prefix])

  async function addData() {
    if (!connected || adding) return
    setAdding(true)
    setAddResult(null)
    setProgress(0)
    setError(null)
    try {
      const seconds = expire.trim() ? Number(expire) : 0
      const started = performance.now()
      let sent = 0
      let errors = 0
      let firstError: string | null = null
      let batch: string[][] = []
      const flush = async () => {
        if (!batch.length) return
        const res = await window.snugBench.dbPipeline({ commands: batch })
        sent += res.sent
        errors += res.errors
        firstError = firstError ?? res.firstError
        batch = []
      }
      // Start numbering after the highest existing index so repeated inserts add new keys.
      const existing = keys.filter(k => k.key.startsWith(`${prefix}:`)).map(k => Number(k.key.slice(prefix.length + 1))).filter(Number.isFinite)
      const startAt = existing.length ? Math.max(...existing) + 1 : 1
      for (let i = 0; i < count; i++) {
        const key = `${prefix}:${startAt + i}`
        batch.push(...sample.build(key, startAt + i))
        if (seconds > 0) batch.push(['EXPIRE', key, String(seconds)])
        if (batch.length >= 2000) {
          await flush()
          setProgress((i + 1) / count)
        }
      }
      await flush()
      setProgress(1)
      const secs = (performance.now() - started) / 1000
      setAddResult(errors
        ? `${nf.format(count)} ${sample.label} keys sent, ${errors} errors: ${firstError}`
        : `Added ${nf.format(count)} ${sample.label.toLowerCase()} key${count === 1 ? '' : 's'} in ${secs.toFixed(secs < 10 ? 2 : 1)} s`)
      await Promise.all([loadOverview(), scan(true)])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setAdding(false)
    }
  }

  async function flushDb() {
    if (!connected) return
    const typed = window.prompt(`This deletes ALL ${nf.format(overview?.keys ?? 0)} keys.\nType FLUSH to confirm.`)
    if (typed !== 'FLUSH') return
    try {
      await window.snugBench.dbFlush()
      setSelected(null)
      setDetails(null)
      setChecked(new Set())
      await Promise.all([loadOverview(), scan(true)])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  // ── inspector ────────────────────────────────────────────────────────────
  const [selected, setSelected] = useState<string | null>(null)
  const [details, setDetails] = useState<DbKeyDetails | null>(null)
  const [ttl, setTtl] = useState('')
  const [value, setValue] = useState('')
  const [field, setField] = useState('')
  const [member, setMember] = useState('')
  const [score, setScore] = useState('0')
  const [lastCommand, setLastCommand] = useState('')

  async function openKey(key: string) {
    setSelected(key)
    try {
      const result = await window.snugBench.dbGetKey({ key })
      setDetails(result)
      setTtl(result.ttl >= 0 ? String(result.ttl) : '')
      const editable = result.type === 'string' || result.type.toLowerCase().includes('json')
      setValue(!editable ? '' : typeof result.value === 'string' ? result.value : JSON.stringify(result.value, null, 2))
      setField('')
      setMember('')
      setLastCommand(result.command)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function mutate(request: DbMutation) {
    try {
      const result = await window.snugBench.dbMutate(request)
      setLastCommand(result.command)
      await openKey(request.key)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function saveString() {
    if (!selected) return
    try {
      const result = await window.snugBench.dbSetString({ key: selected, value })
      setLastCommand(result.command)
      await openKey(selected)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function applyTtl() {
    if (!selected) return
    try {
      const result = await window.snugBench.dbSetTtl({ key: selected, seconds: ttl.trim() ? Number(ttl) : null })
      setLastCommand(result.command)
      await openKey(selected)
      scan(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function deleteKey() {
    if (!selected || !window.confirm(`Delete ${selected}?`)) return
    try {
      await window.snugBench.dbDeleteKey({ key: selected })
      setSelected(null)
      setDetails(null)
      await Promise.all([loadOverview(), scan(true)])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const renderValue = () => {
    if (!details || !selected) return null
    const isJson = details.type.toLowerCase().includes('json') || details.type === 'ReJSON-RL'

    if (isJson) {
      return <div className="dbm-editor"><textarea className="dbm-textarea" value={value} onChange={e => setValue(e.target.value)} /><button className="dbm-btn primary" onClick={() => mutate({ action: 'json-set-root', key: selected, value })}>Save JSON</button></div>
    }
    if (details.type === 'string') {
      return <div className="dbm-editor"><textarea className="dbm-textarea" value={value} onChange={e => setValue(e.target.value)} /><button className="dbm-btn primary" onClick={saveString}>Save</button></div>
    }
    if (details.type === 'hash' && Array.isArray(details.value)) {
      return <div className="dbm-rows">
        {details.value.map((row: { field: string; value: string }) => <div className="dbm-row" key={row.field}><code>{row.field}</code><span>{row.value}</span><button className="dbm-btn" onClick={() => { setField(row.field); setValue(row.value) }}>Edit</button><button className="dbm-btn danger" onClick={() => mutate({ action: 'hash-del', key: selected, field: row.field })}>×</button></div>)}
        <div className="dbm-add"><input placeholder="field" value={field} onChange={e => setField(e.target.value)} /><input placeholder="value" value={value} onChange={e => setValue(e.target.value)} /><button className="dbm-btn primary" onClick={() => mutate({ action: 'hash-set', key: selected, field, value })}>Save field</button></div>
      </div>
    }
    if (details.type === 'list' && Array.isArray(details.value)) {
      return <div className="dbm-rows">
        {details.value.map((item: unknown, index: number) => <div className="dbm-row" key={index}><code>#{index}</code><span>{String(item)}</span><button className="dbm-btn danger" onClick={() => mutate({ action: 'list-del-index', key: selected, index })}>×</button></div>)}
        <div className="dbm-add"><input placeholder="new item" value={value} onChange={e => setValue(e.target.value)} /><button className="dbm-btn" onClick={() => mutate({ action: 'list-push', key: selected, side: 'left', value })}>LPUSH</button><button className="dbm-btn primary" onClick={() => mutate({ action: 'list-push', key: selected, side: 'right', value })}>RPUSH</button></div>
      </div>
    }
    if (details.type === 'set' && Array.isArray(details.value)) {
      return <div className="dbm-rows">
        <div className="dbm-chips">{details.value.map((item: unknown) => <span key={String(item)}>{String(item)}<button onClick={() => mutate({ action: 'set-del', key: selected, value: String(item) })}>×</button></span>)}</div>
        <div className="dbm-add"><input placeholder="member" value={member} onChange={e => setMember(e.target.value)} /><button className="dbm-btn primary" onClick={() => mutate({ action: 'set-add', key: selected, value: member })}>Add member</button></div>
      </div>
    }
    if (details.type === 'zset' && Array.isArray(details.value)) {
      return <div className="dbm-rows">
        {details.value.map((row: { member: string; score: string }) => <div className="dbm-row" key={row.member}><code>{row.member}</code><span>{row.score}</span><button className="dbm-btn" onClick={() => { setMember(row.member); setScore(row.score) }}>Edit</button><button className="dbm-btn danger" onClick={() => mutate({ action: 'zset-del', key: selected, member: row.member })}>×</button></div>)}
        <div className="dbm-add"><input placeholder="member" value={member} onChange={e => setMember(e.target.value)} /><input type="number" step="any" value={score} onChange={e => setScore(e.target.value)} /><button className="dbm-btn primary" onClick={() => mutate({ action: 'zset-set', key: selected, member, score: Number(score) })}>Save member</button></div>
      </div>
    }
    return <pre className="dbm-pre">{JSON.stringify(details.value, null, 2)}</pre>
  }

  // ── render ───────────────────────────────────────────────────────────────
  const avgBytes = overview && overview.usedMemory !== null && overview.keys > 0 ? overview.usedMemory / overview.keys : null
  const updatedAgo = overview ? Math.max(0, Math.round((now - overview.at) / 1000)) : null

  if (!connected) {
    return (
      <section className="dbm">
        <div className="dbm-empty">
          <h1>No database connected</h1>
          <p>Start Redis or SnugKV from the Benchmark tab, then come back to inspect and fill it.</p>
        </div>
      </section>
    )
  }

  return (
    <section className="dbm">
      <header className="dbm-top">
        <div className="dbm-conn">
          <span className="dbm-dot" />
          <div>
            <strong>{serverName}</strong>
            <small>127.0.0.1:{serverStatus.port}</small>
          </div>
        </div>

        <div className="dbm-stats">
          <article><span>Total keys</span><strong>{overview ? nf.format(overview.keys) : '—'}</strong></article>
          <article><span>DB size</span><strong>{formatBytes(overview?.usedMemory)}</strong>{overview?.peakMemory ? <small>peak {formatBytes(overview.peakMemory)}</small> : null}</article>
          <article><span>Bytes / key</span><strong>{avgBytes !== null ? avgBytes.toFixed(1) : '—'}</strong><small>incl. overhead</small></article>
          <article><span>Peak size</span><strong>{formatBytes(overview?.peakMemory)}</strong><small>since start</small></article>
          <article><span>Memory limit</span><strong>{overview?.maxMemory ? formatBytes(overview.maxMemory) : overview ? 'None' : '—'}</strong><small>{overview?.maxMemory && overview.usedMemory ? `${((overview.usedMemory / overview.maxMemory) * 100).toFixed(1)}% used` : 'unlimited'}</small></article>
        </div>

        <div className="dbm-refresh">
          <label>
            <span>Auto refresh</span>
            <select value={refreshMs} onChange={e => setRefreshMs(Number(e.target.value))}>
              {REFRESH_CHOICES.map(c => <option key={c.ms} value={c.ms}>{c.label}</option>)}
            </select>
          </label>
          <button className="dbm-btn" onClick={() => { loadOverview(); scan(true) }}>Refresh</button>
          <small>{updatedAgo === null ? '' : updatedAgo === 0 ? 'updated now' : `updated ${updatedAgo}s ago`}</small>
        </div>
      </header>

      {error && <div className="dbm-error"><strong>Database error</strong><span>{error}</span><button onClick={() => setError(null)}>×</button></div>}

      <div className="dbm-body">
        <aside className="dbm-side">
          <section className="dbm-card">
            <h3>Add data</h3>
            <div className="dbm-kinds" role="tablist" aria-label="Data type">
              {samples.map(s => (
                <button key={s.kind} role="tab" aria-selected={kind === s.kind} className={kind === s.kind ? 'active' : ''} onClick={() => setKind(s.kind)}>{s.label}</button>
              ))}
            </div>
            <p className="dbm-models">{sample.models}</p>

            <div className="dbm-field"><span>Key prefix</span><input value={prefix} onChange={e => setPrefix(e.target.value.trim())} /></div>
            <div className="dbm-field">
              <span>How many keys</span>
              <div className="dbm-counts">
                {COUNT_CHOICES.map(c => <button key={c} className={count === c ? 'active' : ''} onClick={() => setCount(c)}>{c >= 1000 ? `${c / 1000}k` : c}</button>)}
              </div>
            </div>
            <div className="dbm-field"><span>Expire after (s)</span><input type="number" min="0" placeholder="never" value={expire} onChange={e => setExpire(e.target.value)} /></div>

            <div className="dbm-preview">
              <span>Example record</span>
              <pre>{preview.map(cmd => formatCommand(cmd)).join('\n')}</pre>
            </div>

            <button className="dbm-btn primary wide" disabled={adding || !prefix || !count} onClick={addData}>
              {adding ? `Adding… ${Math.round(progress * 100)}%` : `Add ${nf.format(count)} ${sample.label.toLowerCase()} key${count === 1 ? '' : 's'}`}
            </button>
            {adding && <div className="dbm-progress"><i style={{ width: `${progress * 100}%` }} /></div>}
            {addResult && <p className="dbm-result">{addResult}</p>}
          </section>

          <section className="dbm-card dbm-danger">
            <h3>Danger zone</h3>
            <button className="dbm-btn danger wide" onClick={flushDb} disabled={!overview?.keys}>Flush database</button>
          </section>
        </aside>

        <main className="dbm-main">
          <section className="dbm-card dbm-table-card">
            <div className="dbm-table-head">
              <div className="dbm-search">
                <input value={pattern} onChange={e => setPattern(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') scan(true) }} placeholder="Filter keys, e.g. demo:user:*" />
                <button className="dbm-btn" onClick={() => scan(true)} disabled={scanning}>Search</button>
              </div>
              <div className="dbm-types">
                <button className={typeFilter === 'all' ? 'active' : ''} onClick={() => setTypeFilter('all')}>All <b>{keys.length}</b></button>
                {Object.entries(typeCounts).map(([type, n]) => (
                  <button key={type} className={typeFilter === type ? 'active' : ''} onClick={() => setTypeFilter(type)}>{type} <b>{n}</b></button>
                ))}
              </div>
            </div>

            {checked.size > 0 && (
              <div className="dbm-bulk">
                <strong>{checked.size} selected</strong>
                <input type="number" value={bulkTtl} onChange={e => setBulkTtl(e.target.value)} aria-label="Expire seconds" />
                <button className="dbm-btn" onClick={() => bulk('expire')}>Expire</button>
                <button className="dbm-btn" onClick={() => bulk('persist')}>Persist</button>
                <button className="dbm-btn danger" onClick={() => bulk('delete')}>Delete</button>
                <button className="dbm-btn" onClick={() => setChecked(new Set())}>Clear</button>
              </div>
            )}

            <div className="dbm-table-scroll">
              <table className="dbm-table">
                <thead>
                  <tr>
                    <th className="chk"><input type="checkbox" aria-label="Select all shown" checked={visibleKeys.length > 0 && visibleKeys.every(k => checked.has(k.key))} onChange={e => setChecked(e.target.checked ? new Set(visibleKeys.map(k => k.key)) : new Set())} /></th>
                    <th>Key</th><th>Type</th><th className="num">TTL</th><th className="num">Memory</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleKeys.map(k => (
                    <tr key={k.key} className={selected === k.key ? 'active' : ''} onClick={() => openKey(k.key)}>
                      <td className="chk" onClick={e => e.stopPropagation()}><input type="checkbox" checked={checked.has(k.key)} onChange={() => toggle(k.key)} /></td>
                      <td className="key">{k.key}</td>
                      <td><span className={`dbm-type ${k.type}`}>{k.type}</span></td>
                      <td className="num">{formatTtl(k.ttl)}</td>
                      <td className="num">{k.memoryBytes !== undefined ? formatBytes(k.memoryBytes) : '—'}</td>
                    </tr>
                  ))}
                  {!visibleKeys.length && (
                    <tr><td colSpan={5} className="dbm-none">{scanning ? 'Loading…' : overview?.keys ? 'No keys match this filter.' : 'The database is empty. Use “Add data” to create some keys.'}</td></tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="dbm-table-foot">
              <span>Showing {nf.format(visibleKeys.length)} of {overview ? nf.format(overview.keys) : '—'} keys</span>
              {cursor && <button className="dbm-btn" disabled={scanning} onClick={() => scan(false)}>{scanning ? 'Loading…' : 'Load more'}</button>}
            </div>
          </section>

          {details && selected && (
            <section className="dbm-card dbm-inspector">
              <div className="dbm-insp-head">
                <div><span>Key inspector</span><h2>{details.key}</h2></div>
                <div>
                  <button className="dbm-btn" onClick={() => openKey(details.key)}>Reload</button>
                  <button className="dbm-btn danger" onClick={deleteKey}>Delete</button>
                  <button className="dbm-btn" onClick={() => { setSelected(null); setDetails(null) }} aria-label="Close">×</button>
                </div>
              </div>
              <div className="dbm-meta">
                <article><span>Type</span><strong>{details.type}</strong></article>
                <article><span>Length</span><strong>{details.length ?? '—'}</strong></article>
                <article><span>Memory</span><strong>{formatBytes(details.memoryBytes)}</strong></article>
                <article><span>Encoding</span><strong>{details.encoding ?? '—'}</strong></article>
                <article className="ttl"><span>TTL (s)</span><div><input type="number" placeholder="none" value={ttl} onChange={e => setTtl(e.target.value)} /><button className="dbm-btn" onClick={applyTtl}>Apply</button></div></article>
              </div>
              {renderValue()}
              <div className="dbm-cmd"><span>Equivalent command</span><code>{lastCommand}</code></div>
            </section>
          )}
        </main>
      </div>
    </section>
  )
}
