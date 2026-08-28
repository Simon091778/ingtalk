export const TERMS_OF_SERVICE_TEXT_EN = `Effective date: August 28, 2026

1. Purpose
These Terms govern the Ingtalk service provided by Itembus and the rights and responsibilities of users and the operator.

2. Eligibility
Ingtalk is only for users age 19 or older. Users must provide an accurate age. Accounts and content may be restricted or deleted if a user misrepresents their age or is found to be a minor. Impersonation and abuse of rewards or points through multiple accounts are prohibited.

3. Service
The service includes profiles, distance-based talk cards, chat requests, one-to-one chats, an anonymous-alias board, points, reports, and blocks. Features may change for safety, legal compliance, or improvement; material changes will be announced in the app or on a public webpage.

4. Points
Points are used only for service features and cannot be exchanged for cash or property. Rewards are limited to the stated frequency. Points obtained through abuse, errors, or violations may be revoked. Paid points are purchased through the app store, with prices and point amounts shown before purchase. Payments and refunds follow the relevant store policies and applicable law.

5. Prohibited conduct
Prohibited conduct includes use by minors; sexual approaches to minors; prostitution, illegal imagery, or pornography; threats, hate, harassment, stalking, or disclosure of personal data; fraud, requests for money, spam, impersonation, copyright or privacy violations; abuse of reports, points, or device recovery; and violations of law or operating policy.

6. Content and moderation
Users must have the necessary rights to posted content. The operator may hide or remove violating content and suspend accounts. Records may be preserved or disclosed for urgent safety or lawful requests.

7. Reports and appeals
Posts, comments, users, and chats can be reported in the app. Appeals may be sent to itembus@itembus.com.

8. Account deletion
Signup uses SMS, Google or Kakao verification without a user-set password or recovery code. After verifying the existing account and an additional sign-in method, linked phone, Google and Kakao sign-ins use one account, wallet and chat history on the registered phone. Two separately created accounts are not merged. The same linked Google or Kakao account restores the existing account, points and chats across phones. Phone recovery requires a linked sign-in method and the registered device identity. Android uses an app-signing and OS-user-scoped device identifier; iPhone uses device-local Keychain data. Without a usable linked Google or Kakao account, losing access to linked sign-in methods, changing phones, a factory reset, signing or OS-user change, or loss of Keychain data may prevent restoration of previous points (including purchased points) and chats. Deletion applies to the entire account shared by linked methods and all its devices. Registration on all registered devices is restricted for 7 days after deletion; contact support if a secondhand device is affected. This technical restoration policy does not limit statutory payment or refund rights.
Users may request account deletion in the app. User-facing data is deleted; minimum records needed for fraud prevention, reports, legal duties, or disputes may be retained under the Privacy Policy.

9. Limitation of liability
The operator does not broker or guarantee offline meetings, user payments, or third-party services. Users should use care when sharing personal information or meeting offline. Liability that cannot legally be excluded remains unaffected.

10. Governing law
These Terms are governed by the laws of the Republic of Korea. Disputes are resolved by the court having jurisdiction under Korean civil procedure law.`

export const PRIVACY_POLICY_TEXT_EN = `Effective date: August 28, 2026

Itembus processes personal information for Ingtalk as follows.

1. Data and purposes
When you choose Kakao sign-in, Kakao and Supabase Auth process your app-scoped Kakao user ID and authentication session. We do not request your Kakao nickname, profile photo or email. App accounts use a keyed hash of the Kakao ID across devices; Kakao profiles are not copied to public Ingtalk profiles.
When you choose Google sign-in, Google and Supabase Auth process your Google account identifier, email and its verification status, and basic profile information for authentication. Google names, emails, and photos are not automatically copied to your public Ingtalk profile. App accounts use a keyed hash of the stable Google identifier across devices, not email matching. Points and chats are not automatically merged with phone accounts or other sign-in methods.
When you request linking, recent verification of the current account, verification of the additional method, and the registered device are required. Both methods then reference one internal account ID. Similar phone numbers, emails or devices alone never grant another account's data. One-time linking requests expire after 5 minutes and remain for retry-limit enforcement until scheduled cleanup one day after expiration.
Phone numbers and SMS verification records support signup, login and abuse prevention; numbers are not shown to other users. A random device credential is saved in secure device storage; the application database keeps its hash, a keyed phone-number hash and account bindings. Reinstall recovery uses a hash derived from the Android app-scoped device identifier or iPhone Keychain credential. The server stores a further keyed hash until account deletion, never the raw Android device identifier. Supabase Auth processes the actual phone number for SMS authentication. Internal user ID, nickname, age, and gender support profiles, age restrictions, and matching. Talk cards, posts, comments, reactions, chat activity, reports, and blocks support the service, disputes, and safety. Installation ID, app and OS version, push token, access records, and error records support same-number and same-device account verification, notifications, diagnostics, and abuse prevention. Photos and location are processed only when selected. The Google Mobile Ads SDK may automatically collect and share an approximate location inferred from IP address, app interactions such as launches, taps, ad views and video views, SDK diagnostics, and device identifiers such as the advertising ID and app set ID for ad delivery, measurement, analytics, and fraud prevention. Ad completion, ad transaction identifiers, and point-reward records support the 50-point reward, the 24-hour limit, and duplicate-reward prevention.

When you purchase points, RevenueCat and Apple App Store or Google Play process the internal app account ID, product, transaction and receipt identifiers, purchase time, amount, currency, country and refund information to verify purchases, credit points, prevent duplicate grants and handle refunds. Ingtalk does not directly collect card or bank account numbers.

2. Retention
Each 50P check-in, rewarded-ad, talk-card, post and comment reward is available once per rolling 24 hours per account and device. To prevent repeat claims after switching accounts, deletion or normal reinstallation, a device hash and the last grant time per reward are retained separately from accounts and cleaned up after seven days. Opaque ad-claim tickets are valid for 24 hours and cleaned up seven days after expiry. Tickets do not contain phone numbers or raw device identifiers.
Kakao authentication records are deleted after all device accounts linked to that Kakao identity are deleted. The keyed Kakao identifier used to prevent repeat welcome grants remains while linked accounts exist, then for up to one year after last use or deletion before scheduled cleanup.
Google authentication records are deleted after all device accounts linked to that Google identity are deleted. The keyed Google identifier used to prevent repeat welcome grants remains while linked accounts exist, then for up to one year after last use or deletion before scheduled cleanup.
Keyed device hashes, welcome-reward usage and registration cooldown timestamps are retained separately to prevent repeat registration and duplicate rewards. After all accounts on that device are deleted, these records remain for up to one year after last use or deletion before scheduled cleanup. Internal authentication identifiers for deletion retries are cleaned up after 30 days once deletion is complete; failed deletions retain the records necessary to finish processing.
Profiles and general service data are kept until account deletion. User-accessible chats are kept up to 30 days; closed support inquiries and error logs up to 90 days; safety and enforcement evidence up to one year; and device-wallet and repeat-registration prevention records up to one year after last use or withdrawal. Phone authentication records are deleted when all device accounts linked to that number have been deleted. A keyed phone hash prevents duplicate welcome grants while linked accounts exist, then is retained up to one year after last use or deletion and removed by scheduled cleanup. The same linked Google or Kakao account can restore the account across devices. Phone recovery also requires a registered device. Losing access to the required method or device identity may prevent restoration. Legally required or disputed records may be isolated for the necessary period and then irreversibly deleted.

3. Processors and international processing
RevenueCat, Inc. and the app stores process purchase verification, receipts and refunds. Purchase information may be processed in the United States or other provider infrastructure locations, transferred over encrypted networks when purchases or refunds occur, and retained for legally required periods or dispute handling. RevenueCat privacy policy: https://www.revenuecat.com/privacy/.
Kakao sign-in is optional. Kakao and Supabase Auth process account authentication when selected. Kakao privacy policy: https://www.kakao.com/policy/privacy. You can choose another sign-in method.
Google sign-in is optional. Google's authentication service and Supabase Auth process account authentication information when you choose it. Google's privacy policy is available at https://policies.google.com/privacy. You may choose phone verification instead.
Twilio and delivery carriers process recipient phone numbers, verification messages and delivery status when SMS verification is requested. Processing may occur in the United States or other provider infrastructure locations. Provider terms: https://www.twilio.com/en-us/legal/privacy/faqs and https://www.twilio.com/en-us/legal/data-protection-addendum. Supabase processes authentication, database, storage, and realtime communications in Seoul. Expo/650 Industries, Sentry/Functional Software, Google Firebase, and Google AdMob may process app, device, push-token, error, advertising-interaction, and identifier data in the United States or other infrastructure locations for builds, updates, push delivery, diagnostics, ad delivery, measurement, and fraud prevention. Transfers use encrypted networks. Google's privacy practices are available at https://policies.google.com/privacy. Refusing or restricting related processing may limit push, diagnostics, advertising, or ad-reward features.

4. Optional permissions
Location supports distance-based cards; precise coordinates are not shown to users. Notifications announce chat requests and messages. Only photos selected through the system picker are processed. Refusal limits only the related feature.

5. User rights
Users may edit profiles, withdraw permissions, or delete their account under My Info. Requests for access, correction, deletion, suspension, or withdrawal may be sent to itembus@itembus.com or 1555-1645.

6. Minors
Ingtalk is limited to users age 19 or older. Accounts and content may be restricted or deleted when use by a minor is identified.

7. Security and deletion
Protections include encryption in transit, row-level security, separated administrator access, audit logs, reporting, blocking, and enforcement. Electronic files are deleted to prevent recovery; legally retained data is isolated.

8. Privacy contact
Email: itembus@itembus.com

9. Changes
Changes will be announced in the app or on a public webpage before taking effect.`
