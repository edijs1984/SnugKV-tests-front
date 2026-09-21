import type { BenchmarkConfig, Job, ServerStatus, ProfileBestResults, OptimizerMode } from './types'

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
    }
  }
}
