/**
 * THE MIGRATION RUNNER'S ENTRYPOINT — the guard closest to the write
 * ==================================================================
 *
 * `scripts/run-production-migration-job.ts` checks the AWS account and checks
 * that the secret's ARN names a production resource. Both are checks on
 * POINTERS: they pass whether or not the secret's contents point where the ARN
 * suggests. This script runs inside the container and parses the URL it is
 * actually about to connect with, which is the only check that sees the thing
 * itself.
 *
 * It matters most for `baseline`. `migrate resolve --applied` writes migration
 * history into whatever database it reaches, and re-running it against the right
 * one does not undo what it wrote into the wrong one.
 *
 * Executed as real `sh`, not read as text. The parsing is POSIX parameter
 * expansion and the failure modes are shell failure modes — an assertion about
 * what the file CONTAINS would pass just as happily against a script with a
 * syntax error in it.
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const ENTRYPOINT = join(__dirname, '..', '..', 'tools', 'managed-db', 'runner', 'entrypoint.sh')

interface Run {
  status: number
  output: string
}

/**
 * Run the entrypoint with a fake prisma on PATH, so the guard is exercised
 * without the real CLI and without a database anywhere.
 */
function run(args: string[], env: Record<string, string>): Run {
  try {
    const output = execFileSync('sh', [ENTRYPOINT, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH ?? '',
        // The entrypoint execs an absolute path that does not exist here, so a
        // run that gets PAST the guard fails at the exec. That is the signal:
        // "refusing" means the guard stopped it, anything else means it did not.
        ...env,
      },
    })
    return { status: 0, output }
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string }
    return { status: e.status ?? 1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

const url = (db: string, opts: { password?: string; query?: string } = {}) =>
  `postgresql://backenly_user:${opts.password ?? 'pw'}@db.example.internal:5432/${db}${opts.query ?? ''}`

describe('the entrypoint refuses the wrong database', () => {
  it('exists and is a shell script', () => {
    expect(existsSync(ENTRYPOINT)).toBe(true)
  })

  it('refuses when the connected database is not the expected one', () => {
    const r = run(['status'], { EXPECT_DATABASE: 'backenly', DATABASE_URL: url('backenly_staging') })
    expect(r.status).toBe(2)
    expect(r.output).toMatch(/refusing: connected database is "backenly_staging", expected "backenly"/)
  })

  it('refuses when DATABASE_URL is empty but a database was named', () => {
    const r = run(['status'], { EXPECT_DATABASE: 'backenly', DATABASE_URL: '' })
    expect(r.status).toBe(2)
    expect(r.output).toMatch(/DATABASE_URL is empty/)
  })

  it('refuses a URL with no database path at all, rather than guessing', () => {
    // Extraction yields "db.example.internal:5432", which matches nothing. The
    // failure direction is the point: an unparseable URL must not pass.
    const r = run(['status'], {
      EXPECT_DATABASE: 'backenly',
      DATABASE_URL: 'postgresql://backenly_user:pw@db.example.internal:5432',
    })
    expect(r.status).toBe(2)
    expect(r.output).toMatch(/refusing: connected database is/)
  })

  it('accepts the expected database, and says which one it matched', () => {
    const r = run(['status'], { EXPECT_DATABASE: 'backenly', DATABASE_URL: url('backenly') })
    // Past the guard, so it fails at the missing prisma binary rather than at a
    // refusal. Non-vacuity: proves the guard is what stops the cases above.
    expect(r.output).toMatch(/database: backenly \(matches EXPECT_DATABASE\)/)
    expect(r.output).not.toMatch(/refusing/)
  })

  it('is not confused by a password containing a slash or an at-sign', () => {
    // Parsed after the LAST '@', so neither can shift the fields. A naive parse
    // splits on the first '/' after the scheme and reads the password as the
    // database, which would refuse a correct URL — or, with the wrong password,
    // accept an incorrect one.
    const r = run(['status'], {
      EXPECT_DATABASE: 'backenly',
      DATABASE_URL: url('backenly', { password: 'a/b@c' }),
    })
    expect(r.output).toMatch(/database: backenly \(matches EXPECT_DATABASE\)/)
  })

  it('ignores query parameters after the database name', () => {
    const r = run(['status'], {
      EXPECT_DATABASE: 'backenly',
      DATABASE_URL: url('backenly', { query: '?sslmode=require&connection_limit=1' }),
    })
    expect(r.output).toMatch(/database: backenly \(matches EXPECT_DATABASE\)/)
  })

  it('skips the check entirely when no database was named', () => {
    // Staging runs without it. The guard is opt-in so that adding it to the
    // image did not change what the staging launcher already does.
    const r = run(['status'], { DATABASE_URL: url('anything') })
    expect(r.output).not.toMatch(/refusing/)
    expect(r.output).not.toMatch(/matches EXPECT_DATABASE/)
  })
})

describe('the entrypoint still refuses an unconfirmed baseline', () => {
  it('will not resolve a migration as applied without the naming confirmation', () => {
    const r = run(['baseline', '00000000000000_baseline'], {
      EXPECT_DATABASE: 'backenly',
      DATABASE_URL: url('backenly'),
    })
    expect(r.status).toBe(2)
    expect(r.output).toMatch(/MIGRATE_BASELINE_CONFIRM to name the same migration/)
  })

  it('will not accept a confirmation naming a DIFFERENT migration', () => {
    const r = run(['baseline', '00000000000000_baseline'], {
      EXPECT_DATABASE: 'backenly',
      DATABASE_URL: url('backenly'),
      MIGRATE_BASELINE_CONFIRM: '20260916120000_maintenance_ledger',
    })
    expect(r.status).toBe(2)
    expect(r.output).toMatch(/MIGRATE_BASELINE_CONFIRM to name the same migration/)
  })

  it('rejects an unknown command rather than doing nothing quietly', () => {
    const r = run(['migrate-everything'], { DATABASE_URL: url('backenly') })
    expect(r.status).toBe(2)
    expect(r.output).toMatch(/usage: status \| deploy \| baseline/)
  })
})
