'use strict'

// Durable delivery on top of Redis Streams, for the Pub/Sub console.
//
// A topic is the stream `durable:<topic>`. Publishing is XADD, so a message
// waits in the stream when nobody is listening. Every subscriber reads through
// a consumer group:
//   - "all":  each subscriber has its own group, so each gets every message
//   - "one":  subscribers share the group `shared` and split the messages
// A message is complete once every group has acknowledged it. Complete messages
// are removed with XTRIM MINID. A message nobody has read yet protects itself:
// a group that has not read it holds the boundary back.

const net = require('node:net')

class RespError extends Error {}

class Parser {
  constructor() { this.buf = Buffer.alloc(0) }
  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk
    const out = []
    for (;;) {
      const parsed = this.parse(0, 0)
      if (!parsed) break
      this.buf = this.buf.subarray(parsed.end)
      out.push(parsed.value)
    }
    return out
  }
  parse(at, depth) {
    if (at >= this.buf.length) return null
    if (depth > 16) throw new Error('reply nested too deeply')
    const i = this.buf.indexOf('\r\n', at)
    if (i < 0) return null
    const type = String.fromCharCode(this.buf[at])
    const text = this.buf.toString('utf8', at + 1, i)
    const end = i + 2
    switch (type) {
      case '+': return { value: text, end }
      case '-': return { value: new RespError(text), end }
      case ':': case ',': return { value: Number(text), end }
      case '_': return { value: null, end }
      case '#': return { value: text === 't', end }
      case '$': case '=': {
        const n = Number(text)
        if (n < 0) return { value: null, end }
        if (this.buf.length < end + n + 2) return null
        let s = this.buf.toString('utf8', end, end + n)
        if (type === '=') s = s.slice(4)
        return { value: s, end: end + n + 2 }
      }
      case '*': case '~': case '>': case '%': {
        const n = Number(text) * (type === '%' ? 2 : 1)
        if (n < 0 || Number.isNaN(n)) return { value: null, end }
        const items = []
        let pos = end
        for (let k = 0; k < n; k++) {
          const item = this.parse(pos, depth + 1)
          if (!item) return null
          items.push(item.value)
          pos = item.end
        }
        return { value: items, end: pos }
      }
      default: throw new Error(`unexpected reply type ${JSON.stringify(type)}`)
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

// A small sequential client: one command at a time, replies matched in order.
class Client {
  constructor(addr) {
    const m = /^\[?([^\]\s]+?)\]?:(\d{1,5})$/.exec(String(addr).trim())
    if (!m) throw new Error(`"${addr}" is not host:port`)
    this.target = { host: m[1], port: Number(m[2]) }
    this.queue = []
    this.closed = false
  }
  open() {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.target)
      const parser = new Parser()
      this.socket = socket
      socket.setNoDelay(true)
      socket.setTimeout(5000)
      let opened = false
      socket.once('connect', () => { opened = true; socket.setTimeout(0); resolve() })
      socket.on('timeout', () => socket.destroy(new Error('connection timed out')))
      socket.on('data', chunk => {
        let values
        try { values = parser.push(chunk) } catch (error) { socket.destroy(error); return }
        for (const value of values) this.queue.shift()?.resolve(value)
      })
      socket.on('error', error => {
        const message = error.code === 'ECONNREFUSED' ? `connection refused by ${this.target.host}:${this.target.port}` : error.message
        for (const w of this.queue.splice(0)) w.reject(new Error(message))
        if (!opened) reject(new Error(message))
      })
      socket.on('close', () => {
        this.closed = true
        for (const w of this.queue.splice(0)) w.reject(new Error('connection closed'))
      })
    })
  }
  call(args) {
    return new Promise((resolve, reject) => {
      if (this.closed || !this.socket) return reject(new Error('connection closed'))
      this.queue.push({ resolve, reject })
      this.socket.write(encode(args))
    })
  }
  // Like call, but a server error reply throws.
  async must(args) {
    const value = await this.call(args)
    if (value instanceof RespError) throw new Error(`${args[0]}: ${value.message}`)
    return value
  }
  close() { this.closed = true; this.socket?.destroy() }
}

const streamKey = topic => `durable:${topic}`

// ---- stream ids ----
function parseId(id) {
  const [ms, seq] = String(id).split('-')
  return [BigInt(ms || 0), BigInt(seq || 0)]
}
function compareIds(a, b) {
  const [am, as] = parseId(a)
  const [bm, bs] = parseId(b)
  return am === bm ? (as === bs ? 0 : as < bs ? -1 : 1) : am < bm ? -1 : 1
}
function nextId(id) {
  const [ms, seq] = parseId(id)
  return `${ms}-${seq + 1n}`
}

function toMap(flat) {
  const out = {}
  if (!Array.isArray(flat)) return out
  for (let i = 0; i + 1 < flat.length; i += 2) out[String(flat[i])] = flat[i + 1]
  return out
}

async function listGroups(client, topic) {
  const reply = await client.call(['XINFO', 'GROUPS', streamKey(topic)])
  if (reply instanceof RespError) {
    if (/no such key/i.test(reply.message)) return []
    throw new Error(`XINFO GROUPS: ${reply.message}`)
  }
  return (reply || []).map(entry => {
    const g = toMap(entry)
    return {
      name: String(g.name),
      consumers: Number(g.consumers ?? 0),
      pending: Number(g.pending ?? 0),
      lastDelivered: String(g['last-delivered-id'] ?? '0-0'),
      lag: g.lag === null || g.lag === undefined ? null : Number(g.lag),
    }
  })
}

/**
 * Removes the messages every group has acknowledged. Returns how many went.
 * A group holds the boundary at its oldest unacknowledged message, or just
 * after the last message it has read when nothing is pending.
 */
async function finalize(client, topic) {
  const groups = await listGroups(client, topic)
  if (!groups.length) return 0
  let boundary = null
  for (const g of groups) {
    let limit
    if (g.pending > 0) {
      const summary = await client.must(['XPENDING', streamKey(topic), g.name])
      limit = summary && summary[1] ? String(summary[1]) : nextId(g.lastDelivered)
    } else {
      limit = nextId(g.lastDelivered)
    }
    if (boundary === null || compareIds(limit, boundary) < 0) boundary = limit
  }
  const removed = await client.must(['XTRIM', streamKey(topic), 'MINID', boundary])
  return Number(removed) || 0
}

async function backlog(client, topic) {
  const key = streamKey(topic)
  const stored = Number(await client.must(['XLEN', key])) || 0
  const groups = await listGroups(client, topic)
  return { topic, stored, groups }
}

module.exports = { Client, RespError, streamKey, toMap, listGroups, finalize, backlog, compareIds, nextId }
