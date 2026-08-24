-- Report an anonymous board post author or commenter with a content snapshot.

create or replace function public.report_board_content(
  content_type text,
  content_uuid uuid,
  reason_code text default 'inappropriate'
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  target_user_uuid uuid;
  evidence jsonb;
  report_uuid uuid;
begin
  if auth.uid() is null then raise exception 'authentication_required'; end if;
  if content_type not in ('post', 'comment') then raise exception 'invalid_content_type'; end if;
  if reason_code not in ('inappropriate', 'spam', 'harassment', 'fraud', 'sexual', 'other') then
    raise exception 'invalid_report_reason';
  end if;

  if content_type = 'post' then
    select author_id, jsonb_build_object(
      'id', id, 'title', title, 'body', body, 'image_url', image_url,
      'anonymous_name', anonymous_name, 'created_at', created_at
    ) into target_user_uuid, evidence
    from public.board_posts where id = content_uuid;
  else
    select author_id, jsonb_build_object(
      'id', id, 'post_id', post_id, 'body', body,
      'anonymous_name', anonymous_name, 'created_at', created_at
    ) into target_user_uuid, evidence
    from public.board_comments where id = content_uuid;
  end if;

  if target_user_uuid is null then raise exception 'content_not_found'; end if;
  if target_user_uuid = auth.uid() then raise exception 'cannot_report_self'; end if;

  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text || content_type || content_uuid::text, 0));
  if exists (
    select 1 from public.reports
    where reporter_id = auth.uid()
      and target_type = content_type
      and content_snapshot ->> 'id' = content_uuid::text
  ) then raise exception 'report_already_exists'; end if;

  insert into public.reports(
    reporter_id, reported_user_id, reason, details,
    target_type, content_snapshot, priority
  ) values (
    auth.uid(), target_user_uuid, reason_code, '',
    content_type, evidence, case when reason_code = 'sexual' then 'high' else 'normal' end
  ) returning id into report_uuid;

  return report_uuid;
end;
$$;

revoke all on function public.report_board_content(text, uuid, text) from public;
grant execute on function public.report_board_content(text, uuid, text) to authenticated;

notify pgrst, 'reload schema';
