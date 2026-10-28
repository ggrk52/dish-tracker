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
PUBLIC_DIR = os.path.abspath(os.path.join(BASE_DIR, "public"))
DATA_FILE = os.path.join(BASE_DIR, "data.json")
MAINTENANCE_FILE = os.path.join(BASE_DIR, "maintenance.flag")

AUTH_SECRET = "family_dish_secret_2026"

def get_local_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"

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
    "history": [],
    "debts": [],
    "pendingTakeover": None
}

# --------------------------------------------------------
# In-Memory State & Caching Engine
# --------------------------------------------------------
STATE_LOCK = threading.RLock()
CURRENT_STATE = None
STATE_VERSION = 1
STATE_ETAG = '"v1"'
STATE_JSON_STR = "{}"
STATE_JSON_BYTES = b"{}"
STATE_GZIP_BYTES = b""

STATIC_CACHE = {}
STATIC_CACHE_LOCK = threading.Lock()

def safe_int(val, default=0):
    try:
        if val is None or isinstance(val, bool):
            return default
        return max(0, int(float(val)))
    except (ValueError, TypeError):
        return default

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
        else:
            if "debts" not in loaded or not isinstance(loaded["debts"], list):
                loaded["debts"] = []
            if "pendingTakeover" not in loaded:
                loaded["pendingTakeover"] = None

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

def save_state(data=None):
    global CURRENT_STATE, STATE_VERSION, STATE_ETAG, STATE_JSON_STR, STATE_JSON_BYTES, STATE_GZIP_BYTES
    with STATE_LOCK:
        if data is not None and data is not CURRENT_STATE:
            merged = dict(DEFAULT_STATE)
            if isinstance(data, dict):
                merged.update(data)
                if "members" not in data or not data["members"]:
                    merged["members"] = DEFAULT_STATE["members"]
                if "debts" not in data or not isinstance(data["debts"], list):
                    merged["debts"] = []
                if "pendingTakeover" not in data:
                    merged["pendingTakeover"] = None
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
# Раздача строго из public/ с защитой от Path Traversal
# --------------------------------------------------------
ALLOWED_EXTENSIONS = {
    ".html", ".css", ".js", ".json", ".svg", ".png", ".jpg", ".jpeg", ".webp", ".ico"
}
FORBIDDEN_FILES = {
    "server.py", "server.js", "data.json", "Dockerfile", "docker-compose.yml"
}

def get_static_file_response(rel_path, accept_gzip=False):
    clean_path = unquote(rel_path.split("?")[0].split("#")[0]).lstrip("/")
    if not clean_path or clean_path == "/":
        clean_path = "index.html"

    # Строгая защита от Path Traversal через os.path.commonpath
    abs_path = os.path.abspath(os.path.join(PUBLIC_DIR, clean_path))
    try:
        if os.path.commonpath([PUBLIC_DIR, abs_path]) != PUBLIC_DIR:
            return None
    except ValueError:
        return None

    if not os.path.isfile(abs_path):
        return None

    ext = os.path.splitext(abs_path)[1].lower()
    filename = os.path.basename(abs_path)

    # Белый список расширений и защита исходников
    if ext not in ALLOWED_EXTENSIONS or filename.startswith("."):
        return None
    if ext == ".json" and filename != "manifest.json":
        return None
    if filename in FORBIDDEN_FILES or ext in {".py", ".sh", ".env", ".tmp", ".bak"}:
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
            if len(raw_bytes) > 180 and any(clean_path.endswith(e) for e in [".html", ".js", ".css", ".svg", ".json"]):
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
        super().__init__(*args, directory=PUBLIC_DIR, **kwargs)

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

    def do_HEAD(self):
        self.handle_get(head_only=True)

    def do_GET(self):
        self.handle_get(head_only=False)

    def handle_get(self, head_only=False):
        parsed = urlparse(self.path)

        # 0. Maintenance Mode
        if os.path.exists(MAINTENANCE_FILE):
            if parsed.path.startswith("/api/"):
                payload = json.dumps({"maintenance": True, "error": "Ведутся технические работы. Сервер временно недоступен."}).encode("utf-8")
                self.send_response(503)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Cache-Control", "no-store")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                if not head_only:
                    self.wfile.write(payload)
                return
            if parsed.path in ["/", "/index.html", "/maintenance.html"]:
                m_path = os.path.join(PUBLIC_DIR, "maintenance.html")
                if os.path.exists(m_path):
                    with open(m_path, "rb") as mf:
                        content = mf.read()
                    self.send_response(200)
                    self.send_header("Content-Type", "text/html; charset=utf-8")
                    self.send_header("Cache-Control", "no-store")
                    self.send_header("Content-Length", str(len(content)))
                    self.end_headers()
                    if not head_only:
                        self.wfile.write(content)
                    return

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
            if not head_only:
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
            if not head_only:
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
            if not head_only:
                self.wfile.write(file_resp["payload"])
            return

        # 404
        self.send_response(404)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.end_headers()
        if not head_only:
            self.wfile.write(b"404 Not Found")

    MAX_BODY_SIZE = 10 * 1024 * 1024  # 10 MB maximum payload

    def read_body(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
        except (ValueError, TypeError):
            length = 0
        if length <= 0:
            return ""
        if length > self.MAX_BODY_SIZE:
            raise ValueError(f"Payload too large ({length} bytes > {self.MAX_BODY_SIZE} bytes)")
        body_bytes = bytearray()
        while len(body_bytes) < length:
            chunk = self.rfile.read(min(length - len(body_bytes), 65536))
            if not chunk:
                break
            body_bytes.extend(chunk)
        return body_bytes.decode("utf-8", errors="replace")

    def do_POST(self):
        parsed = urlparse(self.path)

        if os.path.exists(MAINTENANCE_FILE):
            payload = json.dumps({"maintenance": True, "error": "Ведутся технические работы."}).encode("utf-8")
            self.send_response(503)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return

        # 1. Login Endpoint
        if parsed.path == "/api/login":
            try:
                raw_body = self.read_body()
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
                self.send_header("Connection", "close")
                self.send_header("Content-Length", str(len(err_body)))
                self.end_headers()
                self.wfile.write(err_body)
                self.close_connection = True
                return

        # 2. State Update Endpoint
        if parsed.path == "/api/state":
            try:
                raw_body = self.read_body()
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
                action = state_data.get("_action", "")

                with STATE_LOCK:
                    global CURRENT_STATE
                    curr_q = list(CURRENT_STATE.get("queue", []))
                    curr_idx = CURRENT_STATE.get("currentQueueIndex", 0)
                    curr_duty_id = curr_q[curr_idx] if (curr_q and 0 <= curr_idx < len(curr_q)) else None

                    # Гранулярные мутации состояния с защитой от Privilege Escalation
                    if action == "reaction":
                        # Реакции: обновляем ТОЛЬКО реакции для существующей записи истории (монотонно, защищая от race conditions)
                        client_hist = state_data.get("history", [])
                        client_items_by_id = {
                            item.get("id"): item for item in client_hist
                            if isinstance(item, dict) and "id" in item
                        }
                        for hist_item in CURRENT_STATE.get("history", []):
                            hid = hist_item.get("id")
                            if hid in client_items_by_id:
                                c_reactions = client_items_by_id[hid].get("reactions")
                                if isinstance(c_reactions, dict):
                                    existing_r = hist_item.get("reactions") if isinstance(hist_item.get("reactions"), dict) else {}
                                    hist_item["reactions"] = {
                                        r_key: max(
                                            safe_int(existing_r.get(r_key, 0)),
                                            safe_int(c_reactions.get(r_key, 0))
                                        )
                                        for r_key in ["love", "clap", "star"]
                                    }
                        save_state(CURRENT_STATE)

                    elif action in ["wash", "wash_done"]:
                        # Проверка: дежурный или админ
                        is_duty = (curr_duty_id and auth_user == curr_duty_id)
                        if not is_admin and not is_duty:
                            curr_duty_name = CURRENT_STATE.get("members", {}).get(curr_duty_id, {}).get("name", "дежурного")
                            err_body = json.dumps({"error": f"Сейчас очередь дежурить: {curr_duty_name}. Отметить помывку может только он(а)"}, ensure_ascii=False).encode("utf-8")
                            self.send_response(403)
                            self.send_header("Content-Type", "application/json; charset=utf-8")
                            self.send_header("Access-Control-Allow-Origin", "*")
                            self.send_header("Content-Length", str(len(err_body)))
                            self.end_headers()
                            self.wfile.write(err_body)
                            return

                        client_hist = state_data.get("history", [])
                        new_item = client_hist[0] if (isinstance(client_hist, list) and client_hist) else {}

                        if is_admin and new_item.get("memberId") in CURRENT_STATE.get("members", {}):
                            washer = new_item.get("memberId")
                        else:
                            washer = curr_duty_id or auth_user

                        now_ts = int(time.time() * 1000)
                        raw_photo = new_item.get("photo")
                        photo_val = raw_photo if (isinstance(raw_photo, str) and raw_photo.startswith("data:image/")) else None

                        raw_duration = new_item.get("durationMs")
                        duration_ms = safe_int(raw_duration, 0)
                        note_val = str(new_item.get("note") or "").strip()

                        raw_reactions = new_item.get("reactions")
                        history_reactions = {
                            r_key: safe_int(raw_reactions.get(r_key, 0)) if isinstance(raw_reactions, dict) else 0
                            for r_key in ["love", "clap", "star"]
                        }

                        history_entry = {
                            "id": new_item.get("id") or now_ts,
                            "memberId": washer,
                            "timestamp": new_item.get("timestamp") or now_ts,
                            "durationMs": duration_ms,
                            "note": note_val,
                            "photo": photo_val,
                            "reactions": history_reactions
                        }

                        # Атомарный расчет перехода хода
                        if "stats" not in CURRENT_STATE or not isinstance(CURRENT_STATE["stats"], dict):
                            CURRENT_STATE["stats"] = {}
                        CURRENT_STATE["stats"][washer] = CURRENT_STATE["stats"].get(washer, 0) + 1

                        if "history" not in CURRENT_STATE or not isinstance(CURRENT_STATE["history"], list):
                            CURRENT_STATE["history"] = []
                        CURRENT_STATE["history"].insert(0, history_entry)
                        if len(CURRENT_STATE["history"]) > 200:
                            CURRENT_STATE["history"].pop()

                        # Settle debt or sync debts
                        if isinstance(state_data.get("debts"), list):
                            CURRENT_STATE["debts"] = state_data["debts"]
                        else:
                            scheduled_member = curr_q[curr_idx]
                            debts = CURRENT_STATE.get("debts", [])
                            for i, d in enumerate(debts):
                                if d.get("toMemberId") == scheduled_member:
                                    debts.pop(i)
                                    break

                        if "pendingTakeover" in state_data:
                            CURRENT_STATE["pendingTakeover"] = state_data["pendingTakeover"]
                        elif CURRENT_STATE.get("pendingTakeover") and CURRENT_STATE["pendingTakeover"].get("coveredBy") == washer:
                            debts = CURRENT_STATE.setdefault("debts", [])
                            debts.append({
                                "id": int(time.time() * 1000),
                                "fromMemberId": CURRENT_STATE["pendingTakeover"].get("skippedBy"),
                                "toMemberId": washer,
                                "createdAt": int(time.time() * 1000)
                            })
                            CURRENT_STATE["pendingTakeover"] = None

                        if curr_q:
                            CURRENT_STATE["currentQueueIndex"] = (curr_idx + 1) % len(curr_q)
                        CURRENT_STATE["dutyStartedAt"] = now_ts
                        save_state(CURRENT_STATE)

                    elif action == "undo":
                        # Отмена: только админ или тот, кто выполнил последнюю помывку
                        hist = CURRENT_STATE.get("history", [])
                        if not hist:
                            err_body = json.dumps({"error": "Нет записей о помывке для отмены"}, ensure_ascii=False).encode("utf-8")
                            self.send_response(400)
                            self.send_header("Content-Type", "application/json; charset=utf-8")
                            self.send_header("Access-Control-Allow-Origin", "*")
                            self.send_header("Content-Length", str(len(err_body)))
                            self.end_headers()
                            self.wfile.write(err_body)
                            return

                        last_wash = hist[0]
                        last_washer = last_wash.get("memberId")
                        if not is_admin and auth_user != last_washer:
                            err_body = json.dumps({"error": "Отменить помывку может только тот, кто помыл, или Серёжа (Администратор)"}, ensure_ascii=False).encode("utf-8")
                            self.send_response(403)
                            self.send_header("Content-Type", "application/json; charset=utf-8")
                            self.send_header("Access-Control-Allow-Origin", "*")
                            self.send_header("Content-Length", str(len(err_body)))
                            self.end_headers()
                            self.wfile.write(err_body)
                            return

                        CURRENT_STATE["history"].pop(0)
                        if "stats" in CURRENT_STATE and last_washer in CURRENT_STATE["stats"]:
                            CURRENT_STATE["stats"][last_washer] = max(0, CURRENT_STATE["stats"][last_washer] - 1)
                        if curr_q:
                            CURRENT_STATE["currentQueueIndex"] = (curr_idx - 1) % len(curr_q)
                        if CURRENT_STATE.get("history"):
                            CURRENT_STATE["dutyStartedAt"] = CURRENT_STATE["history"][0].get("timestamp", int(time.time() * 1000))
                        else:
                            CURRENT_STATE["dutyStartedAt"] = int(time.time() * 1000)
                        if isinstance(state_data.get("debts"), list):
                            CURRENT_STATE["debts"] = state_data["debts"]
                        if "pendingTakeover" in state_data:
                            CURRENT_STATE["pendingTakeover"] = state_data["pendingTakeover"]
                        save_state(CURRENT_STATE)

                    elif action in ["skip", "swap"]:
                        # Пропуск/обмен: только текущий дежурный или админ
                        is_duty = (curr_duty_id and auth_user == curr_duty_id)
                        if not is_admin and not is_duty:
                            err_body = json.dumps({"error": "Пропустить или передать очередь может только текущий дежурный или Серёжа (Администратор)"}, ensure_ascii=False).encode("utf-8")
                            self.send_response(403)
                            self.send_header("Content-Type", "application/json; charset=utf-8")
                            self.send_header("Access-Control-Allow-Origin", "*")
                            self.send_header("Content-Length", str(len(err_body)))
                            self.end_headers()
                            self.wfile.write(err_body)
                            return

                        if action == "skip":
                            if curr_q:
                                skipped_member = curr_duty_id
                                next_idx = (curr_idx + 1) % len(curr_q)
                                next_member = curr_q[next_idx]
                                if "pendingTakeover" in state_data:
                                    CURRENT_STATE["pendingTakeover"] = state_data["pendingTakeover"]
                                else:
                                    CURRENT_STATE["pendingTakeover"] = {
                                        "skippedBy": skipped_member,
                                        "coveredBy": next_member,
                                        "timestamp": int(time.time() * 1000)
                                    }
                                CURRENT_STATE["currentQueueIndex"] = next_idx
                            if isinstance(state_data.get("debts"), list):
                                CURRENT_STATE["debts"] = state_data["debts"]
                            CURRENT_STATE["dutyStartedAt"] = int(time.time() * 1000)
                            save_state(CURRENT_STATE)
                        elif action == "swap":
                            client_q = state_data.get("queue")
                            if isinstance(client_q, list) and sorted(client_q) == sorted(curr_q):
                                CURRENT_STATE["queue"] = list(client_q)
                                CURRENT_STATE["dutyStartedAt"] = int(time.time() * 1000)
                                save_state(CURRENT_STATE)
                            else:
                                err_body = json.dumps({"error": "Некорректный состав очереди"}, ensure_ascii=False).encode("utf-8")
                                self.send_response(400)
                                self.send_header("Content-Type", "application/json; charset=utf-8")
                                self.send_header("Access-Control-Allow-Origin", "*")
                                self.send_header("Content-Length", str(len(err_body)))
                                self.end_headers()
                                self.wfile.write(err_body)
                                return

                    elif is_admin:
                        # Действия администратора
                        if action == "reset":
                            CURRENT_STATE = copy.deepcopy(DEFAULT_STATE)
                        elif action == "reorder":
                            client_q = state_data.get("queue")
                            if isinstance(client_q, list) and sorted(client_q) == sorted(curr_q):
                                CURRENT_STATE["queue"] = list(client_q)
                            else:
                                err_body = json.dumps({"error": "Некорректная очередь"}, ensure_ascii=False).encode("utf-8")
                                self.send_response(400)
                                self.send_header("Content-Type", "application/json; charset=utf-8")
                                self.send_header("Access-Control-Allow-Origin", "*")
                                self.send_header("Content-Length", str(len(err_body)))
                                self.end_headers()
                                self.wfile.write(err_body)
                                return
                        else:
                            # Полное обновление состояния администратором
                            merged = dict(DEFAULT_STATE)
                            if isinstance(state_data, dict):
                                clean_copy = dict(state_data)
                                for k in ["_authUser", "_authToken", "_authPass", "_adminPassword", "_memberId", "_action"]:
                                    clean_copy.pop(k, None)
                                merged.update(clean_copy)
                                if "members" not in clean_copy or not clean_copy["members"]:
                                    merged["members"] = DEFAULT_STATE["members"]
                            CURRENT_STATE = merged
                        save_state(CURRENT_STATE)

                    else:
                        err_body = json.dumps({"error": "Управлять очередью и настройками может только Серёжа (Администратор)"}, ensure_ascii=False).encode("utf-8")
                        self.send_response(403)
                        self.send_header("Content-Type", "application/json; charset=utf-8")
                        self.send_header("Access-Control-Allow-Origin", "*")
                        self.send_header("Content-Length", str(len(err_body)))
                        self.end_headers()
                        self.wfile.write(err_body)
                        return

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
                self.send_header("Connection", "close")
                self.send_header("Content-Length", str(len(err_body)))
                self.end_headers()
                self.wfile.write(err_body)
                self.close_connection = True
            return

        self.send_response(404)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()

def run():
    init_in_memory_state()
    server_address = ("0.0.0.0", PORT)
    httpd = ThreadingHTTPServer(server_address, DishDutyHandler)
    httpd.daemon_threads = True

    local_ip = get_local_ip()
    print("\n======================================================")
    print("🍽️   ЧИСТАЯ ТАРЕЛКА — Сервер на Python 3 для Raspberry Pi")
    print("⚡  Ultra-Fast: In-Memory + ETag 304 + HTTP/1.1 + Gzip")
    print("======================================================")
    print(f"📱  Доступно по адресу: http://{local_ip}:{PORT}")
    print(f"💻  Локальный адрес:   http://localhost:{PORT}")
    print(f"💾  База данных: {DATA_FILE}")
    print("======================================================\n")

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nОстановка сервера...")
        httpd.server_close()

if __name__ == "__main__":
    run()
