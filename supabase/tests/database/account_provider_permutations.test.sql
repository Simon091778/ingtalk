begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions,pgtap;
select plan(103);

create temporary table permutation_results(case_id integer primary key,result jsonb);
grant all on pg_temp.permutation_results to authenticated,service_role;

create function pg_temp.provider_number(provider_name text) returns integer language sql immutable as $$
  select case provider_name when 'phone' then 1 when 'google' then 2 when 'kakao' then 3 end
$$;
create function pg_temp.user_id(case_id integer,provider_name text) returns uuid language sql immutable as $$
  select ('91000000-0000-4000-8000-'||lpad((case_id*10+pg_temp.provider_number(provider_name))::text,12,'0'))::uuid
$$;
create function pg_temp.session_id(case_id integer,provider_name text,slot integer) returns uuid language sql immutable as $$
  select ('92000000-0000-4000-8000-'||lpad((case_id*100+pg_temp.provider_number(provider_name)*10+slot)::text,12,'0'))::uuid
$$;
create function pg_temp.device_secret(case_id integer,slot integer) returns text language sql immutable as $$
  select lpad((case_id*100+slot)::text,64,'0')
$$;
create function pg_temp.device_identifier(case_id integer) returns text language sql immutable as $$
  select lpad((case_id+1000)::text,64,'a')
$$;
create function pg_temp.set_provider(case_id integer,provider_name text,slot integer default 1,age_minutes integer default 0) returns void language plpgsql as $$
declare uid uuid:=pg_temp.user_id(case_id,provider_name); sid uuid:=pg_temp.session_id(case_id,provider_name,slot);
begin
  perform set_config('request.jwt.claim.sub',uid::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',uid,'role','authenticated',
    'phone',case when provider_name='phone' then '+821077'||lpad((case_id*10+1)::text,4,'0') else '' end,
    'session_id',sid,'amr',jsonb_build_array(jsonb_build_object(
      'method',case when provider_name='phone' then 'otp' else 'oauth' end,
      'timestamp',extract(epoch from now()-make_interval(mins=>age_minutes))::bigint)))::text,true);
end $$;
create function pg_temp.authorize_provider(case_id integer,provider_name text,secret text,identifier text) returns jsonb language plpgsql as $$
begin
  if provider_name='phone' then return public.authorize_device_account_v2(secret,'android',identifier); end if;
  if provider_name='google' then return public.authorize_google_device_account(secret,'android',identifier); end if;
  if provider_name='kakao' then return public.authorize_kakao_device_account(secret,'android',identifier); end if;
  raise exception 'unsupported provider';
end $$;

insert into auth.users(id,instance_id,aud,role,email,email_confirmed_at,phone,phone_confirmed_at,is_anonymous,created_at,updated_at)
select pg_temp.user_id(c,p),'00000000-0000-0000-0000-000000000000','authenticated','authenticated',
  case when p='google' then 'permutation-'||c||'@example.invalid' end,
  case when p='google' then now() end,
  case when p='phone' then '821077'||lpad((c*10+1)::text,4,'0') end,
  case when p='phone' then now() end,false,now(),now()
from generate_series(1,18) c cross join unnest(array['phone','google','kakao']) as provider_rows(p);
insert into auth.identities(id,user_id,provider,provider_id,identity_data)
select gen_random_uuid(),pg_temp.user_id(c,p),p,
  case when p='google' then 'permutation-google-'||c else (93000000+c)::text end,
  case when p='google' then jsonb_build_object('sub','permutation-google-'||c,'email_verified',true)
    else jsonb_build_object('sub',(93000000+c)::text,'provider_id',(93000000+c)::text) end
from generate_series(1,18) c cross join unnest(array['google','kakao']) as provider_rows(p);
insert into auth.sessions(id,user_id)
select pg_temp.session_id(c,p,s),pg_temp.user_id(c,p)
from generate_series(1,18) c cross join unnest(array['phone','google','kakao']) as provider_rows(p) cross join generate_series(1,4) s;

create function pg_temp.run_order(case_id integer,first_provider text,second_provider text,third_provider text) returns jsonb language plpgsql as $$
declare secret text:=pg_temp.device_secret(case_id,1); identifier text:=pg_temp.device_identifier(case_id);
  first_result jsonb; second_ticket jsonb; second_result jsonb; third_ticket jsonb; third_result jsonb;
  canonical uuid; first_restore jsonb; second_restore jsonb; third_restore jsonb;
begin
  perform pg_temp.set_provider(case_id,first_provider,1);
  first_result:=pg_temp.authorize_provider(case_id,first_provider,secret,identifier);
  canonical:=(first_result->>'account_id')::uuid;
  insert into public.profiles(id,nickname,birth_year,region_code,gender)
    values(canonical,'순열'||case_id,1990,'TEST','male');
  perform public.claim_account_welcome_points();

  second_ticket:=public.begin_account_link_v2(secret,'android',identifier,second_provider);
  perform pg_temp.set_provider(case_id,second_provider,1);
  second_result:=public.finish_account_link(second_ticket->>'ticket',secret,'android',identifier);
  third_ticket:=public.begin_account_link_v2(secret,'android',identifier,third_provider);
  perform pg_temp.set_provider(case_id,third_provider,1);
  third_result:=public.finish_account_link(third_ticket->>'ticket',secret,'android',identifier);

  perform pg_temp.set_provider(case_id,first_provider,2);
  first_restore:=pg_temp.authorize_provider(case_id,first_provider,pg_temp.device_secret(case_id,2),identifier);
  perform pg_temp.set_provider(case_id,second_provider,2);
  second_restore:=pg_temp.authorize_provider(case_id,second_provider,pg_temp.device_secret(case_id,3),identifier);
  perform pg_temp.set_provider(case_id,third_provider,2);
  third_restore:=pg_temp.authorize_provider(case_id,third_provider,pg_temp.device_secret(case_id,4),identifier);
  return jsonb_build_object('canonical',canonical,'created',first_result->>'created',
    'second',second_result->>'account_id','third',third_result->>'account_id',
    'first_restore',first_restore->>'account_id','second_restore',second_restore->>'account_id',
    'third_restore',third_restore->>'account_id','providers',public.account_login_methods()->'providers',
    'balance',public.my_point_balance());
end $$;

set local role authenticated;
insert into pg_temp.permutation_results values
  (1,pg_temp.run_order(1,'phone','google','kakao')),
  (2,pg_temp.run_order(2,'phone','kakao','google')),
  (3,pg_temp.run_order(3,'google','phone','kakao')),
  (4,pg_temp.run_order(4,'google','kakao','phone')),
  (5,pg_temp.run_order(5,'kakao','phone','google')),
  (6,pg_temp.run_order(6,'kakao','google','phone'));
reset role;

select is(result->>'created','true','order '||case_id||' creates only its first app account') from pg_temp.permutation_results where case_id<=6 order by case_id;
select is(result->>'second',result->>'canonical','order '||case_id||' links its second provider to the canonical account') from pg_temp.permutation_results where case_id<=6 order by case_id;
select is(result->>'third',result->>'canonical','order '||case_id||' links its third provider to the canonical account') from pg_temp.permutation_results where case_id<=6 order by case_id;
select is(result->'providers','["google","kakao","phone"]'::jsonb,'order '||case_id||' reports all three providers') from pg_temp.permutation_results where case_id<=6 order by case_id;
select is((result->>'balance')::bigint,100::bigint,'order '||case_id||' preserves the original wallet') from pg_temp.permutation_results where case_id<=6 order by case_id;
select is(result->>'first_restore',result->>'canonical','order '||case_id||' restores through its first provider') from pg_temp.permutation_results where case_id<=6 order by case_id;
select is(result->>'second_restore',result->>'canonical','order '||case_id||' restores through its second provider') from pg_temp.permutation_results where case_id<=6 order by case_id;
select is(result->>'third_restore',result->>'canonical','order '||case_id||' restores through its third provider') from pg_temp.permutation_results where case_id<=6 order by case_id;
select is((select count(distinct result->>'canonical') from pg_temp.permutation_results where case_id<=6),6::bigint,'all six orders retain separate canonical accounts');

-- Explicit linking verifies both established accounts. Exercise every directed
-- provider pair on distinct scopes; the current/source account is the survivor.
create function pg_temp.run_established_conflict(case_id integer,source_provider text,target_provider text) returns jsonb
language plpgsql security definer set search_path=public,account_private,pg_temp as $$
declare source_secret text:=pg_temp.device_secret(case_id,1); target_secret text:=pg_temp.device_secret(case_id,2);
  source_identifier text:=pg_temp.device_identifier(case_id); target_identifier text:=lpad((case_id+2000)::text,64,'b');
  source_result jsonb; target_result jsonb; ticket jsonb; link_result jsonb;
  source_account uuid; target_account uuid;
begin
  perform pg_temp.set_provider(case_id,source_provider,1);
  source_result:=pg_temp.authorize_provider(case_id,source_provider,source_secret,source_identifier);
  source_account:=(source_result->>'account_id')::uuid;
  insert into public.profiles(id,nickname,birth_year,region_code,gender)
    values(source_account,'충돌원본'||case_id,1990,'TEST','male');
  perform public.claim_account_welcome_points();
  ticket:=public.begin_account_link_v2(source_secret,'android',source_identifier,target_provider);

  perform pg_temp.set_provider(case_id,target_provider,1);
  target_result:=pg_temp.authorize_provider(case_id,target_provider,target_secret,target_identifier);
  target_account:=(target_result->>'account_id')::uuid;
  insert into public.profiles(id,nickname,birth_year,region_code,gender)
    values(target_account,'충돌대상'||case_id,1990,'TEST','male');
  perform public.claim_account_welcome_points();
  link_result:=public.finish_account_link(ticket->>'ticket',source_secret,'android',source_identifier);

  return jsonb_build_object('source',source_account,'target',target_account,'error',link_result->>'error',
    'current',public.current_account_id(),
    'source_profile',exists(select 1 from public.profiles where id=source_account),
    'target_profile',exists(select 1 from public.profiles where id=target_account),
    'source_balance',(select balance from public.point_wallets where user_id=source_account),
    'target_balance',(select balance from public.point_wallets where user_id=target_account),
    'source_owner_count',(select count(*) from account_private.account_identities where account_id=source_account and provider=source_provider),
    'target_owner_count',(select count(*) from account_private.account_identities where account_id=target_account and provider=target_provider));
end $$;

set local role authenticated;
insert into pg_temp.permutation_results values
  (13,pg_temp.run_established_conflict(13,'phone','google')),
  (14,pg_temp.run_established_conflict(14,'google','phone')),
  (15,pg_temp.run_established_conflict(15,'phone','kakao')),
  (16,pg_temp.run_established_conflict(16,'kakao','phone')),
  (17,pg_temp.run_established_conflict(17,'google','kakao')),
  (18,pg_temp.run_established_conflict(18,'kakao','google'));
reset role;

select is(result->>'error',null::text,'established pair '||case_id||' accepts verified merge') from pg_temp.permutation_results where case_id>=13 order by case_id;
select isnt(result->>'source',result->>'target','established pair '||case_id||' begins with distinct canonical accounts') from pg_temp.permutation_results where case_id>=13 order by case_id;
select is(result->>'current',result->>'source','established pair '||case_id||' rebinds verified session to source survivor') from pg_temp.permutation_results where case_id>=13 order by case_id;
select ok((result->>'source_profile')::boolean,'established pair '||case_id||' preserves survivor profile') from pg_temp.permutation_results where case_id>=13 order by case_id;
select ok(not (result->>'target_profile')::boolean,'established pair '||case_id||' retires losing profile') from pg_temp.permutation_results where case_id>=13 order by case_id;
select is((result->>'source_balance')::bigint,100::bigint,'established pair '||case_id||' keeps MAX balance') from pg_temp.permutation_results where case_id>=13 order by case_id;
select is((result->>'target_balance')::bigint,null::bigint,'established pair '||case_id||' removes losing wallet') from pg_temp.permutation_results where case_id>=13 order by case_id;
select is((result->>'source_owner_count')::bigint,1::bigint,'established pair '||case_id||' preserves source provider on survivor') from pg_temp.permutation_results where case_id>=13 order by case_id;
select is((result->>'target_owner_count')::bigint,0::bigint,'established pair '||case_id||' removes target provider from losing account') from pg_temp.permutation_results where case_id>=13 order by case_id;

select * from finish();
rollback;

/* Obsolete destructive account-takeover fixtures retained below for migration
history only. They are intentionally excluded from execution because canonical
Phone rotation no longer creates the temporary accounts they require.

create function pg_temp.seed_reverse_recovery(shell uuid,canonical uuid,duplicate_phone boolean) returns void
language plpgsql security definer set search_path=public,account_private,pg_temp as $$
begin
  insert into public.point_reward_claims(user_id,reward_type,claimed_at)
    values(shell,'attendance',now()-interval '1 hour');
  if duplicate_phone then
    insert into account_private.account_identities(account_id,auth_user_id,provider,identity_hash)
      select canonical,auth_user_id,'phone',identity_hash
      from account_private.account_identities where account_id=shell and provider='phone';
  end if;
end $$;

create function pg_temp.run_reverse(case_id integer,first_social text,second_social text,target_social text) returns jsonb
language plpgsql security definer set search_path=public,account_private,pg_temp as $$
declare old_secret text:=pg_temp.device_secret(case_id,1); phone_secret text:=pg_temp.device_secret(case_id,2);
  identifier text:=pg_temp.device_identifier(case_id); first_result jsonb; link_ticket jsonb; link_result jsonb;
  phone_result jsonb; recovery_ticket jsonb; recovery_result jsonb; canonical uuid; shell uuid;
  stale_current_denied boolean; stale_reward_denied boolean:=false; stale_begin_result jsonb;
begin
  perform pg_temp.set_provider(case_id,first_social,1);
  first_result:=pg_temp.authorize_provider(case_id,first_social,old_secret,identifier);
  canonical:=(first_result->>'account_id')::uuid;
  insert into public.profiles(id,nickname,birth_year,region_code,gender)
    values(canonical,'역복구'||case_id,1990,'TEST','male');
  perform public.claim_account_welcome_points();
  link_ticket:=public.begin_account_link_v2(old_secret,'android',identifier,second_social);
  perform pg_temp.set_provider(case_id,second_social,1);
  link_result:=public.finish_account_link(link_ticket->>'ticket',old_secret,'android',identifier);

  perform pg_temp.set_provider(case_id,'phone',1);
  phone_result:=pg_temp.authorize_provider(case_id,'phone',phone_secret,identifier);
  shell:=(phone_result->>'account_id')::uuid;
  insert into public.profiles(id,nickname,birth_year,region_code,gender)
    values(shell,'폐기역복구'||case_id,1990,'TEST','male');
  update public.profiles set welcome_points_claimed=true where id=shell;
  update public.point_wallets set balance=1000 where user_id=shell;
  insert into account_private.point_wallet_historical_baselines(account_id,amount,source)
    values(shell,1000,'migration_024_opening_balance');
  -- Case 7 covers the idempotent state where A already has this exact phone
  -- method (for example, a prior callback succeeded but the client retried).
  perform pg_temp.seed_reverse_recovery(shell,canonical,case_id=7);
  -- A second JWT for B must not retain app access after B is retired.
  perform pg_temp.set_provider(case_id,'phone',3);
  perform pg_temp.authorize_provider(case_id,'phone',phone_secret,identifier);
  perform pg_temp.set_provider(case_id,'phone',1);
  -- Destructive phone-account retirement requires the recent OTP. The app
  -- performs this step inline without logging the current account out.
  recovery_ticket:=public.begin_account_link_v2(phone_secret,'android',identifier,target_social);
  perform pg_temp.set_provider(case_id,target_social,2);
  recovery_result:=public.finish_account_link(recovery_ticket->>'ticket',phone_secret,'android',identifier);
  perform pg_temp.set_provider(case_id,'phone',3);
  stale_current_denied:=public.current_account_id() is null;
  begin
    perform * from public.claim_attendance_reward();
  exception when others then stale_reward_denied:=true;
  end;
  stale_begin_result:=public.begin_account_link_v2(phone_secret,'android',identifier,target_social);
  perform pg_temp.set_provider(case_id,'phone',1);
  return jsonb_build_object('canonical',canonical,'shell',shell,'legacy',recovery_result->>'account_id',
    'recovered',recovery_result->>'recovered_account_id','phone_current',public.current_account_id(),
    'providers',public.account_login_methods()->'providers','balance',public.my_point_balance(),
    'reward_preserved',exists(select 1 from public.point_reward_claims where user_id=canonical and reward_type='attendance'),
    'alias_preserved',exists(select 1 from account_private.account_recovery_aliases where retired_account_id=shell and canonical_account_id=canonical),
    'phone_identity_count',(select count(*) from account_private.account_identities b join account_private.account_identities old
      on old.provider='phone' and old.identity_hash=b.identity_hash where old.account_id=canonical and b.provider='phone'),
    'stale_current_denied',stale_current_denied,'stale_reward_denied',stale_reward_denied,
    'stale_begin_denied',stale_begin_result->>'error' is not null);
end $$;

set local role authenticated;
insert into pg_temp.permutation_results values
  (7,pg_temp.run_reverse(7,'google','kakao','google')),
  (8,pg_temp.run_reverse(8,'kakao','google','kakao'));
reset role;
select isnt(result->>'shell',result->>'canonical','reverse case '||case_id||' starts with an isolated phone shell') from pg_temp.permutation_results where case_id>=7 order by case_id;
select is(result->>'legacy',result->>'shell','reverse case '||case_id||' keeps the shipped-client response contract') from pg_temp.permutation_results where case_id>=7 order by case_id;
select is(result->>'recovered',result->>'canonical','reverse case '||case_id||' recovers the existing social account') from pg_temp.permutation_results where case_id>=7 order by case_id;
select is(result->>'phone_current',result->>'canonical','reverse case '||case_id||' rebinds the phone session') from pg_temp.permutation_results where case_id>=7 order by case_id;
select is(result->'providers','["google","kakao","phone"]'::jsonb,'reverse case '||case_id||' reports all three providers') from pg_temp.permutation_results where case_id>=7 order by case_id;
select is((result->>'balance')::bigint,1000::bigint,'reverse case '||case_id||' preserves the higher phone wallet') from pg_temp.permutation_results where case_id>=7 order by case_id;
select is((select amount from public.point_transactions where user_id=(result->>'canonical')::uuid and reason='account_merge_balance_preserved' and reference_id=(result->>'shell')::uuid),900::bigint,'reverse case '||case_id||' records only the preserved balance difference') from pg_temp.permutation_results where case_id>=7 order by case_id;
select ok(not exists(select 1 from account_private.device_accounts where id=(result->>'shell')::uuid),'reverse case '||case_id||' retires the phone-only account') from pg_temp.permutation_results where case_id>=7 order by case_id;
select ok(not exists(select 1 from public.profiles where id=(result->>'shell')::uuid),'reverse case '||case_id||' deletes the phone-only profile') from pg_temp.permutation_results where case_id>=7 order by case_id;
select ok(not exists(select 1 from public.point_wallets where user_id=(result->>'shell')::uuid),'reverse case '||case_id||' discards the phone-only points') from pg_temp.permutation_results where case_id>=7 order by case_id;
select ok((result->>'reward_preserved')::boolean,'reverse case '||case_id||' preserves the reward cooldown without adding points') from pg_temp.permutation_results where case_id>=7 order by case_id;
select ok((result->>'alias_preserved')::boolean,'reverse case '||case_id||' records the retired principal alias') from pg_temp.permutation_results where case_id>=7 order by case_id;
select is((result->>'phone_identity_count')::bigint,1::bigint,'reverse case '||case_id||' leaves exactly one copy of the verified phone identity') from pg_temp.permutation_results where case_id>=7 order by case_id;
select ok((result->>'stale_current_denied')::boolean,'reverse case '||case_id||' rejects a retired B JWT at the account boundary') from pg_temp.permutation_results where case_id>=7 order by case_id;
select ok((result->>'stale_reward_denied')::boolean,'reverse case '||case_id||' denies rewards to a retired B JWT') from pg_temp.permutation_results where case_id>=7 order by case_id;
select ok((result->>'stale_begin_denied')::boolean,'reverse case '||case_id||' denies account-link tickets to a retired B JWT') from pg_temp.permutation_results where case_id>=7 order by case_id;

create function pg_temp.seed_stale_jwt_room(first_user uuid,second_user uuid) returns uuid
language plpgsql security definer set search_path=public,pg_temp as $$
declare card_id uuid; request_id uuid; room_id uuid;
begin
  insert into public.conversation_cards(author_id,purpose,topic) values(second_user,'수다','폐기 JWT 메시지 차단') returning id into card_id;
  insert into public.chat_requests(card_id,sender_id,receiver_id,opening_message,status)
    values(card_id,first_user,second_user,'보안 검사','accepted') returning id into request_id;
  insert into public.chat_rooms(request_id) values(request_id) returning id into room_id;
  insert into public.chat_members(room_id,user_id) values(room_id,first_user),(room_id,second_user);
  return room_id;
end $$;
create function pg_temp.stale_profile_update_denied(target uuid) returns boolean language plpgsql as $$
declare changed integer;
begin
  update public.profiles set introduction='stale-jwt-write' where id=target;
  get diagnostics changed=row_count;
  return changed=0;
exception when others then return true;
end $$;
create function pg_temp.stale_message_denied(room_id uuid,target uuid) returns boolean language plpgsql as $$
begin
  insert into public.messages(room_id,sender_id,body) values(room_id,target,'stale-jwt-message');
  return false;
exception when others then return true;
end $$;
create function pg_temp.stale_purchase_denied(target uuid) returns boolean language plpgsql as $$
begin
  perform * from public.credit_verified_point_purchase_v2('stale-event','stale-transaction',target,
    'kr.ingtalk.points.3000','TEST_STORE','SANDBOX',0,'KRW',3000,'KR','{}'::jsonb);
  return false;
exception when others then return true;
end $$;
create function pg_temp.stale_ad_denied() returns boolean language plpgsql as $$
begin
  perform public.prepare_rewarded_ad_claim();
  return false;
exception when others then return true;
end $$;
create temporary table stale_jwt_room(id uuid);
grant select on pg_temp.stale_jwt_room to authenticated;
insert into stale_jwt_room values(pg_temp.seed_stale_jwt_room(
  (select (result->>'canonical')::uuid from pg_temp.permutation_results where case_id=7),
  (select (result->>'canonical')::uuid from pg_temp.permutation_results where case_id=8)));
select pg_temp.set_provider(7,'phone',3); set local role authenticated;
select ok(pg_temp.stale_profile_update_denied((select (result->>'canonical')::uuid from pg_temp.permutation_results where case_id=7)),'retired B JWT cannot update the canonical profile');
select ok(pg_temp.stale_message_denied((select id from stale_jwt_room),(select (result->>'canonical')::uuid from pg_temp.permutation_results where case_id=7)),'retired B JWT cannot send a message');
select ok(pg_temp.stale_purchase_denied((select (result->>'canonical')::uuid from pg_temp.permutation_results where case_id=7)),'retired B JWT cannot call purchase crediting');
select ok(pg_temp.stale_ad_denied(),'retired B JWT cannot prepare a rewarded-ad claim');
reset role;

create function pg_temp.run_phone_takeover(case_id integer,social_provider text) returns jsonb
language plpgsql security definer set search_path=public,pg_temp,account_private as $$
declare secret text:=pg_temp.device_secret(case_id,1); identifier text:=pg_temp.device_identifier(case_id);
  phone_result jsonb; social_result jsonb; link_ticket jsonb; link_result jsonb; phone_account uuid; canonical uuid;
begin
  perform pg_temp.set_provider(case_id,'phone',1);
  phone_result:=pg_temp.authorize_provider(case_id,'phone',secret,identifier);
  phone_account:=(phone_result->>'account_id')::uuid;
  insert into public.profiles(id,nickname,birth_year,region_code,gender)
    values(phone_account,'폐기휴대폰'||case_id,1990,'TEST','male');
  update public.profiles set welcome_points_claimed=true where id=phone_account;
  update public.point_wallets set balance=1000 where user_id=phone_account;
  insert into account_private.point_wallet_historical_baselines(account_id,amount,source)
    values(phone_account,1000,'migration_024_opening_balance');

  perform pg_temp.set_provider(case_id,social_provider,1);
  social_result:=pg_temp.authorize_provider(case_id,social_provider,secret,identifier);
  canonical:=(social_result->>'account_id')::uuid;
  insert into public.profiles(id,nickname,birth_year,region_code,gender)
    values(canonical,'보존소셜'||case_id,1990,'TEST','male');
  perform public.claim_account_welcome_points();
  update public.point_wallets set balance=222 where user_id=canonical;
  link_ticket:=public.begin_account_link_v2(secret,'android',identifier,'phone');

  perform pg_temp.set_provider(case_id,'phone',2);
  link_result:=public.finish_account_link(link_ticket->>'ticket',secret,'android',identifier);
  return jsonb_build_object('canonical',canonical,'phone_account',phone_account,'linked',link_result->>'account_id',
    'discarded',link_result->'discarded_phone_accounts','phone_current',public.current_account_id(),
    'providers',public.account_login_methods()->'providers');
end $$;

set local role authenticated;
insert into pg_temp.permutation_results values
  (9,pg_temp.run_phone_takeover(9,'google')),
  (10,pg_temp.run_phone_takeover(10,'kakao'));
reset role;
select isnt(result->>'phone_account',result->>'canonical','takeover case '||case_id||' starts with a separate established phone account') from pg_temp.permutation_results where case_id>=9 order by case_id;
select is(result->>'linked',result->>'canonical','takeover case '||case_id||' keeps the authenticated social account canonical') from pg_temp.permutation_results where case_id>=9 order by case_id;
select is(result->>'phone_current',result->>'canonical','takeover case '||case_id||' rebinds the verified phone session') from pg_temp.permutation_results where case_id>=9 order by case_id;
select is(result->'providers',case when case_id=9 then '["google","phone"]'::jsonb else '["kakao","phone"]'::jsonb end,'takeover case '||case_id||' links the phone method') from pg_temp.permutation_results where case_id>=9 order by case_id;
select is((select balance from public.point_wallets where user_id=(result->>'canonical')::uuid),1000::bigint,'takeover case '||case_id||' preserves the higher phone wallet') from pg_temp.permutation_results where case_id>=9 order by case_id;
select is((select amount from public.point_transactions where user_id=(result->>'canonical')::uuid and reason='account_merge_balance_preserved' and reference_id=(result->>'phone_account')::uuid),778::bigint,'takeover case '||case_id||' records only the preserved balance difference') from pg_temp.permutation_results where case_id>=9 order by case_id;
select ok(not exists(select 1 from account_private.device_accounts where id=(result->>'phone_account')::uuid),'takeover case '||case_id||' retires the old phone principal') from pg_temp.permutation_results where case_id>=9 order by case_id;
select ok(not exists(select 1 from public.profiles where id=(result->>'phone_account')::uuid),'takeover case '||case_id||' deletes the old phone profile') from pg_temp.permutation_results where case_id>=9 order by case_id;
select ok(not exists(select 1 from public.point_wallets where user_id=(result->>'phone_account')::uuid),'takeover case '||case_id||' discards the old phone points') from pg_temp.permutation_results where case_id>=9 order by case_id;
select is((select nickname from public.profiles where id=(result->>'canonical')::uuid),'보존소셜'||case_id,'takeover case '||case_id||' preserves the social profile') from pg_temp.permutation_results where case_id>=9 order by case_id;
select ok((result->'discarded') @> jsonb_build_array(result->>'phone_account'),'takeover case '||case_id||' reports the retired phone account') from pg_temp.permutation_results where case_id>=9 order by case_id;

create function pg_temp.run_recycled_social_phone(case_id integer) returns jsonb
language plpgsql security definer set search_path=public,pg_temp,account_private as $$
declare old_secret text:=pg_temp.device_secret(case_id,1); new_secret text:=pg_temp.device_secret(case_id,2);
  old_identifier text:=pg_temp.device_identifier(case_id); new_identifier text:=repeat('f',64);
  first_result jsonb; ticket jsonb; linked jsonb; takeover jsonb; canonical uuid; replacement uuid;
begin
  perform pg_temp.set_provider(case_id,'phone',1);
  first_result:=pg_temp.authorize_provider(case_id,'phone',old_secret,old_identifier);
  canonical:=(first_result->>'account_id')::uuid;
  insert into public.profiles(id,nickname,birth_year,region_code,gender)
    values(canonical,'소셜보호'||case_id,1990,'TEST','male');
  perform public.claim_account_welcome_points();
  update public.point_wallets set balance=654 where user_id=canonical;
  ticket:=public.begin_account_link_v2(old_secret,'android',old_identifier,'google');
  perform pg_temp.set_provider(case_id,'google',1);
  linked:=public.finish_account_link(ticket->>'ticket',old_secret,'android',old_identifier);
  ticket:=public.begin_account_link_v2(old_secret,'android',old_identifier,'kakao');
  perform pg_temp.set_provider(case_id,'kakao',1);
  linked:=public.finish_account_link(ticket->>'ticket',old_secret,'android',old_identifier);
  update account_private.account_identities set linked_at=now()-interval '1 minute'
    where account_id=canonical and provider='phone';

  -- This session is issued after all three methods were linked and represents
  -- a later holder proving the recycled number on an unknown device.
  insert into auth.sessions(id,user_id,created_at,updated_at)
    values(pg_temp.session_id(case_id,'phone',5),pg_temp.user_id(case_id,'phone'),now(),now());
  perform pg_temp.set_provider(case_id,'phone',5);
  takeover:=pg_temp.authorize_provider(case_id,'phone',new_secret,new_identifier);
  replacement:=(takeover->>'account_id')::uuid;
  insert into public.profiles(id,nickname,birth_year,region_code,gender)
    values(replacement,'새번호소유자'||case_id,1990,'TEST','male');
  perform public.claim_account_welcome_points();
  return jsonb_build_object('canonical',canonical,'replacement',replacement,
    'replacement_balance',public.my_point_balance(),'replacement_providers',public.account_login_methods()->'providers');
end $$;

set local role authenticated;
insert into pg_temp.permutation_results values(11,pg_temp.run_recycled_social_phone(11));
reset role;
select isnt(result->>'replacement',result->>'canonical','recycled social case creates a separate account for the new number holder') from pg_temp.permutation_results where case_id=11;
select is((select balance from public.point_wallets where user_id=(result->>'canonical')::uuid),654::bigint,'recycled social case preserves A points') from pg_temp.permutation_results where case_id=11;
select is((select nickname from public.profiles where id=(result->>'canonical')::uuid),'소셜보호11','recycled social case preserves A profile') from pg_temp.permutation_results where case_id=11;
select is((select jsonb_agg(provider order by provider) from account_private.account_identities where account_id=(result->>'canonical')::uuid),'["google","kakao"]'::jsonb,'recycled social case removes only A phone login') from pg_temp.permutation_results where case_id=11;
select is(result->'replacement_providers','["phone"]'::jsonb,'recycled social case gives B only the phone login') from pg_temp.permutation_results where case_id=11;
select is((result->>'replacement_balance')::bigint,0::bigint,'recycled social case does not give B A points or another welcome award') from pg_temp.permutation_results where case_id=11;
select is((select count(*) from account_private.sessions where account_id=(result->>'canonical')::uuid and user_id=pg_temp.user_id(11,'phone')),0::bigint,'recycled social case revokes every A phone app session') from pg_temp.permutation_results where case_id=11;
select ok(exists(select 1 from account_private.device_accounts where id=(result->>'canonical')::uuid),'recycled social case keeps A app principal') from pg_temp.permutation_results where case_id=11;
select pg_temp.set_provider(11,'phone',1); set local role authenticated;
select is(public.current_account_id(),null::uuid,'A old phone session can no longer open the social account');
select pg_temp.set_provider(11,'google',2);
select is(pg_temp.authorize_provider(11,'google',pg_temp.device_secret(11,3),pg_temp.device_identifier(11))->>'account_id',(select result->>'canonical' from pg_temp.permutation_results where case_id=11),'A Google login still restores the account');
select is(public.my_point_balance(),654::bigint,'A Google login still reads the preserved points');
select pg_temp.set_provider(11,'kakao',2);
select is(pg_temp.authorize_provider(11,'kakao',pg_temp.device_secret(11,4),pg_temp.device_identifier(11))->>'account_id',(select result->>'canonical' from pg_temp.permutation_results where case_id=11),'A Kakao login still restores the account');
select is(public.my_point_balance(),654::bigint,'A Kakao login still reads the preserved points');
reset role;

create function pg_temp.run_recycled_phone_only(case_id integer) returns jsonb
language plpgsql security definer set search_path=public,pg_temp,account_private as $$
declare original jsonb; replacement jsonb; original_id uuid; replacement_id uuid;
  counterpart uuid:=(select (saved.result->>'canonical')::uuid from pg_temp.permutation_results saved where saved.case_id=11);
  card_id uuid; request_id uuid; room_id uuid;
begin
  perform pg_temp.set_provider(case_id,'phone',1);
  original:=pg_temp.authorize_provider(case_id,'phone',pg_temp.device_secret(case_id,1),pg_temp.device_identifier(case_id));
  original_id:=(original->>'account_id')::uuid;
  insert into public.profiles(id,nickname,birth_year,region_code,gender)
    values(original_id,'폐기번호'||case_id,1990,'TEST','male');
  perform public.claim_account_welcome_points();
  insert into public.point_purchase_receipts(provider_event_id,store_transaction_id,user_id,product_id,point_amount,price_won,store,environment)
    values('reassigned-event-'||case_id,'reassigned-tx-'||case_id,original_id,'kr.ingtalk.points.3000',3000,3000,'TEST_STORE','SANDBOX');
  insert into public.conversation_cards(author_id,purpose,topic) values(counterpart,'수다','번호 재할당 보관 테스트') returning id into card_id;
  insert into public.chat_requests(card_id,sender_id,receiver_id,opening_message,status)
    values(card_id,original_id,counterpart,'A의 보관 대상 요청','accepted') returning id into request_id;
  insert into public.chat_rooms(request_id) values(request_id) returning id into room_id;
  insert into public.messages(room_id,sender_id,body) values(room_id,original_id,'A의 보관 대상 메시지');
  update account_private.account_identities set linked_at=now()-interval '1 minute'
    where account_id=original_id and provider='phone';
  insert into auth.sessions(id,user_id,created_at,updated_at)
    values(pg_temp.session_id(case_id,'phone',5),pg_temp.user_id(case_id,'phone'),now(),now());
  perform pg_temp.set_provider(case_id,'phone',5);
  replacement:=pg_temp.authorize_provider(case_id,'phone',pg_temp.device_secret(case_id,2),repeat('e',64));
  replacement_id:=(replacement->>'account_id')::uuid;
  return jsonb_build_object('original',original_id,'replacement',replacement_id,'replacement_balance',public.my_point_balance());
end $$;
set local role authenticated;
insert into pg_temp.permutation_results values(12,pg_temp.run_recycled_phone_only(12));
reset role;
select isnt(result->>'replacement',result->>'original','recycled phone-only case creates B a new principal') from pg_temp.permutation_results where case_id=12;
select ok(not exists(select 1 from account_private.device_accounts where id=(result->>'original')::uuid),'recycled phone-only case removes A principal') from pg_temp.permutation_results where case_id=12;
select ok(not exists(select 1 from public.point_wallets where user_id=(result->>'original')::uuid),'recycled phone-only case destroys A points') from pg_temp.permutation_results where case_id=12;
select is((select jsonb_agg(provider order by provider) from account_private.account_identities where account_id=(result->>'replacement')::uuid),'["phone"]'::jsonb,'recycled phone-only case gives B the phone identity') from pg_temp.permutation_results where case_id=12;
select ok(exists(select 1 from account_private.phone_reassignment_archives where account_id=(result->>'original')::uuid),'recycled phone-only case keeps a server-only A archive') from pg_temp.permutation_results where case_id=12;
select is((select recovery_disposition from account_private.phone_reassignment_archives where account_id=(result->>'original')::uuid),'purchase_exists','protected A data no longer blocks B phone ownership') from pg_temp.permutation_results where case_id=12;
select is((select snapshot->'profile'->>'nickname' from account_private.phone_reassignment_archives where account_id=(result->>'original')::uuid),'폐기번호12','server archive preserves A profile without exposing it to B') from pg_temp.permutation_results where case_id=12;
select is((select jsonb_array_length(snapshot->'purchase_receipts') from account_private.phone_reassignment_archives where account_id=(result->>'original')::uuid),1,'server archive preserves A purchase history') from pg_temp.permutation_results where case_id=12;
select is((select snapshot->'messages'->0->>'body' from account_private.phone_reassignment_archives where account_id=(result->>'original')::uuid),'A의 보관 대상 메시지','server archive preserves A message content') from pg_temp.permutation_results where case_id=12;
select is((select count(*) from account_private.sessions where account_id=(result->>'original')::uuid),0::bigint,'recycled phone-only case revokes every A app session') from pg_temp.permutation_results where case_id=12;
select is((result->>'replacement_balance')::bigint,0::bigint,'recycled phone-only case gives B none of A points') from pg_temp.permutation_results where case_id=12;

create function pg_temp.run_manual_recovery_block(case_id integer,social_provider text,artifact text) returns jsonb
language plpgsql security definer set search_path=public,pg_temp,account_private,extensions as $$
declare social_secret text:=pg_temp.device_secret(case_id,1); phone_secret text:=pg_temp.device_secret(case_id,2);
  identifier text:=pg_temp.device_identifier(case_id);
  social_identifier text:=case when artifact='message' then repeat('f',64) else pg_temp.device_identifier(case_id) end;
  social_result jsonb; phone_result jsonb; ticket jsonb; link_result jsonb;
  canonical uuid; shell uuid; card_id uuid; request_id uuid; room_id uuid;
  activity_peer uuid:=(select (saved.result->>'replacement')::uuid from pg_temp.permutation_results saved where saved.case_id=11);
begin
  perform pg_temp.set_provider(case_id,social_provider,1);
  social_result:=pg_temp.authorize_provider(case_id,social_provider,social_secret,social_identifier);
  canonical:=(social_result->>'account_id')::uuid;
  insert into public.profiles(id,nickname,birth_year,region_code,gender)
    values(canonical,'보존대상'||case_id,1990,'TEST','male');
  update public.point_wallets set balance=500 where user_id=canonical;

  perform pg_temp.set_provider(case_id,'phone',1);
  phone_result:=pg_temp.authorize_provider(case_id,'phone',phone_secret,identifier);
  shell:=(phone_result->>'account_id')::uuid;
  insert into public.profiles(id,nickname,birth_year,region_code,gender)
    values(shell,'수동검토'||case_id,1990,'TEST','male');
  if artifact='purchase' then
    insert into public.point_purchase_receipts(provider_event_id,store_transaction_id,user_id,product_id,point_amount,price_won,store,environment)
      values('manual-event-'||case_id,'manual-tx-'||case_id,shell,'kr.ingtalk.points.3000',3000,3000,'TEST_STORE','SANDBOX');
  else
    insert into public.conversation_cards(author_id,purpose,topic) values(activity_peer,'수다','현재 계정 보존 메시지') returning id into card_id;
    insert into public.chat_requests(card_id,sender_id,receiver_id,opening_message,status)
      values(card_id,shell,activity_peer,'보존 요청','accepted') returning id into request_id;
    insert into public.chat_rooms(request_id) values(request_id) returning id into room_id;
    insert into public.messages(room_id,sender_id,body) values(room_id,shell,'삭제되면 안 되는 메시지');
  end if;

  -- The source Phone OTP is older than the 10-minute "fresh" window but still
  -- within one month. Protected records must not trigger duplicate Phone OTP.
  perform set_config('request.jwt.claims',(
    current_setting('request.jwt.claims',true)::jsonb || jsonb_build_object('amr',jsonb_build_array(
      jsonb_build_object('method','otp','timestamp',extract(epoch from now()-interval '1 day')::bigint)
    ))
  )::text,true);
  ticket:=public.begin_account_link_v2(phone_secret,'android',identifier,social_provider);
  perform pg_temp.set_provider(case_id,social_provider,2);
  link_result:=public.finish_account_link(ticket->>'ticket',phone_secret,'android',identifier);
  return jsonb_build_object('canonical',canonical,'shell',shell,'ticket_issued',ticket->>'ok','error',link_result->>'error',
    'linked',link_result->>'account_id','balance',(select balance from public.point_wallets where user_id=shell),
    'providers',public.account_login_methods()->'providers',
    'balance_adjustment',(select amount from public.point_transactions where user_id=shell
      and reason='account_merge_balance_preserved' and reference_id=canonical),
    'device_preserved',exists(select 1 from account_private.account_devices where account_id=shell
      and device_scope_hash=account_private.device_scope(phone_secret,'android',identifier)),
    'shell_exists',exists(select 1 from account_private.device_accounts where id=shell),
    'profile_exists',exists(select 1 from public.profiles where id=shell),
    'canonical_exists',exists(select 1 from account_private.device_accounts where id=canonical),
    'artifact_exists',case when artifact='purchase' then exists(select 1 from public.point_purchase_receipts where user_id=shell)
      else exists(select 1 from public.messages where sender_id=shell) end,
    'ticket_unused',exists(select 1 from account_private.account_link_requests where
      token_hash=encode(extensions.digest(ticket->>'ticket','sha256'),'hex') and used_at is null));
end $$;

set local role authenticated;
insert into pg_temp.permutation_results values
  (13,pg_temp.run_manual_recovery_block(13,'google','purchase')),
  (14,pg_temp.run_manual_recovery_block(14,'kakao','message'));
reset role;
select is(result->>'error',null::text,'current Phone purchase history does not block direct Google linking') from pg_temp.permutation_results where case_id=13;
select is(result->>'ticket_issued','true','recent Phone OTP starts Google linking without duplicate Phone reauthentication') from pg_temp.permutation_results where case_id=13;
select ok((result->>'shell_exists')::boolean,'Google linking keeps the current Phone principal') from pg_temp.permutation_results where case_id=13;
select ok((result->>'profile_exists')::boolean,'Google linking keeps the current Phone profile') from pg_temp.permutation_results where case_id=13;
select ok(not (result->>'canonical_exists')::boolean,'Google linking retires the past Social principal') from pg_temp.permutation_results where case_id=13;
select ok((result->>'artifact_exists')::boolean,'Google linking keeps the current Phone purchase receipt') from pg_temp.permutation_results where case_id=13;
select ok(not (result->>'ticket_unused')::boolean,'successful purchase-account linking consumes the ticket') from pg_temp.permutation_results where case_id=13;
select is(result->>'linked',result->>'shell','Google linking returns the current Phone account') from pg_temp.permutation_results where case_id=13;
select is((result->>'balance')::bigint,500::bigint,'Google linking imports only the higher past Social balance') from pg_temp.permutation_results where case_id=13;
select is((result->>'balance_adjustment')::bigint,500::bigint,'Google linking records the imported balance difference') from pg_temp.permutation_results where case_id=13;
select is(result->'providers','["google","phone"]'::jsonb,'Google linking adds the verified method to the current account') from pg_temp.permutation_results where case_id=13;
select ok((result->>'device_preserved')::boolean,'Google linking preserves the current reinstalled Phone device') from pg_temp.permutation_results where case_id=13;
select is(result->>'error',null::text,'ordinary phone activity can link the directly verified Kakao account') from pg_temp.permutation_results where case_id=14;
select is(result->>'ticket_issued','true','recent Phone OTP starts Kakao linking without duplicate Phone reauthentication') from pg_temp.permutation_results where case_id=14;
select ok((result->>'shell_exists')::boolean,'Kakao linking keeps the current Phone principal') from pg_temp.permutation_results where case_id=14;
select ok((result->>'profile_exists')::boolean,'Kakao linking keeps the current Phone profile') from pg_temp.permutation_results where case_id=14;
select ok(not (result->>'canonical_exists')::boolean,'Kakao linking retires the past Social principal') from pg_temp.permutation_results where case_id=14;
select ok((result->>'artifact_exists')::boolean,'Kakao linking keeps current Phone message data') from pg_temp.permutation_results where case_id=14;
select ok(not (result->>'ticket_unused')::boolean,'successful activity recovery consumes the link ticket') from pg_temp.permutation_results where case_id=14;
select is(result->>'linked',result->>'shell','Kakao linking returns the current Phone account') from pg_temp.permutation_results where case_id=14;
select is((result->>'balance')::bigint,500::bigint,'Kakao linking imports only the higher past Social balance') from pg_temp.permutation_results where case_id=14;
select is((result->>'balance_adjustment')::bigint,500::bigint,'Kakao linking records the imported balance difference') from pg_temp.permutation_results where case_id=14;
select is(result->'providers','["kakao","phone"]'::jsonb,'Kakao linking adds the verified method to the current account') from pg_temp.permutation_results where case_id=14;
select ok((result->>'device_preserved')::boolean,'Kakao linking preserves the current Phone device after reinstall') from pg_temp.permutation_results where case_id=14;

create function pg_temp.run_phone_conflict(case_id integer,mode text) returns jsonb
language plpgsql security definer set search_path=public,pg_temp,account_private as $$
declare social_secret text:=pg_temp.device_secret(case_id,1); phone_secret text:=pg_temp.device_secret(case_id,2);
  identifier text:=pg_temp.device_identifier(case_id); social_result jsonb; phone_result jsonb; ticket jsonb; link_result jsonb;
  canonical uuid; shell uuid; third_account uuid; source_hash text; spare_uid uuid:=pg_temp.user_id(case_id+2,'phone');
begin
  perform pg_temp.set_provider(case_id,'google',1);
  social_result:=pg_temp.authorize_provider(case_id,'google',social_secret,identifier);
  canonical:=(social_result->>'account_id')::uuid;
  insert into public.profiles(id,nickname,birth_year,region_code,gender) values(canonical,'충돌A'||case_id,1990,'TEST','male');

  perform pg_temp.set_provider(case_id,'phone',1);
  phone_result:=pg_temp.authorize_provider(case_id,'phone',phone_secret,identifier);
  shell:=(phone_result->>'account_id')::uuid;
  insert into public.profiles(id,nickname,birth_year,region_code,gender) values(shell,'충돌B'||case_id,1990,'TEST','male');
  perform public.claim_account_welcome_points();
  select identity_hash into source_hash from account_private.account_identities where account_id=shell and provider='phone';

  if mode='different_a_phone' then
    insert into account_private.account_identities(account_id,auth_user_id,provider,identity_hash)
      values(canonical,spare_uid,'phone',account_private.identity_hash(spare_uid,'phone'));
  else
    insert into account_private.device_accounts(auth_user_id,phone_hash,auth_provider)
      values(spare_uid,source_hash,'phone') returning id into third_account;
    insert into account_private.account_identities(account_id,auth_user_id,provider,identity_hash)
      values(third_account,spare_uid,'phone',source_hash);
  end if;

  ticket:=public.begin_account_link_v2(phone_secret,'android',identifier,'google');
  perform pg_temp.set_provider(case_id,'google',2);
  link_result:=public.finish_account_link(ticket->>'ticket',phone_secret,'android',identifier);
  return jsonb_build_object('canonical',canonical,'shell',shell,'third',third_account,'error',link_result->>'error',
    'canonical_exists',exists(select 1 from account_private.device_accounts where id=canonical),
    'shell_exists',exists(select 1 from account_private.device_accounts where id=shell),
    'shell_profile_exists',exists(select 1 from public.profiles where id=shell),
    'no_alias',not exists(select 1 from account_private.account_recovery_aliases where retired_account_id=shell),
    'identities_unchanged',exists(select 1 from account_private.account_identities where account_id=shell and provider='phone')
      and (case when mode='different_a_phone' then exists(select 1 from account_private.account_identities where account_id=canonical and provider='phone' and identity_hash<>source_hash)
        else exists(select 1 from account_private.account_identities where account_id=third_account and provider='phone' and identity_hash=source_hash) end));
end $$;

set local role authenticated;
insert into pg_temp.permutation_results values
  (15,pg_temp.run_phone_conflict(15,'different_a_phone')),
  (16,pg_temp.run_phone_conflict(16,'third_account'));
reset role;
select is(result->>'error','account_link_conflict','phone conflict case '||case_id||' rejects automatic recovery') from pg_temp.permutation_results where case_id>=15 order by case_id;
select ok((result->>'canonical_exists')::boolean,'phone conflict case '||case_id||' keeps A') from pg_temp.permutation_results where case_id>=15 order by case_id;
select ok((result->>'shell_exists')::boolean and (result->>'shell_profile_exists')::boolean,'phone conflict case '||case_id||' keeps B and its profile') from pg_temp.permutation_results where case_id>=15 order by case_id;
select ok((result->>'no_alias')::boolean,'phone conflict case '||case_id||' does not mark B retired') from pg_temp.permutation_results where case_id>=15 order by case_id;
select ok((result->>'identities_unchanged')::boolean,'phone conflict case '||case_id||' leaves every phone identity unchanged') from pg_temp.permutation_results where case_id>=15 order by case_id;

select * from finish();
rollback;
*/
