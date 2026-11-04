const test = require('node:test');
const assert = require('node:assert/strict');
const action = require('./archive-action.js');
function makeEvent(index = 4, properties = '') {
  const row = { index, dataset: { properties } };
  const button = { disabled: false, closest: selector => selector === 'tr' ? row : null };
  const event = { button: 0, target: { closest: () => button },
    preventDefault() { this.prevented = true; },
    stopImmediatePropagation() { this.stopped = true; } };
  return { event, button, row };
}
test('archive exactly the clicked row and prevent native delete/selection bubbling', async () => {
  const { event, button, row } = makeEvent();
  const header = { folder: { key: 'only-this-account' } };
  const seen = [];
  const resolve = index => { assert.equal(index, 4); return header; };
  assert.equal(await action.click(event, resolve, async h => { seen.push(h); assert.equal(button.disabled, true); }), true);
  assert.deepEqual(seen, [header]);
  assert.equal(event.prevented, true); assert.equal(event.stopped, true);
  assert.equal(button.disabled, false);
  row.index = 8;
  await action.click(event, index => { assert.equal(index, 8); return header; }, async () => {});
});
test('do not archive group headers, invalid rows or unavailable messages', async () => {
  let archives = 0;
  for (const [index, properties] of [[4, 'dummy unread'], [-1, ''], [null, '']]) {
    const { event } = makeEvent(index, properties);
    assert.equal(await action.click(event, () => ({ folder: {} }), async () => { archives++; }), false);
  }
  const { event } = makeEvent();
  assert.equal(await action.click(event, () => null, async () => { archives++; }), false);
  assert.equal(archives, 0);
});
test('a failed archive is reported without a second move or a stuck button', async () => {
  const { event, button } = makeEvent(); let calls = 0;
  await assert.rejects(action.click(event, () => ({ folder: {} }), async () => { calls++; throw Error('offline'); }), /offline/);
  assert.equal(calls, 1); assert.equal(button.disabled, false);
});
