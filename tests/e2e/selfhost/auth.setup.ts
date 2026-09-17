/**
 * A REAL SESSION, ON A REAL SELF-HOSTED DEPLOYMENT
 * ===============================================
 * The specs beside this file assert user-visible behaviour, so they need a
 * signed-in browser. The pre-existing suite in `tests/e2e/` says
 * "assumes user is already authenticated" and nothing ever made that true,
 * which is why it has never run in CI and is not evidence for anything.
 *
 * This makes it true, without a fixture or a mock: it registers through the
 * real `/api/auth/register` route against the deployment `npm run selfhost`
 * just built, and saves the session cookie the app itself issued. If
 * registration is broken, these tests do not run — which is correct, because a
 * deployment nobody can sign into is not one whose dashboard is worth
 * asserting.
 *
 * A self-hosted install admits exactly one account and then closes
 * registration, so this runs once per deployment, as the first operator.
 */

import { test as setup, expect } from '@playwright/test'
import { randomBytes } from 'crypto'
import { mkdirSync, writeFileSync } from 'fs'
import { dirname, resolve } from 'path'

export const STORAGE_STATE = resolve(__dirname, '../../../.playwright/selfhost-state.json')
const PROJECT_HANDOFF = resolve(__dirname, '../../../.playwright/selfhost-project.json')

setup('sign up the first operator', async ({ page, request, baseURL }) => {
  const email = `e2e-${randomBytes(4).toString('hex')}@example.test`
  // Long enough for any password policy, and generated so it is never a
  // literal in the repository.
  const password = `E2e!${randomBytes(12).toString('hex')}`

  const res = await request.post('/api/auth/register', {
    data: { email, password, name: 'E2E Operator' },
  })

  // A closed registration means a previous run already claimed the single
  // account. Saying so plainly beats a timeout on a login form later.
  expect(
    res.ok(),
    `registration failed (${res.status()}): ${await res.text()}`
  ).toBe(true)

  // Register returns a token in its BODY and sets no cookie; login is what
  // issues the `auth-token` cookie the app authenticates with. So the setup
  // does what an operator does — sign up, then sign in — rather than lifting
  // the token out of the register response and constructing a cookie by hand.
  // A hand-built cookie would also pass if login were broken, which is exactly
  // the failure this suite should not be blind to.
  const login = await request.post('/api/auth/login', { data: { email, password } })
  expect(login.ok(), `login failed (${login.status()}): ${await login.text()}`).toBe(true)

  // The cookie the application set, not one this file invented. Reading it back
  // from the context is what proves the session is real.
  const cookies = await request.storageState().then(s => s.cookies)
  const auth = cookies.find(c => c.name === 'auth-token')
  expect(auth, 'no auth-token cookie was issued by /api/auth/login').toBeTruthy()

  mkdirSync(dirname(STORAGE_STATE), { recursive: true })
  writeFileSync(
    STORAGE_STATE,
    JSON.stringify({ cookies, origins: [] }, null, 2),
    'utf8'
  )

  // Prove the session actually opens the dashboard before any spec depends on
  // it. A cookie that exists but does not authenticate would otherwise surface
  // as an unrelated failure in every spec at once.
  await page.context().addCookies(cookies)
  await page.goto('/app')
  await expect(page).toHaveURL(/\/app(\/|$)/, { timeout: 30_000 })

  // The single project this deployment is. Its id is what the database specs
  // navigate to, and bootstrap pinned it long before the browser opened.
  const projects = await request.get('/api/projects')
  expect(projects.ok(), `could not list projects: ${projects.status()}`).toBe(true)
  const body = await projects.json()
  const list = Array.isArray(body) ? body : (body.projects ?? body.data ?? [])
  expect(Array.isArray(list) && list.length > 0, 'the deployment has no project').toBe(true)

  writeFileSync(PROJECT_HANDOFF, JSON.stringify({ id: list[0].id, email }, null, 2), 'utf8')
  void baseURL
})
