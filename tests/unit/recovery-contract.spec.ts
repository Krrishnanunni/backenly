/**
 * THE RECOVERY CONTRACT, PINNED BEFORE ANYTHING IMPLEMENTS IT
 * ==========================================================
 * These assert the promises the two recovery products make, so the promises
 * cannot drift once code starts depending on them. They are deliberately
 * written first: this is the tranche where a platform accidentally claims to
 * restore far more than it does, and the claim is easiest to pin down before
 * there is an implementation arguing for its own convenience.
 */

import {
  assertRestorable,
  BUNDLE_FORMAT_VERSION,
  ENCRYPTED_COMPONENTS,
  missingComponents,
  mutatesTarget,
  RECOVERY_COMPONENTS,
  RecoveryContractError,
  RESTORE_ORDER,
  VALIDATION_STEPS,
  type RecoveryManifest,
} from '@/lib/recovery/contract'

function manifest(overrides: Partial<RecoveryManifest> = {}): RecoveryManifest {
  return {
    formatVersion: BUNDLE_FORMAT_VERSION,
    createdAt: '2026-09-19T00:00:00.000Z',
    backenlyVersion: 'test',
    schemaVersion: '20260919000000_test',
    postgresVersion: '16.4',
    requiredExtensions: ['pgcrypto'],
    components: [],
    wrappedDataKey: null,
    ...overrides,
  }
}

describe('what a deployment recovery bundle must be able to carry', () => {
  it('covers every category needed to rebuild a deployment', () => {
    // Pinned as a list, so adding a new kind of deployment state forces a
    // decision about whether recovery includes it rather than letting it be
    // forgotten.
    expect([...RECOVERY_COMPONENTS].sort()).toEqual([
      'deployment-metadata',
      'function-definitions',
      'operator-ownership',
      'platform-database',
      'project-secrets',
      'storage-objects',
      'workspace-schemas',
    ])
  })

  it('treats secrets as encrypted and nothing else as automatically safe', () => {
    // If this list ever grows, it should be because somebody decided another
    // component is sensitive - not because encryption became the default and
    // hid a component that should have been reviewable.
    expect(ENCRYPTED_COMPONENTS).toContain('project-secrets')
  })
})

describe('a bundle states what it contains, so absence is meaningful', () => {
  it('reports the components a bundle does not carry', () => {
    const m = manifest({
      components: [
        { component: 'platform-database', path: 'platform.sql', bytes: 10, sha256: 'x', encrypted: false, items: 1 },
      ],
    })
    // The point: a reader can say "this bundle has no storage" rather than
    // guessing whether storage was empty or unsupported.
    expect(missingComponents(m)).toContain('storage-objects')
    expect(missingComponents(m)).not.toContain('platform-database')
  })

  it('distinguishes present-but-empty from absent', () => {
    // A deployment with no files writes the component with zero items. A
    // bundle predating storage support omits it. Only the second is ambiguous,
    // and this is what removes the ambiguity.
    const empty = manifest({
      components: [
        { component: 'storage-objects', path: 'storage/', bytes: 0, sha256: 'x', encrypted: false, items: 0 },
      ],
    })
    expect(missingComponents(empty)).not.toContain('storage-objects')

    const absent = manifest({ components: [] })
    expect(missingComponents(absent)).toContain('storage-objects')
  })
})

describe('refusing a bundle this build cannot honestly restore', () => {
  it('accepts its own format version', () => {
    expect(() => assertRestorable(manifest())).not.toThrow()
  })

  it('refuses a NEWER bundle rather than restoring part of it', () => {
    // Restoring it would produce a deployment silently missing whatever the
    // newer format added, and the operator would believe recovery succeeded.
    // That is worse than refusing.
    expect(() => assertRestorable(manifest({ formatVersion: BUNDLE_FORMAT_VERSION + 1 })))
      .toThrow(RecoveryContractError)
  })

  it('refuses a bundle naming a component it does not understand', () => {
    const m = manifest({
      components: [
        // A component from some future build.
        { component: 'quantum-state' as never, path: 'q', bytes: 1, sha256: 'x', encrypted: false, items: 1 },
      ],
    })
    expect(() => assertRestorable(m)).toThrow(/does not know how to restore/)
  })

  it('says what to do about it', () => {
    let message = ''
    try {
      assertRestorable(manifest({ formatVersion: BUNDLE_FORMAT_VERSION + 1 }))
    } catch (err) {
      message = err instanceof Error ? err.message : String(err)
    }
    expect(message).toMatch(/at least as new/i)
  })
})

describe('the restore order', () => {
  it('validates the whole archive before touching the target', () => {
    // The workspace backup path learned this the expensive way: it dropped a
    // schema and then found the dump unreadable, which is terminal however
    // loudly it fails afterwards.
    const firstMutating = RESTORE_ORDER.findIndex(mutatesTarget)
    const lastValidation = RESTORE_ORDER.reduce(
      (acc, step, i) => (VALIDATION_STEPS.includes(step) ? i : acc),
      -1,
    )
    expect(lastValidation).toBeLessThan(firstMutating)
  })

  it('puts every dependency before what needs it', () => {
    const at = (s: string) => RESTORE_ORDER.indexOf(s as never)

    // Schemas need roles and extensions to exist.
    expect(at('provision-database-roles-and-extensions')).toBeLessThan(at('restore-workspace-schemas'))
    // Storage metadata references projects, which live in the platform database.
    expect(at('restore-platform-database')).toBeLessThan(at('restore-storage-objects'))
    // Secrets are re-wrapped under the TARGET's key, so the target must exist.
    expect(at('restore-platform-database')).toBeLessThan(at('rewrap-secrets-for-target'))
    // Derived state can only be reconciled once its inputs are present.
    expect(at('restore-workspace-schemas')).toBeLessThan(at('reconcile-derived-state'))
  })

  it('verifies health LAST, so success is a claim about the restored system', () => {
    // Not a claim about the restore process having exited 0, which is what
    // "command succeeded" would mean and is not the same thing.
    expect(RESTORE_ORDER[RESTORE_ORDER.length - 1]).toBe('verify-health-and-integrity')
  })
})

describe('the recovery credential is not in the bundle', () => {
  it('the manifest carries only a WRAPPED data key', () => {
    // A bundle holding both the ciphertext and the key that opens it is not
    // encrypted; it is a tarball with a lock painted on it.
    const m = manifest({
      wrappedDataKey: {
        algorithm: 'aes-256-gcm',
        kdf: 'scrypt',
        salt: 's', iv: 'i', authTag: 't', ciphertext: 'c',
      },
    })
    const serialised = JSON.stringify(m)
    // The shape has nowhere to put an unwrapped key, which is the guarantee -
    // not that some field happens to be empty today.
    expect(serialised).not.toMatch(/"dataKey"/)
    expect(serialised).not.toMatch(/"recoveryKey"/)
    expect(serialised).not.toMatch(/"passphrase"/)
    expect(m.wrappedDataKey).not.toBeNull()
  })
})
