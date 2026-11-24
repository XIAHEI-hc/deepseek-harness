# Host system onboarding conditions

English | [中文](ONBOARDING.zh.md)

This page is the intake checklist for connecting one host system to DSH system fusion. It states what the host owner, W3 tenant administrator, platform administrator, and security reviewer must provide before preflight can report `ready` and before production use is allowed. Runtime behavior is documented in [README.md](README.md); deployment steps are in [deploy/integration/README.md](../../deploy/integration/README.md).

## 1. Roles and decisions

| Role | Must provide | Accountable for |
|---|---|---|
| Host system owner | Read-only interface documentation, resource catalogue, ACL rules, sample resources, and a change window | The host remains unmodified and every exposed action is read-only |
| W3 tenant administrator | Two test users, their subjects/uids, the existing W3 client registration, and a permission-change test | Real identity mapping and revocable authorization |
| DSH platform administrator | Linux Docker host, deployment values, connector registry, analysis image, backup, and rollback | Preflight `ready`, isolation, and recoverability |
| Security reviewer | Data classification, allowed network destinations, secret handling, retention, and audit requirements | No write path, no secret exposure, and no uncontrolled egress |

One named acceptance owner must be able to approve the two-user test and the production switch.

## 2. Identity and authorization conditions

- The existing W3 authorization-code login must already work on the target platform. Fusion adds no second login, cookie, or user directory.
- At least two real W3 test users are required. User A must be authorized for two resources; user B must be authorized for only one of them; at least one resource must be denied to A.
- The ACL key may be the internal DSH user id, the W3 subject, or the W3 uid. Values are limited to `list`, `read`, and `export`; absent entries deny by default.
- The host owner must state how a user loses access, and the platform must be able to demonstrate it: disable the account or change its permission version, then confirm existing sessions and runtime tokens fail.
- A service credential may read host resources only after the server has checked the user ACL. It must not be accepted as a user identity and must not be shared with a model, Session, Job, or browser.

## 3. Resource conditions

| Resource kind | Required from the host | Limits and refusals |
|---|---|---|
| Interface documentation | Versioned OpenAPI, AsyncAPI, or Markdown; base URL; authentication; pagination; error format; rate limits | No user-supplied URL and no write endpoint |
| Read-only source | A read-only Git mirror or archive endpoint plus the commit or version identifier | No build, checkout write, or host workspace mount |
| Data | A read-only SQL view or export endpoint; schema; row limit; sample response | No DML, stored procedure with side effects, or unbounded query |
| Logs | A read-only query endpoint; time range; fields; redaction rules | No log deletion, ingestion, or host shell |
| Execution artifacts | Read-only object references with checksums and retention | No upload, overwrite, or executable handoff to the host |

Every resource must have a stable locator, a source version, a classification, and a hashable representation. The default snapshot cap is 16 MiB; larger resources need an explicit platform limit change and a size test.

## 4. Adapter and network conditions

- The current adapters are the offline `mock` adapter and the endpoint-allowlisted `http` adapter. The mock adapter is for development and rehearsal only; production preflight refuses it.
- The HTTP adapter uses administrator-configured base URLs and paths. It accepts `GET` reads, refuses redirects, enforces timeout and response-size limits, and does not expose a general proxy or a user-controlled URL.
- Any other protocol or write integration requires a new reviewed adapter. It is not enabled by editing the registry.
- The platform container must be able to reach the host base URL. The analysis Job container stays on `--network none` by default and does not need host access.
- If a Job needs controlled egress, the broker must be deployed, its exact `host:port` allowlist reviewed, and `dsh-fusion-egress` used. Direct Job egress is not an option.

## 5. Connector registry and grants

The administrator supplies one versioned `systems.json` entry. The example format is [systems.http.example.json](../../deploy/integration/systems.http.example.json).

- `id`, `name`, `adapter`, `baseUrl`, and `endpoints` are administrator-owned.
- Each endpoint has a stable `id`, `path`, `resourceType`, `version`, `classification`, and `acl`.
- ACL entries name real users; no wildcard tenant, shared admin account, or public endpoint is accepted.
- The request selects an existing endpoint id; it never supplies a host, URL, method, or action outside the registry.
- Test user A and test user B must produce different resource lists from the same endpoint.

## 6. Runtime and deployment conditions

- A Linux host with Docker Engine, cgroups, and a non-root deployment user is required. Windows through WSL2 is development-only.
- The analysis image must provide `/bin/sh` and `python3`, run as a non-root uid, and be pinned by digest. The host must load the image before enabling fusion.
- Snapshot, workspace, and Job roots must be pairwise disjoint real directories. Symlinks and overlapping roots are refused.
- The platform stores fusion metadata under `management/integration`; existing backup and restore keep that directory with the rest of `management`.
- Required deployment values include `DSH_INTEGRATION_ENABLED`, `DSH_INTEGRATION_SYSTEMS_FILE`, `DSH_INTEGRATION_DATA_DIR`, `DSH_INTEGRATION_JOB_RUNNER_KIND=container`, `DSH_INTEGRATION_JOB_IMAGE`, `DSH_INTEGRATION_JOB_NETWORK`, and `DSH_INTEGRATION_RUNTIME_API_URL`.
- Concurrency is bounded by `DSH_INTEGRATION_MAX_ACTIVE_JOBS` per user and `DSH_INTEGRATION_MAX_ACTIVE_JOBS_TOTAL` platform-wide.
- `admin integration status` must report `ready`; every missing prerequisite is a blocker, not a warning to ignore.

## 7. Security conditions

- The host credential is read-only, least-privilege, rotatable, and supplied out of band. It never appears in a registry, snapshot, Job, model prompt, Session event, or log.
- Host source, deployment files, `.env`, keys, and raw data are never mounted into the per-user Runtime or the analysis Job.
- The Job has no Docker socket, host root, platform secret, or persistent host token.
- The host must provide TLS, a stable DNS name or address, and a firewall rule for the platform only. If a broker is used, its allowlist must not include metadata services.
- The host owner defines data classification, retention, and deletion. The platform administrator must confirm that snapshots, workspaces, artifacts, and backups follow that policy.
- Audit must cover reads, snapshot creation, Job start, cancellation, download, and denied access. The host keeps its own read audit as well.

## 8. Acceptance evidence required before production

| Check | Required evidence |
|---|---|
| Real W3 login | Two users sign in through the existing W3 flow; no fusion-specific login exists |
| ACL isolation | User A sees the two approved resources; user B sees one; the denied resource returns 403/404 |
| Snapshot metadata | Source version, hash, grant, classification, and permission epoch are stored and visible in the Job audit |
| Workspace isolation | A Job writes only the selected workspace; switching to workspace B cannot write A |
| Job isolation | Real Docker negative test passes: read-only root and inputs, writable work/scratch only, no socket, no host root, `--network none` unless a reviewed broker exists |
| Revocation | Disable or permission change stops new requests and cancels an active Job |
| Artifact download | Owner check, hash check, `x-artifact-sha256`, and `x-artifact-job-id` are verified |
| Preflight | Missing prerequisites produce `blocked`; complete prerequisites produce `ready` |
| Backup and restore | A management tar round-trip preserves metadata counts and snapshot bytes |
| Upgrade and rollback | The target host rehearsal keeps native users and fusion data |
| Seven-day run | A real target run completes without a security or data-integrity incident |

Items that require a real tenant or target host remain `BLOCKED` until that evidence exists. A local test or a remote report is not a substitute.

## 9. Intake form

Provide the following in the onboarding ticket. Do not paste credentials into the ticket; deliver them through the approved secret channel.

```text
Host system:
Owner and contact:
Environment and version:
Base URL and TLS:
Network path from the platform:
Authentication method and read-only scopes:
Credential rotation owner:
Resource types and stable ids:
Expected size, content type, and rate limit per resource:
Sample response for each resource:
ACL keys and values:
Test user A: subject / uid / internal id / allowed resources
Test user B: subject / uid / internal id / allowed resources
Denied-resource case for user A:
Data classification, retention, and deletion:
Egress destinations and ports:
Target Linux host and Docker version:
Analysis image digest:
Backup, rollback, and change-window owner:
Acceptance owner and test dates:
```

## 10. Conditions that stop onboarding

- The host exposes only a write API, or requires a shared administrator token.
- The platform would need a general proxy, arbitrary URL fetching, or an allowlist that includes cloud metadata endpoints.
- The host cannot provide two real users or a resource-level deny case.
- The source is not read-only, or the platform would need to modify host code, deployment files, `.env`, keys, or raw data.
- The analysis Job would need a Docker socket, host root, persistent host token, or unrestricted network.
- The production deployment would use the Mock adapter, a mutable image tag, or an unloaded analysis image.
- No target host, backup path, rollback owner, or seven-day window exists.

## 11. Onboarding sequence

1. Complete the intake form and name the acceptance owner.
2. Freeze the resource list, ACL, and read-only guarantee with the host owner.
3. Run the Mock adapter rehearsal for the two users and the denied resource.
4. Add the real HTTP system to `systems.json`, then run `admin integration status` until it reports `ready`.
5. Run the two-user, workspace, network, revocation, and download checks on a staging deployment.
6. Load the analysis image, verify the isolation and egress scripts, and rehearse backup and rollback on the target host.
7. Run the seven-day pilot with real W3 users.
8. Enable fusion for the approved users only, then keep the switch, audit, and rollback path under review.
