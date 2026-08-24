# Global point product pricing

The app must use the same six product identifiers in App Store Connect, Google Play Console, and RevenueCat.

| Product ID | Points | Korea base price (VAT included) |
|---|---:|---:|
| `kr.ingtalk.points.3000` | 3,000P | KRW 3,300 |
| `kr.ingtalk.points.5000` | 5,000P | KRW 5,500 |
| `kr.ingtalk.points.10000` | 10,000P | KRW 11,000 |
| `kr.ingtalk.points.30000` | 30,000P | KRW 33,000 |
| `kr.ingtalk.points.50000` | 50,000P | KRW 55,000 |
| `kr.ingtalk.points.100000` | 100,000P | KRW 99,000 |

## App Store Connect

1. Create or open all six consumable in-app purchases.
2. Use South Korea as the base storefront and enter the KRW prices above.
3. Enable every intended storefront, including the United States.
4. Accept Apple's automatically generated comparable prices, or explicitly select a USD price point for the United States.
5. Do not create country-specific product IDs. The storefront supplies the localized price and currency for the same ID.

## Google Play Console

1. Create or open the same six one-time consumable products.
2. Enter the KRW prices above and enable automatic local-price conversion.
3. Enable the United States and all intended countries/regions.
4. Review Play's generated USD and other local prices, then activate each product.

## RevenueCat

1. Import the six Apple and Google products into the IngTalk project.
2. Keep each platform product attached to its matching product ID and non-subscription offering.
3. Keep the authenticated Supabase user UUID as the RevenueCat App User ID.
4. Configure the Supabase `revenuecat-webhook` URL and authorization header.
5. Send sandbox purchases from KR and US storefront test accounts and verify `purchase_currency`, `purchase_amount`, and `purchase_country_code` in `point_purchase_receipts`.

The app displays the store-provided `priceString`; it must never calculate USD from KRW or choose billing currency from the in-app service-country preference.
