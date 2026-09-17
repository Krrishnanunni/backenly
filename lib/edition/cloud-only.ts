/**
 * Capabilities that belong to Backenly Cloud and are not part of a self-hosted
 * deployment.
 *
 * ---- WHY A SERVICE-LEVEL GUARD AND NOT A ROUTE CHECK --------------------
 *
 * Each of these capabilities has several front doors: an HTTP route, an agent
 * tool in `lib/ai/brain/tools.ts`, and in some cases a scheduler tick. Gating
 * the route alone leaves the other two open, and the MCP surface is the door
 * this product actually leads with. Guarding the service means one refusal
 * that every caller inherits, and a new caller added later cannot miss it.
 *
 * This is an authorization decision, so it reads `currentEdition()` on the
 * server. `CLOUD_CONTROL_PLANE` is the sibling seam for *presentation* — which
 * surfaces a build contains — and is explicitly documented as never being an
 * access check. Both are needed: this one refuses the work, that one stops the
 * dashboard offering a control for work that will be refused.
 */
import { currentEdition } from '@/lib/edition'

export class CloudOnlyFeatureError extends Error {
  readonly code = 'CLOUD_ONLY_FEATURE'
  readonly feature: string

  constructor(feature: string) {
    super(
      `${feature} is part of Backenly Cloud and is not available in a self-hosted deployment.`
    )
    this.name = 'CloudOnlyFeatureError'
    this.feature = feature
  }
}

/** True when this deployment is Backenly Cloud rather than a self-host install. */
export function isCloudEdition(): boolean {
  return currentEdition() === 'cloud'
}

/**
 * Refuse a Cloud-only capability outside Cloud.
 *
 * Callers that answer HTTP should map this to 404 rather than 403: on a
 * self-hosted deployment the capability does not exist, and 403 would suggest
 * it is there and merely withheld.
 */
export function assertCloudEdition(feature: string): void {
  if (!isCloudEdition()) throw new CloudOnlyFeatureError(feature)
}
