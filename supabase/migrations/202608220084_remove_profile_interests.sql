-- Remove profile interests from the active product contract. The legacy columns
-- remain temporarily for rollback compatibility, but all existing values are
-- erased and every current write path stores an empty array.

update public.profiles set interests = '{}' where cardinality(interests) > 0;
update public.conversation_cards set interests = '{}' where cardinality(interests) > 0;

comment on column public.profiles.interests is 'Deprecated; profile interests were removed in migration 084.';
comment on column public.conversation_cards.interests is 'Deprecated; profile interests were removed in migration 084.';

drop function if exists public.update_my_profile_details(text, integer, text, text[]);
create function public.update_my_profile_details(
  next_nickname text,
  next_birth_year integer,
  next_gender text
)
returns table (balance bigint)
language plpgsql security definer set search_path = public as $$
declare
  normalized_nickname text := trim(coalesce(next_nickname, ''));
  current_profile public.profiles;
  next_balance bigint;
begin
  if auth.uid() is null then raise exception 'authentication_required'; end if;
  if char_length(normalized_nickname) not between 2 and 9 then raise exception 'invalid_nickname'; end if;
  if next_birth_year not between extract(year from now())::integer - 80 and extract(year from now())::integer - 19 then raise exception 'invalid_age'; end if;
  if next_gender not in ('male', 'female', 'other', 'private') then raise exception 'invalid_gender'; end if;

  select * into current_profile from public.profiles where id = auth.uid() for update;
  if current_profile.id is null then raise exception 'profile_not_found'; end if;
  if current_profile.status <> 'active' then raise exception 'profile_not_active'; end if;
  if current_profile.nickname = normalized_nickname and current_profile.birth_year = next_birth_year and current_profile.gender = next_gender then
    raise exception 'profile_details_unchanged';
  end if;

  update public.point_wallets wallet set balance = wallet.balance - 100, updated_at = now()
  where wallet.user_id = auth.uid() and wallet.balance >= 100 returning wallet.balance into next_balance;
  if next_balance is null then raise exception 'insufficient_points'; end if;

  update public.profiles set nickname = normalized_nickname, birth_year = next_birth_year,
    gender = next_gender, interests = '{}', updated_at = now() where id = auth.uid();
  update public.conversation_cards set interests = '{}' where author_id = auth.uid() and is_active;
  insert into public.point_transactions(user_id, amount, reason) values (auth.uid(), -100, 'profile_details_update');
  return query select next_balance;
end;
$$;
revoke all on function public.update_my_profile_details(text, integer, text) from public, anon;
grant execute on function public.update_my_profile_details(text, integer, text) to authenticated;

drop function if exists public.update_profile_details(text, integer, text, text[]);

drop function if exists public.publish_conversation_card(text, text, text[]);
create function public.publish_conversation_card(card_purpose text, card_topic text)
returns uuid language plpgsql security definer set search_path = public as $$
declare new_card_id uuid;
begin
  if auth.uid() is null then raise exception 'authentication_required'; end if;
  if not exists (select 1 from public.profiles where id = auth.uid() and status = 'active') then raise exception 'active_profile_required'; end if;
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text, 0));
  update public.conversation_cards set is_active = false where author_id = auth.uid() and is_active;
  insert into public.conversation_cards(author_id, purpose, topic, interests, is_active, created_at, expires_at)
  values (auth.uid(), card_purpose, card_topic, '{}', true, now(), now() + interval '24 hours') returning id into new_card_id;
  perform public.award_daily_action('talk_write', new_card_id);
  return new_card_id;
end;
$$;
revoke all on function public.publish_conversation_card(text, text) from public, anon;
grant execute on function public.publish_conversation_card(text, text) to authenticated;

drop function if exists public.update_my_conversation_card(uuid, text, text, text[]);
create function public.update_my_conversation_card(card_uuid uuid, card_purpose text, card_topic text)
returns uuid language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'authentication_required'; end if;
  update public.conversation_cards set purpose = card_purpose, topic = trim(card_topic), interests = '{}',
    created_at = now(), expires_at = now() + interval '24 hours'
  where id = card_uuid and author_id = auth.uid() and is_active returning id into card_uuid;
  if card_uuid is null then raise exception 'card_not_available'; end if;
  return card_uuid;
end;
$$;
revoke all on function public.update_my_conversation_card(uuid, text, text) from public, anon;
grant execute on function public.update_my_conversation_card(uuid, text, text) to authenticated;

notify pgrst, 'reload schema';
