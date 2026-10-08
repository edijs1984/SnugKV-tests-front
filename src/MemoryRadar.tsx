import { useMemo, useState } from 'react'
import type { AllProfileBestResults, BestServerResult } from './types'

type SeriesKey = 'redis' | 'snug-opt'

const series: { key: SeriesKey; label: string; color: string; dash?: string }[] = [
  { key: 'redis', label: 'Redis', color: '#3987e5', dash: '5 4' },
  { key: 'snug-opt', label: 'SnugKV', color: '#199e70' }
]

const sizes: Record<string, string> = { small: '10', medium: '100', large: '1k' }
const types: Record<string, string> = { hash: 'Hash', list: 'List', set: 'Set', zset: 'ZSet' }
function shortLabel(key: string, fallback: string) {
  const m = key.match(/^(hash|list|set|zset)-(small|medium|large)$/)
  if (m) return `${types[m[1]]} ${sizes[m[2]]}`
  return key || fallback
}

export type RadarMetric = 'memory' | 'set' | 'get'
const metrics: Record<RadarMetric, { title: string; sub: string; unit: string; pick: (b: BestServerResult) => number }> = {
  memory: { title: 'RAM per item vs Redis', sub: 'Lowest bytes/item, Redis = 100%. Closer to the centre is better.', unit: 'B/item', pick: b => b.lowestBytesPerKey },
  set: { title: 'SET speed vs Redis', sub: 'Best SET ops/s, Redis = 100%. Further out is faster.', unit: 'ops/s', pick: b => b.bestSet },
  get: { title: 'GET speed vs Redis', sub: 'Best GET ops/s, Redis = 100%. Further out is faster.', unit: 'ops/s', pick: b => b.bestGet }
}

type Axis = { key: string; label: string; redis: number; values: Partial<Record<SeriesKey, number>> }

const fmt = (v: number) => (v >= 1000 ? Math.round(v).toLocaleString() : v.toFixed(1))
const W = 800
const R = 215
const CX = W / 2
const CY = R + 80
const H = 2 * R + 160

export function MemoryRadar({ profiles, allBest, metric = 'memory' }: { profiles: string[][]; allBest: AllProfileBestResults; metric?: RadarMetric }) {
  const m = metrics[metric]
  const [table, setTable] = useState(false)
  const [tip, setTip] = useState<{ x: number; y: number; axis: Axis; s: typeof series[number] } | null>(null)

  // Axes: every profile that has a Redis baseline (everything is shown relative to it).
  const axes = useMemo<Axis[]>(() => profiles.flatMap(([key, label]) => {
    const b = allBest[key]
    const redis = b?.redis ? m.pick(b.redis) : 0
    if (!b || !redis || redis <= 0) return []
    const values: Partial<Record<SeriesKey, number>> = {}
    for (const s of series) {
      const v = b[s.key] ? m.pick(b[s.key]!) : 0
      if (v && v > 0) values[s.key] = v
    }
    return [{ key, label: shortLabel(key, label), redis, values }]
  }), [profiles, allBest, m])

  const ratios = axes.flatMap(a => series.map(s => (a.values[s.key] ?? 0) / a.redis))
  const max = Math.max(1.2, ...ratios)
  const top = Math.ceil(max * 5) / 5 // outer ring, in ratio to Redis
  const rings = Array.from(new Set([0.5, 1, top])).sort((a, b) => a - b)
  const n = axes.length
  const angle = (i: number) => -Math.PI / 2 + (i * 2 * Math.PI) / n
  const pt = (i: number, ratio: number) => {
    const r = (ratio / top) * R
    return [CX + r * Math.cos(angle(i)), CY + r * Math.sin(angle(i))] as const
  }

  return (
    <section className="radar-card" aria-label={m.title}>
      <div className="radar-head">
        <div>
          <strong>{m.title}</strong>
          <span>{m.sub}</span>
        </div>
        <button onClick={() => setTable(t => !t)}>{table ? 'Chart' : 'Table'}</button>
      </div>

      <ul className="radar-legend">
        {series.map(s => (
          <li key={s.key}>
            <svg width="22" height="10" aria-hidden="true">
              <line x1="1" x2="21" y1="5" y2="5" stroke={s.color} strokeWidth="2" strokeDasharray={s.dash} />
            </svg>
            {s.label}
          </li>
        ))}
      </ul>

      {n < 3 ? (
        <p className="radar-empty">Run at least 3 profiles on Redis and SnugKV to draw the chart.</p>
      ) : table ? (
        <table className="radar-table">
          <thead>
            <tr><th>Profile</th>{series.map(s => <th key={s.key}>{s.label} {m.unit}</th>)}<th>vs Redis</th></tr>
          </thead>
          <tbody>
            {axes.map(a => {
              const o = a.values['snug-opt']
              return (
                <tr key={a.key}>
                  <td>{a.label}</td>
                  {series.map(s => <td key={s.key}>{a.values[s.key] ? fmt(a.values[s.key]!) : '—'}</td>)}
                  <td>{o ? `${((o / a.redis) * 100).toFixed(0)}%` : '—'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      ) : (
        <div className="radar-wrap" onMouseLeave={() => setTip(null)}>
          <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Radar chart of bytes per item relative to Redis">
            {rings.map((t, k) => (
              <g key={k}>
                <polygon
                  points={axes.map((_, i) => pt(i, t).join(',')).join(' ')}
                  className={Math.abs(t - 1) < 1e-9 ? 'radar-ring base' : 'radar-ring'}
                />
                <text x={CX + 4} y={CY - (t / top) * R - 3} className="radar-tick">{Math.round(t * 100)}%</text>
              </g>
            ))}
            {axes.map((a, i) => {
              const [x, y] = pt(i, top)
              const [lx, ly] = pt(i, top * 1.13)
              const cos = Math.cos(angle(i))
              return (
                <g key={a.key}>
                  <line x1={CX} y1={CY} x2={x} y2={y} className="radar-spoke" />
                  <text x={lx} y={ly} className="radar-label" textAnchor={Math.abs(cos) < 0.2 ? 'middle' : cos > 0 ? 'start' : 'end'} dominantBaseline="middle">
                    {a.label}
                  </text>
                </g>
              )
            })}
            {series.map(s => {
              const have = axes.every(a => a.values[s.key])
              if (!have && !axes.some(a => a.values[s.key])) return null
              const pts = axes.map((a, i) => pt(i, (a.values[s.key] ?? 0) / a.redis))
              return (
                <g key={s.key}>
                  <polygon
                    points={pts.map(p => p.join(',')).join(' ')}
                    fill={s.color}
                    fillOpacity={s.key === 'redis' ? 0 : 0.12}
                    stroke={s.color}
                    strokeWidth="2"
                    strokeDasharray={s.dash}
                    strokeLinejoin="round"
                  />
                  {axes.map((a, i) => a.values[s.key] ? (
                    <g key={a.key}>
                      <circle cx={pts[i][0]} cy={pts[i][1]} r="4" fill={s.color} stroke="#101418" strokeWidth="2" />
                      <circle
                        cx={pts[i][0]} cy={pts[i][1]} r="12" fill="transparent"
                        onMouseEnter={() => setTip({ x: pts[i][0], y: pts[i][1], axis: a, s })}
                        onFocus={() => setTip({ x: pts[i][0], y: pts[i][1], axis: a, s })}
                        tabIndex={0}
                      />
                    </g>
                  ) : null)}
                </g>
              )
            })}
          </svg>
          {tip && (
            <div className="radar-tip" style={{ left: `${(tip.x / W) * 100}%`, top: `${(tip.y / H) * 100}%` }}>
              <b>{tip.axis.label}</b>
              <span>{tip.s.label}: {fmt(tip.axis.values[tip.s.key]!)} {m.unit}</span>
              <span>{(((tip.axis.values[tip.s.key] ?? 0) / tip.axis.redis) * 100).toFixed(0)}% of Redis ({fmt(tip.axis.redis)})</span>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
