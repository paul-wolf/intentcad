# IntentCAD: project rules

## Every user-visible feature keeps the guide current

A branch that adds or changes a user-visible feature also, in the same branch:

1. Updates `docs/guide/README.md`: the right section, in the same plain style (what it's
   for, how to invoke it from the UI, short sentences).
2. Retakes or adds its screenshot in `docs/guide/images/`, from a part in the
   "Guide examples" project (1600×1000 viewport, light theme, no dev overlays, the
   relevant panel open, PNG of at most ~300 KB).
3. Ticks the item in `docs/feature-plan.md` (the Done list, the tier table, the Order line).

## Conventions

- One branch per feature. Don't merge until the user has reviewed it. Don't push
  without asking.
- Use SQLite: run the backend with `DB_HOST` empty (`backend/db.sqlite3`). Don't touch
  Postgres.
- Don't use or restart the user's own servers on ports 8951 and 5951; run test servers on
  other ports.
- Never commit `tmp/` files (e.g. `tmp/drone-pi-carrier.pdf`); use them only as context
  files in the app.
- Stage files explicitly (`git add <paths>`), not `git add -A`.
- Checks before committing:
  - frontend: `cd frontend && npx tsc --noEmit -p . && npx vitest run`
  - backend: `cd backend && DB_HOST= .venv/bin/python manage.py test modeling accounts`
