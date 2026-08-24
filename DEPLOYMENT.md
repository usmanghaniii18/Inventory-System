# Deployment

This repo is an npm-workspaces monorepo:

- `apps/admin` — inventory + POS (the **only** app wired for deploy right now)
- `apps/storefront` — customer e-commerce (deploy config intentionally **not** set up yet)
- `packages/shared` — shared code consumed by both apps

Both apps talk to the **same** hosted Supabase project. Deploying `apps/admin` does
not require touching the storefront.

---

## Deploy `apps/admin` to Railway

`apps/admin` runs as a **standard Next.js Node server** — `next build` then
`next start`. There is no edge/Workers runtime and no Cloudflare adapter: routes use
the default Node.js runtime, and `next start` binds to the `PORT` Railway injects.

### 1. Create the service

Railway → **New Project** → **Deploy from GitHub repo** → pick this repository.
Railway clones the whole repo (needed so the `@hamza/shared` workspace resolves).

### 2. Service settings

In the service **Settings**:

| Setting | Value |
|---|---|
| **Root Directory** | `apps/admin` |
| **Build Command** | `npm run build` |
| **Start Command** | `npm run start` |
| **Production branch** | `on-going-development` (switch to `main` when you go live) |

Notes:
- **Root Directory = `apps/admin`.** Railway still has the full repo checked out, so
  the default `npm install` walks up to the workspace root and the `@hamza/shared`
  workspace package resolves automatically. (If install ever can't find it, set Root
  Directory = repo root, Build Command = `npm run build -w @hamza/admin`,
  Start Command = `npm run start -w @hamza/admin`.)
- **Do not set `PORT` yourself** — Railway provides it and `next start` reads it
  automatically (it also binds `0.0.0.0`, so the service is reachable).
- Use **Node 20+**. Railway picks it up from a repo-root `.nvmrc` or the
  `NODE_VERSION` service variable.

### 3. Environment variables (service → Variables)

All point at the **existing shared Supabase project** — do not create a new one.
Values are never committed; only the names below (and in `apps/admin/.env.example`)
live in git.

**Public — exposed to the browser (`NEXT_PUBLIC_*`):**

| Name | Notes |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL (shared project) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon/public key |
| `NEXT_PUBLIC_APP_URL` | This admin deploy's own public URL (used in password-reset links), e.g. `https://admin.yourdomain.com` |
| `NEXT_PUBLIC_APP_NAME` | Optional — display name |
| `NEXT_PUBLIC_CURRENCY` | Optional — currency label (e.g. `PKR`) |

**Server-only — secret, never prefix with `NEXT_PUBLIC`:**

| Name | Notes |
|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | Privileged Supabase key for server actions + auth admin |
| `ADMIN_OTP_SECRET` | Signs the OTP-verified session cookie (2nd factor). Long random string. **Required** or the admin is unreachable |
| `RESEND_API_KEY` | Resend key — sends login OTP + password-reset emails |
| `AUTH_EMAIL_FROM` | Verified Resend sender, e.g. `Hamza Store <noreply@yourdomain.com>` |

**Local-only** (used by `node scripts/create-admin.mjs` to seed the first admin):
`ADMIN_EMAIL`, `ADMIN_PASSWORD`. Run that script locally once, then clear them — they
are not needed on Railway.

### 4. Custom domain

Service → **Settings → Networking** → generate a Railway domain or add a custom one
(e.g. `admin.yourdomain.com`). After it resolves, set `NEXT_PUBLIC_APP_URL` to that
exact URL and redeploy so the password-reset email links are correct.

### 5. Scheduled tasks (cron)

`apps/admin` has **no** scheduled task, so nothing extra is needed. (The only cron in
the repo is the storefront's `/api/cron/release-reservations`, out of scope until the
storefront is deployed separately.)

---

## Local commands

From the repo root (the app builds/starts the same way Railway runs it):

```bash
npm run build -w @hamza/admin   # next build
npm run start -w @hamza/admin   # next start (PORT respected; defaults to 3000)
npm run dev:admin               # local dev server (next dev)
```
