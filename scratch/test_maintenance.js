const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const flagFile = path.join(__dirname, '../maintenance.flag');
if (fs.existsSync(flagFile)) fs.unlinkSync(flagFile);

const serverProc = spawn('node', [path.join(__dirname, '../server.js')], {
  env: { ...process.env, PORT: '59123' },
  stdio: 'inherit'
});

setTimeout(async () => {
  try {
    console.log('[TEST] Checking normal mode...');
    let res = await fetch('http://127.0.0.1:59123/api/state');
    if (res.status !== 200) throw new Error('Expected 200 in normal mode, got ' + res.status);
    console.log('  ✅ Normal mode /api/state returned 200');

    // Turn ON maintenance mode
    console.log('[TEST] Enabling maintenance mode via flag...');
    fs.writeFileSync(flagFile, 'MAINTENANCE_ACTIVE');

    res = await fetch('http://127.0.0.1:59123/api/state');
    if (res.status !== 503) throw new Error('Expected 503 in maintenance mode, got ' + res.status);
    const data = await res.json();
    if (!data.maintenance) throw new Error('Expected data.maintenance === true');
    console.log('  ✅ Maintenance mode /api/state returned 503 with maintenance: true');

    const pageRes = await fetch('http://127.0.0.1:59123/');
    const pageHtml = await pageRes.text();
    if (!pageHtml.includes('Ведутся техработы')) throw new Error('Expected maintenance.html content');
    console.log('  ✅ Root page / returned maintenance.html content');

    // Turn OFF maintenance mode
    console.log('[TEST] Disabling maintenance mode...');
    fs.unlinkSync(flagFile);

    res = await fetch('http://127.0.0.1:59123/api/state');
    if (res.status !== 200) throw new Error('Expected 200 after maintenance disabled');
    console.log('  ✅ Returned to normal mode 200 OK');

    console.log('\n🎉 ALL MAINTENANCE MODE TESTS PASSED!');
    serverProc.kill();
    process.exit(0);
  } catch (err) {
    console.error('❌ Test failed:', err);
    if (fs.existsSync(flagFile)) fs.unlinkSync(flagFile);
    serverProc.kill();
    process.exit(1);
  }
}, 1200);
