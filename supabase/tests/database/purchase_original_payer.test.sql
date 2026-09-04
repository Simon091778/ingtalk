begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions,pgtap;
select plan(21);

create function pg_temp.uid(n integer) returns uuid language sql as $$
  select ('9d000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid
$$;
create function pg_temp.error(statement text) returns text language plpgsql as $$
begin execute statement; return null; exception when others then return sqlerrm; end $$;

insert into auth.users(id,instance_id,aud,role,phone,phone_confirmed_at,is_anonymous,created_at,updated_at) values
 (pg_temp.uid(1),'00000000-0000-0000-0000-000000000000','authenticated','authenticated','821077770001',now(),false,now(),now()),
 (pg_temp.uid(2),'00000000-0000-0000-0000-000000000000','authenticated','authenticated','821077770002',now(),false,now(),now()),
 (pg_temp.uid(3),'00000000-0000-0000-0000-000000000000','authenticated','authenticated',null,null,false,now(),now());
insert into account_private.device_accounts(id,auth_user_id) values
 (pg_temp.uid(101),pg_temp.uid(1)),(pg_temp.uid(102),pg_temp.uid(2)),(pg_temp.uid(103),pg_temp.uid(3));
insert into public.profiles(id,nickname,birth_year,region_code,gender) values
 (pg_temp.uid(101),'원본A',1990,'TEST','male'),(pg_temp.uid(102),'현재B',1990,'TEST','female'),
 (pg_temp.uid(103),'병합대상C',1990,'TEST','male');

insert into account_private.account_identities(account_id,auth_user_id,provider,identity_hash,linked_at)
values(pg_temp.uid(101),pg_temp.uid(1),'phone',account_private.identity_hash(pg_temp.uid(1),'phone'),now()-interval '2 days');

insert into public.point_purchase_receipts(
 id,provider_event_id,store_transaction_id,user_id,product_id,point_amount,price_won,store,environment,raw_event)
values(pg_temp.uid(201),'original-event-a','original-store-a',pg_temp.uid(101),
 'kr.ingtalk.points.3000',3000,3000,'TEST_STORE','SANDBOX','{}');
update public.point_wallets set balance=5000 where user_id=pg_temp.uid(101);
insert into public.point_transactions(user_id,amount,reason,reference_id)
values(pg_temp.uid(101),3000,'point_purchase',pg_temp.uid(201));

select is((select original_account_id from public.point_purchase_receipts where id=pg_temp.uid(201)),pg_temp.uid(101),'P1 insert captures immutable original payer');
select is((select user_id from public.point_purchase_receipts where id=pg_temp.uid(201)),pg_temp.uid(101),'P1 operational payer matches original payer');
select is(pg_temp.error(format('update public.point_purchase_receipts set original_account_id=%L where id=%L',pg_temp.uid(102),pg_temp.uid(201))),'original_purchase_account_immutable','original payer cannot be updated');
select is(pg_temp.error(format($sql$insert into public.point_purchase_receipts(provider_event_id,store_transaction_id,user_id,original_account_id,product_id,point_amount,price_won,store,environment) values('bad-owner','bad-owner',%L,%L,'kr.ingtalk.points.3000',3000,3000,'TEST_STORE','SANDBOX')$sql$,pg_temp.uid(101),pg_temp.uid(102))),'original_purchase_account_mismatch','new receipt cannot claim a different original payer');

select account_private.retire_phone_identity(pg_temp.uid(101),account_private.identity_hash(pg_temp.uid(1),'phone'),'new_device_phone_reassignment');
insert into account_private.account_identities(account_id,auth_user_id,provider,identity_hash)
values(pg_temp.uid(102),pg_temp.uid(1),'phone',account_private.identity_hash(pg_temp.uid(1),'phone'));
select is((select original_account_id from public.point_purchase_receipts where id=pg_temp.uid(201)),pg_temp.uid(101),'P2 phone move does not mutate original payer');
select is((select user_id from public.point_purchase_receipts where id=pg_temp.uid(201)),pg_temp.uid(101),'P2 phone move does not mutate operational payer');
select is((select user_id from public.point_transactions where reference_id=pg_temp.uid(201) and reason='point_purchase'),pg_temp.uid(101),'P2 phone move does not mutate point ledger owner');
select is((select count(distinct account_id) from account_private.account_identities where provider='phone' and identity_hash=account_private.identity_hash(pg_temp.uid(1),'phone')),1::bigint,'F3 moved phone has exactly one active account identity');

insert into public.point_purchase_receipts(
 id,provider_event_id,store_transaction_id,user_id,product_id,point_amount,price_won,store,environment,raw_event)
values(pg_temp.uid(202),'original-event-b','original-store-b',pg_temp.uid(102),
 'kr.ingtalk.points.3000',3000,3000,'TEST_STORE','SANDBOX','{}');
select is((select original_account_id from public.point_purchase_receipts where id=pg_temp.uid(202)),pg_temp.uid(102),'P3 B purchase has B as independent original payer');
select isnt((select original_account_id from public.point_purchase_receipts where id=pg_temp.uid(201)),(select original_account_id from public.point_purchase_receipts where id=pg_temp.uid(202)),'same historical phone never combines payment ownership');

select * from public.refund_verified_point_purchase('original-store-a','refund-a','{}');
select is((select balance from public.point_wallets where user_id=pg_temp.uid(101)),2000::bigint,'R3 phone move refund debits original operational wallet A');
select is((select balance from public.point_wallets where user_id=pg_temp.uid(102)),0::bigint,'R3 phone move refund never debits current phone owner B');

insert into public.point_purchase_receipts(
 id,provider_event_id,store_transaction_id,user_id,product_id,point_amount,price_won,store,environment,raw_event)
values(pg_temp.uid(203),'original-event-c','original-store-c',pg_temp.uid(103),
 'kr.ingtalk.points.3000',3000,3000,'TEST_STORE','SANDBOX','{}');
update public.point_wallets set balance=4000 where user_id=pg_temp.uid(103);
insert into public.point_transactions(user_id,amount,reason,reference_id)
values(pg_temp.uid(103),3000,'point_purchase',pg_temp.uid(203));
insert into account_private.account_recovery_aliases(retired_account_id,canonical_account_id,reason)
values(pg_temp.uid(103),pg_temp.uid(102),'verified_account_merge');
select public.delete_account_data(pg_temp.uid(103));
select is((select original_account_id from public.point_purchase_receipts where id=pg_temp.uid(203)),pg_temp.uid(103),'P4/P5 merge-delete preserves original payer C');
select is((select user_id from public.point_purchase_receipts where id=pg_temp.uid(203)),null,'merge-delete may clear operational payer');
select is((select account_deleted_at is not null from public.point_purchase_receipts where id=pg_temp.uid(203)),true,'deleted operational account is timestamped');

select * from public.refund_verified_point_purchase('original-store-c','refund-c','{}');
select is((select balance from public.point_wallets where user_id=pg_temp.uid(102)),0::bigint,'R2 refund with no provenance never debits canonical B');
select is((select unrecovered_points from public.point_purchase_receipts where id=pg_temp.uid(203)),3000::bigint,'R2 unprovable merged points are fully unrecovered');
select is((select status from public.point_purchase_receipts where id=pg_temp.uid(203)),'refunded','R2 refund evidence is retained');
select is((select original_account_id from public.point_purchase_receipts where id=pg_temp.uid(203)),pg_temp.uid(103),'refund does not mutate original payer');

select is(pg_temp.error($sql$insert into public.point_purchase_receipts(provider_event_id,store_transaction_id,user_id,product_id,point_amount,price_won,store,environment) values('unresolved-future','unresolved-future',null,'kr.ingtalk.points.3000',3000,3000,'TEST_STORE','SANDBOX')$sql$),'original_purchase_account_required','P6 future evidence-free NULL payer is rejected rather than guessed');
select is((select count(*) from public.point_purchase_receipts where original_account_id is null),0::bigint,'all created test receipts have a proven original payer');

select * from finish();
rollback;
