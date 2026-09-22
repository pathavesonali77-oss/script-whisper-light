# Fix the four-panel generation cutoff

## What will change
- Replace the four simultaneous image workers with one paced image queue, preventing Agnes from receiving a burst after the first four panels.
- Enforce the stated 20-requests-per-minute limit across the whole Agnes image service, while continuing to rotate all nine server-only keys.
- Treat Agnes 429 / error 1015 as a real cooldown: wait before retrying instead of immediately sending another burst.
- Preserve completed panels and automatically continue queued panels after cooldown.

## Technical details
- Add a process-wide start-rate and concurrency gate around every Agnes image request.
- Keep credentials server-only and retain key rotation for quota/auth fallback.
- Update retry timing and status messaging only; scene prompts, panel count, image model, and existing saved progress remain unchanged.
- Validate the current build and inspect the generation path after the change; no full generation test will be run.
