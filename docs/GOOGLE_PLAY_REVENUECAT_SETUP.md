# Google Play and RevenueCat payment launch checklist

The Android package is `kr.ingtalk.app`. Point purchases are consumable one-time products and must use the same identifiers in Google Play, RevenueCat, the app, and Supabase.

## Product catalog

| Product ID | Points | Korea price (VAT included) |
|---|---:|---:|
| `kr.ingtalk.points.3000` | 3,000P | KRW 3,300 |
| `kr.ingtalk.points.5000` | 5,000P | KRW 5,500 |
| `kr.ingtalk.points.10000` | 10,000P | KRW 11,000 |
| `kr.ingtalk.points.30000` | 30,000P | KRW 33,000 |
| `kr.ingtalk.points.50000` | 50,000P | KRW 55,000 |
| `kr.ingtalk.points.100000` | 100,000P | KRW 99,000 |

## Required connections

1. Create and activate all six one-time products in Google Play Console.
2. Add the Google Play app `kr.ingtalk.app` to RevenueCat and upload valid Google service credentials.
3. Import or manually create all six Google products in RevenueCat as consumable products. Do not mark them non-consumable.
4. Copy the Google app-specific RevenueCat public SDK key (`goog_...`) into the EAS `preview` and `production` environments as `EXPO_PUBLIC_REVENUECAT_GOOGLE_API_KEY`.
5. Apply the Supabase migrations and deploy `revenuecat-webhook` with its authorization secret.
6. Add the Supabase function URL and matching full Authorization header to RevenueCat Webhooks. Enable sandbox and production events.
7. Build a new Android App Bundle after the public SDK key is configured, upload it to the closed track, and install it through the Play opt-in page.
8. Use a license tester account for no-charge purchase tests. A regular closed tester can be charged real money.

## Security boundaries

- The RevenueCat public SDK key is intended to be embedded in the app.
- Google service-account JSON, Supabase service-role keys, and webhook authorization values are server secrets and must never use the `EXPO_PUBLIC_` prefix.
- Points are credited only by the authenticated RevenueCat webhook. The mobile purchase result alone never changes the wallet.
- The authenticated Supabase UUID is the RevenueCat App User ID so the webhook can credit the correct profile.
