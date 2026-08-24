# AdMob rewarded-ad SSV

This unauthenticated GET endpoint accepts only callbacks whose original query
string has a valid Google AdMob ECDSA signature. It additionally verifies the
configured ad unit, reward amount, reward item, timestamp, user UUID, and unique
transaction ID before calling the service-role-only point credit function.

Deploy:

```powershell
npx supabase functions deploy admob-reward --project-ref pcildcgxoclqimusjgma --no-verify-jwt
```

Then configure this verified callback URL in the rewarded ad unit:

```text
https://pcildcgxoclqimusjgma.supabase.co/functions/v1/admob-reward
```

For AdMob's **Verify URL** form, leave the test user ID blank and enter the
following custom data value. A correctly signed setup test returns HTTP 200 but
never credits points:

```text
admob_ssv_setup_test
```

Do not use the RevenueCat webhook URL for AdMob callbacks.
