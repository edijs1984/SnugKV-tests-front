import type { BenchmarkConfig, Job, ServerStatus } from './types'

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
      startServer(kind: 'redis' | 'snug-raw' | 'snug-opt'): Promise<ServerStatus>
      stopServer(): Promise<ServerStatus>
      onServerUpdate(callback: (status: ServerStatus) => void): () => void
    }
  }
}
