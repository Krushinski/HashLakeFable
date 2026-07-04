export const buildInfo = {
  name: 'HashLake',
  phase: 'Fable p0 — First Light',
  commit: __BUILD_COMMIT__,
  builtAt: __BUILD_TIME__,
}

export function phasePillText(rendererPath: string): string {
  return `HASHLAKE · ${buildInfo.phase} · ${buildInfo.commit} · ${rendererPath}`
}
