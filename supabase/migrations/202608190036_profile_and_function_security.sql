-- Protect operator-owned profile fields and make RPC exposure an explicit allowlist.

-- A user may edit only public profile fields. Operational trust and account-state
-- fields remain writable only by trusted server/operator roles.
revoke update on public.profiles from authenticated;
grant update (
  nickname,
  birth_year,
  region_code,
  introduction,
  gender,
  interests,
  avatar_url,
  updated_at
) on public.profiles to authenticated;

-- New functions must be private until a later migration explicitly grants them.
alter default privileges in schema public revoke execute on functions from public;
alter default privileges in schema public revoke execute on functions from anon, authenticated;

-- SECURITY DEFINER bypasses RLS, so remove every implicit API grant first.
do $$
declare
  function_signature regprocedure;
begin
  for function_signature in
    select procedure.oid::regprocedure
    from pg_proc procedure
    join pg_namespace namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public' and procedure.prosecdef
  loop
    execute format(
      'revoke execute on function %s from public, anon, authenticated',
      function_signature
    );
  end loop;
end;
$$;

-- Grant only RPC signatures used by the mobile app or required by RLS.
do $$
declare
  signature text;
  function_oid regprocedure;
  allowed_signatures text[] := array[
    'public.is_room_member(uuid)',
    'public.update_my_location(double precision,double precision,real)',
    'public.discover_conversation_cards(boolean,integer,integer)',
    'public.publish_conversation_card(text,text,text[])',
    'public.update_my_conversation_card(uuid,text,text,text[])',
    'public.delete_my_conversation_card(uuid)',
    'public.create_chat_request(uuid,text)',
    'public.create_board_chat_request(uuid,uuid,text)',
    'public.respond_to_chat_request(uuid,text)',
    'public.mark_room_read(uuid)',
    'public.my_chat_requests()',
    'public.my_chat_rooms()',
    'public.manage_chat_room(uuid,text)',
    'public.my_point_balance()',
    'public.claim_attendance_reward()',
    'public.my_attendance_status()',
    'public.create_board_post(text,text,text)',
    'public.create_board_comment(uuid,text)',
    'public.list_board_posts(integer)',
    'public.list_board_comments(uuid)',
    'public.increment_board_post_view(uuid)',
    'public.toggle_board_post_like(uuid)',
    'public.report_chat_user(uuid,text,text)'
  ];
begin
  foreach signature in array allowed_signatures loop
    function_oid := to_regprocedure(signature);
    if function_oid is not null then
      execute format('grant execute on function %s to authenticated', function_oid);
    end if;
  end loop;
end;
$$;

-- Fail the migration if protected profile columns are accidentally writable.
do $$
begin
  if has_column_privilege('authenticated', 'public.profiles', 'trust_score', 'UPDATE')
     or has_column_privilege('authenticated', 'public.profiles', 'is_verified', 'UPDATE')
     or has_column_privilege('authenticated', 'public.profiles', 'status', 'UPDATE') then
    raise exception 'protected_profile_columns_are_still_writable';
  end if;
end;
$$;

notify pgrst, 'reload schema';
