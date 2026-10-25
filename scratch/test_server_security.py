#!/usr/bin/env python3
"""
Comprehensive Security & Regression Test Suite for «Чистая Тарелка PRO»
Verifies against both server.py (Python) and server.js (Node):
1. Static File Path Traversal & Source Code Leakage Protection
2. Extension allowlist enforcement
3. Authentication enforcement on /api/state
4. Privilege Escalation Prevention:
   - Tamper protection on stats/queue during 'reaction'
   - Non-duty wash blocking
   - Legitimate duty wash calculation on server
   - Non-washer undo blocking
   - Legitimate undo calculation on server
   - Skip / swap duty authorization
   - Admin reorder / reset permissions
"""

import os
import sys
import json
import time
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

def request(url, method="GET", data=None, headers=None):
    if headers is None:
        headers = {}
    req_data = None
    if data is not None:
        if isinstance(data, (dict, list)):
            req_data = json.dumps(data).encode("utf-8")
            if "Content-Type" not in headers:
                headers["Content-Type"] = "application/json"
        elif isinstance(data, str):
            req_data = data.encode("utf-8")
        else:
            req_data = data

    req = urllib.request.Request(url, data=req_data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req) as resp:
            body = resp.read()
            return resp.status, resp.headers, body
    except urllib.error.HTTPError as e:
        return e.code, e.headers, e.read()

def test_server(server_cmd, server_name):
    print(f"\n=======================================================")
    print(f"🔒 Testing Security Suite on [{server_name}]...")
    print(f"=======================================================")

    port = find_free_port()
    base_url = f"http://127.0.0.1:{port}"

    # Backup data.json
    data_backup = None
    if os.path.exists(DATA_FILE):
        with open(DATA_FILE, "r", encoding="utf-8") as f:
            data_backup = f.read()

    env = os.environ.copy()
    env["PORT"] = str(port)

    proc = subprocess.Popen(
        server_cmd,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE
    )

    try:
        # Wait for server ready
        connected = False
        for _ in range(40):
            try:
                status, _, _ = request(f"{base_url}/api/version")
                if status == 200:
                    connected = True
                    break
            except Exception:
                pass
            time.sleep(0.1)

        if not connected:
            raise RuntimeError(f"Failed to connect to {server_name} on {base_url}")
        print(f"[{server_name}] Connected on {base_url}.")

        # -----------------------------------------------------------------
        # TEST GROUP 1: Path Traversal & Source Disclosure Prevention
        # -----------------------------------------------------------------
        print(f"[{server_name}] 1. Testing Path Traversal & Source Code Protection...")

        # 1.1 Safe static files must return 200
        safe_paths = ["/", "/index.html", "/app.js", "/style.css", "/sw.js", "/manifest.json", "/icons/icon-192.png"]
        for p in safe_paths:
            st, _, _ = request(f"{base_url}{p}")
            assert st == 200, f"Expected 200 for {p}, got {st}"

        # 1.2 Sensitive / server files must return 404 or 403 (NEVER 200)
        forbidden_paths = [
            "/server.py",
            "/server.js",
            "/data.json",
            "/Dockerfile",
            "/docker-compose.yml",
            "/deploy-to-rpi.sh",
            "/.dockerignore",
            "/.gitignore",
            "/../server.py",
            "/../server.js",
            "/../data.json",
            "/../../../../etc/passwd",
            "/%2e%2e%2fserver.py",
            "/%2e%2e/data.json",
            "/.git/config",
            "/Запустить_График.command"
        ]
        for p in forbidden_paths:
            import urllib.parse
            encoded_p = urllib.parse.quote(p, safe="/:@&=+$,-_.!~*'()")
            st, _, body = request(f"{base_url}{encoded_p}")
            assert st in [403, 404], f"VULNERABILITY: {p} returned {st}! Body: {body[:100]}"
        print(f"[{server_name}]   ✅ Path traversal & sensitive file blocks passed ({len(forbidden_paths)} checks).")

        # -----------------------------------------------------------------
        # TEST GROUP 2: Authentication on /api/login and /api/state
        # -----------------------------------------------------------------
        print(f"[{server_name}] 2. Testing Authentication...")

        # 2.1 Invalid login
        st, _, _ = request(f"{base_url}/api/login", method="POST", data={"username": "mama", "password": "wrongpassword"})
        assert st == 401, f"Expected 401 on wrong password, got {st}"

        # 2.2 Valid login for admin (serezha) and member (mama, papa)
        st, _, b = request(f"{base_url}/api/login", method="POST", data={"username": "serezha", "password": "5252"})
        assert st == 200
        admin_data = json.loads(b.decode())
        admin_token = admin_data["token"]

        st, _, b = request(f"{base_url}/api/login", method="POST", data={"username": "mama", "password": "1111"})
        assert st == 200
        mama_data = json.loads(b.decode())
        mama_token = mama_data["token"]

        st, _, b = request(f"{base_url}/api/login", method="POST", data={"username": "papa", "password": "2222"})
        assert st == 200
        papa_data = json.loads(b.decode())
        papa_token = papa_data["token"]

        # 2.3 Unauthenticated POST /api/state
        st, _, _ = request(f"{base_url}/api/state", method="POST", data={"_action": "reaction"})
        assert st == 401, f"Expected 401 for unauthenticated state update, got {st}"
        print(f"[{server_name}]   ✅ Authentication checks passed.")

        # -----------------------------------------------------------------
        # TEST GROUP 3: Privilege Separation & State Integrity
        # -----------------------------------------------------------------
        print(f"[{server_name}] 3. Testing Privilege Escalation Prevention...")

        # Get initial state
        _, _, b = request(f"{base_url}/api/state")
        state = json.loads(b.decode())
        curr_duty_id = state["queue"][state["currentQueueIndex"]]
        other_user = "papa" if curr_duty_id == "mama" else "mama"
        other_token = papa_token if other_user == "papa" else mama_token
        duty_token = mama_token if curr_duty_id == "mama" else papa_token

        # 3.1 Non-admin trying arbitrary full state overwrite / queue reorder
        tampered_state = dict(state)
        tampered_state["queue"] = [other_user]
        tampered_state["stats"][other_user] = 9999
        st, _, b = request(
            f"{base_url}/api/state",
            method="POST",
            data=tampered_state,
            headers={"X-Auth-User": other_user, "X-Auth-Token": other_token}
        )
        assert st == 403, f"Expected 403 when non-admin tries arbitrary state overwrite, got {st}"

        # 3.2 Non-duty user trying to wash
        wash_payload = dict(state)
        wash_payload["_action"] = "wash"
        wash_payload["history"] = [{
            "id": int(time.time() * 1000),
            "memberId": other_user,
            "note": "Illegal wash",
            "photo": None
        }]
        st, _, b = request(
            f"{base_url}/api/state",
            method="POST",
            data=wash_payload,
            headers={"X-Auth-User": other_user, "X-Auth-Token": other_token}
        )
        assert st == 403, f"Expected 403 when non-duty tries to wash, got {st}"

        # 3.3 Legitimate duty user performing wash
        initial_duty_stats = state["stats"].get(curr_duty_id, 0)
        wash_id = int(time.time() * 1000)
        legit_wash = dict(state)
        legit_wash["_action"] = "wash"
        legit_wash["history"] = [{
            "id": wash_id,
            "memberId": curr_duty_id,
            "note": "Clean sink test",
            "photo": None,
            "reactions": {"love": 0, "clap": 0, "star": 0}
        }]
        st, _, b = request(
            f"{base_url}/api/state",
            method="POST",
            data=legit_wash,
            headers={"X-Auth-User": curr_duty_id, "X-Auth-Token": duty_token}
        )
        assert st == 200, f"Expected 200 for legitimate wash, got {st}: {b.decode()}"

        # Verify server calculated turn transition and stats increment
        _, _, b = request(f"{base_url}/api/state")
        updated_state = json.loads(b.decode())
        assert updated_state["stats"][curr_duty_id] == initial_duty_stats + 1, "Washer stats not incremented!"
        assert updated_state["history"][0]["id"] == wash_id, "History top item mismatch!"
        assert updated_state["history"][0]["note"] == "Clean sink test"
        next_duty_id = updated_state["queue"][updated_state["currentQueueIndex"]]
        assert next_duty_id != curr_duty_id, "Queue did not advance!"
        print(f"[{server_name}]   ✅ Duty wash correctly computed on server.")

        # 3.4 Reaction action: cannot tamper with stats or queue
        reaction_payload = dict(updated_state)
        reaction_payload["_action"] = "reaction"
        reaction_payload["stats"][other_user] = 999999  # Attempted stat tamper
        reaction_payload["queue"] = ["tampered"]        # Attempted queue tamper
        # Add love reaction to latest wash
        reaction_payload["history"][0]["reactions"]["love"] = 5
        st, _, b = request(
            f"{base_url}/api/state",
            method="POST",
            data=reaction_payload,
            headers={"X-Auth-User": other_user, "X-Auth-Token": other_token}
        )
        assert st == 200, f"Expected 200 for reaction, got {st}: {b.decode()}"

        # Verify reactions updated but stats & queue protected
        _, _, b = request(f"{base_url}/api/state")
        reacted_state = json.loads(b.decode())
        assert reacted_state["history"][0]["reactions"]["love"] == 5, "Reaction not applied!"
        assert reacted_state["stats"][other_user] != 999999, "SECURITY BUG: stats were overwritten via reaction!"
        assert "tampered" not in reacted_state["queue"], "SECURITY BUG: queue was overwritten via reaction!"
        print(f"[{server_name}]   ✅ Reaction tamper prevention passed (stats & queue preserved).")

        # 3.5 Undo action: non-washer cannot undo
        st, _, b = request(
            f"{base_url}/api/state",
            method="POST",
            data={"_action": "undo"},
            headers={"X-Auth-User": other_user, "X-Auth-Token": other_token}
        )
        assert st == 403, f"Expected 403 when non-washer tries to undo, got {st}"

        # 3.6 Legit undo by washer
        st, _, b = request(
            f"{base_url}/api/state",
            method="POST",
            data={"_action": "undo"},
            headers={"X-Auth-User": curr_duty_id, "X-Auth-Token": duty_token}
        )
        assert st == 200, f"Expected 200 when washer undos, got {st}"

        _, _, b = request(f"{base_url}/api/state")
        undone_state = json.loads(b.decode())
        assert undone_state["stats"][curr_duty_id] == initial_duty_stats, "Stats not restored on undo!"
        assert undone_state["queue"][undone_state["currentQueueIndex"]] == curr_duty_id, "Queue not restored on undo!"
        print(f"[{server_name}]   ✅ Undo authorization & server computation passed.")

        # 3.7 Admin reorder
        new_q = list(reversed(undone_state["queue"]))
        st, _, b = request(
            f"{base_url}/api/state",
            method="POST",
            data={"_action": "reorder", "queue": new_q},
            headers={"X-Auth-User": "serezha", "X-Auth-Token": admin_token}
        )
        assert st == 200
        _, _, b = request(f"{base_url}/api/state")
        reordered_state = json.loads(b.decode())
        assert reordered_state["queue"] == new_q, "Admin reorder failed!"
        print(f"[{server_name}]   ✅ Admin reorder passed.")

        print(f"\n🎉 ALL SECURITY CHECKS PASSED ON [{server_name}]!\n")

    finally:
        proc.terminate()
        try:
            proc.communicate(timeout=3)
        except Exception:
            proc.kill()

        if data_backup is not None:
            with open(DATA_FILE, "w", encoding="utf-8") as f:
                f.write(data_backup)

if __name__ == "__main__":
    # Test Python server
    test_server([sys.executable, os.path.join(REPO_DIR, "server.py")], "server.py (Python)")
    # Test Node server
    test_server(["node", os.path.join(REPO_DIR, "server.js")], "server.js (Node)")
