/**
 * THE GOVERNED EXECUTOR — the only thing that runs a maintenance ladder
 * =====================================================================
 *
 * Phase 5 plans and refuses. This runs what Phase 5 produced, one rung at a
 * time, and refuses far more often than it runs.
 *
 * ── Classification happens before every mutation, not once at the top ───────
 *
 * `classifyMaintenanceStep` is called immediately before each step mutates
 * anything, against the step about to run. Classifying the ladder once at the
 * start and trusting the result for the rest of it is the same mistake as
 * checking a permission at login: the interesting failures are the ones where
 * something changed in between. A deploy can land mid-ladder and move a
 * capability; the tier a step carries is a property of the step, and this asks
 * for it at the moment it matters.
 *
 * ── A ladder is all-or-nothing ──────────────────────────────────────────────
 *
 * A plan whose validity is `blocked_by_capability` does not run, including its
 * runnable prefix. `executablePrefix` exists for reporting and says so: running
 * the supported prefix of expand/contract leaves a new column nothing fills and
 * a dual-write that was never installed — a half-migrated schema that is worse
 * than the problem the plan was written to fix.
 *
 * ── What this does NOT own ──────────────────────────────────────────────────
 *
 *   retries and dead-lettering      BackgroundJob. A backfill is dispatched,
 *                                   not looped here. A second retry ladder
 *                                   would disagree with the first one.
 *   the mutation itself             `add_structure` goes through executeAction,
 *                                   the platform's one governed mutation path,
 *                                   with replanning OFF so a failed step cannot
 *                                   be turned into a different one.
 *   the approval decision           passed in. This checks that consent exists
 *                                   and matches THIS plan version; it never
 *                                   grants it.
 *   rollback                        recorded, never automatic. Undoing a failed
 *                                   rung is a decision with its own blast
 *                                   radius, and an executor that halts loudly
 *                                   is better than one that improvises.
 *
 * ── Mutations are off by default ────────────────────────────────────────────
 *
 * Mutations are gated by `FLAGS.ENABLE_PHASE_6B_MAINTENANCE_MUTATIONS`, which is
 * off by default, so reaching production is not the same event as executing
 * there. A run with it off still classifies every step, checks every gate and
 * writes the ledger — it just refuses at the write. That makes "would this
 * ladder have been allowed to run?" answerable against real production schemas
 * without anything running.
 *
 * `mutationsEnabled` on the input ANDs with the flag. A caller can narrow what
 * the environment permits and can never widen it.
 */

import { prisma } from '@/lib/db'
import { enqueue } from '@/lib/queue'
import { FLAGS } from '@/lib/config/flags'
import { isTierAutoAllowed, type AutonomyLevel } from '../autonomy-level'
import { approvalStillValid, isPlanStale, type MaintenancePlan } from './plan'
import {
  classifyMaintenanceStep,
  OPTIONAL_TERMINAL_STEPS,
  type MaintenanceStep,
  type MaintenanceStepKind,
} from './step'
import { installDualWrite } from './primitives/dual-write'
import { switchReaders, type SwitchedReader } from './primitives/switch-readers'
import { runVerify } from './primitives/verify'
import type { Transform } from './transform'

// ── Bindings: abstract plan params become concrete objects ───────────────────

/**
 * What a step operates on, in real identifiers.
 *
 * The planner deliberately emits abstract params (`{ tableName, purpose }`) and
 * never SQL. Bindings are how those become a real column, supplied by the
 * caller as typed data — not generated. There is no branch here that accepts a
 * SQL string, which is the whole point: the executor's vocabulary is closed, so
 * "what could this possibly run?" is answerable by reading this type.
 */
export type StepBinding =
  | { kind: 'add_structure'; verb: 'ADD_COLUMN'; table: string; column: string; columnType: string }
  | { kind: 'dual_write'; table: string; sourceColumn: string; targetColumn: string; transform: Transform }
  | {
      kind: 'backfill'
      table: string
      sourceColumn: string
      targetColumn: string
      transform: Transform
      batchRows?: number
      lockTimeoutMs?: number
    }
  | { kind: 'verify'; table: string; sourceColumn: string; targetColumn: string; transform: Transform }
  | { kind: 'switch_readers'; table: string; sourceColumn: string; targetColumn: string }

export interface ExecuteMaintenanceInput {
  plan: MaintenancePlan
  projectId: string
  /** The catalog as it is NOW. A plan built against a different one is stale. */
  currentCatalogFingerprint: string
  autonomyLevel: AutonomyLevel
  /** One binding per step, by ordinal. A step without one cannot run. */
  bindings: Record<number, StepBinding>
  /** The approved plan version, when an owner approved one. */
  approvedPlanVersion?: string | null
  approvalId?: string | null
  /**
   * Off unless BOTH this and the deployment flag say otherwise.
   *
   * Omitted, it falls back to `FLAGS.ENABLE_PHASE_6B_MAINTENANCE_MUTATIONS`,
   * which is itself off by default. Passing `true` does not override the flag:
   * a caller cannot enable mutations in an environment that has not enabled
   * them, which is what keeps "the code is deployed" and "it may write here"
   * separate decisions.
   */
  mutationsEnabled?: boolean
}

export type ExecutionStatus = 'completed' | 'halted' | 'refused'

export interface StepOutcome {
  ordinal: number
  kind: MaintenanceStepKind
  status: 'completed' | 'dispatched' | 'skipped' | 'failed' | 'awaiting_human'
  detail: string
  /** Set for a backfill, which continues under BackgroundJob. */
  backgroundJobId?: string
  /**
   * Set for a reader switch, carrying the previous code of everything moved.
   *
   * The observation window's revert restores these bytes, so they have to
   * survive the step that produced them — which is why they are on the outcome
   * and in the ledger row rather than held in memory.
   */
  switchedReaders?: SwitchedReader[]
}

export interface MaintenanceExecutionOutcome {
  status: ExecutionStatus
  executionId: string | null
  /** Why it stopped. Null only when every step completed. */
  haltReason: string | null
  steps: StepOutcome[]
}

// ── Gates ────────────────────────────────────────────────────────────────────

/**
 * Everything that must hold before the FIRST step runs.
 *
 * Returned as a reason rather than thrown, because a refusal is an outcome the
 * ledger records, not an error the caller handles.
 */
function refuseLadder(input: ExecuteMaintenanceInput): string | null {
  const { plan, autonomyLevel } = input

  if (plan.validity === 'invalid') return 'the plan is invalid and should not exist'
  if (plan.validity === 'blocked_by_capability') {
    return (
      `the ladder is blocked by capability (${plan.blockedReasons.join('; ')}); ` +
      'a ladder is all-or-nothing and its runnable prefix must not be executed'
    )
  }
  if (isPlanStale(plan, input.currentCatalogFingerprint)) {
    return 'the catalog moved since this plan was built, so its preconditions describe a schema that no longer exists'
  }

  // Tier is asked per step below as well; this is the up-front answer to "could
  // this ladder ever have been allowed", so a ladder needing consent it does not
  // have is refused before anything is written rather than halfway down.
  for (const step of plan.steps) {
    // A human-only terminal step is not this executor's to run, so it is not
    // this executor's to refuse over either. Sweeping it through the tier gate
    // would refuse every expand/contract ladder before the first rung, because
    // `contract` is Tier 3 and Tier 3 is never executed here.
    if (OPTIONAL_TERMINAL_STEPS.includes(step.kind)) continue

    const { tier } = classifyMaintenanceStep(step)
    const gate = tierGate(tier, autonomyLevel, input)
    if (gate) return `step ${step.ordinal} (${step.kind}): ${gate}`
    if (!input.bindings[step.ordinal]) return `step ${step.ordinal} (${step.kind}) has no binding`
    const binding = input.bindings[step.ordinal]
    if (binding.kind !== step.kind) {
      return `step ${step.ordinal} is ${step.kind} but its binding is ${binding.kind}`
    }
  }
  return null
}

/**
 * May a step of this tier run at all?
 *
 * Tier 0 and 1 are the dial's band. Tier 2 needs an approval bound to THIS plan
 * version — `isTierAutoAllowed` hard-denies it regardless of level, and no
 * argument from this module changes that. Tier 3 is irreversible and this
 * executor never runs one: not with an approval, not at any level.
 */
function tierGate(tier: number, level: AutonomyLevel, input: ExecuteMaintenanceInput): string | null {
  if (tier >= 3) {
    return 'tier 3 is irreversible and is never executed here, approval or not'
  }
  if (tier >= 2) {
    if (!input.approvedPlanVersion) return 'tier 2 requires an approval and none was supplied'
    if (!approvalStillValid(input.plan, input.approvedPlanVersion)) {
      return 'the approval is for a different plan version, so it does not authorize this ladder'
    }
    return null
  }
  if (!isTierAutoAllowed(level, tier as 0 | 1)) {
    return `the autonomy level ${level} does not permit tier ${tier}`
  }
  return null
}

// ── Execution ────────────────────────────────────────────────────────────────

/**
 * Run a maintenance plan, or record exactly why it did not run.
 *
 * Resumable: a step already recorded `completed` under its idempotency key is
 * skipped rather than repeated, so an executor that died mid-ladder does not
 * apply a rung twice on restart.
 */
export async function executeMaintenancePlan(
  input: ExecuteMaintenanceInput,
): Promise<MaintenanceExecutionOutcome> {
  const { plan, projectId } = input
  // AND, not OR. The caller may narrow what the environment permits; it may
  // never widen it.
  const mutationsEnabled =
    (input.mutationsEnabled ?? true) && FLAGS.ENABLE_PHASE_6B_MAINTENANCE_MUTATIONS

  const refusal = refuseLadder(input)
  if (refusal) {
    const execution = await openExecution(input, 'refused', refusal)
    return { status: 'refused', executionId: execution, haltReason: refusal, steps: [] }
  }

  const executionId = await openExecution(input, 'running', null)
  const steps: StepOutcome[] = []

  for (const step of plan.steps) {
    // Reached, recorded, and left for a person. Not executed, not skipped
    // silently, and not a halt: the ladder did everything software may do.
    if (OPTIONAL_TERMINAL_STEPS.includes(step.kind)) {
      steps.push({
        ordinal: step.ordinal,
        kind: step.kind,
        status: 'awaiting_human',
        detail: `${step.kind} is performed by a person; ${classifyMaintenanceStep(step).reason}`,
      })
      continue
    }

    // Immediately before mutating. Not once at the top.
    const classification = classifyMaintenanceStep(step)

    if (!classification.executable) {
      return halt(executionId, steps, `step ${step.ordinal} (${step.kind}) is ${classification.capability}`)
    }
    const gate = tierGate(classification.tier, input.autonomyLevel, input)
    if (gate) return halt(executionId, steps, `step ${step.ordinal} (${step.kind}): ${gate}`)

    const existing = await prisma.maintenanceStepExecution.findUnique({
      where: { idempotencyKey: step.idempotencyKey },
    })
    if (existing?.status === 'completed') {
      steps.push({ ordinal: step.ordinal, kind: step.kind, status: 'skipped', detail: 'already applied' })
      continue
    }

    const binding = input.bindings[step.ordinal]
    const isMutation = step.kind !== 'verify'
    if (isMutation && !mutationsEnabled) {
      return halt(
        executionId,
        steps,
        `step ${step.ordinal} (${step.kind}) would mutate and mutations are disabled for this run`,
      )
    }

    const row = await prisma.maintenanceStepExecution.upsert({
      where: { idempotencyKey: step.idempotencyKey },
      create: {
        executionId,
        stepId: String(step.ordinal),
        stepKind: step.kind,
        ordinal: step.ordinal,
        idempotencyKey: step.idempotencyKey,
        status: 'running',
        startedAt: new Date(),
        preconditionEvidence: { declared: step.preconditions, classification: { ...classification } },
        rollback: step.rollbackSpec ? { ...step.rollbackSpec } : undefined,
      },
      update: { status: 'running', startedAt: new Date() },
    })

    let outcome: StepOutcome
    try {
      outcome = await runStep(projectId, step, binding, plan.planVersion)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await prisma.maintenanceStepExecution.update({
        where: { id: row.id },
        data: { status: 'failed', completedAt: new Date(), result: { error: message } },
      })
      steps.push({ ordinal: step.ordinal, kind: step.kind, status: 'failed', detail: message })
      return halt(executionId, steps, `step ${step.ordinal} (${step.kind}) threw: ${message}`)
    }

    await prisma.maintenanceStepExecution.update({
      where: { id: row.id },
      data: {
        status: outcome.status === 'failed' ? 'failed' : outcome.status,
        completedAt: new Date(),
        backgroundJobId: outcome.backgroundJobId ?? null,
        postconditionEvidence: { declared: step.expectedPostconditions, detail: outcome.detail },
        // Through JSON so the ledger stores plain data. `switchedReaders`
        // carries the bytes a revert restores, so it has to land in the row
        // rather than only in the return value.
        result: JSON.parse(JSON.stringify(outcome)),
      },
    })
    steps.push(outcome)

    if (outcome.status === 'failed') {
      // No substitution, no continuation, no automatic undo. The rollback spec
      // is on the row; acting on it is a separate decision.
      return halt(executionId, steps, `step ${step.ordinal} (${step.kind}) failed: ${outcome.detail}`)
    }
  }

  await prisma.maintenanceExecution.update({
    where: { id: executionId },
    data: { status: 'completed', completedAt: new Date() },
  })
  return { status: 'completed', executionId, haltReason: null, steps }
}

/** One rung. Every branch is a named primitive; there is no default case. */
async function runStep(
  projectId: string,
  step: MaintenanceStep,
  binding: StepBinding,
  planVersion: string,
): Promise<StepOutcome> {
  const base = { ordinal: step.ordinal, kind: step.kind }

  switch (binding.kind) {
    case 'add_structure': {
      const { executeAction } = await import('@/lib/ai/minimal-executor')
      const result = await executeAction(
        {
          action: binding.verb,
          params: { tableName: binding.table, columnName: binding.column, columnType: binding.columnType },
        } as any,
        projectId,
        undefined,
        0,
        undefined,
        // Deterministic. A maintenance step that fails must not be replanned
        // into a different action — that is how a failed CREATE_INDEX once got
        // reported as a fix that never happened.
        false,
      )
      return result.success
        ? { ...base, status: 'completed', detail: result.message || `${binding.verb} applied` }
        : { ...base, status: 'failed', detail: result.message || `${binding.verb} failed` }
    }

    case 'dual_write': {
      const r = await installDualWrite({ projectId, ...binding })
      return r.installed
        ? { ...base, status: 'completed', detail: `trigger ${r.objectName} installed` }
        : { ...base, status: 'failed', detail: r.refusal ?? 'dual-write refused' }
    }

    case 'backfill': {
      // Dispatched, not run. BackgroundJob owns attempts, backoff and
      // dead-lettering; looping here would be a second retry lifecycle
      // disagreeing with the first.
      const job = await enqueue(
        'maintenance_backfill',
        {
          projectId,
          planVersion,
          idempotencyKey: step.idempotencyKey,
          table: binding.table,
          sourceColumn: binding.sourceColumn,
          targetColumn: binding.targetColumn,
          transform: binding.transform,
          batchRows: binding.batchRows,
          lockTimeoutMs: binding.lockTimeoutMs,
          cursor: null,
        },
        { projectId },
      )
      return { ...base, status: 'dispatched', detail: `backfill queued as job ${job.id}`, backgroundJobId: job.id }
    }

    case 'switch_readers': {
      const r = await switchReaders({ projectId, ...binding })
      if (r.refusal) return { ...base, status: 'failed', detail: r.refusal }
      // Reported on every switch, not only when it is zero. The consumers that
      // cannot be enumerated are the reason `contract` stays human-only, and a
      // summary that omitted them would read like the cutover was complete.
      return {
        ...base,
        status: 'completed',
        detail:
          `${r.switched.length} Backenly-authored reader(s) switched; ` +
          `${r.inventory.unobservable.length} consumer class(es) cannot be enumerated and still read ` +
          `${binding.table}.${binding.sourceColumn}`,
        switchedReaders: r.switched,
      }
    }

    case 'verify': {
      const r = await runVerify({ projectId, ...binding, planIdentity: planVersion })
      // `halt` and `failed` are both "do not proceed", and the detail says which
      // one it was: a rung that disagreed, or a rung that demonstrated nothing.
      return r.mayProceed
        ? { ...base, status: 'completed', detail: r.summary }
        : { ...base, status: 'failed', detail: `${r.outcome}: ${r.summary}` }
    }
  }
}

async function openExecution(
  input: ExecuteMaintenanceInput,
  status: string,
  haltReason: string | null,
): Promise<string> {
  const { plan } = input
  const row = await prisma.maintenanceExecution.create({
    data: {
      projectId: input.projectId,
      findingId: plan.findingId,
      planId: plan.planId,
      // The ledger column is an Int; planVersion is a content hash, so the
      // version pair that must be unique is (planId, planVersion) and the
      // integer is a monotonic attempt counter for this plan.
      planVersion: await nextAttempt(plan.planId),
      catalogFingerprint: plan.catalogFingerprint,
      approvalId: input.approvalId ?? null,
      tier: String(Math.max(...plan.steps.map(s => classifyMaintenanceStep(s).tier), 0)),
      status,
      haltReason,
      startedAt: status === 'running' ? new Date() : null,
      completedAt: status === 'refused' ? new Date() : null,
    },
  })
  return row.id
}

async function nextAttempt(planId: string): Promise<number> {
  const last = await prisma.maintenanceExecution.findFirst({
    where: { planId },
    orderBy: { planVersion: 'desc' },
    select: { planVersion: true },
  })
  return (last?.planVersion ?? 0) + 1
}

async function halt(
  executionId: string,
  steps: StepOutcome[],
  reason: string,
): Promise<MaintenanceExecutionOutcome> {
  await prisma.maintenanceExecution.update({
    where: { id: executionId },
    data: { status: 'halted', haltReason: reason, completedAt: new Date() },
  })
  return { status: 'halted', executionId, haltReason: reason, steps }
}
