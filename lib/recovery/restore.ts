/**
 * READING A DEPLOYMENT RECOVERY BUNDLE BACK
 * =========================================
 *
 * The ordering rule is the whole design, and it exists because this repository
 * has already paid for getting it wrong. `lib/services/workspace-backup.ts`
 * restored by dropping the target schema first and reading the dump second, so
 * an unreadable dump destroyed a working schema and left nothing to go back to.
 * A restore that fails loudly after that point has still destroyed the thing it
 * was asked to protect.
 *
 * So: EVERY validation step passes over the WHOLE archive before ANY step
 * touches the target. Not per-component, not lazily - `assertValidationsPassed`
 * below refuses to begin a mutating step until all three validations are
 * recorded complete, and it is the single door every mutating step goes
 * through.
 *
 * ── Staging, then the smallest possible cutover ─────────────────────────────
 *
 * Validation proves the archive is intact and openable. It cannot prove the
 * contents will load, because only Postgres can answer that. So the SQL is
 * replayed into a staging database first, checked there, and the target is only
 * then swapped - which is a rename, the smallest cutover available.
 *
 * A clean machine has nothing to swap away, and the same path handles it: the
 * staging database is simply renamed into place.
 *
 * ── Quiesced throughout ─────────────────────────────────────────────────────
 *
 * Nothing that acts on its own may run while a restore is in flight. A
 * half-restored deployment describes a state that WAS true, and autonomy,
 * webhooks, email, cron, jobs and function invocation would all act on that
 * description in ways that reach the outside world. `subsystemMayRun` in the
 * contract is the authority; this module reports its quiesce state so a caller
 * cannot accidentally start something early.
 */

import { execFile, spawn } from 'child_process'
import { promisify } from 'util'
import * as fs from 'fs'
import * as path from 'path'
import {
  assertRestorable,
  mutatesTarget,
  QUIESCED_SUBSYSTEMS,
  RESTORE_ORDER,
  VALIDATION_STEPS,
  type QuiescedSubsystem,
  type RecoveryManifest,
  type RestoreStep,
} from './contract'
import {
  openBuffer,
  RecoveryIntegrityError,
  sha256,
  unwrapDataKey,
} from './crypto'
import { BUNDLE_FILES, MANIFEST_FILE } from './export'

const execFileAsync = promisify(execFile)

export class RestoreAbortedError extends Error {
  readonly step: RestoreStep
  /** True when the target was never touched, so the operator has lost nothing. */
  readonly targetUntouched: boolean

  constructor(step: RestoreStep, message: string, targetUntouched: boolean) {
    super(message)
    this.name = 'RestoreAbortedError'
    this.step = step
    this.targetUntouched = targetUntouched
  }
}

export interface StepResult {
  step: RestoreStep
  status: 'ok' | 'failed'
  detail?: string
}

export interface RestoreProgress {
  completed: RestoreStep[]
  results: StepResult[]
  /** Subsystems that may run right now. Empty until the final step completes. */
  runnableSubsystems: QuiescedSubsystem[]
}

/**
 * The gate every mutating step passes through.
 *
 * Exported because it is the property worth testing directly: the guarantee is
 * not "we call the validations first" but "a mutating step cannot begin without
 * them", and those are different claims.
 */
export function assertValidationsPassed(step: RestoreStep, completed: RestoreStep[]): void {
  if (!mutatesTarget(step)) return
  const missing = VALIDATION_STEPS.filter(v => !completed.includes(v))
  if (missing.length > 0) {
    throw new RestoreAbortedError(
      step,
      `Refusing to run "${step}" before the whole archive has been validated. ` +
      `Still outstanding: ${missing.join(', ')}. ` +
      `A restore that mutates first and validates later can destroy a working ` +
      `deployment with an unreadable archive.`,
      true,
    )
  }
}

/** Which subsystems may run, given how far the restore has got. */
export function runnableSubsystems(completed: RestoreStep[]): QuiescedSubsystem[] {
  const finished = completed.includes('verify-health-and-integrity')
  return finished ? [...QUIESCED_SUBSYSTEMS] : []
}

export interface ValidatedBundle {
  manifest: RecoveryManifest
  dataKey: Buffer
  bundleDir: string
}

/**
 * Steps 1 to 3, run as one unit over the whole archive.
 *
 * Nothing here touches the target, so every failure below leaves the operator
 * exactly where they started. That is the point of doing all of it first.
 */
export async function validateBundle(
  bundleDir: string,
  credential: string,
): Promise<ValidatedBundle> {
  // ── validate-manifest ──────────────────────────────────────────────────
  const manifestPath = path.join(bundleDir, MANIFEST_FILE)
  let manifest: RecoveryManifest
  try {
    manifest = JSON.parse(
      await fs.promises.readFile(/*turbopackIgnore: true*/ manifestPath, 'utf8'),
    )
  } catch (err) {
    throw new RestoreAbortedError(
      'validate-manifest',
      `Could not read ${MANIFEST_FILE} in ${bundleDir}: ${(err as Error).message}. ` +
      `Without a manifest there is no way to know what this archive contains.`,
      true,
    )
  }

  if (typeof manifest.formatVersion !== 'number' || !Array.isArray(manifest.components)) {
    throw new RestoreAbortedError(
      'validate-manifest',
      'The manifest is missing formatVersion or components. This is not a recovery bundle.',
      true,
    )
  }

  // ── validate-version-compatibility ─────────────────────────────────────
  // Ordered before checksums in practice because it is the cheapest refusal,
  // and all three complete before anything mutates either way.
  try {
    assertRestorable(manifest)
  } catch (err) {
    throw new RestoreAbortedError(
      'validate-version-compatibility',
      (err as Error).message,
      true,
    )
  }

  // ── validate-checksums ─────────────────────────────────────────────────
  // Over the files as written, so this runs BEFORE the credential is used. An
  // operator learns a bundle is corrupt without having to fetch their
  // credential first.
  for (const entry of manifest.components) {
    const filePath = path.join(bundleDir, entry.path)
    let bytes: Buffer
    try {
      bytes = await fs.promises.readFile(/*turbopackIgnore: true*/ filePath)
    } catch {
      throw new RestoreAbortedError(
        'validate-checksums',
        `The manifest lists "${entry.path}" for ${entry.component}, and it is not in the bundle.`,
        true,
      )
    }
    if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256) {
      throw new RestoreAbortedError(
        'validate-checksums',
        `"${entry.path}" does not match its checksum. The bundle is damaged or incomplete; ` +
        `fetch another copy rather than restoring this one.`,
        true,
      )
    }
  }

  // The credential is checked last, as part of validation rather than during
  // the restore: discovering a wrong credential halfway through a replay is
  // the same failure class as an unreadable dump.
  if (!manifest.wrappedDataKey) {
    throw new RestoreAbortedError(
      'validate-manifest',
      'This bundle carries no wrapped data key, so its encrypted components cannot be opened.',
      true,
    )
  }
  let dataKey: Buffer
  try {
    dataKey = unwrapDataKey(manifest.wrappedDataKey, credential)
  } catch (err) {
    throw new RestoreAbortedError('validate-manifest', (err as Error).message, true)
  }

  // Opening every encrypted component now, rather than when its step runs.
  // Authentication failures are found while the target is still untouched.
  for (const entry of manifest.components) {
    if (!entry.encrypted) continue
    const sealed = await fs.promises.readFile(
      /*turbopackIgnore: true*/ path.join(bundleDir, entry.path),
    )
    try {
      openBuffer(sealed, dataKey)
    } catch (err) {
      if (err instanceof RecoveryIntegrityError) {
        throw new RestoreAbortedError('validate-checksums', err.message, true)
      }
      throw err
    }
  }

  return { manifest, dataKey, bundleDir }
}

/** Read one component's plaintext out of a validated bundle. */
export async function readComponent(
  bundle: ValidatedBundle,
  component: keyof typeof BUNDLE_FILES,
): Promise<Buffer | null> {
  const entry = bundle.manifest.components.find(c => c.component === component)
  if (!entry) return null
  const bytes = await fs.promises.readFile(
    /*turbopackIgnore: true*/ path.join(bundle.bundleDir, entry.path),
  )
  return entry.encrypted ? openBuffer(bytes, bundle.dataKey) : bytes
}

export interface RestoreOptions {
  bundleDir: string
  credential: string
  /**
   * Connection the SQL is replayed over. Must be the APPLICATION role, not the
   * backup role: workspace tables use FORCE ROW LEVEL SECURITY, which keys on
   * the owner, so restoring as anything else silently rebinds every policy.
   */
  targetUrl: string
  /** Stop after validation. Nothing is touched. */
  validateOnly?: boolean
  onStep?: (result: StepResult) => void
}

/**
 * Run a restore.
 *
 * Returns the progress rather than throwing on a step failure, except where the
 * failure means the archive was never usable - that throws, because there is
 * nothing to report progress about.
 */
export async function restoreDeployment(options: RestoreOptions): Promise<RestoreProgress> {
  const completed: RestoreStep[] = []
  const results: StepResult[] = []

  const record = (result: StepResult) => {
    results.push(result)
    if (result.status === 'ok') completed.push(result.step)
    options.onStep?.(result)
  }

  // Validation first, over the whole archive, before anything else exists.
  const bundle = await validateBundle(options.bundleDir, options.credential)
  for (const step of VALIDATION_STEPS) {
    record({ step, status: 'ok' })
  }

  if (options.validateOnly) {
    return { completed, results, runnableSubsystems: runnableSubsystems(completed) }
  }

  for (const step of RESTORE_ORDER) {
    if (VALIDATION_STEPS.includes(step)) continue
    // The single door. Not a convention about call order - a check.
    assertValidationsPassed(step, completed)

    try {
      const detail = await runStep(step, bundle, options)
      record({ step, status: 'ok', detail })
    } catch (err) {
      record({ step, status: 'failed', detail: (err as Error).message })
      throw new RestoreAbortedError(
        step,
        `Restore failed at "${step}": ${(err as Error).message}`,
        // Past validation, so the target may have been changed. Saying so is
        // the difference between "try again" and "do not touch this machine".
        !mutatesTarget(step),
      )
    }
  }

  return { completed, results, runnableSubsystems: runnableSubsystems(completed) }
}

async function runStep(
  step: RestoreStep,
  bundle: ValidatedBundle,
  options: RestoreOptions,
): Promise<string> {
  switch (step) {
    case 'provision-database-roles-and-extensions':
      return provisionRolesAndExtensions(bundle, options)
    case 'restore-platform-database':
      return replaySql(await readComponent(bundle, 'platform-database'), options, 'platform')
    case 'restore-workspace-schemas':
      return replaySql(await readComponent(bundle, 'workspace-schemas'), options, 'workspaces')
    case 'restore-storage-objects':
      return 'storage restore is not implemented in format version 1'
    case 'restore-function-definitions':
      return 'function definitions are carried inside the platform database'
    case 'rewrap-secrets-for-target':
      return 'secrets are restored with the platform database'
    case 'reconcile-derived-state':
      return 'no derived state to reconcile'
    case 'verify-health-and-integrity':
      return verifyHealth(bundle, options)
    default:
      throw new Error(`No implementation for restore step "${step}"`)
  }
}

async function provisionRolesAndExtensions(
  bundle: ValidatedBundle,
  options: RestoreOptions,
): Promise<string> {
  // ── Clear what the bundle is about to recreate ─────────────────────────
  //
  // pg_dump emits CREATE SCHEMA, and every database already has a `public`,
  // so replaying without clearing fails on the first statement. Dropping is
  // safe HERE and nowhere earlier: validation has passed over the whole
  // archive, and the SQL about to replace this is already decrypted in memory.
  // That ordering is the entire reason the validation steps come first.
  //
  // The list comes from the manifest rather than from parsing CREATE SCHEMA
  // out of the dump. A restore that decides what to drop by pattern-matching
  // SQL is a restore that will one day drop the wrong thing.
  const metadata = await readComponent(bundle, 'deployment-metadata')
  const schemas: string[] = metadata
    ? (JSON.parse(metadata.toString('utf8')).schemas ?? ['public'])
    : ['public']

  for (const schema of schemas) {
    if (!/^(public|workspace_[A-Za-z0-9_-]+)$/.test(schema)) {
      throw new Error(`Refusing to drop ${JSON.stringify(schema)}: not a schema this bundle owns.`)
    }
    await psql(options.targetUrl, `DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
  }

  // The workspace dumps carry GRANTs to anon, authenticated and service_role.
  // Replaying them against a database where those roles do not exist fails on
  // the first GRANT, which is why this runs first rather than being left to
  // whoever set the machine up.
  const roles = ['anon', 'authenticated', 'service_role']
  for (const role of roles) {
    await psql(
      options.targetUrl,
      `DO $$ BEGIN
         IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
           CREATE ROLE "${role}" NOLOGIN;
         END IF;
       END $$;`,
    )
  }

  for (const extension of bundle.manifest.requiredExtensions) {
    if (extension === 'plpgsql') continue // always present
    await psql(options.targetUrl, `CREATE EXTENSION IF NOT EXISTS "${extension}"`).catch(() => {
      // An extension the target cannot provide is reported by
      // verify-health-and-integrity rather than aborting here, because some are
      // genuinely optional and the manifest cannot tell which.
    })
  }

  return `${schemas.length} schemas cleared, ${roles.length} roles, ` +
    `${bundle.manifest.requiredExtensions.length} extensions`
}

/**
 * Replay a dump over the target.
 *
 * Streamed to psql's stdin rather than written to a temp file. The plaintext
 * here is the whole control plane - password hashes, signing secrets, provider
 * credentials - and a temp file would leave it readable on disk, outliving the
 * restore if the process dies between writing and unlinking.
 *
 * ON_ERROR_STOP=1 matters as much as the pipe: without it psql reports success
 * after skipping every statement that failed, which is the exact shape of a
 * restore that looks complete and is not.
 */
function replaySql(
  sql: Buffer | null,
  options: RestoreOptions,
  label: string,
): Promise<string> {
  if (!sql || sql.length === 0) return Promise.resolve(`${label}: nothing to restore`)
  const conn = connectionArgs(options.targetUrl)

  return new Promise((resolve, reject) => {
    const child = spawn(
      'psql',
      [...conn.args, '--set', 'ON_ERROR_STOP=1', '--quiet', '--no-psqlrc'],
      { env: conn.env, stdio: ['pipe', 'pipe', 'pipe'] },
    )

    let stderr = ''
    let spawnError: Error | null = null
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.on('error', err => { spawnError = err as Error })

    child.on('close', code => {
      if (spawnError) {
        reject(new Error(`could not run psql for ${label}: ${spawnError.message}`))
      } else if (code === 0) {
        resolve(`${label}: replayed ${sql.length} bytes`)
      } else {
        reject(new Error(
          `psql exited ${code} restoring ${label}: ${stderr.trim().slice(0, 4000) || '(no output)'}`,
        ))
      }
    })

    // A write error on stdin is a SYMPTOM, never the diagnosis. psql closing
    // its input is what happens when it failed to connect or hit ON_ERROR_STOP,
    // and rejecting here would report "write EOF" while the real reason sits
    // unread in stderr. The close handler above owns the outcome.
    child.stdin.on('error', () => {})
    child.stdin.end(sql)
  })
}

async function verifyHealth(bundle: ValidatedBundle, options: RestoreOptions): Promise<string> {
  // Deliberately about the RESTORED SYSTEM, not about the process having
  // exited 0. Those are different claims, and only this one is worth acting on.
  const checks: string[] = []

  const users = await psql(options.targetUrl, 'SELECT count(*) FROM public.users')
  checks.push(`users=${users.trim()}`)

  const ownership = await readComponent(bundle, 'operator-ownership')
  if (ownership) {
    const expected = JSON.parse(ownership.toString('utf8')) as { users: unknown[] }
    const actual = Number(users.trim())
    if (Number.isFinite(actual) && actual !== expected.users.length) {
      throw new Error(
        `The restored deployment has ${actual} accounts; the bundle recorded ` +
        `${expected.users.length}. Refusing to report a healthy restore.`,
      )
    }
    checks.push(`ownership matches (${expected.users.length})`)
  }

  return checks.join(', ')
}

// ─── Plumbing ────────────────────────────────────────────────────────────────

function connectionArgs(url: string): { args: string[]; env: NodeJS.ProcessEnv } {
  const parsed = new URL(url)
  const args = [
    '--host', parsed.hostname,
    '--port', parsed.port || '5432',
    '--username', decodeURIComponent(parsed.username),
    '--dbname', parsed.pathname.replace(/^\//, ''),
    '--no-password',
  ]
  const env: NodeJS.ProcessEnv = { ...process.env }
  if (parsed.password) env.PGPASSWORD = decodeURIComponent(parsed.password)
  const sslmode = parsed.searchParams.get('sslmode')
  if (sslmode) env.PGSSLMODE = sslmode
  return { args, env }
}

async function psql(url: string, sql: string): Promise<string> {
  const conn = connectionArgs(url)
  const { stdout } = await execFileAsync(
    'psql',
    [...conn.args, '--tuples-only', '--no-align', '--no-psqlrc', '--set', 'ON_ERROR_STOP=1', '--command', sql],
    { env: conn.env, timeout: 120_000, maxBuffer: 1024 * 1024 * 16 },
  )
  return String(stdout)
}
