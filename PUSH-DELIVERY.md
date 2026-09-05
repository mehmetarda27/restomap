# RESTOMAP push notification layer

## Platform status

- Web / installed PWA: Web Push via the existing persistent VAPID keys and service worker. Admin, restaurant and courier device subscriptions share the delivery implementation. Automated API, transport and service-worker tests cover these paths. No real browser subscription or handset delivery was available in this session; automated success is not proof of end-device delivery.
- Android: Capacitor Push Notifications plugin is synchronized with the Android project. FCM token registration, refresh callbacks, deletion, channel creation and notification links are wired. Foreground OS alerts are disabled so the in-app/SSE UI handles them. The existing courier background notification poller is suppressed only after successful native registration. GPS tracking remains active.
- iOS: this repository has no iOS target. Native APNs is not implemented or verified. An iOS target, signing/provisioning, Push Notifications entitlement and APNs credentials are required before native integration. iOS Web Push requires a supported installed web app and device testing; it was not verified here.

## Android configuration before enabling

1. Register `com.restomap.app` in the correct RESTOMAP Firebase project.
2. Place its `google-services.json` in `android/app/` (gitignored).
3. Configure `RESTOMAP_FIREBASE_SERVICE_ACCOUNT` as a secret JSON value on the server, or `GOOGLE_APPLICATION_CREDENTIALS` pointing to a private service-account file. Do not commit secrets. FCM remains disabled for clients when neither is configured.
4. Run `npx cap sync android`, build/install the updated APK, sign in, and enable notifications from the notification center.
5. Verify foreground, background, screen-lock, offline/reconnect, token rotation, logout, and two separate physical devices for each role. Verify that the old courier poller and FCM do not duplicate alerts.

## Routing and failure behavior

Push is triggered from the existing central event broadcaster. Explicit restaurant/courier IDs and explicit audience lists determine recipients; a generic broadcast flag does not expose events to unrelated roles. Announcements use their declared target role. Admin receives operational events, excluding other roles' push-test events.

New order, cancellation/status, assignment, management records (leave, bonus/penalty, payment), shift, day-close, and credit events use the existing business event messages. Package status events carry package IDs for links. Push does not mutate orders, assignment, balances or SSE state.

Each endpoint can be registered repeatedly, and each account may have several endpoints. Registering an endpoint to a new role removes its old role binding. Logout removes only the device subscription, then unregisters it from the provider. Provider invalid-token responses delete stale rows; other failures record counters/timestamps and receive at most three attempts with transport timeouts. Push promises are contained and never awaited by business writes. Retries are in-process, not a durable offline outbox; a server restart may lose an in-flight retry.

The service worker suppresses OS notifications while the matching panel is visible and focuses the matching role page on click. Notification URLs must stay on the same origin. Notification deep links still require normal authenticated role access. App notifications remain in the existing notification center.

## Verification on 2026-09-05

- Full suite: 118 tests, 116 passed, 2 skipped, 0 failed. A logout regression detected during the first run was fixed and the full suite rerun.
- Final targeted checks after retry cancellation and native token registration coverage: 10 passed, 0 failed. JavaScript syntax and diff checks passed.
- Android plugin sync succeeded. Java compilation could not start because Android SDK Platform 36 and Build Tools 35 require missing SDK components/license acceptance in Android Studio. No APK delivery claim is made.
- Real Web Push / FCM / APNs delivery to a physical device was not tested. Firebase credentials and an iOS target remain unavailable.

## References

- https://capacitorjs.com/docs/apis/push-notifications
- https://firebase.google.com/docs/cloud-messaging/send/admin-sdk
