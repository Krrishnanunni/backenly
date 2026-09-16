/**
 * LAYER 3 MIGRATION JOB — run the dedicated migration runner in staging
 * =====================================================================
 *
 * One-shot Fargate task using the migration runner image, not the application
 * image and not the long-lived app process.
 *
 *   node .../launcher --command status  --image <ecr uri>
 *   node .../launcher --command deploy  --image <ecr uri>
 *   node .../launcher --command baseline --migration 00000000000000_baseline \
 *        --image <ecr uri> --confirm-baseline
 *
 * `baseline` is a one-time action for an existing database, not part of a
 * normal release: it needs its own flag here AND the runner's own
 * MIGRATE_BASELINE_CONFIRM check, which must name the same migration. Steady
 * state is `deploy` alone.
 */

import {
  argValue,
  assertStagingOnly,
  die,
  resolveStagingTaskContext,
  runTaskAndReadResult,
  withEphemeralTaskDefinition,
  type OneShotTaskSpec,
} from './lib/staging-fargate-task'

const FAMILY = 'backenly-staging-migration-job'
const CONTAINER = 'migrate'
const LOG_PREFIX = 'migrate'

type Command = 'status' | 'deploy' | 'baseline'

async function main(): Promise<void> {
  const command = (argValue('--command') ?? '') as Command
  if (command !== 'status' && command !== 'deploy' && command !== 'baseline') {
    die('usage: --command status|deploy|baseline --image <ecr uri> [--migration <id> --confirm-baseline]')
  }
  const image = argValue('--image')
  if (!image) die('--image is required: the migration runner image to run')
  if (!/^\d+\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com\//.test(image)) die(`--image is not an ECR image: ${image}`)

  const environment: Array<{ name: string; value: string }> = []
  const args: string[] = [command]

  if (command === 'baseline') {
    const migration = argValue('--migration')
    if (!migration) die('baselining needs --migration <id>')
    if (!process.argv.includes('--confirm-baseline')) {
      die('baselining writes migration history to a real database; pass --confirm-baseline to say so explicitly')
    }
    args.push(migration)
    environment.push({ name: 'MIGRATE_BASELINE_CONFIRM', value: migration })
    console.log(`\nLayer 3 migration job — BASELINE ${migration}\n`)
  } else {
    console.log(`\nLayer 3 migration job — ${command}\n`)
  }

  assertStagingOnly()
  const ctx = resolveStagingTaskContext()
  console.log(`  image ${image}`)

  const spec: OneShotTaskSpec = {
    family: FAMILY,
    containerName: CONTAINER,
    logPrefix: LOG_PREFIX,
    startedBy: `migration-job-${command}`,
    image,
    command: args,
    environment,
    cpu: '512',
    memory: '1024',
  }

  const exitCode = await withEphemeralTaskDefinition(ctx, spec, taskDefArn => {
    const { lines, containerExit } = runTaskAndReadResult(ctx, taskDefArn, spec)
    const text = lines.join('\n')
    // Prisma says what it did; the task's exit code is the authority, and the
    // launcher reports both rather than interpreting one as the other.
    const clean = /Database schema is up to date/i.test(text)
    const noPending = /No pending migrations to apply/i.test(text)
    const applied = /migration\(s\) have been applied|have been successfully applied/i.test(text)
    const resolved = /marked as applied/i.test(text)
    console.log(
      `\n  observed: clean=${clean} noPending=${noPending} applied=${applied} resolved=${resolved}`,
    )

    // `status` exits 1 when migrations are pending, which is an answer rather
    // than a failure, so the launcher passes it through: the caller sees the
    // same code Prisma chose. For a mutation the exit code gates the claim.
    if (command === 'status') return containerExit === 0 ? 0 : 1

    if (containerExit !== 0) {
      console.error(`\n  FAILED: ${command} exited ${containerExit}; the database may be partially migrated`)
      return 1
    }
    const proved = command === 'deploy' ? applied || noPending : resolved
    if (!proved) {
      // A zero exit with none of the expected output means the logs did not
      // arrive or the runner did something else. Not a success.
      console.error(`\n  FAILED: ${command} exited 0 but its outcome was never observed in the logs`)
      return 1
    }
    return 0
  })

  process.exit(exitCode)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
