-- FixFlow schema (Supabase / Postgres)
create extension if not exists pgcrypto;

create table if not exists ff_pgs (
  code text primary key,
  name text not null,
  area text,
  warden_pin text not null
);

create table if not exists ff_complaints (
  id uuid primary key default gen_random_uuid(),
  pg_code text not null references ff_pgs(code),
  resident_name text not null,
  room text not null,
  text text not null,
  title text not null,
  summary text,
  draft text,
  category text not null default 'Other',
  urgency text not null default 'Medium',
  status text not null default 'Open',
  warden_note text,
  escalation_level int not null default 0,
  supporters int not null default 1,
  created_at timestamptz not null default now(),
  seen_at timestamptz,
  fixed_at timestamptz
);
create index if not exists ff_complaints_pg_idx on ff_complaints(pg_code, created_at desc);

create table if not exists ff_movein (
  id uuid primary key default gen_random_uuid(),
  pg_code text not null references ff_pgs(code),
  resident_name text not null,
  room text not null,
  area text not null,
  image text not null,
  issues jsonb not null default '[]',
  summary text,
  created_at timestamptz not null default now()
);

-- Demo app: open read/write for the public anon key on FixFlow tables only.
alter table ff_pgs enable row level security;
alter table ff_complaints enable row level security;
alter table ff_movein enable row level security;
drop policy if exists ff_pgs_read on ff_pgs;
create policy ff_pgs_read on ff_pgs for select to anon using (true);
drop policy if exists ff_c_all on ff_complaints;
create policy ff_c_all on ff_complaints for all to anon using (true) with check (true);
drop policy if exists ff_m_sel on ff_movein;
create policy ff_m_sel on ff_movein for select to anon using (true);
drop policy if exists ff_m_ins on ff_movein;
create policy ff_m_ins on ff_movein for insert to anon with check (true);
grant select on ff_pgs to anon;
grant select, insert, update on ff_complaints to anon;
grant select, insert on ff_movein to anon;

insert into ff_pgs (code, name, area, warden_pin) values ('SUNRISE24', 'Sunrise Co-living', 'Srinivaspura, Bengaluru', '1234')
on conflict (code) do nothing;

-- Keep warden PINs private: anon can read only public columns, and checks a PIN via RPC.
revoke select on ff_pgs from anon;
grant select (code, name, area) on ff_pgs to anon;
create or replace function ff_check_pin(p_code text, p_pin text) returns boolean
language sql security definer set search_path = public as $$
  select exists(select 1 from ff_pgs where code = upper(p_code) and warden_pin = p_pin);
$$;
grant execute on function ff_check_pin(text, text) to anon;
