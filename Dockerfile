FROM python:3.11-alpine

WORKDIR /app

# Создаем непривилегированного пользователя appuser
RUN adduser -D -u 1000 appuser

# Копируем файлы проекта
COPY public/ ./public/
COPY server.py server.js data.json ./
COPY docs/ ./docs/

# Назначаем права пользователю appuser
RUN chown -R appuser:appuser /app

USER appuser

# Порт по умолчанию
ENV PORT=8080
EXPOSE 8080

CMD ["python3", "server.py"]
