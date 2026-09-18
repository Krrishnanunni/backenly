/**
 * THE AUTH LIMITER'S STORE IS PER-PROCESS. THIS STOPS THAT BEING FORGOTTEN.
 * ========================================================================
 *
 * `lib/security/auth-rate-limit.ts` keeps its counters in an in-memory Map.
 * That is a real control on one process and it is NOT a control across several:
 * an attacker who can reach N instances gets a fresh budget from each, so the
 * effective limit becomes (limit x N).
 *
 * Today that is bounded. Self-host runs one web process; the Cloud task
 * definition runs `desired_count = 1`. The problem is that neither fact is
 * written anywhere the limiter can see, and raising a replica count from 1 to 3
 * is a capacity decision — nobody would think to security-review it. The
 * brute-force capacity this audit just closed would reopen silently.
 *
 * So the deployment has to SAY how many instances it runs, and a deployment
 * that runs more than one without a shared store fails loudly at startup
 * instead of quietly weakening.
 *
 * This is deliberately not a Redis implementation. Wiring a shared store is the
 * real fix and belongs with the Auth tranche; this is the much cheaper thing
 * that makes the gap impossible to cross by accident in the meantime.
 *
 *   BACKENLY_APP_INSTANCES        how many web/runtime instances run. Default 1.
 *   BACKENLY_RATE_LIMIT_STORE     'memory' (default) or 'redis'.
 */

export type RateLimitStoreKind = 'memory' | 'redis'

export class RateLimitStoreMisconfigured extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RateLimitStoreMisconfigured'
  }
}

/** How many app instances the deployment declares. Absent means one. */
export function declaredInstanceCount(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.BACKENLY_APP_INSTANCES?.trim()
  if (!raw) return 1
  const n = Number(raw)
  // A value nobody can parse is a misconfiguration, not a reason to assume the
  // safe answer: assuming 1 here is exactly how the check gets bypassed.
  if (!Number.isFinite(n) || n < 1 || !Number.isInteger(n)) {
    throw new RateLimitStoreMisconfigured(
      `BACKENLY_APP_INSTANCES must be a positive integer; got ${JSON.stringify(raw)}.`,
    )
  }
  return n
}

/** Which store the auth limiter is configured to use. */
export function declaredStoreKind(env: NodeJS.ProcessEnv = process.env): RateLimitStoreKind {
  const raw = env.BACKENLY_RATE_LIMIT_STORE?.trim().toLowerCase()
  if (!raw || raw === 'memory') return 'memory'
  if (raw === 'redis') return 'redis'
  throw new RateLimitStoreMisconfigured(
    `BACKENLY_RATE_LIMIT_STORE must be 'memory' or 'redis'; got ${JSON.stringify(raw)}.`,
  )
}

/**
 * Throw when the declared topology cannot enforce the limits it claims.
 *
 * Called at startup so a bad deploy fails immediately and visibly, rather than
 * serving traffic with a security control that is quietly a third as strong as
 * it reads.
 */
export function assertRateLimitStoreSupportsTopology(
  env: NodeJS.ProcessEnv = process.env,
): void {
  const instances = declaredInstanceCount(env)
  const store = declaredStoreKind(env)

  if (instances > 1 && store === 'memory') {
    throw new RateLimitStoreMisconfigured(
      `This deployment declares BACKENLY_APP_INSTANCES=${instances}, but the auth rate ` +
      `limiter uses the in-memory store.\n\n` +
      `Counters are per-process, so ${instances} instances means an attacker gets ` +
      `${instances} budgets and the effective limit on /api/auth/login and ` +
      `/api/v1/{projectId}/auth/* is ${instances}x what it reads.\n\n` +
      `Either run a single instance, or configure a shared store with ` +
      `BACKENLY_RATE_LIMIT_STORE=redis (see checkRateLimitRedis in ` +
      `lib/middleware/rateLimiter.ts, which is not yet wired).`,
    )
  }

  if (store === 'redis' && !env.REDIS_URL?.trim()) {
    // Declaring redis without a URL would fail on the first request instead of
    // at startup, which is the worst of both: it looks configured and is not.
    throw new RateLimitStoreMisconfigured(
      'BACKENLY_RATE_LIMIT_STORE=redis requires REDIS_URL to be set.',
    )
  }
}
