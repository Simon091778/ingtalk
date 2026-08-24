-- Guest profile fields and policies for Supabase anonymous authentication.
alter table public.profiles
  add column if not exists gender text,
  add column if not exists interests text[] not null default '{}';

alter table public.profiles
  alter column region_code set default 'UNSET';

alter table public.profiles
  drop constraint if exists profiles_gender_check;

alter table public.profiles
  add constraint profiles_gender_check
  check (gender in ('male', 'female', 'other', 'private'));

drop policy if exists "users create own profile" on public.profiles;
create policy "users create own profile"
on public.profiles for insert
to authenticated
with check (id = auth.uid());

grant select, insert, update on public.profiles to authenticated;

