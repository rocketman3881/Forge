# Forge web page design notes

## Design read

- **Surface:** hybrid, marketing leads, documentation second. One page served at `/` by the Forge server.
- **Audience:** indie founders and developers arriving via a friend's invite link; terminal-comfortable.
- **Single job:** get a visitor from reading to `forge clan join <code>` with the CLI installed.
- **Content:** real CLI commands (from `forge help`), real rung tables (from the v1 spec), the spec's sidebar rendering. No invented testimonials, logos, or metrics.
- **Platform:** static HTML + one small script, served by Fastify. No build step. `__FORGE_SERVER__` is substituted with `PUBLIC_URL` at serve time so instructions always name the right backend.

## Thesis

A quiet dark editorial page whose one signature device is the product's actual terminal sidebar, reproduced from the spec. Monospace (JetBrains Mono) carries everything the user will type or see in a terminal; a humanist sans (Inter) carries prose. A single ember accent is reserved for links, the install action, and verified-milestone marks. Numbered steps form the spine: install, init, clan, share.

- Dark theme belongs because the page's centerpiece is ANSI terminal output shown in its native form, not a generic developer-dark preference.
- The terminal block belongs because the terminal is the entire product UI; its content is genuine spec output, not decorative fake logs.
- Product glyphs (bars, ⚡ presence dot) appear only inside terminal blocks as product content, never as page iconography.

## Craft/accessibility floor applied

- Semantic landmarks, one h1, skip link, focus-visible outlines, AA contrast on all text (checked against #0d1117), keyboard-operable copy buttons with status announcement via `aria-live`, `prefers-reduced-motion` respected (no ambient motion anyway), single shared content rail (72rem max, same gutters).
- No emoji UI, no hover lift, no `transition: all`, no em dashes in page copy.

## Evidence

Archetype: marketing/brand (aligned: `sanity` typographic hierarchy, `vercel` docs restraint; contrast: `apple` cinematic scale rejected, wrong for a CLI utility). Local evidence preferred throughout: CLI help text, spec tables, real command output.
