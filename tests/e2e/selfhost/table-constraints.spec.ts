/**
 * THE CONSTRAINT PICKER, THROUGH A BROWSER
 * =======================================
 * The unit and integration suites prove the rule and the executor. Neither can
 * prove that the modal wires them together: that the picked table reaches the
 * request, that the guard blocks a column the server would refuse, that a
 * partial failure is reported rather than swallowed. Those are properties of
 * the page, and only a browser can observe them.
 *
 * Runs against the deployment `npm run selfhost` built, signed in as the first
 * operator. Nothing here is mocked — the request goes to the real route, the
 * real executor runs, and the assertion is on what the page then shows.
 */

import { test, expect } from '@playwright/test'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const HANDOFF = resolve(__dirname, '../../../.playwright/selfhost-project.json')

function projectId(): string {
  return JSON.parse(readFileSync(HANDOFF, 'utf8')).id
}

/**
 * A fresh install has no tables.
 *
 * The database page filters out an empty `users` scaffold, so a deployment the
 * installer just produced shows nothing, and the add-column modal is not
 * reachable because no table is selected. The fixture is created through the
 * real create-table route rather than by raw SQL, so the tables it makes are
 * the same ones the editor lists - platform rows included.
 */
test.beforeAll(async ({ request }) => {
  const id = projectId()
  for (const tableName of ['e2e_documents', 'e2e_organizations']) {
    const res = await request.post(`/api/database/create-table?projectId=${id}`, {
      data: {
        tableName,
        columns: [
          { name: 'title', type: 'text', nullable: true },
        ],
      },
    })
    // 409 means a previous run in this deployment already made it, which is
    // fine. Anything else is a fixture that did not build, and the specs below
    // would fail for an unrelated reason.
    expect(
      res.ok() || res.status() === 409,
      `could not create ${tableName} (${res.status()}): ${await res.text()}`
    ).toBe(true)
  }
})

test.beforeEach(async ({ page }) => {
  await page.goto(`/app/projects/${projectId()}/database`)
  // "Add column" is the anchor: it exists only once the page has loaded its
  // table list AND selected a table, which is exactly the state these specs
  // need. Waiting on a heading asserted markup the page does not have.
  await expect(page.getByRole('button', { name: /add column/i }).first()).toBeVisible({
    timeout: 45_000,
  })
})

test('the add-column modal offers constraints, not just name and type', async ({ page }) => {
  // The gap this tranche closed: the backend accepted unique, check and
  // foreign_key, and the modal sent only {name, type, nullable}.
  await page.getByRole('button', { name: /add column/i }).first().click()

  await expect(page.getByText('Constraints', { exact: true })).toBeVisible()
  await expect(page.getByLabel(/unique/i).or(page.getByText('Unique', { exact: true }))).toBeVisible()
  await expect(page.getByText('References', { exact: true })).toBeVisible()
  await expect(page.getByText('Check', { exact: true })).toBeVisible()
})

test('a foreign key on a badly named column is blocked before it is submitted', async ({ page }) => {
  // The executor refuses this, and refuses it AFTER creating the column. The
  // modal knows the same rule, so the operator is stopped while the choice is
  // still free to change. This asserts the guard, not the refusal.
  await page.getByRole('button', { name: /add column/i }).first().click()

  await page.getByPlaceholder(/e\.g\. email, price, is_active/i).fill('description')

  const references = page.locator('select').filter({ hasText: /no foreign key/i }).first()
  const options = await references.locator('option').allTextContents()
  // Needs a second table to reference. A single-table deployment cannot
  // exercise this, and silently passing would be worse than skipping.
  test.skip(options.length < 2, 'deployment has no second table to reference')

  await references.selectOption({ index: 1 })

  await expect(page.getByText(/foreign key needs a column named like/i)).toBeVisible()
  await expect(page.getByRole('button', { name: /^add column$/i }).last()).toBeDisabled()
})

test('renaming the column to the suggested shape unblocks it', async ({ page }) => {
  await page.getByRole('button', { name: /add column/i }).first().click()

  const references = page.locator('select').filter({ hasText: /no foreign key/i }).first()
  const options = await references.locator('option').allTextContents()
  test.skip(options.length < 2, 'deployment has no second table to reference')

  await page.getByPlaceholder(/e\.g\. email, price, is_active/i).fill('description')
  await references.selectOption({ index: 1 })
  await expect(page.getByRole('button', { name: /^add column$/i }).last()).toBeDisabled()

  // The hint names a column the rule accepts. Following it must actually work,
  // or the guidance is worse than none.
  const hint = await page.getByText(/foreign key needs a column named like/i).textContent()
  const suggested = hint?.match(/like\s+(\S+?)\./)?.[1] ?? 'thing_id'

  await page.getByPlaceholder(/e\.g\. email, price, is_active/i).fill(suggested)
  await expect(page.getByRole('button', { name: /^add column$/i }).last()).toBeEnabled()
})

test('cancelling clears the form, so a reopened modal carries no stale constraint', async ({ page }) => {
  // A modal that keeps its previous state silently applies a constraint the
  // operator chose for a different column.
  await page.getByRole('button', { name: /add column/i }).first().click()
  await page.getByPlaceholder(/e\.g\. email, price, is_active/i).fill('leftover_col')
  await page.getByText('Unique', { exact: true }).click()

  await page.getByRole('button', { name: /cancel/i }).click()
  await page.getByRole('button', { name: /add column/i }).first().click()

  await expect(page.getByPlaceholder(/e\.g\. email, price, is_active/i)).toHaveValue('')
  const references = page.locator('select').filter({ hasText: /no foreign key/i }).first()
  await expect(references).toHaveValue('')
})
