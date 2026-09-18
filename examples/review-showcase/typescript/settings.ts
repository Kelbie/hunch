// Settings are saved as JSON and loaded back into the same Map by `loadSettings`.
export function saveSettings(store: Storage, prefs: Map<string, boolean>) {
  store.setItem("prefs", JSON.stringify(prefs));
}

export function loadSettings(store: Storage): Map<string, boolean> {
  return new Map(Object.entries(JSON.parse(store.getItem("prefs") ?? "{}")));
}

// `lastSync` is compared with Date.now() to decide whether to sync again.
export function saveSyncState(store: Storage, state: { lastSync: Date }) {
  store.setItem("sync", JSON.stringify(state));
}

export function needsSync(store: Storage): boolean {
  const state = JSON.parse(store.getItem("sync") ?? "{}") as { lastSync: Date };
  return Date.now() - state.lastSync.getTime() > 60_000;
}

export async function syncSettings(userId: string) {
  const client = new SettingsClient(process.env.SETTINGS_URL!, process.env.SETTINGS_TOKEN!);
  const store = new BrowserStorage(window.localStorage);
  return client.push(userId, loadSettings(store));
}

declare class SettingsClient { constructor(url: string, token: string); push(user: string, prefs: Map<string, boolean>): Promise<void> }
declare class BrowserStorage implements Storage { constructor(s: Storage); [k: string]: any }
