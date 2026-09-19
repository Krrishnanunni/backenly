/**
 * WHERE THE AUTH LIMITER'S COUNTERS ACTUALLY LIVE
 * ===============================================
 *
 * The limiter kept its counters in a per-process `Map`. That is a real control
 * on one process and none across several: an attacker reaching N instances gets
 * N budgets, so the effective limit on /api/auth/login and
 * /api/v1/{projectId}/auth/* is N times what it reads.
 *
 * `assertRateLimitStoreSupportsTopology` made that impossible to cross
 * unknowingly — a deployment declaring more than one instance with the memory
 * store refuses to boot. This is the other half: the shared store that lets a
 * deployment declare more than one instance and still enforce the limit it
 * prints.
 *
 * ── The two backends have the SAME window semantics, deliberately ───────────
 *
 * Both are fixed-window counters keyed on the same string, and both return the
 * same `RateLimitResult`. That is a requirement rather than a coincidence: if
 * Redis were a sliding window and memory a fixed one, moving a deployment onto
 * a shared store would silently change the effective limit, and the number in
 * AUTH_LIMITS would mean two different things depending on configuration.
 *
 * The Redis form is INCR plus PEXPIRE-on-first, in one Lua script so the two
 * cannot interleave. A counter that was INCRed without its expiry being set —
 * which is what happens when a process dies between two round trips — is a key
 * that never resets and locks the identity out for ever.
 *
 * ── Redis unavailable: FAIL CLOSED ──────────────────────────────────────────
 *
 * This is the deliberate decision the tranche called for, and it is the
 * uncomfortable one.
 *
 * Falling back to the in-memory store would be worse than it looks. A
 * deployment only reaches this code with `redis` declared, which means it
 * declared more than one instance, which means the fallback provides
 * (limit x instances) — the exact weakening the startup guard exists to
 * prevent, arriving silently at the moment an attacker is most likely to be
 * the reason Redis is under load. "Never silently revert from shared
 * protection to per-process" is the rule; this is where it would be broken.
 *
 * So a limiter that cannot reach its store denies. The cost is real and worth
 * stating plainly: a Redis outage takes sign-in down. It does not take the
 * data plane down, it is loud, it is in the logs, and it is recoverable in
 * minutes. An unlogged brute-force window is none of those things.
 *
 * The request timeout is deliberately short for the same reason. A limiter
 * that blocks for thirty seconds on a dead socket has taken sign-in down
 * anyway, just less legibly.
 */

import type { Redis } from 'ioredis'
import { declaredStoreKind, RateLimitStoreMisconfigured } from './rate-limit-store'

export interface RateLimitResult {
  allowed: boolean
  remaining: number
  /** Seconds the caller should wait. Belongs in a `Retry-After` header. */
  retryAfter: number
  /** Unix ms at which this window ends. */
  resetAt: number
}

export interface RateLimitBackend {
  consume(key: string, limit: number, windowMs: number): Promise<RateLimitResult>
  reset(key: string): Promise<void>
  /** Which store this is, for diagnostics and the startup report. */
  readonly kind: 'memory' | 'redis'
}

/** Denied, with a window's worth of wait. The shape every failure returns. */
function denied(windowMs: number): RateLimitResult {
  return {
    allowed: false,
    remaining: 0,
    retryAfter: Math.max(1, Math.ceil(windowMs / 1000)),
    resetAt: Date.now() + windowMs,
  }
}

// ── Memory ───────────────────────────────────────────────────────────────────

interface Bucket {
  count: number
  resetAt: number
}

export class MemoryRateLimitBackend implements RateLimitBackend {
  readonly kind = 'memory' as const
  private buckets = new Map<string, Bucket>()
  /** Soft cap; the sweep evicts oldest beyond it. */
  private static readonly MAX_KEYS = 50_000
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(sweep = true) {
    if (sweep && typeof setInterval !== 'undefined') {
      this.timer = setInterval(() => this.sweep(), 60_000)
      this.timer.unref?.()
    }
  }

  private sweep(): void {
    const now = Date.now()
    for (const [k, b] of Array.from(this.buckets.entries())) {
      if (b.resetAt < now) this.buckets.delete(k)
    }
    if (this.buckets.size > MemoryRateLimitBackend.MAX_KEYS) {
      const overflow = this.buckets.size - MemoryRateLimitBackend.MAX_KEYS
      for (const k of Array.from(this.buckets.keys()).slice(0, overflow)) this.buckets.delete(k)
    }
  }

  async consume(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
    const now = Date.now()
    const b = this.buckets.get(key)

    if (!b || b.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + windowMs })
      return { allowed: true, remaining: limit - 1, retryAfter: 0, resetAt: now + windowMs }
    }
    if (b.count >= limit) {
      return {
        allowed: false,
        remaining: 0,
        retryAfter: Math.max(1, Math.ceil((b.resetAt - now) / 1000)),
        resetAt: b.resetAt,
      }
    }
    b.count++
    return { allowed: true, remaining: limit - b.count, retryAfter: 0, resetAt: b.resetAt }
  }

  async reset(key: string): Promise<void> {
    this.buckets.delete(key)
  }

  /** Test seam: drop every counter and stop the sweep. */
  destroy(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.buckets.clear()
  }
}

// ── Redis ────────────────────────────────────────────────────────────────────

/**
 * INCR and PEXPIRE as one indivisible step, returning the count and the
 * remaining TTL.
 *
 * PTTL is read inside the script rather than as a second round trip, so the
 * `resetAt` reported to the caller belongs to the same window the count came
 * from. Two calls could straddle an expiry and report a count from the old
 * window with a TTL from the new one.
 *
 * The `< 0` guard covers a key that exists with no expiry — which should be
 * impossible given the branch above, and would be a permanent lockout if it
 * ever happened, so it repairs rather than trusts.
 */
const CONSUME_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {current, ttl}
`

export class RedisRateLimitBackend implements RateLimitBackend {
  readonly kind = 'redis' as const

  constructor(
    private readonly redis: Redis,
    /** Budget for one limiter round trip. See the fail-closed note above. */
    private readonly timeoutMs = 1_000,
  ) {}

  private async withTimeout<T>(op: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        op,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`rate limiter store did not answer in ${this.timeoutMs}ms`)),
            this.timeoutMs,
          )
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  async consume(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
    try {
      const [count, ttl] = (await this.withTimeout(
        this.redis.eval(CONSUME_SCRIPT, 1, key, String(windowMs)) as Promise<[number, number]>,
      )) as [number, number]

      const resetAt = Date.now() + Math.max(0, ttl)

      if (count > limit) {
        return {
          allowed: false,
          remaining: 0,
          retryAfter: Math.max(1, Math.ceil(ttl / 1000)),
          resetAt,
        }
      }
      return { allowed: true, remaining: Math.max(0, limit - count), retryAfter: 0, resetAt }
    } catch (err: any) {
      // FAIL CLOSED. Not a fallback to memory — see the header. The log line is
      // the point: this is an outage, and it must look like one.
      console.error(
        '[RateLimit] shared store unreachable, DENYING the request rather than ' +
          'falling back to per-process counters:',
        err?.message ?? err,
      )
      return denied(windowMs)
    }
  }

  async reset(key: string): Promise<void> {
    try {
      await this.withTimeout(this.redis.del(key))
    } catch (err: any) {
      // A failed reset leaves a counter that expires on its own. It makes the
      // limiter stricter, never weaker, so it is not worth failing a request
      // that has already succeeded.
      console.warn('[RateLimit] could not clear counter:', err?.message ?? err)
    }
  }
}

// ── Selection ────────────────────────────────────────────────────────────────

let backend: RateLimitBackend | null = null
let redisClient: Redis | null = null

/**
 * The ONE place a limiter Redis client is configured.
 *
 * Exported so the tests build their clients exactly the way production does.
 * A suite that constructs its own client with different options is not testing
 * the thing that ships, and this particular option set is where that bit.
 *
 * ── Why the offline queue is ON ─────────────────────────────────────────────
 *
 * The first version set `enableOfflineQueue: false`, reasoning that a limiter
 * must never block behind a reconnect. It does not do that. ioredis rejects
 * EVERY command issued before the connection is ready when the queue is off —
 * including its own HELLO handshake — so the first requests after startup, and
 * after any reconnect, failed instantly. Combined with failing closed, that is
 * an auth outage on every deploy, reported as a rate-limit denial.
 *
 * The queue is the correct behaviour: a command issued during a blip waits for
 * the socket and then runs. What must not happen is waiting FOREVER, and that
 * is `withTimeout`'s job, not the queue's. Bounded queueing plus a short
 * deadline gives the right answer in both cases — a reconnect is survived, a
 * dead store is denied in under a second.
 */
export function createRateLimitRedis(url: string): Redis {
  const { Redis: RedisCtor } = require('ioredis') as typeof import('ioredis')
  const client = new RedisCtor(url, {
    enableOfflineQueue: true,
    maxRetriesPerRequest: 1,
    connectTimeout: 5_000,
  })
  // Without a handler, a connection error is an unhandled 'error' event and
  // takes the process down — which would turn a Redis blip into a crash loop.
  client.on('error', err =>
    console.error('[RateLimit] redis connection error:', err?.message ?? err),
  )
  return client
}

/**
 * Build the backend the environment declares.
 *
 * Kept lazy so importing the limiter never opens a socket — a unit test, a
 * script or a build step that touches an auth module must not start
 * connecting to Redis as a side effect.
 */
export function getRateLimitBackend(): RateLimitBackend {
  if (backend) return backend

  if (declaredStoreKind() === 'redis') {
    const url = process.env.REDIS_URL?.trim()
    if (!url) {
      // Startup already refuses this. Reaching it here means the check was
      // bypassed, and guessing is not an option for a security control.
      throw new RateLimitStoreMisconfigured(
        'BACKENLY_RATE_LIMIT_STORE=redis requires REDIS_URL to be set.',
      )
    }
    redisClient = createRateLimitRedis(url)
    backend = new RedisRateLimitBackend(redisClient)
    return backend
  }

  backend = new MemoryRateLimitBackend()
  return backend
}

/** Test seam: replace the backend and forget any client. */
export function __setRateLimitBackend(next: RateLimitBackend | null): void {
  backend = next
}

/** Close the shared client, for a clean shutdown or a test teardown. */
export async function closeRateLimitBackend(): Promise<void> {
  if (redisClient) {
    await redisClient.quit().catch(() => redisClient?.disconnect())
    redisClient = null
  }
  if (backend && backend instanceof MemoryRateLimitBackend) backend.destroy()
  backend = null
}
