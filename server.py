#!/usr/bin/env python3
# ========================================================
# ЧИСТАЯ ТАРЕЛКА — Сервер на Python 3 для Raspberry Pi
# Высокопроизводительный сервер с In-Memory кэшированием,
# ETag 304 Not Modified и Gzip сжатием на лету.
# ========================================================

import os
import sys
import json
import socket
import hashlib
import copy
import gzip
import time
import threading
import mimetypes
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, unquote

PORT = int(os.environ.get("PORT", 8080))
BASE_DIR = os.path.abspath(os.path.dirname(__file__))
DATA_FILE = os.path.join(BASE_DIR, "data.json")

AUTH_SECRET = "family_dish_secret_2026"

# Семейные учетные записи
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

# --------------------------------------------------------
# In-Memory State & Caching Engine
# --------------------------------------------------------
STATE_LOCK = threading.Lock()
CURRENT_STATE = None
STATE_VERSION = 1
STATE_ETAG = '"v1"'
STATE_JSON_STR = "{}"
STATE_JSON_BYTES = b"{}"
STATE_GZIP_BYTES = b""

STATIC_CACHE = {}
STATIC_CACHE_LOCK = threading.Lock()

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

    expected_token = generate_token(user)
    if token and token == expected_token:
        return acc

    direct_pass = headers.get("X-Auth-Password", "") or (body_dict.get("_authPass", "") if isinstance(body_dict, dict) else "")
    if direct_pass and str(direct_pass).strip() == acc["password"]:
        return acc

    return None

def init_in_memory_state():
    global CURRENT_STATE, STATE_VERSION, STATE_ETAG, STATE_JSON_STR, STATE_JSON_BYTES, STATE_GZIP_BYTES
    with STATE_LOCK:
        loaded = None
        if os.path.exists(DATA_FILE):
            try:
                with open(DATA_FILE, "r", encoding="utf-8") as f:
                    loaded = json.load(f)
            except Exception as e:
                print(f"[State] Ошибка чтения {DATA_FILE}: {e}")

        if not (isinstance(loaded, dict) and "queue" in loaded and "members" in loaded):
            loaded = copy.deepcopy(DEFAULT_STATE)
            try:
                with open(DATA_FILE, "w", encoding="utf-8") as f:
                    json.dump(loaded, f, ensure_ascii=False, indent=2)
            except Exception as e:
                print(f"[State] Ошибка записи data.json: {e}")

        CURRENT_STATE = loaded
        STATE_VERSION = int(time.time() * 1000)
        STATE_ETAG = f'"{STATE_VERSION}"'
        STATE_JSON_STR = json.dumps(CURRENT_STATE, ensure_ascii=False)
        STATE_JSON_BYTES = STATE_JSON_STR.encode("utf-8")
        STATE_GZIP_BYTES = gzip.compress(STATE_JSON_BYTES, compresslevel=6)
        print(f"[State] Состояние в памяти готово (версия {STATE_VERSION}, {len(STATE_JSON_BYTES)} байт)")

def get_or_create_state():
    with STATE_LOCK:
        return copy.deepcopy(CURRENT_STATE)

def save_state(data):
    global CURRENT_STATE, STATE_VERSION, STATE_ETAG, STATE_JSON_STR, STATE_JSON_BYTES, STATE_GZIP_BYTES
    with STATE_LOCK:
        merged = dict(DEFAULT_STATE)
        if isinstance(data, dict):
            merged.update(data)
            if "members" not in data or not data["members"]:
                merged["members"] = DEFAULT_STATE["members"]

        CURRENT_STATE = merged
        STATE_VERSION = int(time.time() * 1000)
        STATE_ETAG = f'"{STATE_VERSION}"'
        STATE_JSON_STR = json.dumps(CURRENT_STATE, ensure_ascii=False)
        STATE_JSON_BYTES = STATE_JSON_STR.encode("utf-8")
        STATE_GZIP_BYTES = gzip.compress(STATE_JSON_BYTES, compresslevel=6)

        # Атомарное сохранение на диск
        try:
            temp_file = DATA_FILE + ".tmp"
            with open(temp_file, "w", encoding="utf-8") as f:
                json.dump(CURRENT_STATE, f, ensure_ascii=False, indent=2)
            os.replace(temp_file, DATA_FILE)
        except Exception as e:
            print(f"[State] Ошибка сохранения {DATA_FILE}: {e}")

# --------------------------------------------------------
# Высокоскоростной кэш статических файлов (RAM)
# --------------------------------------------------------
def get_static_file_response(rel_path, accept_gzip=False):
    clean_path = rel_path.lstrip("/")
    if not clean_path or clean_path == "/":
        clean_path = "index.html"

    # Защита от выхода за пределы директории
    abs_path = os.path.abspath(os.path.join(BASE_DIR, clean_path))
    if not abs_path.startswith(BASE_DIR) or not os.path.isfile(abs_path):
        return None

    try:
        stat = os.stat(abs_path)
    except OSError:
        return None

    mtime = stat.st_mtime
    size = stat.st_size
    etag = f'"{int(mtime)}-{size}"'

    with STATIC_CACHE_LOCK:
        cached = STATIC_CACHE.get(abs_path)
        if not cached or cached["mtime"] != mtime:
            mime_type, _ = mimetypes.guess_type(abs_path)
            if not mime_type:
                mime_type = "application/octet-stream"
            if clean_path.endswith(".js"):
                mime_type = "application/javascript; charset=utf-8"
            elif clean_path.endswith(".css"):
                mime_type = "text/css; charset=utf-8"
            elif clean_path.endswith(".html"):
                mime_type = "text/html; charset=utf-8"
            elif clean_path.endswith(".json") or clean_path.endswith(".webmanifest"):
                mime_type = "application/json; charset=utf-8"
            elif clean_path.endswith(".svg"):
                mime_type = "image/svg+xml"

            try:
                with open(abs_path, "rb") as f:
                    raw_bytes = f.read()
            except OSError:
                return None

            gzip_bytes = None
            if len(raw_bytes) > 180 and any(clean_path.endswith(ext) for ext in [".html", ".js", ".css", ".svg", ".json"]):
                gzip_bytes = gzip.compress(raw_bytes, compresslevel=6)

            cached = {
                "mtime": mtime,
                "etag": etag,
                "mime": mime_type,
                "raw": raw_bytes,
                "gzip": gzip_bytes
            }
            STATIC_CACHE[abs_path] = cached

    is_sw = (clean_path == "sw.js")
    cache_control = "no-cache, must-revalidate" if is_sw else "public, max-age=600, must-revalidate"
    use_gzip = accept_gzip and (cached["gzip"] is not None) and (len(cached["gzip"]) < len(cached["raw"]))
    payload = cached["gzip"] if use_gzip else cached["raw"]

    return {
        "status": 200,
        "etag": cached["etag"],
        "mime": cached["mime"],
        "payload": payload,
        "is_gzip": use_gzip,
        "cache_control": cache_control
    }

# --------------------------------------------------------
# HTTP Обработчик запросов
# --------------------------------------------------------
class DishDutyHandler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=BASE_DIR, **kwargs)

    def log_message(self, format, *args):
        # Отключаем спам в консоль
        pass

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Auth-User, X-Auth-Token, X-Auth-Password, X-Admin-Password, X-Member-Id, If-None-Match")
        self.send_header("Access-Control-Max-Age", "86400")
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)

        # 1. API: Состояние (In-Memory + ETag 304 + Gzip)
        if parsed.path == "/api/state":
            with STATE_LOCK:
                current_etag = STATE_ETAG
                raw_payload = STATE_JSON_BYTES
                gzip_payload = STATE_GZIP_BYTES

            req_etag = self.headers.get("If-None-Match", "").strip()
            if req_etag and req_etag == current_etag:
                self.send_response(304)
                self.send_header("ETag", current_etag)
                self.send_header("Cache-Control", "no-cache, must-revalidate")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                return

            accept_gzip = "gzip" in self.headers.get("Accept-Encoding", "")
            use_gzip = accept_gzip and bool(gzip_payload) and (len(gzip_payload) < len(raw_payload))
            payload = gzip_payload if use_gzip else raw_payload

            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("ETag", current_etag)
            self.send_header("Cache-Control", "no-cache, must-revalidate")
            self.send_header("Access-Control-Allow-Origin", "*")
            if use_gzip:
                self.send_header("Content-Encoding", "gzip")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return

        # 2. API: Легковесный опрос версии (30 байт)
        if parsed.path == "/api/version":
            with STATE_LOCK:
                ver_bytes = json.dumps({"version": STATE_VERSION, "etag": STATE_ETAG}).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-cache, must-revalidate")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Content-Length", str(len(ver_bytes)))
            self.end_headers()
            self.wfile.write(ver_bytes)
            return

        # 3. Статические файлы (Gzip + ETag 304 + In-Memory RAM Cache)
        accept_gzip = "gzip" in self.headers.get("Accept-Encoding", "")
        file_resp = get_static_file_response(parsed.path, accept_gzip)
        if file_resp:
            req_etag = self.headers.get("If-None-Match", "").strip()
            if req_etag and req_etag == file_resp["etag"]:
                self.send_response(304)
                self.send_header("ETag", file_resp["etag"])
                self.send_header("Cache-Control", file_resp["cache_control"])
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                return

            self.send_response(200)
            self.send_header("Content-Type", file_resp["mime"])
            self.send_header("ETag", file_resp["etag"])
            self.send_header("Cache-Control", file_resp["cache_control"])
            self.send_header("Access-Control-Allow-Origin", "*")
            if file_resp["is_gzip"]:
                self.send_header("Content-Encoding", "gzip")
            self.send_header("Content-Length", str(len(file_resp["payload"])))
            self.end_headers()
            self.wfile.write(file_resp["payload"])
            return

        # 404
        self.send_response(404)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.end_headers()
        self.wfile.write(b"404 Not Found")

    def read_body(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
        except (ValueError, TypeError):
            length = 0
        if length <= 0:
            return ""
        body_bytes = bytearray()
        while len(body_bytes) < length:
            chunk = self.rfile.read(min(length - len(body_bytes), 65536))
            if not chunk:
                break
            body_bytes.extend(chunk)
        return body_bytes.decode("utf-8", errors="replace")

    def do_POST(self):
        parsed = urlparse(self.path)

        # 1. Login Endpoint
        if parsed.path == "/api/login":
            raw_body = self.read_body()
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
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.send_header("Content-Length", str(len(res_body)))
                    self.end_headers()
                    self.wfile.write(res_body)
                    return
                else:
                    err_body = json.dumps({"error": "Неверный пароль. Попробуйте ещё раз"}, ensure_ascii=False).encode("utf-8")
                    self.send_response(401)
                    self.send_header("Content-Type", "application/json; charset=utf-8")
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.send_header("Content-Length", str(len(err_body)))
                    self.end_headers()
                    self.wfile.write(err_body)
                    return
            except Exception as e:
                err_body = json.dumps({"error": str(e)}, ensure_ascii=False).encode("utf-8")
                self.send_response(400)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Content-Length", str(len(err_body)))
                self.end_headers()
                self.wfile.write(err_body)
                return

        # 2. State Update Endpoint
        if parsed.path == "/api/state":
            raw_body = self.read_body()
            try:
                state_data = json.loads(raw_body)

                # Проверка авторизации
                acc = verify_request_auth(self.headers, state_data)
                if not acc:
                    err_body = json.dumps({"error": "Требуется авторизация. Пожалуйста, войдите в аккаунт"}, ensure_ascii=False).encode("utf-8")
                    self.send_response(401)
                    self.send_header("Content-Type", "application/json; charset=utf-8")
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.send_header("Content-Length", str(len(err_body)))
                    self.end_headers()
                    self.wfile.write(err_body)
                    return

                is_admin = (acc["role"] == "admin")
                auth_user = acc["username"]

                # Проверка прав доступа
                if not is_admin:
                    curr_state = get_or_create_state()
                    curr_q = curr_state.get("queue", [])
                    curr_idx = curr_state.get("currentQueueIndex", 0)
                    curr_duty_id = curr_q[curr_idx] if curr_q and curr_idx < len(curr_q) else None

                    # Изменение очереди разрешено только Админу (Серёже)
                    if state_data.get("queue") != curr_q:
                        err_body = json.dumps({"error": "Изменять порядок очереди может только Серёжа (Администратор)"}, ensure_ascii=False).encode("utf-8")
                        self.send_response(403)
                        self.send_header("Content-Type", "application/json; charset=utf-8")
                        self.send_header("Access-Control-Allow-Origin", "*")
                        self.send_header("Content-Length", str(len(err_body)))
                        self.end_headers()
                        self.wfile.write(err_body)
                        return

                    # Обычные члены семьи могут только подтвердить свою очередь, поставить реакцию или отменить
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
                        self.send_header("Access-Control-Allow-Origin", "*")
                        self.send_header("Content-Length", str(len(err_body)))
                        self.end_headers()
                        self.wfile.write(err_body)
                        return

                # Удаляем служебные поля авторизации перед сохранением
                if isinstance(state_data, dict):
                    state_data.pop("_authUser", None)
                    state_data.pop("_authToken", None)
                    state_data.pop("_authPass", None)
                    state_data.pop("_adminPassword", None)
                    state_data.pop("_memberId", None)
                    state_data.pop("_action", None)

                save_state(state_data)

                with STATE_LOCK:
                    current_etag = STATE_ETAG

                res_body = json.dumps({"success": True, "etag": current_etag}).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Content-Length", str(len(res_body)))
                self.end_headers()
                self.wfile.write(res_body)
            except Exception as e:
                err_body = json.dumps({"error": str(e)}, ensure_ascii=False).encode("utf-8")
                self.send_response(400)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Content-Length", str(len(err_body)))
                self.end_headers()
                self.wfile.write(err_body)
            return

        self.send_response(404)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()

def run():
    init_in_memory_state()
    server_address = ("0.0.0.0", PORT)
    httpd = ThreadingHTTPServer(server_address, DishDutyHandler)
    httpd.daemon_threads = True

    print("\n======================================================")
    print("🍽️   ЧИСТАЯ ТАРЕЛКА — Сервер на Python 3 для Raspberry Pi")
    print("⚡  Ultra-Fast: In-Memory + ETag 304 + HTTP/1.1 + Gzip")
    print("======================================================")
    print(f"📱  Доступно по адресу: http://192.168.1.75:{PORT}")
    print(f"💾  База данных: {DATA_FILE}")
    print("======================================================\n")

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nОстановка сервера...")
        httpd.server_close()

if __name__ == "__main__":
    run()
