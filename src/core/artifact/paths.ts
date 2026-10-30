const reserved = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i;

export function normalizeArtifactPath(input: string): string {
  if (typeof input !== 'string' || !input || input.includes('\0') || input.includes('\\') || input.startsWith('/') || /^[A-Za-z]:/.test(input)) throw new Error('Invalid artifact path');
  for (const character of input) {
    const code = character.charCodeAt(0);
    if (character.length === 1 && code >= 0xd800 && code <= 0xdfff) throw new Error('Invalid artifact path');
  }
  const parts = input.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || /[. ]$/.test(part) || reserved.test(part) || /[<>:"|?*]/.test(part) || [...part].some((char) => char.charCodeAt(0) < 32))) throw new Error('Invalid artifact path');
  const normalized = input.normalize('NFC');
  if (normalized !== input) throw new Error('Artifact path must use NFC normalization');
  return normalized;
}

export function validateArtifactPaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const normalizedPaths = paths.map((path) => {
    const normalized = normalizeArtifactPath(path);
    const key = normalized.toLocaleLowerCase('en-US');
    if (seen.has(key)) throw new Error('Duplicate or case-colliding artifact path');
    seen.add(key);
    return normalized;
  });
  const directories = new Map<string, string>();
  for (const path of normalizedPaths) {
    for (let separator = path.indexOf('/'); separator !== -1; separator = path.indexOf('/', separator + 1)) {
      const directory = path.slice(0, separator);
      const folded = directory.toLocaleLowerCase('en-US');
      if (seen.has(folded)) throw new Error('File and directory artifact path conflict');
      const prior = directories.get(folded);
      if (prior !== undefined && prior !== directory) throw new Error('Directory spelling artifact path conflict');
      directories.set(folded, directory);
    }
  }
  return normalizedPaths;
}
