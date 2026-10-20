#!/usr/bin/env python3
# ========================================================
# ЧИСТАЯ ТАРЕЛКА — Сервер на Python 3 для Raspberry Pi
# Система семейных аккаунтов и ролей (Админ: Серёжа)
# ========================================================

import os
import sys
import json
import socket
import hashlib
import copy
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, unquote

PORT = int(os.environ.get("PORT", 8080))
BASE_DIR = os.path.abspath(os.path.dirname(__file__))
DATA_FILE = os.path.join(BASE_DIR, "data.json")

AUTH_SECRET = "family_dish_secret_2026"

# Автоматически заданные логины и пароли для семьи
ACCOUNTS = {
    "serezha": {
        "username": "serezha",
        "password": "5252",
        "name": "Серёжа",
        "role": "admin",
        "avatar": "👦"
    },
    "mama": {
        "username": "mama",
        "password": "1111",
        "name": "Мама",
        "role": "member",
        "avatar": "👩"
    },
    "papa": {
        "username": "papa",
        "password": "2222",
        "name": "Папа",
        "role": "member",
        "avatar": "👨"
    },
    "vasya": {
        "username": "vasya",
        "password": "3333",
        "name": "Вася",
        "role": "member",
        "avatar": "🧒"
    }
}

DEFAULT_STATE = {
  "members": {
    "mama": {"id": "mama", "name": "Мама", "role": "Мама", "avatar": "👩", "color": "#ec4899", "title": "Хранительница очага"},
    "papa": {"id": "papa", "name": "Папа", "role": "Папа", "avatar": "👨", "color": "#0284c7", "title": "Гроза сковородок"},
    "serezha": {"id": "serezha", "name": "Серёжа", "role": "Сын", "avatar": "👦", "color": "#10b981", "title": "Мастер мыльной пены"},
    "vasya": {"id": "vasya", "name": "Вася", "role": "Сын", "avatar": "🧒", "color": "#f59e0b", "title": "Повелитель тарелок"}
  },
  "queue": ["mama", "papa", "serezha", "vasya"],
  "currentQueueIndex": 0,
  "dutyStartedAt": 0,
  "stats": {"mama": 0, "papa": 0, "serezha": 0, "vasya": 0},
  "history": []
}

def generate_token(username):
    acc = ACCOUNTS.get(username)
    if not acc:
        return ""
    data = f"{username}:{acc['password']}:{AUTH_SECRET}".encode("utf-8")
    return hashlib.sha256(data).hexdigest()

def verify_request_auth(headers, body_dict=None):
    user = headers.get("X-Auth-User", "")
    token = headers.get("X-Auth-Token", "")
    if user:
        user = unquote(user)
    if token:
        token = unquote(token)

    if (not user or not token) and isinstance(body_dict, dict):
        user = user or body_dict.get("_authUser", "")
        token = token or body_dict.get("_authToken", "")

    user = (user or "").strip().lower()
    acc = ACCOUNTS.get(user)
    if not acc:
        return None

    # Check sha256 token
    expected_token = generate_token(user)
    if token and token == expected_token:
        return acc

    # Direct password check
    direct_pass = headers.get("X-Auth-Password", "") or (body_dict.get("_authPass", "") if isinstance(body_dict, dict) else "")
    if direct_pass and str(direct_pass).strip() == acc["password"]:
        return acc

    return None

def get_or_create_state():
    if os.path.exists(DATA_FILE):
        try:
            with open(DATA_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
                if isinstance(data, dict) and "queue" in data and "members" in data:
                    return data
        except Exception:
            pass
    try:
        with open(DATA_FILE, "w", encoding="utf-8") as f:
            json.dump(DEFAULT_STATE, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print(f"Error initializing data.json: {e}")
    return copy.deepcopy(DEFAULT_STATE)

def save_state(data):
    try:
        merged = dict(DEFAULT_STATE)
        if isinstance(data, dict):
            merged.update(data)
            if "members" not in data or not data["members"]:
                merged["members"] = DEFAULT_STATE["members"]
        temp_file = DATA_FILE + ".tmp"
        with open(temp_file, "w", encoding="utf-8") as f:
            json.dump(merged, f, ensure_ascii=False, indent=2)
        os.replace(temp_file, DATA_FILE)
    except Exception as e:
        print(f"Error saving data.json: {e}")

class DishDutyHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=BASE_DIR, **kwargs)

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Auth-User, X-Auth-Token, X-Auth-Password, X-Admin-Password, X-Member-Id")
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)

        if parsed.path == "/api/state":
            data = get_or_create_state()
            payload = json.dumps(data, ensure_ascii=False).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return

        if parsed.path in ["", "/"]:
            self.path = "/index.html"

        super().do_GET()

    def do_POST(self):
        parsed = urlparse(self.path)

        # 1. Login Endpoint
        if parsed.path == "/api/login":
            length = int(self.headers.get("Content-Length", 0))
            raw_body = self.rfile.read(length).decode("utf-8")
            try:
                creds = json.loads(raw_body)
                user = (creds.get("username") or "").strip().lower()
                password = str(creds.get("password") or "").strip()

                acc = ACCOUNTS.get(user)
                if acc and acc["password"] == password:
                    token = generate_token(user)
                    res_body = json.dumps({
                        "success": True,
                        "user": {
                            "username": acc["username"],
                            "name": acc["name"],
                            "role": acc["role"],
                            "avatar": acc["avatar"]
                        },
                        "token": token
                    }, ensure_ascii=False).encode("utf-8")
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json; charset=utf-8")
                    self.send_header("Content-Length", str(len(res_body)))
                    self.end_headers()
                    self.wfile.write(res_body)
                    return
                else:
                    err_body = json.dumps({"error": "Неверный пароль. Попробуйте ещё раз"}, ensure_ascii=False).encode("utf-8")
                    self.send_response(401)
                    self.send_header("Content-Type", "application/json; charset=utf-8")
                    self.send_header("Content-Length", str(len(err_body)))
                    self.end_headers()
                    self.wfile.write(err_body)
                    return
            except Exception as e:
                err_body = json.dumps({"error": str(e)}, ensure_ascii=False).encode("utf-8")
                self.send_response(400)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(err_body)))
                self.end_headers()
                self.wfile.write(err_body)
                return

        # 2. State Update Endpoint
        if parsed.path == "/api/state":
            length = int(self.headers.get("Content-Length", 0))
            raw_body = self.rfile.read(length).decode("utf-8")
            try:
                state_data = json.loads(raw_body)
                
                # Check authentication
                acc = verify_request_auth(self.headers, state_data)
                if not acc:
                    err_body = json.dumps({"error": "Требуется авторизация. Пожалуйста, войдите в аккаунт"}, ensure_ascii=False).encode("utf-8")
                    self.send_response(401)
                    self.send_header("Content-Type", "application/json; charset=utf-8")
                    self.send_header("Content-Length", str(len(err_body)))
                    self.end_headers()
                    self.wfile.write(err_body)
                    return

                is_admin = (acc["role"] == "admin")
                auth_user = acc["username"]

                # Non-admin members (Мама, Папа, Вася) have restricted rights
                if not is_admin:
                    curr_state = get_or_create_state()
                    curr_q = curr_state.get("queue", [])
                    curr_idx = curr_state.get("currentQueueIndex", 0)
                    curr_duty_id = curr_q[curr_idx] if curr_q and curr_idx < len(curr_q) else None

                    # 1. Changing queue order requires Admin rights
                    if state_data.get("queue") != curr_q:
                        err_body = json.dumps({"error": "Изменять порядок очереди может только Серёжа (Администратор)"}, ensure_ascii=False).encode("utf-8")
                        self.send_response(403)
                        self.send_header("Content-Type", "application/json; charset=utf-8")
                        self.send_header("Content-Length", str(len(err_body)))
                        self.end_headers()
                        self.wfile.write(err_body)
                        return

                    # 2. Only the current duty member can mark duty as done, react or undo
                    action = state_data.get("_action", "")
                    is_duty_wash = (action in ["wash", "wash_done"] and auth_user and curr_duty_id and auth_user == curr_duty_id)
                    is_reaction = (action == "reaction")
                    is_undo = (action == "undo")

                    if not is_duty_wash and not is_reaction and not is_undo:
                        if action in ["skip", "swap", "reorder", "reset"]:
                            err_msg = "Управлять очередью и настройками может только Серёжа (Администратор)"
                        else:
                            curr_duty_name = curr_state.get("members", {}).get(curr_duty_id, {}).get("name", "дежурного")
                            err_msg = f"Сейчас очередь дежурить: {curr_duty_name}. Отметить помывку может только он(а)"
                        err_body = json.dumps({"error": err_msg}, ensure_ascii=False).encode("utf-8")
                        self.send_response(403)
                        self.send_header("Content-Type", "application/json; charset=utf-8")
                        self.send_header("Content-Length", str(len(err_body)))
                        self.end_headers()
                        self.wfile.write(err_body)
                        return

                # Remove temporary auth fields before persisting
                if isinstance(state_data, dict):
                    state_data.pop("_authUser", None)
                    state_data.pop("_authToken", None)
                    state_data.pop("_authPass", None)
                    state_data.pop("_adminPassword", None)
                    state_data.pop("_memberId", None)
                    state_data.pop("_action", None)

                save_state(state_data)
                res_body = json.dumps({"success": True}).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(res_body)))
                self.end_headers()
                self.wfile.write(res_body)
            except Exception as e:
                err_body = json.dumps({"error": str(e)}, ensure_ascii=False).encode("utf-8")
                self.send_response(400)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(err_body)))
                self.end_headers()
                self.wfile.write(err_body)
            return

        self.send_response(404)
        self.end_headers()

def run():
    get_or_create_state()
    server_address = ("0.0.0.0", PORT)
    httpd = ThreadingHTTPServer(server_address, DishDutyHandler)

    print("\n======================================================")
    print("🍽️   ЧИСТАЯ ТАРЕЛКА — Сервер на Python 3 для Raspberry Pi")
    print("======================================================")
    print(f"📱  Доступно по адресу: http://192.168.1.75:{PORT}")
    print(f"💾  База данных: {DATA_FILE}")
    print("======================================================\n")

    httpd.serve_forever()

if __name__ == "__main__":
    run()
