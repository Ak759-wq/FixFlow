-- FixFlow v2 schema (Supabase / Postgres)
-- Tenant data is private per account (Supabase Auth + RLS).
-- Wardens never get table access: they read/update their PG through PIN-checked RPCs.
create extension if not exists pgcrypto;

-- ---------- PGs (shared) ----------
create table if not exists ff_pgs (
  code text primary key,
  name text not null,
  area text,
  warden_pin text not null
);
alter table ff_pgs enable row level security;
revoke all on ff_pgs from anon, authenticated;
grant select (code, name, area) on ff_pgs to anon, authenticated;
drop policy if exists ff_pgs_read on ff_pgs;
create policy ff_pgs_read on ff_pgs for select to anon, authenticated using (true);

-- ---------- clean out v1 ----------
drop table if exists ff_movein cascade;
drop table if exists ff_complaints cascade;

-- ---------- profiles ----------
create table if not exists ff_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null,
  phone text,
  city text default 'Bengaluru',
  created_at timestamptz not null default now()
);

-- ---------- tenancy (one per account) ----------
create table if not exists ff_tenancies (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null unique default auth.uid() references auth.users(id) on delete cascade,
  pg_code text references ff_pgs(code),
  pg_name text not null,
  owner_name text,
  owner_phone text,
  address text,
  room text not null,
  monthly_rent int not null check (monthly_rent > 0),
  deposit int not null check (deposit > 0),
  move_in date not null,
  move_out date,
  created_at timestamptz not null default now()
);

-- ---------- move-in photos (lockable evidence) ----------
create table if not exists ff_photos (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null default auth.uid() references auth.users(id) on delete cascade,
  area text not null check (area in ('bed','wall','bathroom','wardrobe','floor','other')),
  photo_url text not null,
  ai_tags text[] not null default '{}',
  ai_summary text,
  captured_at timestamptz not null default now(),
  locked boolean not null default false,
  locked_at timestamptz
);

create or replace function ff_photo_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    new.captured_at := now(); new.locked := false; new.locked_at := null;
    return new;
  end if;
  -- admins / account deletion (service role, SQL editor) may remove evidence; tenants never can
  if tg_op = 'DELETE' and coalesce(auth.role(), '') not in ('authenticated', 'anon') then return old; end if;
  if old.locked then
    raise exception 'Locked move-in photos are read-only';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  -- only the lock flag may change after capture
  new.photo_url := old.photo_url; new.area := old.area; new.captured_at := old.captured_at;
  new.ai_tags := old.ai_tags; new.ai_summary := old.ai_summary; new.owner := old.owner;
  if new.locked then new.locked_at := now(); end if;
  return new;
end $$;
drop trigger if exists ff_photo_guard_t on ff_photos;
create trigger ff_photo_guard_t before insert or update or delete on ff_photos
  for each row execute function ff_photo_guard();

-- ---------- complaints ----------
create table ff_complaints (
  id uuid primary key default gen_random_uuid(),
  owner uuid default auth.uid() references auth.users(id) on delete cascade,
  pg_code text references ff_pgs(code),
  resident_name text not null,
  room text,
  category text not null default 'Other',
  urgency text not null default 'Medium' check (urgency in ('High','Medium','Low')),
  title text not null,
  description text not null,
  draft text,
  photo_url text,
  status text not null default 'open' check (status in ('open','in_progress','fixed')),
  warden_note text,
  supporters int not null default 1,
  reported_at timestamptz not null default now(),
  fixed_at timestamptz
);
create index ff_complaints_pg_idx on ff_complaints(pg_code, reported_at desc);
create index ff_complaints_owner_idx on ff_complaints(owner, reported_at desc);

create or replace function ff_complaint_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then new.reported_at := now(); new.supporters := 1; end if;
  if new.status = 'fixed' and (tg_op = 'INSERT' or old.status <> 'fixed') then new.fixed_at := now(); end if;
  if new.status <> 'fixed' then new.fixed_at := null; end if;
  return new;
end $$;
drop trigger if exists ff_complaint_guard_t on ff_complaints;
create trigger ff_complaint_guard_t before insert or update on ff_complaints
  for each row execute function ff_complaint_guard();

-- ---------- deductions + notices ----------
create table if not exists ff_deductions (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null default auth.uid() references auth.users(id) on delete cascade,
  reason text not null,
  amount int not null check (amount > 0),
  ai_verdict text check (ai_verdict in ('fair','unfair','unclear')),
  ai_reason text,
  matched_photo_id uuid references ff_photos(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists ff_notices (
  owner uuid not null default auth.uid() references auth.users(id) on delete cascade,
  kind text not null check (kind in ('whatsapp','formal','grievance')),
  body text not null,
  updated_at timestamptz not null default now(),
  primary key (owner, kind)
);

-- ---------- RLS: every row belongs to its owner ----------
do $$
declare t text;
begin
  foreach t in array array['ff_tenancies','ff_photos','ff_complaints','ff_deductions','ff_notices'] loop
    execute format('alter table %I enable row level security', t);
    execute format('revoke all on %I from anon', t);
    execute format('grant select, insert, update, delete on %I to authenticated', t);
    execute format('drop policy if exists own_all on %I', t);
    execute format('create policy own_all on %I for all to authenticated using (owner = auth.uid()) with check (owner = auth.uid())', t);
  end loop;
end $$;
alter table ff_profiles enable row level security;
revoke all on ff_profiles from anon;
grant select, insert, update on ff_profiles to authenticated;
drop policy if exists own_profile on ff_profiles;
create policy own_profile on ff_profiles for all to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- ---------- RPCs ----------
create or replace function ff_check_pin(p_code text, p_pin text) returns boolean
language sql security definer set search_path = public as $$
  select exists(select 1 from ff_pgs where code = upper(p_code) and warden_pin = p_pin);
$$;

create or replace function ff_warden_list(p_code text, p_pin text) returns setof ff_complaints
language plpgsql security definer set search_path = public as $$
begin
  if not ff_check_pin(p_code, p_pin) then raise exception 'Wrong PG code or PIN'; end if;
  return query select * from ff_complaints where pg_code = upper(p_code) order by reported_at desc;
end $$;

create or replace function ff_warden_set(p_code text, p_pin text, p_id uuid, p_status text, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not ff_check_pin(p_code, p_pin) then raise exception 'Wrong PG code or PIN'; end if;
  if p_status not in ('open','in_progress','fixed') then raise exception 'Bad status'; end if;
  update ff_complaints set status = p_status, warden_note = coalesce(p_note, warden_note)
   where id = p_id and pg_code = upper(p_code);
end $$;

-- co-residents see open issues in their PG (no names), so they can +1 instead of duplicating
create or replace function ff_pg_open(p_code text) returns table(id uuid, title text, category text, urgency text, supporters int, reported_at timestamptz)
language sql security definer set search_path = public as $$
  select id, title, category, urgency, supporters, reported_at from ff_complaints
   where pg_code = upper(p_code) and status <> 'fixed' order by supporters desc, reported_at desc limit 20;
$$;

create or replace function ff_support(p_id uuid) returns int
language sql security definer set search_path = public as $$
  update ff_complaints set supporters = supporters + 1 where id = p_id and status <> 'fixed' returning supporters;
$$;

create or replace function ff_stats() returns table(open_count int, fixed_count int, avg_days numeric)
language sql security definer set search_path = public as $$
  select count(*) filter (where status <> 'fixed')::int,
         count(*) filter (where status = 'fixed')::int,
         round(avg(extract(epoch from (fixed_at - reported_at)) / 86400) filter (where status = 'fixed'), 1)
    from ff_complaints;
$$;

revoke execute on function ff_check_pin(text,text), ff_warden_list(text,text), ff_warden_set(text,text,uuid,text,text), ff_pg_open(text), ff_support(uuid), ff_stats() from public;
grant execute on function ff_check_pin(text,text), ff_warden_list(text,text), ff_warden_set(text,text,uuid,text,text), ff_stats() to anon, authenticated;
grant execute on function ff_pg_open(text), ff_support(uuid) to authenticated;

-- ---------- storage for photos ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('ff-photos', 'ff-photos', true, 5242880, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update set public = true, file_size_limit = 5242880;
drop policy if exists ff_photos_upload on storage.objects;
create policy ff_photos_upload on storage.objects for insert to authenticated
  with check (bucket_id = 'ff-photos' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists ff_photos_read on storage.objects;
create policy ff_photos_read on storage.objects for select to anon, authenticated using (bucket_id = 'ff-photos');
