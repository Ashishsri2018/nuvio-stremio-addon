import type { StremioManifest } from "../types.js";

export const ADDON_ID = "community.nuvio.stremio";
export const ADDON_VERSION = "1.0.0";

export function getManifest(): StremioManifest {
  return {
    id: ADDON_ID,
    version: ADDON_VERSION,
    name: "Nuvio Streams",
    description: "Streams from Nuvio/Eclipsia providers",
    types: ["movie", "series"],
    resources: ["stream"],
    idPrefixes: ["tt"],
    catalogs: [],
    behaviorHints: { configurable: true },
  };
}
