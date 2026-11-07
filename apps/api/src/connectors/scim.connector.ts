import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import type { ImportRow } from './csv.connector.js';
import { defaultPluginsDir } from '../plugins/v1/loader.js';

/**
 * Core adapter of the `scim-connector` plugin: SCIM 2.0-LIKE subset (NOT a SCIM server). The mapping rules
 * live in the plugin folder.
 */
interface ScimPluginModule { scimToRows: (body: unknown) => { rows: ImportRow[]; skipped: number } }
const plugin = createRequire(import.meta.url)(resolve(defaultPluginsDir(), 'scim-connector', 'handlers.mjs')) as ScimPluginModule;

export const scimToRows = plugin.scimToRows;
