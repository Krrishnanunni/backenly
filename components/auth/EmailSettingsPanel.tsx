'use client'

/**
 * OUTGOING MAIL: WHERE IT SENDS FROM, AND WHAT IT SAYS
 * ===================================================
 *
 * Both halves were PARTIAL in the derived register for the same reason: the
 * thing was real and there was no way to configure it. A transport read
 * SMTP_HOST/SMTP_USER/SMTP_PASS from deployment env, and the subjects and
 * bodies were string literals in TypeScript.
 *
 * ── "Configured" is not "works", and this panel keeps them apart ────────────
 *
 * Every field can be right and the credentials still wrong, the port blocked,
 * the sender unverified with the provider. So the panel never shows a tick for
 * a stored row. It shows what is stored, and separately, the result of the last
 * REAL send. Send test is not a validity check — it is the only evidence.
 *
 * ── The preview is the dangerous surface, not the email ─────────────────────
 *
 * An operator authors raw HTML. A mail client runs none of it; the dashboard
 * would. So the preview renders inside an iframe with an empty `sandbox`
 * attribute — no scripts, no same-origin — and the API refuses a <script> tag
 * before it ever gets here. Two controls, because the iframe is the one that
 * holds if a future edit relaxes the other.
 *
 * ── The password is write-only ──────────────────────────────────────────────
 *
 * No route returns it. The field is empty on load and blank means "keep the
 * stored one", which is stated next to it rather than left to be inferred.
 */

import { useCallback, useEffect, useState } from 'react'
import {
  Mail, Loader2, Send, Save, Trash2, RotateCcw, AlertTriangle, CheckCircle2, Eye,
} from 'lucide-react'
import {
  KitButton, KitNote, KitField, KitInput, KitTextarea, KitBadge, KitModal, KitConfirmDialog,
} from '@/components/inspector/kit'

interface SmtpView {
  configured: boolean
  enabled: boolean
  host: string | null
  port: number | null
  username: string | null
  fromAddress: string | null
  fromName: string | null
  passwordConfigured: boolean
  effectivePort: number | null
  portNormalised: boolean
  lastTestAt: string | null
  lastTestError: string | null
  deploymentFallbackAvailable: boolean
  activeSource: 'project' | 'deployment' | 'none'
}

interface TemplateRow {
  kind: string
  title: string
  sends: string
  customised: boolean
  subject: string | null
  bodyHtml: string | null
  updatedAt: string | null
}

interface FieldProblem {
  field?: string
  message: string
}

const SOURCE_TEXT: Record<SmtpView['activeSource'], string> = {
  project: 'Mail sends through this project’s own SMTP settings.',
  deployment: 'Mail sends through the deployment’s SMTP environment variables.',
  none: 'Nothing is configured, so auth emails are only logged to the server console. Password reset and verification will not reach anyone.',
}

export function EmailSettingsPanel({ projectId }: { projectId: string }) {
  const [smtp, setSmtp] = useState<SmtpView | null>(null)
  const [templates, setTemplates] = useState<TemplateRow[]>([])
  const [variables, setVariables] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [message, setMessage] = useState<{ tone: 'danger' | 'success' | 'warn'; text: string } | null>(null)

  const [form, setForm] = useState({
    host: '', port: '587', username: '', password: '', fromAddress: '', fromName: '', enabled: true,
  })
  const [problems, setProblems] = useState<FieldProblem[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [testTo, setTestTo] = useState('')
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [editing, setEditing] = useState<TemplateRow | null>(null)

  const load = useCallback(async () => {
    setLoadError(null)
    try {
      const [smtpRes, tplRes] = await Promise.all([
        fetch(`/api/projects/${projectId}/email/smtp`),
        fetch(`/api/projects/${projectId}/email/templates`),
      ])
      const smtpData = await smtpRes.json()
      const tplData = await tplRes.json()
      if (!smtpRes.ok) throw new Error(smtpData.error ?? 'Mail settings could not be loaded.')
      if (!tplRes.ok) throw new Error(tplData.error ?? 'Templates could not be loaded.')

      setSmtp(smtpData.smtp)
      setTemplates(tplData.templates ?? [])
      setVariables(tplData.variables ?? [])
      setForm(f => ({
        ...f,
        host: smtpData.smtp.host ?? '',
        port: String(smtpData.smtp.port ?? 587),
        username: smtpData.smtp.username ?? '',
        fromAddress: smtpData.smtp.fromAddress ?? '',
        fromName: smtpData.smtp.fromName ?? '',
        enabled: smtpData.smtp.enabled ?? true,
        // Never populated from the server, because the server never sends it.
        password: '',
      }))
    } catch (err) {
      // Reported, not swallowed. Empty fields rendered over a failed request
      // read as "nothing is configured", which is a different and false claim.
      setLoadError(err instanceof Error ? err.message : 'Mail settings could not be loaded.')
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => { load() }, [load])

  async function save() {
    setBusy('save')
    setProblems([])
    setMessage(null)
    try {
      const res = await fetch(`/api/projects/${projectId}/email/smtp`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          host: form.host,
          port: Number(form.port),
          username: form.username,
          // Blank means keep. Sent as undefined rather than '' so the route can
          // tell "unchanged" from "cleared".
          password: form.password || undefined,
          fromAddress: form.fromAddress,
          fromName: form.fromName || null,
          enabled: form.enabled,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setProblems(data.problems ?? [{ message: data.error ?? 'These settings could not be saved.' }])
        return
      }
      setSmtp(data.smtp)
      setForm(f => ({ ...f, password: '' }))
      // Deliberately not "saved and working". Saving cleared the test result,
      // and claiming more than that is the failure this panel is built around.
      setMessage({ tone: 'warn', text: 'Saved. Send a test to confirm these settings actually deliver.' })
    } catch (err) {
      setMessage({ tone: 'danger', text: err instanceof Error ? err.message : 'These settings could not be saved.' })
    } finally {
      setBusy(null)
    }
  }

  async function sendTest() {
    setBusy('test')
    setMessage(null)
    try {
      const res = await fetch(`/api/projects/${projectId}/email/smtp/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: testTo.trim() }),
      })
      const data = await res.json()
      if (data.smtp) setSmtp(data.smtp)

      if (data.success) {
        setMessage({ tone: 'success', text: `Delivered to ${testTo.trim()} via the ${data.source} settings.` })
      } else {
        // The provider's own words. Paraphrasing a 535 into "send failed" is
        // how a five-second fix becomes a support thread.
        setMessage({ tone: 'danger', text: data.error ?? 'The test was not delivered.' })
      }
    } catch (err) {
      setMessage({ tone: 'danger', text: err instanceof Error ? err.message : 'The test was not delivered.' })
    } finally {
      setBusy(null)
    }
  }

  async function removeConfig() {
    setBusy('remove')
    try {
      const res = await fetch(`/api/projects/${projectId}/email/smtp`, { method: 'DELETE' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'The settings could not be removed.')
      setSmtp(data.smtp)
      await load()
      setMessage({ tone: 'success', text: 'Project SMTP removed.' })
    } catch (err) {
      setMessage({ tone: 'danger', text: err instanceof Error ? err.message : 'The settings could not be removed.' })
    } finally {
      setBusy(null)
      setConfirmRemove(false)
    }
  }

  async function revertTemplate(kind: string) {
    setBusy(`revert-${kind}`)
    try {
      const res = await fetch(`/api/projects/${projectId}/email/templates/${kind}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('The template could not be reverted.')
      await load()
      setMessage({ tone: 'success', text: 'Reverted to the built-in template.' })
    } catch (err) {
      setMessage({ tone: 'danger', text: err instanceof Error ? err.message : 'The template could not be reverted.' })
    } finally {
      setBusy(null)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 px-4 py-6 text-[12px] text-zinc-500">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Loading mail settings…
      </div>
    )
  }

  return (
    <div className="px-4 py-5">
      <div className="max-w-[72ch] space-y-6">
        {loadError && <KitNote icon={AlertTriangle} tone="danger">{loadError}</KitNote>}
        {message && (
          <KitNote icon={message.tone === 'success' ? CheckCircle2 : AlertTriangle} tone={message.tone}>
            {message.text}
          </KitNote>
        )}

        {/* ── Where mail sends from ───────────────────────────────── */}
        <section>
          <div className="flex items-center gap-2">
            <Mail className="h-3.5 w-3.5 text-zinc-500" />
            <h2 className="text-[12px] font-medium text-zinc-200">Outgoing mail</h2>
            {smtp && (
              <KitBadge tone={smtp.activeSource === 'none' ? 'failed' : 'operational'}>
                {smtp.activeSource}
              </KitBadge>
            )}
          </div>

          {smtp && (
            <p className="mt-2 text-[12.5px] leading-relaxed text-zinc-400">{SOURCE_TEXT[smtp.activeSource]}</p>
          )}

          {/* Evidence of a real send, kept apart from whether settings exist. */}
          {smtp?.configured && (
            <div className="mt-3">
              {smtp.lastTestAt && !smtp.lastTestError && (
                <KitNote icon={CheckCircle2} tone="success">
                  Last test delivered on {new Date(smtp.lastTestAt).toLocaleString()}.
                </KitNote>
              )}
              {smtp.lastTestAt && smtp.lastTestError && (
                <KitNote icon={AlertTriangle} tone="danger" title="The last test did not deliver">
                  {smtp.lastTestError}
                </KitNote>
              )}
              {!smtp.lastTestAt && (
                <KitNote icon={AlertTriangle} tone="warn">
                  These settings have never been tested, so nothing here says they work.
                </KitNote>
              )}
            </div>
          )}

          <div className="mt-4 grid grid-cols-2 gap-3">
            <KitField label="Host">
              <KitInput value={form.host} onChange={e => setForm({ ...form, host: e.target.value })} placeholder="smtp.example.com" />
            </KitField>
            <KitField
              label="Port"
              hint={
                smtp?.portNormalised
                  ? `465 is rewritten to ${smtp.effectivePort}: implicit TLS is blocked outbound on many hosts and every major provider serves STARTTLS on 587.`
                  : undefined
              }
            >
              <KitInput value={form.port} onChange={e => setForm({ ...form, port: e.target.value })} inputMode="numeric" />
            </KitField>
            <KitField label="Username">
              <KitInput value={form.username} onChange={e => setForm({ ...form, username: e.target.value })} />
            </KitField>
            <KitField
              label="Password"
              hint={smtp?.passwordConfigured ? 'Stored. Leave blank to keep it.' : 'Required.'}
            >
              <KitInput
                type="password"
                value={form.password}
                onChange={e => setForm({ ...form, password: e.target.value })}
                placeholder={smtp?.passwordConfigured ? '••••••••' : ''}
                autoComplete="new-password"
              />
            </KitField>
            <KitField label="From address">
              <KitInput value={form.fromAddress} onChange={e => setForm({ ...form, fromAddress: e.target.value })} placeholder="auth@example.com" />
            </KitField>
            <KitField label="From name" hint="Optional.">
              <KitInput value={form.fromName} onChange={e => setForm({ ...form, fromName: e.target.value })} placeholder="Example" />
            </KitField>
          </div>

          <label className="mt-3 flex cursor-pointer items-center gap-2 text-[12px] text-zinc-300">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={e => setForm({ ...form, enabled: e.target.checked })}
              className="accent-violet-400"
            />
            Use these settings
            <span className="text-zinc-500">
              {smtp?.deploymentFallbackAvailable
                ? '— unchecked falls back to the deployment’s SMTP.'
                : '— unchecked means auth emails are only logged.'}
            </span>
          </label>

          {problems.length > 0 && (
            <div className="mt-3">
              <KitNote icon={AlertTriangle} tone="danger" title="These settings cannot be used">
                <ul className="list-disc pl-4">
                  {problems.map((p, i) => <li key={i}>{p.field ? `${p.field}: ` : ''}{p.message}</li>)}
                </ul>
              </KitNote>
            </div>
          )}

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <KitButton variant="primary" size="sm" icon={busy === 'save' ? Loader2 : Save} disabled={busy !== null} onClick={save}>
              Save
            </KitButton>
            {smtp?.configured && (
              <KitButton variant="ghost" size="sm" icon={Trash2} disabled={busy !== null} onClick={() => setConfirmRemove(true)}>
                Remove
              </KitButton>
            )}
          </div>

          <div className="mt-4 flex flex-wrap items-end gap-2">
            <div className="min-w-[240px] flex-1">
              <KitField label="Send a test to" hint="A real message, through these settings. It is the only thing that proves they work.">
                <KitInput value={testTo} onChange={e => setTestTo(e.target.value)} placeholder="you@example.com" />
              </KitField>
            </div>
            <KitButton
              variant="secondary"
              size="sm"
              icon={busy === 'test' ? Loader2 : Send}
              disabled={busy !== null || testTo.trim() === ''}
              onClick={sendTest}
            >
              Send test
            </KitButton>
          </div>
        </section>

        {/* ── What the mail says ──────────────────────────────────── */}
        <section className="border-t border-white/[0.06] pt-5">
          <h2 className="text-[12px] font-medium text-zinc-200">Auth email templates</h2>
          <p className="mt-2 text-[12.5px] leading-relaxed text-zinc-400">
            Each email has a built-in version that already works. Editing one replaces it for
            this project; reverting removes the override. Available values:{' '}
            {variables.map(v => <code key={v} className="mr-1.5 font-mono text-[11.5px] text-zinc-300">{`{{${v}}}`}</code>)}
          </p>

          <div className="mt-4 space-y-2">
            {templates.map(t => (
              <div key={t.kind} className="flex items-center gap-3 rounded-lg border border-white/[0.06] bg-white/[0.015] px-3.5 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-[12px] text-zinc-200">{t.title}</p>
                  <p className="mt-0.5 text-[11.5px] text-zinc-500">{t.sends}</p>
                </div>
                <KitBadge tone={t.customised ? 'operational' : 'neutral'}>
                  {t.customised ? 'customised' : 'built-in'}
                </KitBadge>
                <KitButton variant="ghost" size="sm" disabled={busy !== null} onClick={() => setEditing(t)}>
                  Edit
                </KitButton>
                {t.customised && (
                  <KitButton
                    variant="ghost"
                    size="sm"
                    icon={busy === `revert-${t.kind}` ? Loader2 : RotateCcw}
                    disabled={busy !== null}
                    onClick={() => revertTemplate(t.kind)}
                  >
                    Revert
                  </KitButton>
                )}
              </div>
            ))}
          </div>
        </section>
      </div>

      {confirmRemove && (
        <KitConfirmDialog
          open
          danger
          busy={busy === 'remove'}
          title="Remove this project’s SMTP settings?"
          description={
            smtp?.deploymentFallbackAvailable
              ? 'Auth emails will fall back to the deployment’s SMTP environment variables. The stored password is deleted and cannot be recovered.'
              : 'There is no deployment fallback configured, so auth emails will only be logged to the server console. Password reset and verification will stop reaching anyone.'
          }
          confirmLabel={busy === 'remove' ? 'Removing…' : 'Remove'}
          onConfirm={removeConfig}
          onCancel={() => setConfirmRemove(false)}
        />
      )}

      {editing && (
        <TemplateEditor
          projectId={projectId}
          template={editing}
          variables={variables}
          onClose={() => setEditing(null)}
          onSaved={async () => { setEditing(null); await load(); setMessage({ tone: 'success', text: 'Template saved.' }) }}
        />
      )}
    </div>
  )
}

/**
 * Edit one template, with a preview rendered by the server.
 *
 * The preview HTML is put into a sandboxed iframe rather than into the
 * dashboard's own DOM. `sandbox` with no tokens means no scripts and no
 * same-origin access, so even if the API's <script> refusal were relaxed, what
 * an operator types here still cannot run against their session.
 */
function TemplateEditor({
  projectId, template, variables, onClose, onSaved,
}: {
  projectId: string
  template: TemplateRow
  variables: string[]
  onClose: () => void
  onSaved: () => void
}) {
  const [subject, setSubject] = useState(template.subject ?? '')
  const [bodyHtml, setBodyHtml] = useState(template.bodyHtml ?? '')
  const [errors, setErrors] = useState<FieldProblem[]>([])
  const [preview, setPreview] = useState<{ subject: string; bodyHtml: string } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  async function runPreview() {
    setBusy('preview')
    setErrors([])
    try {
      const res = await fetch(`/api/projects/${projectId}/email/templates/${template.kind}/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subject, bodyHtml }),
      })
      const data = await res.json()
      if (!res.ok) { setErrors(data.errors ?? [{ message: data.error }]); setPreview(null); return }
      setPreview(data.preview)
    } finally {
      setBusy(null)
    }
  }

  async function save() {
    setBusy('save')
    setErrors([])
    try {
      const res = await fetch(`/api/projects/${projectId}/email/templates/${template.kind}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subject, bodyHtml }),
      })
      const data = await res.json()
      if (!res.ok) { setErrors(data.errors ?? [{ message: data.error }]); return }
      onSaved()
    } finally {
      setBusy(null)
    }
  }

  return (
    <KitModal
      open
      width="max-w-3xl"
      title={template.title}
      description={template.sends}
      onClose={onClose}
      footer={
        <>
          <KitButton variant="ghost" size="sm" onClick={onClose}>Cancel</KitButton>
          <KitButton variant="secondary" size="sm" icon={busy === 'preview' ? Loader2 : Eye} disabled={busy !== null} onClick={runPreview}>
            Preview
          </KitButton>
          <KitButton variant="primary" size="sm" icon={busy === 'save' ? Loader2 : Save} disabled={busy !== null} onClick={save}>
            Save
          </KitButton>
        </>
      }
    >
      <div className="space-y-4">
        <KitField label="Subject">
          <KitInput value={subject} onChange={e => setSubject(e.target.value)} placeholder="Reset your {{appName}} password" />
        </KitField>

        <KitField
          label="Body"
          hint={<>Must contain <code className="font-mono text-zinc-300">{'{{ctaUrl}}'}</code>, or the email has no working link. Available: {variables.map(v => `{{${v}}}`).join(', ')}</>}
        >
          <KitTextarea
            value={bodyHtml}
            onChange={e => setBodyHtml(e.target.value)}
            rows={12}
            className="font-mono text-[11.5px]"
            placeholder={'<p>Hi {{email}}, <a href="{{ctaUrl}}">reset your password</a>. Expires in {{expiry}}.</p>'}
          />
        </KitField>

        {errors.length > 0 && (
          <KitNote icon={AlertTriangle} tone="danger" title="This template cannot be used">
            <ul className="list-disc pl-4">
              {errors.map((e, i) => <li key={i}>{e.message}</li>)}
            </ul>
          </KitNote>
        )}

        {preview && (
          <div>
            <p className="mb-1.5 text-[11px] font-medium text-zinc-400">
              Preview — subject: <span className="text-zinc-200">{preview.subject}</span>
            </p>
            {/* Sandboxed with NO tokens: no scripts, no same-origin. Operator
                HTML renders here and can do nothing to the dashboard. */}
            <iframe
              title="Email preview"
              sandbox=""
              srcDoc={preview.bodyHtml}
              className="h-64 w-full rounded-lg border border-white/10 bg-white"
            />
          </div>
        )}
      </div>
    </KitModal>
  )
}
