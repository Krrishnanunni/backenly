/**
 * The canonical baseline: one squashed migration generated from schema.prisma,
 * pinned by digest, and containing Layer 3 and nothing else.
 *
 * The legacy 18-migration chain is not history. It builds 50 of 119 tables and
 * lives in tools/migration-lineage/evidence as forensic evidence, which is why
 * these checks also assert it has not crept back into the canonical directory.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { BASELINE_ID, BASELINE_LOCK_PATH, BASELINE_SQL_PATH, generateBaselineSql, type BaselineLock } from '../../tools/managed-db/generate-baseline'
import { auditBaselineSql } from '../../tools/managed-db/layers'
import { assembleMigrationWorkspace, CANONICAL_DIR } from '../../tools/managed-db/migration-workspace'

const ROOT = join(__dirname, '..', '..')
const sql = readFileSync(join(ROOT, BASELINE_SQL_PATH), 'utf8')
const lock: BaselineLock = JSON.parse(readFileSync(join(ROOT, BASELINE_LOCK_PATH), 'utf8'))
const sha256 = (v: string) => createHash('sha256').update(v).digest('hex')

describe('the canonical baseline', () => {
  it('is pinned by digest', () => {
    expect({ sha256: sha256(sql), bytes: sql.length }).toEqual({ sha256: lock.sha256, bytes: lock.bytes })
    expect(lock.migration).toBe(BASELINE_ID)
  })

  it('still matches schema.prisma', () => {
    // Spawns the pinned Prisma CLI; no database is involved. This is what
    // notices a schema.prisma change that nobody baselined.
    const regenerated = generateBaselineSql(ROOT)
    expect(sha256(regenerated.sql)).toBe(lock.sha256)
    expect(regenerated.schemaSha256).toBe(lock.schemaSha256)
  }, 120_000)

  it('owns the canonical schema and nothing else', () => {
    expect(auditBaselineSql(sql)).toEqual([])
    expect(sql).toMatch(/CREATE TABLE "projects"/)
    expect(sql).not.toMatch(/CREATE EXTENSION|CREATE ROLE|\bGRANT\b|EVENT TRIGGER/i)
  })

  it('is the only migration in the canonical directory', () => {
    const entries = readdirSync(join(ROOT, CANONICAL_DIR)).sort()
    expect(entries).toEqual([BASELINE_ID, 'migration_lock.toml'])
  })

  it('does not live in the gitignored working directory', () => {
    // prisma/migrations stays a scratch path: on developer machines it still
    // holds the legacy corpus, and shipping that would apply a history that
    // builds less than half the schema.
    const ignore = readFileSync(join(ROOT, '.gitignore'), 'utf8').split(/\r?\n/)
    expect(ignore).toContain('/prisma/migrations')
    expect(BASELINE_SQL_PATH.replace(/\\/g, '/')).toMatch(/^prisma\/migrations-canonical\//)
  })
})

describe('the assembled migration workspace', () => {
  it('contains the schema and only the canonical history', () => {
    const workspace = assembleMigrationWorkspace(ROOT)
    try {
      expect(workspace.migrations).toEqual([BASELINE_ID])
      expect(existsSync(workspace.schemaPath)).toBe(true)
      expect(existsSync(join(workspace.migrationsDir, BASELINE_ID, 'migration.sql'))).toBe(true)
      expect(existsSync(join(workspace.migrationsDir, 'migration_lock.toml'))).toBe(true)
      expect(readFileSync(join(workspace.migrationsDir, BASELINE_ID, 'migration.sql'), 'utf8')).toBe(sql)
    } finally {
      workspace.dispose()
    }
  })

  it('can carry a rehearsal-only migration without writing it into the repository', () => {
    const workspace = assembleMigrationWorkspace(ROOT, [{ id: '20260916000000_fixture', sql: 'SELECT 1;' }])
    try {
      expect(workspace.migrations).toEqual([BASELINE_ID, '20260916000000_fixture'])
      expect(existsSync(join(ROOT, CANONICAL_DIR, '20260916000000_fixture'))).toBe(false)
    } finally {
      workspace.dispose()
    }
  })

  it('cleans up after itself', () => {
    const workspace = assembleMigrationWorkspace(ROOT)
    workspace.dispose()
    expect(existsSync(workspace.dir)).toBe(false)
  })
})
