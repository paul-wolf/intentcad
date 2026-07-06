#!/bin/bash
set -e
cd /app
python manage.py migrate --run-syncdb 2>/dev/null || true
exec gunicorn intentcad.wsgi:application \
    --bind 0.0.0.0:${PORT:-8000} \
    --workers ${WEB_CONCURRENCY:-2} \
    --timeout 300
