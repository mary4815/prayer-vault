-- =====================================================================
-- Prayer Memory Vault — Supabase schema
-- Run in Supabase SQL Editor (Dashboard > SQL > New query). Safe to re-run.
-- Auth = Supabase Auth (email/password + Google OAuth). RLS isolates data.
-- =====================================================================

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;

-- profiles (1:1 with auth.users)
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  first_name text, last_name text, email text, church text,
  plan text default 'Personal', whatsapp text,
  created_at timestamptz default now(), updated_at timestamptz default now()
);
drop trigger if exists trg_profiles_updated on public.profiles;
create trigger trg_profiles_updated before update on public.profiles
  for each row execute function public.set_updated_at();

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, first_name, last_name)
  values (new.id, new.email,
    coalesce(new.raw_user_meta_data->>'first_name', split_part(coalesce(new.raw_user_meta_data->>'full_name',''),' ',1)),
    new.raw_user_meta_data->>'last_name')
  on conflict (id) do nothing;
  return new;
end; $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

create table if not exists public.people (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null, relationship text, created_at timestamptz default now()
);
create index if not exists idx_people_user on public.people(user_id);

create table if not exists public.prayers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  person text, request text not null, category text, follow_up date,
  privacy text default 'Private', answered boolean default false,
  answered_note text, answered_date date,
  created_at timestamptz default now(), updated_at timestamptz default now()
);
create index if not exists idx_prayers_user on public.prayers(user_id);
drop trigger if exists trg_prayers_updated on public.prayers;
create trigger trg_prayers_updated before update on public.prayers
  for each row execute function public.set_updated_at();

create table if not exists public.reminders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  label text, time text, repeat text default 'Daily',
  prayer_id uuid references public.prayers(id) on delete set null,
  channel text default 'app', created_at timestamptz default now()
);
create index if not exists idx_reminders_user on public.reminders(user_id);

create table if not exists public.streaks (
  user_id uuid primary key references auth.users(id) on delete cascade,
  current int default 0, longest int default 0, days date[] default '{}',
  updated_at timestamptz default now()
);

create table if not exists public.prefs (
  user_id uuid primary key references auth.users(id) on delete cascade,
  remind boolean default true, digest boolean default false,
  prompts boolean default true, color_idx int default 0,
  updated_at timestamptz default now()
);

create table if not exists public.groups (
  id uuid primary key default gen_random_uuid(),
  name text not null, description text, privacy text default 'public',
  owner uuid references auth.users(id) on delete set null,
  created_at timestamptz default now()
);
create table if not exists public.group_members (
  group_id uuid references public.groups(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  joined_at timestamptz default now(), primary key (group_id, user_id)
);
create table if not exists public.wall_posts (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  author_id uuid references auth.users(id) on delete set null,
  name text, text text not null, created_at timestamptz default now()
);
create index if not exists idx_wall_group on public.wall_posts(group_id);
create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  sender_id uuid references auth.users(id) on delete set null,
  sender text, text text not null, created_at timestamptz default now()
);
create index if not exists idx_chat_group on public.chat_messages(group_id);

create table if not exists public.confessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  contact text, message text, status text default 'Pending',
  created_at timestamptz default now()
);
create index if not exists idx_confessions_user on public.confessions(user_id);

create table if not exists public.causes (
  id uuid primary key default gen_random_uuid(),
  name text not null, description text, goal numeric default 0, raised numeric default 0,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz default now()
);
create table if not exists public.donations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  cause_id uuid references public.causes(id) on delete cascade,
  cause_name text, amount numeric not null, currency text default 'usd',
  stripe_session text, status text default 'pending', created_at timestamptz default now()
);
create index if not exists idx_donations_user on public.donations(user_id);

create or replace function public.increment_cause_raised(p_cause uuid, p_amount numeric)
returns void language sql security definer set search_path = public as $$
  update public.causes set raised = coalesce(raised,0) + p_amount where id = p_cause;
$$;

-- RLS
alter table public.profiles enable row level security;
alter table public.people enable row level security;
alter table public.prayers enable row level security;
alter table public.reminders enable row level security;
alter table public.streaks enable row level security;
alter table public.prefs enable row level security;
alter table public.groups enable row level security;
alter table public.group_members enable row level security;
alter table public.wall_posts enable row level security;
alter table public.chat_messages enable row level security;
alter table public.confessions enable row level security;
alter table public.causes enable row level security;
alter table public.donations enable row level security;

do $$ begin
  create policy "own profile sel" on public.profiles for select using (auth.uid() = id);
  create policy "own profile upd" on public.profiles for update using (auth.uid() = id);
  create policy "own profile ins" on public.profiles for insert with check (auth.uid() = id);
  create policy "own people" on public.people for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
  create policy "own prayers" on public.prayers for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
  create policy "own reminders" on public.reminders for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
  create policy "own confessions" on public.confessions for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
  create policy "own streak" on public.streaks for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
  create policy "own prefs" on public.prefs for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
  create policy "own donations sel" on public.donations for select using (auth.uid() = user_id);
  create policy "groups readable" on public.groups for select using (auth.role() = 'authenticated');
  create policy "groups create" on public.groups for insert with check (auth.uid() = owner);
  create policy "groups owner upd" on public.groups for update using (auth.uid() = owner);
  create policy "groups owner del" on public.groups for delete using (auth.uid() = owner);
  create policy "members readable" on public.group_members for select using (auth.role() = 'authenticated');
  create policy "members join" on public.group_members for insert with check (auth.uid() = user_id);
  create policy "members leave" on public.group_members for delete using (auth.uid() = user_id);
  create policy "wall readable" on public.wall_posts for select using (exists (select 1 from public.group_members m where m.group_id = wall_posts.group_id and m.user_id = auth.uid()));
  create policy "wall post" on public.wall_posts for insert with check (exists (select 1 from public.group_members m where m.group_id = wall_posts.group_id and m.user_id = auth.uid()));
  create policy "chat readable" on public.chat_messages for select using (exists (select 1 from public.group_members m where m.group_id = chat_messages.group_id and m.user_id = auth.uid()));
  create policy "chat send" on public.chat_messages for insert with check (auth.uid() = sender_id and exists (select 1 from public.group_members m where m.group_id = chat_messages.group_id and m.user_id = auth.uid()));
  create policy "causes readable" on public.causes for select using (auth.role() = 'authenticated');
  create policy "causes create" on public.causes for insert with check (auth.uid() = created_by);
exception when duplicate_object then null; end $$;

insert into public.causes (name, description, goal, raised)
select * from (values
  ('Community Food Pantry','Stock the shelves so no family goes hungry this season.', 2500, 940),
  ('Youth Mission Trip','Send our young people to serve and rebuild homes abroad.', 5000, 2100),
  ('Candles & Sanctuary Care','Keep the chapel lit and cared for through the year.', 800, 615)
) as v(name,description,goal,raised)
where not exists (select 1 from public.causes);

-- =====================================================================
-- v16 front-end wiring additions (safe to re-run)
-- =====================================================================

-- Monthly review (one row per user per month). The web app stores a review
-- per "YYYY-M" key; this is the cloud home for it.
create table if not exists public.reviews (
  user_id uuid not null references auth.users(id) on delete cascade,
  month text not null,                       -- e.g. "2026-6"
  grew text, drifted text, carry text, godseen text,
  consistency text, intention text, rating int default 0,
  updated_at timestamptz default now(),
  primary key (user_id, month)
);
drop trigger if exists trg_reviews_updated on public.reviews;
create trigger trg_reviews_updated before update on public.reviews
  for each row execute function public.set_updated_at();
alter table public.reviews enable row level security;

-- Confession requests carry a recipient label (e.g. "Pastor") in the UI.
alter table public.confessions add column if not exists priest text;

-- Groups: join code + owner name. The web UI joins by 6-char code.
alter table public.groups add column if not exists code text;
create unique index if not exists idx_groups_code on public.groups(code) where code is not null;
alter table public.groups add column if not exists owner_name text;

-- Global prayer wall: the app shows ONE shared wall, not a per-group wall.
-- Make group_id optional so null = "global wall", and carry a denormalised
-- author name + pray counter for the UI.
alter table public.wall_posts alter column group_id drop not null;
alter table public.wall_posts add column if not exists author_name text;
alter table public.wall_posts add column if not exists pray_count int default 0;

create or replace function public.increment_wall_pray(p_post uuid)
returns void language sql security definer set search_path = public as $$
  update public.wall_posts set pray_count = coalesce(pray_count,0) + 1 where id = p_post;
$$;

-- RLS for the new / changed surfaces.
do $$ begin
  create policy "own reviews" on public.reviews for all
    using (auth.uid() = user_id) with check (auth.uid() = user_id);
  -- Donations: allow the browser to record its own donation when paying
  -- without Stripe (the server's service-role inserts still bypass RLS).
  create policy "own donations ins" on public.donations for insert
    with check (auth.uid() = user_id);
  -- Global wall (group_id is null) is readable and postable by any signed-in user.
  create policy "global wall readable" on public.wall_posts for select
    using (group_id is null and auth.role() = 'authenticated');
  create policy "global wall post" on public.wall_posts for insert
    with check (group_id is null and auth.role() = 'authenticated');
exception when duplicate_object then null; end $$;

-- =====================================================================
-- v17 paid subscription layer (safe to re-run)
-- =====================================================================
-- profiles.plan already holds the display plan ('Personal' = free).
-- This adds a billing record per user, synced from Stripe by the server.

create table if not exists public.subscriptions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  plan text not null default 'Personal',         -- 'Personal' | 'Plus' | 'Church'
  status text not null default 'inactive',       -- Stripe status: active, trialing, past_due, canceled, inactive
  stripe_customer_id text,
  stripe_subscription_id text,
  current_period_end timestamptz,
  updated_at timestamptz default now()
);
create index if not exists idx_subs_customer on public.subscriptions(stripe_customer_id);
drop trigger if exists trg_subs_updated on public.subscriptions;
create trigger trg_subs_updated before update on public.subscriptions
  for each row execute function public.set_updated_at();

alter table public.subscriptions enable row level security;
do $$ begin
  -- A user may read their own subscription. Writes happen only via the
  -- server's service-role key (which bypasses RLS) — never from the browser.
  create policy "own subscription sel" on public.subscriptions for select
    using (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

-- Called by the server (service role) after a Stripe event. Upserts the
-- billing row AND mirrors the plan onto profiles so the UI reflects it.
create or replace function public.apply_subscription(
  p_user uuid, p_plan text, p_status text,
  p_customer text, p_subscription text, p_period_end timestamptz
) returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.subscriptions
    (user_id, plan, status, stripe_customer_id, stripe_subscription_id, current_period_end, updated_at)
  values (p_user, p_plan, p_status, p_customer, p_subscription, p_period_end, now())
  on conflict (user_id) do update set
    plan = excluded.plan, status = excluded.status,
    stripe_customer_id = coalesce(excluded.stripe_customer_id, public.subscriptions.stripe_customer_id),
    stripe_subscription_id = excluded.stripe_subscription_id,
    current_period_end = excluded.current_period_end, updated_at = now();
  -- Active/trialing keeps the chosen plan; anything else falls back to free.
  update public.profiles
    set plan = case when p_status in ('active','trialing') then p_plan else 'Personal' end
    where id = p_user;
end; $$;
