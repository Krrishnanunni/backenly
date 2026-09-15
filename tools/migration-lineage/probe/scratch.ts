/**
 * Scratch databases and intact SQL replay.
 *
 * Replay is the only DDL the lineage probe runs, and it runs only inside a
 * database this module created a moment earlier under a name no real database
 * can have. Every guard is checked against the server, not against the name the
 * caller asked for.
 */

import { createHash, randomBytes } from 'node:crypto'
import type { PgClient } from './connect'

export type ScratchPurpose = 'chain' | 'push' | 'rlsctl'

export const SCRATCH_NAME = /^backenly_lineage_(chain|push|rlsctl)_[0-9a-f]{8}$/
const RESERVED = new Set(['backenly', 'postgres', 'rdsadmin', 'template0', 'template1'])

export function scratchName(purpose: ScratchPurpose, suffix = randomBytes(4).toString('hex')): string {
  const name = `backenly_lineage_${purpose}_${suffix}`
  assertScratchName(name)
  return name
}

export function assertScratchName(name: string): void {
  if (!SCRATCH_NAME.test(name) || RESERVED.has(name)) {
    throw new Error(`refusing to treat ${JSON.stringify(name)} as a scratch database`)
  }
}

export interface ScratchCleanup {
  name: string
  created: boolean
  dropped: boolean
  error: string | null
}

/**
 * Create a scratch database, run `body` against its name, and drop it whatever
 * happened. The cleanup outcome is returned rather than logged, so a caller
 * cannot report success while a database it created still exists.
 */
export async function withScratchDatabase<T>(
  admin: PgClient,
  purpose: ScratchPurpose,
  body: (name: string) => Promise<T>,
): Promise<{ value: T | null; error: string | null; cleanup: ScratchCleanup }> {
  const name = scratchName(purpose)
  const cleanup: ScratchCleanup = { name, created: false, dropped: false, error: null }

  const [{ current }] = (await admin.query('SELECT current_database() AS current')).rows
  if (current === name) throw new Error('refusing: scratch name equals the connected database')
  const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])
  if (exists.rowCount) throw new Error(`refusing: database ${name} already exists`)

  // Identifiers cannot be bound as parameters. `name` has passed SCRATCH_NAME,
  // which admits only [a-z0-9_], so quoting it is sufficient.
  await admin.query(`CREATE DATABASE "${name}"`)
  cleanup.created = true

  let value: T | null = null
  let error: string | null = null
  try {
    value = await body(name)
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  } finally {
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
      const still = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])
      cleanup.dropped = still.rowCount === 0
      if (!cleanup.dropped) cleanup.error = 'database still present after DROP'
    } catch (err) {
      cleanup.error = err instanceof Error ? err.message : String(err)
    }
  }
  return { value, error, cleanup }
}

/** Every lineage scratch database on the instance, from this run or any other. */
export async function listScratchDatabases(admin: PgClient): Promise<string[]> {
  const { rows } = await admin.query(
    "SELECT datname FROM pg_database WHERE datname LIKE 'backenly\\_lineage\\_%' ORDER BY 1",
  )
  return rows.map(r => r.datname as string)
}

export interface ReplayFile {
  name: string
  sql: string
}

export interface ReplayStep {
  name: string
  sha256: string
  bytes: number
  ok: boolean
  ms: number
  error?: { code: string | null; message: string; position: number | null; near: string | null }
}

export interface ReplayReport {
  database: string
  status: 'complete' | 'failed'
  applied: number
  total: number
  steps: ReplayStep[]
}

/**
 * Replay SQL files in order, each submitted whole.
 *
 * `client.query(text)` with no parameters uses the simple query protocol, which
 * accepts several statements in one message and runs them as one implicit
 * transaction. That is what lets a dollar-quoted PL/pgSQL body with semicolons
 * inside it arrive unchanged. The files are never split.
 *
 * Replay stops at the first failure, because every later file may depend on
 * the one that failed; continuing would describe a database no history produced.
 */
export async function replayFiles(client: PgClient, files: ReplayFile[]): Promise<ReplayReport> {
  const [{ database }] = (await client.query('SELECT current_database() AS database')).rows
  assertScratchName(database)

  const steps: ReplayStep[] = []
  for (const file of files) {
    if (/_prisma_migrations/i.test(file.sql)) {
      throw new Error(`${file.name} references _prisma_migrations; this probe never creates a migration ledger`)
    }
    const bytes = Buffer.byteLength(file.sql, 'utf8')
    const sha256 = createHash('sha256').update(file.sql, 'utf8').digest('hex')
    const t0 = Date.now()
    try {
      await client.query(file.sql)
      steps.push({ name: file.name, sha256, bytes, ok: true, ms: Date.now() - t0 })
    } catch (err) {
      const e = err as { code?: string; message?: string; position?: string }
      const position = e.position ? Number(e.position) : null
      steps.push({
        name: file.name,
        sha256,
        bytes,
        ok: false,
        ms: Date.now() - t0,
        error: {
          code: e.code ?? null,
          message: e.message ?? String(err),
          position,
          near: position ? file.sql.slice(Math.max(0, position - 80), position + 40).replace(/\s+/g, ' ') : null,
        },
      })
      break
    }
  }

  const applied = steps.filter(s => s.ok).length
  return { database, status: applied === files.length ? 'complete' : 'failed', applied, total: files.length, steps }
}
