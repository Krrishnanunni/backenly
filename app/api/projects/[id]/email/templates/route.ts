export const dynamic = 'force-dynamic'

/**
 * Every auth email kind, with the operator's override when there is one.
 *
 * Returns all three kinds whether or not they are customised, because the
 * dashboard's job is to show what WILL be sent. A list of only the overrides
 * would leave an operator unable to tell "using the built-in" from "this kind
 * does not exist".
 */

import { NextRequest, NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth/route-protection'
import { canAccessProject } from '@/lib/edition/guard'
import { prisma } from '@/lib/db/prisma'
import { KIND_LABELS, TEMPLATE_KINDS, TEMPLATE_VARIABLES, REQUIRED_VARIABLES } from '@/lib/email/template-kinds'

export const GET = withAuth(async (_request: NextRequest, { user, params }) => {
  const { id: projectId } = await params
  if (!(await canAccessProject(user.userId, projectId))) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 })
  }

  const overrides = await prisma.projectEmailTemplate.findMany({
    where: { projectId },
    select: { kind: true, subject: true, bodyHtml: true, updatedAt: true },
  })
  const byKind = new Map(overrides.map(o => [o.kind, o]))

  return NextResponse.json({
    // The allowlist travels with the list, so the editor renders its help text
    // from the same source the validator enforces. Two copies is how a UI ends
    // up offering a placeholder the API rejects.
    variables: TEMPLATE_VARIABLES,
    requiredVariables: REQUIRED_VARIABLES,
    templates: TEMPLATE_KINDS.map(kind => {
      const override = byKind.get(kind)
      return {
        kind,
        title: KIND_LABELS[kind].title,
        sends: KIND_LABELS[kind].sends,
        customised: Boolean(override),
        subject: override?.subject ?? null,
        bodyHtml: override?.bodyHtml ?? null,
        updatedAt: override?.updatedAt?.toISOString() ?? null,
      }
    }),
  })
})
