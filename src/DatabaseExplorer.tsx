import { useEffect, useMemo, useState } from 'react'
import type { DbKeyDetails, DbKeySummary, DbMutation, ServerStatus } from './types'

type Props = { serverStatus: ServerStatus }
type DataKind = 'string' | 'hash' | 'list' | 'set' | 'zset' | 'json'
type CommandAction = 'get' | 'type' | 'ttl' | 'exists' | 'incr'

const examples: Array<{ kind: DataKind; label: string; key: string; hint: string }> = [
  { kind: 'string', label: 'String', key: 'demo:greeting', hint: 'Cache value, token, flag or counter.' },
  { kind: 'hash', label: 'Hash', key: 'demo:user:42', hint: 'Object-like fields such as a user profile.' },
  { kind: 'list', label: 'List', key: 'demo:queue', hint: 'Ordered queue, feed or recent activity.' },
  { kind: 'set', label: 'Set', key: 'demo:tags', hint: 'Unique unordered members.' },
  { kind: 'zset', label: 'Sorted set', key: 'demo:leaderboard', hint: 'Members ordered by numeric score.' },
  { kind: 'json', label: 'JSON', key: 'demo:json:user', hint: 'Structured document with path-based access.' },
]

function formatBytes(bytes?: number) {
  if (bytes === undefined) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

function namespaceOf(key: string) {
  const index = key.indexOf(':')
  return index > 0 ? key.slice(0, index) : 'root'
}

export default function DatabaseExplorer({ serverStatus }: Props) {
  const [pattern, setPattern] = useState('*')
  const [keys, setKeys] = useState<DbKeySummary[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [details, setDetails] = useState<DbKeyDetails | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [ttl, setTtl] = useState('')
  const [stringValue, setStringValue] = useState('')
  const [jsonValue, setJsonValue] = useState('')
  const [newKey, setNewKey] = useState('demo:greeting')
  const [exampleKind, setExampleKind] = useState<DataKind>('string')
  const [lastCommand, setLastCommand] = useState('')
  const [newField, setNewField] = useState('')
  const [newValue, setNewValue] = useState('')
  const [newScore, setNewScore] = useState('0')
  const [bulkTtl, setBulkTtl] = useState('3600')
  const [commandAction, setCommandAction] = useState<CommandAction>('type')
  const [commandKey, setCommandKey] = useState('')
  const [commandAmount, setCommandAmount] = useState('1')
  const [commandResult, setCommandResult] = useState('')
  const [namespace, setNamespace] = useState('all')

  const connected = serverStatus.running && !!serverStatus.port
  const serverLabel = connected
    ? `${serverStatus.label ?? serverStatus.kind ?? 'server'} · 127.0.0.1:${serverStatus.port}`
    : 'No local database connected'

  const namespaces = useMemo(() => {
    const counts = new Map<string, number>()
    keys.forEach(item => counts.set(namespaceOf(item.key), (counts.get(namespaceOf(item.key)) ?? 0) + 1))
    return [...counts.entries()].sort((a, b) => b[1] - a[1])
  }, [keys])

  const visibleKeys = useMemo(
    () => namespace === 'all' ? keys : keys.filter(item => namespaceOf(item.key) === namespace),
    [keys, namespace],
  )

  async function refresh(nextPattern = pattern) {
    if (!connected) return
    setBusy(true)
    setError(null)
    try {
      const result = await window.snugBench.dbListKeys({ pattern: nextPattern, count: 500 })
      setKeys(result.keys)
      setLastCommand(result.command)
      setChecked(prev => new Set([...prev].filter(key => result.keys.some(item => item.key === key))))
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
    setCommandKey(key)
    setBusy(true)
    setError(null)
    try {
      const result = await window.snugBench.dbGetKey({ key })
      setDetails(result)
      setTtl(result.ttl >= 0 ? String(result.ttl) : '')
      setStringValue(typeof result.value === 'string' ? result.value : '')
      setJsonValue(
        result.type.toLowerCase().includes('json') || result.type === 'ReJSON-RL'
          ? JSON.stringify(result.value, null, 2)
          : '',
      )
      setLastCommand(result.command)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setDetails(null)
    } finally {
      setBusy(false)
    }
  }

  async function mutate(request: DbMutation) {
    setBusy(true)
    setError(null)
    try {
      const result = await window.snugBench.dbMutate(request)
      setLastCommand(result.command)
      await openKey(request.key)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function saveString() {
    if (!selected) return
    setBusy(true)
    try {
      const result = await window.snugBench.dbSetString({ key: selected, value: stringValue })
      setLastCommand(result.command)
      await openKey(selected)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function applyTtl() {
    if (!selected) return
    setBusy(true)
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

  async function bulk(action: 'delete' | 'expire' | 'persist') {
    const selectedKeys = [...checked]
    if (!selectedKeys.length) return
    if (action === 'delete' && !window.confirm(`Delete ${selectedKeys.length} selected keys?`)) return
    setBusy(true)
    try {
      const request = action === 'expire'
        ? { action, keys: selectedKeys, seconds: Number(bulkTtl) } as const
        : { action, keys: selectedKeys } as const
      const result = await window.snugBench.dbBulk(request)
      setLastCommand(result.command)
      if (action === 'delete') {
        setChecked(new Set())
        if (selected && selectedKeys.includes(selected)) {
          setSelected(null)
          setDetails(null)
        }
      }
      await refresh()
      if (selected && action !== 'delete') await openKey(selected)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function runBuilder() {
    if (!commandKey.trim()) return
    setBusy(true)
    setCommandResult('')
    try {
      const request = commandAction === 'incr'
        ? { action: 'incr' as const, key: commandKey.trim(), amount: Number(commandAmount) }
        : { action: commandAction, key: commandKey.trim() }
      const result = await window.snugBench.dbCommand(request)
      setLastCommand(result.command)
      setCommandResult(result.result || '(empty response)')
      if (selected === commandKey.trim()) await openKey(selected)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  function toggleChecked(key: string) {
    setChecked(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  useEffect(() => {
    if (connected) refresh('*')
    else {
      setKeys([])
      setSelected(null)
      setDetails(null)
      setChecked(new Set())
    }
  }, [serverStatus.running, serverStatus.port])

  const typeDescription = useMemo(() => {
    switch (details?.type) {
      case 'string': return 'A single value. Great for cache entries, counters, tokens and flags.'
      case 'hash': return 'A field/value object. Edit individual fields without replacing the whole object.'
      case 'list': return 'An ordered sequence. Add to either side, edit positions, or remove items.'
      case 'set': return 'Unique unordered values. Ideal for tags, membership and deduplication.'
      case 'zset': return 'Unique members ordered by score. Ideal for leaderboards and ranked queues.'
      case 'ReJSON-RL':
      case 'json': return 'Structured JSON. Edit the document visually while learning JSON.SET.'
      default: return details ? 'This key type is shown in raw form.' : 'Choose a key to inspect it.'
    }
  }, [details])

  const renderEditor = () => {
    if (!details || !selected) return null

    if (details.type === 'string') {
      return (
        <div className="db-string-editor">
          <textarea value={stringValue} onChange={e => setStringValue(e.target.value)} />
          <button className="primary-run" disabled={busy} onClick={saveString}>Save value</button>
        </div>
      )
    }

    if (details.type === 'hash' && Array.isArray(details.value)) {
      return (
        <div className="db-table-editor">
          {details.value.map((row: any) => (
            <div className="db-edit-row db-edit-row-hash" key={row.field}>
              <code>{row.field}</code>
              <input defaultValue={row.value} id={`hash-${row.field}`} />
              <button onClick={() => {
                const input = document.getElementById(`hash-${row.field}`) as HTMLInputElement
                mutate({ action: 'hash-set', key: selected, field: row.field, value: input.value })
              }}>Save</button>
              <button className="mini-danger" onClick={() => mutate({ action: 'hash-del', key: selected, field: row.field })}>×</button>
            </div>
          ))}
          <div className="db-add-row">
            <input placeholder="field" value={newField} onChange={e => setNewField(e.target.value)} />
            <input placeholder="value" value={newValue} onChange={e => setNewValue(e.target.value)} />
            <button onClick={() => {
              if (!newField) return
              mutate({ action: 'hash-set', key: selected, field: newField, value: newValue })
              setNewField(''); setNewValue('')
            }}>+ Add field</button>
          </div>
        </div>
      )
    }

    if (details.type === 'list' && Array.isArray(details.value)) {
      return (
        <div className="db-table-editor">
          {details.value.map((value: any, index: number) => (
            <div className="db-edit-row db-edit-row-list" key={index}>
              <code>#{index}</code>
              <input defaultValue={String(value)} id={`list-${index}`} />
              <button onClick={() => {
                const input = document.getElementById(`list-${index}`) as HTMLInputElement
                mutate({ action: 'list-set', key: selected, index, value: input.value })
              }}>Save</button>
              <button className="mini-danger" onClick={() => mutate({ action: 'list-del-index', key: selected, index })}>×</button>
            </div>
          ))}
          <div className="db-add-row">
            <input placeholder="new list item" value={newValue} onChange={e => setNewValue(e.target.value)} />
            <button onClick={() => { mutate({ action: 'list-push', key: selected, side: 'left', value: newValue }); setNewValue('') }}>+ Left</button>
            <button onClick={() => { mutate({ action: 'list-push', key: selected, side: 'right', value: newValue }); setNewValue('') }}>+ Right</button>
          </div>
        </div>
      )
    }

    if (details.type === 'set' && Array.isArray(details.value)) {
      return (
        <div className="db-chip-editor">
          <div className="db-member-chips">
            {details.value.map((value: any) => (
              <span key={String(value)}>{String(value)}<button onClick={() => mutate({ action: 'set-del', key: selected, value: String(value) })}>×</button></span>
            ))}
          </div>
          <div className="db-add-row">
            <input placeholder="new unique member" value={newValue} onChange={e => setNewValue(e.target.value)} />
            <button onClick={() => { if (newValue) mutate({ action: 'set-add', key: selected, value: newValue }); setNewValue('') }}>+ Add member</button>
          </div>
        </div>
      )
    }

    if (details.type === 'zset' && Array.isArray(details.value)) {
      return (
        <div className="db-table-editor">
          {details.value.map((row: any) => (
            <div className="db-edit-row db-edit-row-zset" key={row.member}>
              <code>{row.member}</code>
              <input type="number" step="any" defaultValue={row.score} id={`score-${row.member}`} />
              <button onClick={() => {
                const input = document.getElementById(`score-${row.member}`) as HTMLInputElement
                mutate({ action: 'zset-set', key: selected, member: row.member, score: Number(input.value) })
              }}>Save score</button>
              <button className="mini-danger" onClick={() => mutate({ action: 'zset-del', key: selected, member: row.member })}>×</button>
            </div>
          ))}
          <div className="db-add-row">
            <input placeholder="member" value={newValue} onChange={e => setNewValue(e.target.value)} />
            <input type="number" step="any" placeholder="score" value={newScore} onChange={e => setNewScore(e.target.value)} />
            <button onClick={() => {
              if (!newValue) return
              mutate({ action: 'zset-set', key: selected, member: newValue, score: Number(newScore) })
              setNewValue(''); setNewScore('0')
            }}>+ Add member</button>
          </div>
        </div>
      )
    }

    if (details.type.toLowerCase().includes('json') || details.type === 'ReJSON-RL') {
      return (
        <div className="db-string-editor">
          <textarea className="db-json-editor" value={jsonValue} onChange={e => setJsonValue(e.target.value)} />
          <button className="primary-run" disabled={busy} onClick={() => mutate({ action: 'json-set-root', key: selected, value: jsonValue })}>
            Validate & save JSON
          </button>
        </div>
      )
    }

    return <pre className="db-value-preview">{JSON.stringify(details.value, null, 2)}</pre>
  }

  return (
    <section className="db-explorer">
      <aside className="db-sidebar">
        <div className="db-sidebar-head">
          <span className="eyebrow">Visual database browser</span>
          <h2>Database</h2>
          <p>{serverLabel}</p>
        </div>

        <div className="db-search-row">
          <input value={pattern} disabled={!connected || busy} onChange={e => setPattern(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') refresh() }} placeholder="Pattern, e.g. user:*" />
          <button disabled={!connected || busy} onClick={() => refresh()}>Search</button>
        </div>

        {!!namespaces.length && (
          <div className="db-namespaces">
            <button className={namespace === 'all' ? 'active' : ''} onClick={() => setNamespace('all')}>All <b>{keys.length}</b></button>
            {namespaces.map(([name, count]) => (
              <button key={name} className={namespace === name ? 'active' : ''} onClick={() => setNamespace(name)}>
                {name} <b>{count}</b>
              </button>
            ))}
          </div>
        )}

        {checked.size > 0 && (
          <div className="db-bulk-bar">
            <strong>{checked.size} selected</strong>
            <div><input type="number" min="1" value={bulkTtl} onChange={e => setBulkTtl(e.target.value)} /><button onClick={() => bulk('expire')}>Expire</button></div>
            <button onClick={() => bulk('persist')}>Persist</button>
            <button className="mini-danger" onClick={() => bulk('delete')}>Delete</button>
          </div>
        )}

        <div className="db-key-count">{visibleKeys.length} keys shown</div>
        <div className="db-key-list">
          {!connected && <div className="db-empty">Start Redis or SnugKV from Benchmark first.</div>}
          {connected && !visibleKeys.length && !busy && <div className="db-empty">No matching keys.</div>}
          {visibleKeys.map(item => (
            <div className={selected === item.key ? 'db-key-row active' : 'db-key-row'} key={item.key}>
              <input type="checkbox" checked={checked.has(item.key)} onChange={() => toggleChecked(item.key)} />
              <button className="db-key" onClick={() => openKey(item.key)}>
                <span className="db-key-name">{item.key}</span>
                <span className={`db-type db-type-${item.type}`}>{item.type}</span>
              </button>
            </div>
          ))}
        </div>
      </aside>

      <main className="db-main">
        <div className="db-hero">
          <div>
            <span className="eyebrow">Visual Redis / SnugKV studio</span>
            <h1>{details?.key ?? 'Explore your data visually'}</h1>
            <p>{typeDescription}</p>
          </div>
          <button className="db-refresh" disabled={!connected || busy} onClick={() => selected ? openKey(selected) : refresh()}>↻ Refresh</button>
        </div>

        {error && <div className="app-error-banner db-error"><strong>Database error</strong><span>{error}</span><button onClick={() => setError(null)}>×</button></div>}

        {!details ? (
          <div className="db-welcome-grid">
            <section className="db-card db-create-card">
              <span className="eyebrow">Learn by creating</span>
              <h3>Create example data</h3>
              <p>Choose a data structure and create a realistic example without knowing its Redis command.</p>
              <label><span>Data type</span><select value={exampleKind} onChange={e => {
                const kind = e.target.value as DataKind
                setExampleKind(kind)
                setNewKey(examples.find(item => item.kind === kind)?.key ?? 'demo:key')
              }}>{examples.map(item => <option key={item.kind} value={item.kind}>{item.label}</option>)}</select></label>
              <label><span>Key name</span><input value={newKey} onChange={e => setNewKey(e.target.value)} /></label>
              <div className="db-example-hint">{examples.find(item => item.kind === exampleKind)?.hint}</div>
              <button className="primary-run" disabled={!connected || busy} onClick={createExample}>Create example</button>
            </section>

            <section className="db-card">
              <span className="eyebrow">Data types</span>
              <h3>What should I use?</h3>
              <div className="db-type-guide">{examples.map(item => (
                <button key={item.kind} onClick={() => { setExampleKind(item.kind); setNewKey(item.key) }}>
                  <strong>{item.label}</strong><span>{item.hint}</span>
                </button>
              ))}</div>
            </section>
          </div>
        ) : (
          <>
            <div className="db-meta-grid">
              <article><span>Type</span><strong>{details.type}</strong></article>
              <article><span>TTL</span><strong>{details.ttl < 0 ? 'No expiry' : `${details.ttl}s`}</strong></article>
              <article><span>Items / length</span><strong>{details.length ?? '—'}</strong></article>
              <article><span>Memory</span><strong>{formatBytes(details.memoryBytes)}</strong></article>
              <article><span>Encoding</span><strong>{details.encoding ?? 'automatic'}</strong></article>
            </div>

            <section className="db-card db-value-card">
              <div className="db-card-head">
                <div><span className="eyebrow">Visual editor</span><h3>{details.type}</h3></div>
                <button className="danger-button" onClick={removeKey} disabled={busy}>Delete key</button>
              </div>
              {renderEditor()}
            </section>

            <section className="db-card db-ttl-card">
              <div><span className="eyebrow">Expiration</span><h3>Time to live</h3><p>Empty means persist forever. Otherwise enter seconds.</p></div>
              <div className="db-ttl-controls">
                <input type="number" min="1" placeholder="No expiry" value={ttl} onChange={e => setTtl(e.target.value)} />
                <button onClick={applyTtl} disabled={busy}>Apply TTL</button>
              </div>
            </section>
          </>
        )}

        <section className="db-card db-command-builder">
          <div className="db-card-head">
            <div><span className="eyebrow">Beginner command builder</span><h3>Do something without writing Redis syntax</h3></div>
          </div>
          <div className="db-builder-controls">
            <select value={commandAction} onChange={e => setCommandAction(e.target.value as CommandAction)}>
              <option value="type">What type is this?</option>
              <option value="ttl">How long until it expires?</option>
              <option value="exists">Does this key exist?</option>
              <option value="get">Read string value</option>
              <option value="incr">Increase counter</option>
            </select>
            <input placeholder="key name" value={commandKey} onChange={e => setCommandKey(e.target.value)} />
            {commandAction === 'incr' && <input type="number" value={commandAmount} onChange={e => setCommandAmount(e.target.value)} />}
            <button onClick={runBuilder} disabled={!connected || busy || !commandKey.trim()}>Run</button>
          </div>
          {commandResult && <div className="db-command-result"><span>Result</span><strong>{commandResult}</strong></div>}
        </section>

        <section className="db-command-card">
          <div><span className="eyebrow">Under the hood</span><h3>Command equivalent</h3>
            <p>The app translates visual actions into Redis-compatible commands so beginners can learn gradually.</p></div>
          <code>{lastCommand || 'Select, edit or create data to see the equivalent command.'}</code>
        </section>
      </main>
    </section>
  )
}
