import { useEffect, useMemo, useRef, useState } from 'react'
import type { ConsoleEvent, ConsoleServerOptions, DurableBacklog, DurableOptions } from './types'

type WinId = 'A' | 'B'
type Conn = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'error'
type Msg = { id: number; ts: number; type: string; channel: string; pattern?: string; payload: string; bytes: number; latency?: number; sid?: string; group?: string; redelivered?: boolean }
type LogLine = { id: number; ts: number; window: ConsoleEvent['window']; level: 'error' | 'info' | 'ok'; text: string }
type Result = { id: number; ts: number; text: string; reply: string; error: boolean; ms?: number }

const MAX_MESSAGES = 300
const MAX_LOG = 600

const defaultServers: ConsoleServerOptions = {
  snugA: true,
  snugB: true,
  redis: true,
  replica: false,
  sendAttempts: 5,
  sendTimeoutMs: 1000,
  queueSize: 1024,
}

function clock(ts: number) {
  const d = new Date(ts)
  return `${d.toLocaleTimeString([], { hour12: false })}.${String(d.getMilliseconds()).padStart(3, '0')}`
}

function describe(event: ConsoleEvent): { level: LogLine['level']; text: string } | null {
  switch (event.kind) {
    case 'error': return { level: 'error', text: event.message ?? 'error' }
    case 'info': return { level: 'info', text: event.message ?? '' }
    case 'status':
      return event.state === 'connected'
        ? { level: 'ok', text: `connected to ${event.addr}` }
        : { level: event.expected ? 'info' : 'error', text: `${event.state} ${event.addr ?? ''}`.trim() }
    case 'sub':
      if (event.state === 'subscribed') return { level: 'ok', text: `subscribed to ${event.name} (${event.count} active)` }
      if (event.state === 'unsubscribed') return { level: 'info', text: `unsubscribed from ${event.name}` }
      return { level: event.expected ? 'info' : 'error', text: `subscriber connection closed after ${event.received ?? 0} messages${event.expected ? '' : ' (not by you)'}` }
    case 'publish':
      return {
        level: event.errors ? 'error' : 'ok',
        text: event.durable
          ? `stored ${event.sent}${event.count && event.count > 1 ? ` of ${event.count}` : ''} on ${event.channel} (${event.stored ?? '?'} waiting) in ${event.ms} ms${event.firstError ? ` - ${event.firstError}` : ''}`
          : `published ${event.sent}${event.count && event.count > 1 ? ` of ${event.count}` : ''} to ${event.channel}: ${event.receivers} deliveries in ${event.ms} ms${event.firstError ? ` - ${event.firstError}` : ''}`,
      }
    default: return null
  }
}

export default function PubSubConsole() {
  const [servers, setServers] = useState<ConsoleServerOptions>(defaultServers)
  const [managed, setManaged] = useState<Record<string, string>>({})
  const [serverBusy, setServerBusy] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)
  const [conn, setConn] = useState<Record<WinId, Conn>>({ A: 'idle', B: 'idle' })
  const [subs, setSubs] = useState<Record<WinId, string[]>>({ A: [], B: [] })
  const [messages, setMessages] = useState<Record<WinId, Msg[]>>({ A: [], B: [] })
  const [received, setReceived] = useState<Record<WinId, number>>({ A: 0, B: 0 })
  const [acked, setAcked] = useState<Record<WinId, Record<string, true>>>({ A: {}, B: {} })
  const [log, setLog] = useState<LogLine[]>([])
  const [errorsOnly, setErrorsOnly] = useState(false)
  const pending = useRef<ConsoleEvent[]>([])
  const nextId = useRef(1)

  useEffect(() => {
    const off = window.snugBench.console.onEvent(event => { pending.current.push(event) })
    const timer = setInterval(() => {
      const batch = pending.current
      if (!batch.length) return
      pending.current = []
      const newMessages: Record<WinId, Msg[]> = { A: [], B: [] }
      const counts: Record<WinId, number> = { A: 0, B: 0 }
      const lines: LogLine[] = []
      const connUpdates: Partial<Record<WinId, Conn>> = {}
      const ackUpdates: Record<WinId, string[]> = { A: [], B: [] }
      const subUpdates: Partial<Record<WinId, (names: string[]) => string[]>> = {}
      for (const event of batch) {
        if (event.kind === 'message' && (event.window === 'A' || event.window === 'B')) {
          const stamp = /"t"\s*:\s*(\d{13})/.exec(event.payload ?? '')
          newMessages[event.window].push({
            id: nextId.current++, ts: event.ts, type: event.type ?? 'message', channel: event.channel ?? '', pattern: event.pattern,
            payload: event.payload ?? '', bytes: event.bytes ?? 0, latency: stamp ? event.ts - Number(stamp[1]) : undefined,
            sid: event.id, group: event.group, redelivered: event.redelivered,
          })
          counts[event.window]++
          continue
        }
        if (event.kind === 'durable-ack' && (event.window === 'A' || event.window === 'B')) {
          for (const sid of event.ids ?? []) ackUpdates[event.window].push(`${event.group}:${sid}`)
          continue
        }
        if (event.window === 'A' || event.window === 'B') {
          const w = event.window
          if (event.kind === 'status') connUpdates[w] = event.state === 'connected' ? 'connected' : event.expected ? 'disconnected' : 'error'
          if (event.kind === 'sub') {
            const prev = subUpdates[w]
            subUpdates[w] = names => {
              const base = prev ? prev(names) : names
              if (event.state === 'subscribed' && event.name && !base.includes(event.name)) return [...base, event.name]
              if (event.state === 'unsubscribed' && event.name) return base.filter(n => n !== event.name)
              if (event.state === 'closed') return []
              return base
            }
          }
        }
        const line = describe(event)
        if (line) lines.push({ id: nextId.current++, ts: event.ts, window: event.window, ...line })
      }
      if (connUpdates.A || connUpdates.B) setConn(prev => ({ A: connUpdates.A ?? prev.A, B: connUpdates.B ?? prev.B }))
      if (subUpdates.A || subUpdates.B) setSubs(prev => ({ A: subUpdates.A ? subUpdates.A(prev.A) : prev.A, B: subUpdates.B ? subUpdates.B(prev.B) : prev.B }))
      if (newMessages.A.length || newMessages.B.length) {
        setMessages(prev => ({
          A: newMessages.A.length ? [...prev.A, ...newMessages.A].slice(-MAX_MESSAGES) : prev.A,
          B: newMessages.B.length ? [...prev.B, ...newMessages.B].slice(-MAX_MESSAGES) : prev.B,
        }))
        setReceived(prev => ({ A: prev.A + counts.A, B: prev.B + counts.B }))
      }
      if (ackUpdates.A.length || ackUpdates.B.length) {
        setAcked(prev => ({
          A: ackUpdates.A.length ? { ...prev.A, ...Object.fromEntries(ackUpdates.A.map(k => [k, true as const])) } : prev.A,
          B: ackUpdates.B.length ? { ...prev.B, ...Object.fromEntries(ackUpdates.B.map(k => [k, true as const])) } : prev.B,
        }))
      }
      if (lines.length) setLog(prev => [...prev, ...lines].slice(-MAX_LOG))
    }, 100)
    return () => { off(); clearInterval(timer) }
  }, [])

  async function startServers() {
    setServerBusy(true)
    setServerError(null)
    try {
      setManaged(await window.snugBench.console.startServers(servers))
    } catch (err) {
      setServerError(err instanceof Error ? err.message : String(err))
    } finally {
      setServerBusy(false)
    }
  }

  async function stopServers() {
    setServerBusy(true)
    try { await window.snugBench.console.stopServers(); setManaged({}) } finally { setServerBusy(false) }
  }

  const setServer = <K extends keyof ConsoleServerOptions>(key: K, value: ConsoleServerOptions[K]) => setServers(prev => ({ ...prev, [key]: value }))
  const running = Object.keys(managed).length > 0
  const shownLog = useMemo(() => (errorsOnly ? log.filter(l => l.level === 'error') : log), [log, errorsOnly])
  const errorCount = useMemo(() => log.filter(l => l.level === 'error').length, [log])

  return (
    <section className="validation-lab rpc-lab psc">
      <div className="validation-main psc-main">
        <div className="validation-hero">
          <div>
            <span className="eyebrow">Live console</span>
            <h1>Publish in one window, receive in the other</h1>
            <p>Each window is its own client. Point them at the same server or at two different ones. Everything that goes wrong - refused connections, protocol errors, a server dropping a subscriber - shows up in the event log.</p>
          </div>
        </div>

        <div className="psc-servers">
          <div className="psc-servers-head">
            <strong>Test servers</strong>
            <span>Start throwaway servers on private ports, or type any address in a window below.</span>
          </div>
          <div className="psc-servers-body">
            <label className="psc-check"><input type="checkbox" checked={servers.snugA} disabled={serverBusy || running} onChange={e => setServer('snugA', e.target.checked)} /> SnugKV A <code>16391</code></label>
            <label className="psc-check"><input type="checkbox" checked={servers.snugB} disabled={serverBusy || running} onChange={e => setServer('snugB', e.target.checked)} /> SnugKV B <code>16392</code></label>
            <label className="psc-check"><input type="checkbox" checked={servers.redis} disabled={serverBusy || running} onChange={e => setServer('redis', e.target.checked)} /> Redis <code>16393</code></label>
            <label className="psc-check"><input type="checkbox" checked={servers.replica} disabled={serverBusy || running} onChange={e => setServer('replica', e.target.checked)} /> B replicates A</label>
            <label className="psc-num"><span>Attempts</span><input type="number" min={1} max={100} value={servers.sendAttempts} disabled={serverBusy || running} onChange={e => setServer('sendAttempts', Number(e.target.value))} /></label>
            <label className="psc-num"><span>Attempt ms</span><input type="number" min={1} max={60000} value={servers.sendTimeoutMs} disabled={serverBusy || running} onChange={e => setServer('sendTimeoutMs', Number(e.target.value))} /></label>
            <label className="psc-num"><span>Queue</span><input type="number" min={1} max={1048576} value={servers.queueSize} disabled={serverBusy || running} onChange={e => setServer('queueSize', Number(e.target.value))} /></label>
            {running
              ? <button className="secondary-stop" disabled={serverBusy} onClick={stopServers}>{serverBusy ? 'Stopping…' : 'Stop servers'}</button>
              : <button className="primary-run psc-start" disabled={serverBusy} onClick={startServers}><span className="play-icon">▶</span>{serverBusy ? 'Starting…' : 'Start servers'}</button>}
          </div>
          {running && (
            <div className="psc-chips">
              {Object.entries(managed).map(([key, addr]) => (
                <span key={key} className="psc-chip">{key === 'snugA' ? 'SnugKV A' : key === 'snugB' ? 'SnugKV B' : 'Redis'} · {addr}</span>
              ))}
            </div>
          )}
          {serverError && <div className="app-error-banner validation-error"><strong>Could not start</strong><span>{serverError}</span></div>}
          {servers.replica && <p className="rpc-note">With "B replicates A", B is read-only and copies A's data. PUBLISH on A does not reach subscribers connected to B.</p>}
        </div>

        <div className="psc-windows">
          {(['A', 'B'] as WinId[]).map(id => (
            <ConsoleWindow
              key={id}
              id={id}
              managed={managed}
              conn={conn[id]}
              setConn={state => setConn(prev => ({ ...prev, [id]: state }))}
              subs={subs[id]}
              messages={messages[id]}
              received={received[id]}
              acked={acked[id]}
              clearMessages={() => { setMessages(prev => ({ ...prev, [id]: [] })); setReceived(prev => ({ ...prev, [id]: 0 })) }}
              pushLog={(level, text) => setLog(prev => {
                const last = prev[prev.length - 1]
                if (last && last.window === id && last.text === text && Date.now() - last.ts < 1500) return prev
                return [...prev, { id: nextId.current++, ts: Date.now(), window: id, level, text }].slice(-MAX_LOG)
              })}
              defaultAddr={id === 'A' ? '127.0.0.1:16391' : '127.0.0.1:16392'}
            />
          ))}
        </div>

        <Backlog conn={conn} pushLog={(level, text) => setLog(prev => [...prev, { id: nextId.current++, ts: Date.now(), window: '*' as const, level, text }].slice(-MAX_LOG))} />

        <div className="validation-console psc-log">
          <div className="console-head">
            <div>
              <strong>Event log</strong>
              <span>{errorCount ? `${errorCount} error${errorCount === 1 ? '' : 's'}` : 'No errors'}</span>
            </div>
            <div className="psc-log-tools">
              <label className="psc-check"><input type="checkbox" checked={errorsOnly} onChange={e => setErrorsOnly(e.target.checked)} /> Errors only</label>
              <button className="validation-copy" onClick={() => setLog([])}>Clear</button>
            </div>
          </div>
          <div className="psc-log-body">
            {shownLog.length === 0 && <div className="psc-empty">Nothing yet.</div>}
            {shownLog.slice().reverse().map(line => (
              <div key={line.id} className={`psc-line ${line.level}`}>
                <time>{clock(line.ts)}</time>
                <b>{line.window === '*' ? 'server' : `window ${line.window}`}</b>
                <span>{line.text}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}

type WindowProps = {
  id: WinId
  managed: Record<string, string>
  conn: Conn
  setConn: (state: Conn) => void
  subs: string[]
  messages: Msg[]
  received: number
  acked: Record<string, true>
  clearMessages: () => void
  pushLog: (level: LogLine['level'], text: string) => void
  defaultAddr: string
}

function ConsoleWindow({ id, managed, conn, setConn, subs, messages, received, acked, clearMessages, pushLog, defaultAddr }: WindowProps) {
  const api = window.snugBench.console
  const [addr, setAddr] = useState(defaultAddr)
  const [channel, setChannel] = useState('news')
  const [body, setBody] = useState('{"n":{n},"t":{ts}}')
  const [count, setCount] = useState(1)
  const [mode, setMode] = useState<'channel' | 'pattern' | 'shard'>('channel')
  const [targets, setTargets] = useState('news')
  const [key, setKey] = useState('greeting')
  const [value, setValue] = useState('hello')
  const [ttl, setTtl] = useState(0)
  const [line, setLine] = useState('')
  const [results, setResults] = useState<Result[]>([])
  const [paused, setPaused] = useState(false)
  const [frozen, setFrozen] = useState<Msg[]>([])
  const [busy, setBusy] = useState(false)
  const [delivery, setDelivery] = useState<'live' | 'durable'>('live')
  const [subKind, setSubKind] = useState<'live' | 'durable'>('live')
  const [maxlen, setMaxlen] = useState(0)
  const [dMode, setDMode] = useState<'all' | 'one'>('all')
  const [dName, setDName] = useState(id === 'A' ? 'amy' : 'bob')
  const [dAck, setDAck] = useState<'auto' | 'manual'>('auto')
  const [dRedeliver, setDRedeliver] = useState(10)
  const nextResult = useRef(1)

  const connected = conn === 'connected'
  const shownMessages = paused ? frozen : messages
  const unacked = shownMessages.filter(m => m.sid && !acked[`${m.group}:${m.sid}`])
  const unackedCount = unacked.length
  const latencies = shownMessages.filter(m => m.latency !== undefined).map(m => m.latency as number)
  const avgLatency = latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : undefined

  function addResult(text: string, reply: string, error: boolean, ms?: number) {
    setResults(prev => [{ id: nextResult.current++, ts: Date.now(), text, reply, error, ms }, ...prev].slice(0, 40))
  }

  async function guard(action: () => Promise<void>, logError = true) {
    setBusy(true)
    try { await action() } catch (err) {
      const message = err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err)
      if (logError) pushLog('error', message)
      addResult('', message, true)
    } finally { setBusy(false) }
  }

  // The main process already reports connection failures as events, so do not log them twice.
  const connect = () => guard(async () => { setConn('connecting'); try { await api.connect(id, addr) } catch (err) { setConn('error'); throw err } }, false)
  const disconnect = () => guard(async () => { await api.disconnect(id); setConn('disconnected') })

  const run = (text: string) => guard(async () => {
    const res = await api.run(id, text)
    addResult(text, res.reply, res.error, res.ms)
    if (res.error) pushLog('error', `${text.split(' ')[0].toUpperCase()}: ${res.reply}`)
  })

  const publishDurable = () => guard(async () => {
    const res = await api.durablePublish(id, channel, body, count, maxlen)
    addResult(`STORE ${channel}${count > 1 ? ` x${count}` : ''}`, `${res.sent} stored, ${res.stored ?? '?'} waiting${res.errors ? `, error: ${res.firstError}` : ''}`, res.errors > 0, res.ms)
  })
  const durableOpts = (): DurableOptions => ({ topic: targets, mode: dMode, name: dName, ack: dAck, redeliverMs: dAck === 'manual' ? dRedeliver * 1000 : 0 })
  const subscribeDurable = () => guard(async () => { await api.durableSubscribe(id, durableOpts()); setSubKind('durable') })
  const pauseDurable = () => guard(async () => { await api.durableStop(id) })
  const ackIds = (list: Msg[]) => guard(async () => {
    const byGroup = new Map<string, string[]>()
    for (const m of list) if (m.sid && m.group) byGroup.set(m.group, [...(byGroup.get(m.group) ?? []), m.sid])
    for (const [group, ids] of byGroup) await api.durableAck(id, list[0].channel, group, ids)
  })
  const publish = () => guard(async () => {
    const res = await api.publish(id, channel, body, count)
    addResult(`PUBLISH ${channel}${count > 1 ? ` x${count}` : ''}`, `${res.receivers} deliveries${res.errors ? `, ${res.errors} error: ${res.firstError}` : ''}`, res.errors > 0, res.ms)
  })

  const subscribe = () => guard(async () => { await api.subscribe(id, mode, targets.split(',')); setSubKind('live') })
  const unsubscribe = () => guard(async () => { await api.unsubscribe(id) })

  const quote = (s: string) => (/[\s"']/.test(s) || s === '' ? `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : s)
  const options = Object.entries(managed)

  return (
    <div className={`psc-window ${conn}`}>
      <div className="psc-window-head">
        <h2>Window {id}</h2>
        <span className={`psc-state ${conn}`}><i />{conn === 'idle' ? 'not connected' : conn}</span>
      </div>

      <div className="psc-row">
        <input list={`psc-addrs-${id}`} value={addr} disabled={connected} onChange={e => setAddr(e.target.value)} placeholder="host:port" />
        <datalist id={`psc-addrs-${id}`}>
          {options.map(([k, a]) => <option key={k} value={a}>{k}</option>)}
        </datalist>
        {connected
          ? <button className="secondary-stop" disabled={busy} onClick={disconnect}>Disconnect</button>
          : <button className="primary-run psc-btn" disabled={busy || conn === 'connecting'} onClick={connect}>Connect</button>}
      </div>
      {options.length > 0 && !connected && (
        <div className="psc-chips">
          {options.map(([k, a]) => <button key={k} className="psc-chip" onClick={() => setAddr(a)}>{k === 'snugA' ? 'SnugKV A' : k === 'snugB' ? 'SnugKV B' : 'Redis'}</button>)}
        </div>
      )}

      <div className="psc-seg" role="tablist">
        <button className={delivery === 'live' ? 'active' : ''} onClick={() => setDelivery('live')} title="Plain Pub/Sub: only subscribers connected right now receive it">Live</button>
        <button className={delivery === 'durable' ? 'active' : ''} onClick={() => setDelivery('durable')} title="Kept on the server until subscribers have received and acknowledged it">Stored until delivered</button>
      </div>

      <fieldset className="psc-box" disabled={!connected}>
        <legend>{delivery === 'live' ? 'Publish' : 'Publish and store'}</legend>
        <div className="psc-row">
          <input value={channel} onChange={e => setChannel(e.target.value)} placeholder={delivery === 'live' ? 'channel' : 'topic'} />
          <input className="psc-count" type="number" min={1} max={100000} value={count} onChange={e => setCount(Number(e.target.value))} title="Number of messages" />
        </div>
        <textarea rows={2} value={body} onChange={e => setBody(e.target.value)} placeholder="message; {n} = sequence number, {ts} = time" />
        <div className="psc-row">
          {delivery === 'durable' && <input className="psc-count" type="number" min={0} value={maxlen} onChange={e => setMaxlen(Number(e.target.value))} title="Keep at most this many waiting messages, 0 = no limit" />}
          <button className="primary-run psc-btn" disabled={busy} onClick={delivery === 'live' ? publish : publishDurable}>{delivery === 'live' ? 'Publish' : 'Store'}{count > 1 ? ` ×${count}` : ''}</button>
          <small>{'{n}'} is replaced by the message number and {'{ts}'} by the send time, so the other window can show latency.</small>
        </div>
      </fieldset>

      <fieldset className="psc-box" disabled={!connected}>
        <legend>{delivery === 'live' ? 'Subscribe' : 'Receive stored messages'}</legend>
        {delivery === 'live' ? (
          <div className="psc-row">
            <select value={mode} onChange={e => setMode(e.target.value as typeof mode)}>
              <option value="channel">SUBSCRIBE</option>
              <option value="pattern">PSUBSCRIBE</option>
              <option value="shard">SSUBSCRIBE</option>
            </select>
            <input value={targets} onChange={e => setTargets(e.target.value)} placeholder="channels, comma separated" />
            {subs.length > 0
              ? <button className="secondary-stop" disabled={busy} onClick={subKind === 'live' ? unsubscribe : pauseDurable}>Stop</button>
              : <button className="primary-run psc-btn" disabled={busy} onClick={subscribe}>Subscribe</button>}
          </div>
        ) : (
          <>
            <div className="psc-row">
              <input value={targets} onChange={e => setTargets(e.target.value)} placeholder="topic" />
              <input value={dName} onChange={e => setDName(e.target.value)} placeholder="subscriber name" title="Name of this subscriber. Messages it has not read wait for it under this name." />
              {subs.length > 0
                ? <button className="secondary-stop" disabled={busy} onClick={subKind === 'durable' ? pauseDurable : unsubscribe}>Pause</button>
                : <button className="primary-run psc-btn" disabled={busy} onClick={subscribeDurable}>Start</button>}
            </div>
            <div className="psc-row">
              <select value={dMode} onChange={e => setDMode(e.target.value as 'all' | 'one')} title="Who has to receive a message before it counts as delivered">
                <option value="all">Every subscriber gets it</option>
                <option value="one">Only one subscriber gets it</option>
              </select>
              <select value={dAck} onChange={e => setDAck(e.target.value as 'auto' | 'manual')} title="Auto confirms on arrival. Manual waits for your Ack button.">
                <option value="auto">Auto acknowledge</option>
                <option value="manual">Acknowledge by hand</option>
              </select>
              {dAck === 'manual' && <input className="psc-count" type="number" min={0} value={dRedeliver} onChange={e => setDRedeliver(Number(e.target.value))} title="Send again after this many seconds without an acknowledgement, 0 = never" />}
            </div>
          </>
        )}
        <div className="psc-sub-state">
          {subs.length > 0 ? <>Listening on {subs.map(s => <code key={s}>{s}</code>)}</> : 'Not subscribed.'}
        </div>
        <div className="psc-feed-head">
          <span><b>{received.toLocaleString()}</b> received{avgLatency !== undefined && <> · avg latency <b>{avgLatency.toFixed(1)} ms</b></>}</span>
          <span>
            {unackedCount > 0 && <button className="psc-link" onClick={() => ackIds(unacked)}>Ack all ({unackedCount})</button>}
            <button className="psc-link" onClick={() => { if (!paused) setFrozen(messages); setPaused(!paused) }}>{paused ? 'Resume' : 'Pause'}</button>
            <button className="psc-link" onClick={clearMessages}>Clear</button>
          </span>
        </div>
        <div className="psc-feed">
          {shownMessages.length === 0 && <div className="psc-empty">Messages appear here.</div>}
          {shownMessages.slice().reverse().map(m => (
            <div key={m.id} className="psc-msg">
              <time>{clock(m.ts)}</time>
              <code>{m.pattern ? `${m.pattern} → ${m.channel}` : m.sid ? `${m.channel} · ${m.sid}` : m.channel}</code>
              <span className="psc-payload">{m.payload}</span>
              <small>
                {m.redelivered && <em className="psc-badge warn">again</em>}
                {m.sid && (acked[`${m.group}:${m.sid}`]
                  ? <em className="psc-badge ok">acked</em>
                  : <button className="psc-ack" onClick={() => ackIds([m])}>Ack</button>)}
                {m.latency !== undefined ? `${m.latency} ms · ` : ''}{m.bytes} B
              </small>
            </div>
          ))}
        </div>
      </fieldset>

      <fieldset className="psc-box" disabled={!connected}>
        <legend>Data</legend>
        <div className="psc-row">
          <input value={key} onChange={e => setKey(e.target.value)} placeholder="key" />
          <input value={value} onChange={e => setValue(e.target.value)} placeholder="value" />
          <input className="psc-count" type="number" min={0} value={ttl} onChange={e => setTtl(Number(e.target.value))} title="Seconds to live, 0 = none" />
        </div>
        <div className="psc-row">
          <button className="validation-copy" disabled={busy} onClick={() => run(`SET ${quote(key)} ${quote(value)}${ttl > 0 ? ` EX ${ttl}` : ''}`)}>SET</button>
          <button className="validation-copy" disabled={busy} onClick={() => run(`GET ${quote(key)}`)}>GET</button>
          <button className="validation-copy" disabled={busy} onClick={() => run(`DEL ${quote(key)}`)}>DEL</button>
          <button className="validation-copy" disabled={busy} onClick={() => run(`TTL ${quote(key)}`)}>TTL</button>
          <button className="validation-copy" disabled={busy} onClick={() => run('INFO replication')}>Role</button>
        </div>
        <form className="psc-row" onSubmit={e => { e.preventDefault(); if (line.trim()) { run(line.trim()); setLine('') } }}>
          <input value={line} onChange={e => setLine(e.target.value)} placeholder='any command, e.g. LPUSH jobs "a b"' />
          <button className="validation-copy" disabled={busy || !line.trim()}>Run</button>
        </form>
        <div className="psc-results">
          {results.length === 0 && <div className="psc-empty">Replies appear here.</div>}
          {results.map(r => (
            <div key={r.id} className={`psc-result ${r.error ? 'error' : ''}`}>
              <div><time>{clock(r.ts)}</time>{r.text && <code>{r.text}</code>}{r.ms !== undefined && <small>{r.ms.toFixed(2)} ms</small>}</div>
              <pre>{r.reply}</pre>
            </div>
          ))}
        </div>
      </fieldset>
    </div>
  )
}

function Backlog({ conn, pushLog }: { conn: Record<WinId, Conn>; pushLog: (level: LogLine['level'], text: string) => void }) {
  const api = window.snugBench.console
  const [topic, setTopic] = useState('news')
  const [auto, setAuto] = useState(true)
  const [data, setData] = useState<DurableBacklog | null>(null)
  const [error, setError] = useState<string | null>(null)
  const via: WinId | null = conn.A === 'connected' ? 'A' : conn.B === 'connected' ? 'B' : null

  async function refresh() {
    if (!via || !topic.trim()) return
    try {
      setData(await api.durableBacklog(via, topic.trim()))
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err))
    }
  }

  useEffect(() => {
    void refresh()
    if (!auto) return
    const timer = setInterval(() => { void refresh() }, 1000)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [via, topic, auto])

  async function remove(group: string) {
    if (!via) return
    try {
      await api.durableDestroyGroup(via, topic.trim(), group)
      await refresh()
    } catch (err) {
      pushLog('error', err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="psc-backlog">
      <div className="psc-backlog-head">
        <div>
          <strong>Stored messages</strong>
          <span>Messages kept on the server until every subscriber has acknowledged them.</span>
        </div>
        <div className="psc-log-tools">
          <input value={topic} onChange={e => setTopic(e.target.value)} placeholder="topic" />
          <label className="psc-check"><input type="checkbox" checked={auto} onChange={e => setAuto(e.target.checked)} /> Live</label>
          <button className="validation-copy" disabled={!via} onClick={() => void refresh()}>Refresh</button>
        </div>
      </div>
      {!via && <div className="psc-empty">Connect a window to see stored messages.</div>}
      {via && error && <div className="psc-line error"><span>{error}</span></div>}
      {via && !error && data && (
        <div className="psc-backlog-body">
          <div className="psc-stat"><b>{data.stored.toLocaleString()}</b><span>waiting on {data.topic}</span></div>
          {data.groups.length === 0 ? (
            <p className="psc-empty">No subscriber has joined this topic yet. Messages wait until one does.</p>
          ) : (
            <table className="rpc-table">
              <thead><tr><th>Subscriber group</th><th>Connected</th><th>Waiting for it</th><th>Read, not acknowledged</th><th /></tr></thead>
              <tbody>
                {data.groups.map(g => (
                  <tr key={g.name}>
                    <td>{g.name === 'shared' ? 'shared (one gets each)' : g.name.replace(/^sub:/, '')}</td>
                    <td>{g.consumers}</td>
                    <td>{g.lag === null ? '—' : g.lag.toLocaleString()}</td>
                    <td>{g.pending.toLocaleString()}</td>
                    <td><button className="psc-link" onClick={() => void remove(g.name)} title="Forget this subscriber. Messages it was holding back are released.">Remove</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  )
}
