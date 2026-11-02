---
name: ui-craft
description: "The factory's floor for UI code. Load it before writing or changing web UI in a factory ticket, which is any plan with a `## UI states` section. It holds the measurable rules every screen must meet."
---

# UI craft

Authority, highest first:
1. The floor below. It holds whatever the other three say.
2. The project's design tokens (type, color, space, radius, icons, motion), where `design-ref.md` says they live: its theme file, Tailwind config or CSS variables.
3. `design-ref.md` beside the plan: the proven pattern to follow, from a Figma design, or else the existing UI's design language (with no UI yet, HeroUI's or shadcn/ui's), laid out like the Mobbin picks from shipped products when there are any. Follow its structure. Compose something new only for what it does not show, and then from the project's existing screens before anything invented.
4. Any other design skill installed in the project. Where it disagrees with the project's design tokens or `design-ref.md` (fonts, colors, icon sets, page structure), the project wins.

Read the files `design-ref.md` names for the design tokens first. Every color, size, space, radius and duration resolves to a design token or, where the project has no theme, to a value its existing screens already use. If a value you need is missing, use the nearest one and say so in `implementation.md`. Add no theme file the plan does not ask for. When `design-ref.md` says there is no proven reference, use the stack's own defaults, define no palette, and say so in `implementation.md`. When the codebase has a component library, build every design from its components, whether the design came from Figma or Mobbin: match the design through the component's variants, props and theme tokens, never by replacing it. Write a new component only where the library has none for the job, compose it from the library's primitives, and say so in `implementation.md`. Without a library, reuse the project's existing components before writing new ones.

## Floor

Layout and actions
- One primary action per surface.
- Link and code values use the full width and never clip.
- Reserve widths so a label change (Copy → Copied) does not shift the layout.
- At 390 px: no horizontal overflow, button text stays inside the button, and the primary action is in the first screen.
- An inner corner's radius is the outer radius minus the gap, when the gap is under 32 px and the result is over 2 px.

Interaction
- Every interactive element has hover, active, `:focus-visible` and disabled styles. Focus styles never imitate an input.
- Tap targets are at least 44 px under `pointer: coarse`.
- Data views have a loading state (a skeleton shaped like the content), an empty state (a composed starting view) and an error state.
- No `href="#"`: a control is linked or visibly disabled. The nav marks the current page.

Contrast
- Text at least 4.5:1; large text, icons, input borders and focus rings at least 3:1. Gradient text is checked at its lightest end.
- State is never shown by color alone: pair it with an icon, a label or a weight change.

Motion
- At most 300 ms, ease-out. Never `scale(0)`.
- Animate only `transform` and `opacity`, never `top`, `left`, `width` or `height`.
- Under `prefers-reduced-motion: reduce`, replace movement with an opacity change.
- Scroll-triggered effects use `IntersectionObserver`, never an unthrottled `scroll` listener.

Content
- Never invent facts. Prices, counts, statistics, testimonials and logos come from the spec or the repo; anything else is a visible `{{placeholder}}`.
- Errors say what failed and what to do next. Confirmations name what was done. No exclamation marks.
- No filler: "revolutionize", "supercharge", "cutting edge", "effortless", "world class".
