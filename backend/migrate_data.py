#!/usr/bin/env python3
"""Migrate data from SQLite (db.sqlite3) to Postgres (via Django ORM)."""
import os
import sqlite3

import django
from django.db import connection

os.environ['DJANGO_SETTINGS_MODULE'] = 'intentcad.settings'

django.setup()
SQLITE_PATH = os.path.join(os.path.dirname(__file__), 'db.sqlite3')

# Remap SQLite user IDs to Postgres user IDs (for users that conflicted on unique constraints)
USER_ID_REMAP = {
    '1505a68768464ad3b2325868bae0f119': '73c00cb0-1c9c-4120-8326-b1f86df0cc4d',
}

# Columns that need boolean casting from SQLite int
BOOL_COLUMNS = {'is_active', 'is_superuser', 'is_staff', 'success'}

# Columns that hold user FK references
USER_FK_COLUMNS = {'created_by_id', 'organisation_id', 'user_id'}

# Tables in dependency order (skip users/organisations — already in Postgres)
TABLES = [
    'projects',
    'documents_document',
    'cam_camprofile',
    'cam_camjob',
    'login_logs',
]


def remap_id(col, value):
    """Remap user/org IDs and cast booleans."""
    if value is None:
        return value
    if col in BOOL_COLUMNS and isinstance(value, int):
        return bool(value)
    if col in USER_FK_COLUMNS and isinstance(value, str):
        return USER_ID_REMAP.get(value, value)
    # Also remap any _id column that might reference a user
    if col == 'created_by_id' and isinstance(value, str):
        return USER_ID_REMAP.get(value, value)
    return value


def migrate():
    sq = sqlite3.connect(SQLITE_PATH)
    sq.row_factory = sqlite3.Row
    pg = connection.cursor()

    for table in TABLES:
        rows = sq.execute(f'SELECT * FROM "{table}"').fetchall()
        if not rows:
            print(f'  {table}: 0 rows (skip)')
            continue

        cols = [desc[0] for desc in sq.execute(f'SELECT * FROM "{table}" LIMIT 1').description]
        placeholders = ', '.join(['%s'] * len(cols))
        col_list = ', '.join(f'"{c}"' for c in cols)
        insert_sql = f'INSERT INTO "{table}" ({col_list}) VALUES ({placeholders}) ON CONFLICT DO NOTHING'

        count = 0
        for row in rows:
            values = [remap_id(c, row[c]) for c in cols]
            try:
                pg.execute(insert_sql, values)
                count += 1
            except Exception as e:
                print(f'  {table}: error on {row["id"] if "id" in cols else "?"}: {e}')
                connection.connection.rollback()

        print(f'  {table}: {count}/{len(rows)} rows inserted')

    connection.connection.commit()
    sq.close()
    print('Done!')


if __name__ == '__main__':
    migrate()
