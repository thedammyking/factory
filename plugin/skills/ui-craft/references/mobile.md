# Mobile craft

Read this only when the plan's app is a mobile app (`type: mobile` in the recipe). The UI lens judges its captures on the run's one device, an iOS simulator or an Android emulator: every state in the plan's `## UI states`, in light and dark, at the default and the largest text size. Build each state so it holds in all four. The floor in `SKILL.md` still holds; where a rule of it means nothing on a touch screen, this file says what stands in its place.

## In place of the web rules

- A pressable has a pressed state and a disabled state, in place of hover and `:focus-visible`.
- The 390 px rules hold at the device's own width: nothing runs off the side, button text stays inside its button, and the primary action is on the first screen.
- Tap targets are at least 44 pt on iOS and 48 dp on Android. Where the visual is smaller, `hitSlop` grows the target, never the visual.
- No pressable without an `onPress`: a control goes somewhere or is visibly disabled. The tab bar marks the current tab.

## Text

- Text scales with the system's text size: no fixed height around text, and no `allowFontScaling={false}`. At the largest size nothing truncates, overlaps or clips. Rows grow, and labels side by side wrap or stack.
- A value that must stay on one line (a price, a count) takes `adjustsFontSizeToFit` with a `minimumFontScale`, never a smaller fixed size.

## Layout

- Content stays inside the safe area (the notch, the status bar, the home indicator), through the safe-area insets, never a written-in inset.
- An input the keyboard would cover moves above it (`KeyboardAvoidingView`, or a scroll view that keeps the focused input in view), and a tap outside it dismisses the keyboard.
- A long or unbounded list is a virtualized list (`FlatList`, `SectionList` or the project's own), never a `.map` inside a `ScrollView`.

## Platform

- The scheme follows the system's (`useColorScheme`), and each color is the design token for that scheme: no color is written for light alone.
- Back works as the platform's does: the edge swipe on an iOS stack screen, and Android's back button closing the top sheet or screen before it leaves.
- Every pressable has an `accessibilityRole`, and an `accessibilityLabel` when its text or icon alone doesn't name it.
- Under the system's reduce-motion setting (`AccessibilityInfo.isReduceMotionEnabled`, or the animation library's own hook), a fade replaces movement.
