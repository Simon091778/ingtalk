-- Kakao uses its app-scoped numeric subject, never email/profile matching.
alter table account_private.device_accounts drop constraint device_accounts_auth_provider_check;
alter table account_private.device_accounts add constraint device_accounts_auth_provider_check check(auth_provider in ('phone','google','kakao'));
alter table account_private.account_identities drop constraint account_identities_provider_check;
alter table account_private.account_identities add constraint account_identities_provider_check check(provider in ('phone','google','kakao'));
alter table account_private.account_link_requests add column target_provider text;
update account_private.account_link_requests set target_provider=case when source_provider='phone' then 'google' else 'phone' end;
alter table account_private.account_link_requests alter column target_provider set not null;
alter table account_private.account_link_requests add constraint account_link_target_check check(target_provider in ('phone','google','kakao') and target_provider<>source_provider);

create function account_private.kakao_identity_hash(uid uuid) returns text
language sql stable security definer set search_path='' as $$
  select account_private.hash_phone('kakao-sub-v1:'||i.provider_id)
  from auth.identities i join auth.users u on u.id=i.user_id
  where i.user_id=uid and i.provider='kakao' and i.provider_id ~ '^[1-9][0-9]{0,19}$'
    and i.identity_data->>'sub'=i.provider_id and nullif(u.phone,'') is null and nullif(u.email,'') is null
    and not coalesce(u.is_anonymous,false)
    and not exists(select 1 from auth.identities other where other.user_id=uid and other.provider<>'kakao')
    and (select count(*) from auth.identities other where other.user_id=uid and other.provider='kakao')=1
    and not exists(select 1 from public.admin_users a where a.user_id=uid and a.is_active);
$$;
create or replace function account_private.identity_hash(uid uuid,provider_name text) returns text
language sql stable security definer set search_path='' as $$
  select case when provider_name='google' then account_private.google_identity_hash(uid)
    when provider_name='kakao' then account_private.kakao_identity_hash(uid)
    when provider_name='phone' then (select account_private.hash_phone(u.phone) from auth.users u
      where u.id=uid and u.phone_confirmed_at is not null and nullif(u.phone,'') is not null
        and nullif(u.email,'') is null and not coalesce(u.is_anonymous,false)
        and not exists(select 1 from auth.identities i where i.user_id=uid and i.provider<>'phone')) end;
$$;

-- Reject accidental provider-level merging before it can damage an existing
-- phone/Google login. App-level linking keeps separate Auth users intentionally.
create function account_private.protect_kakao_identity() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if (new.provider='kakao' and (exists(select 1 from auth.identities where user_id=new.user_id and provider<>'kakao')
      or exists(select 1 from account_private.account_identities where auth_user_id=new.user_id and provider<>'kakao')))
    or (new.provider<>'kakao' and exists(select 1 from auth.identities where user_id=new.user_id and provider='kakao')) then
    raise exception 'kakao_identity_conflict'; end if;
  -- A changed consent configuration must not silently persist optional personal
  -- data. The Auth callback transaction rolls back instead of storing profiles.
  if new.provider='kakao' and exists(select 1 from jsonb_each(new.identity_data) field
    where field.key in ('email','name','full_name','preferred_username','user_name','avatar_url','picture','nickname','profile_image_url','profile')
      and field.value not in ('null'::jsonb,'""'::jsonb,'{}'::jsonb)) then
    raise exception 'kakao_profile_access_not_allowed'; end if;
  return new;
end $$;
create trigger protect_kakao_auth_identity before insert or update on auth.identities
  for each row execute function account_private.protect_kakao_identity();

-- Reuse the audited device/session/reward protocol; both social providers must
-- carry a signed OAuth AMR, including normal authorization with an existing key.
do $$ declare definition text; begin
  definition:=pg_get_functiondef('account_private.authorize_identity(text,text,text,text)'::regprocedure);
  if position('provider_name=''google'' and not coalesce' in definition)=0 then raise exception 'social_amr_guard_missing'; end if;
  execute replace(definition,'provider_name=''google'' and not coalesce','provider_name in (''google'',''kakao'') and not coalesce');
end $$;
create function public.authorize_kakao_device_account(device_secret text,device_platform text,reinstall_identifier text) returns jsonb
language sql security definer set search_path='' as $$ select account_private.authorize_identity(device_secret,device_platform,reinstall_identifier,'kakao'); $$;

create function public.begin_account_link_v2(device_secret text,device_platform text,reinstall_identifier text,target_provider text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare aid uuid; source account_private.account_identities; secret text; dh text; scope text;
begin
  perform pg_advisory_xact_lock(hashtextextended('ingtalk-account-identity-mutations-v1',0));
  aid:=public.current_account_id();
  if aid is null then return jsonb_build_object('error','account_link_unavailable'); end if;
  select * into source from account_private.account_identities where account_id=aid and auth_user_id=auth.uid();
  if target_provider is null or target_provider not in ('phone','google','kakao') then return jsonb_build_object('error','invalid_link_provider'); end if;
  if not account_private.fresh_identity(source.provider) then return jsonb_build_object('error','link_reauthentication_required'); end if;
  scope:=account_private.device_scope(device_secret,device_platform,reinstall_identifier);
  dh:=encode(extensions.digest(device_secret,'sha256'),'hex');
  if not exists(select 1 from account_private.device_accounts where id=aid and device_hash=dh and device_scope_hash=scope)
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
end $$;

-- Keep the old two-method API compatible with already shipped phone/Google apps.
create or replace function public.begin_account_link(device_secret text,device_platform text,reinstall_identifier text) returns jsonb
language sql security definer set search_path='' as $$
  select public.begin_account_link_v2(device_secret,device_platform,reinstall_identifier,
    case when (select provider from account_private.account_identities where account_id=public.current_account_id() and auth_user_id=auth.uid())='phone'
      then 'google' else 'phone' end);
$$;
do $$ declare definition text; old_clause text:=$old$provider_name:=case when r.source_provider='phone' then 'google' else 'phone' end;$old$;
begin
  definition:=pg_get_functiondef('public.finish_account_link(text,text,text,text)'::regprocedure);
  if position(old_clause in definition)=0 then raise exception 'link_target_clause_missing'; end if;
  execute replace(definition,old_clause,'provider_name:=r.target_provider;');
end $$;
create or replace function public.check_account_request() returns void
language plpgsql stable security definer set search_path='' as $$
begin
  if current_setting('request.path',true)=any(array['/rpc/current_account_id','/rpc/authorize_device_account',
    '/rpc/authorize_device_account_v2','/rpc/authorize_google_device_account','/rpc/authorize_kakao_device_account','/rpc/finish_account_link',
    '/rpc/account_access_allowed','/rpc/lock_account_session']) then return; end if;
  perform public.require_account_access();
end $$;
revoke all on all functions in schema account_private from public,anon,authenticated;
revoke all on function public.authorize_kakao_device_account(text,text,text),public.begin_account_link_v2(text,text,text,text) from public,anon;
grant execute on function public.authorize_kakao_device_account(text,text,text),public.begin_account_link_v2(text,text,text,text) to authenticated,service_role;
notify pgrst,'reload schema';
