import type { ImportRow } from './csv.connector.js';
import { loadPluginModule } from '../plugins/v1/loader.js';

/**
 * Core adapter of the `scim-connector` plugin: SCIM 2.0-LIKE subset (NOT a SCIM server). The mapping rules
 * live in the plugin folder.
 */
interface ScimPluginModule { scimToRows: (body: unknown) => { rows: ImportRow[]; skipped: number } }
const plugin = loadPluginModule('scim-connector', 'handlers.mjs') as ScimPluginModule;

export const scimToRows = plugin.scimToRows;
