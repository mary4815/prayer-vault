# Prayer Memory Vault — Backend Setup

Architecture:
- **Supabase** = auth (email/password + Google) + Postgres database + RLS. The web app talks to it directly from the browser.
- **Node server (this folder)** = the few things that need secret keys: Stripe Checkout + webhook, WhatsApp (Twilio) and email (Resend) notifications.
- **Web app** = `index.html` — now wired to Supabase: real email/password + Google auth, and all data (prayers, streaks, monthly reviews, preferences, confessions, profile, groups, the global prayer wall, causes & donations) synced to Postgres. If the Supabase keys are removed it falls back to the original localStorage demo.

> **Re-run the schema.** `schema.sql` gained a `reviews` table, a join `code` on groups, a global prayer wall, a `priest` column on confessions, and a few RLS policies. It is idempotent — paste the whole file into the SQL Editor and Run it again.

> **Two features stay on the device (by design):** the **Heart to Heart** chat is a private AI scripture companion (not shared data), and the onboarding tour / simulated "platform pray count" are cosmetic. Everything else lives in the cloud.

## 1. Supabase
1. Create a project at https://supabase.com (free tier is fine).
2. Project Settings > API — copy: **Project URL**, **anon public key**, **service_role key**.
3. SQL Editor > New query — paste `supabase/schema.sql` and Run. (Re-run it after pulling these changes — see note above.)
4. Authentication > Providers > **Google** — enable it, paste a Google OAuth Client ID + Secret
   (create at https://console.cloud.google.com/apis/credentials, type "Web application").
   Add this Authorized redirect URI to Google: `https://YOUR-PROJECT.supabase.co/auth/v1/callback`.
5. Authentication > URL Configuration — add your local web origin (e.g. `http://localhost:5500`) to redirect allow-list.

## 2. Server
```bash
cd server
cp .env.example .env      # then fill in every value
npm install
npm start                 # http://localhost:8787  (check /api/health)
```

## 3. Stripe (real payments)
1. https://dashboard.stripe.com > Developers > API keys → `STRIPE_SECRET_KEY` (use test key first).
2. Local webhook: `stripe listen --forward-to localhost:8787/api/stripe/webhook`
   → copy the `whsec_...` it prints into `STRIPE_WEBHOOK_SECRET`.
3. Donations create a Checkout session; on success the webhook records the donation and bumps the cause total.

## 4. Email (Resend) + WhatsApp (Twilio)
- Resend: create an API key, verify a sending domain, set `EMAIL_FROM`.
- Twilio: get Account SID + Auth Token; for WhatsApp use the sandbox sender or an approved number → `TWILIO_WHATSAPP_FROM`.

## 5. Admin notifications (confession requests + donations)

Get an **email the moment** someone submits a confession request or makes a donation — without keeping a server running. This uses a Supabase **Edge Function** triggered by **Database Webhooks**.

> Privacy: confession emails contain only a "new request — open your dashboard" heads-up. The message body never leaves the protected database.

1. Install the Supabase CLI (`npm i -g supabase`) and link your project:
   ```bash
   cd prayer-vault
   supabase login
   supabase link --project-ref YOUR-PROJECT-REF
   ```
2. Set the function secrets (Resend key, who to notify, and a webhook secret you invent):
   ```bash
   supabase secrets set \
     RESEND_API_KEY=re_xxx \
     EMAIL_FROM="Prayer Vault <noreply@yourdomain.com>" \
     ADMIN_EMAIL=you@example.com \
     NOTIFY_WEBHOOK_SECRET=$(openssl rand -hex 24)
   ```
   Copy the `NOTIFY_WEBHOOK_SECRET` value — you'll paste it into the webhook headers below.
3. Deploy the function (no JWT, since webhooks call it server-to-server):
   ```bash
   supabase functions deploy notify-admin --no-verify-jwt
   ```
   Its URL is `https://YOUR-PROJECT-REF.functions.supabase.co/notify-admin`.
4. Dashboard → **Database → Webhooks → Create a new hook**, once per table:
   - **confessions**: events = *Insert*, type = *HTTP Request* → POST to the function URL.
   - **donations**: events = *Insert* → POST to the same URL.
   - For **both**, add an HTTP header: `x-webhook-secret` = the `NOTIFY_WEBHOOK_SECRET` you set.
5. Test: submit a confession in the app (or insert a `donations` row) → you get an email within seconds.

(Resend free tier ≈ 3,000 emails/month. `onboarding@resend.dev` works for testing before you verify a domain.)

## 6. Paid subscriptions (Plus / Church)

Three tiers: **Personal** (free), **Plus** ($4.99/mo), **Church** ($14.99/mo). Stripe handles the money; the server syncs the plan back to Supabase.

1. Stripe Dashboard → **Products** → create two products, each with a **recurring monthly Price**:
   - *Prayer Vault Plus* → copy its price id into `STRIPE_PRICE_PLUS`.
   - *Prayer Vault Church* → copy its price id into `STRIPE_PRICE_CHURCH`.
2. Make sure the same webhook from section 3 is forwarding subscription events. For local testing:
   ```bash
   stripe listen --forward-to localhost:8787/api/stripe/webhook \
     --events checkout.session.completed,customer.subscription.created,customer.subscription.updated,customer.subscription.deleted
   ```
   In production, add those event types to your dashboard webhook endpoint.
3. Stripe Dashboard → **Settings → Billing → Customer portal** → activate it (lets users manage/cancel).
4. Re-run `schema.sql` (it now has a `subscriptions` table + `apply_subscription` function).
5. In the app: **Profile → Plans & Billing** → *Upgrade* opens Stripe Checkout; on success the badge flips to the new plan. *Manage Billing* opens the Stripe portal. The **Prayer Letter** generator requires Plus; **creating causes** requires Church (offline demo stays unrestricted).

## 7. Web app config (done)
The config block is already filled in near the top of the `<script>` in `index.html`:
```js
const SUPABASE_URL = 'https://YOUR-PROJECT.supabase.co';
const SUPABASE_ANON_KEY = 'your-anon-key';
const API_BASE = 'http://localhost:8787';   // the Node server; only needed for Stripe donations
```
When these are set, the app uses Supabase for auth + all data automatically.

## 8. Run & test
Serve `index.html` from the origin you allow-listed in Supabase (step 1.5), e.g.:
```bash
npx serve .            # or: python3 -m http.server 5500
```
Smoke test:
1. **Sign up** with email/password → you should land in the app; check Supabase > Table editor > `profiles` for your row.
2. Add a **prayer**, refresh the page → it persists (loaded from `prayers`, not localStorage).
3. **Log out** and back in on another browser → your data follows you.
4. **Groups:** create a group, copy the code, join it from a second account.
5. **Donate:** with the Node server + Stripe running it opens Checkout; without them the gift is recorded straight to `donations` and the cause total updates.

Donations through real Stripe need the server (sections 2–3); until then the in-app "record gift" path works against the database.

## Keys checklist
- [ ] SUPABASE_URL, anon key, service_role key
- [ ] Google OAuth client id + secret (in Supabase)
- [ ] STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET
- [ ] STRIPE_PRICE_PLUS, STRIPE_PRICE_CHURCH (recurring prices)
- [ ] RESEND_API_KEY, EMAIL_FROM
- [ ] TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_FROM
- [ ] Edge Function secrets: RESEND_API_KEY, EMAIL_FROM, ADMIN_EMAIL, NOTIFY_WEBHOOK_SECRET

## Security notes
- `service_role` key and all secrets live ONLY in `server/.env` — never in the browser or git.
- RLS makes every user's prayers/people/reminders/confessions/donations/subscriptions private; groups, wall, chat, and causes are shared per policy.
- Subscription rows are written **only** by the server's service-role key from verified Stripe webhooks — the browser can read its own plan but can never set it.
- Confession notifications never include the message body; only an "open your dashboard" alert is emailed.
