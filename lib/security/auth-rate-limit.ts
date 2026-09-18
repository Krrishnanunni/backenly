/**
 * Auth-surface rate limiting.
 *
 * IP + identifier (email) composite limits, in-memory store with periodic GC.
 * Designed to be cheap (no DB round-trip on hot path) and safe (fail closed on
 * config errors). For multi-instance production we accept some slop — each
 * instance keeps its own counters; the underlying threat (brute force across
 * one connection) is what matters, not perfect cross-pod accounting.
 *
 * ── KNOWN LIMIT: the store is per-process ───────────────────────────────────
 *
 * That slop is acceptable for the platform auth surface and it is NOT a
 * complete answer for the end-user surface below. An attacker who can reach
 * more than one instance gets a fresh budget from each, so the effective limit
 * is (limit x instances).
 *
 * Today that is bounded: self-host is a single process, and the Cloud task
 * definition runs desired_count = 1. It stops being true the moment either is
 * scaled, and scaling is not a security decision anybody would think to
 * review. `checkRateLimitRedis` in lib/middleware/rateLimiter.ts is the
 * intended shared-store replacement and is currently commented out.
 *
 * Recorded here rather than silently assumed, because a control that quietly
 * weakens when someone raises a replica count is worse than one whose limit is
 * written down.
 *
 * Returns a structured result. Routes should 429 on `allowed === false` and
 * include the `retryAfter` in the `Retry-After` header.
 */

interface Bucket {
  count: number
  resetAt: number
}

const buckets = new Map<string, Bucket>()
const MAX_KEYS = 50_000 // soft cap; oldest get evicted

// Periodic sweep so the map never grows unbounded even under burst load.
if (typeof setInterval !== 'undefined') {
  const sweep = () => {
    const now = Date.now()
    for (const [k, b] of Array.from(buckets.entries())) {
      if (b.resetAt < now) buckets.delete(k)
    }
    // Hard ceiling: evict oldest if we somehow blow past the soft cap
    if (buckets.size > MAX_KEYS) {
      const overflow = buckets.size - MAX_KEYS
      const keys = Array.from(buckets.keys()).slice(0, overflow)
      for (const k of keys) buckets.delete(k)
    }
  }
  setInterval(sweep, 60_000).unref?.()
}

export interface RateLimitResult {
  allowed: boolean
  remaining: number
  retryAfter: number // seconds
  resetAt: number    // unix ms
}

/**
 * Consume one token from the bucket identified by `key`.
 * Returns whether the action is allowed and how long to wait if not.
 */
export function consume(key: string, limit: number, windowMs: number): RateLimitResult {
  if (limit <= 0 || windowMs <= 0) {
    // Misconfiguration — fail closed (deny). Better to throw 429 than to
    // silently disable a security control because someone passed limit=0.
    return { allowed: false, remaining: 0, retryAfter: 60, resetAt: Date.now() + 60_000 }
  }
  const now = Date.now()
  const b = buckets.get(key)
  if (!b || b.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs })
    return { allowed: true, remaining: limit - 1, retryAfter: 0, resetAt: now + windowMs }
  }
  if (b.count >= limit) {
    return { allowed: false, remaining: 0, retryAfter: Math.ceil((b.resetAt - now) / 1000), resetAt: b.resetAt }
  }
  b.count++
  return { allowed: true, remaining: limit - b.count, retryAfter: 0, resetAt: b.resetAt }
}

/**
 * Reset a key (e.g. on successful login — drop the failed-attempts counter).
 */
export function reset(key: string): void {
  buckets.delete(key)
}

/**
 * Best-effort client IP. Trusts X-Forwarded-For only when behind a known proxy.
 * Falls back to 'unknown' which still works as a coarse bucket.
 */
export function clientIp(request: { headers: { get: (n: string) => string | null } }): string {
  const xff = request.headers.get('x-forwarded-for')
  if (xff) {
    const first = xff.split(',')[0]?.trim()
    if (first) return first
  }
  const real = request.headers.get('x-real-ip')
  if (real) return real.trim()
  return 'unknown'
}

// ── Preset policies — pick one per surface to keep things consistent ────────

export const AUTH_LIMITS = {
  // Login is handled in /api/auth/login itself (already IP-limited).
  // These cover the surfaces that weren't previously protected.
  forgotPassword: { ip: { limit: 5, windowMs: 15 * 60_000 }, email: { limit: 3, windowMs: 60 * 60_000 } },
  resetPassword: { ip: { limit: 10, windowMs: 15 * 60_000 } },
  signup:        { ip: { limit: 10, windowMs: 60 * 60_000 } },
  verifyEmail:   { ip: { limit: 20, windowMs: 60 * 60_000 } },
  twoFactor:     { ip: { limit: 10, windowMs: 15 * 60_000 } },
  oauthCallback: { ip: { limit: 20, windowMs: 15 * 60_000 } },

  // ── The END-USER auth surface, /api/v1/{projectId}/auth/* ────────────────
  //
  // These had no throttling of any kind. They are unauthenticated by design -
  // they are how a customer's own users sign in - but the platform's
  // /api/auth/login has IP brute-force protection and account lockout, and the
  // end-user equivalent had neither. That left credential stuffing against
  // every end user of every project unthrottled.
  //
  // Keyed per project as well as per IP, so one project under attack cannot
  // lock out sign-in for a different project sharing an egress address, and a
  // single IP cannot spend one global budget across every tenant.
  endUserSignin:  { ip: { limit: 10, windowMs: 15 * 60_000 } },
  endUserSignup:  { ip: { limit: 10, windowMs: 60 * 60_000 } },
  endUserRecover: { ip: { limit: 5,  windowMs: 15 * 60_000 } },
} as const

/**
 * Convenience: check both IP and identifier limits, deny if either trips.
 */
export function consumeComposite(
  ipKey: string,
  ipPolicy: { limit: number; windowMs: number },
  identifierKey?: string,
  identifierPolicy?: { limit: number; windowMs: number },
): RateLimitResult {
  const ipResult = consume(ipKey, ipPolicy.limit, ipPolicy.windowMs)
  if (!ipResult.allowed) return ipResult
  if (identifierKey && identifierPolicy) {
    const idResult = consume(identifierKey, identifierPolicy.limit, identifierPolicy.windowMs)
    if (!idResult.allowed) return idResult
  }
  return ipResult
}
