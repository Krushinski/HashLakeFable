import { defineConfig } from 'vite'
import { execSync } from 'node:child_process'

let commit = 'dev'
try {
  commit = execSync('git rev-parse --short HEAD').toString().trim()
} catch {
  /* not a git checkout (CI tarball) — keep 'dev' */
}

export default defineConfig({
  base: '/HashLakeFable/',
  define: {
    __BUILD_COMMIT__: JSON.stringify(commit),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2000,
  },
})
