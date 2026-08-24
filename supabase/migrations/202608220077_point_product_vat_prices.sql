-- Store VAT-inclusive KRW catalog prices. The 100,000P package remains
-- discounted at KRW 99,000 as explicitly approved.
update public.point_products
set price_won = case product_id
  when 'kr.ingtalk.points.3000' then 3300
  when 'kr.ingtalk.points.5000' then 5500
  when 'kr.ingtalk.points.10000' then 11000
  when 'kr.ingtalk.points.30000' then 33000
  when 'kr.ingtalk.points.50000' then 55000
  when 'kr.ingtalk.points.100000' then 99000
  else price_won
end,
updated_at = now()
where product_id in (
  'kr.ingtalk.points.3000',
  'kr.ingtalk.points.5000',
  'kr.ingtalk.points.10000',
  'kr.ingtalk.points.30000',
  'kr.ingtalk.points.50000',
  'kr.ingtalk.points.100000'
);
