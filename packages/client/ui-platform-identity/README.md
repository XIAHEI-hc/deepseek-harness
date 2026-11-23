---
description: "Web client plugin for the DSH multi-user platform: the sidebar platform identity entry and the personal-runtime start/failure overlay, kept separate from model-provider accounts."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-platform-identity

English | [中文](README.zh.md)

## Summary

The Web client adds two surfaces over the unchanged native DSH pages: an entry in the sidebar foot showing the signed-in platform user's display name, work id, and generated initial, and a full-viewport status card while the gateway prepares that user's personal DSH runtime. The entry offers a read-only account panel, the model-provider settings page, and platform sign-out. The platform identity comes from the gateway's `/auth/me`; the model-provider account surface is never read, reused, or represented as this identity. Without a platform gateway (`/auth/me` answers 404 or is unreachable), both surfaces render nothing and the native client is unchanged.

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

The plugin requires the `slots` and `locale` services. It contributes `settings.platform-launcher` (single, root) into the sidebar foot the settings shell renders, and `shell.overlay` into the application frame's overlay layer.

### The platform entry

The entry renders only while the platform user is signed in. It shows the W3 display name, the work id as `W3 · <uid>`, and a generated initial avatar; no third-party image source is read. The collapsed rail keeps the avatar alone with the user's name and work id as its accessible name.

The menu has three entries:

- **Account information** opens a read-only panel with the display name, work id, and W3 subject. The panel explains that this is the DSH platform identity and that model-provider accounts are managed separately.
- **Model provider settings** opens the settings panel on the `models` section through the shell's own navigation. A shell occupant that exposes no settings navigation falls back to the application root.
- **Sign out of DSH** revokes this browser's platform session and returns to `/login`. A failed request shows a toast and keeps the page as it was.

### Personal-runtime status

The gateway allocates one DSH runtime per platform user. The overlay blocks the native client until that runtime is ready and reports each outcome:

| Runtime state | Surface |
|---|---|
| `UNALLOCATED`, `STOPPED` | Requests the runtime, then polls |
| `PROVISIONING`, `STARTING`, `STOPPING` | "Preparing your personal workspace", polled every two seconds |
| `READY` | No overlay; the native client is fully interactive |
| `FAILED` | The gateway's error code and a retry action, disabled while the gateway reports `retryable: false` |
| Unreachable | A recheck action |

Polling stops after 60 checks and offers a recheck instead of waiting indefinitely.

### Sign-out and local state

Any 401 from a platform API clears the local identity and runtime state before returning to `/login?return_to=<current path>`, so the previous user's data cannot stay on screen. Sign-out itself reads the non-HttpOnly `dsh_csrf` cookie and sends it as `x-csrf-token`; the HttpOnly session cookie is only ever carried by the browser. Model-provider sign-out remains a separate action in the settings account menu and never touches this session.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Identity state machine

`src/client/state.ts` owns one controller per plugin body. It publishes a single snapshot holding the platform identity (`loading`, `ready`, `unauthorized`, `disabled`, `unavailable`) and the runtime view (`idle`, `checking`, `starting`, `failed`, `unavailable`, `ready`). Both surfaces read it through the `platformIdentity` hook compartment; the controller never creates a module-level singleton.

- `GET /auth/me` distinguishes 401 (session ended), 403 (account disabled), 404 and network failures (platform surface unavailable), and a malformed payload (also unavailable).
- After a ready identity, `GET /api/runtime/me` selects the runtime branch. `UNALLOCATED` and `STOPPED` first call `POST /api/runtime/wake`; startup states schedule the next check; `FAILED` records the gateway's `errorCode` and `retryable`.
- Mutating requests — wake, retry, sign-out — echo the `dsh_csrf` cookie in `x-csrf-token`; the reads carry no CSRF header.

The plugin disposes the controller, its timers, and its listeners with its Cordis fiber.

### Slot and layout ownership

The settings shell (`ui-settings-general`) declares and renders `settings.platform-launcher` above its own launcher row; this package waits for that declaration with `ctx.slots.inject`. The overlay is a list entry in `shell.overlay`, owned by the application frame (`ui-layout`), and portals its blocking card to the document body. Both contributions and the `platform` dictionaries are removed with the plugin fiber.

### Copy and styling

All visible copy lives in the `platform` dictionaries (zh/en plus ja, es, fr, de, ru, pt) and reaches components through the standard `t` seat. Styles are CSS Modules over the shared `--dsw-*` aliases; the overlay keeps the native client mounted underneath and is the only blocking surface this package paints.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [ui-settings-general](../ui-settings-general/README.md) — the settings shell that declares the platform launcher seat.
- [ui-layout](../ui-layout/README.md) — the application frame that owns the shell overlay layer.
- [Slots reference](../../../docs/subsystems/slots.md) — slot declarations, inject face, and hook compartments.
- [Platform service architecture](../../../services/platform/ARCHITECTURE.md) — the gateway's identity and runtime API this package consumes.

-----

<a id="model-experience"></a>
## Model Experience

### Browser-only platform chrome

#### What the model sees

Nothing. The launcher and the runtime overlay read `/auth/me` and `/api/runtime/*` in the browser and register no prompt section, tool, tool result, or Session event.

#### Token effect

None. The package issues no model request and adds no context to one.

#### KV Cache effect

None. Nothing this package registers can change a model request, so no cache entry depends on it.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define the current platform UI contract.

- **No platform gateway, no identity UI** — `/auth/me` answering 404 or failing leaves the native DSH client exactly as it was; the platform entry is intentionally absent rather than an error row.
- **The account panel is read-only** — profile editing, session listing, and "sign out of all devices" belong to the platform service and are not offered here.
- **Runtime recovery is bounded per page** — polling stops after 60 two-second checks; a runtime that never settles needs the recheck action or a page reload.
- **Model-provider accounts are separate by design** — this package never reads the DeepSeek account, balance, or model sign-in state, and the model-provider menu remains the only place those actions live.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The gateway contract is documented in `services/platform/ARCHITECTURE.md`; the browser never sees runtime ports or paths. The overlay's blocking card does not trap keyboard focus, matching the native client's non-modal status behavior.

</details>
