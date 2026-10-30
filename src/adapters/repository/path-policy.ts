const device = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i;
const secret = /^(?:\.git|\.agent-collab|\.env(?:\..*)?|id_(?:rsa|ed25519)|.*\.(?:pem|key|p12|pfx))$/i;

/** Conservative portable path policy. Authority still belongs to application handlers. */
export function validateRelativePath(input: string): string {
  if (typeof input !== 'string' || !input || input.includes('\0') || input.includes('\\') || input.startsWith('/') || /^[a-zA-Z]:/.test(input)) {
    throw new Error('INVALID_ARGUMENT');
  }
  const parts = input.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || part !== part.normalize('NFC') || /[. ]$/.test(part) || [...part].some(char => char.charCodeAt(0) < 32) || /[<>:"|?*]/.test(part) || device.test(part) || secret.test(part))) {
    throw new Error('INVALID_ARGUMENT');
  }
  return input;
}

export function portablePathKey(path: string): string {
  return validateRelativePath(path).normalize('NFC').toLocaleLowerCase('en-US');
}
