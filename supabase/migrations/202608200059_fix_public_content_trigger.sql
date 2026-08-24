-- PostgreSQL record fields differ per trigger table; resolve only the active table branch.
create or replace function public.enforce_public_content_filter()
returns trigger language plpgsql security definer set search_path = public as $$
declare content_values text[];
begin
  if tg_table_name = 'conversation_cards' then content_values := array[new.topic];
  elsif tg_table_name = 'board_posts' then content_values := array[new.title, new.body];
  elsif tg_table_name = 'board_comments' then content_values := array[new.body];
  else content_values := array[]::text[];
  end if;
  if public.is_public_content_blocked(content_values) then
    raise exception 'public_content_blocked' using errcode = 'P0001',
      hint = '공개 글에는 불법·유해 표현, 연락처 또는 외부 오픈채팅 링크를 사용할 수 없습니다.';
  end if;
  return new;
end;
$$;

revoke all on function public.enforce_public_content_filter() from public, anon, authenticated;
notify pgrst, 'reload schema';
