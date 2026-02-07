// @ts-expect-error opencascade.js has no type declarations
import { initOpenCascade } from 'opencascade.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type OC = any;

let ocPromise: Promise<OC> | null = null;

/** Singleton async WASM init — returns cached OC instance. */
export function getOC(): Promise<OC> {
  if (!ocPromise) {
    ocPromise = initOpenCascade().then((oc: OC) => {
      console.log('[OCCT] WASM initialized');
      return oc;
    }) as Promise<OC>;
  }
  return ocPromise!;
}

// Expose diagnostic tool on window
import('./diagnose').catch(() => {});
