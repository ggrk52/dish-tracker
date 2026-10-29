const assert = require('assert');

// Test state simulation for cycle reset after swap
let state = {
  members: {
    serezha: { id: 'serezha', name: 'Серёжа' },
    mama: { id: 'mama', name: 'Мама' },
    vasya: { id: 'vasya', name: 'Вася' },
    papa: { id: 'papa', name: 'Папа' }
  },
  baseQueue: ['serezha', 'mama', 'vasya', 'papa'],
  queue: ['serezha', 'mama', 'vasya', 'papa'],
  currentQueueIndex: 0,
  stats: { serezha: 0, mama: 0, vasya: 0, papa: 0 },
  history: []
};

function handleSwap(memberA, memberB) {
  const idxA = state.queue.indexOf(memberA);
  const idxB = state.queue.indexOf(memberB);
  assert.ok(idxA !== -1 && idxB !== -1);
  const tmp = state.queue[idxA];
  state.queue[idxA] = state.queue[idxB];
  state.queue[idxB] = tmp;
}

function handleWash(washerId) {
  const currentMemberId = state.queue[state.currentQueueIndex];
  assert.strictEqual(washerId, currentMemberId);

  state.stats[washerId] = (state.stats[washerId] || 0) + 1;
  state.history.unshift({ id: Date.now(), washerId });

  // Cycle check
  const isEndOfCycle = (state.currentQueueIndex >= state.queue.length - 1);
  if (isEndOfCycle) {
    // Reset to canonical baseQueue!
    state.queue = [...state.baseQueue];
    state.currentQueueIndex = 0;
  } else {
    state.currentQueueIndex = state.currentQueueIndex + 1;
  }
}

console.log('[TEST 1] Initial canonical queue: Serezha (1), Mama (2), Vasya (3), Papa (4)');
assert.deepStrictEqual(state.queue, ['serezha', 'mama', 'vasya', 'papa']);
assert.strictEqual(state.currentQueueIndex, 0);

console.log('[TEST 2] Serezha (pos 1) swaps with Vasya (pos 3)');
handleSwap('serezha', 'vasya');
assert.deepStrictEqual(state.queue, ['vasya', 'mama', 'serezha', 'papa']);
assert.strictEqual(state.queue[0], 'vasya'); // Vasya washes 1st yesterday!
assert.strictEqual(state.queue[2], 'serezha'); // Serezha washes 3rd!

console.log('[TEST 3] Vasya washes at pos 1 (index 0)');
handleWash('vasya');
assert.strictEqual(state.currentQueueIndex, 1);
assert.strictEqual(state.queue[state.currentQueueIndex], 'mama');

console.log('[TEST 4] Mama washes at pos 2 (index 1)');
handleWash('mama');
assert.strictEqual(state.currentQueueIndex, 2);
assert.strictEqual(state.queue[state.currentQueueIndex], 'serezha');

console.log('[TEST 5] Serezha washes at pos 3 (index 2)');
handleWash('serezha');
assert.strictEqual(state.currentQueueIndex, 3);
assert.strictEqual(state.queue[state.currentQueueIndex], 'papa');

console.log('[TEST 6] Papa (pos 4, index 3) washes today, finishing the cycle of 4!');
handleWash('papa');

console.log('[TEST 7] Check cycle completion: queue MUST be reset to canonical baseQueue!');
assert.deepStrictEqual(state.queue, ['serezha', 'mama', 'vasya', 'papa']);
assert.strictEqual(state.currentQueueIndex, 0);
assert.strictEqual(state.queue[0], 'serezha'); // Serezha is 1st again!
assert.strictEqual(state.queue[2], 'vasya');   // Vasya is 3rd again!

console.log('Stats after cycle:');
console.log(state.stats);
assert.strictEqual(state.stats.serezha, 1);
assert.strictEqual(state.stats.mama, 1);
assert.strictEqual(state.stats.vasya, 1);
assert.strictEqual(state.stats.papa, 1);

console.log('\n🎉 ALL CYCLE RESET ASSERTIONS PASSED PERFECTLY!');
