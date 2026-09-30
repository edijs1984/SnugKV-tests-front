import { useEffect, useMemo, useState } from 'react'
import type { ValidationJob, ValidationOptions, ValidationSuite, ValidationSuiteId } from './types'

const defaults: ValidationOptions = {
  durationSeconds: 600,
  caseTimeoutSeconds: 480,
  keys: 100000,
  workers: 4,
  valueBytes: 512,
  seed: 1,
}

function durationLabel(seconds: number) {
  if (seconds % 3600 === 0) return `${seconds / 3600}h`
  if (seconds % 60 === 0) return `${seconds / 60}m`
  return `${seconds}s`
}

export default function ValidationLab() {
  const [suites, setSuites] = useState<ValidationSuite[]>([])
  const [selected, setSelected] = useState<ValidationSuiteId>('full-release')
  const [options, setOptions] = useState<ValidationOptions>(defaults)
  const [job, setJob] = useState<ValidationJob | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    window.snugBench.validationSuites().then(setSuites).catch(err => setError(String(err)))
    return window.snugBench.onValidationUpdate(next => setJob(next))
  }, [])

  const suite = useMemo(() => suites.find(item => item.id === selected), [suites, selected])
  const busy = job?.status === 'running'

  async function run() {
    setError(null)
    setJob(null)
    try {
      const next = await window.snugBench.startValidation(selected, options)
      setJob(next)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function cancel() {
    await window.snugBench.cancelValidation()
  }

  async function copyLog() {
    if (job?.log) await navigator.clipboard.writeText(job.log)
  }

  function choose(next: ValidationSuiteId) {
    const found = suites.find(item => item.id === next)
    setSelected(next)
    if (found?.defaultDurationSeconds) {
      setOptions(prev => ({ ...prev, durationSeconds: found.defaultDurationSeconds! }))
    }
  }

  return (
    <section className="validation-lab">
      <aside className="validation-sidebar">
        <div className="validation-sidebar-head">
          <span className="eyebrow">SnugKV source validation</span>
          <h2>Test suites</h2>
          <p>Run the same release, recovery and soak checks used from the terminal.</p>
        </div>

        {(['release', 'soak'] as const).map(category => (
          <div className="validation-group" key={category}>
            <div className="validation-group-title">{category === 'release' ? 'Release & correctness' : 'Soak & chaos'}</div>
            {suites.filter(item => item.category === category).map(item => (
              <button
                key={item.id}
                className={selected === item.id ? 'validation-suite active' : 'validation-suite'}
                disabled={busy}
                onClick={() => choose(item.id)}
              >
                <span>{item.label}</span>
                <small>{item.description}</small>
              </button>
            ))}
          </div>
        ))}
      </aside>

      <div className="validation-main">
        <div className="validation-hero">
          <div>
            <span className="eyebrow">{suite?.category === 'soak' ? 'Long-running validation' : 'Release gate'}</span>
            <h1>{suite?.label ?? 'Validation Lab'}</h1>
            <p>{suite?.description ?? 'Loading test suites…'}</p>
          </div>
          <div className={`validation-status ${job?.status ?? 'idle'}`}>
            <i />
            <span>{job?.status ?? 'idle'}</span>
          </div>
        </div>

        {suite?.configurable && (
          <div className="validation-options">
            <label>
              <span>Duration</span>
              <select
                value={options.durationSeconds}
                disabled={busy}
                onChange={e => setOptions(prev => ({ ...prev, durationSeconds: Number(e.target.value) }))}
              >
                {[60, 600, 1800, 3600, 7200, 21600, 43200, 86400].map(value => (
                  <option key={value} value={value}>{durationLabel(value)}</option>
                ))}
              </select>
            </label>
            <label>
              <span>Case timeout</span>
              <input
                type="number"
                min={30}
                max={3600}
                value={options.caseTimeoutSeconds}
                disabled={busy}
                onChange={e => setOptions(prev => ({ ...prev, caseTimeoutSeconds: Number(e.target.value) }))}
              />
            </label>
            <label>
              <span>Keys</span>
              <input
                type="number"
                min={10}
                value={options.keys}
                disabled={busy}
                onChange={e => setOptions(prev => ({ ...prev, keys: Number(e.target.value) }))}
              />
            </label>
            <label>
              <span>Workers</span>
              <input
                type="number"
                min={1}
                max={256}
                value={options.workers}
                disabled={busy}
                onChange={e => setOptions(prev => ({ ...prev, workers: Number(e.target.value) }))}
              />
            </label>
            <label>
              <span>Value bytes</span>
              <input
                type="number"
                min={1}
                value={options.valueBytes}
                disabled={busy}
                onChange={e => setOptions(prev => ({ ...prev, valueBytes: Number(e.target.value) }))}
              />
            </label>
            <label>
              <span>Seed</span>
              <input
                type="number"
                value={options.seed}
                disabled={busy}
                onChange={e => setOptions(prev => ({ ...prev, seed: Number(e.target.value) }))}
              />
            </label>
          </div>
        )}

        {suite?.destructive && (
          <div className="validation-warning">
            This suite starts/stops local SnugKV processes and may use FLUSHDB on isolated test instances. Do not point it at production data.
          </div>
        )}

        {error && <div className="app-error-banner validation-error"><strong>Action failed</strong><span>{error}</span></div>}

        <div className="validation-actions">
          <button className="primary-run" disabled={!suite || busy} onClick={run}>
            <span className="play-icon">▶</span>
            {busy ? 'Validation running…' : 'Run suite'}
          </button>
          {busy && <button className="secondary-stop" onClick={cancel}>Cancel</button>}
          {job?.log && <button className="validation-copy" onClick={copyLog}>Copy log</button>}
        </div>

        <div className="validation-console">
          <div className="console-head">
            <div>
              <strong>Validation output</strong>
              <span>{job?.command || 'Select a suite and run it.'}</span>
            </div>
            {job?.startedAt && <span className="validation-time">{new Date(job.startedAt).toLocaleString()}</span>}
          </div>
          <pre className="validation-console-body">{job?.log || 'Ready.'}</pre>
          {job?.error && <div className="inline-error">{job.error}</div>}
        </div>

        <div className="validation-summary">
          <article><span>Suite</span><strong>{job?.suiteLabel ?? suite?.label ?? '—'}</strong></article>
          <article><span>Status</span><strong>{job?.status ?? 'idle'}</strong></article>
          <article><span>Exit code</span><strong>{job?.exitCode ?? '—'}</strong></article>
          <article><span>Duration</span><strong>{suite?.configurable ? durationLabel(options.durationSeconds) : 'suite-defined'}</strong></article>
        </div>
      </div>
    </section>
  )
}
