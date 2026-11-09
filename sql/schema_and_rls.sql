-- =====================================================================
-- POKÉMON PANELA: schema, RLS, triggers e RPCs (idempotente)
-- Execute no SQL Editor do Supabase e depois rode sql/catalog_seed.sql.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- TABELAS
-- ---------------------------------------------------------------------
create table if not exists public.pokemon_catalog (
  pokemon_id         integer primary key,
  dex_number         integer not null check (dex_number between 1 and 1025),
  slug               text not null unique,
  name               text not null,
  species_generation smallint not null check (species_generation between 1 and 9),
  origin_generation  smallint not null check (origin_generation between 1 and 9),
  form_category      text not null check (form_category in ('base','regional','mega','primal','gmax','special')),
  species_class      text check (species_class in ('legendary','mythical','paradox')),
  type_1             text not null,
  type_2             text,
  is_active          boolean not null default true
);
create index if not exists pokemon_catalog_dex_idx on public.pokemon_catalog (dex_number);

create table if not exists public.profiles (
  id                  uuid primary key references auth.users (id) on delete cascade,
  username            text not null,
  username_normalized text not null unique
                      check (username_normalized ~ '^[a-z0-9_.-]{3,20}$'),
  avatar_id           integer references public.pokemon_catalog (pokemon_id) on delete set null,
  bio                 text not null default '' check (char_length(bio) <= 160),
  vote_count          integer not null default 0,
  is_qualified        boolean not null default false,
  is_banned           boolean not null default false,
  ban_reason          text,
  banned_at           timestamptz,
  last_migration_at   timestamptz,
  created_at          timestamptz not null default now()
);

create table if not exists public.user_roles (
  user_id    uuid not null references public.profiles (id) on delete cascade,
  role       text not null check (role in ('admin')),
  created_at timestamptz not null default now(),
  primary key (user_id, role)
);

create table if not exists public.votes (
  user_id    uuid not null references public.profiles (id) on delete cascade,
  pokemon_id integer not null references public.pokemon_catalog (pokemon_id) on delete cascade,
  score      smallint not null check (score between 1 and 5),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, pokemon_id)
);
create index if not exists votes_pokemon_idx on public.votes (pokemon_id);

create table if not exists public.pokemon_stats (
  pokemon_id     integer primary key references public.pokemon_catalog (pokemon_id) on delete cascade,
  total_votes    integer not null default 0,
  panela_votes   integer not null default 0,
  sum_score      integer not null default 0,
  avg_score      numeric(6,4) not null default 0,
  bayesian_score numeric(6,4) not null default 0,
  updated_at     timestamptz not null default now()
);
alter table public.pokemon_stats add column if not exists panela_votes integer not null default 0;

create index if not exists pokemon_stats_rank_idx
  on public.pokemon_stats (bayesian_score desc, avg_score desc, total_votes desc);

create table if not exists public.friendships (
  id           bigint generated always as identity primary key,
  requester_id uuid not null references public.profiles (id) on delete cascade,
  addressee_id uuid not null references public.profiles (id) on delete cascade,
  status       text not null default 'pending' check (status in ('pending','accepted')),
  created_at   timestamptz not null default now(),
  responded_at timestamptz,
  check (requester_id <> addressee_id)
);
create unique index if not exists friendships_pair_uq
  on public.friendships (least(requester_id, addressee_id), greatest(requester_id, addressee_id));
create index if not exists friendships_addressee_idx on public.friendships (addressee_id);

create table if not exists public.admin_audit_logs (
  id         bigint generated always as identity primary key,
  admin_id   uuid references public.profiles (id) on delete set null,
  action     text not null,
  target     text,
  details    jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.vote_rate_buckets (
  user_id      uuid not null references public.profiles (id) on delete cascade,
  bucket_start timestamptz not null,
  hits         integer not null default 0,
  primary key (user_id, bucket_start)
);

create table if not exists public.app_settings (
  id                   boolean primary key default true check (id),
  min_qualified_votes  integer not null default 25,
  bayes_prior          numeric(6,4) not null default 3.0,
  bayes_weight         integer not null default 25,
  max_votes_per_minute integer not null default 120,
  max_votes_per_hour   integer not null default 2400
);
insert into public.app_settings (id) values (true) on conflict (id) do nothing;

-- ---------------------------------------------------------------------
-- FUNÇÕES AUXILIARES
-- ---------------------------------------------------------------------
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.user_roles r where r.user_id = auth.uid() and r.role = 'admin');
$$;

create or replace function public.is_banned(p_user uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select p.is_banned from public.profiles p where p.id = p_user), true);
$$;

create or replace function public.assert_admin()
returns void language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
end $$;

create or replace function public.friend_group_ids(p_user uuid)
returns setof uuid language sql stable security definer set search_path = public, pg_temp as $$
  select p_user
  union
  select case when f.requester_id = p_user then f.addressee_id else f.requester_id end
  from public.friendships f
  where f.status = 'accepted' and (f.requester_id = p_user or f.addressee_id = p_user);
$$;

create or replace function public.catalog_matches(
  c public.pokemon_catalog, p_generation integer, p_type text, p_category text, p_search text
) returns boolean language plpgsql immutable set search_path = public, pg_temp as $$
declare
  q text := lower(btrim(coalesce(p_search, '')));
begin
  if p_generation is not null and c.species_generation <> p_generation then return false; end if;
  if p_type is not null and p_type <> '' and p_type is distinct from c.type_1 and p_type is distinct from c.type_2 then
    return false;
  end if;
  if p_category = 'forms' and c.form_category = 'base' then return false; end if;
  if p_category in ('legendary','mythical','paradox') and c.species_class is distinct from p_category then
    return false;
  end if;
  if q <> '' then
    if q ~ '^#?[0-9]{1,4}$' then
      return c.dex_number = ltrim(q, '#')::integer;
    end if;
    return position(q in lower(c.name)) > 0;
  end if;
  return true;
end $$;

-- Recalcula uma linha. O advisory lock serializa escritas no mesmo Pokémon;
-- o agregado só roda depois que a transação concorrente confirmou.
create or replace function public.refresh_pokemon_stats(p_id integer)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  s public.app_settings;
begin
  perform pg_advisory_xact_lock(727001, p_id);
  select * into s from public.app_settings where id;
  insert into public.pokemon_stats as t (pokemon_id, total_votes, panela_votes, sum_score, avg_score, bayesian_score, updated_at)
  select p_id, count(*), count(*) filter (where v.score >= 4), coalesce(sum(v.score), 0), coalesce(avg(v.score), 0),
         (s.bayes_weight * s.bayes_prior + coalesce(sum(v.score), 0)) / (s.bayes_weight + count(*)),
         now()
  from public.votes v
  join public.profiles p on p.id = v.user_id
  where v.pokemon_id = p_id and p.is_qualified and not p.is_banned
  on conflict (pokemon_id) do update set
    total_votes = excluded.total_votes, panela_votes = excluded.panela_votes, sum_score = excluded.sum_score, avg_score = excluded.avg_score,
    bayesian_score = excluded.bayesian_score, updated_at = excluded.updated_at;
end $$;

create or replace function public.refresh_user_stats(p_user uuid, p_extra integer default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r record;
begin
  for r in
    select pokemon_id from public.votes where user_id = p_user
    union
    select p_extra where p_extra is not null
    order by 1
  loop
    perform public.refresh_pokemon_stats(r.pokemon_id);
  end loop;
end $$;

-- Atualiza vote_count/is_qualified; devolve true se a qualificação mudou.
create or replace function public.sync_profile_votes(p_user uuid)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare
  n integer;
  was boolean;
  now_q boolean;
begin
  select is_qualified into was from public.profiles where id = p_user for update;
  if not found then return false; end if;
  select count(*) into n from public.votes where user_id = p_user;
  select n >= min_qualified_votes into now_q from public.app_settings where id;
  update public.profiles set vote_count = n, is_qualified = now_q where id = p_user;
  return was is distinct from now_q;
end $$;

-- ---------------------------------------------------------------------
-- TRIGGERS
-- ---------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_email text := lower(coalesce(new.email, ''));
  v_norm  text;
  v_name  text;
begin
  if v_email !~ '^[a-z0-9_.-]{3,20}@users\.pokemonpanela\.invalid$' then
    raise exception 'invalid_username';
  end if;
  v_norm := split_part(v_email, '@', 1);
  v_name := new.raw_user_meta_data ->> 'username';
  if v_name is null or lower(v_name) <> v_norm then
    v_name := v_norm;
  end if;
  insert into public.profiles (id, username, username_normalized) values (new.id, v_name, v_norm);
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.votes_before_write()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  s public.app_settings;
  v_bucket timestamptz := date_trunc('minute', now());
  v_minute integer;
  v_hour integer;
begin
  if tg_op = 'UPDATE' then
    new.user_id := old.user_id;
    new.pokemon_id := old.pokemon_id;
    new.created_at := old.created_at;
    new.updated_at := now();
  elsif current_setting('panela.bulk_import', true) is distinct from 'on' then
    new.created_at := now();
    new.updated_at := now();
  end if;

  if current_setting('panela.bulk_import', true) = 'on' then
    return new;
  end if;

  select * into s from public.app_settings where id;
  insert into public.vote_rate_buckets as b (user_id, bucket_start, hits)
  values (new.user_id, v_bucket, 1)
  on conflict (user_id, bucket_start) do update set hits = b.hits + 1
  returning hits into v_minute;

  if v_minute = 1 then
    delete from public.vote_rate_buckets
    where user_id = new.user_id and bucket_start < now() - interval '2 hours';
  end if;

  select coalesce(sum(hits), 0) into v_hour from public.vote_rate_buckets
  where user_id = new.user_id and bucket_start > now() - interval '1 hour';

  if v_minute > s.max_votes_per_minute or v_hour > s.max_votes_per_hour then
    raise exception 'rate_limited' using errcode = 'P0001';
  end if;
  return new;
end $$;

drop trigger if exists votes_before_write on public.votes;
create trigger votes_before_write
  before insert or update on public.votes
  for each row execute function public.votes_before_write();

create or replace function public.votes_after_write()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_user uuid;
  v_pokemon integer;
begin
  if current_setting('panela.bulk_import', true) = 'on' then
    return null;
  end if;
  if tg_op = 'DELETE' then
    v_user := old.user_id; v_pokemon := old.pokemon_id;
  else
    v_user := new.user_id; v_pokemon := new.pokemon_id;
  end if;
  if public.sync_profile_votes(v_user) then
    perform public.refresh_user_stats(v_user, v_pokemon);
  else
    perform public.refresh_pokemon_stats(v_pokemon);
  end if;
  return null;
end $$;

drop trigger if exists votes_after_write on public.votes;
create trigger votes_after_write
  after insert or update of score or delete on public.votes
  for each row execute function public.votes_after_write();

-- ---------------------------------------------------------------------
-- RPCs DE USUÁRIO
-- ---------------------------------------------------------------------
create or replace function public.get_my_account()
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'id', p.id, 'username', p.username, 'avatar_id', p.avatar_id, 'bio', p.bio,
    'vote_count', p.vote_count, 'is_qualified', p.is_qualified,
    'is_banned', p.is_banned, 'ban_reason', p.ban_reason, 'is_admin', public.is_admin())
  from public.profiles p where p.id = auth.uid();
$$;

create or replace function public.migrate_guest_votes(p_votes jsonb, p_overwrite boolean default false)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_user uuid := auth.uid();
  v_last timestamptz;
  v_banned boolean;
  v_written integer := 0;
  v_valid integer := 0;
begin
  if v_user is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if jsonb_typeof(p_votes) is distinct from 'array' or jsonb_array_length(p_votes) > 3000 then
    raise exception 'invalid_payload';
  end if;
  select last_migration_at, is_banned into v_last, v_banned from public.profiles where id = v_user for update;
  if v_banned then raise exception 'banned' using errcode = '42501'; end if;
  if v_last is not null and v_last > now() - interval '10 minutes' then
    raise exception 'rate_limited' using errcode = 'P0001';
  end if;

  perform set_config('panela.bulk_import', 'on', true);

  create temporary table _guest_votes on commit drop as
  select distinct on (pid) pid, score, voted_at
  from (
    select (e ->> 'pokemon_id')::integer as pid,
           (e ->> 'score')::smallint as score,
           least(now(), greatest('2024-01-01'::timestamptz,
             case when jsonb_typeof(e -> 't') = 'number'
                       and (e ->> 't')::numeric between 0 and 32503680000000
                  then to_timestamp((e ->> 't')::numeric / 1000) else now() end)) as voted_at
    from jsonb_array_elements(p_votes) e
    where jsonb_typeof(e) = 'object'
      and jsonb_typeof(e -> 'pokemon_id') = 'number'
      and jsonb_typeof(e -> 'score') = 'number'
      and (e ->> 'pokemon_id') ~ '^[0-9]{1,6}$'
      and (e ->> 'score') ~ '^[1-5]$'
  ) x
  join public.pokemon_catalog c on c.pokemon_id = x.pid and c.is_active
  order by pid;

  select count(*) into v_valid from _guest_votes;

  if p_overwrite then
    insert into public.votes as v (user_id, pokemon_id, score, created_at, updated_at)
    select v_user, pid, score, voted_at, voted_at from _guest_votes
    on conflict (user_id, pokemon_id) do update set score = excluded.score;
  else
    insert into public.votes (user_id, pokemon_id, score, created_at, updated_at)
    select v_user, pid, score, voted_at, voted_at from _guest_votes
    on conflict (user_id, pokemon_id) do nothing;
  end if;
  get diagnostics v_written = row_count;

  update public.profiles set last_migration_at = now() where id = v_user;
  perform public.sync_profile_votes(v_user);
  -- Todos os votos da conta: cobre os migrados e os antigos, caso a qualificação tenha mudado.
  perform public.refresh_user_stats(v_user);
  perform set_config('panela.bulk_import', 'off', true);

  return jsonb_build_object('received', jsonb_array_length(p_votes), 'valid', v_valid, 'written', v_written);
end $$;

create or replace function public.search_profiles(p_query text)
returns table (id uuid, username text, avatar_id integer, vote_count integer)
language sql stable security definer set search_path = public, pg_temp as $$
  select p.id, p.username, p.avatar_id, p.vote_count
  from public.profiles p
  where auth.uid() is not null
    and not p.is_banned
    and p.id <> auth.uid()
    and char_length(btrim(coalesce(p_query, ''))) >= 2
    and position(lower(btrim(p_query)) in p.username_normalized) > 0
  order by position(lower(btrim(p_query)) in p.username_normalized), p.username_normalized
  limit 20;
$$;

create or replace function public.get_my_friends()
returns table (friendship_id bigint, status text, direction text, user_id uuid, username text, avatar_id integer, vote_count integer)
language sql stable security definer set search_path = public, pg_temp as $$
  select f.id, f.status,
         case when f.requester_id = auth.uid() then 'outgoing' else 'incoming' end,
         p.id, p.username, p.avatar_id, p.vote_count
  from public.friendships f
  join public.profiles p
    on p.id = case when f.requester_id = auth.uid() then f.addressee_id else f.requester_id end
  where auth.uid() in (f.requester_id, f.addressee_id) and not p.is_banned
  order by f.status, p.username_normalized;
$$;

create or replace function public.send_friend_request(p_user uuid)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_me uuid := auth.uid();
  f public.friendships;
begin
  if v_me is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if public.is_banned(v_me) then raise exception 'banned' using errcode = '42501'; end if;
  if p_user = v_me or public.is_banned(p_user) then raise exception 'invalid_target'; end if;

  select * into f from public.friendships
  where least(requester_id, addressee_id) = least(v_me, p_user)
    and greatest(requester_id, addressee_id) = greatest(v_me, p_user)
  for update;

  if found then
    if f.status = 'accepted' then return 'already_friends'; end if;
    if f.requester_id = v_me then return 'already_sent'; end if;
    update public.friendships set status = 'accepted', responded_at = now() where id = f.id;
    return 'accepted';
  end if;

  if (select count(*) from public.friendships where requester_id = v_me and status = 'pending') >= 50 then
    raise exception 'too_many_requests' using errcode = 'P0001';
  end if;
  insert into public.friendships (requester_id, addressee_id) values (v_me, p_user)
  on conflict do nothing;
  return 'sent';
end $$;

create or replace function public.respond_friend_request(p_friendship_id bigint, p_accept boolean)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_accept then
    update public.friendships set status = 'accepted', responded_at = now()
    where id = p_friendship_id and addressee_id = auth.uid() and status = 'pending';
  else
    delete from public.friendships
    where id = p_friendship_id and addressee_id = auth.uid() and status = 'pending';
  end if;
  if not found then raise exception 'not_found'; end if;
end $$;

create or replace function public.remove_friendship(p_friendship_id bigint)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  delete from public.friendships
  where id = p_friendship_id and auth.uid() in (requester_id, addressee_id);
  if not found then raise exception 'not_found'; end if;
end $$;

-- ---------------------------------------------------------------------
-- RANKINGS
-- ---------------------------------------------------------------------
drop function if exists public.get_global_ranking(integer, text, text, text, integer, integer);
drop function if exists public.get_friends_ranking(integer, integer, text, text, text, integer, integer);

create or replace function public.get_global_ranking(
  p_generation integer default null, p_type text default null, p_category text default null,
  p_search text default null, p_limit integer default 50, p_offset integer default 0, p_sort text default 'score'
) returns table (rank_position bigint, pokemon_id integer, total_votes integer, panela_votes integer, avg_score numeric, bayesian_score numeric, total_count bigint)
language sql stable security definer set search_path = public, pg_temp as $$
  with eligible as (
    select s.pokemon_id, s.total_votes, s.panela_votes, s.avg_score, s.bayesian_score, c as cat,
           row_number() over (order by case when p_sort = 'panela' then s.panela_votes end desc nulls last, s.bayesian_score desc, s.avg_score desc, s.total_votes desc, s.pokemon_id) as rk
    from public.pokemon_stats s
    join public.pokemon_catalog c on c.pokemon_id = s.pokemon_id
    where s.total_votes >= 1 and c.is_active and (p_sort is distinct from 'panela' or s.panela_votes > 0)
  )
  select e.rk, e.pokemon_id, e.total_votes, e.panela_votes, e.avg_score, e.bayesian_score, count(*) over ()
  from eligible e
  where public.catalog_matches(e.cat, p_generation, p_type, p_category, p_search)
  order by e.rk
  limit least(greatest(coalesce(p_limit, 50), 1), 200) offset greatest(coalesce(p_offset, 0), 0);
$$;

create or replace function public.get_friends_ranking(
  p_min_votes integer default 2, p_generation integer default null, p_type text default null,
  p_category text default null, p_search text default null, p_limit integer default 50, p_offset integer default 0, p_sort text default 'score'
) returns table (rank_position bigint, pokemon_id integer, total_votes integer, panela_votes integer, avg_score numeric, total_count bigint)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  return query
  with agg as (
    select v.pokemon_id as pid, count(*)::integer as n, (count(*) filter (where v.score >= 4))::integer as pn, avg(v.score) as a
    from public.votes v
    join public.profiles p on p.id = v.user_id and not p.is_banned
    where v.user_id in (select public.friend_group_ids(auth.uid()))
    group by v.pokemon_id
    having count(*) >= greatest(coalesce(p_min_votes, 2), 1)
  ), ranked as (
    select a.pid, a.n, a.pn, a.a, c as cat,
           row_number() over (order by case when p_sort = 'panela' then a.pn end desc nulls last, a.a desc, a.n desc, a.pid) as rk
    from agg a join public.pokemon_catalog c on c.pokemon_id = a.pid and c.is_active
    where p_sort is distinct from 'panela' or a.pn > 0
  )
  select r.rk, r.pid, r.n, r.pn, round(r.a, 4), count(*) over ()
  from ranked r
  where public.catalog_matches(r.cat, p_generation, p_type, p_category, p_search)
  order by r.rk
  limit least(greatest(coalesce(p_limit, 50), 1), 200) offset greatest(coalesce(p_offset, 0), 0);
end $$;

create or replace function public.get_form_comparison(p_dex integer)
returns table (pokemon_id integer, global_rank bigint, global_avg numeric, global_votes integer,
               friends_rank bigint, friends_avg numeric, friends_votes integer)
language sql stable security definer set search_path = public, pg_temp as $$
  with g as (
    select s.pokemon_id as pid, s.avg_score, s.total_votes,
           row_number() over (order by s.bayesian_score desc, s.avg_score desc, s.total_votes desc, s.pokemon_id) as rk
    from public.pokemon_stats s
    join public.pokemon_catalog c on c.pokemon_id = s.pokemon_id and c.is_active
    where s.total_votes >= 1
  ), f as (
    select v.pokemon_id as pid, count(*)::integer as n, round(avg(v.score), 4) as a,
           row_number() over (order by avg(v.score) desc, count(*) desc, v.pokemon_id) as rk
    from public.votes v
    join public.profiles p on p.id = v.user_id and not p.is_banned
    join public.pokemon_catalog c on c.pokemon_id = v.pokemon_id and c.is_active
    where auth.uid() is not null and v.user_id in (select public.friend_group_ids(auth.uid()))
    group by v.pokemon_id
    having count(*) >= 2
  )
  select c.pokemon_id, g.rk, g.avg_score, g.total_votes, f.rk, f.a, f.n
  from public.pokemon_catalog c
  left join g on g.pid = c.pokemon_id
  left join f on f.pid = c.pokemon_id
  where c.dex_number = p_dex and c.is_active
  order by c.pokemon_id;
$$;

create or replace function public.get_public_profile(p_username text)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  p public.profiles;
  v_result jsonb;
begin
  select * into p from public.profiles
  where username_normalized = lower(btrim(p_username)) and not is_banned;
  if not found then return null; end if;

  with cat as (select * from public.pokemon_catalog where is_active),
  mine as (
    select c.*, v.score, v.updated_at as voted_at
    from public.votes v join cat c on c.pokemon_id = v.pokemon_id
    where v.user_id = p.id
  ),
  gens as (
    select c.species_generation as gen, count(*) as total, count(m.score) as votes, avg(m.score) as avg
    from cat c left join mine m on m.pokemon_id = c.pokemon_id
    group by c.species_generation
  ),
  types as (
    select t.type, count(*) as votes, avg(t.score) as avg
    from (select type_1 as type, score from mine union all select type_2, score from mine where type_2 is not null) t
    group by t.type
  )
  select jsonb_build_object(
    'id', p.id, 'username', p.username, 'avatar_id', p.avatar_id, 'bio', p.bio, 'created_at', p.created_at,
    'stats', jsonb_build_object(
      'voted', (select count(*) from mine),
      'total', (select count(*) from cat),
      'forms_voted', (select count(*) from mine where form_category <> 'base'),
      'special_class_voted', (select count(*) from mine where species_class is not null),
      'distribution', jsonb_build_object(
        '5', (select count(*) from mine where score = 5), '4', (select count(*) from mine where score = 4),
        '3', (select count(*) from mine where score = 3), '2', (select count(*) from mine where score = 2),
        '1', (select count(*) from mine where score = 1)),
      'by_generation', (select coalesce(jsonb_agg(jsonb_build_object('gen', gen, 'total', total, 'votes', votes, 'avg', round(avg, 3)) order by gen), '[]'::jsonb) from gens),
      'by_type', (select coalesce(jsonb_agg(jsonb_build_object('type', type, 'votes', votes, 'avg', round(avg, 3))), '[]'::jsonb) from types),
      'top6', (select coalesce(jsonb_agg(x.pokemon_id), '[]'::jsonb) from (select pokemon_id from mine order by score desc, voted_at desc, pokemon_id limit 6) x)
    )
  ) into v_result;
  return v_result;
end $$;

-- ---------------------------------------------------------------------
-- RPCs ADMINISTRATIVAS
-- ---------------------------------------------------------------------
create or replace function public.admin_log(p_action text, p_target text, p_details jsonb default '{}'::jsonb)
returns void language sql security definer set search_path = public, pg_temp as $$
  insert into public.admin_audit_logs (admin_id, action, target, details) values (auth.uid(), p_action, p_target, p_details);
$$;

create or replace function public.admin_list_users(p_search text default null, p_limit integer default 50, p_offset integer default 0)
returns table (id uuid, username text, vote_count integer, is_qualified boolean, is_banned boolean,
               ban_reason text, banned_at timestamptz, created_at timestamptz, is_admin boolean, total_count bigint)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform public.assert_admin();
  return query
  select p.id, p.username, p.vote_count, p.is_qualified, p.is_banned, p.ban_reason, p.banned_at, p.created_at,
         exists (select 1 from public.user_roles r where r.user_id = p.id and r.role = 'admin'),
         count(*) over ()
  from public.profiles p
  where coalesce(btrim(p_search), '') = '' or position(lower(btrim(p_search)) in p.username_normalized) > 0
  order by p.created_at desc
  limit least(greatest(coalesce(p_limit, 50), 1), 200) offset greatest(coalesce(p_offset, 0), 0);
end $$;

create or replace function public.admin_set_ban(p_user uuid, p_banned boolean, p_reason text default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public.assert_admin();
  if p_user = auth.uid() then raise exception 'cannot_ban_self'; end if;
  update public.profiles
  set is_banned = p_banned,
      ban_reason = case when p_banned then left(p_reason, 300) end,
      banned_at = case when p_banned then now() end
  where id = p_user;
  if not found then raise exception 'not_found'; end if;
  perform public.refresh_user_stats(p_user);
  perform public.admin_log(case when p_banned then 'ban_user' else 'unban_user' end, p_user::text,
                           jsonb_build_object('reason', left(p_reason, 300)));
end $$;

create or replace function public.admin_set_form_active(p_pokemon_id integer, p_active boolean)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public.assert_admin();
  update public.pokemon_catalog set is_active = p_active
  where pokemon_id = p_pokemon_id and form_category <> 'base';
  if not found then raise exception 'not_found_or_base_form'; end if;
  perform public.admin_log('set_form_active', p_pokemon_id::text, jsonb_build_object('active', p_active));
end $$;

create or replace function public.recalculate_all_pokemon_stats()
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  s public.app_settings;
  v_prior numeric;
  v_changed integer;
  v_rows integer;
begin
  perform public.assert_admin();
  perform pg_advisory_xact_lock(727002);

  update public.profiles p
  set vote_count = x.n, is_qualified = x.n >= (select min_qualified_votes from public.app_settings where id)
  from (select pr.id, count(v.pokemon_id)::integer as n
        from public.profiles pr left join public.votes v on v.user_id = pr.id group by pr.id) x
  where p.id = x.id;

  select avg(v.score) into v_prior
  from public.votes v join public.profiles p on p.id = v.user_id
  where p.is_qualified and not p.is_banned;

  update public.app_settings set bayes_prior = round(coalesce(v_prior, 3.0), 4) where id returning * into s;

  with agg as (
    select v.pokemon_id as pid, count(*)::integer as n, (count(*) filter (where v.score >= 4))::integer as pn, sum(v.score)::integer as total, avg(v.score) as a
    from public.votes v join public.profiles p on p.id = v.user_id
    where p.is_qualified and not p.is_banned
    group by v.pokemon_id
  ), computed as (
    select c.pokemon_id, coalesce(a.n, 0) as n, coalesce(a.pn, 0) as pn, coalesce(a.total, 0) as total, coalesce(a.a, 0) as a,
           (s.bayes_weight * s.bayes_prior + coalesce(a.total, 0)) / (s.bayes_weight + coalesce(a.n, 0)) as b
    from public.pokemon_catalog c left join agg a on a.pid = c.pokemon_id
  ), diff as (
    select c.* from computed c left join public.pokemon_stats t on t.pokemon_id = c.pokemon_id
    where coalesce(t.total_votes, 0) <> c.n or coalesce(t.sum_score, 0) <> c.total
  ), up as (
    insert into public.pokemon_stats as t (pokemon_id, total_votes, panela_votes, sum_score, avg_score, bayesian_score, updated_at)
    select pokemon_id, n, pn, total, a, b, now() from computed
    on conflict (pokemon_id) do update set
      total_votes = excluded.total_votes, panela_votes = excluded.panela_votes, sum_score = excluded.sum_score, avg_score = excluded.avg_score,
      bayesian_score = excluded.bayesian_score, updated_at = excluded.updated_at
    returning 1
  )
  select (select count(*) from diff), (select count(*) from up) into v_changed, v_rows;

  perform public.admin_log('recalculate_stats', null,
    jsonb_build_object('rows', v_rows, 'drift_fixed', v_changed, 'prior', s.bayes_prior));
  return jsonb_build_object('rows', v_rows, 'drift_fixed', v_changed, 'prior', s.bayes_prior);
end $$;

create or replace function public.admin_get_audit_logs(p_limit integer default 100, p_offset integer default 0)
returns table (id bigint, admin_username text, action text, target text, details jsonb, created_at timestamptz)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform public.assert_admin();
  return query
  select l.id, p.username, l.action, l.target, l.details, l.created_at
  from public.admin_audit_logs l left join public.profiles p on p.id = l.admin_id
  order by l.id desc
  limit least(greatest(coalesce(p_limit, 100), 1), 500) offset greatest(coalesce(p_offset, 0), 0);
end $$;

-- ---------------------------------------------------------------------
-- ROW LEVEL SECURITY
-- ---------------------------------------------------------------------
alter table public.pokemon_catalog   enable row level security;
alter table public.profiles          enable row level security;
alter table public.user_roles        enable row level security;
alter table public.votes             enable row level security;
alter table public.pokemon_stats     enable row level security;
alter table public.friendships       enable row level security;
alter table public.admin_audit_logs  enable row level security;
alter table public.vote_rate_buckets enable row level security;
alter table public.app_settings      enable row level security;

drop policy if exists catalog_read on public.pokemon_catalog;
create policy catalog_read on public.pokemon_catalog for select to anon, authenticated using (true);

drop policy if exists stats_read on public.pokemon_stats;
create policy stats_read on public.pokemon_stats for select to anon, authenticated using (total_votes >= 1);

drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles for select to anon, authenticated
  using (not is_banned or id = (select auth.uid()));
drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles for update to authenticated
  using (id = (select auth.uid()) and not is_banned)
  with check (id = (select auth.uid()) and not is_banned);

drop policy if exists roles_read_self on public.user_roles;
create policy roles_read_self on public.user_roles for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists votes_read_self on public.votes;
create policy votes_read_self on public.votes for select to authenticated
  using (user_id = (select auth.uid()));
drop policy if exists votes_insert_self on public.votes;
create policy votes_insert_self on public.votes for insert to authenticated
  with check (
    user_id = (select auth.uid()) and not public.is_banned((select auth.uid()))
    and exists (select 1 from public.pokemon_catalog c where c.pokemon_id = votes.pokemon_id and c.is_active)
  );
drop policy if exists votes_update_self on public.votes;
create policy votes_update_self on public.votes for update to authenticated
  using (user_id = (select auth.uid()) and not public.is_banned((select auth.uid())))
  with check (
    user_id = (select auth.uid()) and not public.is_banned((select auth.uid()))
    and exists (select 1 from public.pokemon_catalog c where c.pokemon_id = votes.pokemon_id and c.is_active)
  );
drop policy if exists votes_delete_self on public.votes;
create policy votes_delete_self on public.votes for delete to authenticated
  using (user_id = (select auth.uid()) and not public.is_banned((select auth.uid())));

drop policy if exists friendships_read_own on public.friendships;
create policy friendships_read_own on public.friendships for select to authenticated
  using ((select auth.uid()) in (requester_id, addressee_id));

-- Sem políticas (acesso só via definer): admin_audit_logs, vote_rate_buckets, app_settings.

-- ---------------------------------------------------------------------
-- PRIVILÉGIOS (o Supabase concede ALL por padrão; revogamos e reabrimos)
-- ---------------------------------------------------------------------
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

grant select on public.pokemon_catalog to anon, authenticated;
grant select on public.pokemon_stats to anon, authenticated;
grant select (id, username, avatar_id, bio, vote_count, created_at) on public.profiles to anon, authenticated;
grant update (avatar_id, bio) on public.profiles to authenticated;
grant select on public.user_roles to authenticated;
grant select, insert, update, delete on public.votes to authenticated;
grant select on public.friendships to authenticated;

do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    left join pg_depend d on d.objid = p.oid and d.deptype = 'e'
    where n.nspname = 'public' and p.prokind = 'f' and d.objid is null
  loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
  end loop;
end $$;

grant execute on function public.is_admin() to anon, authenticated;
grant execute on function public.is_banned(uuid) to anon, authenticated;
grant execute on function public.get_global_ranking(integer, text, text, text, integer, integer, text) to anon, authenticated;
grant execute on function public.get_form_comparison(integer) to anon, authenticated;
grant execute on function public.get_public_profile(text) to anon, authenticated;
grant execute on function public.get_my_account() to authenticated;
grant execute on function public.migrate_guest_votes(jsonb, boolean) to authenticated;
grant execute on function public.search_profiles(text) to authenticated;
grant execute on function public.get_my_friends() to authenticated;
grant execute on function public.send_friend_request(uuid) to authenticated;
grant execute on function public.respond_friend_request(bigint, boolean) to authenticated;
grant execute on function public.remove_friendship(bigint) to authenticated;
grant execute on function public.get_friends_ranking(integer, integer, text, text, text, integer, integer, text) to authenticated;
grant execute on function public.admin_list_users(text, integer, integer) to authenticated;
grant execute on function public.admin_set_ban(uuid, boolean, text) to authenticated;
grant execute on function public.admin_set_form_active(integer, boolean) to authenticated;
grant execute on function public.recalculate_all_pokemon_stats() to authenticated;
grant execute on function public.admin_get_audit_logs(integer, integer) to authenticated;

-- ---------------------------------------------------------------------
-- ATUALIZAÇÃO ÚNICA: bancos criados com o mínimo antigo de 20 votos por conta
-- ---------------------------------------------------------------------
do $$
declare
  r record;
begin
  if (select min_qualified_votes from public.app_settings where id) = 20 then
    update public.app_settings set min_qualified_votes = 25 where id;
    update public.profiles set is_qualified = vote_count >= 25;
    for r in select pokemon_id from public.pokemon_catalog order by 1 loop
      perform public.refresh_pokemon_stats(r.pokemon_id);
    end loop;
  end if;
end $$;

commit;
