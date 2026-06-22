# ASSESSLINK → Supabase migration: setup notes

## 1. Create the Supabase project
If you don't already have one dedicated to this app (don't reuse the TKNP one —
keep institutional systems separate): supabase.com → New Project → pick the
region closest to Kenya (Supabase doesn't have an Africa region yet; use
`eu-west` (Ireland) or `eu-central` for lowest latency from Kitale).

## 2. Run the SQL files, in order
In Supabase Dashboard → SQL Editor:
1. `001_schema.sql` — tables, enums, indexes, triggers
2. `002_rls_policies.sql` — row-level security

## 3. File storage: move off local disk
Your `server.ts` currently writes uploads to a local `uploads/` folder. That
breaks the moment you're not on a single persistent disk. Create three
Supabase Storage buckets:
- `logbook-files` (private — trainee uploads, signatures, site evidence)
- `institutional-docs` (private — NITA forms, insurance, policies)
- `profile-photos` (public read)

Then in `server.ts`, replace every `fs.writeFileSync(uploadsPath, ...)` call
with `supabase.storage.from('bucket-name').upload(path, fileBuffer)`, and
store the returned path/URL in the relevant `file_url` / `file_urls` column
instead of a local path.

## 4. Secrets — do not put these in client code or in a table the frontend can read
Move these into your hosting platform's environment variables (Render/Railway
dashboard → Environment), never into `.env` files committed to git:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY` (server-side only — this key bypasses RLS,
  treat it like a root password)
- `GEMINI_API_KEY`
- Africa's Talking SMS API key (referenced as `smsApiKey` in your old
  `systemSettings` — we deliberately left this OUT of the new `system_settings`
  table; it should live only in database secrets or server env vars, not in a database row a
  logged-in admin's browser can fetch)

## 5. Rewire server.ts
Replace the `db` in-memory object and `loadDb()`/`saveDb()` functions with a
Supabase client, and swap each route's array `.find()`/`.push()` logic for
the equivalent Supabase query. Example query:

```ts
// Before:
const user = db.users.find(u => u.email.toLowerCase() === email.toLowerCase());

// After:
const { data: user, error } = await supabase
  .from('users')
  .select('*')
  .ilike('email', email)
  .maybeSingle();
```

## 6. Auth: replace the current email-lookup "login"
Right now login appears to just look up a user by email with no real password
check (`db.users.find(u => u.email.toLowerCase() === userEmail.toLowerCase())`
with no password verification visible). That's fine for an AI Studio demo,
not for 50,000 real student/staff accounts. Switch to Supabase Auth:
- Email/password or magic link for officers/supervisors/admins
- For trainees, consider Supabase phone OTP (pairs naturally with the
  Africa's Talking SMS you're already simulating) since not every student
  reliably checks email

## 7. Deployment
- Backend (Express + Vite-built frontend): Render or Railway, NOT Vercel
  serverless (you already hit this wall once — long-running Node process,
  not discrete functions).
- Add a `render.yaml` or Railway config running `npm run build && npm start`.
- Point `APP_URL` env var at your real production domain.

## 8. At 50,000 users — is this actually enough?
Yes, comfortably. Supabase's smallest paid Postgres tier handles millions of
rows without strain; the indexes in `001_schema.sql` cover the access
patterns your routes already use (lookup by user, by placement, by cohort,
by status, by county/geo for the placement map). The real bottleneck at that
scale won't be the database — it'll be:
- File storage egress costs if logbook PDFs/images aren't compressed (worth
  capping upload size and image-compressing client-side before upload)
- The Gemini API calls, if any route calls it per-request rather than caching

## 9. Suggested order of operations
1. Run `001_schema.sql` + `002_rls_policies.sql` on a fresh Supabase project
2. Stand up Storage buckets
3. Rewrite `server.ts` (Cursor-assisted or have me do it)
4. Switch login to Supabase Auth
5. Run `migrate-db-json-to-supabase.ts` against any real seed data you have
6. Deploy to Render/Railway
7. Then: PWA manifest, and Capacitor wrap if you want Play Store distribution
