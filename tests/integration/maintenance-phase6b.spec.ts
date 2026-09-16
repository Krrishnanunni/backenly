/**
 * PHASE 6b AGAINST A REAL ENGINE — expand, backfill, and catch it when it lies
 * ============================================================================
 *
 * The executor's governance is decided in TypeScript and is tested in
 * tests/unit/maintenance-executor.spec.ts with everything mocked. This is the
 * other half: the three primitives it calls generate SQL, and nothing about
 * whether that SQL is correct can be learned without PostgreSQL running it.
 *
 * What has no meaning without an engine:
 *
 *   - whether the trigger body compiles at all, and fires on INSERT and UPDATE
 *   - whether the two renderings of a transform actually evaluate the same
 *   - whether the backfill's cursor orders an INTEGER key correctly, which text
 *     comparison would not
 *   - whether a swallowed trigger exception leaves the customer's write intact
 *   - and the one that matters most: whether reconciliation CATCHES a dual-write
 *     that silently wrote nothing
 *
 * That last case is the reason reconcile.ts was built before anything that
 * mutates. A trigger that fails quietly and a trigger that works both report
 * zero faults, so the test asserts the failure is detected by the checker rather
 * than by the thing being checked.
 *
 * Runs against its own schema, created and dropped here, under a project id no
 * Workspace row exists for — so `resolveWorkspaceSchema` takes its documented
 * fallback and the primitives address the same schema this file builds.
 */

import { randomUUID } from 'node:crypto'
import { prisma } from '@/lib/db'
import {
  dualWriteInstalled,
  dualWriteObjectName,
  installDualWrite,
  readDualWriteFaults,
  removeDualWrite,
} from '@/lib/autonomy/maintenance/primitives/dual-write'
import { runBackfillBatch } from '@/lib/autonomy/maintenance/primitives/backfill'
import { runVerify } from '@/lib/autonomy/maintenance/primitives/verify'
import {
  transformLiteralSql,
  transformSql,
  TRANSFORM_KINDS,
  type Transform,
} from '@/lib/autonomy/maintenance/transform'

jest.setTimeout(180_000)

const PROJECT_ID = randomUUID()
const SCHEMA = `workspace_${PROJECT_ID}`
const q = (sql: string) => prisma.$executeRawUnsafe(sql)
const rows = <T = any>(sql: string) => prisma.$queryRawUnsafe<T[]>(sql)

beforeAll(async () => {
  await q(`CREATE SCHEMA "${SCHEMA}"`)
  await q(`CREATE TABLE "${SCHEMA}"."sessions" (id uuid PRIMARY KEY, status text, state text)`)
  // Deliberately includes a NULL: NULL on both sides must AGREE, and NULL on
  // one side only must be a mismatch.
  await q(`INSERT INTO "${SCHEMA}"."sessions" (id, status) VALUES
    (gen_random_uuid(), 'active'),
    (gen_random_uuid(), 'archived'),
    (gen_random_uuid(), 'active'),
    (gen_random_uuid(), NULL),
    (gen_random_uuid(), 'pending')`)
})

afterAll(async () => {
  await q(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`).catch(() => {})
  await prisma.$disconnect().catch(() => {})
})

const UPPER: Transform = { kind: 'upper' }
const verify = (over: Partial<Parameters<typeof runVerify>[0]> = {}) =>
  runVerify({
    projectId: PROJECT_ID,
    table: 'sessions',
    sourceColumn: 'status',
    targetColumn: 'state',
    transform: UPPER,
    planIdentity: 'plan-v1',
    ...over,
  })

// ── The transform renders identically, as PostgreSQL evaluates it ────────────

describe('the two renderings agree when PostgreSQL evaluates them', () => {
  const SAMPLES: Record<string, Transform> = {
    identity: { kind: 'identity' },
    lower: { kind: 'lower' },
    upper: { kind: 'upper' },
    trim: { kind: 'trim' },
    value_map: { kind: 'value_map', map: { active: 'ACTIVE', "it's": 'QUOTED' } },
    null_to: { kind: 'null_to', value: "un'known" },
  }

  it.each(TRANSFORM_KINDS)('evaluates %s the same way parameterised and literal', async kind => {
    const t = SAMPLES[kind]
    // Every input the vocabulary distinguishes, including NULL and a value the
    // map does not list.
    for (const value of ['active', ' Padded ', "it's", null]) {
      const params: unknown[] = [value]
      const parameterised = transformSql(t, '$1::text', params)
      const literal = transformLiteralSql(t, value === null ? 'NULL::text' : `'${value.replace(/'/g, "''")}'`)

      const r = await prisma.$queryRawUnsafe<Array<{ a: string | null; b: string | null }>>(
        `SELECT (${parameterised}) AS a, (${literal}) AS b`,
        ...params,
      )
      expect({ kind, value, parameterised: r[0].a }).toEqual({ kind, value, parameterised: r[0].b })
    }
  })
})

// ── Expand ───────────────────────────────────────────────────────────────────

describe('the dual-write trigger', () => {
  it('refuses an identifier it cannot find, before any DDL runs', async () => {
    const r = await installDualWrite({
      projectId: PROJECT_ID,
      table: 'sessions',
      sourceColumn: 'no_such_column',
      targetColumn: 'state',
      transform: UPPER,
    })
    expect(r).toMatchObject({ installed: false })
    expect(r.refusal).toMatch(/does not exist/)
    expect(await dualWriteInstalled(PROJECT_ID, 'sessions', r.objectName)).toBe(false)
  })

  it('installs, and is actually in the catalog', async () => {
    const r = await installDualWrite({
      projectId: PROJECT_ID,
      table: 'sessions',
      sourceColumn: 'status',
      targetColumn: 'state',
      transform: UPPER,
    })
    expect(r).toMatchObject({ installed: true, refusal: null })
    // Asked of pg_trigger, not inferred from CREATE TRIGGER's silence.
    expect(await dualWriteInstalled(PROJECT_ID, 'sessions', r.objectName)).toBe(true)
  })

  it('fills the target on INSERT and follows it on UPDATE', async () => {
    await q(`INSERT INTO "${SCHEMA}"."sessions" (id, status) VALUES (gen_random_uuid(), 'fresh')`)
    const inserted = await rows(`SELECT status, state FROM "${SCHEMA}"."sessions" WHERE status = 'fresh'`)
    expect(inserted[0]).toEqual({ status: 'fresh', state: 'FRESH' })

    await q(`UPDATE "${SCHEMA}"."sessions" SET status = 'moved' WHERE status = 'fresh'`)
    const updated = await rows(`SELECT status, state FROM "${SCHEMA}"."sessions" WHERE status = 'moved'`)
    expect(updated[0]).toEqual({ status: 'moved', state: 'MOVED' })

    await q(`DELETE FROM "${SCHEMA}"."sessions" WHERE status = 'moved'`)
  })

  it('leaves the pre-existing rows alone, so the table is knowingly inconsistent', async () => {
    // The whole point of the ladder: expand does not touch history. Until the
    // backfill runs, the two columns genuinely disagree — and the checker has
    // to say so, or it would never say so about anything.
    const r = await verify()
    expect(r.outcome).toBe('failed')
    expect(r.mayProceed).toBe(false)
    expect(r.reconciliation.mismatchedRows).toBeGreaterThan(0)
  })
})

// ── Backfill ─────────────────────────────────────────────────────────────────

describe('the backfill', () => {
  it('advances in bounded batches and finishes the table', async () => {
    let cursor: string | null = null
    let done = false
    let batches = 0
    let updated = 0

    while (!done && batches < 20) {
      const r: any = await runBackfillBatch(
        { projectId: PROJECT_ID, table: 'sessions', sourceColumn: 'status', targetColumn: 'state', transform: UPPER, batchRows: 2 },
        cursor,
      )
      expect(r.refusal).toBeNull()
      cursor = r.cursor
      done = r.done
      updated += r.updated
      batches++
    }

    // More than one batch, so the batching is real and not a single sweep.
    expect(batches).toBeGreaterThan(1)
    expect(done).toBe(true)
    expect(updated).toBeGreaterThan(0)
  })

  it('makes the columns agree, and the checker now says so', async () => {
    const r = await verify()
    expect(r.outcome).toBe('passed')
    expect(r.mayProceed).toBe(true)
    // NULL on both sides agrees, so the row with a NULL status is compared and
    // counted rather than skipped.
    expect(r.reconciliation.comparedRows).toBeGreaterThanOrEqual(5)
    expect(r.reconciliation.mismatchedRows).toBe(0)
    expect(r.reconciliation.coverage.complete).toBe(true)
  })

  it('is idempotent: a second pass writes nothing but still completes', async () => {
    const r = await runBackfillBatch(
      { projectId: PROJECT_ID, table: 'sessions', sourceColumn: 'status', targetColumn: 'state', transform: UPPER, batchRows: 1000 },
      null,
    )
    expect(r).toMatchObject({ updated: 0, done: true, refusal: null })
    // Scanned, not written. A cursor that only advanced past written rows would
    // never move here, and the job would re-scan this window forever.
    expect(r.scanned).toBeGreaterThan(0)
  })

  it('orders an integer key numerically, not as text', async () => {
    // The bug this guards: comparing a cursor as text puts '10' before '9', so
    // a paged backfill would skip most of the table and report a clean finish.
    await q(`CREATE TABLE "${SCHEMA}"."numbered" (id int PRIMARY KEY, status text, state text)`)
    await q(`INSERT INTO "${SCHEMA}"."numbered" (id, status)
             SELECT g, 'row' || g FROM generate_series(1, 12) g`)

    let cursor: string | null = null
    let done = false
    let guard = 0
    while (!done && guard++ < 30) {
      const r: any = await runBackfillBatch(
        { projectId: PROJECT_ID, table: 'numbered', sourceColumn: 'status', targetColumn: 'state', transform: UPPER, batchRows: 3 },
        cursor,
      )
      expect(r.refusal).toBeNull()
      cursor = r.cursor
      done = r.done
    }

    const missed = await rows<{ n: bigint }>(
      `SELECT count(*)::bigint AS n FROM "${SCHEMA}"."numbered" WHERE state IS DISTINCT FROM upper(status)`,
    )
    expect(Number(missed[0].n)).toBe(0)
  })

  it('refuses a table it cannot resume through', async () => {
    await q(`CREATE TABLE "${SCHEMA}"."composite" (a int, b int, status text, state text, PRIMARY KEY (a, b))`)
    const r = await runBackfillBatch(
      { projectId: PROJECT_ID, table: 'composite', sourceColumn: 'status', targetColumn: 'state', transform: UPPER },
      null,
    )
    // A composite key has no single ordering column, so this is a refusal
    // rather than a guess at which part to page by.
    expect(r.refusal).toMatch(/no single-column primary key/)
    expect(r.updated).toBe(0)
  })
})

// ── The failure the checker exists for ───────────────────────────────────────

describe('a dual-write that fails silently', () => {
  const OBJ = () => dualWriteObjectName('narrow', 'state')

  beforeAll(async () => {
    // A target too small for the value the transform produces. The trigger will
    // raise, swallow it, and leave the target unset.
    await q(`CREATE TABLE "${SCHEMA}"."narrow" (id uuid PRIMARY KEY, status text, state varchar(3))`)
    await installDualWrite({
      projectId: PROJECT_ID,
      table: 'narrow',
      sourceColumn: 'status',
      targetColumn: 'state',
      transform: UPPER,
    })
  })

  it('does not abort the customer write', async () => {
    // This is the mitigation working: the application's INSERT succeeds even
    // though the maintenance trigger could not do its job.
    await expect(
      q(`INSERT INTO "${SCHEMA}"."narrow" (id, status) VALUES (gen_random_uuid(), 'far-too-long')`),
    ).resolves.toBeDefined()

    const r = await rows(`SELECT status, state FROM "${SCHEMA}"."narrow"`)
    expect(r[0]).toEqual({ status: 'far-too-long', state: null })
  })

  it('is caught by reconciliation, which is the only thing that catches it', async () => {
    const r = await runVerify({
      projectId: PROJECT_ID,
      table: 'narrow',
      sourceColumn: 'status',
      targetColumn: 'state',
      transform: UPPER,
      planIdentity: 'plan-v1',
    })
    expect(r.outcome).toBe('failed')
    expect(r.mayProceed).toBe(false)
    expect(r.reconciliation.mismatchedRows).toBe(1)
  })

  it('recorded a fault, which is telemetry and not the verdict', async () => {
    const faults = await readDualWriteFaults(PROJECT_ID, OBJ())
    expect(faults?.faults).toBeGreaterThan(0)
    expect(faults?.lastError).toBeTruthy()
    // Stated as a property, not an aside: the previous test found the problem
    // without reading this number, and a trigger writing a WRONG value would
    // leave this at zero while reconciliation still failed.
  })
})

// ── Rollback ─────────────────────────────────────────────────────────────────

describe('removing the dual-write', () => {
  it('drops the trigger and confirms it is gone', async () => {
    const r = await removeDualWrite(PROJECT_ID, 'sessions', 'state')
    expect(r).toMatchObject({ removed: true, refusal: null })
    expect(await dualWriteInstalled(PROJECT_ID, 'sessions', r.objectName)).toBe(false)
  })

  it('leaves the target column, which add_structure owns and rolls back separately', async () => {
    const cols = await rows<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = '${SCHEMA}' AND table_name = 'sessions' AND column_name = 'state'`,
    )
    expect(cols).toHaveLength(1)
  })

  it('stops maintaining the column once removed', async () => {
    await q(`INSERT INTO "${SCHEMA}"."sessions" (id, status) VALUES (gen_random_uuid(), 'after-removal')`)
    const r = await rows(`SELECT state FROM "${SCHEMA}"."sessions" WHERE status = 'after-removal'`)
    // Non-vacuity for the removal: the trigger really is not running any more.
    expect(r[0]).toEqual({ state: null })
  })
})
