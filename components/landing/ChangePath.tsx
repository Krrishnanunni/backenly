'use client'

/**
 * ChangePath: one project over one day and one night, drawn as a timeline
 * that assembles itself the first time it is seen.
 *
 * History: this replaced ChangePlayer (a tab list beside mocked dashboard
 * cards), which read as generated. The founder then asked for a drawing that
 * builds itself, in the visual manner of InsForge's branch timeline: the
 * ANIMATION style, not its scenario. A first cut copied the scenario too
 * (three different agents on one project) and was rejected, rightly: nobody
 * runs Claude Code, Cursor and Codex against one backend. Do not bring
 * brand-name agents back into this drawing.
 *
 * 2026-09-30, made readable. Visitors liked the drawing and could not say
 * what it showed, so it now explains itself: a key for the four colours above
 * it, "you're online" and "nobody online" over day and night, plain labels
 * ("Applied", "Tested 5/5", "NEEDS YOU", "FIX") in the order the product
 * actually works (a change is applied, then tested against the running
 * backend), and three time-keyed explanations under it in place of the five
 * abstract stage names. The landing's separate autonomy section (a looping
 * five-phase instrument, then three facts) was folded in and removed: its
 * receipt now sits in the drawing's empty lower right, where the night story
 * ends, and its facts (every minute, no model calls, snapshot first) are in
 * the third explanation.
 *
 * THE SCENE is the three things a Backenly user needs to understand, in the
 * order they would meet them:
 *
 *   1. 14:02, your agent adds comments. Planned into typed actions, applied,
 *      tested against the running backend, merged. Governed building.
 *   2. 17:40, your agent asks to drop a column with live rows. Destructive,
 *      so it waits in the Review Queue until you approve; then it applies.
 *      The human gate.
 *   3. 03:12, nobody online. The line passes into night, and the autonomy
 *      loop, with no agent and no person, finds slow queries, snapshots, adds
 *      the missing index, tests it, merges the fix, and writes a receipt.
 *      Self-healing, the thing only Backenly does.
 *
 * Everything named is a real product noun (typed actions, the Review Queue,
 * verification, restore points, the autonomy loop adding indexes; see the
 * Overview recorded in HeroFilm). Times and names are illustrative, and the
 * caption says so.
 *
 * HOW IT DRAWS. One SVG in a fixed 1260x500 coordinate space, scaled to the
 * container, shown from xl up (below that the text would scale under 10px, so
 * smaller screens get the same story as cards). Lines draw
 * with framer's pathLength; dashed lines draw through a mask, because
 * pathLength works by rewriting stroke-dasharray and would erase the dashes.
 * The sequence starts the first time the figure is 35% on screen. Reduced
 * motion gets the finished drawing with nothing moving.
 */

import { useId, useRef } from 'react'
import { motion, useInView, type Variants } from 'framer-motion'
import { useSettledReducedMotion } from '@/lib/hooks/useSettledReducedMotion'

const W = 1260
const H = 500
const TRACK_Y = 240

const GREEN = '#4ade80'
const AMBER = '#fbbf24'
const VIOLET = '#a78bfa'


/* ── Motion factories ────────────────────────────────────────────────────── */

type T = (delay: number, duration?: number) => Variants

function makeMotion(quiet: boolean) {
  const d = (delay: number) => (quiet ? 0 : delay)
  const dur = (duration: number) => (quiet ? 0 : duration)

  const draw: T = (delay, duration = 0.5) => ({
    hidden: { pathLength: 0, opacity: 0 },
    visible: {
      pathLength: 1,
      opacity: 1,
      transition: {
        pathLength: { delay: d(delay), duration: dur(duration), ease: [0.65, 0, 0.35, 1] },
        opacity: { delay: d(delay), duration: 0.01 },
      },
    },
  })

  const pop: T = (delay, duration = 0.45) => ({
    hidden: { opacity: 0, scale: 0.4 },
    visible: {
      opacity: 1,
      scale: 1,
      transition: { delay: d(delay), duration: dur(duration), ease: [0.34, 1.56, 0.64, 1] },
    },
  })

  const rise: T = (delay, duration = 0.5) => ({
    hidden: { opacity: 0, y: 8 },
    visible: {
      opacity: 1,
      y: 0,
      transition: { delay: d(delay), duration: dur(duration), ease: [0.16, 1, 0.3, 1] },
    },
  })

  const fade: T = (delay, duration = 0.4) => ({
    hidden: { opacity: 0 },
    visible: { opacity: 1, transition: { delay: d(delay), duration: dur(duration) } },
  })

  return { draw, pop, rise, fade }
}

type Kit = ReturnType<typeof makeMotion>

/** Scale and pop around the element's own centre, not the SVG origin. */
const CENTRED = { transformBox: 'fill-box', transformOrigin: 'center' } as const

/* ── Primitives ──────────────────────────────────────────────────────────── */

function Line({ d, stroke, delay, duration, kit }: {
  d: string; stroke: string; delay: number; duration?: number; kit: Kit
}) {
  return (
    <motion.path d={d} stroke={stroke} strokeWidth={1.5} fill="none" strokeLinecap="round" variants={kit.draw(delay, duration)} />
  )
}

/** A dashed line that still draws: the dashes are revealed through a mask. */
function Dashed({ d, delay, duration, kit, stroke = 'rgba(255,255,255,0.32)', className }: {
  d: string; delay: number; duration?: number; kit: Kit; stroke?: string; className?: string
}) {
  const id = `m${useId().replace(/[^a-zA-Z0-9]/g, '')}`
  return (
    <>
      <mask id={id} maskUnits="userSpaceOnUse" x={0} y={0} width={W} height={H}>
        <motion.path d={d} stroke="#fff" strokeWidth={6} fill="none" variants={kit.draw(delay, duration)} />
      </mask>
      <path d={d} stroke={stroke} strokeWidth={1.25} strokeDasharray="3 5" fill="none" mask={`url(#${id})`} className={className} />
    </>
  )
}

/** An event on the production line: a ring with a lit core. */
function EventNode({ x, color, delay, kit }: { x: number; color: string; delay: number; kit: Kit }) {
  return (
    <motion.g variants={kit.pop(delay)} style={CENTRED}>
      <circle cx={x} cy={TRACK_Y} r={8} fill="#08090a" stroke={color} strokeOpacity={0.55} strokeWidth={1.25} />
      <circle cx={x} cy={TRACK_Y} r={3.5} fill={color} />
    </motion.g>
  )
}

function Time({ x, above, children, delay, kit }: {
  x: number; above?: boolean; children: string; delay: number; kit: Kit
}) {
  return (
    <motion.text
      x={x}
      y={above ? TRACK_Y - 20 : TRACK_Y + 30}
      textAnchor="middle"
      className="fill-zinc-500 font-mono"
      fontSize={12}
      variants={kit.fade(delay)}
    >
      {children}
    </motion.text>
  )
}

type Actor = 'agent' | 'autonomy'

/**
 * Line glyphs on a 24 grid: a prompt for your agent, a loop for autonomy. The
 * loop is named "Backenly" on the page: "Autonomy" is the product's word for
 * it, and a visitor does not know that word yet.
 */
const ACTOR: Record<Actor, { name: string; d: string; color: string }> = {
  agent: { name: 'Your agent', d: 'M4.5 7 L9.5 12 L4.5 17 M12 17.5 H19.5', color: '#e4e4e7' },
  autonomy: { name: 'Backenly', d: 'M19.5 12 A7.5 7.5 0 1 1 17.3 6.7 M19.8 3.8 V7.6 H16', color: VIOLET },
}

/**
 * Who started the change, and why. Mono throughout, so the pill's width can
 * be computed from its characters (Geist Mono runs 0.6em per character).
 */
function ActorPill({ cx, cy, actor, action, delay, kit }: {
  cx: number; cy: number; actor: Actor; action: string; delay: number; kit: Kit
}) {
  const a = ACTOR[actor]
  const cw = 7.2 // 12px mono
  const nameW = a.name.length * cw
  const w = 16 + 16 + 8 + nameW + 10 + action.length * cw + 16
  const x = cx - w / 2
  return (
    <motion.g variants={kit.rise(delay)}>
      <rect
        x={x}
        y={cy - 18}
        width={w}
        height={36}
        rx={18}
        fill="#0c0d10"
        stroke={actor === 'autonomy' ? 'rgba(167,139,250,0.4)' : 'rgba(255,255,255,0.14)'}
      />
      <svg x={x + 16} y={cy - 8} width={16} height={16} viewBox="0 0 24 24">
        <path d={a.d} stroke={a.color} strokeWidth={2} fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <text x={x + 40} y={cy + 4} fontSize={12} className="font-mono" fill={actor === 'autonomy' ? VIOLET : '#71717a'}>
        {a.name}
      </text>
      <text x={x + 40 + nameW + 10} y={cy + 4} fontSize={12} className="fill-zinc-100 font-mono">
        {action}
      </text>
    </motion.g>
  )
}

/** Width of a stage card, from its badge and label (both mono). */
function stageWidth(badge: string, label: string) {
  return 8 + (badge.length * 6.6 + 16) + 10 + label.length * 7.8 + 14
}

/** A stage of the change: light card, dark badge. */
function StageCard({ x, cy, badge, label, badgeFill = '#09090b', badgeText = '#fafafa', delay, kit }: {
  x: number; cy: number; badge: string; label: string; badgeFill?: string; badgeText?: string; delay: number; kit: Kit
}) {
  const bw = badge.length * 6.6 + 16
  const w = stageWidth(badge, label)
  return (
    <motion.g variants={kit.rise(delay)}>
      <rect x={x} y={cy - 20} width={w} height={40} rx={8} fill="#f4f4f5" />
      <rect x={x + 8} y={cy - 12} width={bw} height={24} rx={4} fill={badgeFill} />
      <text x={x + 8 + bw / 2} y={cy + 4} textAnchor="middle" fontSize={11} letterSpacing="0.06em" fill={badgeText} className="font-mono">
        {badge}
      </text>
      <text x={x + 8 + bw + 10} y={cy + 5} fontSize={13} fill="#09090b" className="font-mono">
        {label}
      </text>
    </motion.g>
  )
}

type Glyph = 'check' | 'up' | 'person'

const GLYPHS: Record<Glyph, string> = {
  check: 'M-5 0.5 L-1.5 4 L5.5 -3.5',
  up: 'M0 5.5 V-5.5 M-4.5 -1 L0 -5.5 L4.5 -1',
  person: 'M0 -1 A3 3 0 1 0 0 -7 A3 3 0 1 0 0 -1 M-5.5 6 A5.5 5 0 0 1 5.5 6',
}

function Outcome({ cx, cy, glyph, color, label, below, delay, kit }: {
  cx: number; cy: number; glyph: Glyph; color: string; label: string; below?: boolean; delay: number; kit: Kit
}) {
  return (
    <>
      <motion.g variants={kit.pop(delay)} style={CENTRED}>
        <circle cx={cx} cy={cy} r={18} fill="#08090a" stroke={color} strokeWidth={1.5} />
        <path d={GLYPHS[glyph]} transform={`translate(${cx} ${cy})`} stroke={color} strokeWidth={1.75} fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </motion.g>
      <motion.text
        x={cx}
        y={below ? cy + 40 : cy - 30}
        textAnchor="middle"
        fontSize={13}
        className="fill-zinc-400"
        variants={kit.fade(delay + 0.1)}
      >
        {label}
      </motion.text>
    </>
  )
}

/* ── The receipt ─────────────────────────────────────────────────────────── */

/**
 * What the night fix leaves behind, drawn where the night story ends. The
 * same four steps the autonomy loop records in the project's journal:
 * detected, snapshot, fixed, tested. Mono columns, widths from the characters
 * (12px Geist Mono is 7.2px a character).
 */
const RECEIPT: { time: string; step: string; detail: string }[] = [
  { time: '03:12', step: 'detected', detail: 'slow queries on orders' },
  { time: '03:12', step: 'snapshot', detail: 'restore point saved first' },
  { time: '03:13', step: 'fixed', detail: 'index on orders.customer_id' },
  { time: '03:14', step: 'tested', detail: 'queries fast again' },
]

function Receipt({ x, y, delay, kit }: { x: number; y: number; delay: number; kit: Kit }) {
  const w = 380
  const h = 176
  return (
    <motion.g variants={kit.rise(delay)}>
      <rect x={x} y={y} width={w} height={h} rx={10} fill="#0c0d10" stroke="rgba(167,139,250,0.35)" />
      <path
        d={GLYPHS.check}
        transform={`translate(${x + 24} ${y + 22}) scale(0.85)`}
        stroke={GREEN}
        strokeWidth={2}
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <text x={x + 40} y={y + 27} fontSize={13.5} fontWeight={500} className="fill-zinc-100">
        Fixed while you slept
      </text>
      <text x={x + w - 18} y={y + 26} textAnchor="end" fontSize={11} letterSpacing="0.04em" fill={VIOLET} className="font-mono">
        reversible
      </text>
      <line x1={x} x2={x + w} y1={y + 42.5} y2={y + 42.5} stroke="rgba(255,255,255,0.07)" />
      {RECEIPT.map((row, i) => (
        <motion.g key={row.step} variants={kit.fade(delay + 0.2 + i * 0.15)}>
          <text x={x + 18} y={y + 66 + i * 22} fontSize={12} className="fill-zinc-500 font-mono">
            {row.time}
          </text>
          <text x={x + 70} y={y + 66 + i * 22} fontSize={12} fill={VIOLET} className="font-mono">
            {row.step}
          </text>
          <text x={x + 150} y={y + 66 + i * 22} fontSize={12} className="fill-zinc-200 font-mono">
            {row.detail}
          </text>
        </motion.g>
      ))}
      <line x1={x} x2={x + w} y1={y + 146.5} y2={y + 146.5} stroke="rgba(255,255,255,0.07)" />
      <motion.text x={x + 18} y={y + 166} fontSize={12} className="fill-zinc-500" variants={kit.fade(delay + 0.9)}>
        No AI credits spent. Checked again at 03:15.
      </motion.text>
    </motion.g>
  )
}

/** A sun, for the half of the day when someone is at the keyboard. */
const SUN =
  'M12 8.5 A3.5 3.5 0 1 0 12 15.5 A3.5 3.5 0 1 0 12 8.5 Z M12 2.5 V4.5 M12 19.5 V21.5 M2.5 12 H4.5 M19.5 12 H21.5 M5.3 5.3 L6.7 6.7 M17.3 17.3 L18.7 18.7 M5.3 18.7 L6.7 17.3 M17.3 6.7 L18.7 5.3'

/* ── The scene ───────────────────────────────────────────────────────────── */

function Scene({ kit }: { kit: Kit }) {
  const ticks: number[] = []
  for (let x = 230; x < W - 20; x += 70) ticks.push(x)

  // Branch geometry. Day: A rises, B drops. Night: C rises, and its receipt
  // hangs below the line in the space the day stories leave empty.
  const A = { x: 230, card: 290, cy: 76 }
  const aEnd = A.card + stageWidth('PLAN', '4 safe steps')
  const B = { x: 300, card: 340, cy: 404 }
  const bEnd = B.card + stageWidth('NEEDS YOU', '1,284 rows at risk')
  const C = { x: 870, card: 920, cy: 76 }
  const cEnd = C.card + stageWidth('FIX', 'add missing index')
  const NIGHT = 830
  const RECEIPT_Y = 300
  const nodes = [A.x, B.x, 720, 790, C.x, 1220]

  return (
    <>
      <defs>
        <linearGradient id="cp-track" gradientUnits="userSpaceOnUse" x1={168} x2={W} y1={0} y2={0}>
          <stop offset="0" stopColor="#fff" stopOpacity="0.22" />
          <stop offset="0.93" stopColor="#fff" stopOpacity="0.22" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        {/* Night: a violet dusk that deepens to the right and fades off the
            top and bottom of the figure. */}
        <linearGradient id="cp-night-x" gradientUnits="userSpaceOnUse" x1={NIGHT} x2={W} y1={0} y2={0}>
          <stop offset="0" stopColor="#4c1d95" stopOpacity="0" />
          <stop offset="0.45" stopColor="#4c1d95" stopOpacity="0.2" />
          <stop offset="1" stopColor="#4c1d95" stopOpacity="0.3" />
        </linearGradient>
        <linearGradient id="cp-night-y" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity="0" />
          <stop offset="0.2" stopColor="#fff" stopOpacity="1" />
          <stop offset="0.8" stopColor="#fff" stopOpacity="1" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <mask id="cp-night-mask" maskUnits="userSpaceOnUse" x={NIGHT} y={-30} width={W - NIGHT} height={H + 30}>
          <rect x={NIGHT} y={-30} width={W - NIGHT} height={H + 30} fill="url(#cp-night-y)" />
        </mask>
      </defs>

      {/* Day: someone is at the keyboard. */}
      <motion.g variants={kit.fade(0.2, 0.6)}>
        <svg x={200} y={4} width={14} height={14} viewBox="0 0 24 24">
          <path d={SUN} stroke="#a1a1aa" strokeWidth={2} fill="none" strokeLinecap="round" />
        </svg>
        <text x={222} y={15} fontSize={12} className="fill-zinc-500 font-mono">
          you&apos;re online
        </text>
      </motion.g>

      {/* Night falls once the day's work has merged. */}
      <motion.g variants={kit.fade(2.5, 0.9)}>
        <rect x={NIGHT} y={-30} width={W - NIGHT} height={H + 30} fill="url(#cp-night-x)" mask="url(#cp-night-mask)" />
        <svg x={NIGHT + 36} y={4} width={14} height={14} viewBox="0 0 24 24">
          <path d="M20 14.5 A8.5 8.5 0 1 1 9.5 4 A7 7 0 0 0 20 14.5 Z" fill={VIOLET} fillOpacity={0.8} />
        </svg>
        <text x={NIGHT + 58} y={15} fontSize={12} className="font-mono" fill="#8b86a8">
          nobody online
        </text>
      </motion.g>

      {/* Production, and the line it runs along. */}
      <motion.g variants={kit.rise(0)}>
        <rect x={0} y={TRACK_Y - 20} width={168} height={40} rx={8} fill="#f4f4f5" />
        <rect x={8} y={TRACK_Y - 12} width={44} height={24} rx={4} fill="#16a34a" />
        <text x={30} y={TRACK_Y + 4} textAnchor="middle" fontSize={11} letterSpacing="0.06em" fill="#f0fdf4" className="font-mono">
          LIVE
        </text>
        <text x={62} y={TRACK_Y + 5} fontSize={14} fontWeight={500} fill="#09090b">
          Production
        </text>
      </motion.g>
      <motion.path d={`M168 ${TRACK_Y} H${W}`} stroke="url(#cp-track)" strokeWidth={1.25} fill="none" variants={kit.draw(0.15, 1.6)} />
      {ticks
        .filter((x) => nodes.every((n) => Math.abs(n - x) > 14))
        .map((x) => (
          <motion.circle
            key={x}
            cx={x}
            cy={TRACK_Y}
            r={2.5}
            fill="rgba(255,255,255,0.28)"
            variants={kit.pop(0.15 + ((x - 168) / (W - 168)) * 1.6, 0.3)}
            style={CENTRED}
          />
        ))}

      {/* 1 · Afternoon. Your agent adds comments: planned, applied, tested. */}
      <EventNode x={A.x} color="#e4e4e7" delay={0.35} kit={kit} />
      <Time x={A.x} delay={0.4} kit={kit}>14:02</Time>
      <Dashed d={`M${A.x} ${TRACK_Y - 8} V188`} delay={0.5} duration={0.3} kit={kit} />
      <ActorPill cx={A.x} cy={170} actor="agent" action="add comments" delay={0.7} kit={kit} />
      <Dashed d={`M${A.x} 152 V100 A24 24 0 0 1 ${A.x + 24} ${A.cy} H${A.card}`} delay={0.9} duration={0.45} kit={kit} />
      <StageCard x={A.card} cy={A.cy} badge="PLAN" label="4 safe steps" delay={1.25} kit={kit} />
      <Line d={`M${aEnd} ${A.cy} H522`} stroke={GREEN} delay={1.5} duration={0.25} kit={kit} />
      <Outcome cx={540} cy={A.cy} glyph="up" color={GREEN} label="Applied" delay={1.7} kit={kit} />
      <Line d={`M558 ${A.cy} H612`} stroke={GREEN} delay={1.85} duration={0.25} kit={kit} />
      <Outcome cx={630} cy={A.cy} glyph="check" color={GREEN} label="Tested 5/5" delay={2.05} kit={kit} />
      <Line d={`M648 ${A.cy} H690 A30 30 0 0 1 720 106 V${TRACK_Y - 8}`} stroke={GREEN} delay={2.2} duration={0.5} kit={kit} />
      <EventNode x={720} color={GREEN} delay={2.65} kit={kit} />

      {/* 2 · Evening. A destructive ask waits for you; you approve; it applies. */}
      <EventNode x={B.x} color="#e4e4e7" delay={0.65} kit={kit} />
      <Time x={B.x} above delay={0.7} kit={kit}>17:40</Time>
      <Dashed d={`M${B.x} ${TRACK_Y + 8} V292`} delay={1.0} duration={0.3} kit={kit} />
      <ActorPill cx={B.x} cy={310} actor="agent" action="drop legacy_slug" delay={1.2} kit={kit} />
      <Dashed d={`M${B.x} 328 V380 A24 24 0 0 0 ${B.x + 24} ${B.cy} H${B.card}`} delay={1.4} duration={0.45} kit={kit} />
      <StageCard x={B.card} cy={B.cy} badge="NEEDS YOU" label="1,284 rows at risk" badgeFill={AMBER} badgeText="#1c1407" delay={1.75} kit={kit} />
      <Line d={`M${bEnd} ${B.cy} H612`} stroke={AMBER} delay={2.0} duration={0.25} kit={kit} />
      <Outcome cx={630} cy={B.cy} glyph="person" color={AMBER} label="You approved" below delay={2.25} kit={kit} />
      <Line d={`M648 ${B.cy} H702`} stroke={GREEN} delay={2.4} duration={0.25} kit={kit} />
      <Outcome cx={720} cy={B.cy} glyph="up" color={GREEN} label="Applied" below delay={2.6} kit={kit} />
      <Line d={`M738 ${B.cy} H760 A30 30 0 0 0 790 374 V${TRACK_Y + 8}`} stroke={GREEN} delay={2.75} duration={0.5} kit={kit} />
      <EventNode x={790} color={GREEN} delay={3.2} kit={kit} />

      {/* 3 · 03:12, nobody online. Backenly finds it, fixes it, tests it,
          and leaves a receipt, with no agent and no person involved. */}
      <EventNode x={C.x} color={VIOLET} delay={3.1} kit={kit} />
      <Time x={C.x} delay={3.15} kit={kit}>03:12</Time>
      <Dashed d={`M${C.x} ${TRACK_Y - 8} V188`} delay={3.25} duration={0.3} kit={kit} stroke="rgba(167,139,250,0.55)" />
      <ActorPill cx={C.x} cy={170} actor="autonomy" action="finds slow queries" delay={3.45} kit={kit} />
      <Dashed
        d={`M${C.x} 152 V100 A24 24 0 0 1 ${C.x + 24} ${C.cy} H${C.card}`}
        delay={3.65}
        duration={0.4}
        kit={kit}
        stroke="rgba(167,139,250,0.55)"
      />
      <StageCard x={C.card} cy={C.cy} badge="FIX" label="add missing index" badgeFill="#7c3aed" delay={4.0} kit={kit} />
      <Line d={`M${cEnd} ${C.cy} H1132`} stroke={GREEN} delay={4.25} duration={0.2} kit={kit} />
      <Outcome cx={1150} cy={C.cy} glyph="check" color={GREEN} label="Tested" delay={4.4} kit={kit} />
      <Line d={`M1168 ${C.cy} H1190 A30 30 0 0 1 1220 106 V${TRACK_Y - 8}`} stroke={GREEN} delay={4.55} duration={0.5} kit={kit} />
      <EventNode x={1220} color={GREEN} delay={5.0} kit={kit} />
      <motion.text x={1206} y={TRACK_Y + 30} textAnchor="end" fontSize={12} className="fill-zinc-500 font-mono" variants={kit.fade(5.05)}>
        03:14
      </motion.text>
      <Dashed d={`M1220 ${TRACK_Y + 8} V${RECEIPT_Y}`} delay={5.1} duration={0.25} kit={kit} stroke="rgba(167,139,250,0.55)" />
      <Receipt x={872} y={RECEIPT_Y} delay={5.3} kit={kit} />
    </>
  )
}

/* ── The key, the explanations, and the small-screen version ─────────────── */

const LEGEND: { label: string; color: string }[] = [
  { label: 'Your agent asks', color: '#e4e4e7' },
  { label: 'Waits for you', color: AMBER },
  { label: 'Backenly, on its own', color: VIOLET },
  { label: 'Applied and tested', color: GREEN },
]

/**
 * The three moments of the drawing, keyed by the times printed on its line so
 * a reader can match each paragraph to its branch. The third carries what the
 * landing's separate autonomy section used to say.
 */
const STORIES: { time: string; actor: Actor; action: string; title: string; body: string; result: string; color: string }[] = [
  {
    time: '14:02',
    actor: 'agent',
    action: 'add comments',
    title: 'Your agent ships a feature',
    body: 'Backenly turns the request into planned steps, applies them behind a restore point, then tests the live backend with real requests. Done means it works, not that it ran.',
    result: 'Applied, tested 5/5',
    color: GREEN,
  },
  {
    time: '17:40',
    actor: 'agent',
    action: 'drop legacy_slug',
    title: 'Anything risky waits for you',
    body: 'A change that would delete data stops and shows you exactly what it touches. Your agent can ask. Only you can approve, and every change can be undone.',
    result: 'Waited for you, then applied',
    color: AMBER,
  },
  {
    time: '03:12',
    actor: 'autonomy',
    action: 'finds slow queries',
    title: 'Backenly fixes it while you sleep',
    body: 'Every minute, on every plan, Backenly checks the live backend. It snapshots first, fixes only what is safe, tests the fix, and never spends your AI credits doing it.',
    result: 'Fixed and tested, receipt waiting',
    color: VIOLET,
  },
]

function ActorLine({ time, actor, action }: { time: string; actor: Actor; action: string }) {
  const a = ACTOR[actor]
  return (
    <div className="flex items-center gap-2 font-mono text-[12px]">
      <span className="text-zinc-500">{time}</span>
      <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 shrink-0" aria-hidden>
        <path d={a.d} stroke={a.color} strokeWidth={2} fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span className={actor === 'autonomy' ? 'text-violet-300' : 'text-zinc-500'}>{a.name}</span>
      <span className="truncate text-zinc-100">{action}</span>
    </div>
  )
}

export function ChangePath() {
  const quiet = useSettledReducedMotion()
  const ref = useRef<HTMLDivElement>(null)
  const inView = useInView(ref, { once: true, amount: 0.35 })
  const kit = makeMotion(quiet)

  return (
    <figure>
      <div ref={ref} className="hidden xl:block">
        {/* The key: what each colour on the drawing means. */}
        <ul aria-label="How to read the timeline" className="mb-10 flex flex-wrap items-center gap-x-7 gap-y-2 text-[13px] text-zinc-400">
          {LEGEND.map((item) => (
            <li key={item.label} className="flex items-center gap-2">
              <span
                aria-hidden
                className="flex h-3.5 w-3.5 items-center justify-center rounded-full border"
                style={{ borderColor: item.color }}
              >
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: item.color }} />
              </span>
              {item.label}
            </li>
          ))}
        </ul>
        <motion.svg
          viewBox={`0 0 ${W} ${H}`}
          className="block h-auto w-full select-none overflow-visible"
          role="img"
          aria-label="One day and night on production. At 14:02 your agent adds comments: Backenly plans 4 safe steps, applies them, and tests them 5 of 5. At 17:40 your agent asks to drop a column with 1,284 live rows: it waits until you approve, then applies. At 03:12, with nobody online, Backenly finds slow queries, saves a restore point, adds the missing index, tests it, and leaves you a receipt."
          initial="hidden"
          animate={inView || quiet ? 'visible' : 'hidden'}
        >
          <Scene kit={kit} />
        </motion.svg>
        <p className="mt-2 text-right text-[13px] text-zinc-600">
          One project, one day and one night, drawn from the real flow. Names and times are illustrative.
        </p>
      </div>

      {/* What just happened, keyed by the times on the drawing. */}
      <figcaption className="hidden gap-x-10 xl:mt-14 xl:grid xl:grid-cols-3">
        {STORIES.map((story) => (
          <div key={story.time} className="border-t border-white/[0.08] pt-5">
            <p className="font-mono text-[12px]" style={{ color: story.color }}>
              {story.time}
            </p>
            <h3 className="mt-2 text-[17px] font-semibold tracking-[-0.018em] text-white">{story.title}</h3>
            <p className="mt-2 max-w-[44ch] text-[14.5px] leading-[1.65] tracking-[-0.004em] text-zinc-400">
              {story.body}
            </p>
          </div>
        ))}
      </figcaption>

      {/* Below xl the drawing's type would scale under 10px, so the same day
          is told as three cards, and the night's receipt as a card of its own. */}
      <div className="xl:hidden">
        <ol className="grid gap-3 md:grid-cols-3">
          {STORIES.map((story) => (
            <li key={story.time} className="flex flex-col rounded-2xl border border-white/[0.08] bg-white/[0.02] p-5">
              <ActorLine time={story.time} actor={story.actor} action={story.action} />
              <h3 className="mt-4 text-[17px] font-semibold tracking-[-0.018em] text-white">{story.title}</h3>
              <p className="mt-2 text-[15px] leading-[1.65] text-zinc-400">{story.body}</p>
              <p className="mt-auto flex items-center gap-2 pt-5 text-[14px] text-zinc-300">
                <span
                  aria-hidden
                  className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border"
                  style={{ borderColor: story.color }}
                >
                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: story.color }} />
                </span>
                {story.result}
              </p>
            </li>
          ))}
        </ol>

        <div className="mt-3 overflow-hidden rounded-2xl border border-violet-300/25 bg-[#0c0d10]">
          <div className="flex items-center justify-between gap-4 border-b border-white/[0.07] px-5 py-3.5">
            <p className="flex items-center gap-2 text-[14px] font-medium text-zinc-100">
              <svg viewBox="-8 -8 16 16" className="h-3.5 w-3.5 shrink-0" aria-hidden>
                <path d={GLYPHS.check} stroke={GREEN} strokeWidth={2} fill="none" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Fixed while you slept
            </p>
            <span className="font-mono text-[11px] text-violet-300">reversible</span>
          </div>
          <dl className="grid gap-2 px-5 py-4 font-mono text-[12px]">
            {RECEIPT.map((row) => (
              <div key={row.step} className="grid grid-cols-[44px_68px_minmax(0,1fr)] gap-2">
                <dt className="sr-only">{row.step}</dt>
                <span aria-hidden className="text-zinc-500">{row.time}</span>
                <span aria-hidden className="text-violet-300">{row.step}</span>
                <dd className="truncate text-zinc-200">{row.detail}</dd>
              </div>
            ))}
          </dl>
          <p className="border-t border-white/[0.07] px-5 py-3 text-[13px] text-zinc-500">
            No AI credits spent. Checked again at 03:15.
          </p>
        </div>
      </div>
    </figure>
  )
}
