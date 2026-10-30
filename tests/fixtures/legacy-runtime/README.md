# Offline runtime fixtures

These are deidentified test inputs, not runtime acceptance evidence. Native run metadata, prompts, terminal output and original account or session identity are excluded. Paths use a fictitious `fixture` user; UUIDs and invocation IDs are deterministic placeholders. The retained process graph, mount table, PID/inode numbers and historical generic Python program preserve validator edge cases. They describe no current process or machine.

The historical program must retain its exact bytes because the decoder checks a versioned hash. Path-dependent command commitments were recomputed after deidentification. The collector input deliberately remains an unvalidated candidate, matching its observer failure-path tests.

`InitializeParams.json` and `InitializeParams-legacy.json` retain two distinct versioned SDK schemas. Offline capability tests use the former; the native qualification preflight keeps the latter and its original commitment, without promoting that native diagnostic to passing evidence. the warning JSONL and incomplete private binding are minimal synthetic protocol examples. `project-a` and `project-b` contain synthetic source used for isolated repository tests. No file here is a credential or authorization to start a native runtime. Native test output belongs under `.local/qualification/`, never this fixture directory.
