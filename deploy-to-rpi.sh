#!/bin/bash
# ========================================================
# Быстрый скрипт для обновления и перезапуска на Raspberry Pi
# ========================================================

RPI_IP="192.168.1.75"
RPI_USER="${1:-ggrk52}"

echo "========================================================"
echo "🚀 Отправка обновления Чистая Тарелка 2.0 на Raspberry Pi ($RPI_USER@$RPI_IP)..."
echo "========================================================"

# Упаковываем все обновленные файлы в один архив
tar -czf /tmp/dish-update.tar.gz index.html app.js style.css sw.js manifest.json server.py server.js

# Копируем архив за одно соединение (пароль вводится всего один раз для scp)
scp /tmp/dish-update.tar.gz "$RPI_USER@$RPI_IP:~/dish-tracker/"

# Распаковываем, обновляем public и перезапускаем службу
echo ""
echo "🔄 Распаковка и перезапуск службы на Raspberry Pi..."
ssh "$RPI_USER@$RPI_IP" "cd ~/dish-tracker && tar -xzf dish-update.tar.gz && mkdir -p public && cp index.html app.js style.css sw.js manifest.json public/ && rm -f dish-update.tar.gz && sudo systemctl restart dish-tracker"

rm -f /tmp/dish-update.tar.gz

echo ""
echo "✅ Обновление успешно установлено на Raspberry Pi 5!"
echo "👉 Адрес: http://$RPI_IP:8080"
echo "========================================================"
