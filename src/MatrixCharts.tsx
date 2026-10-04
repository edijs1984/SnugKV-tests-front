import { useEffect, useMemo, useState } from 'react'
import type { ProfileBestResults } from './types'

type Profile = readonly [string, string]
type ServerKind = 'redis' | 'snug'

type Props = {
  profiles: readonly Profile[]
}

type FamilyBest = {
  redis: {
    set: number
    get: number
    memory: number
    setSource: string
    getSource: string
    memorySource: string
  }
  snug: {
    set: number
    get: number
    memory: number
    setSource: string
    getSource: string
    memorySource: string
  }
}

type RadarDatum = {
  id: string
  label: string
  redis: number
  snug: number
  redisRaw: number
  snugRaw: number
  redisSource: string
  snugSource: string
}

const nf = new Intl.NumberFormat('en-US')

function logicalFamily(profile: string) {
  if (profile.startsWith('hash-')) return 'hash'
  if (profile.startsWith('list-')) return 'list'
  if (profile.startsWith('set-')) return 'set'
  if (profile.startsWith('zset-')) return 'zset'
  return profile
}

function familyLabel(id: string) {
  const labels: Record<string, string> = {
    'cache-json': 'Cache JSON',
    'session-json': 'Session JSON',
    'api-json': 'API JSON',
    counter: 'Counter',
    uuid: 'UUID',
    ulid: 'ULID',
    text: 'Text',
    repetitive: 'Repetitive',
    compressed: 'Compressed',
    random: 'Random',
    hash: 'Hash',
    list: 'List',
    set: 'Set',
    zset: 'ZSET',
  }
  return labels[id] ?? id
}

function emptyFamily(): FamilyBest {
  const blank = () => ({
    set: 0,
    get: 0,
    memory: Number.POSITIVE_INFINITY,
    setSource: '',
    getSource: '',
    memorySource: '',
  })
  return { redis: blank(), snug: blank() }
}

function aggregate(history: Record<string, ProfileBestResults>, profiles: readonly Profile[]) {
  const grouped = new Map<string, FamilyBest>()

  for (const [profile] of profiles) {
    const best = history[profile]
    if (!best) continue
    const family = logicalFamily(profile)
    const current = grouped.get(family) ?? emptyFamily()

    for (const server of ['redis', 'snug'] as const) {
      const source = best[server]
      if (!source) continue
      if (source.bestSet > current[server].set) {
        current[server].set = source.bestSet
        current[server].setSource = profile
      }
      if (source.bestGet > current[server].get) {
        current[server].get = source.bestGet
        current[server].getSource = profile
      }
      if (Number.isFinite(source.lowestBytesPerKey) && source.lowestBytesPerKey > 0 &&
          source.lowestBytesPerKey < current[server].memory) {
        current[server].memory = source.lowestBytesPerKey
        current[server].memorySource = profile
      }
    }

    grouped.set(family, current)
  }

  return grouped
}

function radarData(grouped: Map<string, FamilyBest>, metric: 'set' | 'get') {
  const result: RadarDatum[] = []
  for (const [id, family] of grouped) {
    const redisRaw = family.redis[metric]
    const snugRaw = family.snug[metric]
    if (redisRaw <= 0 && snugRaw <= 0) continue
    const ceiling = Math.max(redisRaw, snugRaw, 1)
    result.push({
      id,
      label: familyLabel(id),
      redis: redisRaw > 0 ? redisRaw / ceiling : 0,
      snug: snugRaw > 0 ? snugRaw / ceiling : 0,
      redisRaw,
      snugRaw,
      redisSource: metric === 'set' ? family.redis.setSource : family.redis.getSource,
      snugSource: metric === 'set' ? family.snug.setSource : family.snug.getSource,
    })
  }
  return result
}

function point(cx: number, cy: number, radius: number, angle: number) {
  return {
    x: cx + Math.cos(angle) * radius,
    y: cy + Math.sin(angle) * radius,
  }
}

function polygonPoints(data: RadarDatum[], key: 'redis' | 'snug', cx: number, cy: number, radius: number) {
  return data.map((row, index) => {
    const angle = -Math.PI / 2 + (index / data.length) * Math.PI * 2
    const p = point(cx, cy, radius * row[key], angle)
    return `${p.x.toFixed(1)},${p.y.toFixed(1)}`
  }).join(' ')
}

function RadarChart({ title, subtitle, data }: { title: string; subtitle: string; data: RadarDatum[] }) {
  if (data.length < 3) {
    return (
      <div className="matrix-chart-card matrix-chart-empty">
        <div className="matrix-chart-head"><div><strong>{title}</strong><span>{subtitle}</span></div></div>
        <p>Run at least three comparable profiles on Redis and SnugKV to draw this chart.</p>
      </div>
    )
  }

  const size = 360
  const cx = size / 2
  const cy = size / 2
  const radius = 112
  const levels = [0.25, 0.5, 0.75, 1]

  return (
    <div className="matrix-chart-card">
      <div className="matrix-chart-head">
        <div><strong>{title}</strong><span>{subtitle}</span></div>
        <div className="matrix-chart-legend">
          <span><i className="redis" />Redis</span>
          <span><i className="snug" />SnugKV</span>
        </div>
      </div>
      <svg className="matrix-radar" viewBox={`0 0 ${size} ${size}`} role="img" aria-label={title}>
        {levels.map(level => (
          <polygon
            key={level}
            className="matrix-radar-grid"
            points={data.map((_, index) => {
              const angle = -Math.PI / 2 + (index / data.length) * Math.PI * 2
              const p = point(cx, cy, radius * level, angle)
              return `${p.x.toFixed(1)},${p.y.toFixed(1)}`
            }).join(' ')}
          />
        ))}
        {data.map((row, index) => {
          const angle = -Math.PI / 2 + (index / data.length) * Math.PI * 2
          const end = point(cx, cy, radius, angle)
          const label = point(cx, cy, radius + 27, angle)
          const anchor = Math.abs(label.x - cx) < 8 ? 'middle' : label.x < cx ? 'end' : 'start'
          return (
            <g key={row.id}>
              <line className="matrix-radar-axis" x1={cx} y1={cy} x2={end.x} y2={end.y} />
              <text className="matrix-radar-label" x={label.x} y={label.y} textAnchor={anchor} dominantBaseline="middle">
                {row.label}
              </text>
            </g>
          )
        })}
        <polygon className="matrix-radar-area redis" points={polygonPoints(data, 'redis', cx, cy, radius)} />
        <polygon className="matrix-radar-area snug" points={polygonPoints(data, 'snug', cx, cy, radius)} />
        {data.flatMap((row, index) => {
          const angle = -Math.PI / 2 + (index / data.length) * Math.PI * 2
          return (['redis', 'snug'] as const).map(server => {
            const p = point(cx, cy, radius * row[server], angle)
            const raw = server === 'redis' ? row.redisRaw : row.snugRaw
            const source = server === 'redis' ? row.redisSource : row.snugSource
            return (
              <circle key={`${row.id}:${server}`} className={`matrix-radar-dot ${server}`} cx={p.x} cy={p.y} r="3.5">
                <title>{`${row.label} · ${server === 'redis' ? 'Redis' : 'SnugKV'}: ${nf.format(Math.round(raw))}/s · source ${source}`}</title>
              </circle>
            )
          })
        })}
      </svg>
      <div className="matrix-chart-note">Each axis is normalized to the faster server for that data type. Hover points for raw ops/s and source profile.</div>
    </div>
  )
}

function MemoryChart({ grouped }: { grouped: Map<string, FamilyBest> }) {
  const rows = Array.from(grouped.entries()).map(([id, value]) => ({
    id,
    label: familyLabel(id),
    redis: Number.isFinite(value.redis.memory) ? value.redis.memory : 0,
    snug: Number.isFinite(value.snug.memory) ? value.snug.memory : 0,
    redisSource: value.redis.memorySource,
    snugSource: value.snug.memorySource,
  })).filter(row => row.redis > 0 || row.snug > 0)

  const max = Math.max(...rows.flatMap(row => [row.redis, row.snug]), 1)

  return (
    <div className="matrix-chart-card matrix-memory-card">
      <div className="matrix-chart-head">
        <div><strong>RAM used by data type</strong><span>Lowest recorded bytes per logical unit</span></div>
        <div className="matrix-chart-legend">
          <span><i className="redis" />Redis</span>
          <span><i className="snug" />SnugKV</span>
        </div>
      </div>
      {rows.length === 0 ? (
        <p className="matrix-memory-empty">No recorded matrix memory results yet.</p>
      ) : (
        <div className="matrix-memory-chart">
          {rows.map(row => (
            <div className="matrix-memory-row" key={row.id}>
              <strong>{row.label}</strong>
              <div className="matrix-memory-bars">
                {(['redis', 'snug'] as const).map(server => {
                  const value = row[server]
                  const source = server === 'redis' ? row.redisSource : row.snugSource
                  return (
                    <div className="matrix-memory-line" key={server} title={`${server === 'redis' ? 'Redis' : 'SnugKV'} · ${value.toFixed(2)} B/unit · source ${source}`}>
                      <span>{server === 'redis' ? 'R' : 'S'}</span>
                      <div><i className={server} style={{ width: `${value > 0 ? Math.max(1.5, (value / max) * 100) : 0}%` }} /></div>
                      <b>{value > 0 ? value.toFixed(1) : '—'}</b>
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="matrix-chart-note">HASH/LIST/SET/ZSET collapse small, medium and large profiles and use the lowest recorded RAM result for each server.</div>
    </div>
  )
}

export default function MatrixCharts({ profiles }: Props) {
  const [history, setHistory] = useState<Record<string, ProfileBestResults>>({})

  useEffect(() => {
    let cancelled = false
    Promise.all(profiles.map(async ([profile]) => [profile, await window.snugBench.bestResults(profile)] as const))
      .then(entries => {
        if (!cancelled) setHistory(Object.fromEntries(entries))
      })

    const off = window.snugBench.onHistoryUpdate(({ profile, best }) => {
      setHistory(current => ({ ...current, [profile]: best }))
    })

    return () => {
      cancelled = true
      off()
    }
  }, [profiles])

  const grouped = useMemo(() => aggregate(history, profiles), [history, profiles])
  const setData = useMemo(() => radarData(grouped, 'set'), [grouped])
  const getData = useMemo(() => radarData(grouped, 'get'), [grouped])

  return (
    <div className="matrix-charts">
      <div className="matrix-radar-grid-wrap">
        <RadarChart title="SET / WRITE performance" subtitle="Best recorded result per data type" data={setData} />
        <RadarChart title="GET / READ performance" subtitle="Best recorded result per data type" data={getData} />
      </div>
      <MemoryChart grouped={grouped} />
    </div>
  )
}
