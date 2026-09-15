/**
 * The staging acceptance gate, exactly as docs/managed-db-migration-findings.md
 * fixed it in advance.
 *
 *   STAGING_BASELINE_ELIGIBLE only if
 *     objects in P missing from C, or defined differently in C   = 0
 *     AND every semantic C-only object is attributed to a known cause
 *     AND unexplained_divergence                                 = 0
 *     AND every capture and replay the verdict depends on is conclusive
 *
 * Inability to compare is never success: a missing capture or an incomplete
 * replay produces INCONCLUSIVE, which is a different answer from "nothing
 * unexplained was found".
 *
 * The verdict is scoped to staging. It authorises designing and rehearsing a
 * staging baseline, nothing about production.
 */

import { countByBucket, type Attribution } from './attribute'
import type { Difference } from './diff'

export type Verdict = 'STAGING_BASELINE_ELIGIBLE' | 'RECONCILIATION_REQUIRED' | 'INCONCLUSIVE'

export interface Evidence {
  /** The tls-rls task's verdict; anything but PASS makes every later read suspect. */
  tlsRls: string | null
  /** Whether C was captured read-only and completely. */
  captureStaging: boolean
  /** Replay outcomes: 'complete' is the only conclusive one. */
  chainReplay: string | null
  pushReplay: string | null
  /** Every replayed file matched the hash recorded for it. */
  inputsVerified: boolean
}

export interface GateResult {
  verdict: Verdict
  reasons: string[]
  counts: {
    missingFromStaging: number
    definedDifferently: number
    extraInStaging: number
    buckets: ReturnType<typeof countByBucket>
  }
}

export function gate(pToC: Difference[], attributions: Attribution[], evidence: Evidence): GateResult {
  const missingFromStaging = pToC.filter(d => d.status === 'missing_in_right').length
  const definedDifferently = pToC.filter(d => d.status === 'differs').length
  const extraInStaging = pToC.filter(d => d.status === 'extra_in_right').length
  const buckets = countByBucket(attributions)

  const inconclusive: string[] = []
  if (evidence.tlsRls !== 'PASS') inconclusive.push(`the TLS and RLS visibility gate is ${evidence.tlsRls ?? 'absent'}, not PASS`)
  if (!evidence.captureStaging) inconclusive.push('staging was not captured')
  if (evidence.pushReplay !== 'complete') inconclusive.push(`the schema.prisma projection replay is ${evidence.pushReplay ?? 'absent'}`)
  if (!evidence.inputsVerified) inconclusive.push('a replayed file did not match its recorded hash')
  // A is historical evidence and does not gate the staging comparison, but an
  // incomplete chain replay means the A to P report below it is partial.
  if (evidence.chainReplay !== 'complete' && evidence.chainReplay !== null) {
    inconclusive.push(`the legacy chain replay is ${evidence.chainReplay} (reported, not gating)`)
  }

  const blocking = inconclusive.filter(r => !r.includes('not gating'))
  if (blocking.length > 0) {
    return { verdict: 'INCONCLUSIVE', reasons: blocking, counts: { missingFromStaging, definedDifferently, extraInStaging, buckets } }
  }

  const reasons: string[] = []
  if (missingFromStaging > 0) reasons.push(`${missingFromStaging} object(s) the current model requires are missing from staging`)
  if (definedDifferently > 0) reasons.push(`${definedDifferently} object(s) are defined differently in staging`)
  if (buckets.unexplained_divergence > 0) reasons.push(`${buckets.unexplained_divergence} staging object(s) are unexplained`)

  return {
    verdict: reasons.length === 0 ? 'STAGING_BASELINE_ELIGIBLE' : 'RECONCILIATION_REQUIRED',
    reasons,
    counts: { missingFromStaging, definedDifferently, extraInStaging, buckets },
  }
}
