'use client'

/**
 * Schema history — the migration ledger, which was already being written.
 *
 * Every governed DDL action snapshots the schema into `SchemaVersion`, and the
 * list/get/rollback route has existed for as long as the ledger has. Nothing in
 * the dashboard read it, so an operator could see the current shape of their
 * database and no part of how it got there.
 *
 * ── Rollback is destructive and is presented as such ────────────────────────
 *
 * `rollbackToVersion` computes a diff against the live schema and executes DDL
 * to reach the target. Reaching an older shape means DROPPING what came after
 * it, and dropping a column drops its data. There is no undo for that beyond
 * the pre-rollback snapshot the server takes automatically.
 *
 * So the confirmation asks for the version number to be typed rather than
 * offering a button. A modal with a single "Confirm" is dismissed by reflex; a
 * field that has to be filled in cannot be.
 */

import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, History, Loader2, RotateCcw } from 'lucide-react'
import { EmptyState, KitButton } from '@/components/inspector/kit'

interface VersionRow {
  id: string
  versionNum: number
  description: string
  triggeredBy: string
  createdAt: string
}

interface TableSnapshot {
  name: string
  columns?: Array<{ name: string; type: string }>
}

export function SchemaHistory({ projectId }: { projectId: string }) {
  const [versions, setVersions] = useState<VersionRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [selected, setSelected] = useState<VersionRow | null>(null)
  const [snapshot, setSnapshot] = useState<TableSnapshot[] | null>(null)
  const [snapshotLoading, setSnapshotLoading] = useState(false)

  const [confirmFor, setConfirmFor] = useState<VersionRow | null>(null)
  const [typed, setTyped] = useState('')
  const [rollingBack, setRollingBack] = useState(false)
  const [outcome, setOutcome] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/projects/${projectId}/schema-versions`, { credentials: 'include' })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || `Request failed with ${res.status}`)
      setVersions(body.versions ?? [])
    } catch (err: any) {
      // Cleared, so a stale list cannot be read as the current history.
      setVersions([])
      setError(err?.message || 'Could not load schema history')
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => { void load() }, [load])

  const openSnapshot = async (v: VersionRow) => {
    setSelected(v)
    setSnapshot(null)
    setSnapshotLoading(true)
    try {
      const res = await fetch(
        `/api/projects/${projectId}/schema-versions?versionId=${encodeURIComponent(v.id)}`,
        { credentials: 'include' },
      )
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || 'Could not load that version')
      setSnapshot(body.version?.snapshot?.tables ?? [])
    } catch (err: any) {
      setSnapshot(null)
      setError(err?.message || 'Could not load that version')
    } finally {
      setSnapshotLoading(false)
    }
  }

  const rollback = async () => {
    if (!confirmFor || rollingBack) return
    setRollingBack(true)
    setOutcome(null)
    try {
      const res = await fetch(`/api/projects/${projectId}/schema-versions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ versionId: confirmFor.id }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok || body.success === false) {
        throw new Error(body.error || body.message || 'Rollback failed')
      }
      // The count is reported because "rolled back" with zero statements means
      // the schema already matched, which is a different outcome worth knowing.
      const n = Array.isArray(body.statementsExecuted) ? body.statementsExecuted.length : 0
      setOutcome(
        n === 0
          ? `Schema already matched v${confirmFor.versionNum}. Nothing was changed.`
          : `Rolled back to v${confirmFor.versionNum}. ${n} ${n === 1 ? 'statement' : 'statements'} executed.`
      )
      setConfirmFor(null)
      setTyped('')
      await load()
    } catch (err: any) {
      setOutcome(err?.message || 'Rollback failed')
    } finally {
      setRollingBack(false)
    }
  }

  return (
    <div className="flex h-full w-full min-h-0">
      <div className="flex w-80 flex-shrink-0 flex-col border-r border-white/[0.06]">
        <div className="flex h-10 flex-shrink-0 items-center justify-between border-b border-white/[0.06] px-3">
          <span className="text-[12.5px] font-semibold text-zinc-100">Schema history</span>
          <span className="font-mono text-[10.5px] tabular-nums text-zinc-600">{versions.length}</span>
        </div>

        <div className="min-h-0 flex-1 overflow-auto">
          {error ? (
            <div className="p-3">
              <div className="rounded-lg border border-rose-500/20 bg-rose-500/[0.05] px-3 py-2">
                <p className="text-[11.5px] text-rose-200">{error}</p>
                <KitButton variant="secondary" onClick={() => void load()} className="mt-2">Try again</KitButton>
              </div>
            </div>
          ) : loading ? (
            <div className="flex h-full items-center justify-center text-[12px] text-zinc-500">
              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> Loading
            </div>
          ) : versions.length === 0 ? (
            <div className="flex h-full items-center justify-center px-6">
              <EmptyState
                icon={History}
                title="No schema versions yet"
                description="A version is recorded every time the schema changes, so this fills in as you build."
              />
            </div>
          ) : (
            versions.map(v => (
              <button
                key={v.id}
                onClick={() => void openSnapshot(v)}
                className={`block w-full border-b border-white/[0.04] px-3 py-2.5 text-left transition-colors focus:outline-none ${
                  selected?.id === v.id ? 'bg-white/[0.05]' : 'hover:bg-white/[0.02]'
                }`}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-mono text-[11.5px] font-medium text-zinc-100">v{v.versionNum}</span>
                  <span className="font-mono text-[10.5px] tabular-nums text-zinc-600">
                    {new Date(v.createdAt).toLocaleString()}
                  </span>
                </div>
                <p className="mt-0.5 truncate text-[11.5px] text-zinc-400">{v.description}</p>
                <p className="mt-0.5 truncate font-mono text-[10.5px] text-zinc-600">{v.triggeredBy}</p>
              </button>
            ))
          )}
        </div>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        {outcome && (
          <div className="flex-shrink-0 border-b border-white/[0.06] px-4 py-2.5">
            <p className="text-[11.5px] text-zinc-300">{outcome}</p>
          </div>
        )}

        {!selected ? (
          <div className="flex h-full items-center justify-center px-8 text-center">
            <p className="text-[12.5px] text-zinc-500">Select a version to see the schema it captured.</p>
          </div>
        ) : (
          <>
            <div className="flex h-10 flex-shrink-0 items-center justify-between gap-3 border-b border-white/[0.06] px-4">
              <div className="flex min-w-0 items-baseline gap-2">
                <h2 className="font-mono text-[13px] font-medium text-zinc-100">v{selected.versionNum}</h2>
                <span className="truncate text-[11.5px] text-zinc-500">{selected.description}</span>
              </div>
              <KitButton
                variant="secondary"
                icon={RotateCcw}
                onClick={() => { setConfirmFor(selected); setTyped(''); setOutcome(null) }}
              >
                Roll back to this
              </KitButton>
            </div>

            <div className="min-h-0 flex-1 overflow-auto p-4">
              {snapshotLoading ? (
                <div className="flex items-center gap-2 text-[12px] text-zinc-500">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading snapshot
                </div>
              ) : !snapshot || snapshot.length === 0 ? (
                <p className="text-[12px] text-zinc-500">This version captured no tables.</p>
              ) : (
                <div className="space-y-4">
                  {snapshot.map(t => (
                    <div key={t.name} className="overflow-hidden rounded-lg border border-white/[0.07]">
                      <div className="border-b border-white/[0.06] bg-white/[0.02] px-3 py-1.5">
                        <span className="font-mono text-[11.5px] font-medium text-zinc-200">{t.name}</span>
                      </div>
                      <table className="w-full">
                        <tbody>
                          {(t.columns ?? []).map(c => (
                            <tr key={c.name}>
                              <td className="border-b border-white/[0.04] px-3 py-1.5 font-mono text-[11px] text-zinc-300">{c.name}</td>
                              <td className="border-b border-white/[0.04] px-3 py-1.5 text-right font-mono text-[11px] text-zinc-500">{c.type}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* Typed confirmation, not a button. Reaching an older shape means
          dropping what came after it, and dropping a column drops its data. */}
      {confirmFor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="w-full max-w-md rounded-xl border border-rose-500/25 bg-[#16171d] shadow-[0_12px_32px_-16px_rgba(0,0,0,0.85)]">
            <div className="border-b border-white/[0.06] px-5 py-4">
              <div className="flex items-start gap-3">
                <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-rose-300" />
                <div>
                  <h2 className="text-[13px] font-semibold text-zinc-50">
                    Roll back to v{confirmFor.versionNum}?
                  </h2>
                  <p className="mt-1.5 text-[11.5px] text-zinc-400">
                    Tables and columns added after this version will be dropped, and dropping a
                    column drops its data. A snapshot of the current schema is taken first.
                  </p>
                </div>
              </div>
            </div>
            <div className="px-5 py-4">
              <label className="block text-[11px] text-zinc-400 mb-1.5">
                Type <span className="font-mono text-zinc-200">{confirmFor.versionNum}</span> to confirm
              </label>
              <input
                autoFocus
                value={typed}
                onChange={e => setTyped(e.target.value)}
                aria-label="Type the version number to confirm"
                className="h-8 w-full rounded-lg border border-white/[0.07] bg-[#0f1015] px-3 font-mono text-[12.5px] text-zinc-50 focus:border-rose-400/40 focus:outline-none"
              />
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-white/[0.06] px-5 py-4">
              <button
                onClick={() => { setConfirmFor(null); setTyped('') }}
                disabled={rollingBack}
                className="h-8 rounded-lg px-3 text-[12px] font-medium text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-100 disabled:opacity-50 focus:outline-none"
              >
                Cancel
              </button>
              <button
                onClick={() => void rollback()}
                disabled={rollingBack || typed.trim() !== String(confirmFor.versionNum)}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-rose-500 px-3.5 text-[12px] font-semibold text-white transition-colors hover:bg-rose-400 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {rollingBack ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
                Roll back
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
