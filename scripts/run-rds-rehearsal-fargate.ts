/**
 * PHASE 6 RDS REHEARSAL LAUNCHER — ephemeral in AWS, reproducible in the repo
 * ===========================================================================
 *
 * Runs `scripts/rehearse-maintenance-rds.ts` inside the VPC, against the staging
 * database, as a one-shot Fargate task. Then deregisters everything it created.
 *
 * ── Why a one-shot task rather than ECS Exec ────────────────────────────────
 *
 * The staging RDS instance is `PubliclyAccessible: false`, so nothing outside
 * the VPC can reach it — correct, and not worth weakening. The obvious
 * alternative was ECS Exec into the running runtime service, but
 * `backenly-staging-runtime-task` carries NO IAM policies at all, so enabling it
 * would mean an IAM expansion plus a forced redeployment of staging purely to
 * obtain a shell.
 *
 * A one-shot task is also the better artifact: reproducible, non-interactive,
 * CloudWatch-audited, and re-runnable before any future change to the
 * maintenance engine. An exec session is none of those.
 *
 * ── Ephemeral by construction ───────────────────────────────────────────────
 *
 * Registers a task definition, runs one task, collects the result, deregisters
 * the definition. Nothing durable is left in staging. The reusable part is this
 * file and the rehearsal it runs, both version-controlled.
 *
 * ── Why the rehearsal is injected rather than baked into an image ───────────
 *
 * The runtime image ships `dist-runtime` plus `@prisma/client` and bundles
 * everything else, so `pg` is not resolvable inside it — but Prisma is, which is
 * all the rehearsal needs. The script is bundled with esbuild, base64-encoded,
 * and carried in the TASK DEFINITION rather than a RunTask override, because
 * overrides are capped near 8 KB and a task definition is not.
 *
 * The canonical logic stays in `scripts/rehearse-maintenance-rds.ts`. Nothing
 * authoritative lives inside a shell string.
 *
 * ── Usage ───────────────────────────────────────────────────────────────────
 *
 *   REHEARSAL_AWS_ACCOUNT_ID=<staging account id>  *     npx tsx scripts/run-rds-rehearsal-fargate.ts
 *
 * Requires an authenticated AWS CLI on PATH. Exits non-zero if the rehearsal
 * fails or if any guard below refuses.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

// ── The guards ───────────────────────────────────────────────────────────────
//
// A typo in an argument must not be capable of pointing a schema-mutating
// rehearsal at production. Every one of these is checked against what AWS
// actually reports, never against what was passed in.

// Supplied by the operator, not written down here. This repository is public,
// and an account id in public source is free reconnaissance: it is the missing
// half of every role ARN someone would need to guess. Reading it from the
// environment leaves the guard exactly as strong, because unset refuses and a
// mismatch refuses, and the value is still compared against what STS actually
// reports rather than against anything passed in.
const EXPECTED_ACCOUNT = process.env.REHEARSAL_AWS_ACCOUNT_ID?.trim() ?? ''
const EXPECTED_REGION = 'ap-south-1'
const CLUSTER = 'backenly-staging'
const SOURCE_SERVICE = 'backenly-staging-runtime'
// Reuses the RUNTIME log group rather than creating one.
//
// The staging execution role's policy is scoped to the log groups it already
// writes, so a fresh group fails at task start with
// "not authorized to perform: logs:CreateLogStream". Expanding that policy would
// be an IAM change made solely so a rehearsal could have its own folder, which
// is a poor trade — the stream prefix already separates it, and reusing the
// group keeps this launcher's AWS footprint to "one task definition, briefly".
const LOG_GROUP = '/ecs/backenly-staging/runtime'
const LOG_PREFIX = 'rehearsal'
const FAMILY = 'backenly-staging-maintenance-rehearsal'

const RESULT_BEGIN = '---REHEARSAL-RESULT-BEGIN---'
const RESULT_END = '---REHEARSAL-RESULT-END---'

function aws(args: string[]): any {
  const out = execFileSync('aws', [...args, '--region', EXPECTED_REGION, '--output', 'json'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  return out.trim() ? JSON.parse(out) : null
}

function die(msg: string): never {
  console.error(`\n  REFUSED: ${msg}\n`)
  process.exit(2)
}

function assertStagingOnly(): void {
  if (!EXPECTED_ACCOUNT) {
    die(
      'REHEARSAL_AWS_ACCOUNT_ID is not set. Set it to the staging account id this ' +
        'rehearsal is allowed to run against. It is deliberately not hardcoded.',
    )
  }
  const id = aws(['sts', 'get-caller-identity'])
  if (id?.Account !== EXPECTED_ACCOUNT) {
    die(`account is ${id?.Account}, expected ${EXPECTED_ACCOUNT}`)
  }
  if (!CLUSTER.includes('staging')) die(`cluster "${CLUSTER}" is not a staging cluster`)
  if (!SOURCE_SERVICE.includes('staging')) die(`service "${SOURCE_SERVICE}" is not staging`)
  console.log(`  account ${id.Account} · region ${EXPECTED_REGION} · cluster ${CLUSTER}`)
}

/**
 * The staging secrets, with production structurally excluded.
 *
 * Only DATABASE_URL and DIRECT_URL are carried over: the rehearsal needs a
 * database and nothing else. JWT_SECRET and MASTER_ENCRYPTION_KEY are
 * deliberately dropped — a rehearsal that cannot decrypt anything cannot leak
 * anything.
 */
function stagingDbSecrets(taskDef: any): Array<{ name: string; valueFrom: string }> {
  const all: Array<{ name: string; valueFrom: string }> =
    taskDef.containerDefinitions?.[0]?.secrets ?? []
  const wanted = all.filter(s => s.name === 'DATABASE_URL' || s.name === 'DIRECT_URL')

  if (wanted.length === 0) die('staging task definition exposes no DATABASE_URL secret')

  for (const s of wanted) {
    if (/production|prod-/i.test(s.valueFrom)) {
      die(`secret ${s.name} resolves to a production ARN: ${s.valueFrom}`)
    }
    if (!/staging/i.test(s.valueFrom)) {
      die(`secret ${s.name} does not identify a staging resource: ${s.valueFrom}`)
    }
  }
  return wanted
}

/**
 * Bundle the rehearsal to a single base64 blob.
 *
 * Split from launching because esbuild ships a platform-native binary, and this
 * repository is routinely edited on Windows while the AWS CLI is authenticated
 * inside WSL. A `node_modules` installed on one cannot run esbuild on the other
 * — a trap this project has hit before — and reinstalling for Linux would break
 * the Windows toolchain in the same move.
 *
 * So the two halves can run on different platforms:
 *
 *   # Windows (has the repo and a Windows esbuild)
 *   npx tsx scripts/run-rds-rehearsal-fargate.ts --emit-bundle .rehearsal.b64
 *
 *   # WSL / CI (has an authenticated AWS CLI)
 *   npx tsx scripts/run-rds-rehearsal-fargate.ts --bundle .rehearsal.b64
 *
 * On a machine where both work, neither flag is needed.
 */
async function bundleRehearsal(): Promise<string> {
  // Imported lazily, not at module load. esbuild resolves its native binary on
  // import, so a static import crashes on a platform whose binary is absent
  // EVEN IN --bundle mode, where esbuild is never used. That is the whole point
  // of the split, and a top-level import quietly defeats it.
  const { build } = await import('esbuild')
  const result = await build({
    entryPoints: [join(process.cwd(), 'scripts', 'rehearse-maintenance-rds.ts')],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    // Present in the runtime image; bundling it would be pointless and huge.
    external: ['@prisma/client', '.prisma/client'],
    write: false,
    logLevel: 'silent',
  })
  const code = result.outputFiles[0].text
  console.log(`  rehearsal bundled: ${(code.length / 1024).toFixed(1)} KB`)
  return Buffer.from(code, 'utf8').toString('base64')
}

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? (process.argv[i + 1] ?? null) : null
}

/**
 * The bundle, however this platform can obtain it.
 *
 * A supplied bundle is checked for freshness against the rehearsal source, so a
 * stale blob cannot silently rehearse last week's logic and report PASS.
 */
async function resolveBundle(): Promise<string> {
  const supplied = argValue('--bundle')
  if (!supplied) return bundleRehearsal()

  const b64 = readFileSync(supplied, 'utf8').trim()
  const srcMtime = statSync(join(process.cwd(), 'scripts', 'rehearse-maintenance-rds.ts')).mtimeMs
  const bundleMtime = statSync(supplied).mtimeMs
  if (bundleMtime < srcMtime) {
    die(
      `${supplied} is older than scripts/rehearse-maintenance-rds.ts — ` +
      're-emit it, or the rehearsal would run stale logic and report on the wrong code',
    )
  }
  console.log(`  using supplied bundle: ${(b64.length / 1024).toFixed(1)} KB base64`)
  return b64
}

/** The log group is the staging runtime's own; nothing to create. */
function ensureLogGroup(): void {}

async function main(): Promise<void> {
  // Bundle-only mode: makes no AWS calls at all, so it runs on a machine that
  // has the repo's toolchain but no credentials.
  const emitTo = argValue('--emit-bundle')
  if (emitTo) {
    writeFileSync(emitTo, await bundleRehearsal(), 'utf8')
    console.log(`  wrote ${emitTo}`)
    process.exit(0)
  }

  console.log('\nPhase 6 RDS rehearsal — staging, one-shot Fargate task\n')
  assertStagingOnly()

  const svc = aws(['ecs', 'describe-services', '--cluster', CLUSTER, '--services', SOURCE_SERVICE])
    ?.services?.[0]
  if (!svc) die(`service ${SOURCE_SERVICE} not found in ${CLUSTER}`)

  const net = svc.networkConfiguration?.awsvpcConfiguration
  if (!net) die('staging service has no awsvpc configuration to mirror')

  const srcDef = aws(['ecs', 'describe-task-definition', '--task-definition', SOURCE_SERVICE])
    ?.taskDefinition
  if (!srcDef) die('could not read the staging task definition')

  const secrets = stagingDbSecrets(srcDef)
  console.log(`  secrets carried: ${secrets.map(s => s.name).join(', ')}`)

  const b64 = await resolveBundle()
  ensureLogGroup()

  // The rehearsal travels in the task definition, not a RunTask override:
  // overrides are capped near 8 KB, a task definition is not.
  const container = {
    name: 'rehearsal',
    image: srcDef.containerDefinitions[0].image,
    essential: true,
    // Decoded at start rather than eval'd from an argv string, so nothing
    // depends on shell quoting.
    command: [
      'sh',
      '-c',
      'echo "$REHEARSAL_B64" | base64 -d > /tmp/rehearsal.cjs && node /tmp/rehearsal.cjs',
    ],
    environment: [
      { name: 'REHEARSAL_B64', value: b64 },
      // The image has a read-only root and writes nothing outside /tmp, so the
      // decoded script lives there — and Node resolves modules from the
      // SCRIPT's directory, walking /tmp/node_modules then /node_modules and
      // never reaching /app/node_modules where @prisma/client actually is.
      // NODE_PATH bridges that without needing /app to be writable.
      { name: 'NODE_PATH', value: '/app/node_modules' },
    ],
    secrets,
    logConfiguration: {
      logDriver: 'awslogs',
      options: {
        'awslogs-group': LOG_GROUP,
        'awslogs-region': EXPECTED_REGION,
        'awslogs-stream-prefix': LOG_PREFIX,
      },
    },
  }

  const registerArgs = [
    'ecs', 'register-task-definition',
    '--family', FAMILY,
    '--requires-compatibilities', 'FARGATE',
    '--network-mode', 'awsvpc',
    '--cpu', '512',
    '--memory', '1024',
    '--execution-role-arn', srcDef.executionRoleArn,
    '--container-definitions', JSON.stringify([container]),
  ]
  // No task role: the rehearsal calls no AWS API. Least privilege by omission.
  const registered = aws(registerArgs)?.taskDefinition
  const taskDefArn: string = registered.taskDefinitionArn
  console.log(`  registered ${taskDefArn.split('/').pop()}`)

  let exitCode = 1
  try {
    const netCfg = JSON.stringify({
      awsvpcConfiguration: {
        subnets: net.subnets,
        securityGroups: net.securityGroups,
        // Mirrors staging. These subnets default-route to an Internet Gateway,
        // not a NAT, so a task needs a public IP to reach ECR and CloudWatch.
        // It exposes no listener, and the security group still governs inbound.
        assignPublicIp: net.assignPublicIp,
      },
    })

    const run = aws([
      'ecs', 'run-task',
      '--cluster', CLUSTER,
      '--task-definition', taskDefArn,
      '--launch-type', 'FARGATE',
      '--network-configuration', netCfg,
      '--started-by', 'phase6-rds-rehearsal',
    ])
    if (run?.failures?.length) die(`run-task failed: ${JSON.stringify(run.failures)}`)

    const taskArn: string = run.tasks[0].taskArn
    const taskId = taskArn.split('/').pop()!
    console.log(`  task ${taskId} starting…`)

    execFileSync('aws', [
      'ecs', 'wait', 'tasks-stopped',
      '--cluster', CLUSTER, '--tasks', taskArn,
      '--region', EXPECTED_REGION,
    ], { stdio: 'inherit' })

    const done = aws(['ecs', 'describe-tasks', '--cluster', CLUSTER, '--tasks', taskArn])
      ?.tasks?.[0]
    const containerExit = done?.containers?.[0]?.exitCode
    console.log(`  task stopped: ${done?.stoppedReason ?? 'n/a'} (exit ${containerExit})`)

    let events: any[] = []
    try {
      events = aws([
        'logs', 'get-log-events',
        '--log-group-name', LOG_GROUP,
        '--log-stream-name', `${LOG_PREFIX}/rehearsal/${taskId}`,
        '--start-from-head',
      ])?.events ?? []
    } catch (err) {
      // Reporting failure, not a rehearsal verdict. The container exit code
      // below is the authority; crashing here would skip the cleanup that
      // makes this launcher ephemeral.
      console.error('  could not read task logs:', err instanceof Error ? err.message : err)
    }

    const lines: string[] = events.map((e: any) => String(e.message))
    for (const l of lines) console.log(`    | ${l}`)

    const a = lines.findIndex(l => l.includes(RESULT_BEGIN))
    const b = lines.findIndex(l => l.includes(RESULT_END))
    if (a >= 0 && b > a) {
      const parsed = JSON.parse(lines.slice(a + 1, b).join('\n'))
      console.log('\n  RESULT:', parsed.result)
      for (const [k, v] of Object.entries(parsed.tests)) {
        console.log(`    ${String(v).padEnd(4)} ${k}`)
      }
      exitCode = parsed.result === 'PASS' ? 0 : 1
    } else {
      console.error('\n  no machine-readable result found in the task logs')
      exitCode = 1
    }
  } finally {
    // Ephemeral by construction: nothing durable is left behind in staging.
    try {
      aws(['ecs', 'deregister-task-definition', '--task-definition', taskDefArn])
      console.log(`  deregistered ${taskDefArn.split('/').pop()}`)
    } catch (err) {
      console.error('  WARNING: could not deregister the task definition:', err)
    }
  }

  process.exit(exitCode)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
