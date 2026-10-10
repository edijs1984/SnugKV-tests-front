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
  /** Measured passes (1-3). Matrix runs use 1; omitted means 3. */
  repetitions?: number
  profileReplay?: boolean
  diagnostics?: boolean
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
  duration_ns?: number
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

export type DiagnosticCommandResult = {
  ok: boolean
  exitCode?: number | null
  stdout?: string
  stderr?: string
  skipped?: boolean
  reason?: string
  output?: string
  error?: string
}

export type ProcessMetrics = {
  rss_kb: number | null
  peak_rss_kb: number | null
  virtual_kb: number | null
  threads: number | null
  voluntary_context_switches: number | null
  nonvoluntary_context_switches: number | null
  cpu_user_ticks: number | null
  cpu_system_ticks: number | null
  read_bytes: number | null
  write_bytes: number | null
  read_syscalls: number | null
  write_syscalls: number | null
}

export type BenchmarkDiagnostics = {
  schemaVersion: number
  runId: string
  profile: string
  startedAt: string
  finishedAt?: string
  durationMs: number
  command: string
  config: BenchmarkConfig
  server: {
    kind: 'redis' | 'snug' | null
    label: string
    pid: number | null
    optimizerMode: OptimizerMode | null
    logTail: string
  }
  environment: {
    platform: string
    arch: string
    node: string
    electron?: string
    cpus: string[]
    totalMemoryBytes: number
  }
  artifacts: {
    runDir: string
    loadJson: string
    getJson: string
    diagnosticsJson: string
  }
  snapshots: {
    before: Record<string, unknown>
    afterMeasured: Record<string, unknown>
    afterProfilingReplay: Record<string, unknown> | null
  }
  processSamples: Array<{
    elapsed_ms: number
    process: ProcessMetrics | null
    system: {
      loadavg: number[]
      free_memory_bytes: number
      total_memory_bytes: number
      cpus: number
    }
  }>
  profiling: {
    cpu: DiagnosticCommandResult
    heap: DiagnosticCommandResult
    alloc: DiagnosticCommandResult
    replay: {
      skipped: boolean
      reason?: string
      runDir?: string
      keys?: number
      getOps?: number
      command?: string
      replay?: DiagnosticCommandResult
      cpu: DiagnosticCommandResult
      readCpu?: DiagnosticCommandResult
      readProfile?: {
        command: string
        ops: number
        run: DiagnosticCommandResult
        result?: BenchResult | null
        cpu: DiagnosticCommandResult
      }
      load?: BenchResult | null
      get?: BenchResult | null
    }
  }
  benchmark: {
    load: BenchResult
    get: BenchResult
  } | null
}

export type Job = {
  id: string
  status: 'running' | 'done' | 'failed'
  config?: BenchmarkConfig
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
  diagnostics?: BenchmarkDiagnostics
}

export type ServerStatus = {
  running: boolean
  kind?: 'redis' | 'snug'
  port?: number
  label?: string
  optimizerMode?: OptimizerMode
}

export type BestServerResult = {
  bestSet: number
  bestGet: number
  lowestBytesPerKey: number
  /** Median of the latest runs with identical settings (see medianSettings). */
  medianSet?: number
  medianGet?: number
  medianBytesPerKey?: number
  medianRuns?: number
  medianSettings?: string
  runs: number
  lastUpdated: string | null
  source: 'cli' | 'electron' | null
}

export type ProfileBestResults = {
  redis: BestServerResult | null
  snug: BestServerResult | null
}


export type ValidationSuiteId =
  | 'full-release'
  | 'go-test'
  | 'go-race'
  | 'go-vet'
  | 'resp-fuzz'
  | 'redis82-differential'
  | 'cli-command-matrix'
  | 'durability'
  | 'cluster-recovery'
  | 'cluster-corrupt-replica'
  | 'cluster-persistence-failure'
  | 'full-soak'
  | 'distributed-soak'
  | 'mixed-soak'

export type ValidationSuite = {
  id: ValidationSuiteId
  label: string
  description: string
  category: 'release' | 'cli' | 'soak'
  destructive?: boolean
  configurable?: boolean
  defaultDurationSeconds?: number
}

export type ValidationOptions = {
  durationSeconds: number
  caseTimeoutSeconds: number
  keys: number
  workers: number
  valueBytes: number
  seed: number
}

export type ValidationJob = {
  id: string
  suiteId: ValidationSuiteId
  suiteLabel: string
  status: 'running' | 'done' | 'failed' | 'cancelled'
  command: string
  log: string
  startedAt: string
  finishedAt?: string
  exitCode?: number
  error?: string
  options: ValidationOptions
}


export type DbKeySummary = {
  key: string
  type: string
}

export type DbKeyDetails = {
  key: string
  type: string
  ttl: number
  length?: number
  encoding?: string
  memoryBytes?: number
  value: unknown
  command: string
}

export type DbListResult = {
  keys: DbKeySummary[]
  command: string
}


export type DbMutation =
  | { action: 'hash-set'; key: string; field: string; value: string }
  | { action: 'hash-del'; key: string; field: string }
  | { action: 'list-push'; key: string; side: 'left' | 'right'; value: string }
  | { action: 'list-set'; key: string; index: number; value: string }
  | { action: 'list-del-index'; key: string; index: number }
  | { action: 'set-add'; key: string; value: string }
  | { action: 'set-del'; key: string; value: string }
  | { action: 'zset-set'; key: string; member: string; score: number }
  | { action: 'zset-del'; key: string; member: string }
  | { action: 'json-set-root'; key: string; value: string }

export type DbBulkAction =
  | { action: 'delete'; keys: string[] }
  | { action: 'expire'; keys: string[]; seconds: number }
  | { action: 'persist'; keys: string[] }

export type DbCommandAction =
  | { action: 'get'; key: string }
  | { action: 'type'; key: string }
  | { action: 'ttl'; key: string }
  | { action: 'exists'; key: string }
  | { action: 'incr'; key: string; amount: number }
  | { action: 'set'; key: string; value: string }
  | { action: 'delete'; key: string }
  | { action: 'expire'; key: string; seconds: number }
  | { action: 'hget'; key: string; field: string }
  | { action: 'hset'; key: string; field: string; value: string }
  | { action: 'lpush'; key: string; value: string }
  | { action: 'rpush'; key: string; value: string }
  | { action: 'sadd'; key: string; value: string }
  | { action: 'zadd'; key: string; member: string; score: number }

export type DbOverview = {
  host: string
  port: number
  keys: number
  usedMemory: number | null
  peakMemory: number | null
  maxMemory: number | null
  commands: number | null
  uptimeSeconds: number | null
  clients: number | null
  version: string | null
  at: number
}

export type DbScanKey = {
  key: string
  type: string
  ttl: number
  memoryBytes?: number
}

export type DbScanResult = {
  keys: DbScanKey[]
  cursor: string
  command: string
}

export type DbPipelineResult = {
  ok: boolean
  sent: number
  errors: number
  firstError: string | null
  elapsedMs: number
}

export type RpcChain = 'solana' | 'evm'
export type RpcCacheKind = 'snug' | 'redis'

export type RpcLabConfig = {
  chain: RpcChain
  caches: RpcCacheKind[]
  users: number
  durationSeconds: number
  refreshMs: number
  watched: number
  popular: number
  popularReads: number
  overlap: number
  skew: number
  /** Proxy TTL for state, recent and tip reads. 0 keeps the proxy defaults. */
  cacheTtlSeconds: number
  /** Block or slot time of the fake node. 0 keeps the chain default. */
  blockTimeMs: number
  /** Seconds to wait before the final memory reading (SnugKV optimizer). */
  settleSeconds: number
  checkRate: number
  seed: number
}

export type RpcMethodTally = {
  calls: number
  hit: number
  miss: number
  coalesced: number
  bypass: number
  answered_without_node: number
}

export type RpcWalletResult = {
  chain: RpcChain
  users: number
  seconds: number
  http_requests: number
  rpc_calls: number
  failures: number
  first_failure_status?: number
  calls_per_sec: number
  p50_ms: number
  p99_ms: number
  answered_without_node: number
  node_calls_from_proxy?: number
  node_calls_saved?: number
  methods: Record<string, RpcMethodTally>
  staleness?: {
    checked: number
    stale: number
    stale_share?: number
    lag_slots_p50?: number
    lag_slots_p99?: number
    lag_slots_max?: number
  }
  cache_peak_entries?: number
  cache_peak_bytes?: number
  cache_bytes_per_entry_at_peak?: number
  cache_bytes_after_wait?: number
  cache_entries_after_wait?: number
}

export type RpcLabJob = {
  id: string
  status: 'running' | 'done' | 'failed' | 'cancelled'
  stage: string
  config: RpcLabConfig
  results: { cache: RpcCacheKind; label: string; result: RpcWalletResult; proxy?: Record<string, number> }[]
  log: string
  commands: string[]
  startedAt: string
  finishedAt?: string
  error?: string
}

export type PubSubServerKind = 'snug' | 'redis'

export type PubSubLabConfig = {
  servers: PubSubServerKind[]
  subscribers: number
  /** Subscribers that connect and never read. */
  stuck: number
  channels: number
  publishers: number
  payloadBytes: number
  /** Total PUBLISH per second, 0 for as fast as possible. */
  rate: number
  durationSeconds: number
  pattern: boolean
  /** SnugKV delivery policy. */
  sendAttempts: number
  sendTimeoutMs: number
  queueSize: number
}

export type PubSubResult = {
  server: string
  subscribers: number
  channels: number
  publishers: number
  pattern: boolean
  payload_bytes: number
  seconds: number
  published: number
  publish_per_sec: number
  publish_p50_ms: number
  publish_p99_ms: number
  publish_max_ms: number
  deliveries_expected: number
  deliveries: number
  delivered_share: number
  deliveries_per_sec: number
  delivery_p50_ms: number
  delivery_p99_ms: number
  delivery_max_ms: number
  healthy_disconnected: number
  stuck_subscribers: number
  stuck_dropped: number
  stuck_bytes_buffered: number
  server_dropped_subscribers: number
  publish_errors: number
  connect_errors: number
  first_problem?: string
}

export type PubSubLabJob = {
  id: string
  status: 'running' | 'done' | 'failed' | 'cancelled'
  stage: string
  config: PubSubLabConfig
  results: { server: PubSubServerKind; label: string; result: PubSubResult }[]
  log: string
  commands: string[]
  startedAt: string
  finishedAt?: string
  error?: string
}

export type ConsoleEvent = {
  window: 'A' | 'B' | '*'
  ts: number
  kind: 'status' | 'sub' | 'message' | 'publish' | 'error' | 'info'
  state?: string
  addr?: string
  expected?: boolean
  name?: string
  count?: number
  message?: string
  type?: string
  channel?: string
  pattern?: string
  payload?: string
  bytes?: number
  received?: number
  sent?: number
  receivers?: number
  errors?: number
  firstError?: string | null
  ms?: number
}

export type ConsoleRunResult = { reply: string; error: boolean; ms: number }
export type ConsolePublishResult = { sent: number; receivers: number; errors: number; firstError: string | null; ms: number }

export type ConsoleServerOptions = {
  snugA: boolean
  snugB: boolean
  redis: boolean
  /** Make SnugKV B a replica of SnugKV A. */
  replica: boolean
  sendAttempts: number
  sendTimeoutMs: number
  queueSize: number
}
