#!/usr/bin/env bash
cd "$(dirname "$0")"
.venv/bin/python manage.py migrate --run-syncdb 2>/dev/null
exec .venv/bin/python manage.py runserver 127.0.0.1:8951
