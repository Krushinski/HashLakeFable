# Deploying HashLake to Cloudflare Pages (new private repo, free tier)

The public URL can't carry Water Pro / Sky Pro (licensed source must stay
out of public git). Target architecture: **NEW private GitHub repo →
Cloudflare Pages build → public URL**. Free tier covers all of it
(unlimited bandwidth, 500 builds/month, custom domains).

## ⚓ THE HERO CHECKPOINT — read first, never violate

**`Krushinski/HashLakeFable` stays PUBLIC and FROZEN, forever.**
https://krushinski.github.io/HashLakeFable/ is preserved exactly as it
is (round 5, main @ `78f30e2`, tagged `hero-checkpoint`) unless
Krushinski explicitly says to change it. This is the journey before
the licensed libs arrived, kept to reminisce. Consequences:

- **NEVER** flip HashLakeFable private — GitHub Pages on the free plan
  stops serving on private repos, which would kill the checkpoint URL.
- **NEVER** push, merge, or commit to its `main` — not even to delete
  `deploy.yml` or tweak the README. Any push to main re-triggers the
  Pages deploy.
- **NEVER** touch its Settings → Pages configuration.
- The Water Pro era lives in a **separate private repo** (below).

## One-time setup checklist

1. **Create a NEW private repo** (Krushinski's account):
   GitHub → New repository → name e.g. `HashLake` → **Private** →
   no README (we push into it).

2. **Push the integration branch there as its main**:
   ```
   git remote add private https://github.com/Krushinski/HashLake.git
   git push private fable/renaissance-v1:main
   ```

3. **Commit the licensed libraries** (allowed in the private repo —
   they are part of YOUR app build, not redistributed):
   - Remove these two lines from `.gitignore`:
     `src/threejs-water-pro/` and `src/threejs-sky-pro/`
   - `git add src/threejs-water-pro src/threejs-sky-pro && git commit`
   - `git push private fable/renaissance-v1:main`

4. **Cloudflare Pages**
   - dash.cloudflare.com → Workers & Pages → Create → Pages →
     "Connect to Git" → authorize GitHub → pick the **private** repo
     (`HashLake`, NOT HashLakeFable)
   - Build settings:
     - Framework preset: **None** (or Vite)
     - Build command: `npm run build`
     - Build output directory: `dist`
     - Node version: env var `NODE_VERSION = 22`
   - Deploy. Every push to the private repo's `main` auto-deploys;
     PR branches get preview URLs for free.

5. **Base path**: `vite.config.ts` pins `base: '/HashLakeFable/'` for
   GitHub Pages. In the private repo set `base: '/'` (Cloudflare
   serves at the domain root). Leave the public repo's config alone.

6. **Custom domain** (optional): Pages project → Custom domains.

## Notes

- Sourcemaps are already off in the build — the deployed bundle is
  minified-only, which is the license-respecting distribution form.
- Day-to-day development continues in this working copy; `origin`
  remains the public repo (branch pushes are fine — Pages only builds
  main), `private` receives what should deploy.
- Keep `assets-src/*.blend` and `vendor/` zips out of git as before.
