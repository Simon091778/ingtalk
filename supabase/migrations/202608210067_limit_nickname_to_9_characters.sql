-- Limit newly created or changed nicknames to 9 characters.
-- Existing 10-12 character nicknames remain readable and can still receive
-- unrelated profile updates, such as avatar changes.

create or replace function public.enforce_nickname_length()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if char_length(trim(new.nickname)) not between 2 and 9 then
    raise exception 'invalid_nickname';
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_profile_nickname_length_on_insert on public.profiles;
create trigger enforce_profile_nickname_length_on_insert
before insert on public.profiles
for each row
execute function public.enforce_nickname_length();

drop trigger if exists enforce_profile_nickname_length_on_update on public.profiles;
create trigger enforce_profile_nickname_length_on_update
before update of nickname on public.profiles
for each row
when (old.nickname is distinct from new.nickname)
execute function public.enforce_nickname_length();

create or replace function public.update_profile_details(
  next_nickname text,
  next_birth_year integer,
  next_gender text,
  next_interests text[]
)
returns table (charged boolean, balance bigint)
language plpgsql security definer set search_path = public as $$
declare
  normalized_nickname text := trim(coalesce(next_nickname, ''));
  normalized_interests text[] := coalesce(next_interests, '{}');
  current_profile public.profiles;
  next_balance bigint;
begin
  if auth.uid() is null then raise exception 'authentication_required'; end if;
  if char_length(normalized_nickname) not between 2 and 9 then raise exception 'invalid_nickname'; end if;
  if next_birth_year not between extract(year from now())::integer - 80 and extract(year from now())::integer - 19 then
    raise exception 'invalid_age';
  end if;
  if next_gender not in ('male', 'female', 'other', 'private') then raise exception 'invalid_gender'; end if;
  if cardinality(normalized_interests) not between 1 and 5 then raise exception 'invalid_interests'; end if;
  if exists (select 1 from unnest(normalized_interests) interest where char_length(trim(interest)) not between 1 and 30) then
    raise exception 'invalid_interests';
  end if;

  select * into current_profile from public.profiles where id = auth.uid() and status = 'active' for update;
  if not found then raise exception 'active_profile_required'; end if;

  if current_profile.nickname = normalized_nickname
     and current_profile.birth_year = next_birth_year
     and current_profile.gender = next_gender
     and current_profile.interests = normalized_interests then
    return query select false, coalesce((select wallet.balance from public.point_wallets wallet where wallet.user_id = auth.uid()), 0);
    return;
  end if;

  update public.point_wallets wallet
  set balance = wallet.balance - 100, updated_at = now()
  where wallet.user_id = auth.uid() and wallet.balance >= 100
  returning wallet.balance into next_balance;
  if next_balance is null then raise exception 'insufficient_points'; end if;

  update public.profiles
  set nickname = normalized_nickname,
      birth_year = next_birth_year,
      gender = next_gender,
      interests = normalized_interests,
      updated_at = now()
  where id = auth.uid();

  insert into public.point_transactions(user_id, amount, reason)
  values (auth.uid(), -100, 'profile_details_update');

  return query select true, next_balance;
end;
$$;

revoke all on function public.update_profile_details(text, integer, text, text[]) from public, anon;
grant execute on function public.update_profile_details(text, integer, text, text[]) to authenticated;
notify pgrst, 'reload schema';
