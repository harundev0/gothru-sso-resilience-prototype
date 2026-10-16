# GoThru SSO Resilience — UI Prototype

Clickable HTML/CSS/JS prototype of the Panorra × GoThru login flow when Keycloak (GoThru SSO) is down.
It follows the *Keycloak Downtime Risk Mitigation* task specs.

**Live demo:** https://harundev0.github.io/gothru-sso-resilience-prototype/
**Mobile app version:** https://harundev0.github.io/gothru-sso-resilience-prototype/mobile.html

## Flows covered

- Pre-flight screen on "Continue with Gothru": 4-step loader while the 1.5 s health probe runs. Success shows a short "You're all set" state, then redirects to GoThru SSO; failure is not shown and opens Google / Magic Link sign-in straight away.
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

`mobile.html` is the native-app flow from the illustrations: start, pre-flight, redirect,
local login (Google or Magic Link), enter email, email sent / resent, email app, verify, signed in, link invalid and home.
On a desktop it shows inside a phone frame with the scenario controls beside it; on a phone it runs full screen
(controls behind the button on the right edge). Deep links work the same way, e.g. `mobile.html#sent`, `#fallback`.

No build step and no dependencies; fonts load from Google Fonts.
