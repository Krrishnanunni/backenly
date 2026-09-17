/**
 * The self-hosted build must not present itself as a hosted SaaS.
 *
 * A cold install on 2026-09-17 showed the opposite: the root URL served the
 * marketing site including pricing and the competitor comparisons, the shell
 * showed a hardcoded "Free" plan chip against unlimited entitlements, the
 * account Usage page was permanently broken because it called an endpoint that
 * only ships with the Cloud overlay, and the 404 page offered "Get started
 * free". Branching and backups were then moved to Cloud-only by founder
 * decision.
 *
 * None of that is visible in a diff, and all of it regresses the moment
 * somebody adds a nav item, a CTA or a fetch without thinking about edition.
 * So this asserts the SHAPE of the separation rather than any one call site.
 *
 * Like `oss-surface.test.ts`, these are OSS contracts: composed Cloud restores
 * the surfaces asserted absent here, so the suite states that precondition
 * instead of asking private CI to maintain an exclusion list.
 */
import * as fs from 'fs'
import * as path from 'path'

const ROOT = process.cwd()

/** True when the Cloud overlay has been applied over this checkout. */
const composed = fs.existsSync(path.join(ROOT, 'lib/cloud/manifest.json'))
const describeOss = composed ? describe.skip : describe

const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

/** Strip comments so prose explaining a removal is not read as the thing itself. */
const code = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')

describeOss('self-host surface separation', () => {
  describe('the edition seam itself', () => {
    it('resolves CLOUD_CONTROL_PLANE false without the overlay', () => {
      expect(code('lib/edition/oss/control-plane.ts')).toMatch(
        /export const CLOUD_CONTROL_PLANE = false/
      )
    })

    it('exposes a server-side guard that is separate from the presentation flag', () => {
      const guard = code('lib/edition/cloud-only.ts')
      // The guard must read the edition on the server. CLOUD_CONTROL_PLANE is a
      // client-visible build constant and its own header forbids using it as an
      // access check, so a guard built on it would be trivially flipped.
      expect(guard).toMatch(/currentEdition\(\)/)
      expect(guard).not.toMatch(/CLOUD_CONTROL_PLANE/)
    })
  })

  describe('marketing belongs to Cloud', () => {
    it('middleware redirects marketing paths away when the overlay is absent', () => {
      const mw = code('middleware.ts')
      expect(mw).toMatch(/CLOUD_CONTROL_PLANE/)
      expect(mw).toMatch(/isMarketingPath/)
      // The redirect must be conditional on edition, never unconditional.
      expect(mw).toMatch(/!CLOUD_CONTROL_PLANE\s*&&\s*isMarketingPath\(pathname\)/)
    })

    it('covers every marketing route that exists in the tree', () => {
      const mw = read('middleware.ts')
      const marketingDirs = [
        'pricing',
        'comparisons',
        'alternatives',
        'features',
        'use-cases',
        'resources',
        'contact',
        'terms',
        'privacy',
        'refund-policy',
      ].filter((d) => fs.existsSync(path.join(ROOT, 'app', d)))

      // Every marketing directory present on disk must be named in the
      // middleware lists, or a new landing page silently becomes reachable on
      // somebody's private infrastructure.
      for (const dir of marketingDirs) {
        expect(mw).toContain(`'/${dir}'`)
      }
    })

    it('never blocks the routes that reach the product', () => {
      const mw = code('middleware.ts')
      const marketingBlock = mw.slice(
        mw.indexOf('const marketingRoutes'),
        mw.indexOf('function isMarketingPath')
      )
      for (const keep of ['/auth', '/login', '/signup', '/app']) {
        expect(marketingBlock).not.toContain(`'${keep}'`)
      }
    })
  })

  describe('no plan, no upsell', () => {
    it('does not report a Cloud plan name off Cloud', () => {
      // The Subscription table is not in the self-host schema, so the resolver
      // returns null and the fallback is what an operator actually sees.
      expect(code('lib/autonomy/autonomy-level.ts')).toMatch(
        /isCloudEdition\(\)\s*\?\s*'Free'\s*:\s*'Self-hosted'/
      )
    })

    it('renders no plan chip in the OSS identity chip', () => {
      const chip = code('lib/edition/oss/org-switcher.tsx')
      expect(chip).not.toMatch(/\{plan\}/)
    })

    it('gates every Upgrade affordance in the dashboard on the overlay', () => {
      // Any button that routes to /app/billing must sit behind the flag: the
      // page it targets ships only with the overlay, so an ungated one is a
      // guaranteed 404 and an upsell with nothing behind it.
      for (const rel of ['app/app/page.tsx', 'app/app/usage/page.tsx']) {
        const src = code(rel)
        if (!src.includes('/app/billing')) continue
        expect(src).toMatch(/CLOUD_CONTROL_PLANE/)
      }
    })

    it('keeps the 404 page free of marketing CTAs off Cloud', () => {
      const nf = code('app/not-found.tsx')
      expect(nf).toMatch(/CLOUD_CONTROL_PLANE/)
      // Pricing / signup links must be inside the guard, not at the top level.
      const guarded = nf.indexOf('CLOUD_CONTROL_PLANE &&')
      expect(guarded).toBeGreaterThan(-1)
      // JSX attribute form, not a quoted string literal.
      const pricingAt = nf.indexOf('href="/pricing"')
      expect(pricingAt).toBeGreaterThan(guarded)
      expect(nf.indexOf('href="/auth/signup"')).toBeGreaterThan(guarded)
    })
  })

  describe('Cloud-only capabilities refuse at the service layer', () => {
    // Gating the HTTP route alone leaves the agent tool and the scheduler open,
    // and MCP is the door this product leads with.
    it('branches engine refuses off Cloud', () => {
      const engine = code('lib/branches/engine.ts')
      expect(engine).toMatch(/assertCloudEdition\('Preview branches'\)/)
      for (const fn of ['createBranch', 'mergeBranch', 'discardBranch', 'diffBranch']) {
        const at = engine.indexOf(`export async function ${fn}`)
        expect(at).toBeGreaterThan(-1)
        // The guard must be inside the function, near the top.
        expect(engine.slice(at, at + 600)).toMatch(/assertCloudEdition/)
      }
    })

    it('backup service refuses off Cloud, before the try that records failures', () => {
      const svc = code('lib/services/workspace-backup.ts')
      const at = svc.indexOf('export async function backupWorkspace')
      const tryAt = svc.indexOf('try {', at)
      const guardAt = svc.indexOf('assertCloudEdition', at)
      expect(guardAt).toBeGreaterThan(-1)
      // A guard inside the try would be swallowed and persisted as a failed
      // backup row, which is not what an edition refusal is.
      expect(guardAt).toBeLessThan(tryAt)
      expect(svc).toMatch(/export async function restoreWorkspace[\s\S]{0,300}assertCloudEdition/)
    })

    it('read paths answer empty rather than throwing', () => {
      // "What exists here" has a correct answer off Cloud, and it is none.
      expect(code('lib/branches/engine.ts')).toMatch(
        /export async function listBranches[\s\S]{0,400}isCloudEdition\(\)[\s\S]{0,80}return \[\]/
      )
      expect(code('lib/services/workspace-backup.ts')).toMatch(
        /export async function listBackups[\s\S]{0,400}isCloudEdition\(\)[\s\S]{0,80}return \[\]/
      )
    })

    it('the daily backup scheduler returns rather than throws', () => {
      expect(code('lib/services/workspace-backup.ts')).toMatch(
        /export async function runDailyBackups[\s\S]{0,500}isCloudEdition\(\)[\s\S]{0,120}return \{ ran: 0/
      )
    })

    it('their HTTP routes answer 404, not 403', () => {
      // Off Cloud the capability does not exist; 403 would imply it is present
      // and merely withheld.
      for (const rel of [
        'app/api/projects/[id]/branches/route.ts',
        'app/api/projects/[id]/branches/[branchId]/route.ts',
        'app/api/projects/[id]/backup/route.ts',
      ]) {
        const src = code(rel)
        expect(src).toMatch(/isCloudEdition/)
        expect(src).toMatch(/status: 404/)
        expect(src).not.toMatch(/CLOUD_ONLY_FEATURE[\s\S]{0,120}status: 403/)
      }
    })
  })

  describe('the dashboard offers no control for refused work', () => {
    it('drops Branches from the project sidebar off Cloud', () => {
      const nav = code('components/shell/ProjectSidebar.tsx')
      expect(nav).toMatch(/CLOUD_CONTROL_PLANE[\s\S]{0,200}id: 'branches'/)
    })

    it('drops Usage, Members and Billing from the org nav off Cloud', () => {
      const nav = code('components/shell/OrgShell.tsx')
      const guardAt = nav.indexOf('CLOUD_CONTROL_PLANE')
      for (const id of ["id: 'usage'", "id: 'members'", "id: 'billing'"]) {
        const at = nav.indexOf(id)
        expect(at).toBeGreaterThan(-1)
        expect(at).toBeGreaterThan(guardAt)
      }
    })

    it('guards the pages themselves, not only the nav', () => {
      // A typed URL or an old bookmark still resolves; without this the page
      // renders a shell whose every call answers 404.
      for (const rel of ['app/app/projects/[id]/branches/page.tsx', 'app/app/usage/page.tsx']) {
        const src = code(rel)
        expect(src).toMatch(/CLOUD_CONTROL_PLANE/)
        expect(src).toMatch(/notFound\(\)/)
      }
    })

    it('drops the Cloud command-palette entries off Cloud', () => {
      const palette = code('components/app/CommandPalette.tsx')
      for (const id of ["id: 'p-branches'", "id: 'a-members'", "id: 'a-billing'"]) {
        const at = palette.indexOf(id)
        expect(at).toBeGreaterThan(-1)
        const before = palette.slice(Math.max(0, at - 400), at)
        expect(before).toMatch(/CLOUD_CONTROL_PLANE/)
      }
    })
  })
})
