# System-fusion acceptance

English | [中文](ACCEPTANCE.zh.md)

This table records what this branch actually exercised. `RUN_PASS` means the named command or gate ran on this host; `BLOCKED` means an external condition is missing; `NOT_RUN` means the behavior is not implemented or not exercised. A remote report is never copied into `RUN_PASS`.

## Fusion gates

| ID | Check | Status | Evidence |
|---|---|---|---|
| F0-01 | Existing W3 platform suite still passes | RUN_PASS | `pnpm run test:platform`: 276 passed, 4 skipped |
| F0-02 | Real W3 tenant A/B login | BLOCKED | no W3 tenant credentials |
| F1-01 | Disabled switch has no fusion side effect | RUN_PASS | `integration.config.spec.ts`, `integration.service.spec.ts` |
| F1-02 | Enabled but incomplete preflight is blocked, native platform stays up | RUN_PASS | `integration.preflight.spec.ts`, blocked-route test |
| F1-03 | Production refuses the process runner | RUN_PASS | `integration.config.spec.ts` |
| F2-01 | Gateway authenticates before fusion routing | RUN_PASS | `gateway.integration.spec.ts` 401 case |
| F2-02 | Mutations require CSRF and same-origin Origin | RUN_PASS | `gateway.integration.spec.ts` |
| F2-03 | Cross-user job/artifact reads return 404 | RUN_PASS | `integration.service.spec.ts` |
| F3-01 | Real container root and inputs are read-only | RUN_PASS | `verify-integration-isolation.sh` on WSL2 Docker 29.7.2 |
| F3-02 | Workspace and scratch are writable; uid is unprivileged | RUN_PASS | same Docker gate |
| F3-03 | `--network none`, no Docker socket, no host deployment root | RUN_PASS | same Docker gate |
| F3-04 | Non-Linux host is refused for analysis containers | RUN_PASS | `integration.preflight.spec.ts` host-platform issue |
| F3-05 | Shell/MCP/PTY/SSH/subagent/schedule bypasses disabled before any fusion tool runs | RUN_PASS | `/fusion` command marks the session; the guard admits only `integration_*` tools |
| F3-06 | Non-integration tools denied after a session enters fusion mode | RUN_PASS | `fusionToolAllowed` and `tools/pre-execute` guard in `tool-integration` |
| F4-01 | Mock ACL isolates users and resources | RUN_PASS | `integration.service.spec.ts` |
| F4-02 | HTTP adapter refuses redirects, metadata hosts, and oversized bodies | RUN_PASS | `integration.http-adapter.spec.ts` |
| F5-01 | Snapshot hash, source version, grant record, and epoch are stored | RUN_PASS | `integration.service.spec.ts` |
| F5-02 | Workspace switch reads the same snapshot and writes only the selected workspace | RUN_PASS | `integration.service.spec.ts` |
| F5-03 | Artifact download re-checks owner and hash | RUN_PASS | `integration.service.spec.ts` |
| F5-04 | Permission epoch change refuses an old snapshot | RUN_PASS | `integration.service.spec.ts` |
| F5-05 | Explicit cancellation is not overwritten by the container exit | RUN_PASS | `integration.service.spec.ts` cancellation race case |
| F6-01 | Workbench hidden without the fusion API | RUN_PASS | `Workbench.client.spec.tsx` |
| F6-02 | Ready and blocked panels render authorized resources and issue codes | RUN_PASS | `Workbench.client.spec.tsx` |
| F6-03 | Server-sent job streaming | NOT_RUN | panel refreshes on user action |
| F6-04 | Model tools read resources and run jobs through a runtime capability | RUN_PASS | `integration.capability.spec.ts`, `gateway.integration.spec.ts`, `tool-integration` client tests |
| F7-01 | Real W3 dual-user fusion isolation | BLOCKED | no real tenant or host system |
| F7-02 | Revocation/logout mid-job stops the old container | RUN_PASS | identity `isSessionActive` test and reaper case in `integration.service.spec.ts` |
| F7-03 | Background task, Schedule, MCP, and browser bypasses in a fusion Session | RUN_PASS | `tools/pre-execute` guard denies every non-`integration_*` tool once `/fusion` is entered |
| F8-01 | Analysis job image builds from `deploy/integration/job/Dockerfile` | BLOCKED | local Docker build could not resolve `python:3.12-alpine` (registry egress timeout) |
| F8-02 | Backup covers fusion metadata and snapshots | RUN_PASS (design) | `backup.sh` archives `management/`, which contains `integration/`; target-machine rehearsal not run |
| F8-03 | Upgrade/rollback preserves native users and fusion data | NOT_RUN | reuses existing scripts; no target-machine fusion rehearsal |
| F8-04 | Offline release with the fusion job image | NOT_RUN | no release bundle produced |
| F8-05 | Target-machine seven-day run | BLOCKED | no target machine window |
| F8-06 | Read-only fusion admin status reports state and counts | RUN_PASS | `admin.integration.spec.ts` |

## Explicit non-claims

- The remote `81/84` report is the baseline repository report, not this round's result. This round re-ran the local platform suite and recorded it separately.
- Mock resources and the local Docker host prove the contracts, not a production host-system connection.
- A green `RUN_PASS` row names only the evidence in its cell; it does not widen to real W3, the target deployment machine, or a business system.
