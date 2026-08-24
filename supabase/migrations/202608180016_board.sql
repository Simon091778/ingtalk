create table if not exists public.board_posts (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references public.profiles(id) on delete cascade,
  body text not null check (char_length(trim(body)) between 1 and 500),
  created_at timestamptz not null default now()
);

create table if not exists public.board_comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.board_posts(id) on delete cascade,
  author_id uuid not null references public.profiles(id) on delete cascade,
  body text not null check (char_length(trim(body)) between 1 and 300),
  created_at timestamptz not null default now()
);

create index if not exists board_posts_created_idx on public.board_posts(created_at desc);
create index if not exists board_comments_post_idx on public.board_comments(post_id, created_at);
alter table public.board_posts enable row level security;
alter table public.board_comments enable row level security;

drop policy if exists "authenticated read board posts" on public.board_posts;
create policy "authenticated read board posts" on public.board_posts for select to authenticated using (true);
drop policy if exists "users create board posts" on public.board_posts;
create policy "users create board posts" on public.board_posts for insert to authenticated with check (author_id = auth.uid());
drop policy if exists "users delete own board posts" on public.board_posts;
create policy "users delete own board posts" on public.board_posts for delete to authenticated using (author_id = auth.uid());

drop policy if exists "authenticated read board comments" on public.board_comments;
create policy "authenticated read board comments" on public.board_comments for select to authenticated using (true);
drop policy if exists "users create board comments" on public.board_comments;
create policy "users create board comments" on public.board_comments for insert to authenticated with check (author_id = auth.uid());
drop policy if exists "users delete own board comments" on public.board_comments;
create policy "users delete own board comments" on public.board_comments for delete to authenticated using (author_id = auth.uid());

grant select, insert, delete on public.board_posts, public.board_comments to authenticated;

create or replace function public.list_board_posts(result_limit integer default 100)
returns table (id uuid, author_id uuid, nickname text, body text, created_at timestamptz, comment_count bigint)
language sql stable security definer set search_path = public as $$
  select p.id, p.author_id, profile.nickname, p.body, p.created_at,
    (select count(*) from public.board_comments c where c.post_id = p.id)
  from public.board_posts p
  join public.profiles profile on profile.id = p.author_id and profile.status = 'active'
  order by p.created_at desc
  limit least(greatest(result_limit, 1), 100);
$$;

create or replace function public.list_board_comments(post_uuid uuid)
returns table (id uuid, author_id uuid, nickname text, body text, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  select c.id, c.author_id, profile.nickname, c.body, c.created_at
  from public.board_comments c
  join public.profiles profile on profile.id = c.author_id and profile.status = 'active'
  where c.post_id = post_uuid
  order by c.created_at asc;
$$;

revoke all on function public.list_board_posts(integer) from public;
grant execute on function public.list_board_posts(integer) to authenticated;
revoke all on function public.list_board_comments(uuid) from public;
grant execute on function public.list_board_comments(uuid) to authenticated;

do $$ begin alter publication supabase_realtime add table public.board_posts; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.board_comments; exception when duplicate_object then null; end $$;
notify pgrst, 'reload schema';
