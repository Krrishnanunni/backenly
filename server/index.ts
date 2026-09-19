/**
 * Backenly Runtime API Server — Port 3001
 *
 * Handles all /api/v1/* routes (public runtime API for end-users):
 *   - Auth  (signin / signup)
 *   - Database CRUD
 *   - Realtime SSE (PostgreSQL LISTEN/NOTIFY)
 *   - Presence
 *   - Broadcast
 *   - Triggers (platform management)
 *   - Logs
 *   - Dynamic catch-all (generated table CRUD)
 *
 * Next.js on port 3000 handles the frontend and platform management APIs.
 * In development, Next.js rewrites /api/v1/* → http://localhost:3001/api/v1/*
 * In production, nginx proxies /api/v1/* → this server.
 */

import 'dotenv/config'
import { assertEditionCompositionOrExit } from '../lib/edition/cloud-extension'
import { installProcessSafetyNet } from './lib/async-route'
import app from './app'

// Before the socket, not after. This process serves every /api/v1/* request in
// production, so a cloud deployment that is missing its private half must die
// here rather than answer one request with single-tenant tenancy rules. A no-op
// unless BACKENLY_EDITION is explicitly cloud.
assertEditionCompositionOrExit('Runtime Server')

// Before the socket. Every route is wrapped so nothing should reach this, but
// the cost of one missed call site is the whole API going down - which is
// exactly what happened when a PostgreSQL restart made the next request's
// Prisma call reject with P1017 and Node terminated the process.
installProcessSafetyNet()

const PORT = parseInt(process.env.RUNTIME_PORT || '3001', 10)

const server = app.listen(PORT, () => {
  console.log(`[Runtime Server] Listening on http://localhost:${PORT}`)
  console.log(`[Runtime Server] Health: http://localhost:${PORT}/health`)
})

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[Runtime Server] SIGTERM received, shutting down gracefully...')
  server.close(() => {
    console.log('[Runtime Server] HTTP server closed')
    process.exit(0)
  })
})

process.on('SIGINT', () => {
  console.log('[Runtime Server] SIGINT received, shutting down gracefully...')
  server.close(() => {
    process.exit(0)
  })
})
