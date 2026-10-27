const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const server = http.createServer((req, res) => {
  let reqPath = req.url.split('?')[0];
  if (reqPath === '/') reqPath = '/index.html';
  const filePath = path.join(__dirname, '../public', reqPath);

  if (fs.existsSync(filePath)) {
    const ext = path.extname(filePath);
    const mimeMap = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.json': 'application/json',
      '.svg': 'image/svg+xml'
    };
    res.writeHead(200, { 'Content-Type': mimeMap[ext] || 'text/plain' });
    fs.createReadStream(filePath).pipe(res);
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  console.log(`[TEST] Test server listening on http://127.0.0.1:${port}`);

  const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const chromeProc = spawn(chromePath, [
    '--headless=new',
    '--remote-debugging-port=0',
    '--no-sandbox',
    '--disable-gpu',
    'about:blank'
  ]);

  let cdpPort = null;
  chromeProc.stderr.on('data', async chunk => {
    const str = chunk.toString();
    const match = str.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
    if (match && !cdpPort) {
      cdpPort = match[1];
      console.log(`[TEST] Chrome debugging port: ${cdpPort}`);
      try {
        // Query http://127.0.0.1:cdpPort/json to get page target
        await new Promise(r => setTimeout(r, 400));
        const res = await fetch(`http://127.0.0.1:${cdpPort}/json`);
        const targets = await res.json();
        const pageTarget = targets.find(t => t.type === 'page') || targets[0];
        if (!pageTarget || !pageTarget.webSocketDebuggerUrl) {
          throw new Error('No page target found');
        }
        runCdpTests(pageTarget.webSocketDebuggerUrl, port, chromeProc, server);
      } catch (e) {
        console.error('Target discovery failed:', e);
      }
    }
  });

  setTimeout(() => {
    if (!cdpPort) {
      console.error('Timed out waiting for Chrome CDP');
      chromeProc.kill();
      server.close();
      process.exit(1);
    }
  }, 5000);
});

async function runCdpTests(wsUrl, port, chromeProc, server) {
  console.log(`[TEST] Connecting to Page CDP at ${wsUrl}`);
  const ws = new globalThis.WebSocket(wsUrl);

  let msgId = 1;
  const pending = new Map();

  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = msgId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.id && pending.has(data.id)) {
      const { resolve, reject } = pending.get(data.id);
      pending.delete(data.id);
      if (data.error) reject(data.error);
      else resolve(data.result);
    }
  };

  ws.onopen = async () => {
    try {
      console.log('[TEST] Page CDP connected. Enabling Page and Runtime...');
      await send('Page.enable');
      await send('Runtime.enable');

      // Navigate to app with demo data
      const url = `http://127.0.0.1:${port}/index.html?demo=1`;
      console.log(`[TEST] Navigating to ${url}...`);
      await send('Page.navigate', { url });

      // Wait for page load
      await new Promise(r => setTimeout(r, 1200));

      const viewports = [
        { name: 'Galaxy S21 (360x780)', width: 360, height: 780, dpr: 3 },
        { name: 'iPhone SE / Mini (375x812)', width: 375, height: 812, dpr: 3 },
        { name: 'iPhone 15 / 16 (393x852)', width: 393, height: 852, dpr: 3 },
        { name: 'Pixel 8 / 9 (412x915)', width: 412, height: 915, dpr: 2.625 }
      ];

      for (const vp of viewports) {
        console.log(`\n--- Testing ${vp.name} ---`);
        await send('Emulation.setDeviceMetricsOverride', {
          width: vp.width,
          height: vp.height,
          deviceScaleFactor: vp.dpr,
          mobile: true
        });

        // Allow layout to settle
        await new Promise(r => setTimeout(r, 300));

        // Test Duty Tab
        const dutyRes = await send('Runtime.evaluate', {
          expression: `(() => {
            const docWidth = document.documentElement.scrollWidth;
            const winWidth = window.innerWidth;
            const ptr = document.getElementById('ptr-indicator');
            const tabIndicator = document.getElementById('tab-sliding-indicator');
            const streak = document.getElementById('hero-streak');
            const indRect = tabIndicator ? tabIndicator.getBoundingClientRect() : null;

            return {
              docWidth,
              winWidth,
              overflow: docWidth > winWidth,
              hasPtr: Boolean(ptr),
              hasIndicator: Boolean(tabIndicator),
              indicatorWidth: indRect ? indRect.width : 0,
              indicatorOpacity: tabIndicator ? window.getComputedStyle(tabIndicator).opacity : 0,
              streakText: streak ? streak.textContent : ''
            };
          })()`,
          returnByValue: true
        });

        const dData = dutyRes.result.value;
        console.log(`  [Duty Tab] Window: ${dData.winWidth}px, ScrollWidth: ${dData.docWidth}px, Overflow: ${dData.overflow}`);
        console.log(`  [Duty Tab] Indicator width: ${dData.indicatorWidth.toFixed(1)}px, Opacity: ${dData.indicatorOpacity}, Streak: "${dData.streakText}"`);

        if (dData.overflow) {
          throw new Error(`CRITICAL OVERFLOW detected on ${vp.name} (Duty Tab)! docWidth=${dData.docWidth} > winWidth=${dData.winWidth}`);
        }
        if (dData.indicatorWidth <= 0) {
          throw new Error(`VisionOS tab indicator has zero width on ${vp.name}!`);
        }

        // Test History Tab
        await send('Runtime.evaluate', { expression: `switchTab('tab-history')` });
        await new Promise(r => setTimeout(r, 200));

        const histRes = await send('Runtime.evaluate', {
          expression: `(() => {
            const docWidth = document.documentElement.scrollWidth;
            const winWidth = window.innerWidth;
            const tabIndicator = document.getElementById('tab-sliding-indicator');
            const indRect = tabIndicator ? tabIndicator.getBoundingClientRect() : null;
            return {
              docWidth,
              winWidth,
              overflow: docWidth > winWidth,
              indicatorLeft: indRect ? indRect.left : 0,
              indicatorWidth: indRect ? indRect.width : 0
            };
          })()`,
          returnByValue: true
        });
        const hData = histRes.result.value;
        console.log(`  [History Tab] ScrollWidth: ${hData.docWidth}px, Overflow: ${hData.overflow}, IndicatorLeft: ${hData.indicatorLeft.toFixed(1)}px`);
        if (hData.overflow) {
          throw new Error(`CRITICAL OVERFLOW detected on ${vp.name} (History Tab)!`);
        }

        // Test Stats Tab
        await send('Runtime.evaluate', { expression: `switchTab('tab-stats')` });
        await new Promise(r => setTimeout(r, 200));

        const statsRes = await send('Runtime.evaluate', {
          expression: `(() => {
            const docWidth = document.documentElement.scrollWidth;
            const winWidth = window.innerWidth;
            const totalBadge = document.getElementById('stat-total-badge');
            const podium = document.getElementById('podium-container');
            return {
              docWidth,
              winWidth,
              overflow: docWidth > winWidth,
              totalBadgeText: totalBadge ? totalBadge.textContent : '',
              hasPodium: Boolean(podium && podium.children.length > 0)
            };
          })()`,
          returnByValue: true
        });
        const sData = statsRes.result.value;
        console.log(`  [Stats Tab] ScrollWidth: ${sData.docWidth}px, Overflow: ${sData.overflow}, Total: "${sData.totalBadgeText}"`);
        if (sData.overflow) {
          throw new Error(`CRITICAL OVERFLOW detected on ${vp.name} (Stats Tab)!`);
        }

        // Switch back to duty
        await send('Runtime.evaluate', { expression: `switchTab('tab-duty')` });
      }

      // Check Gesture Controller instance & SoundEngine
      const fxRes = await send('Runtime.evaluate', {
        expression: `(() => {
          return {
            hasGestureCtrl: Boolean(window.gestureController),
            hasSoundEngine: Boolean(window.soundFx),
            hasCelebration: Boolean(window.celebration),
            hasCrystalMethod: typeof window.soundFx.playCrystalChime === 'function',
            hasSubClickMethod: typeof window.soundFx.playSubClick === 'function'
          };
        })()`,
        returnByValue: true
      });
      console.log('\n[TEST] FX and Controllers Inspection:', fxRes.result.value);

      console.log('\n🎉 ALL MOBILE VIEWPORT & MOTION DESIGN CHECKS PASSED WITH 0 OVERFLOW!');
      ws.close();
      chromeProc.kill();
      server.close();
      process.exit(0);

    } catch (err) {
      console.error('\n❌ TEST FAILED:', err);
      ws.close();
      chromeProc.kill();
      server.close();
      process.exit(1);
    }
  };
}
