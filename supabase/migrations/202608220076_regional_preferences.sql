-- Keep display language independent from service country so travelers and
-- multilingual users can choose each setting separately.
alter table public.profiles
  add column if not exists language_code text not null default 'ko'
    check (language_code in ('ko', 'en')),
  add column if not exists country_code text not null default 'KR'
    check (country_code in ('KR', 'US'));

revoke update (language_code, country_code) on public.profiles from authenticated;

create or replace function public.update_my_regional_preferences(next_language text, next_country text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if next_language not in ('ko', 'en') or next_country not in ('KR', 'US') then
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
