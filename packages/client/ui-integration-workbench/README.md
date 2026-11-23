---
description: "Optional Web client workbench over the DSH platform fusion API: authorized read-only resources, analysis workspaces, and job source metadata, with no UI when fusion is unavailable."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-integration-workbench

English | [中文](README.zh.md)

## Summary

The plugin adds one optional launcher to the native DSH shell. It reads `/api/integration/status` once; a deployment without fusion renders nothing and makes no further request. When the service is available, the panel lists only the signed-in user's authorized systems and resources, captures immutable snapshots, creates logical analysis workspaces, starts short-lived analysis jobs, and exposes artifacts with their source metadata. The chat runtime, model providers, and native Session UI are unchanged.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

The plugin requires the `slots` and `locale` services and contributes one `shell.overlay` entry. The launcher is absent while availability is loading or when fusion is disabled at the deployment level. A blocked service still opens a panel that lists missing-prerequisite codes; data routes stay refused by the gateway.

The panel supports the same flow as the HTTP API: select a system, create a snapshot for an authorized resource, create or select a workspace, choose shell or Python, run a script, refresh job status, cancel a queued or running job, and download each artifact.

## Understand the implementation

### Availability

`src/client/controller.ts` reads `/api/integration/status` once. A 404 or transport failure publishes `unavailable` and the component returns nothing. A 200 publishes the service status; `disabled` is also treated as unavailable. The controller is disposed with the plugin fiber.

### Data and mutation

`src/client/api.ts` performs same-origin fetches. Mutating requests echo the non-HttpOnly `dsh_csrf` cookie in `x-csrf-token`; the browser never reads the HttpOnly session cookie. The component holds panel data in local state and refreshes it only from user actions, so the plugin owns no polling timer or module-level cache.

### Copy and styling

Visible copy lives in the `fusion` dictionaries (zh/en plus ja, es, fr, de, ru, pt) and reaches the component through the `t` seat. Styles are CSS Modules over the shared `--dsw-*` aliases.

-----

<a id="further-exploration"></a>
## Further Exploration

- [System fusion implementation](../../../docs/integration/README.md) — switch, ACL, snapshots, jobs, and security boundaries.
- [Platform architecture](../../../services/platform/ARCHITECTURE.md) — gateway, identity, runtime, and integration composition.
- [Slots reference](../../../docs/subsystems/slots.md) — slot declarations, inject face, and hook compartments.

-----

<a id="model-experience"></a>
## Model Experience

### Browser-only fusion chrome

#### What the model sees

Nothing. The workbench reads and writes `/api/integration/*` in the browser and registers no prompt section, tool, tool result, or Session event.

#### Token effect

None. The package issues no model request and adds no context to one.

#### KV Cache effect

None. Nothing this package registers can change a model request, so no cache entry depends on it.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No fusion API, no UI** — a deployment without the feature renders no launcher and makes no fusion request beyond the initial status read.
- **No model-side tools** — the workbench is a human surface; Agent tools for reading resources and running jobs are not part of this package.
- **No job streaming** — status changes appear after the user refreshes the row; the panel does not subscribe to server events.
- **Logical ids only** — the panel never displays or accepts a host path; workspace and artifact identities are platform-generated.

<a id="dev-note"></a>
### Dev Note

The panel is a human surface over the gateway API. The absence of Agent tools, server-sent job events, and a host path is intentional: those require separate capability assembly and are not hidden fallbacks in this package.
