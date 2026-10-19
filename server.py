#!/usr/bin/env python3
# ========================================================
# ЧИСТАЯ ТАРЕЛКА — Сервер на Python 3 для Raspberry Pi
# ========================================================

import os
import sys
import json
import socket
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

PORT = int(os.environ.get("PORT", 8080))
BASE_DIR = os.path.abspath(os.path.dirname(__file__))
DATA_FILE = os.path.join(BASE_DIR, "data.json")

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

def get_or_create_state():
    if os.path.exists(DATA_FILE):
        try:
            with open(DATA_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
                if data and "queue" in data:
                    return data
        except Exception:
            pass
    # Initialize file
    try:
        with open(DATA_FILE, "w", encoding="utf-8") as f:
            json.dump(DEFAULT_STATE, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print(f"Error initializing data.json: {e}")
    return DEFAULT_STATE

def save_state(data):
    try:
        with open(DATA_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print(f"Error saving data.json: {e}")

class DishDutyHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=BASE_DIR, **kwargs)

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
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

        if parsed.path == "/api/state":
            length = int(self.headers.get("Content-Length", 0))
            raw_body = self.rfile.read(length).decode("utf-8")
            try:
                state_data = json.loads(raw_body)
                
                # Check admin password
                auth_pass = self.headers.get("X-Admin-Password", "")
                if auth_pass:
                    from urllib.parse import unquote
                    auth_pass = unquote(auth_pass)
                if not auth_pass and isinstance(state_data, dict):
                    auth_pass = state_data.get("_adminPassword", "")

                clean_pass = (auth_pass or "").strip().lower().replace("ё", "е")
                if clean_pass not in ["525252", "мамамолодец"]:
                    err_body = json.dumps({"error": "Требуется PIN-код администратора ('525252')"}).encode("utf-8")
                    self.send_response(403)
                    self.send_header("Content-Type", "application/json; charset=utf-8")
                    self.send_header("Content-Length", str(len(err_body)))
                    self.end_headers()
                    self.wfile.write(err_body)
                    return

                # Remove temporary auth field before persisting
                if isinstance(state_data, dict) and "_adminPassword" in state_data:
                    del state_data["_adminPassword"]

                save_state(state_data)
                res_body = json.dumps({"success": True}).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(res_body)))
                self.end_headers()
                self.wfile.write(res_body)
            except Exception as e:
                err_body = json.dumps({"error": str(e)}).encode("utf-8")
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
    print("🍽️   ЧИСТАЯ ТАРЕЛКА — Сервер на Raspberry Pi (Python 3)")
    print("======================================================")
    print(f"📱  Доступно по адресу: http://192.168.1.75:{PORT}")
    print(f"💾  База данных: {DATA_FILE}")
    print("======================================================\n")

    httpd.serve_forever()

if __name__ == "__main__":
    run()
