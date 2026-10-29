# IntentCAD

**Parametric CAD for 3D printing, driven by AI, with exact geometry you can still point at, measure and tweak.**

IntentCAD is a web-based CAD tool for designing functional parts: enclosures, brackets,
mounts, knobs, adapters. You describe what you want, the AI builds it as an exact,
parametric model, and you refine it with the same tools you'd find in Fusion or Onshape
(sketches, extrudes, fillets, holes, patterns) whenever pointing is easier than describing.

![The part editor: a board case with the parameters, the AI chat and the 3D view](docs/guide/images/overview.png)

- [User guide](docs/guide/README.md): how to use the app, feature by feature
- [Feature plan](docs/feature-plan.md): what's done and what's next
- [Iteration 1 spec](docs/iteration-1-spec.md): the original 2D sketcher spec, kept for reference

## Running locally

You need Python 3.12 and Node.js 20 or later.

### Backend

```sh
cd backend
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
./run.sh
```

`run.sh` migrates and serves the API at `http://127.0.0.1:8951/api`. With `DB_HOST`
unset it uses SQLite (`backend/db.sqlite3`); set `DB_HOST` (and `DB_NAME`, `DB_USER`,
`DB_PASSWORD`, `DB_PORT`) to use PostgreSQL instead. Settings can also go in
`backend/.env`.

The AI needs an Anthropic API key in the backend's environment: `ANTHROPIC_API_KEY`
(or `ANTHROPIC_KEY`).

### Frontend

```sh
cd frontend
npm install
npm run dev
```

Open `http://localhost:5951`. The frontend calls the API at `http://localhost:8951/api`;
set `VITE_API_BASE` to point it elsewhere.

### A test user

For trying the app on a second, test server (UI checks, the guide's screenshots), seed
the test user into its SQLite database:

```sh
cd backend && DB_HOST= .venv/bin/python manage.py seed_test_user
```

It signs in with the username or email and the password in
`backend/accounts/dev_seed.py`, and joins the organisation that owns the "Guide
examples" project. Running it again resets the password and any lockout. It refuses
to run against PostgreSQL. A test frontend on another port needs that origin allowed:
start the test backend with `CORS_ALLOWED_ORIGINS` and `CSRF_TRUSTED_ORIGINS` set to
it (e.g. `http://127.0.0.1:5965`).

### Tests

```sh
cd backend && DB_HOST= .venv/bin/python manage.py test
cd frontend && npx tsc --noEmit -p . && npx vitest run
```

## License

MIT, see [LICENSE](LICENSE).
