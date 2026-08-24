-- Profile photos remain free to change. Editing identity/details costs 100 points
-- and must happen atomically on the server so the charge cannot be bypassed.

revoke update (nickname, birth_year, gender, interests) on public.profiles from authenticated;

create or replace function public.update_my_profile_details(
  next_nickname text,
  next_birth_year integer,
  next_gender text,
  next_interests text[]
)
returns table (balance bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_nickname text := trim(coalesce(next_nickname, ''));
  normalized_interests text[] := coalesce(next_interests, '{}'::text[]);
  allowed_interests constant text[] := array[
    '대화', '만남', '애인', '영화', '음악', '맛집', '여행', '운동',
    '게임', '반려동물', '독서', '카페', '사진', '전시', '드라마'
  ];
  current_profile public.profiles;
  next_balance bigint;
begin
  if auth.uid() is null then raise exception 'authentication_required'; end if;
  if char_length(normalized_nickname) not between 2 and 12 then raise exception 'invalid_nickname'; end if;
  if next_birth_year not between extract(year from now())::integer - 80 and extract(year from now())::integer - 19 then
    raise exception 'invalid_age';
  end if;
  if next_gender not in ('male', 'female', 'other', 'private') then raise exception 'invalid_gender'; end if;
  if cardinality(normalized_interests) not between 1 and 5
     or exists (select 1 from unnest(normalized_interests) interest where not (interest = any(allowed_interests)))
     or cardinality(normalized_interests) <> cardinality(array(select distinct interest from unnest(normalized_interests) interest)) then
    raise exception 'invalid_interests';
  end if;

  select * into current_profile
  from public.profiles profile
  where profile.id = auth.uid()
  for update;
  if current_profile.id is null then raise exception 'profile_not_found'; end if;
  if current_profile.status <> 'active' then raise exception 'profile_not_active'; end if;

  if current_profile.nickname = normalized_nickname
     and current_profile.birth_year = next_birth_year
     and current_profile.gender = next_gender
     and current_profile.interests = normalized_interests then
    raise exception 'profile_details_unchanged';
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

  update public.conversation_cards
  set interests = normalized_interests
  where author_id = auth.uid() and is_active;

  insert into public.point_transactions(user_id, amount, reason)
  values (auth.uid(), -100, 'profile_details_update');

  return query select next_balance;
end;
$$;

revoke all on function public.update_my_profile_details(text, integer, text, text[]) from public, anon, authenticated;
grant execute on function public.update_my_profile_details(text, integer, text, text[]) to authenticated;

notify pgrst, 'reload schema';
