// Pure release-version helper for the skills GUI's `release` command. Kept obsidian-free (its
// own file, not commands.ts which imports `obsidian`) so it stays headless-testable — the
// repo's "pure logic is unit-tested" discipline. Ported from the standalone vault-skills
// plugin's commands.ts.

/** Suggest the next patch version from an existing semver-ish string; falls back to 0.1.0 when
 *  the input isn't an X.Y.Z triple (missing plugin.json, empty repo, malformed version). */
export function bumpPatch(version: string | undefined): string {
  const m = version?.match(/^(\d+)\.(\d+)\.(\d+)$/);
  return m ? `${m[1]}.${m[2]}.${Number(m[3]) + 1}` : "0.1.0";
}
