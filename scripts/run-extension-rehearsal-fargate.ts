/**
 * LAYER 2 EXTENSION REHEARSAL LAUNCHER — staging, scratch database only
 * =====================================================================
 *
 * Runs `tools/managed-db/rehearsal-task.ts` inside the staging VPC as a one-shot
 * Fargate task. It proves extension provisioning in a throwaway database: the
 * real staging database is not touched, and Layer 3 and Layer 4 are not involved.
 *
 * Before the bundle may ship it must pass the Layer 2 audit: exactly one
 * mutation vocabulary (`CREATE EXTENSION IF NOT EXISTS`), no drops, no roles,
 * no grants, no event triggers, no tenant schemas, no migration runner, and no
 * import that reaches the SQL replay path or the Layer 4 installers. The audit
 * also fails a bundle that contains NO mutation at all, because a provisioner
 * that cannot install anything is broken rather than safe.
 *
 *   # Windows
 *   npx tsx scripts/run-extension-rehearsal-fargate.ts --emit tools/managed-db/out/bundle
 *
 *   # WSL, from the repository root
 *   REHEARSAL_AWS_ACCOUNT_ID=<staging account id> \
 *     node tools/managed-db/out/bundle/launcher.cjs --run \
 *     --from tools/managed-db/out/bundle --out tools/managed-db/out/<run>
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { brotliCompressSync, brotliDecompressSync, constants } from 'node:zlib'
import { decodeResult, hasCompleteResult } from '../tools/migration-lineage/probe/output'
import {
  assertProvisionerBundle,
  assertProvisionerModules,
} from '../tools/managed-db/provisioner-audit'
import type { ExtensionRehearsalResult } from '../tools/managed-db/rehearse-extensions'
import {
  argValue,
  assertStagingOnly,
  die,
  resolveStagingTaskContext,
  runTaskAndReadLogs,
  withEphemeralTaskDefinition,
  type OneShotTaskSpec,
} from './lib/staging-fargate-task'

const FAMILY = 'backenly-staging-layer2-extensions'
const CONTAINER = 'layer2'
const LOG_PREFIX = 'layer2'

const BOOTSTRAP =
  "const z=require('zlib'),f=require('fs');" +
  "f.writeFileSync('/tmp/layer2.cjs',z.brotliDecompressSync(Buffer.from(process.env.PROBE_B64,'base64')));" +
  "require('/tmp/layer2.cjs')"

function sources(root: string): string[] {
  const dir = 'tools/managed-db'
  const shared = 'tools/migration-lineage/probe'
  return [
    ...readdirSync(join(root, dir)).filter(f => f.endsWith('.ts')).map(f => `${dir}/${f}`),
    `${shared}/capabilities.ts`,
    `${shared}/connect.ts`,
    `${shared}/output.ts`,
    `${shared}/rds-ca.ts`,
    'scripts/run-extension-rehearsal-fargate.ts',
  ].sort()
}

const digests = (root: string): Record<string, string> =>
  Object.fromEntries(sources(root).map(rel => [rel, createHash('sha256').update(readFileSync(join(root, rel))).digest('hex')]))

function assertRepoRoot(root: string): void {
  for (const marker of ['prisma/schema.prisma', 'AGENTS.md', 'tools/managed-db/rehearsal-task.ts']) {
    if (!existsSync(join(root, marker))) die(`${root} is not the repository root (no ${marker})`)
  }
}

async function emit(dir: string): Promise<void> {
  const root = process.cwd()
  assertRepoRoot(root)
  mkdirSync(dir, { recursive: true })

  const { build } = await import('esbuild')
  const probe = await build({
    entryPoints: [join(root, 'tools', 'managed-db', 'rehearsal-task.ts')],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    minify: true,
    external: ['pg-native', 'pg-cloudflare', 'cloudflare:sockets'],
    write: false,
    metafile: true,
    logLevel: 'silent',
  })
  const code = probe.outputFiles[0].text
  const modules = Object.keys(probe.metafile?.inputs ?? {})
  assertProvisionerBundle(code)
  assertProvisionerModules(modules)
  console.log(`  layer 2 audit: ${modules.length} modules, one mutation vocabulary, nothing it does not own`)

  const launcher = await build({
    entryPoints: [join(root, 'scripts', 'run-extension-rehearsal-fargate.ts')],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    external: ['esbuild'],
    write: false,
    logLevel: 'silent',
  })

  const probeB64 = brotliCompressSync(Buffer.from(code, 'utf8'), {
    params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
  }).toString('base64')
  writeFileSync(join(dir, 'probe.b64'), probeB64)
  writeFileSync(join(dir, 'launcher.cjs'), launcher.outputFiles[0].text)
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({ createdAt: new Date().toISOString(), sources: digests(root), probeModules: modules }, null, 2),
  )
  console.log(`  probe ${(probeB64.length / 1024).toFixed(1)} KB of environment`)
  console.log(`  wrote bundle to ${dir}`)
}

function summarise(r: ExtensionRehearsalResult): void {
  console.log(`\n  layer 2 rehearsal: ${r.verdict}`)
  for (const f of r.failures) console.log(`    FAIL          ${f}`)
  for (const u of r.inconclusive) console.log(`    INCONCLUSIVE  ${u}`)
  console.log(`    before        ${r.beforeStatuses.map(s => `${s.name}=${s.status}`).join(' ')}`)
  console.log(`    installed     ${JSON.stringify(r.firstRun?.executed ?? [])}`)
  console.log(`    operational   ${JSON.stringify(r.firstRun?.operational ?? [])}`)
  for (const id of r.identitiesAfterFirst) console.log(`    identity      ${id.name} ${id.version} in ${id.schema}`)
  console.log(`    second run    executed ${JSON.stringify(r.secondRun?.executed ?? [])}, idempotent=${r.idempotent}`)
  console.log(`    scratch       ${r.scratch?.name} created=${r.scratch?.created} dropped=${r.scratch?.dropped}`)
  console.log(`    leftovers     ${JSON.stringify(r.scratchDatabasesAfter)}`)
}

async function run(from: string, out: string): Promise<void> {
  const root = process.cwd()
  assertRepoRoot(root)

  const manifest = JSON.parse(readFileSync(join(from, 'manifest.json'), 'utf8'))
  const now = digests(root)
  for (const key of new Set([...Object.keys(now), ...Object.keys(manifest.sources)])) {
    if (manifest.sources[key] !== now[key]) die(`${key} has changed since the bundle was emitted; re-emit it`)
  }

  const probeB64 = readFileSync(join(from, 'probe.b64'), 'utf8')
  assertProvisionerBundle(brotliDecompressSync(Buffer.from(probeB64, 'base64')).toString('utf8'))
  assertProvisionerModules(manifest.probeModules ?? [])

  console.log('\nLayer 2 extension rehearsal — staging, scratch database only\n')
  console.log('  layer 2 audit: shipped bundle is one mutation vocabulary')
  assertStagingOnly()
  const ctx = resolveStagingTaskContext()

  const spec: OneShotTaskSpec = {
    family: FAMILY,
    containerName: CONTAINER,
    logPrefix: LOG_PREFIX,
    startedBy: 'layer2-extension-rehearsal',
    command: ['sh', '-c', 'exec node -e "$LAYER2_BOOTSTRAP"'],
    environment: [
      { name: 'LAYER2_BOOTSTRAP', value: BOOTSTRAP },
      { name: 'PROBE_B64', value: probeB64 },
    ],
    cpu: '512',
    memory: '1024',
  }

  const exitCode = await withEphemeralTaskDefinition(ctx, spec, taskDefArn => {
    const lines = runTaskAndReadLogs(ctx, taskDefArn, spec, {
      complete: hasCompleteResult,
      echo: line => !line.startsWith('LINEAGE-CHUNK '),
    })
    if (!hasCompleteResult(lines)) {
      console.error('\n  no complete result in the task logs')
      return 1
    }
    const result = decodeResult<ExtensionRehearsalResult>(lines)
    mkdirSync(out, { recursive: true })
    writeFileSync(join(out, 'layer2-extension-rehearsal.json'), JSON.stringify(result, null, 2))
    summarise(result)
    console.log(`\n  wrote ${join(out, 'layer2-extension-rehearsal.json')}`)
    return result.verdict === 'PASS' ? 0 : 1
  })

  process.exit(exitCode)
}

async function main(): Promise<void> {
  const emitTo = argValue('--emit')
  if (emitTo) return emit(emitTo)
  if (!process.argv.includes('--run')) die('usage: --emit <dir> | --run --from <dir> --out <dir>')
  const from = argValue('--from')
  const out = argValue('--out')
  if (!from || !out) die('--run needs --from <bundle dir> and --out <result dir>')
  return run(from, out)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
