import { startExternalHttp, type ExternalHttpHandle, type ExternalHttpOptions } from '../adapters/mcp/http.js';
import { createPlatformFileDownloadResolver } from '../adapters/mcp/platform-file-download.js';
import { openApplicationWithinInstallation } from './application.js';
import type { PersonalCodexInvestigatorConfiguration, PersonalCodexDiagnostic } from './codex-owned-investigation.js';
import { acquireInstallationRuntime, assertActiveInstallation, retainInstallationRuntime,
  type InstallationRuntime } from './installation.js';

/** Trusted host composition; it neither issues OAuth tokens nor grants product permissions. */
export interface ProductHttpOptions extends Omit<ExternalHttpOptions, 'dispatcher' | 'resolveFileTransfer'> {
  /** Explicitly reviewed HTTPS file origins. Omission leaves the file tool undiscoverable. */
  allowedFileOrigins?: readonly string[];
  /** Trusted local selection; never derived from an external request or bearer token. */
  codexInvestigator?: PersonalCodexInvestigatorConfiguration;
  codexManaged?:boolean;
  onCodexDiagnostic?:(diagnostic:PersonalCodexDiagnostic)=>void;
}

export async function startProductExternalHttp(dataDirectory: string,
  options: ProductHttpOptions): Promise<ExternalHttpHandle> {
  const runtime = acquireInstallationRuntime(dataDirectory);
  let borrowed: ExternalHttpHandle;
  try { borrowed = await startProductExternalHttpWithinInstallation(runtime, options); }
  catch (error) {
    if (error instanceof AggregateError) retainInstallationRuntime(runtime);
    else {
      try { runtime.release(); }
      catch (releaseError) {
        retainInstallationRuntime(runtime);
        throw new AggregateError([error, releaseError], 'Product HTTP startup cleanup unconfirmed',
          { cause: releaseError });
      }
    }
    throw error;
  }
  let closing: Promise<void> | undefined;
  return { url: borrowed.url, close: () => {
    if (closing) return closing;
    closing = (async () => {
      try { await borrowed.close(); }
      catch (error) { retainInstallationRuntime(runtime); throw error; }
      try { runtime.release(); }
      catch (error) { retainInstallationRuntime(runtime); throw error; }
    })();
    return closing;
  } };
}

/** Borrow the outer installation owner; this handle never releases its maintenance gate. */
export async function startProductExternalHttpWithinInstallation(runtime: InstallationRuntime,
  options: ProductHttpOptions): Promise<ExternalHttpHandle> {
  assertActiveInstallation(runtime);
  const application = openApplicationWithinInstallation(runtime, {
    ...(options.codexInvestigator ? {codexInvestigator:options.codexInvestigator}:{}),
    ...(options.codexManaged !== undefined ? {codexManaged:options.codexManaged}:{}),
    ...(options.codexInvestigator && options.onCodexDiagnostic ?
      {onCodexDiagnostic:options.onCodexDiagnostic}:{})});
  try {
    await application.ready;
    const resolveFileTransfer = options.allowedFileOrigins?.length ?
      createPlatformFileDownloadResolver({ allowedOrigins: options.allowedFileOrigins }) : undefined;
    const http = await startExternalHttp({
      dispatcher: application.dispatch, expectedAudience: options.expectedAudience,
      verifyBearer: options.verifyBearer,
      ...(options.resourceMetadata ? { resourceMetadata: options.resourceMetadata } : {}),
      ...(options.port === undefined ? {} : { port: options.port }),
      ...(resolveFileTransfer ? { resolveFileTransfer } : {}),
    });
    let closing: Promise<void> | undefined;
    return { url: http.url, close: () => {
      closing ??= (async () => {
        const failures: unknown[] = [];
        let applicationClose:Promise<void>|void=undefined;
        try { applicationClose=application.close(); } catch (error) { failures.push(error); }
        let transportClose:Promise<void>|void=undefined;
        try { transportClose=http.close(); } catch (error) { failures.push(error); }
        const finished=await Promise.allSettled([applicationClose,transportClose]);
        failures.push(...finished.filter((result):result is PromiseRejectedResult=>result.status==='rejected')
          .map(result=>result.reason as unknown));
        if (failures.length) throw new AggregateError(failures, 'Product HTTP shutdown failed');
      })();
      return closing;
    } };
  } catch (error) {
    try { await application.close(); }
    catch (closeError) { throw new AggregateError([error, closeError], 'Product HTTP startup cleanup unconfirmed',
      { cause: closeError }); }
    throw error;
  }
}
