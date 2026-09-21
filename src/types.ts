export type OptimizerMode = 'dedicated' | 'sidecar'

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
  optimizerMode?: OptimizerMode
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
  used_memory_post_workload_delta?: number
  bytes_per_key_post_workload?: number
  converge_ms?: number
  converged?: boolean
  convergence_elapsed_ms?: number
  convergence_samples?: number
}

export type OptimizationProgress = {
  elapsed_ms: number
  used_memory: number
  optimizer_rewritten?: number
  optimizer_rewritten_run?: number
  optimizer_queue_depth?: number
  arena_bytes?: number
  arena_payload_bytes?: number
  arena_live_block_bytes?: number
  estimated_final_memory?: number
  estimated_final_bytes_per_key?: number
  start_used_memory?: number
}

export type Job = {
  id: string
  status: 'running' | 'done' | 'failed'
  command: string
  log: string
  error?: string
  startedAt: string
  finishedAt?: string
  optimization?: OptimizationProgress
  results?: {
    load: BenchResult
    get: BenchResult
  }
}

export type ServerStatus = {
  running: boolean
  kind?: 'redis' | 'snug-raw' | 'snug-opt'
  port?: number
  label?: string
  optimizerMode?: OptimizerMode
}

export type BestServerResult = {
  bestSet: number
  bestGet: number
  lowestBytesPerKey: number
  runs: number
  lastUpdated: string | null
  source: 'cli' | 'electron' | null
}

export type ProfileBestResults = {
  redis: BestServerResult | null
  'snug-raw': BestServerResult | null
  'snug-opt': BestServerResult | null
}
