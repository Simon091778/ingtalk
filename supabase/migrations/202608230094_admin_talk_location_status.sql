-- Let reviewers confirm whether a talk has a write-time location snapshot
-- without exposing exact coordinates or accuracy information.
create function public.admin_list_user_talk_location_status(target_user_uuid uuid)
returns table (card_id uuid, location_captured_at timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.admin_has_role('reviewer') then raise exception 'admin_required'; end if;
  if not exists (select 1 from public.profiles where id = target_user_uuid) then raise exception 'user_not_found'; end if;

  return query
  select card.id, location.captured_at
  from public.conversation_cards card
  left join public.conversation_card_locations location on location.card_id = card.id
  where card.author_id = target_user_uuid
  order by card.created_at desc
  limit 30;
end;
$$;

revoke all on function public.admin_list_user_talk_location_status(uuid) from public, anon, authenticated;
grant execute on function public.admin_list_user_talk_location_status(uuid) to authenticated;
notify pgrst, 'reload schema';
