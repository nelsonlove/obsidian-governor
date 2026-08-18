// config.ts — the crosssession module's typed config (#232). Defaults mirror
// the LIVE vault conventions (the 03.16 collection's own frontmatter), and are
// overridable so another vault's naming does not hardcode this one's — the
// "scheme semantics are configuration" discipline.

export interface CrosssessionConfig {
  /** fileClass a channel's folder note carries. */
  channelFileclass: string;
  /** fileClass a per-message note carries. */
  messageFileclass: string;
  /** Max entries `crosssession_delta` returns per channel per call. */
  deltaCap: number;
}

export const DEFAULT_DELTA_CAP = 20;

export const DEFAULT_CROSSSESSION_CONFIG: CrosssessionConfig = {
  channelFileclass: "Collection/Log",
  messageFileclass: "Agent/Log/CrossSession",
  deltaCap: DEFAULT_DELTA_CAP,
};

/** Coerce a merged config record (defaults ∪ user override, as `register()`
 * receives it) into a typed CrosssessionConfig — the health module's
 * degrade-to-default discipline: a hand-edited data.json must never crash a
 * tool, only fall back. */
export function crosssessionConfigOf(config: Record<string, unknown>): CrosssessionConfig {
  const str = (v: unknown, dflt: string) => (typeof v === "string" && v.length > 0 ? v : dflt);
  const capRaw = config.deltaCap;
  const capN = typeof capRaw === "number" && Number.isFinite(capRaw) ? Math.floor(capRaw) : NaN;
  return {
    channelFileclass: str(config.channelFileclass, DEFAULT_CROSSSESSION_CONFIG.channelFileclass),
    messageFileclass: str(config.messageFileclass, DEFAULT_CROSSSESSION_CONFIG.messageFileclass),
    deltaCap: Number.isFinite(capN) && capN >= 1 ? capN : DEFAULT_CROSSSESSION_CONFIG.deltaCap,
  };
}

/** Manifest `validate` — findings reported to the settings tab, never thrown. */
export function validateCrosssessionConfig(config: Record<string, unknown>): string[] {
  const problems: string[] = [];
  for (const key of ["channelFileclass", "messageFileclass"] as const) {
    const v = config[key];
    if (v !== undefined && typeof v !== "string") problems.push(`${key} must be a string (a fileClass name)`);
  }
  const cap = config.deltaCap;
  if (cap !== undefined && (typeof cap !== "number" || !Number.isFinite(cap) || cap < 1)) {
    problems.push("deltaCap must be a number ≥ 1");
  }
  return problems;
}
