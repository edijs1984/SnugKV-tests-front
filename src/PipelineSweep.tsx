import { useMemo, useRef, useState } from 'react'
import type { BenchmarkConfig, Job } from './types'

type SweepRow = {
  pipeline: number
  keys: number
  getOps: number
  status: 'running' | 'done' | 'failed'
  error?: string
  job?: Job
}

type Props = {
  baseConfig: BenchmarkConfig
  disabled?: boolean
  onRunningChange?: (running: boolean) => void
}

const DEFAULT_PIPELINES = [1, 8, 16, 64, 256] as const
const nf = new Intl.NumberFormat('en-US')

function quickWorkload(pipeline: number) {
  switch (pipeline) {
    case 1:
      return { keys: 20_000, getOps: 40_000 }
    case 8:
      return { keys: 50_000, getOps: 100_000 }
    case 16:
      return { keys: 100_000, getOps: 200_000 }
    case 64:
      return { keys: 250_000, getOps: 500_000 }
    default:
      return { keys: 500_000, getOps: 1_000_000 }
  }
}

function waitForJob(id: string): Promise<Job> {
  return new Promise(resolve => {
    const off = window.snugBench.onUpdate(next => {
      if (next.id !== id || next.status === 'running') return
      off()
      resolve(next)
    })
  })
}

export default function PipelineSweep({ baseConfig, disabled, onRunningChange }: Props) {
  const [selected, setSelected] = useState<number[]>([...DEFAULT_PIPELINES])
  const [rows, setRows] = useState<SweepRow[]>([])
  const [running, setRunning] = useState(false)
  const cancelled = useRef(false)

  const completed = useMemo(
    () => rows.filter(row => row.status === 'done' && row.job?.results),
    [rows],
  )

  function toggle(pipeline: number) {
    if (running) return
    setSelected(current =>
      current.includes(pipeline)
        ? current.filter(value => value !== pipeline)
        : [...current, pipeline].sort((a, b) => a - b),
    )
  }

  function replaceRow(pipeline: number, next: SweepRow) {
    setRows(current => {
      const index = current.findIndex(row => row.pipeline === pipeline)
      if (index < 0) return [...current, next].sort((a, b) => a.pipeline - b.pipeline)
      const copy = [...current]
      copy[index] = next
      return copy
    })
  }

  async function runSweep() {
    if (running || selected.length === 0) return

    cancelled.current = false
    setRows([])
    setRunning(true)
    onRunningChange?.(true)

    try {
      for (const pipeline of selected) {
        if (cancelled.current) break

        const quick = quickWorkload(pipeline)
        const pending: SweepRow = {
          pipeline,
          keys: quick.keys,
          getOps: quick.getOps,
          status: 'running',
        }
        replaceRow(pipeline, pending)

        try {
          const config: BenchmarkConfig = {
            ...baseConfig,
            pipeline,
            keys: quick.keys,
            getOps: quick.getOps,
          }
          const started = await window.snugBench.start(config)
          const finished = await waitForJob(started.id)
          replaceRow(pipeline, {
            ...pending,
            status: finished.status === 'done' ? 'done' : 'failed',
            error: finished.error,
            job: finished,
          })
        } catch (error) {
          replaceRow(pipeline, {
            ...pending,
            status: 'failed',
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
    } finally {
      setRunning(false)
      onRunningChange?.(false)
    }
  }

  async function cancelSweep() {
    cancelled.current = true
    await window.snugBench.cancel()
  }

  async function copyMarkdown() {
    const lines = [
      '| Pipeline | Keys | Read ops | WRITE/s | READ/s | WRITE p95 | READ p95 | Final B/unit |',
      '|---:|---:|---:|---:|---:|---:|---:|---:|',
    ]
    for (const row of rows) {
      const load = row.job?.results?.load
      const get = row.job?.results?.get
      if (!load || !get) {
        lines.push(`| ${row.pipeline} | ${nf.format(row.keys)} | ${nf.format(row.getOps)} | ${row.status.toUpperCase()} | — | — | — | — |`)
        continue
      }
      lines.push(
        `| ${row.pipeline} | ${nf.format(row.keys)} | ${nf.format(row.getOps)} | ${nf.format(Math.round(load.ops_per_second))} | ${nf.format(Math.round(get.ops_per_second))} | ${(load.p95_ns / 1000).toFixed(2)} μs | ${(get.p95_ns / 1000).toFixed(2)} μs | ${load.bytes_per_key_delta.toFixed(2)} |`,
      )
    }
    await navigator.clipboard.writeText(lines.join('\n'))
  }

  return (
    <section className="matrix-card pipeline-sweep-card">
      <div className="matrix-head">
        <div>
          <span className="eyebrow">Single profile · quick scaling</span>
          <h3>Pipeline sweep</h3>
          <p>
            Compare the selected profile at several pipeline depths. Lower pipeline values
            automatically use fewer keys and read operations so the sweep stays quick.
          </p>
          <div className="server-switches matrix-server-switches" aria-label="Pipeline depths">
            {DEFAULT_PIPELINES.map(pipeline => {
              const active = selected.includes(pipeline)
              const workload = quickWorkload(pipeline)
              return (
                <button
                  key={pipeline}
                  type="button"
                  className={active ? 'server-choice active' : 'server-choice'}
                  disabled={running || disabled}
                  aria-pressed={active}
                  title={`${nf.format(workload.keys)} keys · ${nf.format(workload.getOps)} reads`}
                  onClick={() => toggle(pipeline)}
                >
                  {active ? '✓ ' : ''}P{pipeline}
                </button>
              )
            })}
          </div>
          <small>
            Auto sizes: P1 20k/40k · P8 50k/100k · P16 100k/200k ·
            P64 250k/500k · P256 500k/1m (keys/read ops).
          </small>
        </div>
        <div className="matrix-primary-actions">
          {!running ? (
            <button
              className="primary-run"
              disabled={disabled || selected.length === 0}
              onClick={runSweep}
            >
              ▶ Run pipeline sweep
            </button>
          ) : (
            <button className="secondary-stop" onClick={cancelSweep}>Cancel sweep</button>
          )}
        </div>
      </div>

      {rows.length > 0 && (
        <>
          <div className="matrix-summary">
            <span>Passed <b>{completed.length}</b></span>
            <span>Total <b>{rows.length}</b></span>
            <span>Profile <b>{baseConfig.profile}</b></span>
          </div>

          <div className="matrix-table-wrap">
            <table className="matrix-table">
              <thead>
                <tr>
                  <th>Pipeline</th>
                  <th>Keys</th>
                  <th>Read ops</th>
                  <th>Status</th>
                  <th>WRITE/s</th>
                  <th>READ/s</th>
                  <th>p95 WRITE</th>
                  <th>p95 READ</th>
                  <th>Final B/unit</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(row => {
                  const load = row.job?.results?.load
                  const get = row.job?.results?.get
                  return (
                    <tr key={row.pipeline}>
                      <td><strong>{row.pipeline}</strong></td>
                      <td>{nf.format(row.keys)}</td>
                      <td>{nf.format(row.getOps)}</td>
                      <td>
                        <span className={`matrix-status ${row.status}`}>{row.status}</span>
                        {row.error && <small title={row.error}>!</small>}
                      </td>
                      <td>{load ? nf.format(Math.round(load.ops_per_second)) : '—'}</td>
                      <td>{get ? nf.format(Math.round(get.ops_per_second)) : '—'}</td>
                      <td>{load ? `${(load.p95_ns / 1000).toFixed(2)} μs` : '—'}</td>
                      <td>{get ? `${(get.p95_ns / 1000).toFixed(2)} μs` : '—'}</td>
                      <td>{load ? load.bytes_per_key_delta.toFixed(2) : '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {!running && rows.length > 0 && (
            <div className="matrix-export-actions">
              <button onClick={copyMarkdown}>Copy Markdown</button>
            </div>
          )}
        </>
      )}
    </section>
  )
}
