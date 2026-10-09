import { useMemo, useRef, useState } from 'react'
import type { BenchmarkConfig, Job } from './types'
import MatrixCharts from './MatrixCharts'

type ServerKind = 'redis' | 'snug'
type Profile = readonly [string, string]

type MatrixRow = {
  profile: string
  profileLabel: string
  server: ServerKind
  serverLabel: string
  status: 'running' | 'done' | 'failed'
  startedAt: string
  finishedAt?: string
  error?: string
  job?: Job
}

type Props = {
  profiles: readonly Profile[]
  baseConfig: BenchmarkConfig
  disabled?: boolean
  onRunningChange?: (running: boolean) => void
}

const serverDefs: readonly [ServerKind, string][] = [
  ['redis', 'Redis'],
  ['snug', 'SnugKV'],
]


const profileGroups = [
  { id: 'scalar', label: 'Strings / scalar', match: (profile: string) => !/^(hash|list|set|zset)-/.test(profile) },
  { id: 'hash', label: 'Hash', match: (profile: string) => profile.startsWith('hash-') },
  { id: 'list', label: 'List', match: (profile: string) => profile.startsWith('list-') },
  { id: 'set', label: 'Set', match: (profile: string) => profile.startsWith('set-') },
  { id: 'zset', label: 'Sorted Set (ZSET)', match: (profile: string) => profile.startsWith('zset-') },
] as const

const nf = new Intl.NumberFormat('en-US')

function waitForJob(id: string): Promise<Job> {
  return new Promise(resolve => {
    const off = window.snugBench.onUpdate(next => {
      if (next.id !== id || next.status === 'running') return
      off()
      resolve(next)
    })
  })
}

function finalBytesPerKey(job?: Job) {
  if (!job?.results) return null
  return job.results.load.bytes_per_key_delta
}

function finalMemory(job?: Job) {
  if (!job?.results) return null
  return job.results.load.used_memory_delta
}

function hotBytesPerKey(job?: Job) {
  if (!job?.results) return null
  return job.results.load.bytes_per_key_post_workload ?? job.results.load.bytes_per_key_delta
}

function csvCell(value: unknown) {
  const text = value === null || value === undefined ? '' : String(value)
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export default function BenchmarkMatrix({ profiles, baseConfig, disabled, onRunningChange }: Props) {
  const [rows, setRows] = useState<MatrixRow[]>([])
  const [running, setRunning] = useState(false)
  const [selectedServers, setSelectedServers] = useState<ServerKind[]>(['redis', 'snug'])
  const [selectedProfiles, setSelectedProfiles] = useState<string[]>(() => profiles.map(([profile]) => profile))
  const [progress, setProgress] = useState({ current: 0, total: profiles.length * serverDefs.length, label: '' })
  const [copyState, setCopyState] = useState('')
  const cancelled = useRef(false)

  const completed = useMemo(() => rows.filter(row => row.status === 'done' && row.job?.results), [rows])
  const failed = useMemo(() => rows.filter(row => row.status === 'failed'), [rows])

  function replaceRow(match: Pick<MatrixRow, 'profile' | 'server'>, next: MatrixRow) {
    setRows(current => {
      const index = current.findIndex(row => row.profile === match.profile && row.server === match.server)
      if (index < 0) return [...current, next]
      const copy = [...current]
      copy[index] = next
      return copy
    })
  }

  function toggleServer(server: ServerKind) {
    if (running) return
    setSelectedServers(current =>
      current.includes(server)
        ? current.filter(item => item !== server)
        : [...current, server],
    )
  }

  function toggleProfile(profile: string) {
    if (running) return
    setSelectedProfiles(current =>
      current.includes(profile)
        ? current.filter(item => item !== profile)
        : [...current, profile],
    )
  }

  function selectAllProfiles() {
    if (running) return
    setSelectedProfiles(profiles.map(([profile]) => profile))
  }

  function clearSelectedProfiles() {
    if (running) return
    setSelectedProfiles([])
  }

  async function runMatrix(mode: 'all' | 'selected') {
    if (running || selectedServers.length === 0) return
    const activeProfiles = mode === 'all'
      ? profiles
      : profiles.filter(([profile]) => selectedProfiles.includes(profile))
    if (activeProfiles.length === 0) return
    cancelled.current = false
    setRows([])
    setRunning(true)
    onRunningChange?.(true)
    setCopyState('')

    const activeServers = serverDefs.filter(([server]) => selectedServers.includes(server))
    const total = activeProfiles.length * activeServers.length
    setProgress({ current: 0, total, label: '' })
    let current = 0

    try {
      for (const [server, serverLabel] of activeServers) {
        if (cancelled.current) break

        let status
        try {
          status = await window.snugBench.startServer(server, baseConfig.optimizerMode ?? 'dedicated')
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          for (const [profile, profileLabel] of activeProfiles) {
            current += 1
            const now = new Date().toISOString()
            replaceRow({ profile, server }, {
              profile, profileLabel, server, serverLabel,
              status: 'failed', startedAt: now, finishedAt: now, error: `Server start failed: ${message}`,
            })
          }
          continue
        }

        for (const [profile, profileLabel] of activeProfiles) {
          if (cancelled.current) break
          current += 1
          const label = `${serverLabel} · ${profileLabel}`
          setProgress({ current, total, label })

          const startedAt = new Date().toISOString()
          const pending: MatrixRow = { profile, profileLabel, server, serverLabel, status: 'running', startedAt }
          replaceRow({ profile, server }, pending)

          try {
            const config: BenchmarkConfig = {
              ...baseConfig,
              repetitions: 1, // one measured pass per data type per server
              diagnostics: false, // no profiling while measuring
              profileReplay: false, // keep the full measured data set in the database
              profile,
              host: '127.0.0.1',
              port: status.port!,
              server: status.label!,
            }
            const started = await window.snugBench.start(config)
            const finished = await waitForJob(started.id)
            const row: MatrixRow = {
              ...pending,
              status: finished.status === 'done' ? 'done' : 'failed',
              finishedAt: finished.finishedAt ?? new Date().toISOString(),
              error: finished.error,
              job: finished,
            }
            replaceRow({ profile, server }, row)
          } catch (error) {
            replaceRow({ profile, server }, {
              ...pending,
              status: 'failed',
              finishedAt: new Date().toISOString(),
              error: error instanceof Error ? error.message : String(error),
            })
          }
        }
      }
    } finally {
      setRunning(false)
      onRunningChange?.(false)
      setProgress(prev => ({ ...prev, label: cancelled.current ? 'Cancelled' : 'Complete' }))
    }
  }

  async function cancelMatrix() {
    cancelled.current = true
    await window.snugBench.cancel()
  }

  function asJson() {
    return rows.map(row => ({
      profile: row.profile,
      profileLabel: row.profileLabel,
      server: row.server,
      serverLabel: row.serverLabel,
      status: row.status,
      error: row.error ?? null,
      config: row.job?.config ?? null,
      load: row.job?.results?.load ?? null,
      get: row.job?.results?.get ?? null,
    }))
  }

  function asCsv() {
    const header = ['profile','server','status','write_ops_s','read_ops_s','write_p95_us','read_p95_us','final_memory_bytes','final_bytes_per_key','hot_bytes_per_key','error']
    const lines = [header.join(',')]
    for (const row of rows) {
      const load = row.job?.results?.load
      const get = row.job?.results?.get
      lines.push([
        row.profile,
        row.server,
        row.status,
        load?.ops_per_second ?? '',
        get?.ops_per_second ?? '',
        load ? load.p95_ns / 1000 : '',
        get ? get.p95_ns / 1000 : '',
        finalMemory(row.job) ?? '',
        finalBytesPerKey(row.job) ?? '',
        hotBytesPerKey(row.job) ?? '',
        row.error ?? '',
      ].map(csvCell).join(','))
    }
    return lines.join('\n')
  }

  function asMarkdown() {
    const lines = [
      '| Profile | Server | WRITE/s | READ/s | WRITE p95 | READ p95 | Final memory | Final B/unit | Hot B/unit |',
      '|---|---|---:|---:|---:|---:|---:|---:|---:|',
    ]
    for (const row of rows) {
      if (!row.job?.results) {
        lines.push(`| ${row.profile} | ${row.serverLabel} | ${row.status.toUpperCase()} | — | — | — | — | — | — |`)
        continue
      }
      const { load, get } = row.job.results
      const memory = finalMemory(row.job)
      const bpk = finalBytesPerKey(row.job)
      const hotBpk = hotBytesPerKey(row.job)
      lines.push(`| ${row.profile} | ${row.serverLabel} | ${Math.round(load.ops_per_second).toLocaleString()} | ${Math.round(get.ops_per_second).toLocaleString()} | ${(load.p95_ns / 1000).toFixed(2)} μs | ${(get.p95_ns / 1000).toFixed(2)} μs | ${memory === null ? '—' : (memory / 1024 / 1024).toFixed(1) + ' MB'} | ${bpk === null ? '—' : bpk.toFixed(2)} | ${hotBpk === null ? '—' : hotBpk.toFixed(2)} |`)
    }
    return lines.join('\n')
  }

  async function copy(format: 'markdown' | 'json' | 'csv') {
    const text = format === 'markdown' ? asMarkdown() : format === 'csv' ? asCsv() : JSON.stringify(asJson(), null, 2)
    await navigator.clipboard.writeText(text)
    setCopyState(format)
    setTimeout(() => setCopyState(''), 1500)
  }

  async function save(format: 'json' | 'csv') {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    if (format === 'json') {
      await window.snugBench.save({
        filename: `snugkv-full-matrix-${stamp}.json`,
        data: {
          generatedAt: new Date().toISOString(),
          baseConfig,
          profiles: profiles.map(([id, label]) => ({ id, label })),
          selectedProfiles,
          servers: serverDefs
            .filter(([server]) => selectedServers.includes(server))
            .map(([id, label]) => ({ id, label })),
          results: asJson(),
        },
      })
    } else {
      await window.snugBench.saveText({
        filename: `snugkv-full-matrix-${stamp}.csv`,
        data: asCsv(),
        type: 'csv',
      })
    }
  }

  return (
    <section className="matrix-card">
      <div className="matrix-head">
        <div>
          <span className="eyebrow">Selectable profiles · selected servers</span>
          <h3>Full benchmark matrix</h3>
          <p>
            Run the complete matrix or choose exactly which profiles to benchmark. Current selection:
            {' '}{selectedProfiles.length} of {profiles.length} profiles × {selectedServers.length} selected server{selectedServers.length === 1 ? '' : 's'}.
          </p>
          <div className="server-switches matrix-server-switches" aria-label="Matrix servers">
            {serverDefs.map(([server, label]) => {
              const selected = selectedServers.includes(server)
              return (
                <button
                  key={server}
                  type="button"
                  className={selected ? 'server-choice active' : 'server-choice'}
                  disabled={running || disabled}
                  aria-pressed={selected}
                  onClick={() => toggleServer(server)}
                >
                  {selected ? '✓ ' : ''}{label}
                </button>
              )
            })}
          </div>
          {selectedServers.length === 0 && (
            <small className="inline-error">Select at least one server to run the matrix.</small>
          )}

          <div className="matrix-profile-selector">
            <div className="matrix-profile-selector-head">
              <div>
                <strong>Profiles</strong>
                <span>{selectedProfiles.length} / {profiles.length} selected</span>
              </div>
              <div>
                <button type="button" disabled={running || disabled} onClick={selectAllProfiles}>Select all</button>
                <button type="button" disabled={running || disabled || selectedProfiles.length === 0} onClick={clearSelectedProfiles}>Clear</button>
              </div>
            </div>
            <div className="matrix-profile-groups">
              {profileGroups.map(group => {
                const groupProfiles = profiles.filter(([profile]) => group.match(profile))
                if (groupProfiles.length === 0) return null
                const selectedCount = groupProfiles.filter(([profile]) => selectedProfiles.includes(profile)).length
                return (
                  <section className="matrix-profile-group" key={group.id}>
                    <div className="matrix-profile-group-head">
                      <strong>{group.label}</strong>
                      <span>{selectedCount}/{groupProfiles.length}</span>
                    </div>
                    <div className="matrix-profile-grid">
                      {groupProfiles.map(([profile, label]) => {
                        const selected = selectedProfiles.includes(profile)
                        return (
                          <label key={profile} className={selected ? 'matrix-profile active' : 'matrix-profile'}>
                            <input
                              type="checkbox"
                              checked={selected}
                              disabled={running || disabled}
                              onChange={() => toggleProfile(profile)}
                            />
                            <span>
                              <strong>{label}</strong>
                              <small>{profile}</small>
                            </span>
                          </label>
                        )
                      })}
                    </div>
                  </section>
                )
              })}
            </div>
          </div>
        </div>
        <div className="matrix-primary-actions">
          {!running ? (
            <>
              <button
                className="primary-run"
                disabled={disabled || selectedServers.length === 0}
                onClick={() => runMatrix('all')}
              >
                ▶ Run all
                <small>{profiles.length * selectedServers.length} runs</small>
              </button>
              <button
                className="matrix-run-selected"
                disabled={disabled || selectedServers.length === 0 || selectedProfiles.length === 0}
                onClick={() => runMatrix('selected')}
              >
                ▶ Run selected
                <small>{selectedProfiles.length * selectedServers.length} runs</small>
              </button>
            </>
          ) : (
            <button className="secondary-stop" onClick={cancelMatrix}>Cancel matrix</button>
          )}
        </div>
      </div>

      <MatrixCharts profiles={profiles} />

      {(running || rows.length > 0) && (
        <>
          <div className="matrix-progress">
            <div><strong>{running ? progress.label : 'Matrix complete'}</strong><span>{Math.min(progress.current, progress.total)} / {progress.total}</span></div>
            <div className="matrix-progress-track"><i style={{ width: `${progress.total ? (Math.min(progress.current, progress.total) / progress.total) * 100 : 0}%` }} /></div>
          </div>

          <div className="matrix-summary">
            <span>Passed <b>{completed.length}</b></span>
            <span>Failed <b>{failed.length}</b></span>
            <span>Total <b>{rows.length}</b></span>
          </div>

          <div className="matrix-table-wrap">
            <table className="matrix-table">
              <thead><tr><th>Profile</th><th>Server</th><th>Status</th><th>WRITE/s</th><th>READ/s</th><th>p95 WRITE</th><th>p95 READ</th><th>Final memory</th><th>Final B/key</th><th>Hot B/key</th></tr></thead>
              <tbody>
                {rows.map(row => {
                  const load = row.job?.results?.load
                  const get = row.job?.results?.get
                  const memory = finalMemory(row.job)
                  const bpk = finalBytesPerKey(row.job)
                  const hotBpk = hotBytesPerKey(row.job)
                  return <tr key={`${row.server}:${row.profile}`}>
                    <td><strong>{row.profile}</strong></td>
                    <td>{row.serverLabel}</td>
                    <td><span className={`matrix-status ${row.status}`}>{row.status}</span>{row.error && <small title={row.error}>!</small>}</td>
                    <td>{load ? nf.format(Math.round(load.ops_per_second)) : '—'}</td>
                    <td>{get ? nf.format(Math.round(get.ops_per_second)) : '—'}</td>
                    <td>{load ? `${(load.p95_ns / 1000).toFixed(2)} μs` : '—'}</td>
                    <td>{get ? `${(get.p95_ns / 1000).toFixed(2)} μs` : '—'}</td>
                    <td>{memory === null ? '—' : `${(memory / 1024 / 1024).toFixed(1)} MB`}</td>
                    <td>{bpk === null ? '—' : bpk.toFixed(2)}</td>
                    <td>{hotBpk === null ? '—' : hotBpk.toFixed(2)}</td>
                  </tr>
                })}
              </tbody>
            </table>
          </div>

          {!running && rows.length > 0 && (
            <div className="matrix-export-actions">
              <button onClick={() => copy('markdown')}>{copyState === 'markdown' ? 'Copied' : 'Copy Markdown'}</button>
              <button onClick={() => copy('json')}>{copyState === 'json' ? 'Copied' : 'Copy JSON'}</button>
              <button onClick={() => copy('csv')}>{copyState === 'csv' ? 'Copied' : 'Copy CSV'}</button>
              <button onClick={() => save('json')}>Save JSON</button>
              <button onClick={() => save('csv')}>Save CSV</button>
            </div>
          )}
        </>
      )}
    </section>
  )
}
