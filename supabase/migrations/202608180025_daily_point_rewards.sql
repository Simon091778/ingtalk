-- Four independent rolling 24-hour rewards worth 50 points each.

create table if not exists public.point_reward_claims (
  user_id uuid not null references public.profiles(id) on delete cascade,
  reward_type text not null check (reward_type in ('attendance', 'talk_write', 'board_post', 'board_comment')),
  claimed_at timestamptz not null,
  primary key (user_id, reward_type)
);

alter table public.point_reward_claims enable row level security;
drop policy if exists "users read own reward claims" on public.point_reward_claims;
create policy "users read own reward claims" on public.point_reward_claims for select to authenticated using (user_id = auth.uid());
revoke all on public.point_reward_claims from authenticated;
grant select on public.point_reward_claims to authenticated;

create or replace function public.award_daily_action(reward_key text, reward_reference uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare last_claim timestamptz;
begin
  if auth.uid() is null then raise exception 'authentication_required'; end if;
  if reward_key not in ('talk_write', 'board_post', 'board_comment') then raise exception 'invalid_reward_type'; end if;
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text || ':' || reward_key, 0));
  select claimed_at into last_claim from public.point_reward_claims where user_id = auth.uid() and reward_type = reward_key;
  if last_claim is not null and last_claim > now() - interval '24 hours' then return false; end if;
  insert into public.point_reward_claims(user_id, reward_type, claimed_at) values (auth.uid(), reward_key, now())
  on conflict (user_id, reward_type) do update set claimed_at = excluded.claimed_at;
  update public.point_wallets set balance = balance + 50, updated_at = now() where user_id = auth.uid();
  if not found then raise exception 'point_wallet_not_found'; end if;
  insert into public.point_transactions(user_id, amount, reason, reference_id)
  values (auth.uid(), 50, 'reward_' || reward_key, reward_reference);
  return true;
end;
$$;
revoke all on function public.award_daily_action(text, uuid) from public;

create or replace function public.claim_attendance_reward()
returns table (awarded boolean, balance bigint, next_available_at timestamptz)
language plpgsql security definer set search_path = public as $$
declare last_claim timestamptz; did_award boolean := false;
begin
  if auth.uid() is null then raise exception 'authentication_required'; end if;
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text || ':attendance', 0));
  select claimed_at into last_claim from public.point_reward_claims where user_id = auth.uid() and reward_type = 'attendance';
  if last_claim is null or last_claim <= now() - interval '24 hours' then
    insert into public.point_reward_claims(user_id, reward_type, claimed_at) values (auth.uid(), 'attendance', now())
    on conflict (user_id, reward_type) do update set claimed_at = excluded.claimed_at;
    update public.point_wallets set balance = point_wallets.balance + 50, updated_at = now() where user_id = auth.uid();
    if not found then raise exception 'point_wallet_not_found'; end if;
    insert into public.point_transactions(user_id, amount, reason) values (auth.uid(), 50, 'reward_attendance');
    last_claim := now();
    did_award := true;
  end if;
  return query select did_award, coalesce((select wallet.balance from public.point_wallets wallet where wallet.user_id = auth.uid()), 0), last_claim + interval '24 hours';
end;
$$;
revoke all on function public.claim_attendance_reward() from public;
grant execute on function public.claim_attendance_reward() to authenticated;

create or replace function public.my_attendance_status()
returns table (available boolean, next_available_at timestamptz)
language sql stable security definer set search_path = public as $$
  select claim.claimed_at is null or claim.claimed_at <= now() - interval '24 hours',
         case when claim.claimed_at is null then now() else claim.claimed_at + interval '24 hours' end
  from (select (select claimed_at from public.point_reward_claims where user_id = auth.uid() and reward_type = 'attendance') as claimed_at) claim;
$$;
revoke all on function public.my_attendance_status() from public;
grant execute on function public.my_attendance_status() to authenticated;

create or replace function public.publish_conversation_card(card_purpose text, card_topic text, card_interests text[] default '{}')
returns uuid language plpgsql security definer set search_path = public as $$
declare new_card_id uuid;
begin
  if auth.uid() is null then raise exception 'authentication_required'; end if;
  if not exists (select 1 from public.profiles where id = auth.uid() and status = 'active') then raise exception 'active_profile_required'; end if;
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text, 0));
  update public.conversation_cards set is_active = false where author_id = auth.uid() and is_active;
  insert into public.conversation_cards(author_id, purpose, topic, interests, is_active, created_at, expires_at)
  values (auth.uid(), card_purpose, card_topic, coalesce(card_interests, '{}'), true, now(), now() + interval '24 hours')
  returning id into new_card_id;
  perform public.award_daily_action('talk_write', new_card_id);
  return new_card_id;
end;
$$;
revoke all on function public.publish_conversation_card(text, text, text[]) from public;
grant execute on function public.publish_conversation_card(text, text, text[]) to authenticated;

create or replace function public.create_board_post(post_title text, post_body text, post_image_url text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare profile_gender text; post_uuid uuid; previous_alias text; new_alias text;
begin
  if auth.uid() is null then raise exception 'authentication_required'; end if;
  if char_length(trim(post_title)) not between 1 and 60 then raise exception 'invalid_post_title'; end if;
  if char_length(trim(post_body)) not between 1 and 500 then raise exception 'invalid_post_length'; end if;
  select gender into profile_gender from public.profiles where id = auth.uid() and status = 'active';
  if not found then raise exception 'active_profile_required'; end if;
  select anonymous_name into previous_alias from public.board_posts where author_id = auth.uid() order by created_at desc limit 1;
  loop new_alias := public.generate_board_alias(profile_gender); exit when previous_alias is null or new_alias <> previous_alias; end loop;
  insert into public.board_posts(author_id, title, body, image_url, anonymous_name, anonymous_gender)
  values (auth.uid(), trim(post_title), trim(post_body), nullif(trim(post_image_url), ''), new_alias, case when profile_gender in ('male','female') then profile_gender else 'neutral' end)
  returning id into post_uuid;
  perform public.award_daily_action('board_post', post_uuid);
  return post_uuid;
end;
$$;
revoke all on function public.create_board_post(text, text, text) from public;
grant execute on function public.create_board_post(text, text, text) to authenticated;

create or replace function public.create_board_comment(post_uuid uuid, comment_body text)
returns uuid language plpgsql security definer set search_path = public as $$
declare target_post public.board_posts; profile_gender text; alias_name text; alias_gender text; comment_uuid uuid;
begin
  if auth.uid() is null then raise exception 'authentication_required'; end if;
  if char_length(trim(comment_body)) not between 1 and 300 then raise exception 'invalid_comment_length'; end if;
  select * into target_post from public.board_posts where id = post_uuid;
  if target_post.id is null then raise exception 'post_not_found'; end if;
  if target_post.author_id = auth.uid() then
    alias_name := target_post.anonymous_name; alias_gender := target_post.anonymous_gender;
  else
    select anonymous_name, anonymous_gender into alias_name, alias_gender from public.board_comments where post_id = post_uuid and author_id = auth.uid() order by created_at asc limit 1;
    if alias_name is null then
      select gender into profile_gender from public.profiles where id = auth.uid() and status = 'active';
      if not found then raise exception 'active_profile_required'; end if;
      alias_name := public.generate_board_alias(profile_gender);
      alias_gender := case when profile_gender in ('male','female') then profile_gender else 'neutral' end;
    end if;
  end if;
  insert into public.board_comments(post_id, author_id, body, anonymous_name, anonymous_gender)
  values (post_uuid, auth.uid(), trim(comment_body), alias_name, alias_gender) returning id into comment_uuid;
  perform public.award_daily_action('board_comment', comment_uuid);
  return comment_uuid;
end;
$$;
revoke all on function public.create_board_comment(uuid, text) from public;
grant execute on function public.create_board_comment(uuid, text) to authenticated;
notify pgrst, 'reload schema';
