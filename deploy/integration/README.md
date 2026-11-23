# System-fusion deployment

English | [中文](README.zh.md)

This directory holds the optional host-fusion assets. The native W3 platform runs unchanged when `DSH_INTEGRATION_ENABLED=false`.

## Prerequisites

1. Linux host with Docker Engine and `docker compose`; the platform process needs the Docker CLI and socket to start analysis containers. Fusion preflight refuses a non-Linux host because bind-mount paths and isolation flags must be authoritative.
2. `APP_ENV=production`, `AUTH_MODE=w3`, and `DSH_RUNTIME_KIND=container`.
3. A fixed analysis image built from [`job/Dockerfile`](job/Dockerfile) or an equivalent image with `/bin/sh` and `python3`.
4. A connector registry copied from [`systems.http.example.json`](systems.http.example.json). Remove the example host and users before deployment. ACL keys may be the internal user id, the W3 subject, or the W3 uid; `uid` is the practical choice for administrators.
5. Snapshot, workspace, and job roots on a persistent volume. They must be pairwise disjoint real directories; preflight refuses overlap or symlinks.
6. A backup plan for `DSH_INTEGRATION_DATA_DIR`. Snapshots and job metadata are required for provenance, not for the native chat history.

## Enable

```dotenv
DSH_INTEGRATION_ENABLED=true
DSH_INTEGRATION_SYSTEMS_FILE=/srv/dsh/management/integration/systems.json
DSH_INTEGRATION_DATA_DIR=/srv/dsh/management/integration
DSH_INTEGRATION_JOB_RUNNER_KIND=container
DSH_INTEGRATION_JOB_IMAGE=dsh-analysis@sha256:<digest>
DSH_INTEGRATION_JOB_NETWORK=none
```

Restart the platform and read `GET /api/integration/status` as a signed-in user. `ready` means preflight passed. `blocked` lists stable issue codes; the detail needed to repair the deployment stays in the operator's configuration, not in the browser.

## Disable

Set `DSH_INTEGRATION_ENABLED=false` and restart. Fusion routes disappear, the metadata database and snapshots stay on disk, and no analysis container is started. Revoke active jobs before disabling if they must stop immediately.

## Verify

Run the real Docker gate on the deployment host:

```bash
DSH_INTEGRATION_JOB_IMAGE=dsh-analysis@sha256:<digest> \
  bash deploy/scripts/verify-integration-isolation.sh
```

The gate inspects the daemon-resolved container and fails if the root is writable, the network is not `none`, capabilities or `no-new-privileges` are missing, the user is not the configured uid, a Docker socket or host deployment root is visible, or the input snapshot is writable.

## Boundaries

- Analysis containers receive only `/inputs` (read-only), `/work` (the selected workspace, read-write), and `/scratch` (job-private, read-write). `/app`, the platform configuration, and `/secrets` are never mounted.
- Jobs have no network by default. A dedicated broker network is not implemented; preflight refuses anything except `none`.
- The connector registry is administrator-owned. A request selects an existing endpoint id; it never supplies a URL, host, or action outside the configured read actions.
- Mock connectors are development fixtures. Production preflight refuses them.
