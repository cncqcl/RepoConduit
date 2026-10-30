# Dependencies and license status

## Current package boundary, 2026-10-29

`package.json` declares Node `>=24 <25`, `private: true` and `MIT` (see [LICENSE](../LICENSE));
the npm package is not publicly released. The retained private `a38d560` tgz
passed its scoped isolated smoke, but that does not establish a locked installed
graph: the [public historical evidence summary](release-evidence.md)
records `on-finished` 2.4.1 in shrinkwrap versus 2.4.2 selected during installation.
This remains open separately from the full release gates. Historical inventories
below describe their stated dates and do not establish the current installed graph.

## Production notice inventory, 2026-10-02

The then-locked production graph contained 54 package entries (including
nested versions): all installed manifest versions and declared licenses match
`package-lock.json`. The bounded collector inspected 295 directory entries and
read 90,912 bytes of license text, without reading dependency source trees or
examining the system toolchain.

[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) preserves the supplied text for
53 entries; [PRODUCTION_LICENSE_INVENTORY.json](PRODUCTION_LICENSE_INVENTORY.json)
records each original notice's byte size/hash and the lockfile binding.
Regenerate these documents from the source checkout with
`node tools/collect-production-notices.mjs`.

`koa-compose@4.1.0` has no LICENSE text in the installed package or npm tarball;
its manifest and Readme declare MIT. Official npm metadata identifies source
tag commit `06e82e65a368ac12cd6405beaf19fd5d208a1477`. A separate bounded
investigation preserved the later upstream-authored notice from commit
`903480c36957776f8561a33a840cdd0a06ad611f`; it was added after the 4.1.0 release
and is not represented as having shipped in 4.1.0. See the dated supplement
below and its provenance record. The production notice inventory remains
**incomplete**, and the final `license_review` gate has not passed. RepoConduit source is licensed under MIT; dependency notices retain their own terms. This does not certify a distributable dependency bundle. The broader
historical development-dependency counts below are separate from this current
production inventory.

The project source is licensed under MIT by the owner decision on 2026-10-30. The npm package remains private; this is not an npm release. The historical handoff was UNLICENSED, and the original records are retained privately. Third-party notices and the complete release-review gate remain separate.

The direct production dependencies are locked in `package-lock.json`. On 2026-09-27, the installed package manifests reported:

| Package | Locked version | Manifest license |
|---|---:|---|
| `@modelcontextprotocol/client` | 2.1.0 | MIT |
| `@modelcontextprotocol/server` | 2.1.0 | MIT |
| `jose` | 6.2.12 | MIT |
| `oidc-provider` | 9.12.2 | MIT |
| `zod` | 4.2.0 | MIT |
| `semver` | 7.8.5 | ISC |

On 2026-10-02, `semver` 7.8.5 became an exact direct production dependency
for validating installation dependency ranges. Its installed manifest and
ISC license were read locally; it was installed from the existing offline
npm cache. The older transitive inventory below has not been refreshed.

This is a direct-dependency manifest inventory, not a full transitive-license audit or legal conclusion. It does not satisfy the `license_review` release receipt on its own. No code from the four reference repositories in [REFERENCES_AND_REUSE.md](REFERENCES_AND_REUSE.md) has been copied into the product.

The 2026-09-27 local lockfile inventory contains 189 dependency entries: 161 MIT, 13 Apache-2.0, 7 ISC, 6 BSD-2-Clause, 1 BSD-3-Clause, and 1 BlueOak-1.0.0 (`minimatch`). Every lockfile entry declares a license. Of the 163 packages installed for this Windows host, every manifest version and license matched the lockfile. The other 26 entries are optional packages for other platforms and were not installed locally. Six installed package directories did not contain a root-level `LICENSE` or `COPYING` file (`@esbuild/win32-x64`, `@humanfs/types`, `esrecurse`, `imurmurhash`, `koa-compose`, `natural-compare`); their manifests still declare a license. This inventory does not establish a complete notice set for redistribution, so the release receipt remains open.

## koa-compose notice supplement, 2026-10-03

The exact 1,093-byte MIT notice later added upstream at Git commit `903480c36957776f8561a33a840cdd0a06ad611f` is preserved in [the versioned notice archive](licenses/koa-compose/903480c/LICENSE), with source details in [PROVENANCE.md](licenses/koa-compose/903480c/PROVENANCE.md). Its SHA-256 is `44a7ca64cb59fbe6481a7260e4317ff0177127a6e50e6077a9bfa60f89f905a2`; the fixed source is [the official GitHub commit file](https://github.com/koajs/compose/blob/903480c36957776f8561a33a840cdd0a06ad611f/LICENSE).

This notice was added after `koa-compose` 4.1.0. It is not present in the locked 4.1.0 install or npm tarball, so the production notice inventory remains incomplete and the final `license_review` gate has not passed. The MIT choice for RepoConduit does not close this historical notice-review gate. This documentation supplement does not upgrade the dependency to 4.2.0 or claim the later notice shipped with 4.1.0.

Independent bounded review on 2026-10-03 checked all 54 installed production
manifests against the locked graph, all 53 supplied notice bodies and their
sizes/hashes, and the exact supplementary Git blob. No mismatch was found in
that scope (`supplemented_notice_review_complete`). The original installed-text
inventory remains `incomplete`. Manifest labels (49 MIT, 5 ISC) are not the
whole notice terms: the three MCP package notices also preserve Apache-2.0/MIT
transition wording and CC-BY-4.0 documentation statements. Final artifact
preservation and a properly bound release-review receipt remain required;
this bounded review does not grant public distribution authorization.
