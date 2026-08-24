-- Soft-delete an owned active card so chat and request history remains intact.
create or replace function public.delete_my_conversation_card(card_uuid uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'authentication_required'; end if;

  update public.conversation_cards
  set is_active = false
  where id = card_uuid
    and author_id = auth.uid()
    and is_active;

  if not found then raise exception 'card_not_available'; end if;
end;
$$;

revoke all on function public.delete_my_conversation_card(uuid) from public;
grant execute on function public.delete_my_conversation_card(uuid) to authenticated;

notify pgrst, 'reload schema';
