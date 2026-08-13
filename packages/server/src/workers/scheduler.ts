import type { Db } from '../db/client.js'
import type { Notifier } from '../events/emit.js'
import { runGithubPoll, type GithubClient } from './github-poll.js'
import { runStripePoll, type StripeClient } from './stripe-poll.js'
import { runProber, type Fetcher, type TxtResolver } from './prober.js'
import { runMetricsPoll, type MetricsClients } from './metrics-poll.js'

export interface SchedulerDeps {
  db: Db
  notifier: Notifier
  secretKey: Buffer
  github: GithubClient
  stripe: StripeClient
  fetch: Fetcher
  resolveTxt: TxtResolver
  metrics: MetricsClients
}

export async function runAllProducers(deps: SchedulerDeps): Promise<void> {
  const jobs: Array<() => Promise<void>> = [
    () => runGithubPoll(deps),
    () => runStripePoll({ db: deps.db, notifier: deps.notifier, secretKey: deps.secretKey, stripe: deps.stripe }),
    () => runProber({ db: deps.db, notifier: deps.notifier, fetch: deps.fetch, resolveTxt: deps.resolveTxt }),
    () => runMetricsPoll({ db: deps.db, secretKey: deps.secretKey, stripe: deps.stripe, metrics: deps.metrics }),
  ]
  for (const job of jobs) {
    try {
      await job()
    } catch {
      // one failing producer never blocks the others; next interval retries
    }
  }
}

export function startScheduler(deps: SchedulerDeps, intervalMs = 15 * 60 * 1000): { stop(): void } {
  void runAllProducers(deps)
  const timer = setInterval(() => void runAllProducers(deps), intervalMs)
  timer.unref()
  return { stop: () => clearInterval(timer) }
}
