FROM node:22-slim AS frontend-build
WORKDIR /build
COPY frontend/package*.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

FROM python:3.12-slim
WORKDIR /app
COPY backend/requirements.lock.txt backend/requirements.lock.txt
RUN pip install --no-cache-dir -r backend/requirements.lock.txt
COPY backend/ backend/
COPY --from=frontend-build /build/dist frontend/dist
ENV ARGON_DATA_DIR=/app/data
ENV ARGON_FRONTEND_DIST=/app/frontend/dist
EXPOSE 8000
CMD ["python", "-m", "uvicorn", "app.main:app", "--app-dir", "backend", "--host", "0.0.0.0", "--port", "8000", "--no-proxy-headers", "--workers", "1", "--limit-concurrency", "32"]
