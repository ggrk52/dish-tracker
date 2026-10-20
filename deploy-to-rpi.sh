#!/bin/bash
# ========================================================
# Быстрый скрипт для обновления и перезапуска на Raspberry Pi
# ========================================================

RPI_IP="192.168.1.75"
RPI_USER="${1:-ggrk52}"

echo "========================================================"
echo "🚀 Отправка обновления Чистая Тарелка 2.0 на Raspberry Pi ($RPI_USER@$RPI_IP)..."
echo "========================================================"

# Копируем основные файлы сервера и веб-интерфейса
scp index.html app.js style.css sw.js manifest.json server.py server.js "$RPI_USER@$RPI_IP:~/dish-tracker/"
ssh "$RPI_USER@$RPI_IP" "mkdir -p ~/dish-tracker/public"
scp index.html app.js style.css sw.js manifest.json "$RPI_USER@$RPI_IP:~/dish-tracker/public/"

echo ""
echo "🔄 Перезапуск службы dish-tracker..."
ssh "$RPI_USER@$RPI_IP" "sudo systemctl restart dish-tracker"

echo ""
echo "✅ Обновление успешно установлено на Raspberry Pi 5!"
echo "👉 Адрес: http://$RPI_IP:8080"
echo "========================================================"
