import type { BenchmarkConfig, Job, ServerStatus, ProfileBestResults, OptimizerMode, ValidationJob, ValidationOptions, ValidationSuite, ValidationSuiteId, DbListResult, DbKeyDetails, DbMutation, DbBulkAction, DbCommandAction, DbOverview, DbScanResult, DbPipelineResult, RpcLabConfig, RpcLabJob, PubSubLabConfig, PubSubLabJob, ConsoleEvent, ConsoleRunResult, ConsolePublishResult, ConsoleServerOptions } from './types'

export {}

declare global {
  interface Window {
    snugBench: {
      environment(): Promise<{ snugkvRepo: string; script: string; scriptFound: boolean }>
      start(config: BenchmarkConfig): Promise<Job>
      cancel(): Promise<boolean>
      save(payload: { filename: string; data: unknown }): Promise<{ saved: boolean; path?: string }>
      saveText(payload: { filename: string; data: string; type?: 'csv' | 'txt' }): Promise<{ saved: boolean; path?: string }>
      onUpdate(callback: (job: Job) => void): () => void
      serverStatus(): Promise<ServerStatus>
      startServer(kind: 'redis' | 'snug', optimizerMode?: OptimizerMode): Promise<ServerStatus>
      stopServer(): Promise<ServerStatus>
      onServerUpdate(callback: (status: ServerStatus) => void): () => void
      bestResults(profile: string): Promise<ProfileBestResults>
      resetBestResults(profile: string): Promise<ProfileBestResults>
      resetAllStatistics(): Promise<boolean>
      onHistoryUpdate(callback: (payload: { profile: string; best: ProfileBestResults }) => void): () => void
      validationSuites(): Promise<ValidationSuite[]>
      startValidation(suiteId: ValidationSuiteId, options: ValidationOptions): Promise<ValidationJob>
      cancelValidation(): Promise<boolean>
      onValidationUpdate(callback: (job: ValidationJob) => void): () => void
      console: {
        startServers(opts: ConsoleServerOptions): Promise<Record<string, string>>
        stopServers(): Promise<boolean>
        connect(id: string, addr: string): Promise<boolean>
        disconnect(id: string): Promise<boolean>
        run(id: string, line: string): Promise<ConsoleRunResult>
        publish(id: string, channel: string, message: string, count: number): Promise<ConsolePublishResult>
        subscribe(id: string, kind: 'channel' | 'pattern' | 'shard', targets: string[]): Promise<boolean>
        unsubscribe(id: string): Promise<boolean>
        onEvent(callback: (event: ConsoleEvent) => void): () => void
      }
      startPubSubLab(config: PubSubLabConfig): Promise<PubSubLabJob>
      cancelPubSubLab(): Promise<boolean>
      onPubSubUpdate(callback: (job: PubSubLabJob) => void): () => void
      startRpcLab(config: RpcLabConfig): Promise<RpcLabJob>
      cancelRpcLab(): Promise<boolean>
      onRpcUpdate(callback: (job: RpcLabJob) => void): () => void
      dbListKeys(options: { pattern: string; count: number }): Promise<DbListResult>
      dbGetKey(options: { key: string }): Promise<DbKeyDetails>
      dbSetString(options: { key: string; value: string }): Promise<{ ok: boolean; command: string }>
      dbSetTtl(options: { key: string; seconds: number | null }): Promise<{ ok: boolean; command: string }>
      dbDeleteKey(options: { key: string }): Promise<{ ok: boolean; command: string }>
      dbCreateExample(options: { key: string; kind: 'string' | 'hash' | 'list' | 'set' | 'zset' | 'json' }): Promise<{ ok: boolean; command: string }>
      dbMutate(request: DbMutation): Promise<{ ok: boolean; command: string }>
      dbBulk(request: DbBulkAction): Promise<{ ok: boolean; command: string; affected: number }>
      dbCommand(request: DbCommandAction): Promise<{ ok: boolean; command: string; result: string }>
      dbOverview(): Promise<DbOverview>
      dbScan(options: { cursor: string; pattern: string; count: number }): Promise<DbScanResult>
      dbPipeline(request: { commands: string[][] }): Promise<DbPipelineResult>
      dbFlush(): Promise<{ ok: boolean; command: string }>
    }
  }
}
