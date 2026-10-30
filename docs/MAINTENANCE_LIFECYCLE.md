# Managed installation maintenance lifecycle

Historical installation and maintenance component results are scoped to the source, package, and environment recorded in each execution. They do not establish a current unified release; see [evidence status](release-evidence.md).
Use the [daily guide](user-guide/index.html) for ordinary setup; retain the managed
maintenance contracts below for actual managed backup/restore/upgrade operations.

Status: **managed backup/restore, installed rich history, and the fixed-version upgrade route verified in scoped checks; final release acceptance pending**. This document
defines the minimal path from a maintenance lock primitive to actual consistent
backup, restore and upgrade. The local backup/restore API has scoped real
copy, corruption, process-interruption and rich-data evidence plus independent
review. The installed CLI basic backup/restore route has separate actual smoke
evidence. Installed rich history reads and the supported 0.1.0 to 0.1.1 upgrade
have separate real package and interruption evidence. Broader final-build
acceptance remains pending; arbitrary schema upgrades are not qualified.
The shared/exclusive gate and application request drain have separate focused
evidence; passing them does not pass T06.2, AC12, AC14 or release readiness.

The governing requirements are DESIGN sections 5.3, 5.5 and 12,
ARCHITECTURE_AND_CONTRACTS sections 2 and 10, and IMPLEMENTATION_PLAN T06.2.

## 1. Supported installation scope

The initial lifecycle applies only to a newly created managed installation:

```text
<installation>/
  managed.json
  lifecycle.sqlite
  generations/<generation-id>/data/
  generations/<generation-id>/package/  # subsequent installed upgrade candidate
```

Completed backups for the current slice use explicit fresh private roots outside
the installation and registered source roots: `<backup>/backup.json` plus
`<backup>/data/`. Installation-descendant destinations are refused.

The public installation root has no `state.sqlite`. A legacy CLI given that root
cannot open its data; legacy `init` must continue refusing an existing directory.
Managed commands resolve the active generation only after acquiring the gate and
validating the private manifest, format and compatible package identity.

Existing flat installations are not silently adopted. Lifecycle commands reject
them without adding a gate or relocating data. Safe initial migration of an
existing installation requires its own verified offline procedure and remains
outside this first slice. Directly pointing an old executable at an internal
generation, or arbitrary disk writes by the same OS user, is outside the managed
entry-point guarantee. The gate is product process coordination, not an OS
sandbox against a same-user adversary.

The explicit `init-managed` route creates a new installation root and initial
generation data using the current installed CLI's package version. The initial
generation has no copied `package` directory; that directory belongs to actual
candidate upgrade installation. An empty directory cannot prove deployment.
Initialization refuses any existing root, including partial output, and starts
no recovery, listener or model. Failure preserves the created tree for inspection.
Once manifest publication begins, any failure retains the exclusive gate for
the current process lifetime. This does not provide a disk recovery protocol:
after process termination, an intact valid manifest may already be present and
must be inspected rather than assuming initialization never published. Never
delete the root or rerun initialization to manufacture success.

Current executables reject any supplied installation root beneath a managed
marker, checking both lexical and native canonical strict ancestors. Internal
generation data, inactive generations and junction aliases cannot be admitted
as independent flat installations. A malformed single marker also rejects; the
resolver never redirects automatically. This guard is independently reviewed
and covered by real filesystem regressions in D175. The old-executable exclusion
above does not exempt current executables from this check.

No operation changes global npm configuration, host MCP configuration, public
network exposure, accounts or credentials. Source repositories, AGENTS.md and
.codex configuration are outside installation mutation paths.

## 2. Maintenance gate primitive

The initial module is `src/runtime/maintenance-gate.ts` with three operations:

```ts
initializeMaintenanceGate(root: string): void;
acquireRuntimeMaintenanceGate(root: string): { release(): void };
acquireExclusiveMaintenanceGate(root: string): { release(): void };
```

The final names and return types may be adjusted mechanically during integration;
their behavioral contract is fixed below. The primitive does not resolve a data
generation, start application recovery, inspect business state or copy files.

### Initialization

- Only the fresh managed-install creation path may call initialization. It accepts
  a validated existing private directory and creates one previously absent fixed
  gate file. It does not initialize arbitrary legacy installation directories.
- Gate creation is exclusive. A preexisting file, directory, link or interrupted
  initialization is a conflict; do not delete, replace or repair it automatically.
- The gate uses SQLite **DELETE journal mode**, a fixed versioned schema and a
  fixed control row. Initialization closes its connection before normal use.
- No application state, credentials, process IDs or lease timestamps are needed
  in this database. Its file identity is retained across generation changes.

### Normal runtime acquisition

- Validate the directory and fixed gate file before use. Reject missing files,
  symbolic links/reparse points, hardlinks, unexpected schema/version/rows and
  unsupported journal mode. Do not run migration or switch WAL to DELETE.
- Open read-only with no implicit creation. Execute `BEGIN` followed by a real
  read of the fixed control row, acquiring SQLite's SHARED lock. A deferred BEGIN
  alone is insufficient.
- Keep that transaction and connection alive for the entire protected operation
  or service lifetime. Multiple normal runtime holders may coexist.
- Release rolls back the read transaction and closes the connection. Release is
  idempotent. A failed acquisition closes any connection it created.

### Maintenance acquisition

- Perform the same private-file, schema and journal-mode checks without repair.
- Acquire `BEGIN EXCLUSIVE` using zero busy timeout. A conflict returns a closed
  busy result/error; there is no polling loop, lock stealing or implicit drain.
- Hold the transaction for the complete maintenance operation. It excludes all
  participating runtime holders and other maintenance holders. It does not prove
  that an external model or provider-side action has terminated.
- Release rolls back and closes. SQLite releases actual file locks when a holder
  process exits; no PID check or timestamp expiry authorizes recovery.
- Never remove or replace the gate to resolve contention. WAL mode is rejected
  because it does not provide the required reader/exclusive-writer exclusion.

Process interruption may leave SQLite recovery files. An acquisition must either
use SQLite's supported recovery under the same safety checks or return a closed
recovery-required result; it must not unlink journals based on age or appearance.

## 3. Private-directory policy reuse

The existing `assertPrivateDataDirectory` currently requires `state.sqlite` on
both Windows and POSIX. It cannot directly validate a managed root, which
intentionally has no such file. Do not create a dummy state database to satisfy
that dependency, and do not replace the Windows policy with a mode-bit check.

Extract or parameterize the **internal** common check for a private directory and
an explicit set of files. Preserve the existing wrapper's mandatory state.sqlite
behavior for all current data-directory callers. A narrow
`assertPrivateInstallationDirectory(root, file?)` wrapper
uses that same owner, Windows protected-DACL and ancestor replacement policy for
the managed root and lifecycle.sqlite. Initialization checks the directory before
creation and the completed gate afterwards. Acquisition always checks the gate.

File type, single-link and path/reparse checks are required in addition to ACL
checks. This change must not introduce a caller-controlled public option that
disables data-directory policy. No automatic permission repair occurs on an
existing installation. Public errors remain closed and contain no SID, secret,
raw subprocess output or private path obtained from an exception.

## 4. Required writer coverage before backup

The primitive is not sufficient until all managed product paths participate:

| Entry / owner | Required protected interval |
| --- | --- |
| `openApplication` | Before any store constructor, artifact directory creation or recovery start; through dispatch drain, recovery shutdown and closing every store |
| `configure-mcp` | Before authorization/data reads through completing configuration writes |
| `configure-oauth`, `configure-file-origins` | Before configuration/store reads through all database and file updates |
| MCP stdio | Includes the separate grant store, transport lifetime and all in-flight requests |
| OAuth HTTP service | Includes issuer database, listeners, application state and all in-flight requests |
| CLI request and local collection | Entire application operation, including both filesystem and database completion |
| Managed init, restore, upgrade | Dedicated creation/maintenance route; never ordinary application recovery |

Gate ownership must be explicit so a composition root acquires once and releases
only after its dependent components close. Shutdown first rejects new requests,
then waits for in-flight work, stops recovery and closes stores. Merely closing a
listener or a DB connection is not a drain proof. Child helpers that can continue
installation writes must finish or retain protection before the owning runtime
releases its gate. Ongoing native investigations are additionally handled by the
persistent-state preflight below.

Tests that instantiate stores directly do not establish product entry coverage.
The independent review must trace every installed write entry and startup failure
path. Until that coverage is complete, the gate must not authorize a backup.

## 5. Actual backup and restore path

`src/runtime/installation-backup.ts` implements the local data API after gate integration. Backup holds the
maintenance transaction throughout all steps:

1. Resolve and validate the active generation and exact installation-owned paths.
2. Check unresolved conversation sends, investigation active attempts/outbox and
   unknown native activity. Block without changing records, expiring leases,
   cancelling models, releasing slots or treating unknown as complete.
3. Validate staging and database state. Published staging markers are persistent
   records and do not by themselves mean active transfer. An unexplained DB/FS
   conflict blocks; do not invoke repair as a hidden part of backup.
4. Create a private pending backup in an explicit destination. Generate consistent
   state.sqlite and optional issuer.sqlite copies using the installed Node
   SQLite backup API after verifying that actual API/version. Preserve the other
   installation data, including configuration, objects, staging and persistent
   ordinary lock files, as one dataset. Exclude only documented regenerable SQLite
   sidecars corresponding to successfully backed-up databases.
5. Enforce bounded enumeration/bytes and reject links or special files. Keep
   credentials in private backup files; never print them or ordinary file bodies.
6. Validate copied database integrity/foreign keys and published bundle/decision
   references against copied object hashes. Preserve lifecycle facts and grants.
7. Publish a versioned completion manifest only after all validation and required
   durability steps succeed. A pending directory is never a completed backup.

The shared gate prevents cooperating writers from changing config, DB or files
during these steps. A main-database transaction, absent WAL, stable mtime or PID
enumeration cannot replace it. In-flight provider or model activity is not covered
by a local file lock; persistent unknown/active state therefore blocks maintenance.

Restore initially supports the same machine and a new, nonexistent managed
destination. Validate a completed backup, create a private pending installation,
copy and verify it, then publish its managed entry. Preserve existing grants,
bindings and native identities. Do not insert a new administrator or start
listeners/recovery automatically. Refuse merging into or overwriting an existing
target. Keep the source backup and report interrupted pending output explicitly.

## 6. Actual upgrade continuation

The implemented coordinator in `src/runtime/installation-upgrade.ts` reuses the
same gate and completed backup. The supported pair is installation format 1,
package 0.1.0 to 0.1.1:

1. Under maintenance exclusion, create and validate the backup.
2. Install a locally packed candidate into a dedicated new generation prefix,
   using offline package installation with no global side effects.
3. Migrate the copied dataset through a candidate entry that opens only the
   required stores and never starts dispatch, recovery, listeners or model work.
4. Verify data preservation, object references, permissions and candidate schema.
5. Publish the candidate completion state, then atomically switch the private
   active-generation manifest. Preserve the prior generation and backup.

The active manifest is the generation-selection authority after a crash. A
candidate not published by that manifest cannot serve requests. Resume must not
replay external sends or guess that migration/activation succeeded. The installed
entry must re-read and validate package/generation selection after acquiring its
runtime gate, preventing a waiter from using stale pre-maintenance selection.
Failure before activation preserves the original active generation. Upgrade is
not complete until the actual installed candidate path and crash cases pass.

## 7. Implementation ownership and acceptance

First slice ownership:

- Implementer: `src/runtime/maintenance-gate.ts`, focused gate integration tests;
  any local-security extraction must have separately assigned ownership.
- Main agent: CLI/application/HTTP/stdio integration and shutdown ownership.
- Subsequent backup implementer: installation-backup module and restore tests
  after the gate interface is frozen.
- Main agent: final packaging, operations instructions and evidence integration.

Required primitive tests use real subprocesses and the actual SQLite engine:

- Two runtime holders coexist; maintenance is refused while either holds a read.
- A maintenance holder excludes a new runtime and another maintenance process.
- Releasing holders permits the opposite mode. Killing an owned synthetic holder
  releases its lock without changing/recreating gate identity.
- Acquisition failure and duplicate release do not leak a lock or connection.
- Missing, malformed, linked, hardlinked, WAL and unknown-version gates fail
  without repair. Unsafe ACLs/ancestors fail under the existing security policy.
- Managed-root validation works without state.sqlite while the old data-root
  validator still requires it. A legacy flat root cannot be silently initialized.

Subsequent acceptance must exercise the packed CLI: fresh managed init, concurrent
writer exclusion, actual backup, restore to another new directory, and reading
the same bundle versions and decisions. Include binary/multifile objects,
interrupted staging, unknown sends, active investigations, copy failure and crash
before publication. Any blocked case must preserve original records and bytes.

Finally, use two actual different package versions for upgrade acceptance,
including failed migration and crash around generation activation. Same-version
reinstallation, lock unit tests, or a dry-run report do not satisfy this gate.

## 8. Evidence status

This design is based on source inspection of `runtime/application.ts`,
`runtime/local-security.ts`, `cli/main.ts`, `cli/oauth.ts`, storage objects and
the session/investigation/main SQLite stores. Primitive process exclusion is
verified in `MAINTENANCE_GATE_2026-10-01.md`（私有历史记录，见[验证状态](release-evidence.md)）; admitted
application request drain is verified in
`APPLICATION_DRAIN_2026-10-01.md`（私有历史记录，见[验证状态](release-evidence.md)）. HTTP callback drain is
verified in `HTTP_HANDLER_DRAIN_2026-10-02.md`（私有历史记录，见[验证状态](release-evidence.md)）; strict managed
manifest resolution and application ownership in
`MANAGED_APPLICATION_2026-10-02.md`（私有历史记录，见[验证状态](release-evidence.md)）. Public runtime HTTP
composition ownership is verified in
`MANAGED_HTTP_OWNERSHIP_2026-10-02.md`（私有历史记录，见[验证状态](release-evidence.md)）. Fresh managed creation
and its installed CLI smoke are scoped verified in
`MANAGED_INIT_2026-10-02.md`（私有历史记录，见[验证状态](release-evidence.md)）. Full remaining configuration/service
integration is pending; D174 observations are recorded separately. Local backup/
restore data evidence is in `INSTALLATION_BACKUP_RESTORE_2026-10-02.md`（私有历史记录，见[验证状态](release-evidence.md)）;
installed basic CLI backup/restore evidence is in
`INSTALLED_BACKUP_RESTORE_2026-10-02.md`（私有历史记录，见[验证状态](release-evidence.md)）. Rich bundle versions
and Decision reads are in `INSTALLED_RICH_RESTORE_2026-10-03.md`（私有历史记录，见[验证状态](release-evidence.md)）.
Actual different-version upgrade preservation is in
`INSTALLED_UPGRADE_2026-10-02.md`（私有历史记录，见[验证状态](release-evidence.md)）; four coordinator crash
points and two copy interruption phases are covered separately by
`UPGRADE_COORDINATOR_CRASH_2026-10-02.md`（私有历史记录，见[验证状态](release-evidence.md)） and
`UPGRADE_COPY_INTERRUPTION_2026-10-02.md`（私有历史记录，见[验证状态](release-evidence.md)）.
These scoped receipts do not qualify arbitrary schema migration, active worker
descendant termination, full power loss, or final-build release acceptance.
