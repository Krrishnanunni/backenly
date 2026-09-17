/**
 * ONE COMMAND, FROM A FRESH CLONE TO A RUNNING DEPLOYMENT
 * ======================================================
 *
 *   npm run selfhost
 *
 * WHY THIS EXISTS
 * ---------------
 * Supabase self-hosted is `git clone && docker compose up -d`. Backenly was
 * five documented steps: edit five secrets into .env by hand, run a reconciler
 * whose first run is EXPECTED to exit 3, run two superuser scripts, copy a
 * generated password back into .env, start a fourth container, then rerun the
 * reconciler. Every one of those steps is defensible on its own. Together they
 * were the largest honest gap against Supabase, and the one a new operator hits
 * before seeing anything the product does.
 *
 * This runs that same sequence. It does not replace it or route around it:
 *
 *   - the prerequisite chain comes from scripts/bootstrap-prerequisites.ts,
 *     which is the module bootstrap prints from and README.md is tested
 *     against. A step added there is executed here without being re-typed, so
 *     the installer cannot drift from the documentation the way a parallel
 *     copy would.
 *   - bootstrap is still the authority on readiness. This never decides a
 *     deployment is ready; it runs bootstrap and reads its exit code.
 *
 * IDEMPOTENT, for the same reason bootstrap is: operators rerun installers,
 * and an installer that is only safe once is a trap. It fills what is missing
 * and touches nothing else. It NEVER rotates a secret that already exists —
 * rotating JWT_SECRET would invalidate every live session, and rotating the
 * authenticator password would break a running PostgREST.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * --------------------------------
 * It does not start the application. `npm run dev` is one command already, and
 * daemonising a dev server from an installer hides the logs an operator needs
 * on a first run. It prints the command instead.
 */

import { spawnSync } from 'child_process'
import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'fs'
import { randomBytes, randomUUID } from 'crypto'
import { resolve } from 'path'
import {
  BOOTSTRAP_EXIT,
  postgrestPrerequisiteSteps,
} from './bootstrap-prerequisites'
import { ensureEnvVar, envValue, setEnvVar } from './lib/env-file'

const ROOT = resolve(__dirname, '..')
const ENV_PATH = resolve(ROOT, '.env')
const ENV_EXAMPLE = resolve(ROOT, '.env.example')
const COMPOSE = ['-f', 'docker-compose.dev.yml']

// ── Output ───────────────────────────────────────────────────────────────────
// Numbered to match what the README describes, so an operator reading both is
// never guessing which step failed.

let stepNo = 0
function heading(text: string): void {
  stepNo += 1
  console.log('')
  console.log(`  ${stepNo}. ${text}`)
}
const ok = (text: string) => console.log(`     ok   ${text}`)
const info = (text: string) => console.log(`     ..   ${text}`)

class InstallFailure extends Error {
  constructor(readonly what: string, readonly fix: string) {
    super(what)
    this.name = 'InstallFailure'
  }
}

// ── .env ─────────────────────────────────────────────────────────────────────

/**
 * Read .env as an ordered list of lines, so rewriting preserves the template's
 * comments. Those comments are the only documentation of what half these keys
 * mean, and a serialise-from-a-map approach would delete all of them.
 */
function readEnvLines(): string[] {
  return readFileSync(ENV_PATH, 'utf8').split('\n')
}

const hex32 = () => randomBytes(32).toString('hex')

// ── Process helpers ──────────────────────────────────────────────────────────

/** Run a command, stream it, and throw with guidance if it fails. */
function run(cmd: string, args: string[], fix: string, env: NodeJS.ProcessEnv = {}): void {
  const r = spawnSync(cmd, args, {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, ...env },
    shell: false,
  })
  if (r.error) throw new InstallFailure(`could not run \`${cmd}\`: ${r.error.message}`, fix)
  if (r.status !== 0) throw new InstallFailure(`\`${cmd} ${args.join(' ')}\` exited ${r.status}`, fix)
}

/** Run a command and capture its output, for the steps whose output is parsed. */
function capture(cmd: string, args: string[], env: NodeJS.ProcessEnv = {}): { out: string; code: number } {
  const r = spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    shell: false,
  })
  return { out: `${r.stdout ?? ''}${r.stderr ?? ''}`, code: r.status ?? 1 }
}

/** Block the thread. This script is a sequence of steps, so it is genuinely serial. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function have(cmd: string, args: string[] = ['--version']): boolean {
  const r = spawnSync(cmd, args, { stdio: 'ignore', shell: false })
  return !r.error && r.status === 0
}

// ── Steps ────────────────────────────────────────────────────────────────────

function checkPrerequisites(): void {
  heading('checking what this machine already has')

  const major = Number(process.versions.node.split('.')[0])
  if (major < 20) {
    throw new InstallFailure(
      `Node ${process.versions.node} is too old; Backenly needs 20 or newer`,
      'install Node 20+ and rerun'
    )
  }
  ok(`node ${process.versions.node}`)

  if (!have('docker')) {
    throw new InstallFailure('docker is not on PATH', 'install Docker, start it, and rerun')
  }
  if (!have('docker', ['compose', 'version'])) {
    throw new InstallFailure(
      'docker is present but `docker compose` is not',
      'install the Compose v2 plugin (docker-compose-v2), then rerun'
    )
  }
  ok('docker with compose')

  // The superuser steps are shell scripts. Checked HERE rather than at the
  // point of use, because discovering it after provisioning a database leaves a
  // half-installed deployment and a confusing error.
  if (!have('bash', ['--version'])) {
    throw new InstallFailure(
      'bash is not on PATH, and the superuser steps are bash scripts',
      'run this from a shell that has bash (WSL, Git Bash, or any Linux/macOS terminal)'
    )
  }
  ok('bash')
}

function ensureEnvFile(): { projectId: string } {
  heading('configuring .env')

  if (!existsSync(ENV_PATH)) {
    if (!existsSync(ENV_EXAMPLE)) {
      throw new InstallFailure('neither .env nor .env.example exists', 'run this from a full checkout')
    }
    copyFileSync(ENV_EXAMPLE, ENV_PATH)
    ok('created .env from .env.example')
  } else {
    info('.env already exists; filling only what is missing')
  }

  const lines = readEnvLines()

  // Each of these has no safe default. A fallback baked into a public
  // repository is a key everybody already has, which is why the application
  // refuses to start on several of them rather than inventing one.
  const generated: string[] = []
  const secrets: Array<[string, () => string]> = [
    ['BACKENLY_PROJECT_ID', randomUUID],
    ['JWT_SECRET', hex32],
    ['POSTGREST_JWT_SECRET', hex32],
    ['STORAGE_SECRET', hex32],
    // Encrypts project signing secrets and stored database credentials at
    // rest. Unset outside production it silently falls back to 32 zero bytes,
    // announced only in a log line, so a self-hosted install that followed the
    // README encrypted its secrets with a key that is public knowledge.
    ['MASTER_ENCRYPTION_KEY', hex32],
  ]
  for (const [key, gen] of secrets) {
    if (ensureEnvVar(lines, key, gen) === 'generated') generated.push(key)
  }

  writeFileSync(ENV_PATH, lines.join('\n'), 'utf8')

  if (generated.length > 0) ok(`generated ${generated.join(', ')}`)
  else ok('every required secret was already set')

  const projectId = envValue(readEnvLines(), 'BACKENLY_PROJECT_ID')
  if (!projectId) throw new InstallFailure('BACKENLY_PROJECT_ID is still unset', 'set it in .env and rerun')

  // Said out loud because it is the one value that must never change again: it
  // names the workspace_<uuid> schema every table in this deployment lives in.
  info(`this deployment is project ${projectId}`)
  return { projectId }
}

function startInfrastructure(): void {
  heading('starting postgres and redis')

  // postgrest is deliberately NOT started here. It has no credential until the
  // roles step issues one, so starting it now only proves it restarts in a
  // loop — which is exactly what an operator reads as a broken install.
  run('docker', ['compose', ...COMPOSE, 'up', '-d', 'postgres', 'redis'],
    'check `docker compose -f docker-compose.dev.yml logs postgres`')

  info('waiting for postgres to accept queries')
  // A real query, not pg_isready. The entrypoint runs initdb against a
  // TEMPORARY server on the unix socket, so a socket pg_isready reports ready
  // seconds before the real server exists and the next step then fails with
  // "the database system is starting up".
  const user = envValue(readEnvLines(), 'POSTGRES_USER') || 'backenly_user'
  const db = envValue(readEnvLines(), 'POSTGRES_DB') || 'backenly'
  for (let i = 1; i <= 120; i++) {
    const r = capture('docker', [
      'compose', ...COMPOSE, 'exec', '-T', 'postgres',
      'psql', '-h', '127.0.0.1', '-U', user, '-d', db, '-tAc', 'select 1',
    ])
    if (r.code === 0) {
      ok(`postgres accepting queries after ${i}s`)
      return
    }
    sleepSync(1000)
  }
  throw new InstallFailure(
    'postgres never started accepting queries',
    'check `docker compose -f docker-compose.dev.yml logs postgres`'
  )
}

/** Ask the database a yes/no question through the Compose postgres service. */
function psqlScalar(sql: string): string | null {
  const user = envValue(readEnvLines(), 'POSTGRES_USER') || 'backenly_user'
  const db = envValue(readEnvLines(), 'POSTGRES_DB') || 'backenly'
  const r = capture('docker', [
    'compose', ...COMPOSE, 'exec', '-T', 'postgres',
    'psql', '-h', '127.0.0.1', '-U', user, '-d', db, '-tAc', sql,
  ])
  return r.code === 0 ? r.out.trim() : null
}

function createTables(): void {
  heading('creating the platform tables')

  run('npx', ['prisma', 'generate'], 'check the prisma schema')

  // `prisma db push` runs ONCE, and only when the platform tables are absent.
  //
  // It is not idempotent against an installed deployment. The PostgREST support
  // objects are created by SQL rather than by Prisma — a registry table and two
  // event triggers that fire on schema DDL — so push sees objects its schema
  // does not describe and sets out to drop them, which is what
  // `--accept-data-loss` would authorise. Running it a second time failed with
  // P1014 on `public.backenly_pgrst_schema_registry`; had it succeeded, it
  // would have removed the registry the data plane reads to decide which
  // schemas PostgREST serves.
  //
  // Found by the rerun assertion in CI, not by reasoning about it. The
  // documented manual path only ever reaches this step once, so an installer
  // that is safe to rerun has to check rather than repeat.
  const present = psqlScalar("SELECT to_regclass('public.projects') IS NOT NULL")
  if (present === 't') {
    ok('platform tables already present; not re-pushing the schema')
    return
  }

  run('npx', ['prisma', 'db', 'push', '--accept-data-loss', '--skip-generate'],
    'check DATABASE_URL in .env points at the Compose stack')
  ok('schema in sync')
}

/**
 * Run bootstrap and return its state.
 *
 * Bootstrap is the authority on readiness, so this reads its exit code rather
 * than forming its own opinion. 3 is not a failure: it is the documented
 * "core provisioned, superuser prerequisites remain" state.
 */
function runBootstrap(label: string): number {
  heading(label)
  const r = spawnSync('npx', ['tsx', 'scripts/bootstrap.ts'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: process.env,
    shell: false,
  })
  const code = r.status ?? 1
  if (code === BOOTSTRAP_EXIT.refused) {
    throw new InstallFailure(
      'bootstrap refused: this database already holds a different deployment',
      'point DATABASE_URL at an empty database, or set BACKENLY_PROJECT_ID to the one already there'
    )
  }
  if (code !== BOOTSTRAP_EXIT.ready && code !== BOOTSTRAP_EXIT.incomplete) {
    throw new InstallFailure(`bootstrap exited ${code}`, 'read the output above')
  }
  return code
}

function installSuperuserPrerequisites(projectId: string): void {
  heading('installing the superuser prerequisites')

  // The chain, in the order the module defines. Not re-typed here: this is the
  // same list bootstrap prints and README.md is tested against.
  const steps = postgrestPrerequisiteSteps(projectId)
  info(`${steps.length} steps, from scripts/bootstrap-prerequisites.ts`)

  // Step 0 is conditional guidance for operators who brought their own
  // database with a non-default role; on the Compose path it is a no-op.
  run('bash', ['scripts/postgrest-install.sh'],
    'the support objects and PostgREST roles could not be installed; see the output above')
  ok('support objects, event triggers and PostgREST roles')

  // The password is printed exactly once and is not recoverable, so it is
  // captured and written to .env here. Doing this by hand was the step most
  // likely to be got wrong: the connection string is easy to mis-copy and a
  // wrong value shows up only as PostgREST restarting in a loop.
  const r = capture('npx', ['tsx', 'scripts/setup-postgrest-roles.ts', '--project', projectId, '--apply'])
  process.stdout.write(r.out)
  if (r.code !== 0) {
    throw new InstallFailure('could not issue the authenticator password and grants', 'see the output above')
  }

  const match = r.out.match(/postgres:\/\/[^:]+:([^@]+)@/)
  if (match) {
    const lines = readEnvLines()
    const idx = lines.findIndex(l => /^\s*POSTGREST_AUTHENTICATOR_PASSWORD\s*=/.test(l))
    const entry = `POSTGREST_AUTHENTICATOR_PASSWORD=${match[1]}`
    if (idx >= 0) lines[idx] = entry
    else lines.push(entry)
    writeFileSync(ENV_PATH, lines.join('\n'), 'utf8')
    ok('authenticator password issued and written to .env')
  } else {
    // The script prints no connection string when the role already had a
    // password, which is the normal rerun path. Leaving .env alone is correct:
    // the existing value is the one a running PostgREST authenticates with.
    info('authenticator already had a password; left it alone')
    if (!envValue(readEnvLines(), 'POSTGREST_AUTHENTICATOR_PASSWORD')) {
      throw new InstallFailure(
        'the authenticator role has a password but .env does not carry it',
        `npx tsx scripts/setup-postgrest-roles.ts --project ${projectId} --apply --rotate-password  (then rerun)`
      )
    }
  }

  // Optional, and reported as optional by bootstrap. Installed here because
  // "one command" should mean the whole product, and it is the difference
  // between direct psql access working and being advertised but absent.
  const direct = capture('bash', ['scripts/install-sql.sh', 'scripts/setup-direct-access.sql'])
  if (direct.code === 0) ok('privileged role helpers, for direct database credentials')
  else info('privileged role helpers not installed; direct psql credentials will be unavailable')
}

function startDataPlane(): void {
  heading('starting the data plane')
  run('docker', ['compose', ...COMPOSE, 'up', '-d', 'postgrest'],
    'check `docker compose -f docker-compose.dev.yml logs postgrest`')
  ok('postgrest started')
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main(): void {
  console.log('')
  console.log('  Backenly self-host installer')
  console.log('  One deployment is one project.')

  checkPrerequisites()
  const { projectId } = ensureEnvFile()
  startInfrastructure()
  createTables()

  // First run. Exit 3 is expected and documented: it provisions the project,
  // its schema and its signing secret, then reports what only a superuser can
  // install. Reaching 0 here is fine too, on a rerun where they already are.
  const first = runBootstrap('bootstrapping the project')

  if (first === BOOTSTRAP_EXIT.incomplete) {
    installSuperuserPrerequisites(projectId)
    startDataPlane()

    // Rerunning IS the mechanism. Bootstrap is a reconciler, and the
    // prerequisites it could not install itself now exist.
    const second = runBootstrap('reconciling, now that the prerequisites exist')
    if (second !== BOOTSTRAP_EXIT.ready) {
      throw new InstallFailure(
        'bootstrap still reports unmet prerequisites',
        'read its output above; it names exactly what is missing, and rerunning is safe'
      )
    }
  } else {
    // Already ready. Still converge the data plane, because a previous run may
    // have stopped before starting it.
    startDataPlane()
  }

  console.log('')
  console.log('  Backenly is installed.')
  console.log('')
  console.log('    npm run dev          dashboard :3000 · runtime :3001')
  console.log('')
  console.log('  There is no account yet. Sign up in the dashboard, then run')
  console.log('  `npm run bootstrap` once more to issue the anon key your frontend embeds.')
  console.log('')
}

try {
  main()
} catch (err) {
  if (err instanceof InstallFailure) {
    console.error('')
    console.error(`  Install stopped: ${err.what}`)
    console.error('')
    console.error(`    ${err.fix}`)
    console.error('')
    console.error('  Rerunning is safe. This installer only fills what is missing.')
    console.error('')
    process.exit(1)
  }
  throw err
}
