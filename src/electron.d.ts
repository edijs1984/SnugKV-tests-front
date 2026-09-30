import type { BenchmarkConfig, Job, ServerStatus, ProfileBestResults, OptimizerMode, ValidationJob, ValidationOptions, ValidationSuite, ValidationSuiteId, DbListResult, DbKeyDetails } from './types'

export {}

declare global {
  interface Window {
    snugBench: {
      environment(): Promise<{ snugkvRepo: string; script: string; scriptFound: boolean }>
      start(config: BenchmarkConfig): Promise<Job>
      cancel(): Promise<boolean>
      save(payload: { filename: string; data: unknown }): Promise<{ saved: boolean; path?: string }>
      onUpdate(callback: (job: Job) => void): () => void
      serverStatus(): Promise<ServerStatus>
      startServer(kind: 'redis' | 'snug-raw' | 'snug-opt', optimizerMode?: OptimizerMode): Promise<ServerStatus>
      stopServer(): Promise<ServerStatus>
      onServerUpdate(callback: (status: ServerStatus) => void): () => void
      bestResults(profile: string): Promise<ProfileBestResults>
      resetBestResults(profile: string): Promise<ProfileBestResults>
      onHistoryUpdate(callback: (payload: { profile: string; best: ProfileBestResults }) => void): () => void
      validationSuites(): Promise<ValidationSuite[]>
      startValidation(suiteId: ValidationSuiteId, options: ValidationOptions): Promise<ValidationJob>
      cancelValidation(): Promise<boolean>
      onValidationUpdate(callback: (job: ValidationJob) => void): () => void
      dbListKeys(options: { pattern: string; count: number }): Promise<DbListResult>
      dbGetKey(options: { key: string }): Promise<DbKeyDetails>
      dbSetString(options: { key: string; value: string }): Promise<{ ok: boolean; command: string }>
      dbSetTtl(options: { key: string; seconds: number | null }): Promise<{ ok: boolean; command: string }>
      dbDeleteKey(options: { key: string }): Promise<{ ok: boolean; command: string }>
      dbCreateExample(options: { key: string; kind: 'string' | 'hash' | 'list' | 'set' | 'zset' | 'json' }): Promise<{ ok: boolean; command: string }>
    }
  }
}
