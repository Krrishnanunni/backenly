/**
 * ONE SHAPE FOR EVERY THROTTLED ANSWER
 * ====================================
 *
 * `lib/security/auth-rate-limit.ts` has said this since it was written:
 *
 *     Routes should 429 on `allowed === false` and include the `retryAfter`
 *     in the `Retry-After` header.
 *
 * Not one route did. Every one of them computed `retryAfter`, discarded it,
 * and returned a bare 429 — so a legitimate client that tripped a limit had no
 * way to know whether to come back in one second or fifteen minutes, and
 * retried blindly into the same wall. The contract was written down and never
 * held anywhere, which is the argument for a helper rather than a review note.
 *
 * ── The message never varies with what the server knows ─────────────────────
 *
 * A throttled answer must not become an oracle. The same text and the same
 * headers go back whether the limit that tripped was keyed on an address that
 * exists or one that does not, because a 429 that only appears for real
 * accounts tells an attacker which addresses are real — and the recovery
 * routes went to some trouble to avoid exactly that.
 *
 * So callers pass a result, not a reason.
 */

import { NextResponse } from 'next/server'
import type { RateLimitResult } from './rate-limit-backend'

/** What every throttled surface says. Deliberately free of detail. */
export const THROTTLED_MESSAGE = 'Too many attempts. Please try again later.'

/**
 * Headers describing when the caller may return.
 *
 * `Retry-After` is the standard one and is what clients and proxies act on.
 * The `X-RateLimit-*` pair is conventional rather than standard, and is here
 * because an operator debugging their own integration should not have to
 * reverse-engineer the window from timing.
 */
export function rateLimitHeaders(result: RateLimitResult): Record<string, string> {
  return {
    'Retry-After': String(Math.max(1, result.retryAfter)),
    'X-RateLimit-Remaining': String(Math.max(0, result.remaining)),
    'X-RateLimit-Reset': String(Math.ceil(result.resetAt / 1000)),
  }
}

/** The v1 end-user error envelope, with the headers attached. */
export function throttledV1Response(result: RateLimitResult, code = 'RATE_LIMIT_EXCEEDED'): NextResponse {
  return NextResponse.json(
    { error: { code, message: THROTTLED_MESSAGE } },
    { status: 429, headers: rateLimitHeaders(result) },
  )
}

/** The platform error envelope, with the headers attached. */
export function throttledPlatformResponse(result: RateLimitResult): NextResponse {
  return NextResponse.json(
    { error: THROTTLED_MESSAGE },
    { status: 429, headers: rateLimitHeaders(result) },
  )
}
