# Capturing analytics events per provider without reaching production

Ticket: [#5](https://github.com/thedammyking/factory/issues/5). Context: [Product analytics as a verified requirement](https://github.com/thedammyking/factory/blob/main/docs/design/design.md#product-analytics-as-a-verified-requirement). Researched 2026-11-02 from vendor docs and SDK source (default branches: posthog-js browser 1.444.1 and react-native 4.85.1; analytics-next browser 1.84.3; analytics-react-native 2.21.4; Amplitude-TypeScript browser 2.49.0 and RN 1.13.0; mixpanel-js 2.84.0; mixpanel-react-native 4.0.0). Bracketed IDs like [PH1] are keyed to the Sources list at the end.

## Answer

1. On web, all six send plain HTTPS calls to stable hosts, so a test can intercept or block them. On React Native only PostHog, Segment, Amplitude and Mixpanel let you point the SDK at a local sink. Google's docs show no React Native SDK for GA4 itself and Firebase Analytics has no documented endpoint override, so those two are verified from debug logs, not the wire.
2. Debug modes show events but do not isolate them. Firebase DebugView events still land in reports and the BigQuery export unless a developer-traffic filter exists [FB1]. What keeps events out of production is a separate project, source or property key per environment, plus (on web) a network rule that blocks and records.
3. A disabled or opted-out SDK drops events before any request in every provider, so "disabled" and "observed" cannot be the same run. Event verification needs an enabled SDK with a dev or placeholder key.
4. Consent is not binary. Google consent mode (advanced) and Segment's consent wrapper deliberately still send requests when consent is denied or partial. "No request before consent" holds for PostHog, Amplitude and Mixpanel opt-out, Segment with every category denied, and Google basic mode.

## Provider by platform

Defaults come from the SDK source or docs in Sources. "Sink" means a local HTTP recorder the SDK is pointed at. Where Google or a vendor does not document a behaviour, the cell says so.

| Provider and platform | Intercept pattern | Debug mode | Local sink | Dev/test key setup | Consent effects |
|---|---|---|---|---|---|
| PostHog web | POST to `api_host` (default `us.i.posthog.com`, EU `eu.i.posthog.com`): events at `/e/` (SDK default) or `/i/v0/e/`, batches at `/batch/`, plus `/flags/?v=2` and `/array/<token>/config`. Bodies are gzip by default (`disable_compression: false`). The API answers 200 even for events it silently drops [PH1][PH3][PH6] | `debug: true`, `posthog.debug()` or `?__posthog_debug=true` logs to the console only. `before_send` can amend or drop events [PH1] | Set `api_host` to the sink; it must also answer `/flags` and the config path [PH1][PH6] | One project per environment, each with its own write-only token; the docs recommend Local Development, Staging and Production projects [PH5][PH9] | `opt_out_capturing_by_default: true` makes `capture()` return without sending; events are dropped, not queued [PH6]. `cookieless_mode: 'on_reject'` captures nothing until the user decides. PostHog advises loading the SDK and toggling opt-in/out rather than gating the snippet [PH4] |
| PostHog RN | `POST {host}/batch/` and `{host}/flags/?v=2`; gzip unless `disableCompression`; `flushAt` 20, `flushInterval` 10 s. Some events (push-notification opens, session replay) are built by the native plugin and skip JS `before_send` [PH2][PH7][PH8] | `posthog.debug()` or `<PostHogProvider debug>`; `before_send` returning `null` drops the event [PH2] | Set `host` to the sink [PH2] | `disabled: __DEV__` is the documented dev switch [PH2]. The client also disables itself when the token is missing [PH7]. Tokens per project as above [PH5] | `defaultOptIn: false` sends nothing until `optIn()`; the choice persists in `.posthog-rn.json` [PH4]. An opted-out client emits "Library is disabled. Not sending event" and drops the event [PH7] |
| Segment web | Per-call POST to `https://api.segment.io/v1/{t,p,i,g,a,s}` (first letter of the call type); `/v1/b` when the batching strategy is set [SG3]. Before any event the SDK GETs `https://cdn.segment.com/v1/projects/<writeKey>/settings` [SG2]. JSON bodies | `analytics.debug(true)`. The instance is an emitter: `analytics.on('track' \| 'page' \| ..., fn)` fires in process [SG4] | `apiHost` (via `integrations['Segment.io']`) and `cdnURL` load options; passing `cdnSettings` inline skips the settings fetch [SG1][SG2] | One workspace, one source per environment, each with its own write key [SG7]. Hard off: load option `disable: true` (or a function) returns a no-op instance with no network, cookies or storage [SG1][SG2] | The consent wrapper delays `load()` until the CMP is ready; calls made before load are buffered. Events carry `context.consent.categoryPreferences`; opt-in removes unconsented device-mode destinations; Segment.io itself is blocked only when none of the consented categories matter to the source and no destination is unmapped (all-denied included), so partial consent usually still sends [SG2][SG5] |
| Segment RN | `POST https://api.segment.io/v1/b`; settings from `https://cdn-settings.segment.com/v1/projects/<writeKey>/settings`; `flushAt` 20, `flushInterval` 30 s, `maxBatchSize` 1000 [SG6] | `debug` defaults true outside production; `logger` is pluggable; a custom `Plugin` (`before`, `enrichment`, `destination`, `after`) sees every event [SG6] | `proxy` is the batch URL (`useSegmentEndpoints` appends `/b`), `cdnProxy` for settings. `http://` is rejected unless `allowInsecureProxy`. `defaultSettings` apply if the settings fetch fails. README spells the flag `useSegmentEndpoint`, the `Config` type `useSegmentEndpoints`; check at setup [SG6] | Source per environment [SG7]. No `disable` flag; `autoAddSegmentDestination: false` skips the Segment destination [SG6] | `ConsentPlugin` queues events (cap 1000) until consent starts, stamps `context.consent`, and filters each destination by category. The Segment destination is skipped only when no category is consented and none is unmapped [SG6] |
| GA4 web (gtag.js) | Script from `www.googletagmanager.com/gtag/js`; hits to `google-analytics.com/g/collect` or `analytics.google.com/g/collect` (Google's own troubleshooting names these) [GA1][GA10]. The query format is not documented by Google, so it is setup-proven, not contractual. Measurement Protocol (`/mp/collect`) is a separate server-side API and returns no HTTP error even for malformed events [GA3] | `gtag('config', ID, {debug_mode: true})` feeds DebugView; `false` does not turn it off [GA2]. `/debug/mp/collect` validates Measurement Protocol payloads and keeps them out of reports, but does not check `api_secret` or `firebase_app_id` [GA3] | `server_container_url` in `config` routes hits to your own server-side tagging container, which is heavy to run locally [GA9]. Otherwise block with the browser test tool | Separate property, or a dev web stream plus a data filter on debug-mode traffic [GA8]. Filtered data is never processed and filters apply only going forward [GA7] | `gtag('consent','default',...)` must run before the tag; Google does not persist choices [GA4]. Advanced mode: denied `analytics_storage` still sends cookieless pings (`gcs`, `gcd`). Basic mode: tag blocked, nothing sent [GA5][GA6] |
| GA4 RN | No GA4 or gtag SDK for React Native in Google's docs. Apps report to GA4 through Firebase Analytics (below). `/debug/mp/collect` can validate payloads you hand-build [GA3] | See Firebase RN | None | Dev/test GA4 property as in the web row [GA8] | See Firebase RN |
| Firebase web (`firebase/analytics`) | Wraps gtag.js: loads `googletagmanager.com/gtag/js` and, without a `measurementId`, GETs `firebase.googleapis.com/v1alpha/projects/-/apps/{app-id}/webConfig`; hits as in the GA4 web row [FB5] | Google Analytics Debugger Chrome extension [FB1]. `initializeAnalytics(app, {config})` forwards `config` to the first gtag `config` call, whose type accepts arbitrary keys, so `debug_mode` should pass through (inferred from the type) [FB5] | As GA4 web. The Emulator Suite does not support Analytics [FB4] | Separate Firebase project per environment; web config chosen by a runtime check [FB9] | `setConsent()` sends a gtag consent update (default "granted"); `setAnalyticsCollectionEnabled(false)` sets `window['ga-disable-<id>']` [FB5] |
| Firebase RN (React Native Firebase) | No wire contract found. The native SDKs are binaries and the Firebase docs I read name no endpoint or override. RN Firebase calls itself the officially recommended RN package [FB10] | iOS: `-FIRDebugEnabled` / `-FIRDebugDisabled` [FB1] and `-FIRAnalyticsVerboseLoggingEnabled` prints events to the Xcode console [FB2]. Android: `adb shell setprop debug.firebase.analytics.app <pkg>`, undo with `.none.` [FB1]. RNFB: `globalThis.RNFBDebug = true` on "other" platforms [FB6] | None (Emulator Suite excludes Analytics) [FB4] | `google-services.json` per build variant on Android; `GoogleService-Info.plist` per target, or loaded at runtime, on Apple [FB9]. Collection off: `firebase.json` `react-native.analytics_auto_collection_enabled: false` (reversible in JS) or `analytics_collection_deactivated` (permanent) [FB6][FB7][FB8] | `setConsent()`; build-time defaults `analytics_default_allow_analytics_storage` and siblings [FB7][FB8]. With consent denied, apps send events without device or user identifiers [GA6] |
| Amplitude web | POST `https://api2.amplitude.com/2/httpapi` (EU `api.eu.amplitude.com`), `/batch` with `useBatch`; JSON `{api_key, events}`; 200 body has `events_ingested`. Also GET `sr-client-cfg.amplitude.com/config` (`fetchRemoteConfig` default true) and diagnostics posts [AM3][AM5] | `logLevel: Debug` (None, Error, Warn default, Verbose, Debug). `track()` resolves with a result code, e.g. `0` "Event skipped due to optOut config". No dry-run mode [AM1][AM2][AM3] | `serverUrl`, or a custom `transportProvider` [AM1][AM5] | "Always create a test project or a dev environment for each production project" [AM4] | `optOut: true` or `setOptOut()` makes `process()` return before any destination; dropped, not queued; persisted in a cookie [AM2][AM5]. A `before` plugin returning `null` also drops events [AM5] |
| Amplitude RN | Same endpoints; `flushQueueSize` 30 [AM1] | `logLevel`, `loggerProvider`; plugin types `before`, `enrichment`, `destination` [AM1] | `serverUrl` / `useBatch` / `serverZone` [AM1] | As web [AM4] | `optOut: true` or `setOptOut(true)`: nothing saved or sent; persists [AM1] |
| Mixpanel web | Default `api_host` `https://api-js.mixpanel.com` (the HTTP API's regional hosts are `api-eu.mixpanel.com` and `api-in.mixpanel.com`); routes `track/`, `engage/`, `groups/`, `record/`, `flags/`, `settings/`. Default `api_payload_format` is base64, so a decoder must base64 the `data` field. Batching on: `batch_size` 50, `batch_flush_interval_ms` 5000 [MX3][MX5] | `debug: true` or `set_config({debug: true})` logs to the console; `verbose` adds `verbose=1` so the API returns `{status, error}`. Hooks `before_send_events` and `before_track` can drop events [MX1][MX3][MX5] | `api_host`, `api_hosts`, `api_routes` [MX5] | Separate dev and prod projects; pick the token by hostname [MX4]. The token is "intended for untrusted clients", so it is routing, not a secret [MX3] | `opt_out_tracking_by_default: true`: `track` returns without a request and queued requests flush only if not opted out. `opt_in_tracking()` sends an `$opt_in` event by default [MX1][MX5] |
| Mixpanel RN | `{serverURL}/track`, `/engage`, `/groups` (default `https://api.mixpanel.com`); flush at 50 events or every 60 s and on backgrounding. Native mode (default) uses the native SDKs, so JS fetch mocks see nothing; JS mode (`useNative=false`) is plain fetch and does not flush on background [MX2] | `setLoggingEnabled(true)` prints to the Xcode or Android Studio console [MX2] | `init(optOutDefault, superProps, serverURL)` or `setServerURL()` [MX2][MX6] | Projects as web; there is no hostname to switch on, so the token must come from build config (inference) | `init(true)` sends nothing until `optInTracking()` [MX2] |

## Implications for the factory

What to keep:

- **Wire interception on web, endpoint pattern recorded at setup.** Every web SDK above has a stable host and path set, so no app change is needed. Cost: one decoder per provider (gzip for PostHog, base64 for Mixpanel, Google's undocumented `/g/collect` query format), proven once at setup like any other check.
- **Device logs for mobile.** `mobile_get_device_logs` reads logcat and the unified log, so the design's log route exists [X2]. Whether a JS-level logger (Segment RN, Amplitude, PostHog, Mixpanel JS mode) reaches those logs in the build under test was not verified here; setup must prove it per app.
- **The PII, consent and production-key checks**, with the changes below.

What to change:

1. **Make "block and record" the web default, not "observe".** In non-production runs, route each provider's hosts through `context.route` and `route.fulfill` a 2xx, and set `serviceWorkers: 'block'` because service-worker traffic bypasses routes [X1]. Benefit: nothing can reach production even with a wrong key, and runs are deterministic. Trade-off: the SDK sees fake success, so server-side rejections (Amplitude 400s, Mixpanel `verbose` errors, Measurement Protocol validation) are not caught; PostHog hides them behind 200 anyway [PH3]. Playwright's network guide does not mention `sendBeacon`, so setup must show beacon-sent events are routed too.
2. **Give analytics two explicit profile states.** `capture` is the SDK enabled with a dev or placeholder key, pointed at the recorder; `off` is the SDK disabled, with zero requests expected. The current "analytics unset" profile cannot verify events because every provider drops events when disabled. Event criteria need `capture`; consent-off criteria need `off` or a denied-consent walk. On Firebase RN the two can be separate builds: `analytics_collection_deactivated` is permanent, `analytics_auto_collection_enabled` is reversible [FB7].
3. **Replace "no analytics request before consent" with a per-provider mode recorded at setup.** `strict` (PostHog and Mixpanel opt-out default, Amplitude `optOut`, Segment all-denied, Google basic mode): zero event requests. `signalled` (Google advanced mode, Segment partial consent, Firebase with denied defaults): requests are legal but must carry the denied state (`gcs`/`gcd` [GA5], `context.consent.categoryPreferences` [SG5]). Also tag non-event traffic (PostHog `/flags`, Segment settings, Amplitude remote config, Mixpanel `settings/`) so it is not a P0 by itself; whether those fire while opted out was not verified. Benefit: no false P0 on a correct Google advanced-mode setup, and no false pass on a leaky one. Trade-off: one more setup field and a classification step.
4. **Treat client tokens as routing config.** PostHog's token is write-only [PH9], Mixpanel's is "intended for untrusted clients" [MX3], and the Segment write key, Amplitude key and GA4 measurement ID must be present in client code for the SDK to send at all (inference). Record the production identifiers at setup (non-secret) and have `verify.mjs` search every observed request, blocked ones included, and the built mobile config for them: a hit is the existing P0. For Firebase, check the chosen `google-services.json` or `GoogleService-Info.plist` per variant at build time, since there is no wire to watch [FB9]. Trade-off: the check is only as good as the recorded IDs; unknown production IDs should yield `needs-human`.
5. **Rewrite the credentials wording for analytics.** No provider has a test mode like Stripe's; the equivalent is a separate project, source or property [PH5][SG7][AM4][MX4][GA8][FB9]. Setup section J should offer: a dedicated dev key in `.factory/env.local`; a placeholder key plus the recorder (enough for web under item 1); or "not available", which records `skipped`. Costs to state: PostHog's free plan includes one project, so separate dev projects need a paid plan [PH9]; Mixpanel bills MTUs across projects [MX4]; GA4 data filters are permanent and forward-only [GA7].
6. **Mobile local sinks work for four providers and need build support.** PostHog `host`, Segment `proxy` and `cdnProxy`, Amplitude `serverUrl`, Mixpanel `serverURL` can target a recorder; Firebase cannot. Android 9+ blocks cleartext HTTP unless the app opts in per domain [X3], and Segment RN rejects `http://` without `allowInsecureProxy` [SG6]. Plan on a debug-build exemption or an HTTPS recorder. This only works if the app reads the host from the recipe's `env`; otherwise fall back to logs. Trade-off: the sink path is stronger evidence than logs but touches app configuration.
7. **Label evidence strength.** Write `verified: wire | log | sdk-hook` per event in `analytics.json`. Firebase and GA4 on mobile can only reach `log`, and DebugView is not isolation [FB1]; `merge-decision.mjs` can then treat a `log`-only analytics criterion as weaker than a `wire` one, without changing `qa.json`'s pass rule.
8. **Correct the batching note.** The design says providers that batch need SDK debug mode instead of request capture. Batching only delays the request: PostHog RN 10 s, Segment RN 30 s, Mixpanel RN 60 s, Mixpanel web 5 s [PH2][SG6][MX2][MX5]. End each analytics walk with a flush step (navigate away or background the app, then wait) so events are not wrongly `missing`. Cost: a few seconds per run.

Gaps and unverified items:

- Segment's docs site returns HTTP 403 to automated fetches, so Segment claims rest on SDK source; the per-environment guidance [SG7] comes from a search excerpt of that page.
- Firebase native Analytics endpoints and payload are not published in the docs read; the Android `log.tag.FA` verbose recipe was not found in current docs.
- Mixpanel web's `test` option adds `test=1` to requests [MX5]; its server effect is not documented in the sources read, so do not rely on it.
- iOS App Transport Security behaviour for a localhost sink and the Android emulator host alias were not confirmed.
- PostHog's multi-environment tutorial [PH5] is dated 2024-05-30; the current projects page [PH9] gives the same recommendation.

## Sources

PostHog
- [PH1] https://posthog.com/docs/libraries/js/config
- [PH2] https://posthog.com/docs/libraries/react-native
- [PH3] https://posthog.com/docs/api/capture
- [PH4] https://posthog.com/docs/privacy/data-collection
- [PH5] https://posthog.com/tutorials/multiple-environments
- [PH9] https://posthog.com/docs/settings/projects
- [PH6] https://github.com/PostHog/posthog-js/blob/main/packages/browser/src/posthog-core.ts (`analyticsDefaultEndpoint`, `capture`, compression) and `remote-config.ts` in the same folder
- [PH7] https://github.com/PostHog/posthog-js/blob/main/packages/core/src/posthog-core-stateless.ts (`/batch/`, `/flags/?v=2`, `disabled`) and `types.ts` (`disableCompression`)
- [PH8] https://github.com/PostHog/posthog-js/blob/main/packages/react-native/src/posthog-rn.ts

Segment
- [SG1] https://github.com/segmentio/analytics-next/blob/master/packages/browser/src/browser/settings.ts
- [SG2] https://github.com/segmentio/analytics-next/blob/master/packages/browser/src/browser/index.ts (load, `disable`, settings URL) and `core/buffer/index.ts` (pre-init buffer)
- [SG3] https://github.com/segmentio/analytics-next/blob/master/packages/browser/src/plugins/segmentio/index.ts and `batched-dispatcher.ts`
- [SG4] https://github.com/segmentio/analytics-next/blob/master/packages/browser/src/core/analytics/index.ts
- [SG5] https://github.com/segmentio/analytics-next/blob/master/packages/consent/consent-tools/README.md and `src/domain/blocking-middleware.ts`
- [SG6] https://github.com/segmentio/analytics-react-native/blob/master/README.md; `packages/core/src/types.ts`, `constants.ts`, `util.ts`, `plugins/ConsentPlugin.ts`, `plugins/SegmentDestination.ts`
- [SG7] https://segment.com/docs/segment-app/set-up-envs/

Google Analytics 4
- [GA1] https://developers.google.com/analytics/devguides/collection/ga4/troubleshoot
- [GA2] https://support.google.com/analytics/answer/7201382
- [GA3] https://developers.google.com/analytics/devguides/collection/protocol/ga4/validating-events
- [GA4] https://developers.google.com/tag-platform/security/guides/consent
- [GA5] https://developers.google.com/tag-platform/security/concepts/consent-mode
- [GA6] https://support.google.com/analytics/answer/9976101
- [GA7] https://support.google.com/analytics/answer/10108813
- [GA8] https://support.google.com/analytics/answer/10607999
- [GA9] https://developers.google.com/tag-platform/tag-manager/server-side/intro
- [GA10] https://developers.google.com/tag-platform/security/guides/csp

Firebase
- [FB1] https://firebase.google.com/docs/analytics/debugview
- [FB2] https://firebase.google.com/docs/analytics/events
- [FB3] https://firebase.google.com/docs/analytics/configure-data-collection
- [FB4] https://firebase.google.com/docs/emulator-suite
- [FB5] https://github.com/firebase/firebase-js-sdk/blob/main/packages/analytics/src/api.ts, `constants.ts`, `public-types.ts`, `helpers.ts`
- [FB6] https://github.com/invertase/react-native-firebase/blob/main/docs/analytics/usage/index.mdx
- [FB7] https://github.com/invertase/react-native-firebase/blob/main/packages/app/firebase-schema.json
- [FB8] https://github.com/invertase/react-native-firebase/blob/main/packages/analytics/android/src/main/AndroidManifest.xml
- [FB9] https://firebase.google.com/docs/projects/multiprojects
- [FB10] https://github.com/invertase/react-native-firebase/blob/main/docs/index.mdx

Amplitude
- [AM1] https://amplitude.com/docs/sdks/analytics/react-native/react-native-sdk
- [AM2] https://amplitude.com/docs/sdks/analytics/browser/browser-sdk-2
- [AM3] https://amplitude.com/docs/apis/analytics/http-v2
- [AM4] https://amplitude.com/docs/get-started/create-project
- [AM5] https://github.com/amplitude/Amplitude-TypeScript/blob/main/packages/analytics-core/src/types/constants.ts; `config.ts`, `core-client.ts`, `types/plugin.ts`, `remote-config/remote-config.ts`

Mixpanel
- [MX1] https://docs.mixpanel.com/docs/tracking-methods/sdks/javascript
- [MX2] https://docs.mixpanel.com/docs/tracking-methods/sdks/react-native
- [MX3] https://docs.mixpanel.com/reference/track-event
- [MX4] https://docs.mixpanel.com/docs/tracking-best-practices/developer-environments
- [MX5] https://github.com/mixpanel/mixpanel-js/blob/master/src/mixpanel-core.js
- [MX6] https://github.com/mixpanel/mixpanel-react-native/blob/master/index.d.ts and `index.js`

Cross-cutting
- [X1] https://playwright.dev/docs/network
- [X2] https://github.com/mobile-next/mobile-mcp (README tool list: `mobile_get_device_logs`)
- [X3] https://developer.android.com/privacy-and-security/security-config (cleartext default, per-domain opt-in)
