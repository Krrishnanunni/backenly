export const dynamic = 'force-dynamic'

/**
 * Send a real email through the project's SMTP settings and report what
 * happened.
 *
 * The whole reason this exists is that "configured" and "works" are different
 * claims. Every field can be right and the credentials still wrong, the port
 * still blocked, the sender still unverified with the provider. A dashboard that
 * shows a green tick for a stored row is asserting the second from the first.
 *
 * So this performs a real send through the same transport production uses, and
 * the answer describes the RESULT. A restore step in the recovery tranche
 * returned a cheerful string having restored nothing; that class of answer is
 * banned.
 */

import { NextRequest, NextResponse } from 'next/server'
import nodemailer from 'nodemailer'
import { withAuth } from '@/lib/auth/route-protection'
import { canAdministerProject } from '@/lib/edition/guard'
import { buildProjectSmtpTransport, getSmtpConfigView, recordSmtpTest } from '@/lib/email/project-smtp'

export const POST = withAuth(async (request: NextRequest, { user, params }) => {
  const { id: projectId } = await params

  // ADMIN, and a write: this sends live mail to an address the caller names,
  // through credentials that may be billed per message.
  if (!(await canAdministerProject(user.userId, projectId))) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 })
  }

  const body = await request.json().catch(() => null)
  const to = typeof body?.to === 'string' ? body.to.trim() : ''
  if (!/^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(to)) {
    return NextResponse.json(
      { error: 'A "to" address is required, so the test proves delivery somewhere you can check.' },
      { status: 400 },
    )
  }

  const resolved = await buildProjectSmtpTransport(nodemailer, projectId)
  if (!resolved) {
    return NextResponse.json(
      {
        success: false,
        error:
          'No SMTP settings for this project and no deployment fallback, so nothing was sent.',
        smtp: await getSmtpConfigView(projectId),
      },
      // 400, not 500: nothing is broken. Nothing is configured.
      { status: 400 },
    )
  }

  try {
    await resolved.transport.sendMail({
      from: resolved.from,
      to,
      subject: 'Backenly SMTP test',
      // Deliberately dull and carrying no project data. A test message is not a
      // place to demonstrate templates, and it must be safe to send anywhere.
      text:
        'This is a test message from Backenly. If you are reading it, this ' +
        "project's outgoing mail settings work.",
    })
    await recordSmtpTest(projectId, null)
    return NextResponse.json({
      success: true,
      source: resolved.source,
      smtp: await getSmtpConfigView(projectId),
    })
  } catch (err: any) {
    // The provider's own words. An operator debugging a 535 needs to read it,
    // and paraphrasing it into "send failed" is how a five-second fix becomes a
    // support thread.
    const message = String(err?.message ?? err)
    await recordSmtpTest(projectId, message)
    return NextResponse.json({
      success: false,
      source: resolved.source,
      error: message.slice(0, 500),
      smtp: await getSmtpConfigView(projectId),
    })
  }
})
