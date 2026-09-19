'use client'

/**
 * PROJECT DATABASE SNAPSHOTS
 *
 * One project's schema and rows, and deliberately not more. The panel says what
 * a snapshot excludes before it offers to take one, because the failure this
 * product family is most prone to is an operator seeing something called
 * "Backup", concluding their server is safe, and finding out otherwise on the
 * only day it matters.
 *
 * That is why this is never labelled "Backup" on its own, and why it names its
 * sibling: deployment recovery lives in Settings and covers the machine. A
 * snapshot covers a project.
 *
 * ── Restore states what it replaces, in the dialog ──────────────────────────
 *
 * Restoring replaces every table in the project, and the confirmation says so
 * along with the snapshot's own timestamp - a dialog that asked "are you sure?"
 * over an unnamed snapshot would be a worse guard than none, because it looks
 * like one.
 */

import { useCallback, useEffect, useState } from 'react'
import {
  Camera, Loader2, RotateCcw, CheckCircle2, XCircle,
} from 'lucide-react'
import { KitButton, KitNote, KitConfirmDialog } from '@/components/inspector/kit'

interface Snapshot {
  id: string
  filename: string
  sizeBytes: number
  status: string
  error: string | null
  createdAt: string
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

export function DatabaseSnapshots({ projectId }: { projectId: string }) {
  const [snapshots, setSnapshots] = useState<Snapshot[]>([])
  const [loading, setLoading] = useState(true)
  const [taking, setTaking] = useState(false)
  const [restoring, setRestoring] = useState<string | null>(null)
  const [message, setMessage] = useState<{ tone: 'danger' | 'success'; text: string } | null>(null)
  const [confirmRestore, setConfirmRestore] = useState<Snapshot | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/backup`)
      const data = await res.json()
      if (res.ok) setSnapshots(data.data ?? [])
    } catch {
      // A list that cannot load is not worth an error banner over the action
      // that still works. The empty state below reads honestly either way.
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => { load() }, [load])

  async function takeSnapshot() {
    setTaking(true)
    setMessage(null)
    try {
      const res = await fetch(`/api/projects/${projectId}/backup`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'The snapshot failed.')
      setMessage({ tone: 'success', text: 'Snapshot taken.' })
      await load()
    } catch (err) {
      setMessage({ tone: 'danger', text: err instanceof Error ? err.message : 'The snapshot failed.' })
    } finally {
      setTaking(false)
    }
  }

  async function restore(snapshot: Snapshot) {
    setRestoring(snapshot.id)
    setMessage(null)
    try {
      const res = await fetch(`/api/projects/${projectId}/backup`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ backupId: snapshot.id }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'The restore failed.')
      setMessage({ tone: 'success', text: 'Restored. Reload to see the current tables.' })
      await load()
    } catch (err) {
      setMessage({ tone: 'danger', text: err instanceof Error ? err.message : 'The restore failed.' })
    } finally {
      setRestoring(null)
      setConfirmRestore(null)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto">
      <div className="flex h-10 flex-shrink-0 items-center justify-between gap-3 border-b border-white/[0.06] px-4">
        <div className="flex items-center gap-2">
          <Camera className="h-3.5 w-3.5 text-zinc-500" />
          <span className="text-[12px] font-medium text-zinc-200">Database snapshots</span>
        </div>
        <KitButton
          variant="secondary"
          size="sm"
          icon={taking ? Loader2 : Camera}
          onClick={takeSnapshot}
          disabled={taking}
        >
          {taking ? 'Taking…' : 'Take snapshot'}
        </KitButton>
      </div>

      <div className="flex-1 px-4 py-4">
        <p className="max-w-[70ch] text-[12.5px] leading-relaxed text-zinc-400">
          A snapshot captures this project&rsquo;s tables, rows, indexes, constraints and
          RLS policies. It does <span className="text-zinc-200">not</span> capture stored
          files, platform accounts, API keys, project configuration or function source, so
          it is for rolling a schema back or moving a project &mdash; not for recovering a
          server. That is <span className="text-zinc-200">Settings &rarr; Recovery</span>.
        </p>

        {message && (
          <div className="mt-4 max-w-[70ch]">
            <KitNote tone={message.tone}>{message.text}</KitNote>
          </div>
        )}

        <div className="mt-5">
          {loading ? (
            <div className="flex items-center gap-2 text-[12px] text-zinc-500">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Loading snapshots…
            </div>
          ) : snapshots.length === 0 ? (
            <p className="text-[12.5px] text-zinc-500">
              No snapshots yet. Taking one reads the project&rsquo;s schema as it is now.
            </p>
          ) : (
            <div className="max-w-[70ch] overflow-hidden rounded-lg border border-white/[0.06]">
              <table className="w-full text-[12px]">
                <tbody>
                  {snapshots.map(snapshot => (
                    <tr key={snapshot.id} className="border-b border-white/[0.04] last:border-0">
                      <td className="px-3 py-2.5">
                        {snapshot.status === 'completed' ? (
                          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500/70" />
                        ) : (
                          <XCircle className="h-3.5 w-3.5 text-rose-500/70" />
                        )}
                      </td>
                      <td className="px-1 py-2.5 text-zinc-300">
                        {new Date(snapshot.createdAt).toLocaleString()}
                        {snapshot.error && (
                          <span className="ml-2 text-[11px] text-rose-400/80">{snapshot.error}</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono text-zinc-500">
                        {formatBytes(snapshot.sizeBytes)}
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        {snapshot.status === 'completed' && (
                          <KitButton
                            variant="secondary"
                            size="sm"
                            icon={restoring === snapshot.id ? Loader2 : RotateCcw}
                            onClick={() => setConfirmRestore(snapshot)}
                            disabled={restoring !== null}
                          >
                            Restore
                          </KitButton>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {confirmRestore && (
        <KitConfirmDialog
          open
          danger
          busy={restoring !== null}
          title="Restore this snapshot?"
          // Named plainly. Everything in the project's schema is replaced by
          // what the snapshot held, and rows written since are not merged in.
          description={
            `Every table in this project is replaced by the snapshot taken on ` +
            `${new Date(confirmRestore.createdAt).toLocaleString()}. Rows written since ` +
            `then are not kept. The live schema is renamed aside first, so a restore ` +
            `that fails leaves the current data in place.`
          }
          confirmLabel={restoring ? 'Restoring…' : 'Restore'}
          onConfirm={() => restore(confirmRestore)}
          onCancel={() => setConfirmRestore(null)}
        />
      )}
    </div>
  )
}
