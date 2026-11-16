/**
 * Skills plaza plugin, node half. Pure UI plugin: the empty apply exists so the
 * plugin appears in the Web profile's Loader roster; the browser half ships via
 * `exports["./client"]`, discovered through the `dsh.client` declaration.
 */

/** Host plugin body — no host-side behavior for this Client plugin. */
export function apply(): void {}
