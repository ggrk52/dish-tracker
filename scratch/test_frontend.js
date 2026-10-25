// Frontend unit tests for Photo Proof of Cleanliness
const fs = require('fs');
const path = require('path');
const assert = require('assert');

console.log('[TEST] Checking app.js photo functions and edge cases...');

// Read app.js (prioritizing public/app.js)
const appJsPath = fs.existsSync(path.join(__dirname, '..', 'public', 'app.js'))
  ? path.join(__dirname, '..', 'public', 'app.js')
  : path.join(__dirname, '..', 'app.js');
const appJs = fs.readFileSync(appJsPath, 'utf8');

// 1. Verify photoCompressionCounter exists and resetNotePhoto increments it
assert(appJs.includes('let photoCompressionCounter = 0;'), 'photoCompressionCounter missing');
assert(appJs.includes('photoCompressionCounter++;'), 'resetNotePhoto does not increment counter');

// 2. Verify createImageBitmap with EXIF orientation
assert(appJs.includes("createImageBitmap(file, { imageOrientation: 'from-image' })"), 'EXIF orientation not handled');

// 3. Verify white background fill for transparency
assert(appJs.includes("ctx.fillStyle = '#ffffff';"), 'White fill background missing in canvas');
assert(appJs.includes('ctx.fillRect(0, 0, canvas.width, canvas.height);'), 'fillRect missing');

// 4. Verify memory cleanup (revokeObjectURL and bitmap.close)
assert(appJs.includes('URL.revokeObjectURL(objectUrl);'), 'revokeObjectURL missing');
assert(appJs.includes('bitmap.close();'), 'bitmap.close missing');

// 5. Verify QuotaExceededError lean fallback in saveState
assert(appJs.includes('leanState'), 'Lean fallback missing in saveState');
assert(appJs.includes('(idx < 15 ? h : { ...h, photo: null })'), 'Photo pruning missing in saveState');

// 6. Verify keyboard accessibility on timeline
assert(appJs.includes("timeline.addEventListener('keydown', (e) => {"), 'Timeline keydown listener missing');
assert(appJs.includes("e.key === 'Enter' || e.key === ' '"), 'Enter/Space keydown check missing');

// 7. Verify glance photo badge
assert(appJs.includes('glance-photo-badge'), 'glance-photo-badge missing in app.js');

// 8. Verify photo viewer clears src on close
assert(appJs.includes("photoViewerImg.src = '';"), 'photo-viewer-img.src cleanup on close missing');

// 9. Verify dynamic reaction awards in renderStats
assert(appJs.includes('Object.keys(state.members'), 'Dynamic reactionCounts missing');

// 10. Verify window.location.origin in shareFamilyReport and UI
assert(appJs.includes('window.location.origin'), 'window.location.origin missing in app.js');
assert(!appJs.includes('http://192.168.1.75:8080'), 'Hardcoded IP still present in app.js');

// 11. Verify Firebase & Cloud dual sync
assert(appJs.includes("isFirebase = apiUrl.includes('firebaseio.com')"), 'Firebase check missing');
assert(appJs.includes("method: 'PUT'"), 'Firebase PUT method missing');

// 12. Test Cloudflare Worker module directly
(async () => {
  const workerModule = await import('../worker.js');
  const worker = workerModule.default;
  const mockKV = {
    data: {},
    async get(k) { return this.data[k] || null; },
    async put(k, v) { this.data[k] = v; }
  };
  const env = { DISH_KV: mockKV };

  // Unauthenticated
  const unauthReq = new Request('http://localhost/api/state', { method: 'POST', body: '{}' });
  const res1 = await worker.fetch(unauthReq, env);
  assert.strictEqual(res1.status, 401, 'Worker unauth POST must return 401');

  // Duty wash
  const dutyWash = new Request('http://localhost/api/state', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Auth-User': 'mama', 'X-Auth-Password': '1111' },
    body: JSON.stringify({ _action: 'wash', history: [{ id: 100, note: 'Clean!' }] })
  });
  const res2 = await worker.fetch(dutyWash, env);
  assert.strictEqual(res2.status, 200, 'Worker duty wash must return 200');

  // Non-duty wash
  const nonDutyWash = new Request('http://localhost/api/state', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Auth-User': 'mama', 'X-Auth-Password': '1111' },
    body: JSON.stringify({ _action: 'wash', history: [{ id: 101, note: 'Again!' }] })
  });
  const res3 = await worker.fetch(nonDutyWash, env);
  assert.strictEqual(res3.status, 403, 'Worker non-duty wash must return 403');

  // Non-washer undo
  const nonWasherUndo = new Request('http://localhost/api/state', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Auth-User': 'papa', 'X-Auth-Password': '2222' },
    body: JSON.stringify({ _action: 'undo' })
  });
  const res4 = await worker.fetch(nonWasherUndo, env);
  assert.strictEqual(res4.status, 403, 'Worker non-washer undo must return 403');

  // Verify KV sanitization
  const saved = JSON.parse(mockKV.data['dish_state']);
  assert.strictEqual(saved._authUser, undefined, 'Auth field leaked to KV');
  assert.strictEqual(saved._authToken, undefined, 'Auth token leaked to KV');

  console.log('✅ ALL FRONTEND AND WORKER LOGIC ASSERTIONS PASSED!');
})();
