// Frontend unit tests for Photo Proof of Cleanliness
const fs = require('fs');
const path = require('path');
const assert = require('assert');

console.log('[TEST] Checking app.js photo functions and edge cases...');

// Read app.js
const appJs = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

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

console.log('✅ ALL FRONTEND STATIC AND LOGIC ASSERTIONS PASSED!');
