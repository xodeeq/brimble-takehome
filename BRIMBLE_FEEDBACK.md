# Brimble Platform Feedback

**What I deployed:** The frontend of this take-home assignment
**Live URL:** https://brimble-takehome.brimble.app

**Time to first successful deploy:** 1 attempt!

---

## What worked well

- The onboarding flow which highlights and explains sections of the dashboard was really helpful
- I really love the fact that setting "Root directory" for a deployment actually traverses the repo's directories. I have mis-written the root directory on Railway and probably vercel - so many times. This was super helpful and reassurring.

## Friction

- Missing CLI tool. Clicking UIs doesn't aid automation as much as using a CLI tool.
- Session keeps expiring, and I have to re-authenticate with github every now and then. For context, between opening the dashboard and going to read the documentation - shortly - session expired.

## Bugs encountered

- As for user session. It doesn't seem to handle operations that require a forced redirect. First, my session expired while I was on the dashboard screen (it had been opened from the previous day), and I got a series of token-related error popups instead of a forced redirect to the login screen. On performing a browser hard-reload, it does load the sign-in screen, but again, on successful login, another error popped up (didn't have - didn't last long enough for me to read), and it only navigates to the dashboard after another browser reload.

## What I'd change first

- Nothing, really.

## Things I'd want as a power user

- For my AI-driven workflow, i prioritise deployment tools/platforms with a CLI package. With Railway (which I deployed the API to) for example, I have a custom skill file that guides my agent through a smooth deployment in minutes, and I get to recursively improve this skill file with every deployment - with potential gotchas.

## Where I got stuck and reached out

- Nothing, really.

---

*This feedback was written after deploying this take-home project to the Brimble platform.*
