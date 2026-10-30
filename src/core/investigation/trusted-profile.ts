export interface StaticReadonlyBudget {
  maxWallSeconds: number;
  maxTurns: number;
  maxToolCalls: number;
}

export interface ProfileConfiguration {
  workspaceId: string;
  expectedRevisionId: string | null;
  presetRef: 'static_readonly_v1';
  budget: StaticReadonlyBudget;
}

export interface ProfileRevision {
  id: string;
  workspaceId: string;
  previousRevisionId: string | null;
  presetRef: 'static_readonly_v1';
  budget: StaticReadonlyBudget;
  configuredBy: string;
  configuredAt: string;
  runtimeAvailability: 'unavailable';
  reason: 'runtime_not_configured_or_verified';
}

function plain(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value==='object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value)===Object.prototype || Object.getPrototypeOf(value)===null);
}

export function parseProfileConfiguration(value: unknown): ProfileConfiguration {
  if (!plain(value) || Reflect.ownKeys(value).some(key=>
    typeof key!=='string' || !['workspaceId','expectedRevisionId','presetRef','budget'].includes(key)) ||
      !Object.hasOwn(value,'expectedRevisionId')) throw new Error('INVALID_ARGUMENT');
  const workspaceId=value.workspaceId;
  const expectedRevisionId=value.expectedRevisionId;
  const presetRef=value.presetRef;
  const budget=value.budget;
  if (typeof workspaceId!=='string' || !workspaceId.trim() || workspaceId.length>128 ||
      (expectedRevisionId!==null && (typeof expectedRevisionId!=='string' ||
        !expectedRevisionId.trim() || expectedRevisionId.length>128)) ||
      presetRef!=='static_readonly_v1' || !plain(budget) ||
      Reflect.ownKeys(budget).length!==3 ||
      Reflect.ownKeys(budget).some(key=>typeof key!=='string' ||
        !['maxWallSeconds','maxTurns','maxToolCalls'].includes(key))) throw new Error('INVALID_ARGUMENT');
  const maxWallSeconds=budget.maxWallSeconds;
  const maxTurns=budget.maxTurns;
  const maxToolCalls=budget.maxToolCalls;
  for (const [amount,ceiling] of [[maxWallSeconds,600],[maxTurns,8],[maxToolCalls,40]] as
    [unknown,number][]) {
    if (typeof amount!=='number' || !Number.isSafeInteger(amount) || amount<1 || amount>ceiling)
      throw new Error('INVALID_ARGUMENT');
  }
  return {workspaceId,expectedRevisionId,presetRef,
    budget:{maxWallSeconds:maxWallSeconds as number,maxTurns:maxTurns as number,
      maxToolCalls:maxToolCalls as number}};
}
