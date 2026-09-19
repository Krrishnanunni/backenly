/**
 * Marketing design tokens: one type scale, one hairline set, one rhythm.
 *
 * These started life inside app/page.tsx during the 2026-09-18 landing
 * redesign and were lifted here so the landing page and `kit.tsx` (which every
 * other marketing page is built from) cannot drift apart. A visitor moving from
 * `/` to `/pricing` should not feel the typography change under them.
 *
 * Plain strings, no React: safe to import from server and client components
 * alike.
 *
 * ── Two rules that are easy to break by accident ────────────────────────────
 *
 * 1. SIZES ARE `px`, NOT `rem`. app/globals.css sets `--font-body: 13px` on
 *    `html`, so **1rem is 13px here, not 16px**. Converting these to rem on
 *    the usual accessibility reasoning silently shrinks every size by about
 *    19% (it shipped once: 15px body copy rendered at 12px). The
 *    accessibility argument does not apply either, because a hardcoded root
 *    font-size has already overridden the reader's browser setting. Fixing
 *    that is a globals.css change, not a token change.
 *
 * 2. TRACKING SCALES INVERSELY WITH SIZE. This is the part that separates a
 *    page that looks clean from one that looks expensive. A single flat
 *    `tracking-tight` across a 20px card heading and an 80px hero leaves the
 *    display loose and the small text cramped. Reference points measured off
 *    the field: Linear runs about -3.75% at 80px, -3.2% at 56px, -2.5% at
 *    40px and -2.1% at 28px.
 *
 * 3. RESTATE `leading-*` AT EVERY BREAKPOINT THAT SETS A SIZE. Tailwind
 *    font-size utilities ship their own line-height and beat a bare
 *    `leading-*` set at a lower breakpoint. Forgetting this is how a headline
 *    ended up with a 42px font on a 32px line, its two lines overlapping.
 */

/** Hero headline. Pair with the page's own responsive size steps. */
export const DISPLAY =
  'font-semibold leading-[1.03] tracking-[-0.042em] sm:leading-[1.02] md:leading-[1.01] xl:leading-[1.0]'

/** Section headline. */
export const TITLE = 'font-semibold leading-[1.1] tracking-[-0.032em] md:leading-[1.06]'

/** Card and row headings. */
export const HEADING = 'font-semibold leading-[1.35] tracking-[-0.018em]'

/** The paragraph directly under a headline. */
export const LEDE = 'leading-[1.65] tracking-[-0.012em] md:leading-[1.55]'

/** Body copy. Carries its own size; the others do not. */
export const BODY = 'text-[15px] leading-[1.75] tracking-[-0.004em]'

/* ── Hairlines: three jobs, three tokens ─────────────────────────────────── */

/** Divides items inside one group. */
export const RULE = 'border-white/[0.07]'
/** Opens a section, or closes it. */
export const RULE_LEAD = 'border-white/[0.14]'
/** The outline of an actual object: a card, an input, a code block. */
export const EDGE = 'border-white/[0.10]'

/* ── Rhythm ──────────────────────────────────────────────────────────────── */

/**
 * Vertical rhythm for a section.
 *
 * Deliberately half of what it looks like it should be, because adjacent
 * sections each contribute their own padding: at `py-20 md:py-28` every
 * boundary stacked into roughly 224px of empty black with a headline floating
 * in the middle of it.
 */
export const SECTION_Y = 'py-14 md:py-20'

/** Measure. Prose gets one comfortable column; captions get a narrow one. */
export const MEASURE = 'max-w-[60ch]'
export const MEASURE_TIGHT = 'max-w-[44ch]'

/* ── Page container ──────────────────────────────────────────────────────── */

/**
 * THE site container. The navbar, the footer and the landing page all run at
 * this width, so anything that wants to line up with the site's own left and
 * right edges uses it too.
 *
 * ⚠ It is 1300px, not 1600px. `100rem` looks like 1600 and is not: globals.css
 * sets the root font-size to 13px (see the note at the top of this file), so
 * every rem-based width on this site resolves to 81% of its nominal value.
 *
 * That arithmetic caused a real bug, fixed 2026-09-19. `kit.tsx` stepped its
 * `wide` container up to `max-w-container` (a literal 1440px) at 2xl, on the
 * reasoning that 1280px looked mis-set "under a 1600px navbar". The navbar is
 * 1300px, so at >=1536 the subpage content was 140px WIDER than the navbar and
 * visibly overhung it by 70px on each side. On a 15" or 16" MacBook the
 * pricing table stuck out past the site's own chrome.
 *
 * Both strings are written out in full because Tailwind only generates classes
 * it can find literally in a scanned file; do not build them by concatenation.
 */
export const SITE_CONTAINER = 'max-w-[100rem]'
export const SITE_CONTAINER_2XL = '2xl:max-w-[100rem]'
