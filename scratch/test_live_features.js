const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

async function testLiveFeatures() {
  console.log('[TEST] Verifying live wash timer and ping actions in Node.js server...');

  const testPort = 59199;
  const serverPath = path.join(__dirname, '..', 'server.js');
  const env = { ...process.env, PORT: testPort };
  const srv = spawn('node', [serverPath], { env });

  await new Promise(r => setTimeout(r, 1200));

  function request(method, path, body, auth) {
    return new Promise((resolve, reject) => {
      const data = body ? JSON.stringify(body) : '';
      const headers = {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      };
      if (auth) {
        headers['x-auth-user'] = auth.user;
        headers['x-auth-token'] = auth.token;
      }
      const req = http.request({
        hostname: '127.0.0.1',
        port: testPort,
        path,
        method,
        headers
      }, (res) => {
        let buf = '';
        res.on('data', d => buf += d);
        res.on('end', () => resolve({ status: res.statusCode, data: buf ? JSON.parse(buf) : null }));
      });
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
  }

  try {
    // 1. Login as vasya to get token
    const loginRes = await request('POST', '/api/login', { username: 'vasya', password: '3333' });
    if (!loginRes.data || !loginRes.data.token) {
      throw new Error('Login failed: ' + JSON.stringify(loginRes));
    }
    const auth = { user: 'vasya', token: loginRes.data.token };
    console.log('  ✅ Logged in as Vasya, token received');

    // 2. Start wash timer
    const startWashRes = await request('POST', '/api/state', {
      _action: 'start_wash',
      memberId: 'vasya'
    }, auth);
    if (startWashRes.status !== 200 || !startWashRes.data.success) {
      throw new Error('start_wash failed: ' + JSON.stringify(startWashRes));
    }
    const stateAfterStart = await request('GET', '/api/state');
    if (!stateAfterStart.data.activeWash || stateAfterStart.data.activeWash.memberId !== 'vasya') {
      throw new Error('activeWash state not reflected: ' + JSON.stringify(stateAfterStart));
    }
    console.log('  ✅ action start_wash successfully set activeWash for vasya');

    // 3. Ping duty
    const pingRes = await request('POST', '/api/state', {
      _action: 'ping',
      memberId: 'vasya',
      targetMemberId: 'vasya'
    }, auth);
    if (pingRes.status !== 200 || !pingRes.data.success) {
      throw new Error('ping failed: ' + JSON.stringify(pingRes));
    }
    const stateAfterPing = await request('GET', '/api/state');
    if (!stateAfterPing.data.activePing || stateAfterPing.data.activePing.from !== 'vasya') {
      throw new Error('activePing state not reflected: ' + JSON.stringify(stateAfterPing));
    }
    console.log('  ✅ action ping successfully broadcasted activePing');

    // 4. Cancel wash
    const cancelRes = await request('POST', '/api/state', {
      _action: 'cancel_wash',
      memberId: 'vasya'
    }, auth);
    if (cancelRes.status !== 200 || !cancelRes.data.success) {
      throw new Error('cancel_wash failed: ' + JSON.stringify(cancelRes));
    }
    const stateAfterCancel = await request('GET', '/api/state');
    if (stateAfterCancel.data.activeWash !== null && stateAfterCancel.data.activeWash !== undefined) {
      throw new Error('activeWash not cleared: ' + JSON.stringify(stateAfterCancel));
    }
    console.log('  ✅ action cancel_wash cleared activeWash');

    console.log('🎉 ALL LIVE FEATURE TESTS PASSED!');
  } finally {
    srv.kill('SIGTERM');
  }
}

testLiveFeatures().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
