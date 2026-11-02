# What can each mobile tool verify without a person?

Research for issue #4 (slug `mobile-verification`). Context: [runtime verification](../design/design.md#runtime-verification-run-every-app-walk-every-criterion) and brief stage 10.

Researched 2026-11-02 from vendor docs, tool source and changelogs. Versions seen: mobile-mcp 1.0.15 (2026-10-30) [3], Maestro CLI 2.12.1 (2026-11-02) [19], Expo MCP docs written against SDK 58 [22]. Nothing here was run on a device: the research machine has no full Xcode and no emulator. Claims marked **unverified** have no vendor source. Numbers in brackets point to the source list at the end.

## Answer

- Almost everything on the ticket's list can run unattended on a Mac (iOS simulator plus Android emulator) and on Linux (Android only), but no single tool does it all. Two items lack first-party documentation: iOS text size and iOS in-place upgrade.
- **mobile-mcp** drives and observes (tap, type, swipe, screenshot, accessibility tree, logs, crashes) on both platforms, but cannot boot a device, set dark mode or text size, or open custom-scheme deep links by default. **Maestro** adds dark mode, deep links, launch arguments, permissions and JUnit reports, but does not install apps, set text size or test upgrades. **Expo MCP** (local) only taps, screenshots and finds a view by `testID`.
- Environment control (boot, install over the old build, appearance, text size, deep links, logs) is only complete in `xcrun simctl` and `adb`, so the design should put it in `run-apps.sh`, not in the agent's tool list.
- iOS needs full Xcode, not just the command line tools (the design's wording is wrong). Java 17+ is needed only for Maestro; mobile-mcp needs Node 20+ and no Java.

## Capability matrix

Legend: **Y** documented to work; **N** not offered; **via run** only inside a Maestro flow the agent submits; **?** not documented in the sources read.

### iOS (simulator; of these tools only mobile-mcp also supports physical iPhones)

| Capability | mobile-mcp | Maestro CLI | Maestro MCP | Expo MCP (local) | `xcrun simctl` |
|---|---|---|---|---|---|
| Boot | N, "boot first" [1] | Y `start-device --platform ios` [15] | N, `list_devices` only [14] | N; EAS cloud sims are billed [22] | Y `boot`, `shutdown`, `create`, `clone` [33] |
| Install | Y `mobile_install_app` (.app/.zip) [2] | ? | N | N; `expo run:ios` or drag .app [25] | Y `install` [33] |
| Launch | Y `mobile_launch_app`, optional locale [2] | Y `launchApp` (`clearState`, `permissions`, `arguments`) [11] | via run | N | Y `launch` with args [33] |
| Tap / type / swipe | Y [1][2] | Y [10] | via run | tap only, by coords or `testID`; no type, no swipe [22] | N, no input subcommand in the sources read |
| Screenshot / video | Y screenshot, recording [2] | Y `takeScreenshot`, `startRecording` [10] | Y `take_screenshot` [14] | Y `automation_take_screenshot` [22] | Y `io booted screenshot`, `recordVideo` [33][32] |
| Dark mode | N [2] | Y `setDarkMode` (XCTest runner) [12][21] | via run | N | Y `ui booted appearance dark` (Apple staff) [34] |
| Large text | N [2] | N [10] | N | N | `ui … content_size <category>` **unverified**, third-party only [39] |
| Accessibility tree | Y `mobile_list_elements_on_screen` [1] | selectors only; no dump command listed [10] | Y `inspect_screen`, JSON hierarchy [14] | partial: `automation_find_view` by `testID` or label [22] | N |
| Logs | Y unified log, crash list and report [1][2] | N device logs; run artifacts `maestro.log`, `commands.json`, crash detection [18][19] | N | Y `collect_app_logs`, short window, native and JS [22] | Y `spawn booted log stream` [33] |
| Deep link | partial: http/https only unless `MOBILEMCP_ALLOW_UNSAFE_URLS=1` [1][2] | Y `openLink`; first deep link shows an "Open in" prompt, persistent per simulator [13] | via run | CLI only: `npx uri-scheme open … --ios` [26] | `openurl` exists (forum report only); universal links may open Safari [36] |
| Upgrade over prior build | ? | N (no install); `launchApp` without `clearState` keeps data [11] | N | N | ? `install` over an existing app is not documented in the sources read |

### Android (emulator; real devices also work for mobile-mcp, Maestro and adb)

| Capability | mobile-mcp | Maestro CLI | Maestro MCP | Expo MCP (local) | `adb` / `emulator` |
|---|---|---|---|---|---|
| Boot | N [1] | Y `start-device --platform android`; boot wait bounded since 2.12.0 [15][19] | N | N | Y `emulator -avd X -no-window -no-audio -no-boot-anim -no-snapshot` [28]; the `emulator` tool is deprecated for `android emulator` [28] |
| Install | Y .apk [2] | N, "app must already be installed" [16] | N | N; `expo run:android` [25] | Y `install`, `install-multiple`; flags `-r -d -t -g` documented under `pm install` [27] |
| Launch | Y [2] | Y [11] | via run | N | Y `shell am start` [27] |
| Tap / type / swipe | Y [1] | Y [10] | via run | tap only (`adb shell input tap`) [23] | Y `shell input`, as used in [23]; first-party `android input` with selectors [31] |
| Screenshot / video | Y [2] | Y [10] | Y [14] | Y (`screencap`) [23] | Y `exec-out screencap -p`; `screenrecord` capped at 3 min, no audio [27] |
| Dark mode | N [2] | Y `setDarkMode` runs `cmd uimode night yes\|no` [12][20] | via run | N | Y `shell cmd uimode night yes`; documented only in Maestro's source [20] |
| Large text | N [2] | N [10] | N | N | Y `shell settings put system font_scale 1.2f` [29] |
| Accessibility tree | Y [1] | selectors only [10] | Y [14] | partial; uses `uiautomator dump` [23] | Y `exec-out uiautomator dump` [23]; first-party `android layout` [31] |
| Logs | Y logcat, crashes [1][2] | N | N | Y `adb logcat -e <appId>` [23] | Y `logcat`; emulator `-logcat` [27][28] |
| Deep link | http/https only by default [1][2] | Y `openLink`, `autoVerify`, `browser` [13] | via run | CLI only: `uri-scheme … --android` [26] | Y `am start -a android.intent.action.VIEW -d <url>`; `pm get-app-links`, `pm verify-app-links --re-verify` [30] |
| Upgrade over prior build | ? | N (no install); keeps data without `clearState` [11] | N | N | Y `pm install -r` "keeping its data"; `-d` allows downgrade [27] |

Other facts that change how a tool is used:

- mobile-mcp registers 34 tools, including cloud ones (`mobile_login_to_cloud_provider`, `mobile_allocate_remote_device`) [2]. Since 1.0.9, when no local device exists it points at a remote cloud fleet and the agent asks first [3]. Telemetry (PostHog, Scarf) is on unless `MOBILEMCP_DISABLE_TELEMETRY` is set [1].
- `mobile_clear_app_data` is Android and iOS Simulator only, and is new in 1.0.15 [1][3]. `mobile_uninstall_app` renamed its argument to `packageName` in 1.0.9 [3]. The tool names the design uses (`mobile_list_elements_on_screen`, `mobile_click_on_screen_at_coordinates`, `mobile_swipe_on_screen`, `mobile_type_keys`, `mobile_take_screenshot`) still exist [2].
- mobile-mcp drives devices through `mobilecli`. On Android its on-device server holds the device's only UiAutomation connection, so `uiautomator dump` and Appium cannot run alongside it [6]. Whether Maestro's Android driver conflicts with it is **unverified**.
- Expo MCP's local tools need a running dev server, `expo-mcp` and `EXPO_UNSTABLE_MCP_SERVER=1`; simulator screenshots are "proxied through the server to your client" [22]. Its iOS driver is a prebuilt XCUITest runner started with `xcodebuild test-without-building` [24].
- Maestro's launch arguments reach the app as intent extras (Android) or `ProcessInfo`/`UserDefaults` (iOS) [11]. `clearKeychain` is iOS only [11]. No Maestro command sets text size [10].

## Prerequisites

| Tool | iOS | Android | Notes |
|---|---|---|---|
| mobile-mcp | Xcode and a booted simulator [1][4]; real device needs USB trust [1] | `adb` (platform-tools) and a running emulator [1] | Node.js 20+ [1]. No Java. The wiki still tells users to run WebDriverAgent by hand [4]; the changelog says the iOS agent installs itself on a simulator since 1.0.11, and the README keeps WDA only for legacy mode on physical devices (`MOBILEMCP_LEGACY_ROBOT`) [1][3]. |
| Maestro | Xcode and Command Line Tools, latest [8]; simulators only, "Physical iOS devices are not yet supported" [7][19] | Android SDK and an AVD; docs recommend an API 31+ image and list API 29-34 [9] | Java 17+ with `JAVA_HOME` [7][8]. The docs page promising API 35/36 "Q2 2026" looks stale: 2.11.0 added Android 17 (API 37) to `start-device` [19]. Linux and WSL work for Android; WSL needs ADB bridging [8]. |
| Expo MCP (local) | macOS host, simulator only [22]; full Xcode for `xcodebuild` [24] | `adb` [23] | Expo account (OAuth), SDK 54+, a development build, one dev server at a time [22][25]. |
| `xcrun simctl` | macOS and full Xcode with an iOS runtime. On a Mac with only the Command Line Tools, `xcrun simctl` fails with "unable to find utility" (observed on the research machine). | n/a | Xcode 27 ships without Simulator.app, so boot with `simctl boot`, never `open -a Simulator` [19]. Apple publishes no web reference for simctl; `xcrun simctl help` is the reference [35]. |
| `adb` / `emulator` | n/a | SDK platform-tools, emulator, a system image [27][28] | Acceleration needs KVM (Linux), HVF (macOS) or WHPX (Windows); `-accel off` is unsupported and "very slow" [28]. |

Headless and CI:

- **iOS** needs no window: mobile-mcp boots with `xcrun simctl boot` alone [1], `recordVideo` does not need Simulator.app running [32], and Maestro 2.12.0 starts simulators on Xcode 27 [19]. A macOS host is still required [4].
- **Android** has `-no-window` for servers without a display [28]. On GitHub-hosted Linux runners hardware acceleration works once the job grants KVM permissions [37][38]. GitHub's arm64 macOS runners (`macos-latest`) say "Nested-virtualization is not supported" [37], so an accelerated Android emulator there is unlikely (inference).
- No first-party recipe shows a local simulator or emulator in CI for these agent tools. mobile-mcp's CI guide builds on macOS, then tests on Mobile Next Cloud devices from Linux [5]; Maestro's documented CI integrations are Maestro Cloud ones [40]; EAS simulators are billed cloud sessions [22].
- Parallelism: Maestro shards across devices that are already booted, with `--shard-split N` and `--shard-all N` [15]. mobile-mcp uses only the first iOS simulator it finds [4].

## iOS versus Android in practice

- iOS is simulator-only for Maestro and Expo MCP; Android covers emulators and real devices [7][17][22].
- iOS needs an on-device automation agent for touch and the UI tree (mobilecli installs it; Maestro and Expo ship an XCUITest runner), so the first run on a fresh simulator pays a setup cost [6][21][24]. Android uses `adb` plus an on-device server [6].
- Prompts differ: iOS shows an "Open in" dialog on the first custom-scheme link; Android may show an app chooser unless `autoVerify` is set [13].
- State reset differs: Android `-wipe-data` or `pm clear` [27][28]; iOS `mobile_clear_app_data` (simulator only) or Maestro `clearState` and `clearKeychain` [1][11].
- Both platforms set system look from a CLI (`simctl ui`, `cmd uimode`, `settings put system font_scale`), but the first-party references are uneven: Apple staff document `appearance` [34], Android documents `font_scale` [29], and iOS `content_size` and Android `cmd uimode` have none.

## Implications for the factory

**Keep**

1. **mobile-mcp as the default mobile driver, with the design's escalation order.** It is the only listed tool that observes and acts on both platforms through the element tree, with a screenshot fallback, and it needs no Java. Trade-off: it moves fast (eight releases in the four weeks to 2026-10-30 [3]), so the `claude mcp add … @latest` line in the design risks silent tool renames. Pin the version in the recipe and let a golden task fail on drift.
2. **Maestro YAML as the pinned regression format.** It has dark mode, `openLink`, launch arguments, permissions and JUnit output, which the MCP lacks [10][12][18]. Trade-off: needs Java 17+, supports iOS simulators only, and does not install the app.
3. **Boot, install and launch inside `run-apps.sh`.** mobile-mcp cannot boot and Maestro will not install [1][16], so the script already owns the right seam. Keep `simctl boot` and `adb` there.
4. **"Linux hosts verify Android only."** Confirmed: iOS simulators run only on macOS [4][22].

**Change**

1. **Fix the prerequisite wording and check.** The design says mobile-mcp "needs only Xcode command line tools or `adb`". For iOS, `/setup-factory` should require full Xcode and probe `xcrun simctl help` and `xcodebuild -version`. Mention Java 17+ only when Maestro is chosen. Benefit: setup fails early instead of at stage 10. Never `open -a Simulator` (Xcode 27) [19].
2. **Add appearance and text size to `run-apps.sh` profiles.** mobile-mcp has no tool for either [2], and Maestro covers only dark mode [10]. Add per-app fields (for example `appearance: dark`, `text_size: max`) that map to `simctl ui booted appearance` and `content_size` on iOS, and `cmd uimode night` and `settings put system font_scale` on Android. Benefit: mobile gets the same dark and large-text states the web side captures with `capture-states.mjs`, at zero agent tokens. Trade-off: `content_size` and `cmd uimode` have no first-party reference [20][39], so the dry-run golden task must prove both on a real Mac.
3. **Capture mobile state lists by script, not by agent turns.** Loop appearance x text size, take `simctl io booted screenshot` or `adb exec-out screencap -p`, and hand the files to the UI reviewer. Benefit: deterministic and cheap, and the producer/grader separation stays. Trade-off: no accessibility-tree evidence unless the script also calls `uiautomator dump`.
4. **Wrap deep links.** mobile-mcp refuses custom schemes unless `MOBILEMCP_ALLOW_UNSAFE_URLS=1` [1][2]. Add `run-apps.sh open-link <url>` (`simctl openurl`, `am start -a VIEW -d`) restricted to the app's scheme, and accept the iOS "Open in" prompt once during `up` (the choice persists per simulator [13]). Benefit: the agent cannot open arbitrary schemes such as `tel:`. Trade-off: universal links on simulators are unreliable [36]; mark such criteria `blocked: environment` rather than guessing.
5. **Allow-list the qa agent's mobile tools.** Of the 34 tools, grant roughly: `list_available_devices`, `list_elements_on_screen`, `click`, `double_tap`, `long_press`, `swipe`, `type_keys`, `press_button`, `take_screenshot`, `save_screenshot`, `get_foreground_app`, `launch_app`, `terminate_app`, `get_device_logs`, `list_crashes`, `get_crash`, `set_orientation`. Withhold install, uninstall, clear-app-data, the four cloud tools, `set_location` and `clipboard` [2]. Benefit: smaller tool schema in context, no cloud allocation, no environment changes from an agent meant only to report. Trade-off: the agent cannot repair a bad install; that is already `blocked: environment`.
6. **Disable mobile-mcp telemetry in the recipe** (`MOBILEMCP_DISABLE_TELEMETRY=1`) [1]. It sends anonymous usage data by default, which an unattended pipeline should not do silently.
7. **Replay a pinned Maestro flow once before committing it.** The agent writes YAML from mobile-mcp element ids, but Maestro reads its own hierarchy [14], so ids and labels can differ. Run `maestro test --format junit` on the new flow after `down`/`up`, and commit only on green. Also stop mobile-mcp before the replay, because mobilecli holds Android's single UiAutomation connection [6]. The second point is an inference.

**Do not add**

- **Expo MCP.** It overlaps mobile-mcp, only taps and screenshots, needs an Expo account and SDK 54+, and routes simulator screenshots through Expo's server [22]. That is a new outbound path for app captures. Its one unique gain, JS-side logs, is already available from the dev server output that `run-apps.sh` captures. Revisit only for `testID`-targeted taps in Expo apps.
- **Maestro MCP.** Its `inspect_screen` and `run` duplicate mobile-mcp and the CLI [14]. The CLI in `verify.mjs --full` is enough.
- **The first-party Android CLI (`android`, with `emulator`, `run`, `input`, `screen`, `layout`, Journeys) in v1.** It is Android-only, collects usage metrics by default, and Journeys are agent-run prose rather than pinned scripts [31]. The `emulator` binary is deprecated in favour of `android emulator` [28], so keep emulator calls behind one function in `run-apps.sh` and revisit.

**Defer to v2: upgrade-from-previous-build criteria.** Only `pm install -r` is documented to keep data [27]; iOS in-place install semantics are undocumented in the sources read. A useful flow needs a previous build artifact, a flow that seeds state, an in-place install, then assertions. The brief says to add nothing a real run has not shown a need for, so write it as `run-apps.sh upgrade --from <artifact>` only when a ticket needs it, and prove the iOS behaviour in a golden task first.

## Unverified or conflicting

1. `simctl ui … content_size` values and live behaviour: only third-party sources [39]. Check `xcrun simctl help ui`.
2. iOS in-place upgrade: whether `simctl install` over an existing app keeps its data container. No source found.
3. `simctl openurl` is evidenced by a forum report only [36].
4. `cmd uimode night yes` is evidenced by Maestro's source only [20].
5. mobile-mcp iOS setup: the wiki says to run WebDriverAgent [4]; the README and changelog say a built-in agent is used on simulators [1][3]. Confirm on a clean simulator.
6. Maestro Android API range: the install page lists 29-34 with 35/36 "planned" [9]; the changelog shows API 37 support in `start-device` [19].
7. Maestro and mobile-mcp sharing one Android device (UiAutomation exclusivity).
8. Whether a headless macOS host without a logged-in GUI session can run `simctl boot` and the UI agents. No source found.

## Sources

1. mobile-mcp README: https://github.com/mobile-next/mobile-mcp
2. mobile-mcp tool registry: https://github.com/mobile-next/mobile-mcp/blob/main/src/server.ts
3. mobile-mcp changelog: https://github.com/mobile-next/mobile-mcp/blob/main/CHANGELOG.md
4. mobile-mcp wiki, iOS simulators: https://github.com/mobile-next/mobile-mcp/wiki/Getting-Started-with-iOS-Simulators
5. mobile-mcp CI guide: https://github.com/mobile-next/mobile-mcp/blob/main/docs/mobilewright-ci.md
6. mobilecli README: https://github.com/mobile-next/mobilecli
7. Maestro README: https://github.com/mobile-dev-inc/maestro
8. Maestro install, macOS: https://docs.maestro.dev/getting-started/installing-maestro/macos
9. Maestro install overview: https://docs.maestro.dev/getting-started/installing-maestro
10. Maestro commands: https://docs.maestro.dev/reference/commands-available
11. Maestro `launchApp`: https://docs.maestro.dev/reference/commands-available/launchapp
12. Maestro `setDarkMode`: https://docs.maestro.dev/reference/commands-available/setdarkmode
13. Maestro `openLink`: https://docs.maestro.dev/reference/commands-available/openlink
14. Maestro MCP: https://docs.maestro.dev/getting-started/maestro-mcp
15. Maestro devices and sharding: https://docs.maestro.dev/maestro-flows/flow-control-and-logic/specify-and-start-devices.md
16. Maestro on Android: https://docs.maestro.dev/get-started/supported-platform/android.md
17. Maestro platforms: https://docs.maestro.dev/get-started/supported-platform.md and https://docs.maestro.dev/platform-support/ios
18. Maestro reports: https://docs.maestro.dev/cli/test-suites-and-reports
19. Maestro changelog: https://github.com/mobile-dev-inc/maestro/blob/main/CHANGELOG.md
20. Maestro Android driver: https://github.com/mobile-dev-inc/Maestro/blob/main/maestro-client/src/main/java/maestro/drivers/AndroidDriver.kt
21. Maestro iOS XCTest runner: https://github.com/mobile-dev-inc/Maestro/blob/main/maestro-ios-xctest-runner/maestro-driver-iosUITests/Routes/Handlers/AppearanceHandler.swift
22. Expo MCP server: https://docs.expo.dev/eas/ai/mcp/
23. expo-mcp Android automation: https://github.com/expo/expo-mcp/blob/main/packages/expo-mcp/src/automation/AutomationAndroid.ts
24. expo-mcp iOS automation: https://github.com/expo/expo-mcp/blob/main/packages/expo-mcp/src/automation/AutomationIos.ts
25. Expo development builds: https://docs.expo.dev/develop/development-builds/introduction/
26. Expo linking: https://docs.expo.dev/linking/into-your-app/
27. Android Debug Bridge: https://developer.android.com/tools/adb
28. Android Emulator command line: https://developer.android.com/studio/run/emulator-commandline
29. Android font scale command: https://developer.android.com/training/tv/accessibility
30. Android App Links testing: https://developer.android.com/training/app-links/verify-android-applinks
31. Android CLI: https://developer.android.com/tools/agents/android-cli, https://developer.android.com/tools/agents/android-cli/commands/input, https://developer.android.com/tools/agents/android-cli/journeys
32. WWDC20, Become a Simulator expert: https://developer.apple.com/videos/play/wwdc2020/10647/
33. WWDC19, Getting the Most Out of Simulator: https://developer.apple.com/videos/play/wwdc2019/418/
34. Apple Developer Forums, appearance (Apple staff answer): https://developer.apple.com/forums/thread/121115
35. Apple Developer Forums, simctl documentation (Apple staff): https://developer.apple.com/forums/thread/13208
36. Apple Developer Forums, `openurl` report (user post): https://developer.apple.com/forums/thread/739379
37. GitHub-hosted runners: https://docs.github.com/en/actions/reference/runners/github-hosted-runners
38. GitHub changelog, Android hardware acceleration: https://github.blog/changelog/2024-04-02-github-actions-hardware-accelerated-android-virtualization-now-available/
39. Third-party simctl completions listing `ui content_size` (not Apple): https://github.com/sigoden/argc-completions/blob/main/completions/macos/simctl.sh
40. Maestro docs sitemap, CI integrations under `maestro-cloud/`: https://docs.maestro.dev/sitemap.md
