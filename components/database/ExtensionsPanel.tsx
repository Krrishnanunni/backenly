'use client'

/**
 * POSTGRESQL EXTENSIONS
 *
 * The platform already detected two of these — `pg_stat_statements` and
 * `pgstattuple` — and told the operator to go and run `CREATE EXTENSION` by
 * hand. This is the surface that was missing.
 *
 * ── It shows what the SERVER says, not what the code hopes ──────────────────
 *
 * Installed, available, version and trusted all come from `pg_extension` and
 * `pg_available_extensions` on every load. Nothing here is cached, because a
 * dashboard reporting an extension that an operator removed at a psql prompt is
 * the exact drift the derived register exists to stop.
 *
 * ── An Install button only where installing can work ────────────────────────
 *
 * PostgreSQL 13+ lets a non-superuser install TRUSTED extensions. Everything
 * else needs superuser, and Backenly's application role is deliberately
 * NOSUPERUSER. So non-trusted extensions get the exact command and the reason
 * instead of a button whose only possible outcome is a permissions error.
 *
 * ── No uninstall ────────────────────────────────────────────────────────────
 *
 * `DROP EXTENSION` cascades into columns and indexes that depend on it and this
 * surface cannot show what that would take with it. Stated in the footer rather
 * than left as a puzzling absence.
 */

import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, Loader2, Puzzle, Download } from 'lucide-react'
import { KitButton, KitNote, KitBadge } from '@/components/inspector/kit'

interface ExtensionRow {
  name: string
  purpose: string
  caveat?: string
  available: boolean
  installed: boolean
  installedVersion: string | null
  defaultVersion: string | null
  schema: string | null
  trusted: boolean | null
  installable: boolean
  blockedReason: string | null
}

export function ExtensionsPanel({ projectId }: { projectId: string }) {
  const [rows, setRows] = useState<ExtensionRow[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<{ tone: 'danger' | 'success' | 'warn'; text: string } | null>(null)

  const load = useCallback(async () => {
    setLoadError(null)
    try {
      const res = await fetch(`/api/projects/${projectId}/database/extensions`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Extensions could not be loaded.')
      setRows(data.extensions ?? [])
    } catch (err) {
      // Reported, not swallowed. An empty list over a failed request reads as
      // "this server has no extensions", which is a different claim.
      setLoadError(err instanceof Error ? err.message : 'Extensions could not be loaded.')
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => { load() }, [load])

  async function install(name: string) {
    setBusy(name)
    setMessage(null)
    try {
      const res = await fetch(`/api/projects/${projectId}/database/extensions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      const data = await res.json()
      if (!res.ok) {
        // PostgreSQL's own words where it refused. "Install failed" would tell
        // an operator nothing they can act on.
        setMessage({ tone: 'danger', text: data.error ?? 'The extension could not be installed.' })
        return
      }
      setRows(data.extensions ?? rows)
      setMessage({
        tone: 'success',
        text: data.alreadyInstalled
          ? `${name} was already installed.`
          : `${name} ${data.version ?? ''} installed.`.trim(),
      })
    } catch (err) {
      setMessage({ tone: 'danger', text: err instanceof Error ? err.message : 'The extension could not be installed.' })
    } finally {
      setBusy(null)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 px-4 py-6 text-[12px] text-zinc-500">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Reading the extension catalog…
      </div>
    )
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
      <div className="max-w-[78ch]">
        <div className="flex items-center gap-2">
          <Puzzle className="h-3.5 w-3.5 text-zinc-500" />
          <h2 className="text-[12px] font-medium text-zinc-200">PostgreSQL extensions</h2>
        </div>
        <p className="mt-2 text-[12.5px] leading-relaxed text-zinc-400">
          Backenly installs from a fixed list. An extension runs its own install script with
          the privileges of whoever installs it, so the list is a code change rather than a
          text box &mdash; the same reason there is no SQL editor here.
        </p>

        {loadError && (
          <div className="mt-4"><KitNote icon={AlertTriangle} tone="danger">{loadError}</KitNote></div>
        )}
        {message && (
          <div className="mt-4">
            <KitNote icon={message.tone === 'success' ? CheckCircle2 : AlertTriangle} tone={message.tone}>
              {message.text}
            </KitNote>
          </div>
        )}

        <div className="mt-5 space-y-2">
          {rows.map(ext => (
            <div
              key={ext.name}
              className="flex items-start gap-3 rounded-lg border border-white/[0.06] bg-white/[0.015] px-3.5 py-3"
            >
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 font-mono text-[12px] text-zinc-200">
                  {ext.name}
                  {ext.installed && (
                    <span className="font-mono text-[10.5px] text-zinc-500">
                      {ext.installedVersion}
                      {ext.schema ? ` · ${ext.schema}` : ''}
                    </span>
                  )}
                </p>
                <p className="mt-0.5 text-[11.5px] leading-snug text-zinc-500">{ext.purpose}</p>

                {/* Why it cannot be installed, where that is the case. An
                    unexplained disabled button is worse than no button. */}
                {!ext.installed && ext.blockedReason && (
                  <p className="mt-1.5 text-[11.5px] leading-snug text-amber-500/80">
                    {ext.blockedReason}
                  </p>
                )}
              </div>

              <div className="flex flex-shrink-0 items-center gap-2">
                {ext.installed ? (
                  <KitBadge tone="operational">installed</KitBadge>
                ) : ext.installable ? (
                  <KitButton
                    variant="secondary"
                    size="sm"
                    icon={busy === ext.name ? Loader2 : Download}
                    disabled={busy !== null}
                    onClick={() => install(ext.name)}
                  >
                    Install
                  </KitButton>
                ) : (
                  <KitBadge tone={ext.available ? 'attention' : 'neutral'}>
                    {ext.available ? 'needs superuser' : 'unavailable'}
                  </KitBadge>
                )}
              </div>
            </div>
          ))}
        </div>

        <p className="mt-6 text-[11.5px] leading-relaxed text-zinc-500">
          There is no uninstall here. <span className="font-mono">DROP EXTENSION</span> cascades
          into the columns and indexes that depend on it, and this page cannot show what that
          would take with it. Removing one is a deliberate act at a psql prompt.
        </p>
      </div>
    </div>
  )
}
