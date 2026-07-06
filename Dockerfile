# Stage 1: Build frontend
FROM node:20-alpine AS frontend
WORKDIR /build
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ .
ENV VITE_API_BASE=/api
RUN npm run build

# Stage 2: Python backend + built frontend
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

# System libs: psycopg2 (libpq5) + OpenCASCADE/OCP runtime deps that build123d
# (cadquery-ocp-novtk) links against — without these `import build123d` fails.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libpq5 \
    libgl1 libglu1-mesa \
    libx11-6 libxext6 libxi6 libxrender1 libxfixes3 libsm6 libice6 \
    libfontconfig1 libfreetype6 libglib2.0-0 libgomp1 \
    && rm -rf /var/lib/apt/lists/*

# Install Python deps
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy backend code
COPY backend/ .

# Copy built frontend
COPY --from=frontend /build/dist /app/frontend_dist

# Copy startup script
COPY start.sh /app/start.sh
RUN chmod +x /app/start.sh

# Create staticfiles dir and collect static files
RUN mkdir -p /app/staticfiles && SECRET_KEY=build-placeholder python manage.py collectstatic --noinput 2>/dev/null || true

EXPOSE 8000
CMD ["/app/start.sh"]
