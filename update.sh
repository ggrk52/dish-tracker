#!/usr/bin/env bash
# ========================================================
# Скрипт автоматического обновления с GitHub для Raspberry Pi
# Чистая Тарелка PRO
# ========================================================
set -e

SCRIPT_PATH="${BASH_SOURCE[0]}"
while [ -L "$SCRIPT_PATH" ]; do
  SCRIPT_DIR="$(cd -P "$(dirname "$SCRIPT_PATH")" >/dev/null 2>&1 && pwd)"
  SCRIPT_PATH="$(readlink "$SCRIPT_PATH")"
  [[ "$SCRIPT_PATH" != /* ]] && SCRIPT_PATH="$SCRIPT_DIR/$SCRIPT_PATH"
done
DIR="$(cd -P "$(dirname "$SCRIPT_PATH")" >/dev/null 2>&1 && pwd)"

if [ ! -f "$DIR/server.js" ] && [ -d "/home/ggrk52/dish-tracker" ]; then
  DIR="/home/ggrk52/dish-tracker"
fi

cd "$DIR"

echo "========================================================"
echo "🍽️  ЧИСТАЯ ТАРЕЛКА PRO — Обновление из GitHub"
echo "========================================================"

# 1. Защита реальной базы данных семьи
if [ -f "data.json" ]; then
  TIMESTAMP="$(date +%s)"
  BACKUP_FILE="data.json.bak.$TIMESTAMP"
  cp "data.json" "$BACKUP_FILE"
  cp "data.json" "/tmp/dish_tracker_data_preserve.json"
  echo "🛡️  Создан бэкап базы данных: $BACKUP_FILE"
fi

# 2. Получение свежих обновлений из GitHub
echo "📥 Получение обновлений из GitHub (ветка main)..."
git config --global --add safe.directory "$DIR" 2>/dev/null || true

if [ ! -d ".git" ]; then
  echo "⚙️  Инициализация Git репозитория..."
  git init -b main
  git remote add origin https://github.com/ggrk52/dish-tracker.git || git remote set-url origin https://github.com/ggrk52/dish-tracker.git
fi

git fetch origin main
git reset --hard origin/main

# 3. Восстановление реальных данных семьи
if [ -f "/tmp/dish_tracker_data_preserve.json" ]; then
  cp "/tmp/dish_tracker_data_preserve.json" "data.json"
  rm -f "/tmp/dish_tracker_data_preserve.json"
  echo "✅ База данных семьи data.json надёжно сохранена."
fi

# Сохранение правильного владельца файлов
if id "ggrk52" >/dev/null 2>&1; then
  chown -R ggrk52:ggrk52 "$DIR" 2>/dev/null || true
fi

# 4. Перезапуск службы systemd
echo "🔄 Перезапуск службы dish-tracker..."
if command -v systemctl >/dev/null 2>&1; then
  sudo systemctl restart dish-tracker
  echo "🟢 Статус службы: $(sudo systemctl is-active dish-tracker)"
fi

echo "========================================================"
echo "🎉 Обновление успешно установлено!"
echo "📌 Текущий коммит: $(git log -1 --pretty=format:'%h — %s (%cd)' --date=relative)"
echo "📱 Адрес: http://localhost:8080"
echo "========================================================"
