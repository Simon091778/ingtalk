-- Edit an active card in place so request/chat references remain valid.
create or replace function public.update_my_conversation_card(
  card_uuid uuid,
  card_purpose text,
  card_topic text,
  card_interests text[] default '{}'
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'authentication_required'; end if;

  update public.conversation_cards
  set purpose = card_purpose,
      topic = trim(card_topic),
      interests = coalesce(card_interests, '{}'),
      created_at = now(),
      expires_at = now() + interval '24 hours'
  where id = card_uuid
    and author_id = auth.uid()
    and is_active
  returning id into card_uuid;

  if card_uuid is null then raise exception 'card_not_available'; end if;
  return card_uuid;
end;
$$;

revoke all on function public.update_my_conversation_card(uuid, text, text, text[]) from public;
grant execute on function public.update_my_conversation_card(uuid, text, text, text[]) to authenticated;

notify pgrst, 'reload schema';
