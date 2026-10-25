#!/usr/bin/env python3
"""
Test suite for Photo Proof of Cleanliness (📸 Фото-подтверждение чистоты)
Verifies:
1. Server authentication & token generation
2. Robust reading of large Content-Length bodies (compressed photo payload ~40-60 KB)
3. Preserving photo data URL in state.history
4. ETag caching and 304 handling with photo payloads
5. Safe teardown and state restoration
"""

import os
import sys
import json
import time
import base64
import socket
import urllib.request
import urllib.error
import subprocess

REPO_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
DATA_FILE = os.path.join(REPO_DIR, "data.json")

def find_free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(('', 0))
        return s.getsockname()[1]

def make_test_photo(size_kb=45):
    # Create a realistic base64 data URL payload of roughly size_kb kilobytes
    # 1 KB = 1024 bytes -> ~1365 base64 characters
    raw_data = b"CleanSinkPhotoProof2026!*" * (size_kb * 40)
    b64_str = base64.b64encode(raw_data).decode('ascii')
    return f"data:image/webp;base64,{b64_str}"

def run_tests():
    port = find_free_port()
    base_url = f"http://127.0.0.1:{port}"
    print(f"[TEST] Starting test server on {base_url}...")

    # Backup data.json if exists
    data_backup = None
    if os.path.exists(DATA_FILE):
        with open(DATA_FILE, "r", encoding="utf-8") as f:
            data_backup = f.read()

    env = os.environ.copy()
    env["PORT"] = str(port)

    server_proc = subprocess.Popen(
        [sys.executable, os.path.join(REPO_DIR, "server.py")],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE
    )

    try:
        # Wait for server to start
        connected = False
        for _ in range(30):
            try:
                urllib.request.urlopen(f"{base_url}/api/version", timeout=1)
                connected = True
                break
            except Exception:
                time.sleep(0.1)

        if not connected:
            raise RuntimeError("Failed to connect to test server!")
        print("[TEST] Server connected successfully.")

        # 1. Login as admin (serezha)
        login_payload = json.dumps({"username": "serezha", "password": "5252"}).encode("utf-8")
        req = urllib.request.Request(
            f"{base_url}/api/login",
            data=login_payload,
            headers={"Content-Type": "application/json"}
        )
        with urllib.request.urlopen(req) as resp:
            assert resp.status == 200, f"Login failed: status {resp.status}"
            login_data = json.loads(resp.read().decode("utf-8"))
            token = login_data.get("token")
            assert token, "Token missing in login response!"
            print(f"[TEST] Admin login passed. Token: {token[:12]}...")

        # 2. Get current state
        req = urllib.request.Request(f"{base_url}/api/state")
        with urllib.request.urlopen(req) as resp:
            assert resp.status == 200
            initial_state = json.loads(resp.read().decode("utf-8"))
            etag = resp.headers.get("ETag")
            print(f"[TEST] Initial state fetched. ETag: {etag}")

        # 3. Create simulated photo payload (~45 KB)
        photo_data_url = make_test_photo(size_kb=45)
        photo_bytes_len = len(photo_data_url.encode("utf-8"))
        print(f"[TEST] Generated sample photo payload: {photo_bytes_len} bytes (~{photo_bytes_len // 1024} KB)")

        # 4. Perform a wash with photo attachment
        test_history_item = {
            "id": int(time.time() * 1000),
            "memberId": "serezha",
            "timestamp": int(time.time() * 1000),
            "durationMs": 180000,
            "note": "Блестит до скрипа ✨ Тестовая раковина",
            "photo": photo_data_url,
            "reactions": {"love": 1, "clap": 2, "star": 3}
        }

        updated_state = dict(initial_state)
        updated_history = [test_history_item] + list(initial_state.get("history", []))
        updated_state["history"] = updated_history
        updated_state["_authUser"] = "serezha"
        updated_state["_authToken"] = token
        updated_state["_action"] = "wash"

        state_bytes = json.dumps(updated_state, ensure_ascii=False).encode("utf-8")
        print(f"[TEST] Sending POST /api/state with Content-Length: {len(state_bytes)} bytes...")

        req = urllib.request.Request(
            f"{base_url}/api/state",
            data=state_bytes,
            headers={
                "Content-Type": "application/json",
                "X-Auth-User": "serezha",
                "X-Auth-Token": token
            }
        )
        with urllib.request.urlopen(req) as resp:
            assert resp.status == 200, f"State update failed: {resp.status}"
            res_json = json.loads(resp.read().decode("utf-8"))
            assert res_json.get("success") is True, "Response does not indicate success"
            new_etag = res_json.get("etag")
            print(f"[TEST] State update succeeded! New ETag: {new_etag}")

        # 5. Fetch updated state and assert photo integrity
        req = urllib.request.Request(f"{base_url}/api/state")
        with urllib.request.urlopen(req) as resp:
            assert resp.status == 200
            fetched_state = json.loads(resp.read().decode("utf-8"))
            fetched_history = fetched_state.get("history", [])
            assert len(fetched_history) > 0, "History is empty!"
            latest_wash = fetched_history[0]
            assert latest_wash.get("photo") == photo_data_url, "Photo data URL corrupted or truncated!"
            assert latest_wash.get("note") == "Блестит до скрипа ✨ Тестовая раковина"
            print(f"[TEST] Photo verification PASSED! Exact match of {len(photo_data_url)} chars.")

        # 6. Test ETag 304 Not Modified
        req = urllib.request.Request(
            f"{base_url}/api/state",
            headers={"If-None-Match": new_etag}
        )
        try:
            with urllib.request.urlopen(req) as resp:
                assert resp.status == 304, f"Expected 304, got {resp.status}"
        except urllib.error.HTTPError as e:
            assert e.code == 304, f"Expected 304 Not Modified, got {e.code}"
        print("[TEST] 304 Not Modified cache check PASSED.")

        print("\n🎉 ALL TESTS PASSED SUCCESSFULLY! Photo wash payload operates smoothly.")

    finally:
        # Terminate test server
        server_proc.terminate()
        try:
            server_proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            server_proc.kill()

        # Restore data.json
        if data_backup is not None:
            with open(DATA_FILE, "w", encoding="utf-8") as f:
                f.write(data_backup)
            print("[TEST] Restored original data.json.")

if __name__ == "__main__":
    run_tests()
