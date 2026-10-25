FROM python:3.11-alpine

WORKDIR /app

# Копируем файлы проекта
COPY index.html app.js style.css sw.js manifest.json server.py server.js data.json ./
COPY icons/ ./icons/
COPY docs/ ./docs/

# Порт по умолчанию
ENV PORT=8080
EXPOSE 8080

CMD ["python3", "server.py"]
