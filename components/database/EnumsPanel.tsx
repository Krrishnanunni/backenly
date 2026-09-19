'use client'

/**
 * ENUM TYPES AND DOMAINS
 *
 * The last REAL_GAP in Postgres admin. A project could have a status enum
 * created out of band and the dashboard could neither see it nor make one.
 *
 * ── Dependents are shown BEFORE they matter ─────────────────────────────────
 *
 * Every type lists the columns using it. That is what turns "drop this type"
 * from a button into a decision, and it is why dropping is refused while
 * anything uses it rather than offered with CASCADE — CASCADE would drop those
 * columns, which is data.
 *
 * ── Removing an enum value is not offered, and the page says why ────────────
 *
 * PostgreSQL has no `ALTER TYPE ... DROP VALUE` at any version. Emulating it
 * means creating a replacement type, converting every dependent column and
 * dropping the old one — a data-rewriting migration, not a settings change.
 * Saying so is better than an absent control an operator has to guess about,
 * and much better than a button that quietly rewrites their data.
 */

import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, Loader2, Plus, Shapes, Trash2 } from 'lucide-react'
import {
  KitButton, KitNote, KitModal, KitField, KitInput, KitBadge, KitConfirmDialog,
} from '@/components/inspector/kit'

interface EnumType { name: string; values: string[]; usedBy: string[] }
interface DomainType {
  name: string
  baseType: string
  notNull: boolean
  default: string | null
  constraints: string[]
  usedBy: string[]
}

export function EnumsPanel({ projectId }: { projectId: string }) {
  const [enums, setEnums] = useState<EnumType[]>([])
  const [domains, setDomains] = useState<DomainType[]>([])
  const [baseTypes, setBaseTypes] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [message, setMessage] = useState<{ tone: 'danger' | 'success' | 'warn'; text: string } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const [creatingEnum, setCreatingEnum] = useState(false)
  const [creatingDomain, setCreatingDomain] = useState(false)
  const [addingTo, setAddingTo] = useState<EnumType | null>(null)
  const [confirmDrop, setConfirmDrop] = useState<{ name: string; usedBy: string[] } | null>(null)

  const load = useCallback(async () => {
    setLoadError(null)
    try {
      const res = await fetch(`/api/projects/${projectId}/database/types`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Types could not be loaded.')
      setEnums(data.enums ?? [])
      setDomains(data.domains ?? [])
      setBaseTypes(data.baseTypes ?? [])
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Types could not be loaded.')
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => { load() }, [load])

  async function act(body: Record<string, unknown>, success: string): Promise<boolean> {
    setMessage(null)
    const res = await fetch(`/api/projects/${projectId}/database/types`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json()
    if (!res.ok) {
      // PostgreSQL's own message where it refused, rather than a paraphrase.
      setMessage({ tone: 'danger', text: data.error ?? 'That did not work.' })
      return false
    }
    setEnums(data.enums ?? [])
    setDomains(data.domains ?? [])
    setMessage({ tone: 'success', text: success })
    return true
  }

  async function drop(name: string) {
    setBusy(name)
    try {
      const res = await fetch(
        `/api/projects/${projectId}/database/types?name=${encodeURIComponent(name)}`,
        { method: 'DELETE' },
      )
      const data = await res.json()
      if (!res.ok) {
        setMessage({ tone: 'danger', text: data.error ?? 'The type could not be dropped.' })
        return
      }
      setEnums(data.enums ?? [])
      setDomains(data.domains ?? [])
      setMessage({ tone: 'success', text: `${name} dropped.` })
    } finally {
      setBusy(null)
      setConfirmDrop(null)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 px-4 py-6 text-[12px] text-zinc-500">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Reading types…
      </div>
    )
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
      <div className="max-w-[78ch]">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Shapes className="h-3.5 w-3.5 text-zinc-500" />
            <h2 className="text-[12px] font-medium text-zinc-200">Types</h2>
          </div>
          <div className="flex items-center gap-2">
            <KitButton variant="secondary" size="sm" icon={Plus} onClick={() => setCreatingEnum(true)}>
              New enum
            </KitButton>
            <KitButton variant="secondary" size="sm" icon={Plus} onClick={() => setCreatingDomain(true)}>
              New domain
            </KitButton>
          </div>
        </div>

        <p className="mt-2 text-[12.5px] leading-relaxed text-zinc-400">
          Enums and domains in this project&rsquo;s own schema. Each one lists the columns using
          it, because that is what decides whether it can be changed.
        </p>

        {loadError && <div className="mt-4"><KitNote icon={AlertTriangle} tone="danger">{loadError}</KitNote></div>}
        {message && (
          <div className="mt-4">
            <KitNote icon={message.tone === 'success' ? CheckCircle2 : AlertTriangle} tone={message.tone}>
              {message.text}
            </KitNote>
          </div>
        )}

        {/* ── Enums ─────────────────────────────────────────────── */}
        <h3 className="mt-6 text-[11px] font-medium uppercase tracking-wide text-zinc-500">Enums</h3>
        {enums.length === 0 ? (
          <p className="mt-2 text-[12.5px] text-zinc-500">
            No enum types in this project yet.
          </p>
        ) : (
          <div className="mt-2 space-y-2">
            {enums.map(t => (
              <div key={t.name} className="rounded-lg border border-white/[0.06] bg-white/[0.015] px-3.5 py-3">
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="font-mono text-[12px] text-zinc-200">{t.name}</p>
                    <p className="mt-1 flex flex-wrap gap-1.5">
                      {t.values.map(v => (
                        <span key={v} className="rounded bg-white/[0.05] px-1.5 py-0.5 font-mono text-[11px] text-zinc-300">
                          {v}
                        </span>
                      ))}
                    </p>
                    <UsedBy usedBy={t.usedBy} />
                  </div>
                  <div className="flex flex-shrink-0 items-center gap-1.5">
                    <KitButton variant="ghost" size="sm" icon={Plus} disabled={busy !== null} onClick={() => setAddingTo(t)}>
                      Add value
                    </KitButton>
                    <KitButton
                      variant="ghost"
                      size="sm"
                      icon={busy === t.name ? Loader2 : Trash2}
                      disabled={busy !== null}
                      onClick={() => setConfirmDrop({ name: t.name, usedBy: t.usedBy })}
                    >
                      Drop
                    </KitButton>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ── Domains ───────────────────────────────────────────── */}
        <h3 className="mt-6 text-[11px] font-medium uppercase tracking-wide text-zinc-500">Domains</h3>
        {domains.length === 0 ? (
          <p className="mt-2 text-[12.5px] text-zinc-500">No domains in this project yet.</p>
        ) : (
          <div className="mt-2 space-y-2">
            {domains.map(d => (
              <div key={d.name} className="rounded-lg border border-white/[0.06] bg-white/[0.015] px-3.5 py-3">
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="font-mono text-[12px] text-zinc-200">
                      {d.name}
                      <span className="ml-2 text-[11px] text-zinc-500">{d.baseType}</span>
                      {d.notNull && <KitBadge tone="attention" className="ml-2">not null</KitBadge>}
                    </p>
                    {d.constraints.length > 0 && (
                      <p className="mt-1 font-mono text-[11px] leading-snug text-zinc-500">
                        {d.constraints.join(' ')}
                      </p>
                    )}
                    <UsedBy usedBy={d.usedBy} />
                  </div>
                  <KitButton
                    variant="ghost"
                    size="sm"
                    icon={busy === d.name ? Loader2 : Trash2}
                    disabled={busy !== null}
                    onClick={() => setConfirmDrop({ name: d.name, usedBy: d.usedBy })}
                  >
                    Drop
                  </KitButton>
                </div>
              </div>
            ))}
          </div>
        )}

        <p className="mt-6 text-[11.5px] leading-relaxed text-zinc-500">
          There is no &ldquo;remove value&rdquo; for an enum. PostgreSQL has no{' '}
          <span className="font-mono">ALTER TYPE &hellip; DROP VALUE</span> at any version;
          removing one means creating a replacement type, converting every column that uses it
          and dropping the old one &mdash; a migration that rewrites data, not a settings change.
        </p>
      </div>

      {creatingEnum && (
        <EnumForm
          onClose={() => setCreatingEnum(false)}
          onSubmit={async (name, values) => {
            if (await act({ action: 'create_enum', name, values }, `${name} created.`)) {
              setCreatingEnum(false)
            }
          }}
        />
      )}

      {addingTo && (
        <AddValueForm
          enumName={addingTo.name}
          existing={addingTo.values}
          onClose={() => setAddingTo(null)}
          onSubmit={async value => {
            if (await act({ action: 'add_enum_value', name: addingTo.name, value }, `${value} added to ${addingTo.name}.`)) {
              setAddingTo(null)
            }
          }}
        />
      )}

      {creatingDomain && (
        <DomainForm
          baseTypes={baseTypes}
          onClose={() => setCreatingDomain(false)}
          onSubmit={async spec => {
            if (await act({ action: 'create_domain', ...spec }, `${spec.name} created.`)) {
              setCreatingDomain(false)
            }
          }}
        />
      )}

      {confirmDrop && (
        <KitConfirmDialog
          open
          danger
          busy={busy !== null}
          title={`Drop ${confirmDrop.name}?`}
          description={
            confirmDrop.usedBy.length > 0
              ? `${confirmDrop.name} is still used by ${confirmDrop.usedBy.join(', ')}. ` +
                `Dropping it will be refused: the columns would have to go with it, and that is ` +
                `data. Change those columns first.`
              : `Nothing uses ${confirmDrop.name}, so dropping it affects no data. This cannot be undone.`
          }
          confirmLabel={busy ? 'Dropping…' : 'Drop'}
          onConfirm={() => drop(confirmDrop.name)}
          onCancel={() => setConfirmDrop(null)}
        />
      )}
    </div>
  )
}

/** The dependents of a type, which is what makes a change safe or not. */
function UsedBy({ usedBy }: { usedBy: string[] }) {
  if (usedBy.length === 0) {
    return <p className="mt-1.5 text-[11px] text-zinc-600">Not used by any column.</p>
  }
  return (
    <p className="mt-1.5 text-[11px] text-zinc-500">
      Used by <span className="font-mono text-zinc-400">{usedBy.join(', ')}</span>
    </p>
  )
}

function EnumForm({
  onClose, onSubmit,
}: { onClose: () => void; onSubmit: (name: string, values: string[]) => Promise<void> }) {
  const [name, setName] = useState('')
  const [raw, setRaw] = useState('')
  const [busy, setBusy] = useState(false)

  const values = raw.split('\n').map(v => v.trim()).filter(Boolean)

  return (
    <KitModal
      open
      title="New enum"
      description="A fixed set of values a column may hold."
      onClose={onClose}
      footer={
        <>
          <KitButton variant="ghost" size="sm" onClick={onClose}>Cancel</KitButton>
          <KitButton
            variant="primary"
            size="sm"
            icon={busy ? Loader2 : undefined}
            disabled={busy || !name.trim() || values.length === 0}
            onClick={async () => { setBusy(true); try { await onSubmit(name.trim(), values) } finally { setBusy(false) } }}
          >
            Create
          </KitButton>
        </>
      }
    >
      <div className="space-y-4">
        <KitField label="Name" hint="Lower case, letters, digits and underscores.">
          <KitInput value={name} onChange={e => setName(e.target.value)} placeholder="order_status" autoFocus />
        </KitField>
        <KitField label="Values" hint="One per line. Order is the sort order PostgreSQL will use.">
          <textarea
            value={raw}
            onChange={e => setRaw(e.target.value)}
            rows={6}
            placeholder={'draft\npublished\narchived'}
            className="w-full rounded-md border border-white/10 bg-[#0f1015] px-3 py-2 font-mono text-[12px] text-zinc-50 placeholder:text-zinc-600 focus:border-violet-400/40 focus:outline-none focus:ring-2 focus:ring-violet-400/15"
          />
        </KitField>
      </div>
    </KitModal>
  )
}

function AddValueForm({
  enumName, existing, onClose, onSubmit,
}: { enumName: string; existing: string[]; onClose: () => void; onSubmit: (value: string) => Promise<void> }) {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)

  return (
    <KitModal
      open
      title={`Add a value to ${enumName}`}
      // The safe change, and worth saying so: appending does not touch rows.
      description="Appended to the end. Existing rows are untouched."
      onClose={onClose}
      footer={
        <>
          <KitButton variant="ghost" size="sm" onClick={onClose}>Cancel</KitButton>
          <KitButton
            variant="primary"
            size="sm"
            icon={busy ? Loader2 : undefined}
            disabled={busy || !value.trim()}
            onClick={async () => { setBusy(true); try { await onSubmit(value.trim()) } finally { setBusy(false) } }}
          >
            Add
          </KitButton>
        </>
      }
    >
      <KitField label="Value" hint={`Current: ${existing.join(', ')}`}>
        <KitInput value={value} onChange={e => setValue(e.target.value)} autoFocus />
      </KitField>
    </KitModal>
  )
}

function DomainForm({
  baseTypes, onClose, onSubmit,
}: {
  baseTypes: string[]
  onClose: () => void
  onSubmit: (spec: { name: string; baseType: string; notNull: boolean; check: string | null }) => Promise<void>
}) {
  const [name, setName] = useState('')
  const [baseType, setBaseType] = useState(baseTypes[0] ?? 'text')
  const [notNull, setNotNull] = useState(false)
  const [check, setCheck] = useState('')
  const [busy, setBusy] = useState(false)

  return (
    <KitModal
      open
      title="New domain"
      description="A base type with a constraint attached, reusable across columns."
      onClose={onClose}
      footer={
        <>
          <KitButton variant="ghost" size="sm" onClick={onClose}>Cancel</KitButton>
          <KitButton
            variant="primary"
            size="sm"
            icon={busy ? Loader2 : undefined}
            disabled={busy || !name.trim()}
            onClick={async () => {
              setBusy(true)
              try { await onSubmit({ name: name.trim(), baseType, notNull, check: check.trim() || null }) }
              finally { setBusy(false) }
            }}
          >
            Create
          </KitButton>
        </>
      }
    >
      <div className="space-y-4">
        <KitField label="Name">
          <KitInput value={name} onChange={e => setName(e.target.value)} placeholder="email_address" autoFocus />
        </KitField>
        <KitField label="Base type">
          <select
            value={baseType}
            onChange={e => setBaseType(e.target.value)}
            className="h-8 w-full rounded-md border border-white/10 bg-[#0f1015] px-2 text-[12.5px] text-zinc-50 focus:border-violet-400/40 focus:outline-none"
          >
            {baseTypes.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </KitField>
        <label className="flex cursor-pointer items-center gap-2 text-[12px] text-zinc-300">
          <input type="checkbox" checked={notNull} onChange={e => setNotNull(e.target.checked)} className="accent-violet-400" />
          NOT NULL
        </label>
        <KitField
          label="Check"
          hint={<>Must refer to <span className="font-mono text-zinc-300">VALUE</span>, which is the column being checked.</>}
        >
          <KitInput value={check} onChange={e => setCheck(e.target.value)} placeholder="VALUE ~ '^[^@]+@[^@]+$'" />
        </KitField>
      </div>
    </KitModal>
  )
}
