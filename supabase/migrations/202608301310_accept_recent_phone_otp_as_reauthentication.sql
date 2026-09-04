begin;
-- A recent Phone OTP is itself current-account proof. Device and session binding
-- are still checked below, and finish_account_link keeps all merge-safety gates.
CREATE OR REPLACE FUNCTION public.begin_account_link_v2(device_secret text, device_platform text, reinstall_identifier text, target_provider text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare aid uuid; source account_private.account_identities; secret text; dh text; scope text;
begin
  perform pg_advisory_xact_lock(hashtextextended('ingtalk-account-identity-mutations-v1',0));
  aid:=public.current_account_id();
  if aid is null then return jsonb_build_object('error','account_link_unavailable'); end if;
  select * into source from account_private.account_identities where account_id=aid and auth_user_id=auth.uid();
  if target_provider is null or target_provider not in ('phone','google','kakao') then return jsonb_build_object('error','invalid_link_provider'); end if;
  if not account_private.fresh_identity(source.provider) and not (
    source.provider='phone' and target_provider in ('google','kakao')
    and account_private.phone_otp_within_one_month(auth.uid())
  ) then return jsonb_build_object('error','link_reauthentication_required'); end if;
  scope:=account_private.device_scope(device_secret,device_platform,reinstall_identifier);
  dh:=encode(extensions.digest(device_secret,'sha256'),'hex');
  if not exists(select 1 from account_private.account_devices v join account_private.sessions g on g.device_id=v.id
    where v.account_id=aid and v.device_hash=dh and v.device_scope_hash=scope and g.session_id::text=auth.jwt()->>'session_id')
    or exists(select 1 from public.profiles where id=aid and status::text='suspended' and (suspended_until is null or suspended_until>now())) then
    return jsonb_build_object('error','account_link_unavailable'); end if;
  if exists(select 1 from account_private.account_identities b where b.account_id=aid and b.provider=target_provider) then
    return jsonb_build_object('error','account_already_linked'); end if;
  if (select count(*) from account_private.account_link_requests where account_id=aid and created_at>now()-interval '1 hour')>=10 then
    return jsonb_build_object('error','link_rate_limited'); end if;
  update account_private.account_link_requests set used_at=now() where account_id=aid and used_at is null;
  secret:=encode(extensions.gen_random_bytes(32),'hex');
  insert into account_private.account_link_requests(token_hash,account_id,source_user,source_session,source_provider,target_provider,device_hash,scope_hash)
    values(encode(extensions.digest(secret,'sha256'),'hex'),aid,auth.uid(),(auth.jwt()->>'session_id')::uuid,source.provider,target_provider,dh,scope);
  return jsonb_build_object('ok',true,'ticket',secret,'account_id',aid,'provider',target_provider);
end $function$;
revoke all on function public.begin_account_link_v2(text,text,text,text) from public,anon;
grant execute on function public.begin_account_link_v2(text,text,text,text) to authenticated;
commit;
