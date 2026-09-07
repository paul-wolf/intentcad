#!/bin/bash
set -e
cd /app
python manage.py migrate --run-syncdb 2>/dev/null || true
# gthread, not the default sync worker: an /edit request is up to two streamed
# LLM calls plus two full CAD builds, which can exceed --timeout. A sync worker
# only heartbeats between requests, so the arbiter SIGABRTs it mid-request for
# merely being slow; gthread heartbeats from a separate thread, so --timeout
# catches genuinely wedged workers instead. Threads serialise on the GIL during
# a build, so keep multiple workers for real build parallelism.
exec gunicorn intentcad.wsgi:application \
    --bind 0.0.0.0:${PORT:-8000} \
    --worker-class gthread \
    --workers ${WEB_CONCURRENCY:-2} \
    --threads ${WEB_THREADS:-4} \
    --timeout 300
