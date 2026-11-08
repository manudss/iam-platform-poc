/** Refusing base of the connector.app slot (step 3): the slot always has a base, so with no provider plugin
 * enabled the core adapter fails CLOSED (PluginError no-provider) instead of serving a default engine.
 * Enabling a provider plugin (extends this base) chooses it as the slot's replacement. Engine slots serve
 * no bus hooks: the refusal is the adapter seeing a base manifest at resolution time. */
export default {};
