-- Ejecutar una sola vez en el SQL Editor del proyecto de Supabase.
-- Cada cuenta autenticada solo puede leer y modificar su propia sincronización.

create table if not exists public.speis_sync_state (
  user_id uuid primary key references auth.users(id) on delete cascade,
  payload jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default timezone('utc'::text, now())
);

alter table public.speis_sync_state enable row level security;

revoke all on table public.speis_sync_state from anon;
grant select, insert, update on table public.speis_sync_state to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'speis_sync_state' and policyname = 'speis_sync_select_own') then
    create policy "speis_sync_select_own" on public.speis_sync_state for select to authenticated using ((select auth.uid()) = user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'speis_sync_state' and policyname = 'speis_sync_insert_own') then
    create policy "speis_sync_insert_own" on public.speis_sync_state for insert to authenticated with check ((select auth.uid()) = user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'speis_sync_state' and policyname = 'speis_sync_update_own') then
    create policy "speis_sync_update_own" on public.speis_sync_state for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
  end if;
end
$$;

create or replace function public.set_speis_sync_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = timezone('utc'::text, now());
  return new;
end;
$$;

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'set_speis_sync_updated_at' and tgrelid = 'public.speis_sync_state'::regclass) then
    create trigger set_speis_sync_updated_at before update on public.speis_sync_state for each row execute function public.set_speis_sync_updated_at();
  end if;
end
$$;
