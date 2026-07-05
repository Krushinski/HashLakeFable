# Deploying HashLake to Cloudflare Pages (private repo, free tier)

The public URL can't carry Water Pro / Sky Pro (licensed source must stay
out of public git). Target architecture: **private GitHub repo →
Cloudflare Pages build → public URL**. Free tier covers all of it
(unlimited bandwidth, 500 builds/month, custom domains).

## One-time setup checklist

1. **Make the repo private**
   GitHub → HashLakeFable → Settings → General → Danger Zone →
   "Change repository visibility" → Private.
   (GitHub Pages on the free plan stops serving when private — that's
   fine, Cloudflare replaces it.)

2. **Commit the licensed libraries** (allowed once private — they are
   part of YOUR app build, not redistributed):
   - Remove these two lines from `.gitignore`:
     `src/threejs-water-pro/` and `src/threejs-sky-pro/`
   - `git add src/threejs-water-pro src/threejs-sky-pro && git commit`

3. **Cloudflare Pages**
   - dash.cloudflare.com → Workers & Pages → Create → Pages →
     "Connect to Git" → authorize GitHub → pick `HashLakeFable`
   - Build settings:
     - Framework preset: **None** (or Vite)
     - Build command: `npm run build`
     - Build output directory: `dist`
     - Node version: env var `NODE_VERSION = 22`
   - Deploy. Every push to `main` auto-deploys; PR branches get
     preview URLs for free.

4. **Base path**: Cloudflare serves at the domain root, but
   `vite.config.ts` pins `base: '/HashLakeFable/'` for GitHub Pages.
   Either keep the sub-path (works fine at
   `https://<project>.pages.dev/HashLakeFable/`) or set
   `base: '/'` once GitHub Pages is retired.

5. **Custom domain** (optional): Pages project → Custom domains.

## Notes

- Sourcemaps are already off in the build — the deployed bundle is
  minified-only, which is the license-respecting distribution form.
- GitHub Actions `deploy.yml` can be deleted after migration (it can't
  build the licensed deps anyway).
- Keep `assets-src/*.blend` and `vendor/` zips out of git as before.
