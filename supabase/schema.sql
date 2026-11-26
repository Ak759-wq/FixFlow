-- FixFlow schema (Supabase / Postgres): v2 base + v3 additions at the end (also in v3_migration.sql).
-- Idempotent: safe to re-run.
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

-- ---------- clean out v1 (pre-v2 table only; never drops live data) ----------
drop table if exists ff_movein cascade;

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
create table if not exists ff_complaints (
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
create index if not exists ff_complaints_pg_idx on ff_complaints(pg_code, reported_at desc);
create index if not exists ff_complaints_owner_idx on ff_complaints(owner, reported_at desc);

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


-- ================= FixFlow v3 (additive, idempotent) =================
-- Safe to re-run. Only touches ff_* objects and the ff-photos bucket.

-- ---------- move-in evidence: new areas + file integrity ----------
-- UI areas: Bedroom (bed), Bathroom (bathroom), Walls (wall), Furniture (furniture).
-- Legacy values (wardrobe, floor, other) stay valid so old rows keep working.
alter table ff_photos drop constraint if exists ff_photos_area_check;
alter table ff_photos add constraint ff_photos_area_check
  check (area in ('bed','bathroom','wall','furniture','wardrobe','floor','other'));
alter table ff_photos add column if not exists file_sha256 text;
alter table ff_photos add column if not exists file_name text;
alter table ff_photos add column if not exists file_type text;
alter table ff_photos add column if not exists file_bytes int;
alter table ff_photos add column if not exists file_modified_at timestamptz;
alter table ff_photos add column if not exists storage_path text;
alter table ff_photos drop constraint if exists ff_photos_sha_check;
alter table ff_photos add constraint ff_photos_sha_check check (file_sha256 is null or file_sha256 ~ '^[0-9a-f]{64}$');

create or replace function ff_photo_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    new.captured_at := now(); new.locked := false; new.locked_at := null;
    return new;
  end if;
  -- admins (SQL editor / service role) and the owner's own account deletion may remove evidence
  if tg_op = 'DELETE' and (coalesce(auth.role(), '') not in ('authenticated', 'anon')
       or coalesce(current_setting('ff.purge', true), '') = old.owner::text) then
    return old;
  end if;
  if old.locked then
    raise exception 'Locked move-in photos are read-only. Add a dated correction note instead.';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  -- before lock the tenant may review the AI description / area; the file itself never changes
  new.photo_url := old.photo_url; new.captured_at := old.captured_at; new.owner := old.owner;
  new.file_sha256 := old.file_sha256; new.file_name := old.file_name; new.file_type := old.file_type;
  new.file_bytes := old.file_bytes; new.file_modified_at := old.file_modified_at; new.storage_path := old.storage_path;
  if new.locked then new.locked_at := now(); else new.locked_at := null; end if;
  return new;
end $$;

-- corrections to evidence are new dated entries, never edits
create table if not exists ff_evidence_notes (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null default auth.uid() references auth.users(id) on delete cascade,
  photo_id uuid not null references ff_photos(id) on delete cascade,
  note text not null check (char_length(note) between 3 and 1000),
  created_at timestamptz not null default now()
);
create or replace function ff_note_guard() returns trigger language plpgsql as $$
begin new.created_at := now(); new.owner := auth.uid(); return new; end $$;
drop trigger if exists ff_note_guard_t on ff_evidence_notes;
create trigger ff_note_guard_t before insert on ff_evidence_notes for each row execute function ff_note_guard();
alter table ff_evidence_notes enable row level security;
revoke all on ff_evidence_notes from anon, authenticated;
grant select, insert on ff_evidence_notes to authenticated;
drop policy if exists own_read on ff_evidence_notes;
create policy own_read on ff_evidence_notes for select to authenticated using (owner = auth.uid());
drop policy if exists own_insert on ff_evidence_notes;
create policy own_insert on ff_evidence_notes for insert to authenticated
  with check (owner = auth.uid() and exists (select 1 from ff_photos p where p.id = photo_id and p.owner = auth.uid()));

-- ---------- complaints: reference IDs, last-updated, status history ----------
create sequence if not exists ff_complaint_ref_seq;
grant usage, select on sequence ff_complaint_ref_seq to authenticated;
alter table ff_complaints add column if not exists ref text;
alter table ff_complaints add column if not exists updated_at timestamptz not null default now();
alter table ff_complaints add column if not exists ai_category text;
update ff_complaints set ref = 'FF-' || to_char(reported_at at time zone 'Asia/Kolkata', 'YYYY') || '-' || lpad(nextval('ff_complaint_ref_seq')::text, 4, '0')
 where ref is null;
create unique index if not exists ff_complaints_ref_idx on ff_complaints(ref);

create or replace function ff_complaint_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    new.reported_at := now(); new.supporters := 1; new.updated_at := now();
    new.ref := 'FF-' || to_char(now() at time zone 'Asia/Kolkata', 'YYYY') || '-' || lpad(nextval('ff_complaint_ref_seq')::text, 4, '0');
  else
    if coalesce(auth.role(), '') in ('authenticated', 'anon') then  -- admins (seed/backfill) may correct dates
      new.ref := old.ref; new.reported_at := old.reported_at;
    end if;
    if new.status is distinct from old.status or new.warden_note is distinct from old.warden_note
       or new.title is distinct from old.title or new.description is distinct from old.description then
      new.updated_at := now();
    elsif coalesce(auth.role(), '') in ('authenticated', 'anon') then
      new.updated_at := old.updated_at;
    end if;
  end if;
  if new.status = 'fixed' and (tg_op = 'INSERT' or old.status <> 'fixed') then new.fixed_at := now(); end if;
  if new.status <> 'fixed' then new.fixed_at := null; end if;
  return new;
end $$;

create table if not exists ff_complaint_events (
  id bigint generated always as identity primary key,
  complaint_id uuid not null references ff_complaints(id) on delete cascade,
  owner uuid references auth.users(id) on delete cascade,
  kind text not null check (kind in ('created','status','note','response')),
  from_status text,
  to_status text,
  note text check (note is null or char_length(note) <= 1000),
  actor text not null default 'resident' check (actor in ('resident','warden','system')),
  created_at timestamptz not null default now()
);
create index if not exists ff_events_complaint_idx on ff_complaint_events(complaint_id, created_at);

-- tenant-added entries (their own note, or the warden's reply they received) are forced to safe values
create or replace function ff_event_guard() returns trigger language plpgsql as $$
begin
  if coalesce(current_setting('ff.sys', true), '') = '1' then new.created_at := now(); return new; end if;
  if coalesce(auth.role(), '') in ('authenticated', 'anon') then
    if new.kind not in ('note','response') then raise exception 'Only notes or responses can be added'; end if;
    new.created_at := now(); new.owner := auth.uid(); new.actor := 'resident'; new.from_status := null; new.to_status := null;
  end if;
  return new;
end $$;
drop trigger if exists ff_event_guard_t on ff_complaint_events;
create trigger ff_event_guard_t before insert on ff_complaint_events for each row execute function ff_event_guard();

create or replace function ff_complaint_log() returns trigger language plpgsql security definer set search_path = public as $$
declare who text := case when coalesce(current_setting('ff.actor', true), '') = 'warden' then 'warden'
                         when coalesce(auth.role(), '') = 'authenticated' then 'resident' else 'system' end;
begin
  perform set_config('ff.sys', '1', true);
  if tg_op = 'INSERT' then
    insert into ff_complaint_events(complaint_id, owner, kind, to_status, actor) values (new.id, new.owner, 'created', new.status, who);
  elsif new.status is distinct from old.status then
    insert into ff_complaint_events(complaint_id, owner, kind, from_status, to_status, note, actor)
    values (new.id, new.owner, 'status', old.status, new.status,
            case when new.warden_note is distinct from old.warden_note then new.warden_note end, who);
  elsif new.warden_note is distinct from old.warden_note and new.warden_note is not null then
    insert into ff_complaint_events(complaint_id, owner, kind, note, actor) values (new.id, new.owner, 'note', new.warden_note, who);
  end if;
  perform set_config('ff.sys', '', true);
  return null;
end $$;
drop trigger if exists ff_complaint_log_t on ff_complaints;
create trigger ff_complaint_log_t after insert or update on ff_complaints for each row execute function ff_complaint_log();

-- backfill a 'created' event for complaints that predate history
insert into ff_complaint_events(complaint_id, owner, kind, to_status, actor, created_at)
select c.id, c.owner, 'created', 'open', 'system', c.reported_at from ff_complaints c
 where not exists (select 1 from ff_complaint_events e where e.complaint_id = c.id);

alter table ff_complaint_events enable row level security;
revoke all on ff_complaint_events from anon, authenticated;
grant select, insert on ff_complaint_events to authenticated;
drop policy if exists own_read on ff_complaint_events;
create policy own_read on ff_complaint_events for select to authenticated using (owner = auth.uid());
drop policy if exists own_insert on ff_complaint_events;
create policy own_insert on ff_complaint_events for insert to authenticated
  with check (owner = auth.uid() and exists (select 1 from ff_complaints c where c.id = complaint_id and c.owner = auth.uid()));

-- ---------- deductions + notices ----------
alter table ff_deductions add column if not exists matched_complaint_id uuid references ff_complaints(id) on delete set null;
alter table ff_deductions add column if not exists tenant_position text;
alter table ff_deductions drop constraint if exists ff_deductions_position_check;
alter table ff_deductions add constraint ff_deductions_position_check check (tenant_position is null or tenant_position in ('accept','dispute'));
alter table ff_deductions add column if not exists audited_at timestamptz;
alter table ff_deductions add column if not exists ai_source text;
alter table ff_notices add column if not exists finalized_at timestamptz;

-- ---------- audit trail (append-only, written by triggers) ----------
create table if not exists ff_audit_log (
  id bigint generated always as identity primary key,
  owner uuid not null references auth.users(id) on delete cascade,
  action text not null,
  entity text not null,
  entity_id text,
  detail jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index if not exists ff_audit_owner_idx on ff_audit_log(owner, created_at desc);
alter table ff_audit_log enable row level security;
revoke all on ff_audit_log from anon, authenticated;
grant select on ff_audit_log to authenticated;
drop policy if exists own_read on ff_audit_log;
create policy own_read on ff_audit_log for select to authenticated using (owner = auth.uid());

create or replace function ff_audit() returns trigger language plpgsql security definer set search_path = public as $$
declare r jsonb; o jsonb; own uuid; act text := lower(tg_op); d jsonb := '{}';
begin
  -- only end-user sessions are logged; admin SQL and account purges are not
  if coalesce(auth.role(), '') not in ('authenticated', 'anon') or coalesce(current_setting('ff.purge', true), '') <> '' then return null; end if;
  r := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  o := case when tg_op = 'UPDATE' then to_jsonb(old) else null end;
  own := nullif(r->>'owner', '')::uuid;
  if own is null then return null; end if;
  if tg_table_name = 'ff_photos' then
    if tg_op = 'UPDATE' then
      if (r->>'locked')::boolean and not (o->>'locked')::boolean then act := 'lock'; else act := 'review'; end if;
    end if;
    d := jsonb_build_object('area', r->>'area', 'sha256', r->>'file_sha256');
  elsif tg_table_name = 'ff_complaints' then
    if tg_op = 'UPDATE' then
      if r->>'status' is distinct from o->>'status' then act := 'status'; d := jsonb_build_object('from', o->>'status', 'to', r->>'status');
      elsif r->>'warden_note' is distinct from o->>'warden_note' then act := 'warden_note';
      elsif r->>'title' is distinct from o->>'title' or r->>'description' is distinct from o->>'description' then act := 'edit';
      else return null; end if;
    end if;
    d := d || jsonb_build_object('ref', r->>'ref', 'title', r->>'title');
  elsif tg_table_name = 'ff_deductions' then
    if tg_op = 'UPDATE' then act := case when r->>'tenant_position' is distinct from o->>'tenant_position' then 'position' else 'audit' end; end if;
    d := jsonb_build_object('reason', r->>'reason', 'amount', (r->>'amount')::int, 'verdict', r->>'ai_verdict', 'position', r->>'tenant_position');
  elsif tg_table_name = 'ff_notices' then
    act := case when tg_op = 'UPDATE' and r->>'finalized_at' is not null and o->>'finalized_at' is null then 'finalize' else 'save' end;
    d := jsonb_build_object('kind', r->>'kind');
  elsif tg_table_name = 'ff_tenancies' then
    d := jsonb_build_object('pg', r->>'pg_name', 'room', r->>'room', 'deposit', (r->>'deposit')::int);
  elsif tg_table_name = 'ff_evidence_notes' then
    act := 'correction'; d := jsonb_build_object('photo_id', r->>'photo_id', 'note', left(r->>'note', 200));
  end if;
  insert into ff_audit_log(owner, action, entity, entity_id, detail)
  values (own, act, replace(tg_table_name, 'ff_', ''), coalesce(r->>'id', r->>'kind'), d);
  return null;
end $$;

do $$
declare t text;
begin
  foreach t in array array['ff_photos','ff_complaints','ff_deductions','ff_notices','ff_tenancies','ff_evidence_notes'] loop
    execute format('drop trigger if exists ff_audit_t on %I', t);
    execute format('create trigger ff_audit_t after insert or update or delete on %I for each row execute function ff_audit()', t);
  end loop;
end $$;

-- client-side events worth recording (report downloads, exports)
create or replace function ff_log(p_action text, p_detail jsonb default '{}') returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if p_action not in ('evidence_report','notice_pdf','data_export') then raise exception 'Unknown action'; end if;
  insert into ff_audit_log(owner, action, entity, detail) values (auth.uid(), p_action, 'account', coalesce(p_detail, '{}'));
end $$;

-- ---------- warden RPCs: notes + history attribution ----------
create or replace function ff_warden_set(p_code text, p_pin text, p_id uuid, p_status text, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not ff_check_pin(p_code, p_pin) then raise exception 'Wrong PG code or PIN'; end if;
  if p_status not in ('open','in_progress','fixed') then raise exception 'Bad status'; end if;
  perform set_config('ff.actor', 'warden', true);
  update ff_complaints set status = p_status, warden_note = coalesce(nullif(trim(p_note), ''), warden_note)
   where id = p_id and pg_code = upper(p_code);
  perform set_config('ff.actor', '', true);
end $$;

-- ---------- privacy: purge own data, then delete the account ----------
create or replace function ff_purge_my_data() returns void
language plpgsql security definer set search_path = public as $$
declare u uuid := auth.uid();
begin
  if u is null then raise exception 'Not signed in'; end if;
  perform set_config('ff.purge', u::text, true);
  delete from ff_notices where owner = u;
  delete from ff_deductions where owner = u;
  delete from ff_evidence_notes where owner = u;
  delete from ff_complaint_events where owner = u;
  delete from ff_complaints where owner = u;
  delete from ff_photos where owner = u;
  delete from ff_tenancies where owner = u;
  delete from ff_audit_log where owner = u;
  delete from ff_profiles where id = u;
  perform set_config('ff.purge', '', true);
end $$;

create or replace function ff_delete_my_account() returns void
language plpgsql security definer set search_path = public as $$
declare u uuid := auth.uid();
begin
  if u is null then raise exception 'Not signed in'; end if;
  perform ff_purge_my_data();
  perform set_config('ff.purge', u::text, true);
  -- metadata of any files the client could not remove through the Storage API
  perform set_config('storage.allow_delete_query', 'true', true);
  delete from storage.objects where bucket_id = 'ff-photos' and (storage.foldername(name))[1] = u::text;
  delete from auth.users where id = u;
end $$;

revoke execute on function ff_log(text, jsonb), ff_purge_my_data(), ff_delete_my_account() from public, anon;
grant execute on function ff_log(text, jsonb), ff_purge_my_data(), ff_delete_my_account() to authenticated;
revoke execute on function ff_warden_set(text,text,uuid,text,text) from public;
grant execute on function ff_warden_set(text,text,uuid,text,text) to anon, authenticated;

-- ---------- storage: 10 MB originals, owner may delete only unlocked files ----------
update storage.buckets set file_size_limit = 10485760, allowed_mime_types = array['image/jpeg','image/png','image/webp'] where id = 'ff-photos';
drop policy if exists ff_photos_delete on storage.objects;
create policy ff_photos_delete on storage.objects for delete to authenticated
  using (bucket_id = 'ff-photos' and (storage.foldername(name))[1] = auth.uid()::text
         and not exists (select 1 from public.ff_photos p
                          where p.locked and (p.storage_path = storage.objects.name or p.photo_url like '%/' || storage.objects.name)));
