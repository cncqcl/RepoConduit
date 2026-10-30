import { closeSync, existsSync, lstatSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type Provider from 'oidc-provider';
import { startLocalIssuer, type LocalIssuerOptions } from '../adapters/auth/issuer.js';
import { createLocalIntrospectionVerifier,
  type IssuerOperatorBinding } from '../adapters/auth/introspection-verifier.js';
import { startProductExternalHttpWithinInstallation } from './external-http.js';
import type { PersonalCodexInvestigatorConfiguration, PersonalCodexDiagnostic } from './codex-owned-investigation.js';
import { assertPrivateDataDirectory } from './local-security.js';
import { acquireInstallationRuntime, assertActiveInstallation, retainInstallationRuntime,
  type InstallationRuntime } from './installation.js';

export interface SelfHostedOAuthHttpOptions {
  issuer: Omit<LocalIssuerOptions, 'db'>;
  bindings: readonly IssuerOperatorBinding[];
  /** Explicitly reviewed HTTPS file origins; omission keeps file transfer unavailable. */
  allowedFileOrigins?: readonly string[];
  mcpPort?: number;
  /** Trusted local selection constrained to the sole fixed OAuth operator workspace. */
  codexInvestigator?: PersonalCodexInvestigatorConfiguration;
  codexManaged?:boolean;
  onCodexDiagnostic?:(diagnostic:PersonalCodexDiagnostic)=>void;
}

export interface SelfHostedOAuthHttpHandle {
  issuerUrl: string;
  mcpUrl: string;
  /** Exposed for trusted local lifecycle and revocation operations; never sent to a client. */
  provider: Provider;
  close(): Promise<void>;
}

/** Owns the local issuer, bearer verifier and product MCP listener as one process lifetime. */
export async function startSelfHostedOAuthHttp(dataDirectory: string,
  options: SelfHostedOAuthHttpOptions): Promise<SelfHostedOAuthHttpHandle> {
  const runtime = acquireInstallationRuntime(dataDirectory);
  let borrowed: SelfHostedOAuthHttpHandle;
  try { borrowed = await startSelfHostedOAuthHttpWithinInstallation(runtime, options); }
  catch (error) {
    if (error instanceof AggregateError) retainInstallationRuntime(runtime);
    else {
      try { runtime.release(); }
      catch (releaseError) {
        retainInstallationRuntime(runtime);
        throw new AggregateError([error, releaseError], 'Self-hosted HTTP startup cleanup unconfirmed',
          { cause: releaseError });
      }
    }
    throw error;
  }
  let closing: Promise<void> | undefined;
  return { issuerUrl: borrowed.issuerUrl, mcpUrl: borrowed.mcpUrl, provider: borrowed.provider,
    close: () => {
      if (closing) return closing;
      closing = (async () => {
        try { await borrowed.close(); }
        catch (error) { retainInstallationRuntime(runtime); throw error; }
        try { runtime.release(); }
        catch (error) { retainInstallationRuntime(runtime); throw error; }
      })();
      return closing;
    },
  };
}

/** Borrow the outer installation owner for issuer, verifier, product app and MCP listener. */
export async function startSelfHostedOAuthHttpWithinInstallation(runtime: InstallationRuntime,
  options: SelfHostedOAuthHttpOptions): Promise<SelfHostedOAuthHttpHandle> {
  assertActiveInstallation(runtime);
  if((options.codexManaged!==undefined&&typeof options.codexManaged!=='boolean')||
      (options.codexManaged===true&&!options.codexInvestigator))throw new Error('NOT_AVAILABLE');
  const dataDirectory = runtime.dataDirectory;
  assertPrivateDataDirectory(dataDirectory);
  if (!existsSync(join(dataDirectory, 'state.sqlite'))) throw new Error('Installation missing');
  if (!options.issuer || !Array.isArray(options.bindings) || options.bindings.length !== 1 ||
      options.bindings[0]?.issuer !== options.issuer.issuer ||
      options.bindings[0].clientId !== options.issuer.clientId ||
      options.bindings[0].subject !== options.issuer.operator.subject ||
      (options.codexInvestigator !== undefined &&
        options.bindings[0].workspaceId !== options.codexInvestigator.workspaceId) ||
      Object.keys(options.bindings[0].scopes).length !== options.issuer.scopes.length ||
      Object.keys(options.bindings[0].scopes).some(scope => !options.issuer.scopes.includes(scope))) {
    throw new Error('Issuer and operator binding mismatch');
  }
  const issuerFile = join(dataDirectory, 'issuer.sqlite');
  if (existsSync(issuerFile)) {
    if (!lstatSync(issuerFile).isFile()) throw new Error('Issuer database must be a regular file');
    assertPrivateDataDirectory(dataDirectory, issuerFile);
  } else {
    const fd = openSync(issuerFile, 'wx', 0o600);
    try { closeSync(fd); }
    catch (error) { throw new AggregateError([error], 'Issuer file close unconfirmed', { cause: error }); }
  }
  const db = new DatabaseSync(issuerFile);
  let localIssuer: Awaited<ReturnType<typeof startLocalIssuer>> | undefined;
  try {
    assertPrivateDataDirectory(dataDirectory, issuerFile);
    localIssuer = await startLocalIssuer({ ...options.issuer, db });
    const verifyBearer = await createLocalIntrospectionVerifier({
      loopbackUrl: localIssuer.url, expectedIssuer: options.issuer.issuer,
      expectedResource: options.issuer.resource, expectedClientId: options.issuer.clientId,
      bindings: options.bindings,
    });
    const http = await startProductExternalHttpWithinInstallation(runtime, {
      expectedAudience: options.issuer.resource, verifyBearer,
      resourceMetadata: { resource: options.issuer.resource,
        authorizationServer: options.issuer.issuer, scopes: options.issuer.scopes },
      ...(options.mcpPort === undefined ? {} : { port: options.mcpPort }),
      ...(options.allowedFileOrigins ? { allowedFileOrigins: options.allowedFileOrigins } : {}),
      ...(options.codexInvestigator ? { codexInvestigator: options.codexInvestigator } : {}),
      ...(options.codexManaged !== undefined ? {codexManaged:options.codexManaged} : {}),
      ...(options.codexInvestigator && options.onCodexDiagnostic ? {onCodexDiagnostic:options.onCodexDiagnostic} : {}),
    });
    const issuer = localIssuer;
    let closing: Promise<void> | undefined;
    return { issuerUrl: issuer.url, mcpUrl: http.url, provider: issuer.provider,
      close: () => {
        closing ??= (async () => {
          const failures: unknown[] = [];
          try { await http.close(); } catch (error) { failures.push(error); }
          try { await issuer.close(); } catch (error) { failures.push(error); }
          try { db.close(); } catch (error) { failures.push(error); }
          if (failures.length) throw new AggregateError(failures, 'Self-hosted HTTP shutdown failed');
        })();
        return closing;
      },
    };
  } catch (error) {
    const failures: unknown[] = [];
    try { await localIssuer?.close(); } catch (closeError) { failures.push(closeError); }
    try { db.close(); } catch (closeError) { failures.push(closeError); }
    if (failures.length) throw new AggregateError([error, ...failures],
      'Self-hosted HTTP startup cleanup unconfirmed', { cause: error });
    throw error;
  }
}
