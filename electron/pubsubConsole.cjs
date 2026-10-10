'use strict'

// Live Pub/Sub console: a small RESP client per "window" (A and B), each with a
// command connection and, when subscribed, a separate subscriber connection,
// plus optional managed test servers. Everything is reported as events so the
// UI can show errors as they happen. No Electron dependency.

const net = require('node:net')
const { spawn } = require('node:child_process')
const { join } = require('node:path')
const { mkdirSync } = require('node:fs')

const MANAGED = {
  snugA: { label: 'SnugKV A', port: 16391 },
  snugB: { label: 'SnugKV B', port: 16392 },
  redis: { label: 'Redis', port: 16393 },
}

class RespError extends Error {}

// Incremental RESP2/RESP3 parser. push(chunk) returns the complete values.
class Parser {
  constructor() { this.buf = Buffer.alloc(0) }
  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk
    const out = []
    for (;;) {
      const parsed = this.parse(0)
      if (!parsed) break
      this.buf = this.buf.subarray(parsed.end)
      out.push(parsed.value)
    }
    return out
  }
  line(at) {
    const i = this.buf.indexOf('\r\n', at)
    return i < 0 ? null : { text: this.buf.toString('utf8', at, i), end: i + 2 }
  }
  parse(at, depth = 0) {
    if (at >= this.buf.length) return null
    if (depth > 16) throw new Error('reply nested too deeply')
    const type = String.fromCharCode(this.buf[at])
    const l = this.line(at + 1)
    if (!l) return null
    switch (type) {
      case '+': return { value: l.text, end: l.end }
      case '-': return { value: new RespError(l.text), end: l.end }
      case ':': return { value: Number(l.text), end: l.end }
      case '_': return { value: null, end: l.end }
      case '#': return { value: l.text === 't', end: l.end }
      case ',': return { value: Number(l.text), end: l.end }
      case '$': case '=': {
        const n = Number(l.text)
        if (n < 0) return { value: null, end: l.end }
        if (this.buf.length < l.end + n + 2) return null
        let text = this.buf.toString('utf8', l.end, l.end + n)
        if (type === '=') text = text.slice(4)
        return { value: text, end: l.end + n + 2 }
      }
      case '*': case '~': case '>': {
        const n = Number(l.text)
        if (n < 0) return { value: null, end: l.end }
        const items = []
        let pos = l.end
        for (let i = 0; i < n; i++) {
          const item = this.parse(pos, depth + 1)
          if (!item) return null
          items.push(item.value)
          pos = item.end
        }
        return { value: items, end: pos }
      }
      case '%': {
        const n = Number(l.text)
        const items = []
        let pos = l.end
        for (let i = 0; i < n * 2; i++) {
          const item = this.parse(pos, depth + 1)
          if (!item) return null
          items.push(item.value)
          pos = item.end
        }
        return { value: items, end: pos }
      }
      default:
        throw new Error(`unexpected reply type ${JSON.stringify(type)}`)
    }
  }
}

function encode(args) {
  const parts = [`*${args.length}\r\n`]
  for (const arg of args) {
    const s = String(arg)
    parts.push(`$${Buffer.byteLength(s)}\r\n${s}\r\n`)
  }
  return parts.join('')
}

// Splits a command line like: SET key "hello world"
function splitCommand(text) {
  const out = []
  let current = ''
  let quote = null
  let has = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quote) {
      if (c === '\\' && i + 1 < text.length) { current += text[++i] } else if (c === quote) quote = null
      else current += c
    } else if (c === '"' || c === "'") { quote = c; has = true } else if (/\s/.test(c)) {
      if (current || has) { out.push(current); current = ''; has = false }
    } else current += c
  }
  if (quote) throw new Error('unterminated quote')
  if (current || has) out.push(current)
  return out
}

function printable(value) {
  if (value instanceof RespError) return value.message
  if (value === null) return '(nil)'
  if (Array.isArray(value)) return value.map(v => (Array.isArray(v) ? `[${printable(v)}]` : printable(v))).join('\n')
  return String(value)
}

class Window {
  constructor(id, emit) {
    this.id = id
    this.emit = emit
    this.addr = null
    this.cmd = null
    this.sub = null
    this.queue = []
    this.userClosed = true
    this.subscribed = null
    this.received = 0
  }
  event(kind, data = {}) { this.emit({ window: this.id, ts: Date.now(), kind, ...data }) }

  parseAddr(addr) {
    const m = /^(?:redis:\/\/)?\[?([^\]\s]+?)\]?:(\d{1,5})$/.exec(String(addr).trim())
    if (!m) throw new Error(`"${addr}" is not host:port`)
    return { host: m[1], port: Number(m[2]) }
  }

  connect(addr) {
    this.disconnect()
    this.userClosed = false
    return this.open(addr)
  }

  // Opens the command connection without touching an active subscription.
  open(addr) {
    return new Promise((resolve, reject) => {
      let target
      try { target = this.parseAddr(addr) } catch (error) { this.event('error', { message: error.message }); return reject(error) }
      this.addr = `${target.host}:${target.port}`
      const socket = net.createConnection(target)
      const parser = new Parser()
      this.cmd = socket
      socket.setNoDelay(true)
      socket.setTimeout(5000)
      let opened = false
      socket.once('connect', () => {
        opened = true
        socket.setTimeout(0)
        this.event('status', { state: 'connected', addr: this.addr })
        resolve()
      })
      socket.on('data', chunk => {
        let values
        try { values = parser.push(chunk) } catch (error) {
          this.event('error', { message: `protocol error from ${this.addr}: ${error.message}` })
          socket.destroy()
          return
        }
        for (const value of values) {
          const waiter = this.queue.shift()
          if (waiter) waiter.resolve(value)
        }
      })
      const failAll = error => { for (const w of this.queue.splice(0)) w.reject(error) }
      socket.on('timeout', () => socket.destroy(new Error(`timed out connecting to ${this.addr}`)))
      socket.on('error', error => {
        const message = error.code === 'ECONNREFUSED' ? `connection refused by ${this.addr}` : error.message
        this.event('error', { message })
        failAll(new Error(message))
        if (!opened) reject(new Error(message))
      })
      socket.on('close', () => {
        failAll(new Error('connection closed'))
        if (this.cmd === socket) this.cmd = null
        if (opened) {
          if (socket.expectedClose) this.event('status', { state: 'disconnected', addr: this.addr, expected: true })
          else this.event('info', { message: `${this.addr} closed the idle command connection; it reconnects on the next command` })
        }
      })
    })
  }

  disconnect() {
    this.userClosed = true
    this.unsubscribe(true)
    if (this.cmd) { this.cmd.expectedClose = true; this.cmd.destroy() }
    this.cmd = null
  }

  async command(args) {
    // Servers close idle command connections (SnugKV after 30 s by default), so
    // reopen once instead of failing the user's next click.
    if ((!this.cmd || this.cmd.destroyed) && this.addr && !this.userClosed) {
      this.event('info', { message: `reconnecting to ${this.addr}` })
      await this.open(this.addr)
    }
    return this.send(args)
  }

  send(args) {
    return new Promise((resolve, reject) => {
      if (!this.cmd || this.cmd.destroyed) return reject(new Error('not connected'))
      const started = process.hrtime.bigint()
      this.queue.push({
        resolve: value => resolve({ reply: printable(value), error: value instanceof RespError, ms: Number(process.hrtime.bigint() - started) / 1e6, raw: value instanceof RespError ? null : value }),
        reject,
      })
      this.cmd.write(encode(args))
    })
  }

  // Opens a dedicated subscriber connection.
  subscribe(kind, targets) {
    return new Promise((resolve, reject) => {
      if (!this.addr) return reject(new Error('connect first'))
      this.unsubscribe(true)
      const names = targets.map(t => t.trim()).filter(Boolean)
      if (!names.length) return reject(new Error('enter at least one channel'))
      const verb = kind === 'pattern' ? 'PSUBSCRIBE' : kind === 'shard' ? 'SSUBSCRIBE' : 'SUBSCRIBE'
      const target = this.parseAddr(this.addr)
      const socket = net.createConnection(target)
      const parser = new Parser()
      this.sub = socket
      this.subscribed = { kind, names }
      this.received = 0
      let confirmed = 0
      socket.setNoDelay(true)
      socket.once('connect', () => socket.write(encode([verb, ...names])))
      socket.on('data', chunk => {
        let values
        try { values = parser.push(chunk) } catch (error) {
          this.event('error', { message: `subscriber protocol error: ${error.message}` })
          socket.destroy()
          return
        }
        for (const value of values) {
          if (value instanceof RespError) {
            this.event('error', { message: `${verb}: ${value.message}` })
            if (confirmed === 0) { this.unsubscribe(true); reject(new Error(value.message)) }
            continue
          }
          if (!Array.isArray(value)) continue
          const type = value[0]
          if (type === 'subscribe' || type === 'psubscribe' || type === 'ssubscribe') {
            confirmed++
            this.event('sub', { state: 'subscribed', name: value[1], count: value[2] })
            if (confirmed === names.length) resolve()
          } else if (type === 'unsubscribe' || type === 'punsubscribe' || type === 'sunsubscribe') {
            this.event('sub', { state: 'unsubscribed', name: value[1], count: value[2] })
          } else if (type === 'message' || type === 'smessage') {
            this.received++
            this.event('message', { type, channel: value[1], payload: value[2], bytes: Buffer.byteLength(String(value[2])) })
          } else if (type === 'pmessage') {
            this.received++
            this.event('message', { type, pattern: value[1], channel: value[2], payload: value[3], bytes: Buffer.byteLength(String(value[3])) })
          }
        }
      })
      socket.on('error', error => {
        const message = error.code === 'ECONNREFUSED' ? `connection refused by ${this.addr}` : error.message
        this.event('error', { message: `subscriber: ${message}` })
        if (confirmed === 0) reject(new Error(message))
      })
      socket.on('close', () => {
        const wanted = Boolean(socket.expectedClose)
        if (this.sub === socket) { this.sub = null; this.subscribed = null }
        this.event('sub', { state: 'closed', expected: wanted, received: this.received })
        if (!wanted) this.event('error', { message: `${this.addr} closed the subscriber connection after ${this.received} messages. If you did not stop it, the server disconnected this subscriber.` })
      })
    })
  }

  unsubscribe(silent = false) {
    if (!this.sub) return
    this.sub.expectedClose = true
    this.sub.destroy()
    this.sub = null
    if (!silent) this.subscribed = null
  }
}

class Console {
  constructor(emit) {
    this.emit = emit
    this.windows = { A: new Window('A', emit), B: new Window('B', emit) }
    this.children = new Set()
    this.managed = {}
    this.stopping = false
  }
  win(id) {
    const w = this.windows[id]
    if (!w) throw new Error(`unknown window ${id}`)
    return w
  }

  async runLine(id, line) {
    const args = splitCommand(String(line))
    if (!args.length) throw new Error('empty command')
    return this.win(id).command(args)
  }

  // PUBLISH `count` times. {n} in the message becomes the sequence number and {ts} the time.
  async publish(id, channel, message, count) {
    const w = this.win(id)
    const total = Math.max(1, Math.min(100000, Math.round(Number(count) || 1)))
    const started = Date.now()
    let receivers = 0
    let errors = 0
    let firstError = null
    let sent = 0
    for (let i = 1; i <= total; i++) {
      const body = String(message).replaceAll('{n}', String(i)).replaceAll('{ts}', String(Date.now()))
      let res
      try { res = await w.command(['PUBLISH', channel, body]) } catch (error) {
        errors++
        firstError = firstError || error.message
        break
      }
      sent++
      if (res.error) { errors++; firstError = firstError || res.reply; if (total > 1) break } else receivers += Number(res.raw) || 0
    }
    const result = { sent, receivers, errors, firstError, ms: Date.now() - started }
    w.event('publish', { channel, count: total, ...result })
    if (firstError) w.event('error', { message: `PUBLISH ${channel}: ${firstError}` })
    return result
  }

  async startServers(opts, ctx) {
    await this.stopServers()
    const wanted = ['snugA', 'snugB', 'redis'].filter(k => opts[k])
    if (!wanted.length) throw new Error('select at least one server')
    const log = text => this.emit({ window: '*', ts: Date.now(), kind: 'info', message: text })
    let snug = null
    if (wanted.some(k => k.startsWith('snug'))) {
      log('Building SnugKV…')
      snug = await this.build(ctx, 'snugkv', './cmd/snugkv')
    }
    for (const key of wanted) {
      const { label, port } = MANAGED[key]
      const args = key === 'redis'
        ? ['--bind', '127.0.0.1', '--port', String(port), '--save', '', '--appendonly', 'no', '--protected-mode', 'no']
        : ['-listen', `127.0.0.1:${port}`, '-admin-listen', '',
          '-pubsub-send-attempts', String(opts.sendAttempts || 5),
          '-pubsub-send-timeout-ms', String(opts.sendTimeoutMs || 1000),
          '-pubsub-queue-size', String(opts.queueSize || 1024)]
      const command = key === 'redis' ? ctx.redisServer : snug
      const logs = []
      const child = spawn(command, args, { cwd: ctx.repo, env: ctx.env, stdio: ['ignore', 'pipe', 'pipe'] })
      this.children.add(child)
      child.stderr.on('data', c => { logs.push(c.toString()); if (logs.length > 30) logs.shift() })
      child.stdout.on('data', c => { logs.push(c.toString()); if (logs.length > 30) logs.shift() })
      child.once('exit', code => {
        this.children.delete(child)
        if (this.stopping) return this.emit({ window: '*', ts: Date.now(), kind: 'info', message: `${label} stopped` })
        this.emit({ window: '*', ts: Date.now(), kind: 'error', message: `${label} stopped unexpectedly (exit ${code})${logs.length ? `: ${logs.join('').trim().slice(-300)}` : ''}` })
      })
      child.once('error', error => this.emit({ window: '*', ts: Date.now(), kind: 'error', message: `${label}: ${error.message}` }))
      await waitForPort(port, child, logs)
      this.managed[key] = { child, port }
      log(`${label} listening on 127.0.0.1:${port}`)
    }
    if (opts.replica && this.managed.snugA && this.managed.snugB) {
      const probe = new Window('S', () => {})
      await probe.connect(`127.0.0.1:${MANAGED.snugB.port}`)
      const res = await probe.command(['REPLICAOF', '127.0.0.1', String(MANAGED.snugA.port)])
      probe.disconnect()
      log(`SnugKV B is now a replica of A: ${res.reply}`)
    }
    return Object.fromEntries(Object.entries(this.managed).map(([k, v]) => [k, `127.0.0.1:${v.port}`]))
  }

  build(ctx, name, pkg) {
    return new Promise((resolve, reject) => {
      mkdirSync(ctx.binDir, { recursive: true })
      const out = join(ctx.binDir, process.platform === 'win32' ? `${name}.exe` : name)
      const child = spawn(ctx.go, ['build', '-o', out, pkg], { cwd: ctx.repo, env: ctx.env, stdio: ['ignore', 'pipe', 'pipe'] })
      this.children.add(child)
      let output = ''
      child.stdout.on('data', c => { output += c })
      child.stderr.on('data', c => { output += c })
      child.once('error', reject)
      child.once('close', code => {
        this.children.delete(child)
        if (code === 0) resolve(out)
        else reject(new Error(`go build ${pkg} failed: ${output.trim()}`))
      })
    })
  }

  async stopServers() {
    this.stopping = true
    const ports = new Set(Object.values(this.managed).map(m => String(m.port)))
    for (const w of Object.values(this.windows)) {
      if (w.addr && ports.has(w.addr.split(':').pop())) {
        if (w.sub) w.sub.expectedClose = true
        if (w.cmd) w.cmd.expectedClose = true
      }
    }
    for (const child of [...this.children]) { try { child.kill('SIGTERM') } catch { /* gone */ } }
    const deadline = Date.now() + 3000
    while (this.children.size && Date.now() < deadline) await new Promise(r => setTimeout(r, 50))
    for (const child of [...this.children]) { try { child.kill('SIGKILL') } catch { /* gone */ } }
    this.managed = {}
    this.stopping = false
  }

  async closeAll() {
    for (const w of Object.values(this.windows)) w.disconnect()
    await this.stopServers()
  }
}

function waitForPort(port, child, logs, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs
    let exited = false
    child.once('exit', () => { exited = true })
    const attempt = () => {
      if (exited) return reject(new Error(`server exited before listening on ${port}\n${logs.join('').trim()}`))
      const socket = net.createConnection({ host: '127.0.0.1', port })
      socket.setTimeout(500)
      const fail = () => {
        socket.destroy()
        if (Date.now() >= deadline) reject(new Error(`timed out waiting for port ${port}\n${logs.join('').trim()}`))
        else setTimeout(attempt, 100)
      }
      socket.once('connect', () => { socket.end(); resolve() })
      socket.once('error', fail)
      socket.once('timeout', fail)
    }
    attempt()
  })
}

module.exports = { Console, Parser, splitCommand, encode, MANAGED }
