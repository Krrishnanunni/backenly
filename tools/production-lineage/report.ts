/**
 * The production lineage report: P ↔ C_prod, locally, from recorded captures.
 *
 *   npx tsx tools/production-lineage/report.ts \
 *     --capture <production capture json> \
 *     --projection <replay-push.json from the staging run> \
 *     [--manifests tools/migration-lineage/manifests] [--out report.json]
 *
 * The projection is the schema.prisma state captured during the staging
 * investigation. It is a property of the repository, not of an environment,
 * which is why production needs no replay of its own.
 *
 * Staging's provisioning manifests are offered but not assumed: entries that
 * match nothing in production are listed as unobserved, because production may
 * have been provisioned differently.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { attribute, type Attribution, type Manifest } from '../migration-lineage/attribute'
import { countByKind, diffSnapshots, type Difference } from '../migration-lineage/diff'
import type { ProbeResult } from '../migration-lineage/probe/run'
import { gateProduction, type ProductionEvidence } from './verdict'
import type { ProductionCaptureResult } from './probe/run'

const arg = (flag: string): string | null => {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? (process.argv[i + 1] ?? null) : null
}

function loadManifests(dir: string | null): Manifest[] {
  if (!dir || !existsSync(dir)) return []
  return readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .sort()
    .map(f => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Manifest)
}

function section(title: string): void {
  console.log(`\n${title}\n${'='.repeat(title.length)}`)
}

function main(): void {
  const capturePath = arg('--capture')
  const projectionPath = arg('--projection')
  if (!capturePath || !projectionPath) {
    console.error('usage: report.ts --capture <json> --projection <json> [--manifests <dir>] [--out <file>]')
    process.exit(2)
  }

  const capture = JSON.parse(readFileSync(capturePath, 'utf8')) as ProductionCaptureResult
  const projectionResult = JSON.parse(readFileSync(projectionPath, 'utf8')) as ProbeResult
  const manifests = loadManifests(arg('--manifests'))

  if (projectionResult.input?.purpose !== 'push') {
    console.error(`${projectionPath} is not a schema.prisma projection result`)
    process.exit(2)
  }

  section('PRODUCTION LINEAGE')
  console.log(`  capture      ${capturePath} (${capture.verdict})`)
  console.log(`  projection   ${projectionPath}`)
  console.log(`               ${JSON.stringify(projectionResult.input.source)}`)
  console.log(`  manifests    ${manifests.length} (${manifests.map(m => m.id).join(', ') || 'none'})`)

  section('TLS')
  if (capture.tls) {
    console.log(`  authorized=${capture.tls.authorized} server.ssl=${capture.tls.server.ssl} ${capture.tls.protocol} ${capture.tls.server.cipher}`)
    console.log(`  chain ${capture.tls.chain.map(c => c.subject).join(' <- ')}`)
  } else {
    console.log('  no TLS observation')
  }

  section('RLS VISIBILITY')
  if (capture.rls) {
    console.log(`  consistent=${capture.rls.consistent} pg_policy=${capture.rls.policiesTotalUnjoined} joined=${capture.rls.policiesTotalJoined} view=${capture.rls.policiesTotalView}`)
    for (const s of capture.rls.bySchema) {
      console.log(`    ${s.schema.padEnd(24)} tables=${String(s.tables).padStart(4)} rls=${s.rlsEnabled} forced=${s.rlsForced} policies=${s.policiesFromCatalog}  ${s.classification}`)
    }
  }

  let pToProd: Difference[] = []
  let attributions: Attribution[] = []
  if (projectionResult.snapshot && capture.snapshot) {
    pToProd = diffSnapshots(projectionResult.snapshot, capture.snapshot)
    attributions = attribute(pToProd, manifests)

    section('P -> C_prod   what production holds beyond or below the current model')
    for (const c of countByKind(pToProd)) {
      console.log(`  ${c.kind.padEnd(14)} missing ${String(c.missing).padStart(4)}   differs ${String(c.differs).padStart(4)}   extra ${String(c.extra).padStart(4)}`)
    }

    const bad = pToProd.filter(d => d.status !== 'extra_in_right')
    if (bad.length) {
      console.log('\n  missing from production, or defined differently:')
      for (const d of bad.slice(0, 40)) {
        const detail = d.fields ? d.fields.map(f => `${f.field}: ${JSON.stringify(f.left)} -> ${JSON.stringify(f.right)}`).join(', ') : ''
        console.log(`    ${d.status.padEnd(18)} ${d.key}${detail ? `  (${detail})` : ''}`)
      }
      if (bad.length > 40) console.log(`    … and ${bad.length - 40} more`)
    }

    section('ATTRIBUTION')
    const byBucket = new Map<string, Attribution[]>()
    for (const a of attributions) byBucket.set(a.bucket, [...(byBucket.get(a.bucket) ?? []), a])
    for (const bucket of ['known_legacy_sql_effect', 'known_provisioning_effect', 'expected_environmental_difference', 'unexplained_divergence']) {
      console.log(`  ${bucket.padEnd(34)} ${(byBucket.get(bucket) ?? []).length}`)
    }
    const unexplained = byBucket.get('unexplained_divergence') ?? []
    if (unexplained.length) {
      console.log('\n  unexplained:')
      for (const a of unexplained.slice(0, 60)) console.log(`    ${a.difference.key}  (${a.reason})`)
      if (unexplained.length > 60) console.log(`    … and ${unexplained.length - 60} more`)
    }

    // Production is not required to match staging. An entry that matched nothing
    // is information about how the two environments were provisioned, not a fault.
    const claimed = new Set(attributions.filter(a => a.source).map(a => a.difference.key))
    const unobserved = manifests.flatMap(m => m.entries.filter(e => !claimed.has(e.key)).map(e => `${m.id}: ${e.key}`))
    console.log(`\n  manifest entries not observed in production: ${unobserved.length}`)
    for (const u of unobserved.slice(0, 20)) console.log(`    ${u}`)
    if (unobserved.length > 20) console.log(`    … and ${unobserved.length - 20} more`)
  }

  const evidence: ProductionEvidence = {
    captureVerdict: capture.verdict ?? null,
    projectionPresent: Boolean(projectionResult.snapshot),
    projectionEngine: projectionResult.snapshot?.meta.serverVersion ?? null,
    productionEngine: capture.snapshot?.meta.serverVersion ?? null,
    rlsConsistent: capture.rls ? capture.rls.consistent : null,
  }
  const result = gateProduction(pToProd, attributions, evidence)

  section('VERDICT')
  console.log(`  ${result.verdict}`)
  for (const r of result.reasons) console.log(`    - ${r}`)
  for (const n of result.notes) console.log(`    note: ${n}`)
  console.log('\n  This describes production state only. Baseline eligibility additionally')
  console.log('  depends on a delivery mechanism proven on staging first.')

  const out = arg('--out')
  if (out) {
    writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), evidence, gate: result, pToProd, attributions }, null, 2))
    console.log(`\n  wrote ${out}`)
  }
  process.exitCode = result.verdict === 'PRODUCTION_LINEAGE_EXPLAINED' ? 0 : 1
}

main()
