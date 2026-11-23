/**
 * Platform identity plugin, node half.
 *
 * Platform sign-in belongs to the gateway in front of the DSH runtime; the
 * browser half contributes the identity entry and the runtime status overlay
 * into the native client shell. This half registers nothing on the Host.
 */

/** Host plugin body — platform identity is a browser-side capability. */
export function apply(): void {}
