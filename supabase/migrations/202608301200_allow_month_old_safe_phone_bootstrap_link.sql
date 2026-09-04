-- A recent Phone OTP already proves the source bootstrap account. Do not ask
-- for the same OTP again when the current signed JWT is at most one month old,
-- the ticket is issued on the registered device, and the Phone account is safe
-- to retire. Established or older Phone accounts keep the reauthentication
-- requirement. Social-to-Phone linking still requires a fresh target SMS OTP
-- in finish_account_link.
create or replace function account_private.phone_otp_within_one_month(uid uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select exists(select 1 from auth.users u where u.id=uid and nullif(u.email,'') is null
    and ltrim(coalesce(auth.jwt()->>'phone',''),'+')=u.phone)
    and exists(select 1 from jsonb_array_elements(
      case when jsonb_typeof(auth.jwt()->'amr')='array' then auth.jwt()->'amr' else '[]'::jsonb end) m
      where m->>'method'='otp' and
        case when m->>'timestamp' ~ '^[0-9]{1,12}$' then (m->>'timestamp')::numeric else 0 end
        between extract(epoch from now()-interval '1 month') and extract(epoch from now()+interval '1 minute'));
$$;

do $migration$
declare definition text;
  old_policy text:=$old$if not account_private.fresh_identity(source.provider) and not (
    source.provider='phone' and target_provider in ('google','kakao')
    and not exists(select 1 from public.profiles where id=aid)
    and not exists(select 1 from public.point_wallets where user_id=aid)
    and (select count(*) from account_private.account_identities where account_id=aid)=1
    and (select count(*) from account_private.account_devices where account_id=aid)=1
  ) then return jsonb_build_object('error','link_reauthentication_required'); end if;$old$;
  new_policy text:=$new$if not account_private.fresh_identity(source.provider) and not (
    source.provider='phone' and target_provider in ('google','kakao')
    and account_private.phone_otp_within_one_month(auth.uid())
    and account_private.phone_recovery_disposition(aid)='discardable'
    and (select count(*) from account_private.account_identities where account_id=aid)=1
    and (select count(*) from account_private.account_devices where account_id=aid)=1
  ) then return jsonb_build_object('error','link_reauthentication_required'); end if;$new$;
begin
  definition:=pg_get_functiondef('public.begin_account_link_v2(text,text,text,text)'::regprocedure);
  if position(old_policy in definition)=0 then raise exception 'phone_bootstrap_reauthentication_policy_missing'; end if;
  execute replace(definition,old_policy,new_policy);
end $migration$;

revoke all on function account_private.phone_otp_within_one_month(uuid) from public,anon,authenticated;
notify pgrst,'reload schema';
