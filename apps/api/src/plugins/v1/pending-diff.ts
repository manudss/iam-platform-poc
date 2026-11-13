/**
 * Pure diff between two plugin-registry snapshots (typically the work branch
 * and main) plus their settings, used by GET /v1/plugins/pending to list what
 * is modified on the branch but not yet published on main.
 */
export type PendingChangeKind = 'install' | 'uninstall' | 'enable' | 'disable' | 'settings';

export interface PendingChange {
  id: string;
  name: string;
  kind: PendingChangeKind;
  detail?: string;
}

export interface RegistrySnapshotEntry {
  id: string;
  name: string;
  enabled: boolean;
  installed?: boolean;
}

/** A plugin counts as changed on the branch when its version or enabled state differs from main. */
export function pluginChanges(
  work: RegistrySnapshotEntry[],
  main: RegistrySnapshotEntry[],
  workSettings: Record<string, Record<string, string>> = {},
  mainSettings: Record<string, Record<string, string>> = {},
): PendingChange[] {
  const byId = new Map(main.map((p) => [p.id, p]));
  const workIds = new Set(work.map((p) => p.id));
  const out: PendingChange[] = [];
  for (const p of work) {
    if (p.installed === false) continue;
    const m = byId.get(p.id);
    if (!m || m.installed === false) {
      out.push({ id: p.id, name: p.name, kind: 'install', detail: 'Installé sur la branche, absent de main' });
      continue;
    }
    if (p.enabled !== m.enabled) {
      out.push({ id: p.id, name: p.name, kind: p.enabled ? 'enable' : 'disable', detail: p.enabled ? 'Activé sur la branche' : 'Désactivé sur la branche' });
    }
    const ws = workSettings[p.id] ?? {};
    const ms = mainSettings[p.id] ?? {};
    const changed = Object.keys({ ...ws, ...ms }).filter((k) => (ws[k] ?? '') !== (ms[k] ?? ''));
    if (changed.length) {
      out.push({ id: p.id, name: p.name, kind: 'settings', detail: `Réglages modifiés: ${changed.join(', ')}` });
    }
  }
  for (const m of main) {
    if (m.installed === false) continue;
    const w = work.find((p) => p.id === m.id);
    if (!w || w.installed === false || !workIds.has(m.id)) {
      out.push({ id: m.id, name: m.name, kind: 'uninstall', detail: 'Désinstallé sur la branche, encore présent sur main' });
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id) || a.kind.localeCompare(b.kind));
}
