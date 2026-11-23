---
description: "Model-facing tools over the DSH platform fusion API: authorized read-only resources, immutable snapshots, isolated analysis jobs, and artifact reads through a runtime capability token."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-integration

English | [中文](README.zh.md)

## Summary

The package registers host tools that let the agent use the independent platform's fusion API without receiving a browser session, connector URL, or platform secret. Discovery is scoped to the signed-in user; reads become immutable snapshots; scripts run in the platform's short-lived analysis container; artifacts return with their hashes. When the platform injects no API URL or capability, the plugin registers no tools.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The plugin requires the `tools` service and two runtime environment values supplied by the platform supervisor: `DSH_INTEGRATION_API_URL` and `DSH_INTEGRATION_CAPABILITY_TOKEN`. The base bundle mounts the row disabled; the platform runtime overlay enables it only for a runtime whose platform service is ready.

The tools are:

- `integration_list_resources` and `integration_list_workspaces` for discovery.
- `integration_read_resource` and `integration_create_snapshot` for authorized reads.
- `integration_run_analysis_job`, `integration_job_status`, and `integration_read_job_artifact` for execution and output.

## Understand the implementation

### Trust and transport

The capability is an HMAC token scoped to one user, one permission version, and a short expiry. The token reaches the platform gateway's `/api/integration/runtime/*` surface; the gateway resolves it to a session-shaped actor and the fusion service applies the same owner, ACL, and epoch checks as the browser API. The token never authorizes the native runtime proxy.

### Content bounds

Resource and artifact text is capped by `maxContentChars` before it reaches the model. Analysis jobs receive snapshots at `/inputs`, write only `/work` and `/scratch`, and have no network. The tool text marks every truncation.

-----

<a id="further-exploration"></a>
## Further Exploration

- [System-fusion implementation](../../../docs/integration/README.md) — switch, ACL, snapshots, job container, and acceptance status.
- [Platform architecture](../../../services/platform/ARCHITECTURE.md) — gateway, identity, runtime, and integration composition.
- [Model-facing tool conventions](../../../docs/cookbook/adding-a-tool.md) — tool schema, result, and presentation rules.

-----

<a id="model-experience"></a>
## Model Experience

### Fusion analysis tools

#### What the model sees

Seven tool definitions when the platform capability is present: `integration_list_resources`, `integration_list_workspaces`, `integration_read_resource`, `integration_create_snapshot`, `integration_run_analysis_job`, `integration_job_status`, and `integration_read_job_artifact`. Each returns lossless JSON; resource and artifact text is bounded and marked when truncated.

#### Token effect

The schemas and descriptions add a fixed prompt cost to every request in a fusion-enabled runtime. Tool results add only the resource or artifact text the call returned, capped by `maxContentChars`.

#### KV Cache effect

The tool schemas are stable for a runtime generation, so they do not invalidate a cache entry. A read result enters the request only after the call and does not change earlier prompt prefixes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No model-side fusion Session restriction** — these tools are additive; the platform does not yet disable shell, MCP, PTY, SSH, subagent, Schedule, or browser tools for a fusion session.
- **No streaming job status** — the model polls `integration_job_status`.
- **Text-only artifact reads** — binary artifacts are decoded as UTF-8 and may be unreadable.
- **No connector URL or business write** — the tools cannot call a host system directly or perform a write action.

<a id="dev-note"></a>
### Dev Note

The empty-config no-op is intentional: the base bundle mounts the row disabled, and a runtime without the platform capability must remain exactly as it was.
