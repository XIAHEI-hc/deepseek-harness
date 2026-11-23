# System-fusion test report

English | [中文](TEST_REPORT.zh.md)

Records commands and results actually executed; unexecuted items are explicitly `NOT_RUN` or `BLOCKED`.

## 1. This round (2026-11-23, Windows + WSL2 Ubuntu)

| Command | Result | Notes |
|---|---|---|
| `pnpm run typecheck:platform` | PASS | `tsc -p services/platform/tsconfig.json --noEmit` |
| `pnpm run test:platform` | PASS | 26 test files passed, 1 skipped; 279 tests passed, 4 skipped |
| `DSH_INTEGRATION_JOB_IMAGE=dsh-runtime:2026.11.23.7 bash deploy/scripts/verify-integration-isolation.sh` (WSL2 Ubuntu) | PASS | real Docker 29.7.2; read-only root, read-only inputs, writable workspace/scratch, uid 1000, `network none`, no Docker socket, no host deployment root |
| `pnpm exec vitest run packages/client/ui-integration-workbench/tests` | PASS | 2 files, 10 tests: status/overview/CSRF parsing, panel states, and queued-job polling |
| `pnpm exec vitest run packages/client/ui-theme/tests` | PASS | 24 files, 183 tests: the new stylesheet satisfies radius, hairline, elevation, focus-ring, corner-shape, and scrollbar gates |
| `pnpm exec vitest run packages/integration/tool-integration/tests` | PASS | 2 files, 8 tests: capability header, discovery, bounded reads, job start/status, API errors, allowlist, and persisted session markers |
| `pnpm exec vitest run services/platform/tests/admin.integration.spec.ts` | PASS | 3 tests: disabled status is inert; ready status reports zero metadata counts; disabled job listing is empty |
| `bash deploy/scripts/verify-integration-release.sh` on a synthetic bundle | PASS | checksums, image tar, broker source, disabled-by-default env, and both JSON registries |
| `node --test deploy/integration/broker/proxy.test.mjs` | PASS | exact allowlist forwarded; another port refused with 403 |
| `DSH_INTEGRATION_EGRESS_TEST_IMAGE=dsh-platform:2026.11.23.7 bash deploy/scripts/verify-integration-egress.sh` (WSL2) | PASS | internal job network; broker health; allowlisted target through proxy; denied port 403; no direct target route |
| `pnpm run test:gui` (full suite) | RUN_FAIL (environment) | 9/14127 failed: 6 were new-stylesheet rule violations (fixed; `ui-theme` re-run passed), 3 are unrelated host conditions (symlink EPERM, secret-mask timeout, pnpm pack timeout) |

## 2. Fusion unit/contract coverage

`services/platform/tests/integration.*.spec.ts` covers:

- disabled by default creates no directory and opens no database.
- production refuses the process runner; refuses `host`/`bridge`/`default` networks; refuses unknown runners and invalid numbers.
- registry: duplicate system id, path traversal, credentials in baseUrl, write actions.
- preflight: missing systems file, overlapping roots, process runner, missing image, production Mock system.
- adapters: per-user ACL isolation, cross-connector refusal, redirect refusal, response size cap, metadata host refusal, ETag as source version.
- service: only authorized resources are discoverable; unauthorized snapshot 403; hash and source version; the same snapshot is readable after a workspace switch while outputs stay separate; Job success/failure; cross-user Job/artifact 404; changed permission epoch refused.
- gateway: unauthenticated 401, missing CSRF 403, cross-origin 403, authenticated forwarding, disabled 404 without falling into the native proxy.
- workbench: hidden without the API, launcher/panel rendering, authorized resource listing, snapshot selection, blocked issue codes, CSRF on mutations.
- runtime capability: mint/verify/expiry/tamper, gateway bearer route without a browser session, runtime environment injection, and model tool transport.
- session revocation: `isSessionActive` after logout, stale permission version refused, and a running job cancelled by the revocation sweep.
- fusion tool guard: `/fusion` marks the session before the first action; only `integration_*` names are admitted afterwards, and the marker survives a runtime restart.

## 3. Real-container negative evidence

`deploy/scripts/verify-integration-isolation.sh` first uses `docker create` to inspect the daemon-resolved `HostConfig`, then starts the container and runs a probe:

- writes to `/app`, `/inputs`, and `/root` fail;
- writes to `/work` and `/scratch` succeed;
- `/var/run/docker.sock` is absent;
- `/srv/dsh` is invisible;
- reaching `169.254.169.254` times out and fails;
- the process uid is 1000.

Output summary: `analysis probe passed` / `verify-integration-isolation: PASS`.

## 4. Not executed or BLOCKED

| Item | State | Reason |
|---|---|---|
| Real W3 tenant A/B fusion resource read | BLOCKED | no W3 tenant or business-system credentials |
| Target deployment machine rollout | BLOCKED | no target Linux deployment machine or production DNS/certificate |
| Seven-day stability | BLOCKED | needs a target-machine run window |
| Internal Git push | BLOCKED | no internal address or credentials |
| Model-side restricted tool assembly | NOT_RUN | not implemented |
| PostgreSQL-backed fusion metadata | NOT_RUN | fusion metadata is node-local SQLite, matching the runtime registry |
| Analysis job image build | BLOCKED | `python:3.12-alpine` metadata request timed out against Docker Hub from this host |
