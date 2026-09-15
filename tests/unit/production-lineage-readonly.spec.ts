/**
 * The production capture is read-only, and that is checked against the artifact
 * rather than asserted in prose.
 *
 * The probe is bundled exactly as the launcher bundles it, and the result is
 * searched for the primitives that could change a database. The same audit is
 * pointed at the STAGING probe, which legitimately contains those primitives: if
 * the audit did not fail there, passing on the production bundle would mean
 * nothing.
 */

import { join } from 'node:path'
import {
  assertReadOnlyBundle,
  assertReadOnlyModuleGraph,
  auditModuleGraph,
  auditReadOnlyBundle,
} from '../../tools/production-lineage/readonly-audit'
import {
  assertExpectedDatabase,
  assertProductionUrl,
  assertRdsEndpoint,
  assertReadOnlySession,
  ProductionGuardRefusal,
} from '../../tools/production-lineage/probe/guards'
import { gateProduction, type ProductionEvidence } from '../../tools/production-lineage/verdict'
import { diffSnapshots } from '../../tools/migration-lineage/diff'
import { attribute } from '../../tools/migration-lineage/attribute'
import type { Snapshot } from '../../tools/migration-lineage/probe/capture'

const ROOT = join(__dirname, '..', '..')

async function bundle(entry: string): Promise<{ code: string; modules: string[] }> {
  const { build } = await import('esbuild')
  const result = await build({
    entryPoints: [join(ROOT, entry)],
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
  return { code: result.outputFiles[0].text, modules: Object.keys(result.metafile?.inputs ?? {}) }
}

jest.setTimeout(120_000)

describe('the production probe cannot mutate anything', () => {
  it('ships no mutation primitive and reaches no mutation-capable module', async () => {
    const { code, modules } = await bundle('tools/production-lineage/probe/task.ts')
    expect(auditReadOnlyBundle(code)).toEqual([])
    expect(auditModuleGraph(modules)).toEqual([])
    // It really is built on the shared capture, not a stripped copy of it.
    expect(modules.some(m => m.endsWith('tools/migration-lineage/probe/capture.ts'))).toBe(true)
  })

  it('both halves of the audit fail the staging probe, which really can mutate', async () => {
    // Non-vacuity. Without this, "no findings" could just mean the rules never
    // match anything.
    const { code, modules } = await bundle('tools/migration-lineage/probe/task.ts')
    expect(auditReadOnlyBundle(code).map(f => f.why)).toEqual(
      expect.arrayContaining(['creates a database', 'drops a database', 'accepts an arbitrary SQL payload']),
    )
    expect(auditModuleGraph(modules)).toEqual(expect.arrayContaining(['tools/migration-lineage/probe/scratch.ts']))
  })

  it('refuses a bundle that acquired a mutation primitive', () => {
    expect(() => assertReadOnlyBundle('const q = "CREATE DATABASE x";')).toThrow(/creates a database/)
    expect(() => assertReadOnlyBundle('const q = "INSERT INTO t VALUES (1)";')).toThrow(/writes rows/)
    expect(() => assertReadOnlyBundle('const q = "GRANT SELECT ON t TO anon";')).toThrow(/privileges/)
    expect(() => assertReadOnlyBundle('ssl: { rejectUnauthorized: false }')).toThrow(/TLS verification/)
    expect(() => assertReadOnlyBundle('const x = 1')).not.toThrow()
  })

  it('does not flag pg\'s own driver surface', () => {
    // Measured: `queryMode` is part of pg's Query class and appears in every
    // bundle containing the driver. A rule matching it would fail the honest
    // case, which is how a gate gets loosened until it proves nothing.
    expect(() => assertReadOnlyBundle('this.queryMode=e.queryMode,this.binary=e.binary')).not.toThrow()
  })

  it('refuses a module graph that reaches the scratch machinery', () => {
    expect(() => assertReadOnlyModuleGraph(['tools/migration-lineage/probe/capture.ts'])).not.toThrow()
    expect(() => assertReadOnlyModuleGraph(['tools/migration-lineage/probe/scratch.ts'])).toThrow(/mutation-capable/)
    expect(() => assertReadOnlyModuleGraph(['tools/migration-lineage/probe/input.ts'])).toThrow(/mutation-capable/)
  })
})

describe('production guards', () => {
  it('requires a URL that names production and not staging', () => {
    expect(() => assertProductionUrl('postgresql://u:p@backenly-production-pg.x.rds.amazonaws.com/backenly')).not.toThrow()
    expect(() => assertProductionUrl('postgresql://u:p@backenly-staging-pg.x.rds.amazonaws.com/backenly')).toThrow(ProductionGuardRefusal)
    expect(() => assertProductionUrl('postgresql://u:p@db.internal/backenly')).toThrow(/does not identify production/)
  })

  it('requires an RDS endpoint', () => {
    expect(() => assertRdsEndpoint('backenly-production-pg.abc.ap-south-1.rds.amazonaws.com')).not.toThrow()
    expect(() => assertRdsEndpoint('localhost')).toThrow(/RDS endpoint/)
  })

  it('requires the operator to state the database, and it to match', () => {
    expect(() => assertExpectedDatabase(undefined, 'backenly')).toThrow(/PRODUCTION_DB_NAME/)
    expect(() => assertExpectedDatabase('  ', 'backenly')).toThrow(/PRODUCTION_DB_NAME/)
    expect(() => assertExpectedDatabase('backenly', 'backenly_other')).toThrow(/expected "backenly"/)
    expect(() => assertExpectedDatabase('backenly', 'backenly')).not.toThrow()
  })

  it('requires the session to be read-only per the server', () => {
    expect(() => assertReadOnlySession('on')).not.toThrow()
    expect(() => assertReadOnlySession('off')).toThrow(/not read-only/)
    expect(() => assertReadOnlySession(undefined)).toThrow(/not read-only/)
  })
})

describe('the production gate', () => {
  const EMPTY: Snapshot = {
    meta: { database: 'd', serverVersion: '16.13', schemas: ['public'] },
    schemas: [{ name: 'public', owner: 'o' }],
    tables: [], columns: [], constraints: [], indexes: [], types: [], sequences: [],
    policies: [], triggers: [], routines: [], views: [], eventTriggers: [], extensions: [],
  }
  const clean: ProductionEvidence = {
    captureVerdict: 'PASS',
    projectionPresent: true,
    projectionEngine: '16.13',
    productionEngine: '16.13',
    rlsConsistent: true,
  }

  it('explains production when nothing is missing, different or unexplained', () => {
    expect(gateProduction([], [], clean).verdict).toBe('PRODUCTION_LINEAGE_EXPLAINED')
  })

  it('never claims baseline eligibility', () => {
    expect(JSON.stringify(gateProduction([], [], clean))).not.toMatch(/BASELINE_ELIGIBLE/)
  })

  it('requires reconciliation when production holds something unexplained', () => {
    const table = { schema: 'public', name: 'mystery', kind: 'r', persistence: 'p', partition: false, rls: false, force_rls: false }
    const d = diffSnapshots(EMPTY, { ...EMPTY, tables: [table] })
    const r = gateProduction(d, attribute(d, []), clean)
    expect(r.verdict).toBe('RECONCILIATION_REQUIRED')
    expect(r.counts.buckets.unexplained_divergence).toBe(1)
  })

  it.each([
    ['the capture did not pass', { captureVerdict: 'FAIL' }],
    ['there is no projection to compare against', { projectionPresent: false }],
    ['RLS reads disagreed', { rlsConsistent: false }],
    ['RLS was never measured', { rlsConsistent: null }],
    ['the engines differ by major version', { productionEngine: '17.2' }],
  ])('is inconclusive when %s', (_label, patch) => {
    expect(gateProduction([], [], { ...clean, ...patch } as ProductionEvidence).verdict).toBe('INCONCLUSIVE')
  })

  it('notes a minor engine difference without blocking on it', () => {
    const r = gateProduction([], [], { ...clean, productionEngine: '16.14' })
    expect(r.verdict).toBe('PRODUCTION_LINEAGE_EXPLAINED')
    expect(r.notes.join(' ')).toMatch(/same major/)
  })
})
