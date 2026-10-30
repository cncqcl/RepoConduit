export interface LinuxMountEntry {
  mountId: number;
  parentId: number;
  major: number;
  minor: number;
  root: string;
  mountPoint: string;
  mountOptions: string[];
  optionalFields: string[];
  filesystemType: string;
  mountSource: string;
  superOptions: string[];
}

const MAX_BYTES = 128 * 1024;
const MAX_LINE_BYTES = 4096;
const ESCAPES: Readonly<Record<string, string>> = {
  '040': ' ', '011': '\t', '012': '\n', '134': '\\',
};

function decimal(value: string, positive: boolean): number {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) throw new TypeError('invalid mountinfo decimal');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || (positive && parsed === 0)) {
    throw new TypeError('mountinfo decimal out of range');
  }
  return parsed;
}

function decodeKernelField(value: string): string {
  let result = '';
  for (let index = 0; index < value.length; index++) {
    const character = value[index]!;
    if (character === '\\') {
      const octal = value.slice(index + 1, index + 4);
      const decoded = ESCAPES[octal];
      if (decoded === undefined) throw new TypeError('invalid mountinfo escape');
      result += decoded;
      index += 3;
    } else {
      if (character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) {
        throw new TypeError('literal mountinfo control character');
      }
      result += character;
    }
  }
  if (!result || result.includes('\0')) throw new TypeError('empty mountinfo field');
  return result;
}

function opaqueField(value: string): string {
  if (!value || [...value].some(character => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  })) throw new TypeError('invalid mountinfo opaque field');
  return value;
}

function commaOptions(value: string): string[] {
  const options = value.split(',').map(opaqueField);
  if (new Set(options).size !== options.length) throw new TypeError('duplicate mountinfo option');
  return options;
}

export function parseLinuxMountinfo(raw: string): readonly LinuxMountEntry[] {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_BYTES ||
      Buffer.byteLength(raw, 'utf8') > MAX_BYTES ||
      Buffer.from(raw, 'utf8').toString('utf8') !== raw ||
      !raw.endsWith('\n') || raw.includes('\r') || raw.includes('\0')) {
    throw new TypeError('invalid mountinfo input');
  }
  const lines = raw.split('\n');
  lines.pop();
  if (lines.length < 1 || lines.length > 128) throw new TypeError('invalid mountinfo line count');
  const seenIds = new Set<number>();
  return lines.map(line => {
    if (!line || Buffer.byteLength(line, 'utf8') + 1 > MAX_LINE_BYTES) {
      throw new TypeError('invalid mountinfo line length');
    }
    const halves = line.split(' - ');
    if (halves.length !== 2) throw new TypeError('invalid mountinfo separator');
    const pre = halves[0]!.split(' ');
    const post = halves[1]!.split(' ');
    if (pre.length < 6 || post.length !== 3 ||
        pre.some(field => !field) || post.some(field => !field)) {
      throw new TypeError('invalid mountinfo fields');
    }
    const mountId = decimal(pre[0]!, true);
    if (seenIds.has(mountId)) throw new TypeError('duplicate mountinfo mount ID');
    seenIds.add(mountId);
    const parentId = decimal(pre[1]!, false);
    const device = /^(0|[1-9][0-9]*):(0|[1-9][0-9]*)$/.exec(pre[2]!);
    if (!device) throw new TypeError('invalid mountinfo device');
    const major = decimal(device[1]!, false);
    const minor = decimal(device[2]!, false);
    const root = decodeKernelField(pre[3]!);
    const mountPoint = decodeKernelField(pre[4]!);
    if (!root.startsWith('/') || !mountPoint.startsWith('/')) {
      throw new TypeError('mountinfo paths must be absolute');
    }
    const mountOptions = commaOptions(pre[5]!);
    const optionalFields = pre.slice(6).map(opaqueField);
    if (new Set(optionalFields).size !== optionalFields.length) {
      throw new TypeError('duplicate mountinfo optional field');
    }
    return {
      mountId, parentId, major, minor, root, mountPoint, mountOptions, optionalFields,
      filesystemType: opaqueField(post[0]!),
      mountSource: decodeKernelField(post[1]!),
      superOptions: commaOptions(post[2]!),
    };
  });
}
