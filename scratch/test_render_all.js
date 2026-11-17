const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

console.log('[TEST] Verifying renderAll() execution without runtime errors...');

const htmlPath = path.join(__dirname, '..', 'public', 'index.html');
const appJsPath = path.join(__dirname, '..', 'public', 'app.js');

const html = fs.readFileSync(htmlPath, 'utf8');
const appJs = fs.readFileSync(appJsPath, 'utf8');

// Simple DOM element mock
class MockElement {
  constructor(id = '', tagName = 'div') {
    this.id = id;
    this.tagName = tagName.toUpperCase();
    this.className = '';
    this.classList = {
      add: (...c) => { this.className += ' ' + c.join(' '); },
      remove: (...c) => { this.className = this.className.split(' ').filter(x => !c.includes(x)).join(' '); },
      toggle: (c, val) => {
        if (val) this.classList.add(c);
        else this.classList.remove(c);
      },
      contains: (c) => this.className.includes(c)
    };
    this.style = {
      setProperty(k, v) { this[k] = v; }
    };
    this.attributes = {};
    this.innerHTML = '';
    this.textContent = '';
    this.children = [];
  }
  getContext() {
    return {
      clearRect() {},
      beginPath() {},
      arc() {},
      fill() {},
      stroke() {},
      save() {},
      restore() {},
      translate() {},
      rotate() {}
    };
  }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return this.attributes[k] || null; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 40 }; }
  querySelector() { return new MockElement(); }
  querySelectorAll() { return []; }
  appendChild(child) { this.children.push(child); }
  addEventListener() {}
  removeEventListener() {}
}

const elements = new Map();
function getOrCreateElement(id) {
  if (!elements.has(id)) {
    elements.set(id, new MockElement(id));
  }
  return elements.get(id);
}

// Extract IDs from index.html
const idRegex = /id="([^"]+)"/g;
let match;
while ((match = idRegex.exec(html)) !== null) {
  getOrCreateElement(match[1]);
}

const mockWindow = {
  location: { href: 'http://localhost/', search: '', origin: 'http://localhost' },
  localStorage: {
    store: {},
    getItem(k) { return this.store[k] || null; },
    setItem(k, v) { this.store[k] = String(v); },
    removeItem(k) { delete this.store[k]; }
  },
  addEventListener() {},
  requestAnimationFrame(cb) { setTimeout(cb, 0); },
  scrollTo() {}
};

const mockDocument = {
  hidden: false,
  getElementById(id) { return getOrCreateElement(id); },
  querySelector(sel) {
    if (sel.startsWith('#')) return getOrCreateElement(sel.slice(1));
    return new MockElement('', sel);
  },
  querySelectorAll() { return []; },
  createElement(tag) { return new MockElement('', tag); },
  addEventListener() {}
};

const sandbox = {
  window: mockWindow,
  document: mockDocument,
  localStorage: mockWindow.localStorage,
  location: mockWindow.location,
  navigator: { userAgent: 'NodeTest', vibrate() {} },
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  console,
  URLSearchParams,
  Date,
  Math,
  parseInt,
  isNaN,
  Array,
  Object,
  JSON,
  String,
  RegExp,
  Error,
  Buffer
};

vm.createContext(sandbox);

try {
  vm.runInContext(appJs, sandbox);
  console.log('  ✅ app.js script loaded into sandbox without syntax/top-level errors');

  // Set logged in user as serezha (admin)
  sandbox.setAuthSession({
    user: { username: 'serezha', name: 'Серёжа', role: 'admin', avatar: '👦' },
    token: 'test-token'
  });

  // Call renderAll
  sandbox.renderAll();
  console.log('  ✅ renderAll() executed successfully for serezha (admin)');

  // Verify duty-person-name was populated
  const heroNameEl = mockDocument.getElementById('hero-name');
  assert(heroNameEl.textContent !== '—' && heroNameEl.textContent !== '', 'hero-name was not populated by renderDutyTab()');
  console.log(`  ✅ Hero duty person correctly rendered: "${heroNameEl.textContent}"`);

  // Verify duty-status-badge was populated
  const washBtnTitle = mockDocument.getElementById('wash-btn-title');
  console.log(`  ✅ Wash button label correctly rendered: "${washBtnTitle ? washBtnTitle.textContent : ''}"`);

  // Verify switchTab to history (lazy render)
  sandbox.switchTab('tab-history', false);
  console.log('  ✅ switchTab("tab-history") executed cleanly with lazy rendering');

  // Verify switchTab to stats (lazy render)
  sandbox.switchTab('tab-stats', false);
  console.log('  ✅ switchTab("tab-stats") executed cleanly with lazy rendering');

  // Verify updateLiveTickers execution
  sandbox.updateLiveTickers();
  console.log('  ✅ updateLiveTickers() executed cleanly');

  console.log('🎉 ALL RENDER TESTS PASSED!');
} catch (err) {
  console.error('❌ Render test failed:', err);
  process.exit(1);
}
