# Spec 10 — Product website

**Date:** 2026-10-18  
**Status:** Implemented.  
**Scope:** A public one-page site that introduces Luna like a product.
It covers capabilities, a screenshot tour, how it works, specs,
privacy, install, usage and an FAQ, and is published to GitHub Pages.

Decision: [`DECISIONS.md`](../DECISIONS.md) D38. Developer notes: [`docs/development.md`](../docs/development.md#website).

---

## 1. Goal

- In under a minute, a visitor understands what Luna is and why it's
  different: local voice, helper agents, approvals, and memory you
  control.
- They see the real product (screenshots) and can install it from the
  page.

## 2. Shape

```
site/
  index.html             meta + Open Graph (screens/og.jpg), fonts
  src/content.ts         ALL copy: SECTIONS, HERO, CAPABILITIES, SHOTS, FLOW,
                         CONVERSATIONS, SPECS, PRIVACY, INSTALL, SHORTCUTS,
                         VOICE_COMMANDS, CLI, FAQ, FOOTER_LINKS
  src/sections/          Nav · Hero · Capabilities · Showcase · How (SVG diagram,
                         4 steps, example chats) · Specs (+ privacy) · Install ·
                         Usage · Faq + Footer
  src/components/ui.tsx  Section, Reveal (scroll-in, reduced-motion aware),
                         CodeBlock (copy), Screenshot (window frame)
  src/lib/               clipboard (copyText, commandsOnly), asset (base path)
  public/screens/        hud, overview, routines, models, permissions, mobile (.webp), og.jpg
.github/workflows/site.yml   test + build + deploy to Pages (base /Luna/)
```

## 3. Rules

1. Facts come from the README, `docs/` and the code. A changed feature
   updates `content.ts`.
2. Screenshots use demo data only.
3. The page works without horizontal scroll down to 360 px. The nav
   becomes a menu under 860 px.
4. Motion is decorative and off under `prefers-reduced-motion`.
5. External images can fail (the CI badge hides itself).

## 4. Tests

- `site/src/content.test.ts`:
  - capabilities are complete and unique;
  - every nav anchor has a section;
  - non-optional install steps have commands, including `luna-web`;
  - every screenshot file exists;
  - specs and FAQ have no empty rows.
- `site/src/lib/clipboard.test.ts`: copy, failure, comment stripping, base path.
- CI runs `npm test` and `npm run build` for `site/` on every PR.

## 5. Later

- A short demo video or GIF of the voice loop.
- A custom domain (`SITE_BASE=/`).
- A changelog section generated from `DECISIONS.md`.
