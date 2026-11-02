---
name: ui-craft
description: "The factory's floor for UI code. Load it before writing or changing web UI in a factory ticket, which is any plan with a `## UI states` section. It reads the project's DESIGN.md and holds the measurable rules every screen must meet."
---

# UI craft

Authority, highest first:
1. The floor below. It holds whatever the other three say.
2. The project's `DESIGN.md`: tokens, type, color, icons, motion values.
3. `design-ref.md` beside the plan: the proven pattern to follow, from a Figma design, Mobbin picks from shipped products, or the project's own screens. Follow its structure. Compose something new only for what it does not show, and then from the project's existing screens before anything invented.
4. Any other design skill installed in the project. Where it disagrees with `DESIGN.md` (fonts, colors, icon sets, page structure), `DESIGN.md` wins.

Read `DESIGN.md` first. Every color, size, space, radius and duration resolves to one of its tokens. If a value you need is missing, use the nearest token and say so in `implementation.md`.

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

## DESIGN.md shape

`/setup-factory` writes this shape when the project has no `DESIGN.md`; an existing one is used as it is.

- **Palettes**: raw colors, one palette per hue (`Primary`, `Grayscale`, `Red`, `Green`, `Yellow`…), shades `00` (near white) to `1000` (near black) with `500` the base. Translucent overlay colors live here with their opacity, because an alias cannot add one.
- **Role tokens**: `Surface/`, `Text/`, `Border/`, `Action/`, `Icon/`, `Overlay/`, each with the variants it needs (`-Hover`, `-Click`, `-Disabled`, `-Subtle`, `-Inverted`) and a light and a dark value. Every value is an alias to a palette shade, never a raw color. Code uses role tokens only, so a rebrand changes only the palettes.
- **Text styles**: named and numbered by group (Heading, Title, Body, Button, Caption), each on one step of a single type scale.
- **Scales**: spacing, radius and duration.
