export type BenchmarkConfig = {
  profile: string
  host: string
  port: number
  server: string
  keys: number
  getOps: number
  workers: number
  pipeline: number
  settleMs: number
  seed: number
}

export type BenchResult = {
  server: string
  addr: string
  workload: 'load' | 'get'
  value_shape: string
  value_bytes: number
  keys: number
  ops_per_second: number
  p50_ns: number
  p95_ns: number
  p99_ns: number
  used_memory_delta: number
  bytes_per_key_delta: number
}

export type Job = {
  id: string
  status: 'running' | 'done' | 'failed'
  command: string
  log: string
  error?: string
  startedAt: string
  finishedAt?: string
  results?: {
    load: BenchResult
    get: BenchResult
  }
}
