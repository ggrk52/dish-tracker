const assert = require('assert');

let state = {
  members: {
    mama: { id: 'mama', name: 'Мама', color: '#ec4899', title: 'Хранительница очага' },
    papa: { id: 'papa', name: 'Папа', color: '#0284c7', title: 'Гроза сковородок' },
    serezha: { id: 'serezha', name: 'Серёжа', color: '#10b981', title: 'Мастер мыльной пены' },
    vasya: { id: 'vasya', name: 'Вася', color: '#f59e0b', title: 'Повелитель тарелок' }
  },
  queue: ['mama', 'papa', 'serezha', 'vasya'],
  currentQueueIndex: 3, // vasya
  stats: { mama: 5, papa: 5, serehza: 5, vasya: 5 },
  history: [],
  debts: [],
  pendingTakeover: null
};

function getActiveDebts() {
  return state.debts || [];
}

function getActiveDebtForMember(scheduledMemberId) {
  return getActiveDebts().find(d => d.toMemberId === scheduledMemberId);
}

function getCurrentDutyInfo() {
  const scheduledMemberId = state.queue[state.currentQueueIndex];
  const scheduledMember = state.members[scheduledMemberId];

  // Check if someone owes a debt to scheduledMember
  const debt = getActiveDebtForMember(scheduledMemberId);
  if (debt && state.members[debt.fromMemberId]) {
    return {
      member: state.members[debt.fromMemberId],
      scheduledMember: scheduledMember,
      isDebtWorkoff: true,
      debt: debt,
      isCovering: false
    };
  }

  // Check if current person is covering an immediate skip
  if (state.pendingTakeover && state.pendingTakeover.coveredBy === scheduledMemberId) {
    return {
      member: scheduledMember,
      scheduledMember: scheduledMember,
      isDebtWorkoff: false,
      debt: null,
      isCovering: true,
      coveringFor: state.members[state.pendingTakeover.skippedBy]
    };
  }

  return {
    member: scheduledMember,
    scheduledMember: scheduledMember,
    isDebtWorkoff: false,
    debt: null,
    isCovering: false
  };
}

function getCurrentDutyMember() {
  return getCurrentDutyInfo().member;
}

function handleSkip() {
  const dutyInfo = getCurrentDutyInfo();
  if (dutyInfo.isDebtWorkoff) {
    throw new Error('BLOCKED: Cannot skip debt payback!');
  }

  const current = dutyInfo.member;
  const nextIdx = (state.currentQueueIndex + 1) % state.queue.length;
  const nextMemberId = state.queue[nextIdx];

  state.pendingTakeover = {
    skippedBy: current.id,
    coveredBy: nextMemberId,
    timestamp: Date.now()
  };

  state.currentQueueIndex = nextIdx;
}

function handleWash(note = '') {
  const dutyInfo = getCurrentDutyInfo();
  const currentMember = dutyInfo.member;

  // 1. Increment individual count
  state.stats[currentMember.id] = (state.stats[currentMember.id] || 0) + 1;

  // 2. If this was a debt payback, settle the debt!
  if (dutyInfo.isDebtWorkoff) {
    state.debts = state.debts.filter(d => d.id !== dutyInfo.debt.id);
  }

  // 3. If this was covering a skip, create the debt owed to currentMember!
  if (dutyInfo.isCovering && state.pendingTakeover) {
    state.debts.push({
      id: Date.now(),
      fromMemberId: state.pendingTakeover.skippedBy,
      toMemberId: currentMember.id,
      createdAt: Date.now()
    });
    state.pendingTakeover = null;
  }

  state.history.unshift({
    id: Date.now(),
    memberId: currentMember.id,
    isDebtWorkoff: dutyInfo.isDebtWorkoff,
    paidDebtTo: dutyInfo.isDebtWorkoff ? dutyInfo.scheduledMember.id : null,
    note
  });

  state.currentQueueIndex = (state.currentQueueIndex + 1) % state.queue.length;
}

console.log('[TEST 1] Initial state: Vasya is on duty');
assert.strictEqual(getCurrentDutyMember().id, 'vasya');

console.log('[TEST 2] Vasya skips! Mama (next in queue) takes over the shift');
handleSkip();
assert.strictEqual(state.queue[state.currentQueueIndex], 'mama');
assert.strictEqual(getCurrentDutyMember().id, 'mama');
const infoAfterSkip = getCurrentDutyInfo();
assert.strictEqual(infoAfterSkip.isCovering, true);
assert.strictEqual(infoAfterSkip.coveringFor.id, 'vasya');

console.log('[TEST 3] Mama washes the dishes -> Debt from Vasya to Mama is now active!');
handleWash('Mama washes');
assert.strictEqual(state.stats.mama, 6);
assert.strictEqual(state.stats.vasya, 5);
assert.strictEqual(state.debts.length, 1);
assert.strictEqual(state.debts[0].fromMemberId, 'vasya');
assert.strictEqual(state.debts[0].toMemberId, 'mama');
assert.strictEqual(state.pendingTakeover, null);

// Queue moved to Papa (index 1)
assert.strictEqual(state.queue[state.currentQueueIndex], 'papa');
assert.strictEqual(getCurrentDutyMember().id, 'papa');

console.log('[TEST 4] Papa washes, then Serezha washes');
handleWash('Papa washes');
assert.strictEqual(state.queue[state.currentQueueIndex], 'serezha');
handleWash('Serezha washes');
assert.strictEqual(state.queue[state.currentQueueIndex], 'vasya');

console.log('[TEST 5] Vasya washes his own normal turn');
handleWash('Vasya washes');
assert.strictEqual(state.stats.vasya, 6);
// Now queue arrived at Mama (index 0)
assert.strictEqual(state.queue[state.currentQueueIndex], 'mama');

console.log('[TEST 6] Queue is scheduled for Mama, BUT Vasya owes Mama a debt!');
const mamaShiftInfo = getCurrentDutyInfo();
assert.strictEqual(mamaShiftInfo.isDebtWorkoff, true);
assert.strictEqual(mamaShiftInfo.scheduledMember.id, 'mama');
assert.strictEqual(mamaShiftInfo.member.id, 'vasya'); // Vasya must wash instead of Mama!

console.log('[TEST 7] Vasya tries to skip debt payback -> MUST BE BLOCKED');
assert.throws(() => handleSkip(), /BLOCKED: Cannot skip debt payback/);

console.log('[TEST 8] Vasya washes and pays back his debt to Mama');
handleWash('Vasya returns debt to Mama');
assert.strictEqual(state.debts.length, 0); // Debt cleared!
assert.strictEqual(state.stats.vasya, 7); // Vasya has 7 washes total
assert.strictEqual(state.stats.mama, 6);  // Mama rested, remains at 6!
// Queue moves past Mama to Papa!
assert.strictEqual(state.queue[state.currentQueueIndex], 'papa');
assert.strictEqual(getCurrentDutyMember().id, 'papa');

console.log('[TEST 9] Leaderboard Fair Score verification');
const debts = getActiveDebts();
const list = Object.values(state.members).map(m => {
  const count = state.stats[m.id] || 0;
  const debtsOwed = debts.filter(d => d.fromMemberId === m.id).length;
  const fairScore = count - debtsOwed;
  return { ...m, count, debtsOwed, fairScore };
});
list.sort((a, b) => b.fairScore - a.fairScore);

console.log('Leaderboard rankings:');
list.forEach(m => console.log(`  ${m.name}: FairScore=${m.fairScore}, Washes=${m.count}, Debts=${m.debtsOwed}`));
assert.strictEqual(list[0].id, 'vasya'); // Vasya worked off debt, fairScore 7
assert.strictEqual(list[1].id, 'mama');  // Mama fairScore 6

console.log('\n🎉 ALL PERSONAL DEBT & FAIRNESS LOGIC CHECKS PASSED PERFECTLY!');
