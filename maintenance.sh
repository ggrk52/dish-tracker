#!/usr/bin/env bash
# ========================================================
# Управление режимом технических работ (Maintenance Mode)
# Чистая Тарелка PRO
# ========================================================

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

FLAG_FILE="$DIR/maintenance.flag"

case "$1" in
  on)
    touch "$FLAG_FILE"
    echo "========================================================"
    echo "🔧 Режим технических работ ВКЛЮЧЕН!"
    echo "📱 Пользователи видят экран заглушки: /maintenance.html"
    echo "💾 База данных и все API защищены."
    echo "👉 Чтобы отключить: ./maintenance.sh off"
    echo "========================================================"
    ;;
  off)
    rm -f "$FLAG_FILE"
    echo "========================================================"
    echo "✅ Режим технических работ ВЫКЛЮЧЕН!"
    echo "🚀 Сервер 'Чистая Тарелка PRO' работает в штатном режиме."
    echo "========================================================"
    ;;
  status)
    if [ -f "$FLAG_FILE" ]; then
      echo "🔧 Режим техработ: АКТИВЕН (заглушка включена)"
    else
      echo "🟢 Режим техработ: НЕАКТИВЕН (штатный режим)"
    fi
    ;;
  *)
    echo "Использование: $0 {on|off|status}"
    echo "  on     - включить заглушку техработ"
    echo "  off    - отключить заглушку и вернуть обычный режим"
    echo "  status - проверить текущее состояние"
    exit 1
    ;;
esac
