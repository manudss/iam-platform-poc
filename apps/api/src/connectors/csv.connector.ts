import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { defaultPluginsDir } from '../plugins/v1/loader.js';

/** Core adapter of the `csv-connector` plugin: the parsing rules live in the plugin folder. */
export interface ImportRow { identity: string; displayName: string; manager: string | null; department: string; role: string }
interface CsvPluginModule { parseCsv: (text: string) => string[][]; csvToRows: (text: string) => ImportRow[] }
const plugin = createRequire(import.meta.url)(resolve(defaultPluginsDir(), 'csv-connector', 'handlers.mjs')) as CsvPluginModule;

/** Minimal RFC 4180 parser (quotes, doubled quotes, CRLF). */
export const parseCsv = plugin.parseCsv;
/** HR-style CSV connector: header identity_id,display_name,manager_id,department,role_id. Strict validation, fictional data only. */
export const csvToRows = plugin.csvToRows;
