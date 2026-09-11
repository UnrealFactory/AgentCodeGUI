import assert from 'node:assert/strict'
import test from 'node:test'
import { claudeSubscription, codexSubscription, readSubscription } from '../src-tauri/src/subscription-browser.mjs'

test('Claude active status with an end date equal to next charge is cancellation', () => {
  assert.deepEqual(claudeSubscription({ status: 'active', plan_ending_before: '2026-10-03', plan_ending_at: '2026-10-03T03:48:50Z', next_charge_date: '2026-10-03', next_charge_at: '2026-10-03T03:48:50Z' }), { kind: 'cancels', date: '2026-10-03T03:48:50Z' })
  assert.deepEqual(claudeSubscription({ status: 'active', plan_ending_before: null, next_charge_date: '2026-10-03' }), { kind: 'renews', date: '2026-10-03' })
  assert.equal(claudeSubscription({ status: 'active', plan_ending_before: '2026-11-03', next_charge_date: '2026-10-03' }).kind, 'renews')
})
test('gift, scheduled changes, and past-due accounts are not inferred to renew', () => {
  for (const extra of [{ gift_details: { paid_through: '2026-10-03' } }, { has_schedule: true }, { scheduled_downgrade: { plan: 'pro' } }]) {
    assert.equal(claudeSubscription({ status: 'active', next_charge_date: '2026-10-03', ...extra }).kind, 'scheduled')
  }
  assert.equal(claudeSubscription({ status: 'past_due', next_charge_date: '2026-10-03' }).kind, 'paymentDue')
  assert.equal(claudeSubscription({ status: 'trialing', trial_end_ts: Infinity }).date, null)
  assert.equal(claudeSubscription({ status: 'active', next_charge_date: 'broken' }).date, null)
  assert.equal(claudeSubscription({}), null)
})
test('ChatGPT requires the explicit account and uses renewal instead of grace expiry', () => {
  const row = { entitlement: { has_active_subscription: true, renews_at: '2026-10-06T09:11:11Z', expires_at: '2026-10-06T15:11:11Z' }, last_active_subscription: { will_renew: true } }
  assert.deepEqual(codexSubscription({ accounts: { registered: row } }, 'registered'), { kind: 'renews', date: '2026-10-06T09:11:11Z' })
  assert.equal(codexSubscription({ accounts: { default: row, someoneElse: row } }, 'registered'), null)
  assert.deepEqual(codexSubscription({ accounts: { registered: { ...row, entitlement: { ...row.entitlement, cancels_at: '2026-10-06T09:11:11Z' } } } }, 'registered'), { kind: 'cancels', date: '2026-10-06T09:11:11Z' })
  assert.equal(codexSubscription({ accounts: { registered: { ...row, last_active_subscription: { will_renew: false } } } }, 'registered').kind, 'active')
})
test('cancelled or unbound requests never launch a browser', async () => {
  const c = new AbortController(); c.abort()
  assert.deepEqual(await readSubscription({}, { signal: c.signal }), { error: 'cancelled' })
  assert.deepEqual(await readSubscription({ provider: 'claude' }), { error: 'identityMissing' })
})
