import type { BenchmarkConfig, Job } from './types'

export {}

declare global {
  interface Window {
    snugBench: {
      environment(): Promise<{ snugkvRepo: string; script: string; scriptFound: boolean }>
      start(config: BenchmarkConfig): Promise<Job>
      cancel(): Promise<boolean>
      save(payload: { filename: string; data: unknown }): Promise<{ saved: boolean; path?: string }>
      onUpdate(callback: (job: Job) => void): () => void
    }
  }
}
