// Example data generators for the Database screen. The preview shown in the UI is
// the first record produced by these same generators, so what you see is what is written.

export type SampleKind = 'string' | 'counter' | 'hash' | 'list' | 'set' | 'zset' | 'json'

export type Sample = {
  kind: SampleKind
  label: string
  models: string
  defaultPrefix: string
  build: (key: string, i: number) => string[][]
}

function rng(seed: number) {
  let a = (seed + 0x6d2b79f5) >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const first = ['Ada', 'Linus', 'Grace', 'Alan', 'Margaret', 'Dennis', 'Barbara', 'Ken', 'Radia', 'Edsger', 'Hedy', 'Tim']
const last = ['Lovelace', 'Torvalds', 'Hopper', 'Turing', 'Hamilton', 'Ritchie', 'Liskov', 'Thompson', 'Perlman', 'Dijkstra', 'Lamarr', 'Berners']
const roles = ['engineer', 'designer', 'analyst', 'manager', 'support', 'admin']
const countries = ['LV', 'RW', 'DE', 'US', 'KE', 'FR', 'JP', 'BR']
const tags = ['cache', 'session', 'billing', 'beta', 'mobile', 'eu', 'vip', 'trial', 'api', 'internal', 'eu-west', 'promo', 'newsletter', 'ios', 'android']
const events = ['login', 'view_item', 'add_to_cart', 'checkout', 'payment_ok', 'logout', 'search', 'share']

const pick = <T,>(r: () => number, list: T[]) => list[Math.floor(r() * list.length)]
const hex = (r: () => number, n: number) => Array.from({ length: n }, () => Math.floor(r() * 16).toString(16)).join('')

function person(i: number) {
  const r = rng(i)
  const name = `${pick(r, first)} ${pick(r, last)}`
  return {
    id: i,
    name,
    email: `${name.toLowerCase().replace(/[^a-z]+/g, '.')}${i}@example.com`,
    role: pick(r, roles),
    country: pick(r, countries),
    plan: pick(r, ['free', 'pro', 'team']),
    active: r() > 0.2,
    created: new Date(1_700_000_000_000 + Math.floor(r() * 90) * 86_400_000).toISOString().slice(0, 10),
  }
}

export const samples: Sample[] = [
  {
    kind: 'string',
    label: 'String',
    models: 'Cached API response or session blob',
    defaultPrefix: 'demo:session',
    build: (key, i) => {
      const r = rng(i)
      const body = JSON.stringify({ uid: i, token: hex(r, 32), ip: `10.${Math.floor(r() * 255)}.${Math.floor(r() * 255)}.${Math.floor(r() * 255)}`, ua: 'Mozilla/5.0', scopes: ['read', 'write'] })
      return [['SET', key, body]]
    },
  },
  {
    kind: 'counter',
    label: 'Counter',
    models: 'Page views, rate limits, quotas',
    defaultPrefix: 'demo:counter',
    build: (key, i) => [['INCRBY', key, String(1 + ((i * 7919) % 5000))]],
  },
  {
    kind: 'hash',
    label: 'Hash',
    models: 'User profile / object with fields',
    defaultPrefix: 'demo:user',
    build: (key, i) => {
      const p = person(i)
      return [['HSET', key, 'id', String(p.id), 'name', p.name, 'email', p.email, 'role', p.role, 'country', p.country, 'plan', p.plan, 'active', String(p.active), 'created', p.created]]
    },
  },
  {
    kind: 'list',
    label: 'List',
    models: 'Activity feed or job queue',
    defaultPrefix: 'demo:feed',
    build: (key, i) => {
      const r = rng(i)
      const items = Array.from({ length: 20 }, (_, n) => JSON.stringify({ t: 1_760_000_000 + i * 60 + n, event: pick(r, events), item: Math.floor(r() * 9000) }))
      return [['RPUSH', key, ...items]]
    },
  },
  {
    kind: 'set',
    label: 'Set',
    models: 'Tags, followers, unique visitors',
    defaultPrefix: 'demo:tags',
    build: (key, i) => {
      const r = rng(i)
      const members = new Set<string>()
      while (members.size < 8) members.add(pick(r, tags))
      return [['SADD', key, ...members]]
    },
  },
  {
    kind: 'zset',
    label: 'Sorted set',
    models: 'Leaderboard or time-ordered index',
    defaultPrefix: 'demo:leaderboard',
    build: (key, i) => {
      const r = rng(i)
      const args: string[] = []
      for (let n = 0; n < 20; n++) args.push(String(Math.floor(r() * 100000)), `player:${i}:${n}`)
      return [['ZADD', key, ...args]]
    },
  },
  {
    kind: 'json',
    label: 'JSON',
    models: 'Nested document with arrays',
    defaultPrefix: 'demo:doc',
    build: (key, i) => {
      const p = person(i)
      const r = rng(i + 1)
      const doc = {
        ...p,
        address: { city: pick(r, ['Riga', 'Kigali', 'Berlin', 'Nairobi', 'Lyon']), zip: String(10000 + Math.floor(r() * 89999)) },
        tags: [pick(r, tags), pick(r, tags), pick(r, tags)],
        stats: { logins: Math.floor(r() * 500), spend: Math.round(r() * 100000) / 100 },
      }
      return [['JSON.SET', key, '$', JSON.stringify(doc)]]
    },
  },
]

export function formatCommand(args: string[]) {
  return args.map(a => (/^[A-Za-z0-9_:.$@/+-]+$/.test(a) ? a : `'${a.length > 120 ? a.slice(0, 117) + '…' : a}'`)).join(' ')
}
