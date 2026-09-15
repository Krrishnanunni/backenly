/**
 * LAYER 3 REHEARSAL — establish migration history on an existing database and
 * prove it changed nothing.
 *
 *   LINEAGE_LOCAL_DATABASE_URL=postgresql://user:pass@localhost:5432/db \
 *     npx tsx tools/managed-db/rehearse-baseline.ts [--out file.json]
 *
 * This is the operation we intend to perform on staging, rehearsed on a scratch
 * database first. Staging already HAS the canonical schema and no history, so
 * the rehearsal recreates exactly that shape: materialise the schema without
 * history, then baseline it.
 *
 * The property under test is not "_prisma_migrations has rows". It is:
 *
 *     establishing history on an already-correct database causes ZERO
 *     semantic schema change
 *
 * so the catalog is captured before and after and compared with the same
 * semantic diff the lineage investigation used. A forward migration is then
 * applied to prove the result is a working migration system rather than a
 * static ledger that merely looks clean.
 *
 * Loopback only. Everything happens inside a scratch database that is dropped in
 * `finally`, and the run reports any that remain.
 */

import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { diffSnapshots, type Difference } from '../migration-lineage/diff'
import { captureSnapshot, type Snapshot } from '../migration-lineage/probe/capture'
import { clientConfig, connect, isLoopback, parseDatabaseUrl, type PgClient } from '../migration-lineage/probe/connect'
import { platformSchemas } from '../migration-lineage/probe/inventory'
import { BASELINE_ID, BASELINE_SQL_PATH } from './generate-baseline'
import { assembleMigrationWorkspace } from './migration-workspace'
import { listScratchDatabases, withScratchDatabase } from './scratch-database'
import { readFileSync } from 'node:fs'

const FIXTURE_ID = '20260916000000_rehearsal_fixture'
const FIXTURE_SQL = 'CREATE TABLE "_baseline_rehearsal_fixture" ("id" TEXT NOT NULL, CONSTRAINT "_baseline_rehearsal_fixture_pkey" PRIMARY KEY ("id"));\n'

export interface PrismaRun {
  command: string
  exitCode: number
  stdout: string
}

export interface BaselineRehearsalResult {
  rehearsal: 'layer3-baseline'
  version: 1
  startedAt: string
  finishedAt: string
  verdict: 'PASS' | 'FAIL' | 'INCONCLUSIVE'
  failures: string[]
  database: string | null
  runs: PrismaRun[]
  historyRows: Array<{ migration_name: string; applied_steps_count: number; finished: boolean }>
  semanticDelta: Difference[]
  /** Objects the migration ledger itself introduced, reported not hidden. */
  ledgerObjects: string[]
  forward: { applied: boolean; artifactPresent: boolean; secondDeployNoOp: boolean } | null
  scratchDatabasesAfter: string[] | null
  error: string | null
}

function prisma(root: string, schemaPath: string, url: string, args: string[]): PrismaRun {
  const cli = join(root, 'node_modules', 'prisma', 'build', 'index.js')
  const command = `prisma ${args.join(' ')}`
  try {
    const stdout = execFileSync(process.execPath, [cli, ...args, '--schema', schemaPath], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url, PRISMA_HIDE_UPDATE_MESSAGE: '1' },
    })
    return { command, exitCode: 0, stdout: stdout.trim() }
  } catch (err) {
    const e = err as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string }
    return {
      command,
      exitCode: e.status ?? 1,
      stdout: `${String(e.stdout ?? '')}${String(e.stderr ?? '')}`.trim(),
    }
  }
}

const NO_PENDING = /No pending migrations|Database schema is up to date/i

export async function rehearseBaseline(root: string, adminUrl: string): Promise<BaselineRehearsalResult> {
  const r: BaselineRehearsalResult = {
    rehearsal: 'layer3-baseline',
    version: 1,
    startedAt: new Date().toISOString(),
    finishedAt: '',
    verdict: 'INCONCLUSIVE',
    failures: [],
    database: null,
    runs: [],
    historyRows: [],
    semanticDelta: [],
    ledgerObjects: [],
    forward: null,
    scratchDatabasesAfter: null,
    error: null,
  }

  const { target } = parseDatabaseUrl(adminUrl)
  if (!isLoopback(target.host)) throw new Error('the baseline rehearsal runs against a loopback database only')
  const policy = { mode: 'loopback-plaintext' as const }
  const admin = await connect(clientConfig(target, policy))
  // Two workspaces on purpose. The baselining phase must see ONLY the canonical
  // history, or the first `migrate deploy` applies the fixture and the no-op it
  // is supposed to prove never happens.
  const workspace = assembleMigrationWorkspace(root)
  const forwardWorkspace = assembleMigrationWorkspace(root, [{ id: FIXTURE_ID, sql: FIXTURE_SQL }])

  try {
    const out = await withScratchDatabase(admin, 'base', async name => {
      r.database = name
      const url = (() => {
        const u = new URL(adminUrl)
        u.pathname = `/${name}`
        return u.toString()
      })()

      const client: PgClient = await connect(clientConfig(target, policy, { database: name }))
      try {
        // Staging's shape: the canonical schema present, no migration history.
        const baselineSql = readFileSync(join(root, BASELINE_SQL_PATH), 'utf8')
        await client.query(baselineSql)
        const before = await captureSnapshot(client, await platformSchemas(client))

        // The intended mechanism for an existing database: mark the baseline
        // applied rather than running it.
        r.runs.push(prisma(root, workspace.schemaPath, url, ['migrate', 'resolve', '--applied', BASELINE_ID]))
        r.runs.push(prisma(root, workspace.schemaPath, url, ['migrate', 'status']))
        r.runs.push(prisma(root, workspace.schemaPath, url, ['migrate', 'deploy']))
        r.runs.push(prisma(root, workspace.schemaPath, url, ['migrate', 'deploy']))

        const after = await captureSnapshot(client, await platformSchemas(client))
        // `_prisma_migrations` is the history being introduced, not a change to
        // the canonical schema. It is excluded from the delta and asserted
        // separately, so introducing it cannot be mistaken for drift and
        // cannot be hidden either.
        const all = diffSnapshots(before, after)
        r.semanticDelta = all.filter(d => !/_prisma_migrations/.test(d.key))
        r.ledgerObjects = all.filter(d => /_prisma_migrations/.test(d.key)).map(d => d.key)

        const history = await client.query(
          'SELECT migration_name, applied_steps_count, finished_at IS NOT NULL AS finished FROM _prisma_migrations ORDER BY migration_name',
        )
        r.historyRows = history.rows as BaselineRehearsalResult['historyRows']

        // A working migration system, not a static ledger: the fixture appears
        // only now, in its own workspace.
        const forwardDeploy = prisma(root, forwardWorkspace.schemaPath, url, ['migrate', 'deploy'])
        r.runs.push(forwardDeploy)
        const artifact = await client.query(
          "SELECT to_regclass('public._baseline_rehearsal_fixture') IS NOT NULL AS present",
        )
        const secondForward = prisma(root, forwardWorkspace.schemaPath, url, ['migrate', 'deploy'])
        r.runs.push(secondForward)

        return {
          before,
          after,
          forward: {
            applied: forwardDeploy.exitCode === 0,
            artifactPresent: artifact.rows[0]?.present === true,
            secondDeployNoOp: secondForward.exitCode === 0 && NO_PENDING.test(secondForward.stdout),
          },
        }
      } finally {
        await client.end().catch(() => {})
      }
    })

    if (out.error) r.failures.push(`rehearsal did not complete: ${out.error}`)
    r.forward = out.value?.forward ?? null
    if (out.cleanup.created && !out.cleanup.dropped) {
      r.failures.push(`scratch database ${out.cleanup.name} was not dropped: ${out.cleanup.error}`)
    }
    r.scratchDatabasesAfter = await listScratchDatabases(admin)
  } catch (err) {
    r.error = err instanceof Error ? err.message : String(err)
    r.failures.push(`rehearsal error: ${r.error}`)
  } finally {
    workspace.dispose()
    forwardWorkspace.dispose()
    await admin.end().catch(() => {})
  }

  const [resolve, status, deploy, deployAgain] = r.runs
  if (resolve?.exitCode !== 0) r.failures.push(`migrate resolve failed: ${resolve?.stdout}`)
  if (status?.exitCode !== 0) r.failures.push(`migrate status is not clean: ${status?.stdout}`)
  if (deploy?.exitCode !== 0 || !NO_PENDING.test(deploy?.stdout ?? '')) {
    r.failures.push(`migrate deploy after baselining was not a no-op: ${deploy?.stdout}`)
  }
  if (deployAgain?.exitCode !== 0 || !NO_PENDING.test(deployAgain?.stdout ?? '')) {
    r.failures.push(`the second migrate deploy was not a no-op: ${deployAgain?.stdout}`)
  }
  if (r.semanticDelta.length > 0) {
    r.failures.push(`baselining changed ${r.semanticDelta.length} schema object(s); it must change none`)
  }
  if (!r.historyRows.some(h => h.migration_name === BASELINE_ID && h.finished)) {
    r.failures.push('the baseline is not recorded as applied in _prisma_migrations')
  }
  if (r.ledgerObjects.length === 0) {
    r.failures.push('no migration ledger was introduced; the baseline did not take effect')
  }
  if (r.forward && !(r.forward.applied && r.forward.artifactPresent && r.forward.secondDeployNoOp)) {
    r.failures.push(`the forward migration did not behave: ${JSON.stringify(r.forward)}`)
  }
  if (r.scratchDatabasesAfter?.length) {
    r.failures.push(`scratch databases still exist: ${r.scratchDatabasesAfter.join(', ')}`)
  }

  r.finishedAt = new Date().toISOString()
  r.verdict = r.failures.length ? 'FAIL' : 'PASS'
  return r
}

async function main(): Promise<void> {
  const url = process.env.LINEAGE_LOCAL_DATABASE_URL
  if (!url) {
    console.error('LINEAGE_LOCAL_DATABASE_URL is not set')
    process.exit(2)
  }
  const result = await rehearseBaseline(process.cwd(), url)

  console.log(`\n  layer 3 baseline rehearsal: ${result.verdict}  (scratch ${result.database})`)
  for (const f of result.failures) console.log(`    FAIL  ${f}`)
  for (const run of result.runs) {
    console.log(`    ${String(run.exitCode).padEnd(2)} ${run.command.padEnd(34)} ${run.stdout.split('\n').filter(Boolean).slice(-1)[0] ?? ''}`)
  }
  console.log(`    history       ${JSON.stringify(result.historyRows)}`)
  console.log(`    semantic delta ${result.semanticDelta.length} (canonical schema)`)
  console.log(`    ledger objects ${result.ledgerObjects.length}`)
  console.log(`    forward       ${JSON.stringify(result.forward)}`)
  console.log(`    leftovers     ${JSON.stringify(result.scratchDatabasesAfter)}`)

  const i = process.argv.indexOf('--out')
  if (i > 0 && process.argv[i + 1]) writeFileSync(process.argv[i + 1], JSON.stringify(result, null, 2))
  process.exitCode = result.verdict === 'PASS' ? 0 : 1
}

if (require.main === module) main().catch(err => { console.error(err); process.exitCode = 1 })
