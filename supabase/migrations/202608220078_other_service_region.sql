-- Allow users outside the first two launch countries to use a neutral global
-- service region while keeping language and service country independent.
alter table public.profiles drop constraint if exists profiles_country_code_check;
alter table public.profiles add constraint profiles_country_code_check
  check (country_code in ('KR', 'US', 'OTHER'));

create or replace function public.update_my_regional_preferences(next_language text, next_country text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if next_language not in ('ko', 'en') or next_country not in ('KR', 'US', 'OTHER') then
    raise exception 'invalid_regional_preferences';
  end if;
  update public.profiles
  set language_code = next_language, country_code = next_country, updated_at = now()
  where id = auth.uid();
  if not found then raise exception 'profile_not_found'; end if;
end;
$$;

revoke all on function public.update_my_regional_preferences(text, text) from public;
grant execute on function public.update_my_regional_preferences(text, text) to authenticated;
