# Security

RepoConduit connects explicitly registered local repositories to external
participants. Sharing scope, frozen snapshots, project identity, grants,
and the local investigator sandbox are security boundaries. Never put API
keys, browser profiles, real installation databases, or unredacted transcripts
in source control. Keep runtime data outside the checkout.

See [security and deployment](../docs/SECURITY_AND_DEPLOYMENT.md) and
[known limitations](../docs/known-limitations.md). A source release does not
certify that every native execution route or account integration is qualified.

For a suspected vulnerability, stop the affected connection and revoke its
grants as appropriate. Contact the repository maintainer privately through
the hosting service's private vulnerability reporting channel if available.
Do not include credentials or private project data in public issues.
