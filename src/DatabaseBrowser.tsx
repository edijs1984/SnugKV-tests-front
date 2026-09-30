import { useEffect, useMemo, useState } from 'react'
import type { DbKeyDetails, DbKeySummary, DbMutation, ServerStatus } from './types'

type Props = { serverStatus: ServerStatus }

function formatBytes(bytes?: number) {
  if (bytes === undefined) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

export default function DatabaseBrowser({ serverStatus }: Props) {
  const [pattern, setPattern] = useState('*')
  const [keys, setKeys] = useState<DbKeySummary[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [details, setDetails] = useState<DbKeyDetails | null>(null)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [ttl, setTtl] = useState('')
  const [value, setValue] = useState('')
  const [field, setField] = useState('')
  const [member, setMember] = useState('')
  const [score, setScore] = useState('0')
  const [bulkTtl, setBulkTtl] = useState('3600')
  const [lastCommand, setLastCommand] = useState('')

  const connected = serverStatus.running && !!serverStatus.port

  async function refresh() {
    if (!connected) return
    setBusy(true)
    setError(null)
    try {
      const result = await window.snugBench.dbListKeys({ pattern, count: 1000 })
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
    setBusy(true)
    setError(null)
    try {
      const result = await window.snugBench.dbGetKey({ key })
      setDetails(result)
      setTtl(result.ttl >= 0 ? String(result.ttl) : '')
      setValue(typeof result.value === 'string' ? result.value : JSON.stringify(result.value, null, 2))
      setLastCommand(result.command)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function mutate(request: DbMutation) {
    setBusy(true)
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
      const result = await window.snugBench.dbSetString({ key: selected, value })
      setLastCommand(result.command)
      await openKey(selected)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function saveJson() {
    if (!selected) return
    await mutate({ action: 'json-set-root', key: selected, value })
  }

  async function applyTtl() {
    if (!selected) return
    setBusy(true)
    try {
      const result = await window.snugBench.dbSetTtl({ key: selected, seconds: ttl.trim() ? Number(ttl) : null })
      setLastCommand(result.command)
      await openKey(selected)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function deleteKey() {
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

  async function bulk(action: 'delete' | 'expire' | 'persist') {
    const selectedKeys = [...checked]
    if (!selectedKeys.length) return
    if (action === 'delete' && !window.confirm(`Delete ${selectedKeys.length} keys?`)) return
    setBusy(true)
    try {
      const request = action === 'expire'
        ? { action, keys: selectedKeys, seconds: Number(bulkTtl) } as const
        : { action, keys: selectedKeys } as const
      const result = await window.snugBench.dbBulk(request)
      setLastCommand(result.command)
      if (action === 'delete') setChecked(new Set())
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  function toggle(key: string) {
    setChecked(prev => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  }

  useEffect(() => {
    if (connected) refresh()
    else {
      setKeys([])
      setDetails(null)
      setSelected(null)
    }
  }, [serverStatus.running, serverStatus.port])

  const typeCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    keys.forEach(item => { counts[item.type] = (counts[item.type] ?? 0) + 1 })
    return counts
  }, [keys])

  const renderValue = () => {
    if (!details || !selected) return null

    if (details.type === 'string') {
      return <div className="db-string-editor"><textarea value={value} onChange={e => setValue(e.target.value)} /><button className="primary-run" onClick={saveString}>Save</button></div>
    }

    if (details.type.toLowerCase().includes('json') || details.type === 'ReJSON-RL') {
      return <div className="db-string-editor"><textarea className="db-json-editor" value={value} onChange={e => setValue(e.target.value)} /><button className="primary-run" onClick={saveJson}>Save JSON</button></div>
    }

    if (details.type === 'hash' && Array.isArray(details.value)) {
      return <div className="db-table-editor">
        {details.value.map((row: any) => <div className="db-edit-row db-edit-row-hash" key={row.field}><code>{row.field}</code><span>{row.value}</span><button onClick={() => { setField(row.field); setValue(row.value) }}>Edit</button><button className="mini-danger" onClick={() => mutate({ action:'hash-del', key:selected, field:row.field })}>×</button></div>)}
        <div className="db-add-row"><input placeholder="field" value={field} onChange={e=>setField(e.target.value)} /><input placeholder="value" value={value} onChange={e=>setValue(e.target.value)} /><button onClick={() => mutate({ action:'hash-set', key:selected, field, value })}>Save field</button></div>
      </div>
    }

    if (details.type === 'list' && Array.isArray(details.value)) {
      return <div className="db-table-editor">
        {details.value.map((item:any,index:number)=><div className="db-edit-row db-edit-row-list" key={index}><code>#{index}</code><span>{String(item)}</span><button onClick={()=>{ setValue(String(item)); mutate({ action:'list-set', key:selected, index, value:String(item) }) }}>Set</button><button className="mini-danger" onClick={()=>mutate({action:'list-del-index',key:selected,index})}>×</button></div>)}
        <div className="db-add-row"><input placeholder="new item" value={value} onChange={e=>setValue(e.target.value)} /><button onClick={()=>mutate({action:'list-push',key:selected,side:'left',value})}>LPUSH</button><button onClick={()=>mutate({action:'list-push',key:selected,side:'right',value})}>RPUSH</button></div>
      </div>
    }

    if (details.type === 'set' && Array.isArray(details.value)) {
      return <div className="db-chip-editor"><div className="db-member-chips">{details.value.map((item:any)=><span key={String(item)}>{String(item)}<button onClick={()=>mutate({action:'set-del',key:selected,value:String(item)})}>×</button></span>)}</div><div className="db-add-row"><input placeholder="member" value={member} onChange={e=>setMember(e.target.value)} /><button onClick={()=>mutate({action:'set-add',key:selected,value:member})}>Add member</button></div></div>
    }

    if (details.type === 'zset' && Array.isArray(details.value)) {
      return <div className="db-table-editor">
        {details.value.map((row:any)=><div className="db-edit-row db-edit-row-zset" key={row.member}><code>{row.member}</code><span>{row.score}</span><button onClick={()=>{setMember(row.member);setScore(row.score)}}>Edit</button><button className="mini-danger" onClick={()=>mutate({action:'zset-del',key:selected,member:row.member})}>×</button></div>)}
        <div className="db-add-row"><input placeholder="member" value={member} onChange={e=>setMember(e.target.value)} /><input type="number" step="any" value={score} onChange={e=>setScore(e.target.value)} /><button onClick={()=>mutate({action:'zset-set',key:selected,member,score:Number(score)})}>Save member</button></div>
      </div>
    }

    return <pre className="db-value-preview">{JSON.stringify(details.value, null, 2)}</pre>
  }

  return <section className="redisinsight-layout">
    <aside className="redisinsight-sidebar">
      <div className="redisinsight-head"><span className="eyebrow">Database browser</span><h2>Keys</h2><p>{connected ? `127.0.0.1:${serverStatus.port}` : 'Not connected'}</p></div>
      <div className="db-search-row"><input value={pattern} onChange={e=>setPattern(e.target.value)} onKeyDown={e=>{ if(e.key==='Enter') refresh() }} placeholder="Search keys: user:*" /><button onClick={refresh} disabled={!connected || busy}>Search</button></div>
      <div className="redisinsight-stats">{Object.entries(typeCounts).map(([type,count])=><span key={type}>{type} <b>{count}</b></span>)}</div>
      {checked.size > 0 && <div className="db-bulk-bar"><strong>{checked.size} selected</strong><div><input type="number" value={bulkTtl} onChange={e=>setBulkTtl(e.target.value)} /><button onClick={()=>bulk('expire')}>Expire</button></div><button onClick={()=>bulk('persist')}>Persist</button><button className="mini-danger" onClick={()=>bulk('delete')}>Delete</button></div>}
      <div className="redisinsight-keylist">{keys.map(item=><div className={selected===item.key?'redisinsight-key active':'redisinsight-key'} key={item.key}><input type="checkbox" checked={checked.has(item.key)} onChange={()=>toggle(item.key)} /><button onClick={()=>openKey(item.key)}><span>{item.key}</span><small>{item.type}</small></button></div>)}</div>
    </aside>
    <main className="redisinsight-main">
      {error && <div className="app-error-banner db-error"><strong>Database error</strong><span>{error}</span><button onClick={()=>setError(null)}>×</button></div>}
      {!details ? <div className="redisinsight-empty"><span className="eyebrow">Database</span><h1>Select a key</h1><p>Browse, inspect and edit the current database like a Redis GUI.</p></div> : <>
        <div className="redisinsight-toolbar"><div><span className="eyebrow">Key inspector</span><h1>{details.key}</h1></div><div><button onClick={()=>openKey(details.key)}>Refresh</button><button className="danger-button" onClick={deleteKey}>Delete</button></div></div>
        <div className="db-meta-grid"><article><span>Type</span><strong>{details.type}</strong></article><article><span>TTL</span><strong>{details.ttl<0?'No expiry':`${details.ttl}s`}</strong></article><article><span>Length</span><strong>{details.length ?? '—'}</strong></article><article><span>Memory</span><strong>{formatBytes(details.memoryBytes)}</strong></article><article><span>Encoding</span><strong>{details.encoding ?? '—'}</strong></article></div>
        <section className="db-card redisinsight-value"><div className="db-card-head"><div><span className="eyebrow">Value</span><h3>{details.type}</h3></div></div>{renderValue()}</section>
        <section className="db-card db-ttl-card"><div><span className="eyebrow">Expiration</span><h3>TTL</h3></div><div className="db-ttl-controls"><input type="number" placeholder="No expiry" value={ttl} onChange={e=>setTtl(e.target.value)} /><button onClick={applyTtl}>Apply</button></div></section>
        <section className="db-command-card"><div><span className="eyebrow">Command</span><h3>Equivalent command</h3></div><code>{lastCommand}</code></section>
      </>}
    </main>
  </section>
}
