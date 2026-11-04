---
name: ui-craft
description: "The factory's floor for UI code. Load it before writing or changing UI in a factory ticket, which is any plan with a `## UI states` section. It holds the measurable rules every screen meets and says whose look wins."
user-invocable: false
---

# UI craft

The UI lens judges captures, not code: every state in the plan's `## UI states`, at 390, 768 and 1440 px wide, in light and dark, with touch at 390 px. Build each state so it holds in all six.

Authority, highest first:
1. The floor below. Nothing else overrides it.
2. The project's design tokens (type, color, space, radius, icons, motion), where `design-ref.md` says they live: a theme file, a Tailwind config or CSS variables.
3. The pattern in `design-ref.md` beside the plan: a Figma design, or else the existing UI's design language (with no UI yet, the default theme of the library the first UI ticket installs), laid out like its Mobbin picks when it has any. It lends structure, never skin. Follow its structure, and compose something new only for what it doesn't show, from the project's existing screens before anything invented.
4. Any other design skill installed in the project. Wherever it disagrees with the project's design tokens or `design-ref.md` (fonts, colors, icon sets, page structure), the project wins.

Read the files `design-ref.md`'s `## Design tokens` names before you write any UI. The design-token rule: every color, size, space, radius and duration is a design token, or else a value the existing screens already use. When the value you need is neither, use the nearest one and note it under `assumptions:` in `implementation.md`. Add no theme file the plan doesn't ask for. When `design-ref.md` says there is no design reference and no design tokens, use the stack's own defaults, define no palette, and note that too. Where its `## Floors that override it` replaces part of the reference, build the replacement.

When the codebase has a component library, build every design from its components, whatever the design's source: match it through the components' variants, props and the project's design tokens, never by replacing them. Write a new component only where the library has none for the job, compose it from the library's primitives, and note it in `implementation.md`. Without a library, reuse the project's own components before writing new ones.

## Floor

Layout and actions
- One primary action per surface.
- Links and code values use the full width and never clip.
- Reserve widths so a label change (Copy → Copied) doesn't shift the layout.
- At 390 px: no horizontal overflow, button text stays inside its button, and the primary action is on the first screen.
- An inner corner's radius is the outer radius minus the gap, when the gap is under 32 px and the result is over 2 px.

Interaction
- Every interactive element has hover, active, `:focus-visible` and disabled styles. A focus style never looks like an input.
- Tap targets are at least 44 px under `pointer: coarse`.
- Data views have a loading state (a skeleton shaped like the content), an empty state (a composed starting view) and an error state.
- No `href="#"`: a control links somewhere or is visibly disabled. The nav marks the current page.

Contrast
- Text at least 4.5:1; large text, icons, input borders and focus rings at least 3:1. Gradient text is measured at its lightest end.
- State is never shown by color alone: pair it with an icon, a label or a weight change.

Motion
- At most 300 ms, ease-out. Never from `scale(0)`.
- Animate only `transform` and `opacity`, never `top`, `left`, `width` or `height`.
- Under `prefers-reduced-motion: reduce`, an opacity change replaces movement.
- Scroll-triggered effects use `IntersectionObserver`, never an unthrottled `scroll` listener.

Content
- Never invent facts. Prices, counts, statistics, testimonials and logos come from the spec or the repo; anything else is a visible `{{placeholder}}`.
- An error says what failed and what to do next. A confirmation names what was done. No exclamation marks.
- No filler: "revolutionize", "supercharge", "cutting edge", "effortless", "world class".
