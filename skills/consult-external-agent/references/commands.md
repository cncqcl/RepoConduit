# Existing RepoConduit commands

Use the selected installed CLI: `rcac --data-dir ABSOLUTE_DATA_DIRECTORY request` accepts one command JSON on stdin. Write JSON to a file or a child process's stdin; do not interpolate it into a shell command. Use `doctor` for local installation facts. Consult the installed catalog/docs when a shape differs; examples below describe the current v0.2 handlers, not a substitute for their validation.

The command envelope is `{operation, scope: {workspaceId, collaborationId}, payload, idempotencyKey}`. Writes require a stable key. Reuse the key only for the exact same operation/input. Read queries do not require a key. Authority comes from the CLI/transport identity and current grants, not payload fields.

## Daily file-source setup

For builds advertising these commands, `setup --file-source chatgpt` selects the
fixed official file-source preset only when creating a binding. An existing binding
requires an explicitly authorized local `enable-chatgpt-files`; it retains the exact
origin list and identity and reports restart/save status. Ordinary setup does not
migrate it. `check-file-network --file-origin APPROVED_HTTPS_ORIGIN` only reads the
private flat-install binding and system DNS; it neither opens SQLite nor changes
network configuration. It refuses managed roots. Treat its result as DNS evidence,
not a successful file download. All commands accept the selected `--data-dir`.

<a id="daily-investigation-candidate"></a>

## Daily investigation

The 2026-10-27 record covers webpage initial and two parent-linked followup
investigations on the earlier installed 0094092/7f4f74a9 package. The separate
fixed a38 package has offline suite and isolated same-package daily-flow evidence;
it was not globally upgraded and has no claimed unified live acceptance. The source repository records these separately in `verification/receipts/` as
`D240_AUTONOMOUS_VALIDATION_2026-10-27.md` and `D240_A38_OFFLINE_2026-10-29.md`.
Check the selected installed CLI and App capabilities before use; a source edit
is not a reason to restart a connection or modify its private binding.

The person can ask local Codex to reuse an existing authorized Codex investigation
source and enable read-only investigation for a named project, while retaining
its budget. The host resolves the selected installation/source/project from
actual local records. Ask for a location only when it is genuinely missing; never
ask the person to transcribe IDs or prepare JSON. An unavailable source remains
unavailable; do not silently prepare another runtime, copy credentials or log in.

On a build advertising these commands, all use the selected `--data-dir`:

| Local command | Host-supplied selection and effect |
| --- | --- |
| `use-codex --source-data-dir SOURCE_DATA --source-project SOURCE_PROJECT` | Select once an existing verified source by its registered directory or unique name. Saves a fixed source revision; preserves recipient/file policies. Honor returned save/restart status. Configure before the first connection where possible; changing an existing source is refused. |
| `enable-investigation --project PROJECT` | Select the registered absolute root or exact unique project name; the absolute root is recommended for clear targeting. Reuse the current profile budget; a first target profile defaults to 120 seconds, 3 turns and 12 tool calls. Adds separate local/external investigation grants, preserving the daily share and file paths. |
| `disable-investigation --project PROJECT` | Select the registered absolute root or exact unique project name and remove the dedicated investigation rights. Conflicting other rights or concurrent changes cause an error; retain partial steps and inspect the actual state. It does not assert that a running worker has stopped. |

Only an explicit budget change adds `--max-wall-seconds`, `--max-turns` or
`--max-tool-calls`; do not replace a current budget with defaults. New topics in an
enabled project reuse its profile and connection, without another runtime setup.
Later project enablement is discovered by the same configured service. Selecting
a source and enabling rights are local configuration, not evidence that a model
ran, permission to submit an unrequested investigation, or an automatic retry.
Enabling a service can process existing queued work; inspect the queue and its
identity before enabling it, rather than assuming configuration cannot start work.

With the four investigation tools actually advertised, select the topic through
`projects`/`topics`/`open_topic`. Submit `investigate` with `topic`, a human-readable
`requestName`, `question`, `scope: {paths, symbols, relatedTests}` and
`requestedOutputs` selected from `flow`, `evidence`, `gaps`. A followup additionally
uses `parentInvestigation` from the previous result. The host supplies the exact
frozen baseline and trusted runtime; do not add snapshot, identity, runtime or
budget fields. A changed question is a new intentional request name; reconciling
the same intent uses its original name and exact input, and an unknown execution
is not permission to create a replacement.

`investigation_status`, `investigation_result` and `cancel_investigation` take
`{topic, investigation}` with the handle from the original result. Reuse the
correct topic; never infer a handle from a thread URL or reuse another topic's
parent. Null results are pending/unavailable findings, not a completed investigation.
Cancellation is complete only when durable state confirms it. Source/profile
changes or withdrawn data rights fail closed; do not switch accounts, expand
grants or relaunch failed/unknown work to get a result.

## Client file parameters

Distinguish the callable client schema from the MCP server schema. The server's
`openai/fileParams` field receives file objects with required `download_url` and
`file_id`, plus optional `mime_type` and `file_name`, as documented in the
[official file-input contract](https://developers.openai.com/plugins/reference#define-file-inputs).
This does not require the model to construct those objects: the tested client
exposes `files: string[]`, and the host converts actual local original-file paths.
Other clients must use their own advertised schema and platform-supplied references.
Do not change the service schema to path strings or let an external caller read
arbitrary files on the RepoConduit computer.

For a client advertising the tested path-array form, the argument shape is:

```javascript
// Values come from authorized topic discovery and the client's actual file tools.
deliver_files({ topic: selectedTopic.topicHandle, version: newVersionName,
  files: [actualOriginalPath] });
```

`actualOriginalPath` must be a real original in that client's execution environment,
not an invented `/mnt/data` path, a file ID, a URL, or a path copied from another
computer. Do not generate/rewrite originals or manually decode a resource blob to
pretend that the client natively consumed it. Use platform filenames as observed;
there is no extra top-level `path` argument. The server rejects missing target
names, so optional platform metadata is not permission to invent a filename.
Use `parentVersion` only when explicitly making a child of an existing version;
keep previous files and versions intact.

After success, verify the published local bundle, project/topic/context/snapshot,
`platform_file_reference` provenance, and actual bytes/size/hash. A model's success
text alone is insufficient. Failure, missing paths or conversion, uncertain sends,
and deadlines stop the current bounded attempt; do not expand sources or resend.
An authorized manual import uses a new recovery version and remains `manual_import`.

## Host-assisted original attachment

Use this existing local-export/browser-upload composition when the owner authorizes
the local host to send a frozen original and the current client cannot turn its MCP
embedded resource into a usable file. It needs no new MCP permission, provider URL,
server or per-project connection. Keep the failed resource route separate.

1. Resolve the selected installation, registered project root, topic, frozen
   snapshot and relative file from actual product records. Reuse the current
   disclosure scope and selected browser/account; do not infer them from the cwd or
   an unrelated tab. Check the installed CLI's supported arguments.
2. Run its existing local command once, with an argument array or safely quoted
   arguments: `rcac source-export --data-dir DATA --project ROOT --topic TITLE
   --file RELATIVE_PATH`. The command checks `artifact.export` and source-read
   authority, reconstructs bytes programmatically from its own frozen source, and
   writes a private export with a completion manifest last. Do not substitute a
   working-tree file, a prior download or model-authored bytes.
3. Read the returned directory's completed `manifest.json`. Check project/topic/
   snapshot, exact selected file set, regular non-link files inside that export,
   actual size and SHA-256 against the manifest and frozen source receipt. A missing
   manifest, partial result, error or timeout stops preparation; preserve the export.
   Keep `route=authorized_local_original_export` and `manualAttachmentRequired=true`:
   they describe a local export still requiring an attachment step, not an upload
   receipt. Record subsequent host upload separately; do not relabel this as native
   consumption of an MCP resource.
4. **Export-only scope ends here.** Only when the owner's current scope includes
   that file's upload to the selected ChatGPT destination may the host use the
   documented native attachment/file-chooser API with the actual exported path.
   Upload only the selected file set. A model request needs its own already-granted
   scope; upload permission alone does not permit Send. Do not bypass login/consent
   or use cookies/private endpoints to transfer the file.
5. After an authorized upload, observe completion, actual attachment names/count,
   the exact draft and selected App before the one permitted Send. Duplicate names
   may be renamed by the platform; use observed metadata rather than inventing a
   target `path`. Reconcile an uncertain upload or Send from the existing page;
   do not duplicate it, switch destinations, reconstruct files or expand the budget.
   If a conversation bridge controls this chat, honor its released send/handoff
   state. Ordinary daily file delivery still does not require full chat mirroring.
6. For an authorized return, use the client's advertised `files` argument and a new
   version, with `parentVersion` only when requested. Read the persistent bundle and
   compare original scope/baseline, parent, provenance and actual bytes/hash; preserve
   old versions. The outbound evidence is the local export plus observed host upload,
   and inbound `platform_file_reference` remains its own provenance. Neither is a
   claim that the earlier embedded-resource route worked.

An export-only check must not open a chooser, upload an attachment, send a message,
or silently enable a model. If browser upload capability is absent, report that
specific host limitation; do not ask the user to provide URLs or internal IDs.

## Conversation bridge

`rcac --data-dir ABSOLUTE_DATA_DIRECTORY host-conversation [ABSOLUTE_DOWNLOAD_ROOT]` is a persistent JSONL process. Send:

```json
{"type":"command","requestId":"bridge-request","command":{"operation":"conversation.sync","scope":{"workspaceId":"WORKSPACE_ID","collaborationId":"COLLABORATION_ID"},"payload":{"bindingId":"BINDING_FROM_RECEIPT","expectedEpoch":0},"idempotencyKey":"sync-request"}}
```

Replace all example values from actual product receipts, including the epoch. Keep the live process/session handle. Its `action` contains `actionId`, `kind`, and the exact target. Respond with `{type: "action_result", actionId, raw}` only after performing that supported action. Read the matching `result` or error; EOF/timeout drains the product and may leave reconciliation required.

| Phase | Operation | Payload |
| --- | --- | --- |
| Bind selected chat | `conversation.bind` | `{}` |
| Send one authorized question | `conversation.send` | `{bindingId, expectedEpoch, text}` |
| Observe/import new messages | `conversation.sync` | `{bindingId, expectedEpoch}` |
| Give control to the person | `conversation.handoff` | `{bindingId, expectedEpoch}` |
| Restore host control after observation | `conversation.resume` | `{bindingId, expectedEpoch}` |

`observe` raw contains `{account, ui, host}`: normal Account UI, current rendered chat projection, and the complete official native history object. The optional `bodyCopies` shape in `docs/host-conversation.md` adds an explicitly bound native-message Copy source for rich Markdown/plugin mentions and exact same-message content references. It never replaces the raw host object. Clear the browser clipboard with the documented non-sensitive marker before reading a Copy result; do not read or retain the person's old clipboard. Use the selected installed adapter's actual supported version; do not manufacture complete/historyChanged flags or pass an API placeholder as a reply body. Bind/send/sync/resume need these real sources.

If the page shows a reply but the host cannot provide its complete native body, leave the original request untouched: do not click Regenerate or resend it. Ask the person to copy/save the original reply and provide it locally, then review it as a manual import. This does not settle an unknown send or prove conversation synchronization. Preserve the supplied origin in the host's collection record.

Send `prepare` returns the same sources with the exact composer draft and no submit. Send `commit` returns `{toolResult}` from the single released submit. The product still requires actual native message reconciliation to settle it. Handoff changes local control, but personal discussion must be performed by the person.

## Data and investigation

Use existing `collab.get`, `context.read`, and granted `repo.*` operations with explicit scope. Every page retains its snapshot, hash, completeness and continuation; filtered or missing pages do not prove a whole-repository negative.

`investigate.submit` uses `{workingCopyId, input: {snapshotRef, contextRevisionId, question, scope: {paths, symbols, relatedTests}, requestedOutputs, parentInvestigationId}}`. The initial parent is null; a followup names the returned prior request. The locally selected profile supplies the budget and native runtime. Query/cancel with `investigate.get/result/cancel` and `{workingCopyId, requestId}`; cancellation needs a key and confirmed closure or remains recovery required. Never add executable, model, root, or authority fields.

## Bundle and local decision

| Operation | Payload |
| --- | --- |
| `artifact.begin` | `{bundleId, contextRevision, snapshotRefs, expectedPaths, parentBundleId?}` |
| `artifact.collect_browser` | `{bundleId, path, nativeSessionId, nativeMessageId, filename, expectedSha256, expectedSize}` |
| `artifact.status/finalize` | `{bundleId}` |
| `artifact.inspect` | `{bundleId}` |
| `artifact.export` | `{bundleId, expectedManifestHash, exportName}` |
| `decision.review` | `{reviewId, bundleId, bundleManifestHash, snapshotId, contextRevisionId}` |
| `decision.record` | `{decisionId, bundleId, bundleManifestHash, snapshotId, contextRevisionId, reviewId, outcome, reason, items?}` |
| `decision.get` | `{decisionId}` |

Use IDs for a new staging/review/decision and exact existing references from receipts. `artifact.inspect` computes the manifest hash and checks bytes; it does not return file content. With a current `artifact.export` grant, export to a new name using that hash. The receipt points to the private data directory's `exports` copy; read those files as data. Export does not execute content or write source. `decision.review` compares the delivered baseline to the current heads. For accept/modify, use that review ID and the same target/baselines. Outcome is `accept`, `modify`, or `reject`; per-item sources must belong to that bundle. The returned DecisionRecord is separate from any implementation authorization.

The browser download action must use current supported attachment observation. Register the supported download wait before clicking, and retain the original completed download object. Commit raw is `{clicked: true, observation, completion: {captureIntentId, kind: "browser_download_completed", path}}`; reconcile raw is `{observation, completion}` without clicking again. Return only facts observed from the original object. Route is `authorized_local_collector`, not an invented platform file reference. For text sets, native references, or manual files, use the corresponding installed `artifact.*`/`collect-local` interface and preserve its reported route.

For a user-supplied reply file, the host prepares a `collect-local-set` manifest from current product receipts and the selected source files; the person should not hand-edit JSON or infer IDs from a chat URL. Its accepted shape is:

```json
{
  "scope": { "workspaceId": "ID_FROM_PRODUCT_RECEIPT", "collaborationId": "ID_FROM_PRODUCT_RECEIPT" },
  "bundleId": "NEW_BUNDLE_ID",
  "contextRevision": "CURRENT_CONTEXT_REVISION",
  "snapshotRefs": ["CURRENT_SNAPSHOT_ID"],
  "files": [
    { "sourcePath": "C:/path/to/user-provided/reply.md", "path": "review/reply.md", "mediaType": "text/markdown" }
  ]
}
```

Pipe the host-generated manifest to `rcac --data-dir ABSOLUTE_DATA_DIRECTORY collect-local-set`. The CLI records the route as `manual_import`; inspect and export the completed bundle before `decision.review`/`decision.record`. This is local review evidence, not automatic chat synchronization, source editing, or implementation authorization. For a PowerShell pipeline and file-safety rules, see [operations](../../../docs/operations.md#本地原始文件收取与审查副本).

Pass the normal Account UI's actual `{labels}` or `{fields}` observation to the DOM
observer, not a parsed email string. If the tool transport clips deeply nested
objects, serialize the complete observation as JSON text inside the supported
read-only DOM evaluation and parse it on the host, retaining the existing limits.
Reject `MaxDepth` or missing attributes; never reconstruct them or weaken parsing.
