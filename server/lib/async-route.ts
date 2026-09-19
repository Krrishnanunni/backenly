/**
 * AN ASYNC HANDLER THAT REJECTS MUST NOT KILL THE SERVER
 * =====================================================
 *
 * Express 4 does not await the functions it calls. An `async` handler returns a
 * promise that Express drops on the floor, so a rejection never reaches the
 * global error middleware in server/app.ts — it becomes an unhandled rejection,
 * and Node 15+ terminates the process on those.
 *
 * That turned a transient database error into a total outage. Observed in the
 * final qualification run: PostgreSQL was restarted, the next `/api/v1/*`
 * request hit `getProjectIdFromAuth`, Prisma raised P1017 ("Server has closed
 * the connection"), and the runtime process EXITED. Every v1 surface — /db/*,
 * end-user auth, realtime, storage — stayed down afterwards, because nothing
 * in the compose stack restarts that process. With a supervisor it becomes a
 * crash loop instead, dropping every in-flight request and severing every SSE
 * stream on any database blip.
 *
 * The global error handler was correct all along. It simply could never be
 * reached from an async handler, which is why the 500 it exists to send was
 * never sent.
 *
 * ── Middleware counts too ───────────────────────────────────────────────────
 *
 * `v1AuthMiddleware` and `realtimeAuth` are async and both query the database
 * before any handler runs, so they fail in exactly the same way. Everything in
 * a route's chain is wrapped, not just the final handler.
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express'

type MaybeAsyncHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => unknown | Promise<unknown>

/**
 * Forward a rejection to Express instead of losing it.
 *
 * Synchronous throws already reach `next` on their own; this covers the
 * asynchronous half, which is the half that ends the process.
 */
export function asyncRoute(handler: MaybeAsyncHandler): RequestHandler {
  return (req, res, next) => {
    try {
      const result = handler(req, res, next)
      if (result && typeof (result as Promise<unknown>).catch === 'function') {
        ;(result as Promise<unknown>).catch(next)
      }
    } catch (err) {
      next(err)
    }
  }
}

/** Wrap every function in a route's chain. */
export function asyncRoutes(handlers: MaybeAsyncHandler[]): RequestHandler[] {
  return handlers.map(asyncRoute)
}

/**
 * The backstop, and it is only that.
 *
 * Every route is wrapped above, so nothing should reach here. It exists because
 * the cost of ONE missed call site is the whole API going down, and that trade
 * is not worth leaving to a future edit remembering to wrap itself. It logs
 * loudly rather than exiting: a rejection nobody handled is a bug that needs
 * finding, but it is not a reason to stop serving every other request.
 *
 * It deliberately does NOT try to answer the request — it has no reference to
 * one. The wrapper is what turns these into a 500 the caller actually receives.
 */
export function installProcessSafetyNet(log: (message: string) => void = console.error): void {
  process.on('unhandledRejection', (reason: unknown) => {
    const detail =
      reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason)
    log(
      `[Runtime Server] UNHANDLED REJECTION — a promise rejected with nobody to catch it. ` +
        `This is a bug and the request that caused it received no response: ${detail}`,
    )
    if (reason instanceof Error && reason.stack) log(reason.stack)
  })
}
