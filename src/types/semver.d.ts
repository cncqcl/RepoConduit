// Narrow declarations for the installed semver 7.8.5 public APIs used here.
declare module 'semver' {
  export function valid(version: string): string | null;
  export function validRange(range: string): string | null;
  export function satisfies(version: string, range: string): boolean;
}
