/**
 * THE TWO RECOVERY PRODUCTS, AND WHAT EACH ONE DOES NOT COVER
 * ==========================================================
 *
 * Written before any implementation, because this is where a platform
 * accidentally promises far more than it restores. An operator who clicks
 * something called "Backup" and concludes their server is safe has been
 * misled by the product, not by their own carelessness.
 *
 * There are exactly two, and they are never the same thing:
 *
 *   PROJECT DATABASE SNAPSHOT
 *     One workspace schema. Tables, rows, indexes, constraints, RLS policies,
 *     and the triggers and functions that live inside that schema.
 *     NOT storage files. NOT platform accounts. NOT API keys. NOT project
 *     configuration or env. NOT function source. NOT deployment config.
 *     Useful for schema/data rollback and for moving a project. It is NOT
 *     disaster recovery and must never be presented as though it were.
 *
 *   DEPLOYMENT RECOVERY BUNDLE
 *     Enough state to rebuild a self-hosted Backenly on a clean machine. This
 *     is the only artifact that may be described as disaster recovery.
 *
 * The distinction is carried in the UI wording too: "Database snapshot" and
 * "Deployment recovery", never a bare "Backup" that could mean either.
 *
 * ── Why the component list is machine-readable ──────────────────────────────
 *
 * Every bundle records which components it actually contains. Without that, a
 * bundle written before storage support existed would be indistinguishable from
 * one whose storage happened to be empty, and a restore would silently produce
 * a deployment missing files nobody knew were absent. The manifest must be able
 * to say "this predates that component" rather than leaving it to be inferred.
 *
 * ── Why the recovery key lives outside the bundle ───────────────────────────
 *
 * A bundle that contains both the encrypted secrets and the key that opens them
 * is not encrypted; it is a tarball with a lock painted on it. Anyone who
 * obtains the file obtains the OAuth client secrets, project env vars and
 * signing secrets inside it.
 *
 * So sensitive sections are encrypted with a per-bundle data key, and that data
 * key is wrapped by an operator-held recovery credential which is never written
 * into the archive. Losing the bundle alone discloses nothing sensitive; losing
 * the bundle AND the recovery credential is the operator's own key-management
 * failure, which is a boundary they can reason about.
 */

/** Bump when the on-disk shape changes in a way older readers cannot handle. */
export const BUNDLE_FORMAT_VERSION = 1

/**
 * The components a deployment recovery bundle can carry.
 *
 * Recorded per bundle rather than assumed, so an older archive cannot be read
 * as though it contained something that did not exist when it was written.
 */
export const RECOVERY_COMPONENTS = [
  /** The platform database: projects, users, keys metadata, autonomy state. */
  'platform-database',
  /** Every `workspace_<projectId>` schema, with data. */
  'workspace-schemas',
  /** Stored objects plus the metadata rows that describe them. */
  'storage-objects',
  /** Serverless function definitions and their source. */
  'function-definitions',
  /** Per-project configuration and environment, encrypted. */
  'project-secrets',
  /** Which account owns the deployment, and admin role assignments. */
  'operator-ownership',
  /** Backenly version, Prisma schema version, required PostgreSQL extensions. */
  'deployment-metadata',
] as const

export type RecoveryComponent = (typeof RECOVERY_COMPONENTS)[number]

/** Components whose contents are encrypted under the recovery credential. */
export const ENCRYPTED_COMPONENTS: readonly RecoveryComponent[] = [
  'project-secrets',
]

export interface ComponentEntry {
  component: RecoveryComponent
  /** Path inside the bundle. */
  path: string
  bytes: number
  /** SHA-256 of the file as written, so corruption is detected before use. */
  sha256: string
  /** True when this entry is encrypted under the bundle data key. */
  encrypted: boolean
  /**
   * Present and empty is different from absent.
   *
   * A deployment with no storage objects writes this component with zero
   * items; a bundle that predates storage support omits the component
   * entirely. Only the second is ambiguous, and recording both removes the
   * ambiguity.
   */
  items: number
}

export interface RecoveryManifest {
  formatVersion: number
  /** ISO-8601, when the bundle was written. */
  createdAt: string
  /** The Backenly build that wrote it. */
  backenlyVersion: string
  /** Prisma migration the platform database was at. */
  schemaVersion: string
  /** PostgreSQL server version the source ran on. */
  postgresVersion: string
  /** Extensions the restore target must be able to provide. */
  requiredExtensions: string[]
  /** Exactly what this bundle contains. Absence is meaningful. */
  components: ComponentEntry[]
  /**
   * The per-bundle data key, wrapped by the operator's recovery credential.
   * The credential itself is NEVER present in the bundle.
   */
  wrappedDataKey: {
    algorithm: 'aes-256-gcm'
    /** KDF used to turn the operator passphrase into a wrapping key. */
    kdf: 'scrypt'
    salt: string
    iv: string
    authTag: string
    ciphertext: string
  } | null
}

/**
 * The order a restore must follow.
 *
 * Deterministic and dependency-ordered: workspace schemas need roles and
 * extensions, storage metadata references projects, secrets must be re-wrapped
 * under the TARGET deployment's key rather than the source's, and derived state
 * has to be reconciled only once everything it derives from exists.
 *
 * Nothing in this list may touch a live installation before validation has
 * passed over the whole archive. The workspace backup path learned that the
 * expensive way: it dropped a schema and then discovered the dump was
 * unreadable, which is terminal however loudly it fails afterwards.
 */
export const RESTORE_ORDER = [
  'validate-manifest',
  'validate-checksums',
  'validate-version-compatibility',
  'provision-database-roles-and-extensions',
  'restore-platform-database',
  'restore-workspace-schemas',
  'restore-storage-objects',
  'restore-function-definitions',
  'rewrap-secrets-for-target',
  'reconcile-derived-state',
  'verify-health-and-integrity',
] as const

export type RestoreStep = (typeof RESTORE_ORDER)[number]

/** Steps that only read the archive. Everything after the last one mutates. */
export const VALIDATION_STEPS: readonly RestoreStep[] = [
  'validate-manifest',
  'validate-checksums',
  'validate-version-compatibility',
]

/** True when this step changes the target deployment. */
export function mutatesTarget(step: RestoreStep): boolean {
  return !VALIDATION_STEPS.includes(step)
}

export class RecoveryContractError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RecoveryContractError'
  }
}

/**
 * Refuse a bundle this build cannot honestly restore.
 *
 * A newer bundle may name components this build has never heard of. Restoring
 * it would produce a deployment silently missing them, which is worse than
 * refusing: the operator would believe recovery succeeded.
 */
export function assertRestorable(manifest: RecoveryManifest): void {
  if (manifest.formatVersion > BUNDLE_FORMAT_VERSION) {
    throw new RecoveryContractError(
      `This bundle is format version ${manifest.formatVersion}; this build understands ${BUNDLE_FORMAT_VERSION}. ` +
      `Restore it with a Backenly at least as new as the one that wrote it.`,
    )
  }

  const known = new Set<string>(RECOVERY_COMPONENTS)
  const unknown = manifest.components.map(c => c.component).filter(c => !known.has(c))
  if (unknown.length > 0) {
    throw new RecoveryContractError(
      `This bundle contains components this build does not know how to restore: ${unknown.join(', ')}. ` +
      `Restoring it would produce a deployment silently missing them.`,
    )
  }
}

/**
 * What a bundle does NOT contain, stated positively.
 *
 * Used by the UI and the CLI so the answer comes from the manifest rather than
 * from a sentence somebody wrote once and forgot to update.
 */
export function missingComponents(manifest: RecoveryManifest): RecoveryComponent[] {
  const present = new Set(manifest.components.map(c => c.component))
  return RECOVERY_COMPONENTS.filter(c => !present.has(c))
}

/**
 * DURABLE CREDENTIALS SURVIVE RECOVERY. EPHEMERAL ONES MUST NOT.
 * =============================================================
 *
 * A bundle that restores everything restores too much. The distinction is not
 * "secret vs not secret" — it is whether a client outside the deployment
 * depends on the value continuing to exist.
 *
 * DURABLE things are why recovery is worth doing. A project's signing secret,
 * its anon key, its API keys and its OAuth configuration are embedded in
 * client bundles, CI pipelines and other people's code. Recovering a
 * deployment that issued fresh ones would technically be "restored" and would
 * break every caller, which is not recovery in any sense the operator meant.
 *
 * EPHEMERAL things are the opposite: one-time or time-bounded proofs of a
 * moment. Restoring a week-old bundle must not resurrect a session somebody
 * revoked, a password-reset link that was already used, a magic link that has
 * since been cancelled, or the setup token that claims an unclaimed
 * deployment. Each of those would hand back an authentication path that was
 * deliberately taken away.
 *
 * Identity is durable; proof of a past login is not. After recovery a user's
 * account and password hash are intact and they sign in again.
 */

/** Restored as-is. Clients outside the deployment depend on these values. */
export const DURABLE_CREDENTIALS = [
  'project.jwtSecret',
  'project.anonKey',
  'apiKey.records',
  'authProvider.configuration',
  'project.envVars',
  'user.passwordHash',
  'user.identity',
] as const

/**
 * Deliberately NOT restored, even though they live in the same tables.
 *
 * `setupToken` is here for a reason worth stating: restoring it into an
 * already-claimed deployment would reintroduce a credential whose whole
 * purpose is to claim an unclaimed one.
 */
export const EPHEMERAL_CREDENTIALS = [
  'session.records',
  'passwordResetToken.records',
  'oidcAccessToken.records',
  'shareToken.records',
  'workspace._magic_links',
  'workspace._password_resets',
  'workspace._email_verifications',
  'workspace._token_blacklist',
  'deployment.setupToken',
] as const

export type DurableCredential = (typeof DURABLE_CREDENTIALS)[number]
export type EphemeralCredential = (typeof EPHEMERAL_CREDENTIALS)[number]

/**
 * SUBSYSTEMS THAT MUST BE SILENT WHILE A RESTORE IS IN FLIGHT.
 * ===========================================================
 *
 * A half-restored deployment is a deployment describing a state that was true
 * in the past. Anything that acts on state autonomously will act on that
 * description, and the actions reach the outside world where they cannot be
 * taken back.
 *
 * Concretely: webhook delivery would re-send events whose recipients already
 * processed them; email would re-send verifications and invitations; cron and
 * background jobs would re-run work already done; function invocations would
 * bill and mutate; and autonomy would observe a deliberately partial schema,
 * diagnose it as broken, and "repair" it — fighting the restore step by step.
 *
 * These stay off until `verify-health-and-integrity` passes, not until the
 * last write completes. A restore that finished writing is not yet a restore
 * that worked.
 */
export const QUIESCED_SUBSYSTEMS = [
  'cron-scheduler',
  'autonomy-reconciler',
  'webhook-delivery',
  'email-delivery',
  'background-jobs',
  'function-invocation',
] as const

export type QuiescedSubsystem = (typeof QUIESCED_SUBSYSTEMS)[number]

/** True when this subsystem may run at the given point in the restore. */
export function subsystemMayRun(step: RestoreStep, completed: boolean): boolean {
  // Only after the FINAL step has completed successfully. During any step,
  // including the last one while it is still running, everything stays off.
  return completed && step === 'verify-health-and-integrity'
}

/** A credential the restore must drop rather than carry across. */
export function isEphemeral(name: string): boolean {
  return (EPHEMERAL_CREDENTIALS as readonly string[]).includes(name)
}
