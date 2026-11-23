# DSH system-fusion analysis (implementation record)

English | [中文](README.zh.md)

System fusion is a **disabled by default** capability on the independent DSH multi-user platform: an authenticated W3/Mock user can read administrator-registered, user-authorized read-only resources without modifying the host business system, and submit analysis scripts to a separate short-lived container. The native DSH chat, Session, Workspace, identity, and deployment are unchanged while the switch is off.

## 1. Switch and state

`DSH_INTEGRATION_ENABLED=false` is the only default. While off, the composition root creates no fusion service, opens no fusion database, initializes no adapter, and contacts no host system; the gateway answers `/api/integration/*` with 404 and never forwards those requests to the native Runtime.

When enabled, `createIntegrationService()` runs preflight at startup. A failed preflight does not stop the native W3 platform; it sets fusion to `blocked`: `GET /api/integration/status` returns the state and missing-prerequisite codes, and every other fusion route returns 503. Issue codes contain no host path, secret, or upstream response body.

```text
OFF      native platform unchanged; no fusion entry point
READY    preflight passed; each request still re-checks user authorization
BLOCKED  any hard prerequisite missing; all data and Job routes refuse
```

## 2. Two runtimes

| Plane | Owner | Capability |
|---|---|---|
| Chat/control plane | existing per-user DSH Runtime | sign-in, Session, chat, native tools; no host source, business data, or fusion workspace mounted |
| Data/execution plane | `AnalysisJobRunner` | one short-lived container per job; read-only inputs, current workspace output, job scratch, no network by default |

Analysis containers are started directly by Docker, and `services/platform/src/integration/runner.ts` is the only source of their arguments: `--read-only`, `--network none` by default (or an internal network plus the allowlisted broker), `--user <uid>`, `--cap-drop ALL`, `--security-opt no-new-privileges:true`, CPU/memory/PID limits, `--tmpfs /tmp`, and exactly three mounts:

```text
/inputs   RO   authorized snapshots of the current Job
/work     RW   the logical workspace the user selected (one subdirectory per Job)
/scratch  RW   private scratch of the current Job
```

The image entrypoint is cleared, and the command is fixed to `/bin/sh /scratch/run.sh` or `python3 /scratch/run.py`. The container mounts no Docker socket, host root, platform configuration, `.env`, model key, or persistent external-system token.

## 3. Resources, ACL, and snapshots

Administrators register systems in `DSH_INTEGRATION_SYSTEMS_FILE`. A system has one of two adapters:

- `mock`: fully offline declarative resources for tests and local demonstration; production preflight refuses it.
- `http`: only fixed GET endpoints registered by the administrator. A request cannot assemble a URL, host, port, query, or redirect; the adapter refuses 3xx, metadata addresses, oversized responses, and timeouts.

ACL keys are the internal user id, the W3 subject, or the W3 uid, and values may only be `list`, `read`, or `export`. Every discovery, snapshot, job start, and artifact download is decided by the service from the current `ValidatedSession`; a browser-supplied `userId` participates in no query.

A snapshot is immutable after write and records `system_id`, `resource_id`, `source_version`, `sha256`, `fetched_at`, `grant_id`, `policy_epoch`, `classification`, and storage key. Reads recompute the hash; a job re-authorizes with the adapter and checks `policy_epoch` before starting, refusing on mismatch.

## 4. Workspaces and Jobs

A workspace is a platform-generated logical id; the physical path is assembled by the service. Read permission and workspace write permission are orthogonal: a user may read resource S in workspace A and still read the same S after switching to B, but a new Job writes only to B; an already-started Job's output directory never moves because of a switch.

A Job records `owner_user_id`, `session_id`, `workspace_id`, input snapshot ids, language, script hash, status, and timestamps. Outputs are collected only from the current workspace's `<workspace>/jobs/<jobId>`; symlinks, non-regular files, and oversized files are refused. An artifact records `sha256`, MIME, size, and `downloadScope: owner`; download re-checks ownership and hash and returns `x-artifact-sha256` plus `x-artifact-job-id`.

## 5. HTTP routes

Every route first passes the existing Gateway Session check; `POST` additionally requires CSRF and, when an Origin is present, the same origin. The fusion service then looks objects up by owner.

```text
GET  /api/integration/status
GET  /api/integration/systems
GET  /api/integration/resources?systemId=...&cursor=...
POST /api/integration/snapshots
GET  /api/integration/workspaces
POST /api/integration/workspaces
GET  /api/integration/jobs
POST /api/integration/jobs
GET  /api/integration/jobs/:jobId
POST /api/integration/jobs/:jobId/cancel
GET  /api/integration/artifacts/:artifactId/download
GET  /api/integration/audit?jobId=...
```

A cross-user read returns 404 and does not distinguish "absent" from "unauthorized". `GET /api/integration/audit` returns the Job, input snapshots, and artifact metadata for source tracing.

The per-user runtime's model tools call the same paths under `/api/integration/runtime/` with `Authorization: Bearer <capability>`. The gateway resolves the short-lived HMAC token to a session-shaped actor and re-checks the user's current permission version and live browser session, so logout or revocation refuses the token before expiry; no browser cookie or CSRF token is involved, and the route never falls through to the native runtime proxy.

## 6. Configuration

See the "system-fusion analysis" block in `deploy/.env.example` and `deploy/integration/README.md`. Key constraints:

- Production requires `AUTH_MODE=w3`, `DSH_RUNTIME_KIND=container`, and `DSH_INTEGRATION_JOB_RUNNER_KIND=container`.
- The analysis image must be fixed; a digest is recommended.
- `DSH_INTEGRATION_JOB_NETWORK=none` by default. A dedicated network requires `DSH_INTEGRATION_EGRESS_BROKER_URL` and a healthy `/healthz`; the broker accepts only exact `host:port` allowlist entries.
- Concurrent active jobs are bounded per user (`DSH_INTEGRATION_MAX_ACTIVE_JOBS`, default 2) and platform-wide (`DSH_INTEGRATION_MAX_ACTIVE_JOBS_TOTAL`, default 8); both limits return 429 `job-limit`.
- Snapshot, workspace, and Job roots must be pairwise disjoint real directories; preflight refuses symlinks and overlap.
- A non-Linux host cannot start analysis containers; a Windows host using Docker through WSL2 is development-only and is not a production fusion boundary.

## 7. Verified and outstanding

Actual commands and results are in [TEST_REPORT.md](TEST_REPORT.md); per-gate status is in [ACCEPTANCE.md](ACCEPTANCE.md). Executed locally:

- `pnpm run typecheck:platform`: passed.
- `pnpm run test:platform`: 27 files passed, 1 skipped; 283 tests passed, 4 skipped (including 6 fusion specs).
- Real Docker negative verification: `deploy/scripts/verify-integration-isolation.sh` passed on WSL2 Ubuntu + Docker Engine 29.7.2, covering read-only root, read-only `/inputs`, writable `/work` and `/scratch`, uid 1000, `--network none`, no Docker socket, and no host `/srv/dsh`.
- W3 baseline regression: this round's `pnpm run test:platform` covered the original 220 baseline cases, all passed; a real W3 tenant remains externally `BLOCKED`.
- Native optional UI: `packages/client/ui-integration-workbench` registers one `shell.overlay` launcher, reads status once, and renders nothing when fusion is absent; its API and component specs pass.
- Model tools: `packages/integration/tool-integration` exposes discovery, snapshot, isolated-job, status, and artifact tools; the platform injects a short-lived HMAC capability into the per-user runtime and the gateway resolves it without a browser session.
- Session revocation: runtime tokens are re-checked against the current permission version, and the job reaper cancels a running container after logout, disable, or permission change.
- Fusion tool guard: `/fusion` marks a session before the first action, and its `tools/pre-execute` guard then denies shell, MCP, PTY, SSH, subagent, Schedule, browser, and dynamic-plugin tools; the first `integration_*` call also marks the session.
- Offline release: `make-integration-release.sh` packages the image tar, registry examples, job Dockerfile, disabled-by-default env template, and checksums; `verify-integration-release.sh` validates the bundle.
- Controlled egress: `verify-integration-egress.sh` passed on a real WSL2 Docker network with an internal job network, allowlisted target, denied port, and no direct route.

Not complete, and must not be claimed production-ready:

- `/fusion` is an explicit opt-in; without it, the guard activates only on the first `integration_*` call. The marker persists under `DSH_HOME` but is an application guard, not a physical sandbox rule.
- Controlled egress is opt-in; the proxy network path passed a real local Docker test, but no target-environment business host has been exercised.
- Real W3 tenant A/B, a seven-day target-machine run, and internal Git are external `BLOCKED` items.
- Production deployment, upgrade, backup, and rollback reuse the existing scripts; a fusion-specific rehearsal on the target machine has not run.
