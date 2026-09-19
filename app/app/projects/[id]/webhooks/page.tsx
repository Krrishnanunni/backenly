'use client'

/**
 * Webhooks — a first-class project surface.
 *
 * Under Connect rather than Build: an endpoint is somewhere this project sends
 * events, which is the same category as MCP and the SDK, not a thing you build
 * inside the backend.
 */

import { useEffect } from 'react'
import { useParams } from 'next/navigation'
import { Webhook } from 'lucide-react'
import { setCurrentProjectId } from '@/lib/api/client'
import { InspectorPageHeader } from '@/components/inspector/InspectorPageHeader'
import { WebhooksPanel } from '@/components/integrations/WebhooksPanel'

export default function ProjectWebhooksPage() {
  const params = useParams()
  const projectId = params.id as string

  if (projectId && typeof window !== 'undefined') setCurrentProjectId(projectId)
  useEffect(() => {
    if (projectId) setCurrentProjectId(projectId)
  }, [projectId])

  return (
    <div className="min-h-screen bg-[#101116] flex flex-col">
      <InspectorPageHeader
        icon={Webhook}
        title="Webhooks"
        description="Send signed events to your own services when rows change or an end user signs up. Row events are captured in PostgreSQL, so they fire for every writer."
      />
      <div className="flex-1">
        <WebhooksPanel projectId={projectId} />
      </div>
    </div>
  )
}
