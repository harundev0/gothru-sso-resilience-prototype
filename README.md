# GoThru SSO Resilience — UI Prototype

Clickable HTML/CSS/JS prototype of the Panorra × GoThru login flow when Keycloak (GoThru SSO) is down.
It follows the *Keycloak Downtime Risk Mitigation* task specs.

**Live demo:** https://harundev0.github.io/gothru-sso-resilience-prototype/

## Flows covered

- Pre-flight screen on "Continue with Gothru": 4-step loader while the 1.5 s health probe runs, then redirect to GoThru SSO when healthy.
- In-app maintenance modal: Google and Magic Link fallback shown as soon as pre-flight fails; silent background polling every 10 s with auto-recovery redirect.
- Fallback sign-in: Google, or passwordless Magic Link (sent, resent with 60 s cooldown, 429 rate limit).
- Emergency email template, link verification (success, already used, expired).
- Dashboard: emergency session toast, session banner with retry backoff, app-to-app import states
  (live, stale cache, unprovisioned user, provider unavailable).

The original screens (Panorra "Log in to continue", GoThru SSO login, sign-in status cards) are kept as-is.

## Use

Open `index.html` in a browser, or the live demo. The **Prototype** button (bottom-left, right edge on mobile)
switches scenarios (healthy / recovers / extended outage), speed, link state and jumps to any screen.
Deep links work too, e.g. `index.html#maint-fallback`, `#ml-sent`, `#vf-success`, `#db-magic`, `#import`.

No build step and no dependencies; fonts load from Google Fonts.
