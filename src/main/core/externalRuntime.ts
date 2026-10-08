import fs from 'node:fs';
import path from 'node:path';
import type { VersionJson } from './versions';

export function fmlArgument(json: VersionJson, flag: string): string | undefined {
  const args = [
    ...(json.arguments?.game ?? []).flatMap((a) => (typeof a === 'string' ? [a] : Array.isArray(a.value) ? a.value : [a.value])),
    ...(json.minecraftArguments?.match(/"[^"]*"|\S+/g) ?? []).map((a) => a.replace(/^"|"$/g, '')),
  ];
  const index = args.indexOf(flag);
  const value = index < 0 ? args.find((a) => a.startsWith(flag + '='))?.slice(flag.length + 1) : args[index + 1];
  return value && /^[a-zA-Z0-9_.+-]+$/.test(value) ? value : undefined;
}

export function neoRuntimePaths(json: VersionJson): string[] {
  const neo = fmlArgument(json, '--fml.neoForgeVersion');
  if (!neo) return [];
  const mc = fmlArgument(json, '--fml.mcVersion'),
    form = fmlArgument(json, '--fml.neoFormVersion');
  const fml = json.libraries?.find((l) => l.name?.startsWith('net.neoforged.fancymodloader:loader:'))?.name?.split(':')[2];
  const modern = Number(fml?.split('.')[0]) >= 11 || json.mainClass === 'net.neoforged.fml.startup.Client';
  const universal = `net/neoforged/neoforge/${neo}/neoforge-${neo}-universal.jar`;
  // FML 4–10 locates generated SRG/extra + NeoForge client overlays at runtime.
  // FML 11's unobfuscated client uses a different artifact; never put either on -cp.
  return !modern && mc && form
    ? [
        universal,
        `net/neoforged/neoforge/${neo}/neoforge-${neo}-client.jar`,
        ...['srg', 'extra'].map((s) => `net/minecraft/client/${mc}-${form}/client-${mc}-${form}-${s}.jar`),
      ]
    : [universal, `net/neoforged/minecraft-client-patched/${neo}/minecraft-client-patched-${neo}.jar`];
}

export function missingNeoRuntime(json: VersionJson, shared: string): string[] {
  return neoRuntimePaths(json).filter((rel) => {
    try {
      return !fs.statSync(path.join(shared, rel)).isFile() || fs.statSync(path.join(shared, rel)).size === 0;
    } catch {
      return true;
    }
  });
}

/** External launchers may omit FML's dynamically loaded sibling artifacts from
 * libraries. Reuse only matching runtime coordinates, never any instance data. */
export function reuseExternalRuntimeLibraries(json: VersionJson, roots: string[], shared: string, destinations: string[]): number {
  const relative = new Set(destinations.map((dest) => path.relative(shared, dest)));
  for (const lib of json.libraries ?? []) {
    const p = lib.name?.split(':');
    if (p && p.length >= 3 && p.every((s) => /^[a-zA-Z0-9_.+-]+$/.test(s)))
      relative.add(`${p[0].replace(/\./g, '/')}/${p[1]}/${p[2]}/${p[1]}-${p[2]}${p[3] ? '-' + p[3] : ''}.jar`);
  }
  neoRuntimePaths(json).forEach((rel) => relative.add(rel));
  const mc = fmlArgument(json, '--fml.mcVersion'),
    form = fmlArgument(json, '--fml.neoFormVersion');
  if (mc && form)
    for (const suffix of ['srg', 'extra', 'slim']) relative.add(`net/minecraft/client/${mc}-${form}/client-${mc}-${form}-${suffix}.jar`);
  const fml = json.libraries
    ?.map((l) => l.name?.split(':'))
    .find((parts) => parts?.[0] === 'net.minecraftforge' && parts[1] === 'fmlloader');
  if (fml?.[2] && /^[a-zA-Z0-9_.+-]+$/.test(fml[2])) {
    for (const artifact of ['fmlcore', 'javafmllanguage', 'lowcodelanguage', 'mclanguage', 'fmlearlydisplay']) {
      relative.add(`net/minecraftforge/${artifact}/${fml[2]}/${artifact}-${fml[2]}.jar`);
    }
    for (const classifier of ['universal', 'client']) relative.add(`net/minecraftforge/forge/${fml[2]}/forge-${fml[2]}-${classifier}.jar`);
  }
  let count = 0;
  for (const rel of relative) {
    if (path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..') || !rel.endsWith('.jar')) continue;
    const dest = path.join(shared, rel);
    if (fs.existsSync(dest)) continue;
    const source = roots.map((root) => path.join(root, 'libraries', rel)).find((file) => fs.existsSync(file) && fs.statSync(file).isFile());
    if (!source) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    try {
      fs.copyFileSync(source, dest, fs.constants.COPYFILE_EXCL);
      count++;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  return count;
}
