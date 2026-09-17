'use client'

/**
 * The TopBar identity chip, as resolved WITHOUT the private overlay.
 *
 * `@cloud/org-switcher` resolves here only when `lib/cloud/org-switcher.tsx` is
 * absent. The Cloud version is a real switcher: it lists every organization the
 * user belongs to, remembers the active one, and broadcasts the change. This
 * one is the static chip that switcher replaced.
 *
 * ---- WHY A CHIP RATHER THAN NOTHING --------------------------------------
 *
 * The alternative was for TopBar to render the switcher conditionally, which
 * puts an edition check in a shared shell file and leaves a gap in the layout
 * when it fails. A component that always exists and renders the right thing for
 * the build keeps the seam at the import and the shell edition-unaware.
 *
 * There is nothing to switch on a self-hosted deployment: one deployment is one
 * project, and organizations are Cloud control plane. So this shows who is
 * signed in and stops there. No dropdown affordance, no plan chip, and no
 * /api/org/list request to a route this build does not serve.
 */

/**
 * `plan` is accepted and deliberately ignored.
 *
 * TopBar passes the literal "Free", which is a Cloud plan name. A self-hosted
 * deployment has no plan: `selfHostedEntitlements()` leaves every ceiling null,
 * so the chip was telling an operator with unlimited entitlements that they
 * were on the free tier. Keeping the prop in the signature keeps this component
 * swappable with the Cloud switcher, which does render a real plan.
 */
export function OrgSwitcher({ fallbackName }: { fallbackName: string; plan?: string }) {
  return (
    <div className="relative">
      <div className="flex items-center gap-1.5 px-1.5 h-8 rounded-md">
        <span className="text-[12.5px] text-zinc-300 truncate max-w-[140px]">{fallbackName}</span>
      </div>
    </div>
  )
}

/**
 * No active organization to remember.
 *
 * Exported so callers can ask without an edition check of their own. Null is
 * the answer every consumer already handles: it is what the Cloud switcher
 * returns before its first fetch resolves.
 */
export function getActiveOrgId(): string | null {
  return null
}
