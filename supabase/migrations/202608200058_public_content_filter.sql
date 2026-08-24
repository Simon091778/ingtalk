-- Minimal server-side filtering for content shown in public feeds.
-- Private 1:1 messages are intentionally outside this release-scope filter.

create table if not exists public.public_content_block_terms (
  term text primary key check (term = lower(term) and term !~ '[^[:alnum:]가-힣]'),
  category text not null check (category in ('sexual_illegal', 'illegal_goods', 'harassment', 'external_contact')),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.public_content_block_terms enable row level security;
revoke all on public.public_content_block_terms from anon, authenticated;

insert into public.public_content_block_terms(term, category) values
  ('성매매', 'sexual_illegal'), ('조건만남', 'sexual_illegal'),
  ('원조교제', 'sexual_illegal'), ('아청물', 'sexual_illegal'),
  ('아동성착취', 'sexual_illegal'), ('불법촬영물', 'sexual_illegal'),
  ('몰카판매', 'sexual_illegal'), ('마약판매', 'illegal_goods'),
  ('필로폰판매', 'illegal_goods'), ('대마판매', 'illegal_goods'),
  ('씨발', 'harassment'), ('개새끼', 'harassment'),
  ('openkakaocom', 'external_contact')
on conflict (term) do update set category = excluded.category, is_active = true;

create or replace function public.is_public_content_blocked(contents text[])
returns boolean language sql stable security definer set search_path = public as $$
  with supplied as (
    select coalesce(value, '') as raw,
           regexp_replace(lower(coalesce(value, '')), '[^[:alnum:]가-힣]+', '', 'g') as normalized
    from unnest(coalesce(contents, array[]::text[])) as value
  )
  select exists (
    select 1 from supplied content
    where content.raw ~ '(^|[^0-9])01[016789][ -]?[0-9]{3,4}[ -]?[0-9]{4}([^0-9]|$)'
       or exists (
         select 1 from public.public_content_block_terms blocked
         where blocked.is_active and content.normalized like '%' || blocked.term || '%'
       )
  );
$$;

revoke all on function public.is_public_content_blocked(text[]) from public, anon, authenticated;

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

drop trigger if exists conversation_cards_public_content_filter on public.conversation_cards;
create trigger conversation_cards_public_content_filter before insert or update of topic on public.conversation_cards
for each row execute function public.enforce_public_content_filter();

drop trigger if exists board_posts_public_content_filter on public.board_posts;
create trigger board_posts_public_content_filter before insert or update of title, body on public.board_posts
for each row execute function public.enforce_public_content_filter();

drop trigger if exists board_comments_public_content_filter on public.board_comments;
create trigger board_comments_public_content_filter before insert or update of body on public.board_comments
for each row execute function public.enforce_public_content_filter();

notify pgrst, 'reload schema';
