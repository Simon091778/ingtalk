alter table public.board_posts add column if not exists anonymous_name text;
alter table public.board_posts add column if not exists anonymous_gender text;
alter table public.board_comments add column if not exists anonymous_name text;
alter table public.board_comments add column if not exists anonymous_gender text;

create or replace function public.generate_board_alias(profile_gender text)
returns text language plpgsql volatile set search_path = public as $$
declare
  male_names text[] := array['푸른하늘','파란고래','푸른바다','파란여우','푸른별빛','파란구름','푸른나무','파란새'];
  female_names text[] := array['붉은노을','빨간장미','붉은여우','빨간사과','붉은별빛','빨간구름','붉은튤립','빨간새'];
  neutral_names text[] := array['익명달빛','익명바람','익명나무','익명구름','익명별빛','익명여우'];
begin
  if profile_gender = 'male' then return male_names[1 + floor(random() * array_length(male_names, 1))::int]; end if;
  if profile_gender = 'female' then return female_names[1 + floor(random() * array_length(female_names, 1))::int]; end if;
  return neutral_names[1 + floor(random() * array_length(neutral_names, 1))::int];
end;
$$;

update public.board_posts post
set anonymous_gender = case when profile.gender in ('male','female') then profile.gender else 'neutral' end,
    anonymous_name = public.generate_board_alias(profile.gender)
from public.profiles profile
where profile.id = post.author_id and post.anonymous_name is null;

update public.board_comments comment
set anonymous_gender = post.anonymous_gender,
    anonymous_name = post.anonymous_name
from public.board_posts post
where post.id = comment.post_id and post.author_id = comment.author_id and comment.anonymous_name is null;

update public.board_comments comment
set anonymous_gender = case when profile.gender in ('male','female') then profile.gender else 'neutral' end,
    anonymous_name = public.generate_board_alias(profile.gender)
from public.profiles profile
where profile.id = comment.author_id and comment.anonymous_name is null;

alter table public.board_posts alter column anonymous_name set not null;
alter table public.board_posts alter column anonymous_gender set not null;
alter table public.board_comments alter column anonymous_name set not null;
alter table public.board_comments alter column anonymous_gender set not null;

drop policy if exists "users create board posts" on public.board_posts;
drop policy if exists "users create board comments" on public.board_comments;
revoke insert on public.board_posts, public.board_comments from authenticated;

create or replace function public.create_board_post(post_body text)
returns uuid language plpgsql security definer set search_path = public as $$
declare profile_gender text; post_uuid uuid; previous_alias text; new_alias text;
begin
  if auth.uid() is null then raise exception 'authentication_required'; end if;
  if char_length(trim(post_body)) not between 1 and 500 then raise exception 'invalid_post_length'; end if;
  select gender into profile_gender from public.profiles where id = auth.uid() and status = 'active';
  if not found then raise exception 'active_profile_required'; end if;
  select anonymous_name into previous_alias from public.board_posts
  where author_id = auth.uid() order by created_at desc limit 1;
  loop
    new_alias := public.generate_board_alias(profile_gender);
    exit when previous_alias is null or new_alias <> previous_alias;
  end loop;
  insert into public.board_posts(author_id, body, anonymous_name, anonymous_gender)
  values (auth.uid(), trim(post_body), new_alias,
    case when profile_gender in ('male','female') then profile_gender else 'neutral' end)
  returning id into post_uuid;
  return post_uuid;
end;
$$;

create or replace function public.create_board_comment(post_uuid uuid, comment_body text)
returns uuid language plpgsql security definer set search_path = public as $$
declare target_post public.board_posts; profile_gender text; alias_name text; alias_gender text; comment_uuid uuid;
begin
  if auth.uid() is null then raise exception 'authentication_required'; end if;
  if char_length(trim(comment_body)) not between 1 and 300 then raise exception 'invalid_comment_length'; end if;
  select * into target_post from public.board_posts where id = post_uuid;
  if target_post.id is null then raise exception 'post_not_found'; end if;

  if target_post.author_id = auth.uid() then
    alias_name := target_post.anonymous_name;
    alias_gender := target_post.anonymous_gender;
  else
    select anonymous_name, anonymous_gender into alias_name, alias_gender
    from public.board_comments where post_id = post_uuid and author_id = auth.uid()
    order by created_at asc limit 1;
    if alias_name is null then
      select gender into profile_gender from public.profiles where id = auth.uid() and status = 'active';
      if not found then raise exception 'active_profile_required'; end if;
      alias_name := public.generate_board_alias(profile_gender);
      alias_gender := case when profile_gender in ('male','female') then profile_gender else 'neutral' end;
    end if;
  end if;

  insert into public.board_comments(post_id, author_id, body, anonymous_name, anonymous_gender)
  values (post_uuid, auth.uid(), trim(comment_body), alias_name, alias_gender)
  returning id into comment_uuid;
  return comment_uuid;
end;
$$;

drop function if exists public.list_board_posts(integer);
create function public.list_board_posts(result_limit integer default 100)
returns table (id uuid, author_id uuid, nickname text, gender text, body text, created_at timestamptz, comment_count bigint)
language sql stable security definer set search_path = public as $$
  select p.id, p.author_id, p.anonymous_name, p.anonymous_gender, p.body, p.created_at,
    (select count(*) from public.board_comments c where c.post_id = p.id)
  from public.board_posts p order by p.created_at desc
  limit least(greatest(result_limit, 1), 100);
$$;

drop function if exists public.list_board_comments(uuid);
create function public.list_board_comments(post_uuid uuid)
returns table (id uuid, author_id uuid, nickname text, gender text, body text, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  select c.id, c.author_id, c.anonymous_name, c.anonymous_gender, c.body, c.created_at
  from public.board_comments c where c.post_id = post_uuid order by c.created_at asc;
$$;

revoke all on function public.generate_board_alias(text) from public;
revoke all on function public.create_board_post(text) from public;
grant execute on function public.create_board_post(text) to authenticated;
revoke all on function public.create_board_comment(uuid, text) from public;
grant execute on function public.create_board_comment(uuid, text) to authenticated;
revoke all on function public.list_board_posts(integer) from public;
grant execute on function public.list_board_posts(integer) to authenticated;
revoke all on function public.list_board_comments(uuid) from public;
grant execute on function public.list_board_comments(uuid) to authenticated;
notify pgrst, 'reload schema';
