# RevenueCat purchase webhook

This function accepts authenticated RevenueCat webhook events, credits consumable point purchases exactly once, and reverses available points after a refund.

## Deploy

Generate a long random authorization value and store it only in Supabase and RevenueCat. Include an authentication scheme in the value, for example `Bearer <random-value>`.

```powershell
npx supabase secrets set REVENUECAT_WEBHOOK_AUTHORIZATION="Bearer <random-value>"
npx supabase functions deploy revenuecat-webhook
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are supplied by the hosted Supabase function environment. Never place the service-role key or webhook authorization value in the mobile app or a public environment variable.

The RevenueCat webhook URL is:

```text
https://<project-ref>.supabase.co/functions/v1/revenuecat-webhook
```

In RevenueCat, configure the exact same full `Authorization` header value and send both sandbox and production events. The function has gateway JWT verification disabled in `supabase/config.toml` because RevenueCat cannot send a Supabase user JWT; the function performs its own constant header comparison before processing the payload.

## Required database objects

Apply all migrations through `202608230092_fix_restore_point_wallet_primary_key.sql` before enabling purchases. The webhook requires `credit_verified_point_purchase_v2` and `refund_verified_point_purchase`.

## Verification

After a license-tester purchase, verify that:

- the RevenueCat event succeeded with HTTP 200;
- `point_purchase_receipts` contains one row for the transaction;
- `point_wallets.balance` increased by the configured product amount;
- retrying the same event does not credit points twice.
