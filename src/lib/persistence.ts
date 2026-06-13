const DESKTOP_STORE_PATH = 'taskofonico-store.json';

const isBrowserRuntime = () => typeof window !== 'undefined';

const getBrowserStorage = () => {
  if (!isBrowserRuntime()) return null;

  try {
    return window.localStorage;
  } catch (error) {
    console.error('Storage access error:', error);
    return null;
  }
};

type DesktopStoreLike = {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  save(): Promise<void>;
};

const invokeDesktopCommand = async <T>(command: string, args?: Record<string, unknown>): Promise<T | null> => {
  if (!appRuntime.isTauriDesktop()) return null;

  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<T>(command, args);
  } catch (error) {
    console.error(`Desktop command failed: ${command}`, error);
    return null;
  }
};

const loadDesktopBasecampToken = async () => {
  const value = await invokeDesktopCommand<string | null>('load_basecamp_token');
  return typeof value === 'string' && value.length > 0 ? value : null;
};

const saveDesktopBasecampToken = async (token: string) => {
  await invokeDesktopCommand('save_basecamp_token', { token });
};

const clearDesktopBasecampToken = async () => {
  await invokeDesktopCommand('clear_basecamp_token');
};

let desktopStorePromise: Promise<DesktopStoreLike | null> | null = null;

export const storageKeys = {
  theme: 'app-theme',
  basecampToken: 'basecamp_token',
  tabOrder: 'taskofonico-tab-order',
  platedTasks: 'taskofonico-plated-tasks',
  seenActivityKeys: 'taskofonico-seen-activity-keys',
} as const;

const synchronizableKeys = [
  storageKeys.theme,
  storageKeys.tabOrder,
  storageKeys.platedTasks,
  storageKeys.seenActivityKeys,
];

export const appRuntime = {
  isTauriDesktop() {
    if (!isBrowserRuntime()) return false;
    return Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
  },

  isBundledDesktop() {
    if (!isBrowserRuntime()) return false;
    return this.isTauriDesktop() && !/^https?:$/i.test(window.location.protocol);
  },
};

const getDesktopStore = async (): Promise<DesktopStoreLike | null> => {
  if (!appRuntime.isTauriDesktop()) return null;
  if (!desktopStorePromise) {
    desktopStorePromise = import('@tauri-apps/plugin-store')
      .then(({ LazyStore }) => new LazyStore(DESKTOP_STORE_PATH, { defaults: {}, autoSave: 100 }))
      .catch((error) => {
        console.error('Desktop store init error:', error);
        return null;
      });
  }

  return desktopStorePromise;
};

const syncKeyToDesktopStore = async (key: string, value: string | null) => {
  const store = await getDesktopStore();
  if (!store) return;

  try {
    if (value == null) {
      await store.delete(key);
    } else {
      await store.set(key, value);
    }
    await store.save();
  } catch (error) {
    console.error(`Desktop store sync error for ${key}:`, error);
  }
};

export const bootstrapPersistence = async () => {
  const browserStorage = getBrowserStorage();
  if (!browserStorage || !appRuntime.isTauriDesktop()) return;

  const store = await getDesktopStore();
  if (!store) return;

  const keychainToken = await loadDesktopBasecampToken();
  const browserToken = browserStorage.getItem(storageKeys.basecampToken);

  if (keychainToken) {
    browserStorage.setItem(storageKeys.basecampToken, keychainToken);
  } else if (browserToken != null) {
    await saveDesktopBasecampToken(browserToken);
  }

  await store.delete(storageKeys.basecampToken).catch(() => false);

  await Promise.all(
    synchronizableKeys.map(async (key) => {
      const desktopValue = await store.get<string>(key);
      const browserValue = browserStorage.getItem(key);

      if (typeof desktopValue === 'string') {
        browserStorage.setItem(key, desktopValue);
        return;
      }

      if (browserValue != null) {
        await store.set(key, browserValue);
      }
    })
  );

  await store.save();
};

export const persistence = {
  getString(key: string): string | null {
    return getBrowserStorage()?.getItem(key) ?? null;
  },

  setString(key: string, value: string) {
    getBrowserStorage()?.setItem(key, value);
    void syncKeyToDesktopStore(key, value);
  },

  remove(key: string) {
    getBrowserStorage()?.removeItem(key);
    void syncKeyToDesktopStore(key, null);
  },

  getJson<T>(key: string, fallback: T): T {
    const rawValue = this.getString(key);
    if (!rawValue) return fallback;

    try {
      return JSON.parse(rawValue) as T;
    } catch (error) {
      console.error(`Storage parse error for ${key}:`, error);
      return fallback;
    }
  },

  setJson<T>(key: string, value: T) {
    this.setString(key, JSON.stringify(value));
  },
};

export const sessionStore = {
  getBasecampToken() {
    return persistence.getString(storageKeys.basecampToken);
  },

  setBasecampToken(token: string) {
    persistence.setString(storageKeys.basecampToken, token);
    void saveDesktopBasecampToken(token);
  },

  clearBasecampToken() {
    persistence.remove(storageKeys.basecampToken);
    void clearDesktopBasecampToken();
  },

  consumeBasecampTokenFromUrl() {
    if (!isBrowserRuntime()) return null;

    const searchParams = new URLSearchParams(window.location.search);
    const hashValue = window.location.hash.startsWith('#')
      ? window.location.hash.slice(1)
      : window.location.hash;
    const normalizedHash = hashValue.startsWith('?') ? hashValue.slice(1) : hashValue;
    const hashParams = new URLSearchParams(normalizedHash);
    const token = searchParams.get('basecamp_token') || hashParams.get('basecamp_token');
    if (!token) return null;

    this.setBasecampToken(token);
    window.history.replaceState({}, document.title, window.location.pathname);
    return token;
  },
};

export const preferencesStore = {
  getTheme<T extends string>(fallback: T) {
    return persistence.getString(storageKeys.theme) ?? fallback;
  },

  setTheme(theme: string) {
    persistence.setString(storageKeys.theme, theme);
  },

  getTabOrder<T>(fallback: T) {
    return persistence.getJson(storageKeys.tabOrder, fallback);
  },

  setTabOrder<T>(value: T) {
    persistence.setJson(storageKeys.tabOrder, value);
  },

  getPlatedTasks<T>(fallback: T) {
    return persistence.getJson(storageKeys.platedTasks, fallback);
  },

  setPlatedTasks<T>(value: T) {
    persistence.setJson(storageKeys.platedTasks, value);
  },

  getSeenActivityKeys<T>(fallback: T) {
    return persistence.getJson(storageKeys.seenActivityKeys, fallback);
  },

  setSeenActivityKeys<T>(value: T) {
    persistence.setJson(storageKeys.seenActivityKeys, value);
  },
};
