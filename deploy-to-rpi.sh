#!/bin/bash
# ========================================================
# Быстрый скрипт для копирования и запуска на Raspberry Pi
# ========================================================

RPI_IP="192.168.1.75"
RPI_USER="${1:-pi}"

echo "========================================================"
echo "🚀 Отправка проекта на Raspberry Pi 5 ($RPI_USER@$RPI_IP)..."
echo "========================================================"

# Создаем папку на Raspberry Pi и копируем файлы
ssh -o StrictHostKeyChecking=no "$RPI_USER@$RPI_IP" "mkdir -p ~/dish-tracker"
scp -r * "$RPI_USER@$RPI_IP:~/dish-tracker/"

echo ""
echo "✅ Все файлы успешно скопированы на Raspberry Pi!"
echo ""
echo "Для запуска выполните:"
echo "👉 ssh $RPI_USER@$RPI_IP 'cd ~/dish-tracker && node server.js'"
echo ""
echo "Адрес в домашней сети будет:"
echo "👉 http://$RPI_IP:8080"
echo "========================================================"
