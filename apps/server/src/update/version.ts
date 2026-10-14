export function parseVersion(value: string) {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(
      value,
    );
  const major = match?.[1];
  const minor = match?.[2];
  const patch = match?.[3];
  if (!match || major === undefined || minor === undefined || patch === undefined)
    throw new Error("Invalid semantic version.");
  const prerelease = match[4]?.split(".") ?? [];
  if (prerelease.some((part) => /^0\d+$/.test(part)))
    throw new Error("Invalid prerelease version.");
  return { core: { major: BigInt(major), minor: BigInt(minor), patch: BigInt(patch) }, prerelease };
}

export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (const part of ["major", "minor", "patch"] as const) {
    if (a.core[part] < b.core[part]) return -1;
    if (a.core[part] > b.core[part]) return 1;
  }
  if (!a.prerelease.length || !b.prerelease.length)
    return a.prerelease.length ? -1 : b.prerelease.length ? 1 : 0;
  for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i++) {
    const x = a.prerelease[i];
    const y = b.prerelease[i];
    if (x === y) continue;
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) return BigInt(x) < BigInt(y) ? -1 : 1;
    if (xn !== yn) return xn ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}
