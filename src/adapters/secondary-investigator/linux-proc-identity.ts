export interface LinuxProcessIdentity {
  pid: number;
  parentPid: number;
  state: string;
  startTicks: number;
}

/** Parse only the identity fields of one bounded kernel stat read. No liveness authority. */
export function parseLinuxProcessStat(raw: string, expectedPid: number): LinuxProcessIdentity {
  const reject = () => { throw new Error('INVALID_PROCESS_STAT'); };
  if (!Number.isSafeInteger(expectedPid) || expectedPid <= 0 || typeof raw !== 'string' ||
    Buffer.byteLength(raw) > 4096 || !raw.endsWith('\n') || raw.includes('\0')) return reject();
  const prefix = `${expectedPid} (`;
  const close = raw.lastIndexOf(')');
  if (!raw.startsWith(prefix) || close < prefix.length || raw.slice(close, close + 2) !== ') ')
    return reject();
  const tail = raw.slice(close + 2, -1);
  if (!/^[A-Za-z] (?:-?[0-9]+ )*-?[0-9]+$/.test(tail)) return reject();
  const fields = tail.split(' ');
  const state = fields[0]!;
  if (fields.length < 20 || !'RSDTtWIP'.includes(state)) return reject();
  const parse = (value: string, positive: boolean) => {
    if (!/^(0|[1-9][0-9]*)$/.test(value)) return reject();
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < (positive ? 1 : 0)) return reject();
    return number;
  };
  return { pid: expectedPid, parentPid: parse(fields[1]!, false), state,
    startTicks: parse(fields[19]!, true) };
}
