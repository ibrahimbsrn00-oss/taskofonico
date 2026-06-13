import React, { useEffect, useRef, useState } from 'react';
import { User } from 'firebase/auth';
import { collection, onSnapshot, query, where, doc, serverTimestamp, writeBatch } from 'firebase/firestore';
import { invoke } from '@tauri-apps/api/core';
import { initAuth, anonymousSignIn, logout, db } from '../lib/firebase';
import { appRuntime, preferencesStore, sessionStore } from '../lib/persistence';
import { Zap, Loader2, LogOut, ExternalLink, GripVertical, X, Bell, Palette, LayoutGrid, AtSign, ListTodo, CheckCheck, Soup, CalendarDays, MoonStar, SunMedium, Leaf, Waves, Flower2, Rocket } from 'lucide-react';


interface ExtractedTask {
  id?: string;
  taskName: string;
  projectName: string;
  mentionText: string;
  deadline: string | null;
  mentionAt?: string | null;
  completedAt?: string | null;
  unreadAt?: string | null;
  readAt?: string | null;
  unreadCount?: number;
  notificationSection?: string | null;
  readableSgid?: string | null;
  creatorName?: string | null;
  isCompleted?: boolean;
  category?: string;
  taskUrl?: string | null;
  userId?: string;
  updatedAt?: any;
}

interface PlatedTask extends ExtractedTask {
  plateOrder: number;
  sourceTaskKey: string;
  platedAt: string;
}

interface NotificationDebugInfo {
  source: string;
  unreads: number;
  reads: number;
  memories: number;
  fallbackRecordings: number;
  readingsPages: number;
  readingsTotal: number;
  mentionMatches: number;
}

type SyncMode = 'full' | 'activity';

interface FetchTasksOptions {
  includeCompleted?: boolean;
  includeMentions?: boolean;
  includeNotifications?: boolean;
  syncMode?: SyncMode;
  silent?: boolean;
}

interface FetchTasksResult {
  ok: boolean;
  authExpired?: boolean;
  retryAfterMs?: number;
}

const EMPTY_NOTIFICATION_DEBUG: NotificationDebugInfo = {
  source: 'debug_missing',
  unreads: 0,
  reads: 0,
  memories: 0,
  fallbackRecordings: 0,
  readingsPages: 0,
  readingsTotal: 0,
  mentionMatches: 0,
};

const AVAILABLE_THEMES = ['theme-light', 'theme-dark', 'theme-dawn', 'theme-forest', 'theme-ocean', 'theme-petal'] as const;
const DEFAULT_TAB_ORDER: Array<'all' | 'mentions' | 'ongoing' | 'completed' | 'plated' | 'today'> = [
  'all',
  'mentions',
  'ongoing',
  'completed',
  'plated',
  'today',
];

const TAB_META = {
  all: { label: 'Genel', icon: LayoutGrid },
  mentions: { label: 'Bahsetmeler', icon: AtSign },
  ongoing: { label: 'Devam Eden', icon: ListTodo },
  completed: { label: 'Tamamlanan', icon: CheckCheck },
  plated: { label: 'Tabaktakiler', icon: Soup },
  today: { label: 'Bugünkü', icon: CalendarDays },
} as const;

const THEME_OPTIONS = [
  { id: 'theme-dark', label: 'Gece', icon: MoonStar },
  { id: 'theme-dawn', label: 'Şafak', icon: Zap },
  { id: 'theme-forest', label: 'Orman', icon: Leaf },
  { id: 'theme-ocean', label: 'Okyanus', icon: Waves },
  { id: 'theme-light', label: 'Studio', icon: SunMedium },
  { id: 'theme-petal', label: 'Pembe', icon: Flower2 },
] as const;

const POLLING_INTERVALS = {
  activeActivityMs: 7000,
  activeFullMs: 15000,
  passiveActivityMs: 15000,
  passiveFullMs: 30000,
  errorBackoffMs: [30000, 60000, 120000],
} as const;

const MAX_SEEN_ACTIVITY_KEYS = 400;

export default function TasksDashboard() {
  const [needsAuth, setNeedsAuth] = useState(true);
  const [user, setUser] = useState<User | null>(null);
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [tasks, setTasks] = useState<ExtractedTask[]>([]);
  const [completedTasks, setCompletedTasks] = useState<ExtractedTask[]>([]);
  const [platedTasks, setPlatedTasks] = useState<PlatedTask[]>([]);
  const [mentionTasks, setMentionTasks] = useState<ExtractedTask[]>([]);
  const [notificationTasks, setNotificationTasks] = useState<ExtractedTask[]>([]);
  const [notificationDebug, setNotificationDebug] = useState<NotificationDebugInfo | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [statusText, setStatusText] = useState<string>('SİSTEM HAZIR.');
  const [hasInitialLoad, setHasInitialLoad] = useState(false);
  const [activeTab, setActiveTab] = useState<'all' | 'mentions' | 'ongoing' | 'completed' | 'plated' | 'today'>('all');
  const [tabOrder, setTabOrder] = useState(DEFAULT_TAB_ORDER);
  const [selectedProject, setSelectedProject] = useState('all');
  const [theme, setTheme] = useState(() => {
    const storedTheme = preferencesStore.getTheme('theme-light');
    return AVAILABLE_THEMES.includes(storedTheme as typeof AVAILABLE_THEMES[number])
      ? storedTheme
      : 'theme-light';
  });
  const [basecampUser, setBasecampUser] = useState<any>(null);
  const [draggedPlateTaskId, setDraggedPlateTaskId] = useState<string | null>(null);
  const [draggedTabId, setDraggedTabId] = useState<string | null>(null);
  const [tabDropTargetId, setTabDropTargetId] = useState<string | null>(null);
  const [isNotificationsOpen, setIsNotificationsOpen] = useState(false);
  const [launchAtLoginEnabled, setLaunchAtLoginEnabled] = useState(false);
  const [isAutostartPending, setIsAutostartPending] = useState(false);
  const [isWindowFocused, setIsWindowFocused] = useState(() =>
    typeof document !== 'undefined' ? document.hasFocus() : true
  );
  const isFetchingRef = useRef(false);
  const notificationsMenuRef = useRef<HTMLDivElement | null>(null);
  const pollingTimeoutRef = useRef<number | null>(null);
  const lastFullSyncAtRef = useRef(0);
  const pollingErrorCountRef = useRef(0);
  const hasPrimedActivityNotificationsRef = useRef(false);
  const seenActivityKeysRef = useRef<Set<string>>(
    new Set(preferencesStore.getSeenActivityKeys<string[]>([]))
  );

  const getTaskKey = (task: Pick<ExtractedTask, 'taskUrl' | 'projectName' | 'taskName'>) =>
    task.taskUrl ? task.taskUrl : `${task.projectName}::${task.taskName}`;

  const getTaskDocId = (uid: string, task: Pick<ExtractedTask, 'taskUrl' | 'projectName' | 'taskName'>) =>
    `${uid}_${encodeURIComponent(getTaskKey(task))}`;

  const getActivityKey = (task: Pick<ExtractedTask, 'taskUrl' | 'taskName' | 'projectName' | 'mentionAt' | 'category'>) =>
    [
      task.category || 'activity',
      task.taskUrl || '',
      task.taskName || '',
      task.projectName || '',
      task.mentionAt || '',
    ].join('::');

  const persistSeenActivityKeys = () => {
    const trimmedKeys = Array.from(seenActivityKeysRef.current).slice(-MAX_SEEN_ACTIVITY_KEYS);
    seenActivityKeysRef.current = new Set(trimmedKeys);
    preferencesStore.setSeenActivityKeys(trimmedKeys);
  };

  const canUseSystemNotifications = () =>
    typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'granted';

  const pushSystemNotification = (task: ExtractedTask) => {
    if (!canUseSystemNotifications()) return;

    const titlePrefix = task.category === 'mention' ? 'Yeni bahsetme' : 'Yeni bildirim';
    const bodyParts = [
      task.projectName || 'Bilinmeyen Proje',
      task.mentionText || task.taskName,
    ].filter(Boolean);

    const notification = new Notification(`${titlePrefix}: ${task.taskName}`, {
      body: bodyParts.join(' • '),
      tag: getActivityKey(task),
    });

    notification.onclick = () => {
      window.focus();
      if (task.taskUrl) {
        window.open(task.taskUrl, '_blank', 'noopener,noreferrer');
      }
      notification.close();
    };
  };

  const isTaskCompleted = (task: Partial<ExtractedTask>) => {
    const completedValue = task.isCompleted as unknown;
    if (completedValue === true) return true;
    if (completedValue == null) return false;
    return String(completedValue).toLowerCase() === 'true';
  };

  const parseDeadlineDate = (deadline: string | null) => {
    if (!deadline || deadline === 'null' || deadline.toLowerCase() === 'null') {
      return null;
    }

    const dateOnlyMatch = deadline.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (dateOnlyMatch) {
      const [, year, month, day] = dateOnlyMatch;
      return new Date(Number(year), Number(month) - 1, Number(day));
    }

    const parsed = new Date(deadline);
    if (Number.isNaN(parsed.getTime())) {
      return null;
    }

    return new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
  };

  const getTodayDate = () => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  };

  const getDeadlineTimestamp = (deadline: string | null) => {
    const parsed = parseDeadlineDate(deadline);
    return parsed ? parsed.getTime() : Number.POSITIVE_INFINITY;
  };

  const formatDeadlineDate = (date: Date) =>
    new Intl.DateTimeFormat('tr-TR', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    }).format(date);

  const sortPlatedTasks = (items: PlatedTask[]) => {
    items.sort((a, b) => {
      if (a.plateOrder !== b.plateOrder) {
        return a.plateOrder - b.plateOrder;
      }
      return a.taskName.localeCompare(b.taskName, 'tr');
    });
    return items;
  };

  const normalizePlateOrder = (items: PlatedTask[]) =>
    items.map((task, index) => ({
      ...task,
      plateOrder: index,
    }));

  const isTaskPlated = (task: Pick<ExtractedTask, 'taskUrl' | 'projectName' | 'taskName'>) =>
    platedTasks.some((platedTask) => platedTask.sourceTaskKey === getTaskKey(task));

  const buildPlatedTask = (task: ExtractedTask, order: number): PlatedTask => ({
    ...task,
    mentionText: task.mentionText || '',
    taskUrl: task.taskUrl || null,
    sourceTaskKey: getTaskKey(task),
    plateOrder: order,
    platedAt: new Date().toISOString(),
  });

  const sortByDeadline = (items: ExtractedTask[]) => {
    items.sort((a, b) => {
      const aComp = a.isCompleted ? 1 : 0;
      const bComp = b.isCompleted ? 1 : 0;
      if (aComp !== bComp) {
        return aComp - bComp;
      }
      return getDeadlineTimestamp(a.deadline) - getDeadlineTimestamp(b.deadline);
    });
    return items;
  };

  const sortByCompletedAt = (items: ExtractedTask[]) => {
    items.sort((a, b) => {
      const dateA = parseDeadlineDate(a.completedAt || null)?.getTime() || 0;
      const dateB = parseDeadlineDate(b.completedAt || null)?.getTime() || 0;
      return dateB - dateA;
    });
    return items;
  };

  const sortByMentionAt = (items: ExtractedTask[]) => {
    items.sort((a, b) => {
      const dateA = a.mentionAt ? new Date(a.mentionAt).getTime() : 0;
      const dateB = b.mentionAt ? new Date(b.mentionAt).getTime() : 0;
      return dateB - dateA;
    });
    return items.slice(0, 15);
  };

  const sortByActivityAt = (items: ExtractedTask[]) => {
    items.sort((a, b) => {
      const dateA = a.mentionAt ? new Date(a.mentionAt).getTime() : 0;
      const dateB = b.mentionAt ? new Date(b.mentionAt).getTime() : 0;
      return dateB - dateA;
    });
    return items.slice(0, 25);
  };

  const formatRelativeMentionTime = (value: string | null | undefined) => {
    if (!value) return 'Zaman bilgisi yok';

    const target = new Date(value);
    const targetTime = target.getTime();
    if (Number.isNaN(targetTime)) return 'Zaman bilgisi yok';

    const diffSeconds = Math.max(0, Math.floor((Date.now() - targetTime) / 1000));
    if (diffSeconds < 60) return `${diffSeconds} saniye once`;

    const diffMinutes = Math.floor(diffSeconds / 60);
    if (diffMinutes < 60) return `${diffMinutes} dakika once`;

    const diffHours = Math.floor(diffMinutes / 60);
    if (diffHours < 24) return `${diffHours} saat once`;

    const diffDays = Math.floor(diffHours / 24);
    if (diffDays < 30) return `${diffDays} gun once`;

    const diffMonths = Math.floor(diffDays / 30);
    if (diffMonths < 12) return `${diffMonths} ay once`;

    const diffYears = Math.floor(diffMonths / 12);
    return `${diffYears} yil once`;
  };

  const notificationsUnreadCount = notificationTasks.reduce((total, task) => {
    if (typeof task.unreadCount === 'number' && task.unreadCount > 0) {
      return total + task.unreadCount;
    }
    if (task.unreadAt && !task.readAt) {
      return total + 1;
    }
    return total;
  }, 0);

  const markNotificationAsReadLocally = (task: ExtractedTask) => {
    const taskKey = getTaskKey(task);
    const nowIso = new Date().toISOString();

    setNotificationTasks((currentTasks) =>
      currentTasks.map((currentTask) => {
        if (getTaskKey(currentTask) !== taskKey) return currentTask;
        return {
          ...currentTask,
          unreadCount: 0,
          unreadAt: null,
          readAt: currentTask.readAt || nowIso,
        };
      })
    );
  };

  const hasTaskChanged = (currentTask: ExtractedTask | undefined, nextTask: ExtractedTask) => {
    if (!currentTask) return true;

    return (
      currentTask.taskName !== nextTask.taskName ||
      currentTask.projectName !== nextTask.projectName ||
      currentTask.mentionText !== nextTask.mentionText ||
      currentTask.deadline !== nextTask.deadline ||
      currentTask.isCompleted !== nextTask.isCompleted ||
      currentTask.category !== nextTask.category ||
      currentTask.taskUrl !== nextTask.taskUrl
    );
  };

  const handlePlateTask = async (task: ExtractedTask) => {
    if (isTaskPlated(task)) {
      setStatusText('BU GÖREV ZATEN TABAKTA.');
      return;
    }

    const platedTask = buildPlatedTask(task, platedTasks.length);
    setPlatedTasks((prev) => sortPlatedTasks([...prev, platedTask]));
    setStatusText('GÖREV TABAĞA ALINDI.');
  };

  const handleRemoveFromPlate = async (task: PlatedTask) => {
    const nextPlatedTasks = normalizePlateOrder(
      platedTasks.filter((item) => item.sourceTaskKey !== task.sourceTaskKey)
    );

    setPlatedTasks(nextPlatedTasks);
    setStatusText('GÖREV TABAKTAN KALDIRILDI.');
  };

  const reorderPlatedTasks = async (sourceTaskId: string, targetTaskId: string) => {
    if (sourceTaskId === targetTaskId) return;

    const sourceIndex = platedTasks.findIndex((task) => task.sourceTaskKey === sourceTaskId);
    const targetIndex = platedTasks.findIndex((task) => task.sourceTaskKey === targetTaskId);
    if (sourceIndex === -1 || targetIndex === -1) return;

    const nextPlatedTasks = [...platedTasks];
    const [movedTask] = nextPlatedTasks.splice(sourceIndex, 1);
    nextPlatedTasks.splice(targetIndex, 0, movedTask);
    const normalizedTasks = normalizePlateOrder(nextPlatedTasks);
    setPlatedTasks(normalizedTasks);
    setDraggedPlateTaskId(null);
  };

  useEffect(() => {
    document.body.className = theme;
    preferencesStore.setTheme(theme);
  }, [theme]);

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      if (!notificationsMenuRef.current?.contains(event.target as Node)) {
        setIsNotificationsOpen(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, []);

  useEffect(() => {
    const syncFocusState = () => {
      setIsWindowFocused(document.hasFocus());
    };

    syncFocusState();
    window.addEventListener('focus', syncFocusState);
    window.addEventListener('blur', syncFocusState);
    document.addEventListener('visibilitychange', syncFocusState);

    return () => {
      window.removeEventListener('focus', syncFocusState);
      window.removeEventListener('blur', syncFocusState);
      document.removeEventListener('visibilitychange', syncFocusState);
    };
  }, []);

  useEffect(() => {
    const handleContextMenu = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      const selection = window.getSelection?.();
      const hasSelectedText = Boolean(selection && selection.toString().trim().length > 0);
      const isEditableTarget = Boolean(
        target?.closest('input, textarea, [contenteditable="true"], [contenteditable=""], [data-allow-context-menu="true"]')
      );

      if (!hasSelectedText && !isEditableTarget) {
        event.preventDefault();
      }
    };

    document.addEventListener('contextmenu', handleContextMenu);
    return () => document.removeEventListener('contextmenu', handleContextMenu);
  }, []);

  useEffect(() => {
    try {
      const parsed = preferencesStore.getTabOrder<unknown[]>([]);
      if (Array.isArray(parsed)) {
        const validTabs = parsed.filter(
          (tab): tab is typeof DEFAULT_TAB_ORDER[number] =>
            typeof tab === 'string' && DEFAULT_TAB_ORDER.includes(tab as typeof DEFAULT_TAB_ORDER[number])
        );
        const missingTabs = DEFAULT_TAB_ORDER.filter((tab) => !validTabs.includes(tab));
        setTabOrder([...validTabs, ...missingTabs]);
      }
    } catch (error) {
      console.error('Tab order read error:', error);
    }
  }, []);

  useEffect(() => {
    preferencesStore.setTabOrder(tabOrder);
  }, [tabOrder]);

  useEffect(() => {
    try {
      const parsed = preferencesStore.getPlatedTasks<unknown[]>([]);
      if (Array.isArray(parsed)) {
        setPlatedTasks(sortPlatedTasks(parsed as PlatedTask[]));
      }
    } catch (error) {
      console.error('Plate storage read error:', error);
    }
  }, []);

  useEffect(() => {
    try {
      preferencesStore.setPlatedTasks(platedTasks);
    } catch (error) {
      console.error('Plate storage write error:', error);
    }
  }, [platedTasks]);

  useEffect(() => {
    // Check for basecamp token in URL (OAuth fallback callback)
    const tokenFromUrl = sessionStore.consumeBasecampTokenFromUrl();
    
    if (tokenFromUrl) {
      setNeedsAuth(false);
      setStatusText(appRuntime.isTauriDesktop() ? 'MASAUSTU OTURUMU HAZIR.' : 'BAĞLANTI BAŞARILI!');
      setIsLoggingIn(false);
      // Auto sign in anonymously to firebase if not already
      anonymousSignIn().catch(console.error);
    }

    // Listen for messages from the OAuth popup
    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      
      if (event.data?.type === 'BASECAMP_AUTH_SUCCESS') {
        const token = event.data.token;
        sessionStore.setBasecampToken(token);
        setNeedsAuth(false);
        setStatusText('BAĞLANTI BAŞARILI!');
        setIsLoggingIn(false);
        anonymousSignIn().catch(console.error);
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  useEffect(() => {
    const unsubscribe = initAuth(
      (user) => {
        setUser(user);
        const hasToken = Boolean(sessionStore.getBasecampToken());
        if (hasToken) {
           setNeedsAuth(false);
           setStatusText(appRuntime.isTauriDesktop() ? 'MASAUSTU OTURUMU HAZIR.' : 'BAĞLANTI BAŞARILI!');
        } else {
           setNeedsAuth(true);
        }
      },
      () => {
        setUser(null);
        const hasToken = Boolean(sessionStore.getBasecampToken());
        if (hasToken) {
          setNeedsAuth(false);
          setStatusText('BASECAMP BAGLANTISI HAZIR. YEREL OTURUM SENKRONIZE EDILIYOR...');
          return;
        }

        setNeedsAuth(true);
        setStatusText('SİNYAL YOK. LÜTFEN GİRİŞ YAPIN.');
      }
    );
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (needsAuth || typeof window === 'undefined' || !('Notification' in window)) {
      return;
    }

    if (Notification.permission === 'default') {
      void Notification.requestPermission().catch((error) => {
        console.error('Notification permission error:', error);
      });
    }
  }, [needsAuth]);

  useEffect(() => {
    if (!appRuntime.isTauriDesktop()) return;

    void invoke<boolean>('get_launch_at_login_enabled')
      .then((enabled) => {
        setLaunchAtLoginEnabled(Boolean(enabled));
      })
      .catch((error) => {
        console.error('Autostart state read error:', error);
      });
  }, []);

  const fetchTasks = async ({
    includeCompleted = false,
    includeMentions = true,
    includeNotifications = true,
    syncMode = 'full',
    silent = false,
  }: FetchTasksOptions = {}): Promise<FetchTasksResult> => {
    const token = sessionStore.getBasecampToken();
    if (!token) {
      return { ok: false, authExpired: true };
    }
    if (isFetchingRef.current) {
      return { ok: true };
    }
    
    isFetchingRef.current = true;
    if (!silent) {
      setIsLoading(true);
      setStatusText(syncMode === 'activity' ? 'BILDIRIM AKISI GUNCELLENIYOR...' : 'BASECAMP VERİSİ ÇEKİLİYOR...');
    }

    try {
      const response = await fetch(`${apiBaseUrl}/api/basecamp/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accessToken: token, includeCompleted, includeMentions, includeNotifications, syncMode })
      });

      if (!response.ok) {
        if (response.status === 401) {
           // Token expired
           sessionStore.clearBasecampToken();
           setNeedsAuth(true);
           throw Object.assign(new Error('Oturum süresi doldu. Tekrar giriş yapın.'), { authExpired: true });
        }

        const retryAfterRaw = response.headers.get('Retry-After');
        const retryAfterMs = retryAfterRaw ? Number.parseInt(retryAfterRaw, 10) * 1000 : undefined;
        throw Object.assign(new Error('Basecamp verileri alınamadı.'), { retryAfterMs });
      }

      const data = await response.json();
      let extracted: ExtractedTask[] = (data.tasks || []).filter((task: ExtractedTask) => !isTaskCompleted(task));
      const recentCompleted: ExtractedTask[] = sortByCompletedAt(
        (data.completedTasks || []).filter((task: ExtractedTask) => isTaskCompleted(task))
      );
      const recentMentions: ExtractedTask[] = sortByMentionAt(
        (data.mentionTasks || []).filter((task: ExtractedTask) => task.category === 'mention')
      );
      const recentNotifications: ExtractedTask[] = sortByActivityAt(
        (data.notificationTasks || []).filter((task: ExtractedTask) => task.category === 'notification')
      );
      
      if (data.user) {
        setBasecampUser(data.user);
      }

      setMentionTasks(recentMentions);
      setNotificationTasks(recentNotifications);
      setNotificationDebug(data.notificationDebug || EMPTY_NOTIFICATION_DEBUG);

      if (syncMode === 'full') {
        setCompletedTasks(includeCompleted ? recentCompleted : []);
      }

      if (
        syncMode === 'full' &&
        extracted.length === 0 &&
        recentCompleted.length === 0 &&
        recentMentions.length === 0 &&
        recentNotifications.length === 0
      ) {
        setStatusText('YENİ BASECAMP VERİSİ BULUNAMADI.');
        return { ok: true };
      }

      if (syncMode === 'full' && user) {
        setStatusText('BASECAMP VERİSİ SENKRONİZE EDİLİYOR...');

        const existingTasks = new Map<string, ExtractedTask>(
          tasks.map((task) => [getTaskDocId(user.uid, task), task] as [string, ExtractedTask])
        );

        if (extracted.length > 0) {
          for (let i = 0; i < extracted.length; i += 500) {
            const batch = writeBatch(db);
            const chunk = extracted.slice(i, i + 500);

            for (const task of chunk) {
              const normalizedTask: ExtractedTask = {
                ...task,
                mentionText: task.mentionText || '',
                taskUrl: task.taskUrl || null,
                userId: user.uid,
                isCompleted: false,
              };

              const taskDocId = getTaskDocId(user.uid, normalizedTask);
              const existingTask = existingTasks.get(taskDocId);
              if (!hasTaskChanged(existingTask, normalizedTask)) {
                continue;
              }

              batch.set(doc(db, 'tasks', taskDocId), {
                ...normalizedTask,
                updatedAt: serverTimestamp(),
              }, { merge: true });
            }

            await batch.commit();
          }
        }

        setStatusText('SENKRONİZASYON TAMAMLANDI.');
      } else if (syncMode === 'full') {
        // Fallback to local state if Firebase Auth is not completed/failed
        const loadedTasks = extracted.map(t => ({
          ...t,
          isCompleted: false
        }));
        setTasks(sortByDeadline(loadedTasks));
        setStatusText(`SİSTEM AKTİF.`);
      }
      return { ok: true };
    } catch (err: any) {
      console.error(err);
      if (!silent) {
        setStatusText(`HATA: ${err.message?.toUpperCase()}`);
      }
      return {
        ok: false,
        authExpired: Boolean(err?.authExpired),
        retryAfterMs: typeof err?.retryAfterMs === 'number' ? err.retryAfterMs : undefined,
      };
    } finally {
      isFetchingRef.current = false;
      if (!silent) {
        setIsLoading(false);
      }
      if (syncMode === 'full') {
        setHasInitialLoad(true);
      }
    }
  };

  // 1. Sync tasks with Firestore if user is logged in
  useEffect(() => {
    if (!user || needsAuth) return;
    const q = query(collection(db, 'tasks'), where('userId', '==', user.uid));
    const unsub = onSnapshot(q, async (snapshot) => {
      const loadedTasks: ExtractedTask[] = [];
      const taskMap = new Map<string, ExtractedTask>();
      const completedDocs = snapshot.docs.filter((taskDoc) => {
        const task = taskDoc.data() as ExtractedTask;
        return isTaskCompleted(task);
      });

      if (completedDocs.length > 0) {
        const cleanupBatch = writeBatch(db);
        completedDocs.forEach((taskDoc) => cleanupBatch.delete(taskDoc.ref));
        await cleanupBatch.commit();
      }

      snapshot.forEach(doc => {
        const t = { id: doc.id, ...doc.data() } as ExtractedTask;
        if (isTaskCompleted(t)) return;
        const uniqueKey = getTaskKey(t);
        if (!taskMap.has(uniqueKey) || (t.updatedAt && taskMap.get(uniqueKey).updatedAt && t.updatedAt > taskMap.get(uniqueKey).updatedAt)) {
          taskMap.set(uniqueKey, t);
        }
      });
      loadedTasks.push(...Array.from(taskMap.values()));
      setTasks(sortByDeadline(loadedTasks));
    }, (error) => {
      console.error("Firestore read error:", error);
      setStatusText('ERR: FIRESTORE SYNC FAILED.');
    });
    
    return () => {
      unsub();
    };
  }, [user, needsAuth]);

  useEffect(() => {
    setSelectedProject('all');
  }, [activeTab]);

  useEffect(() => {
    if (needsAuth) {
      if (pollingTimeoutRef.current) {
        window.clearTimeout(pollingTimeoutRef.current);
        pollingTimeoutRef.current = null;
      }
      return;
    }

    let disposed = false;

    const scheduleNextPoll = (delayMs: number) => {
      if (disposed) return;
      if (pollingTimeoutRef.current) {
        window.clearTimeout(pollingTimeoutRef.current);
      }
      pollingTimeoutRef.current = window.setTimeout(runPollingCycle, delayMs);
    };

    const getPollingConfig = () => {
      const isAppActive = !document.hidden && isWindowFocused;
      return isAppActive
        ? {
            activityMs: POLLING_INTERVALS.activeActivityMs,
            fullMs: POLLING_INTERVALS.activeFullMs,
          }
        : {
            activityMs: POLLING_INTERVALS.passiveActivityMs,
            fullMs: POLLING_INTERVALS.passiveFullMs,
          };
    };

    const runPollingCycle = async () => {
      if (disposed) return;

      const { activityMs, fullMs } = getPollingConfig();
      const now = Date.now();
      const shouldRunFullSync = !hasInitialLoad || now - lastFullSyncAtRef.current >= fullMs;
      const result = await fetchTasks({
        includeCompleted: shouldRunFullSync && activeTab === 'completed',
        includeMentions: true,
        includeNotifications: true,
        syncMode: shouldRunFullSync ? 'full' : 'activity',
        silent: !shouldRunFullSync,
      });

      if (result.ok) {
        pollingErrorCountRef.current = 0;
        if (shouldRunFullSync) {
          lastFullSyncAtRef.current = Date.now();
        }
        scheduleNextPoll(activityMs);
        return;
      }

      if (result.authExpired) {
        return;
      }

      pollingErrorCountRef.current = Math.min(
        pollingErrorCountRef.current + 1,
        POLLING_INTERVALS.errorBackoffMs.length
      );
      const fallbackDelay =
        POLLING_INTERVALS.errorBackoffMs[pollingErrorCountRef.current - 1] ??
        POLLING_INTERVALS.errorBackoffMs[POLLING_INTERVALS.errorBackoffMs.length - 1];
      scheduleNextPoll(Math.max(activityMs, result.retryAfterMs ?? fallbackDelay));
    };

    void runPollingCycle();

    return () => {
      disposed = true;
      if (pollingTimeoutRef.current) {
        window.clearTimeout(pollingTimeoutRef.current);
        pollingTimeoutRef.current = null;
      }
    };
  }, [needsAuth, activeTab, isWindowFocused, hasInitialLoad]);

  useEffect(() => {
    if (needsAuth || !hasInitialLoad) return;

    const activityItems = [...mentionTasks, ...notificationTasks]
      .sort((a, b) => {
        const dateA = a.mentionAt ? new Date(a.mentionAt).getTime() : 0;
        const dateB = b.mentionAt ? new Date(b.mentionAt).getTime() : 0;
        return dateB - dateA;
      })
      .slice(0, 25);

    if (!hasPrimedActivityNotificationsRef.current) {
      activityItems.forEach((task) => {
        seenActivityKeysRef.current.add(getActivityKey(task));
      });
      persistSeenActivityKeys();
      hasPrimedActivityNotificationsRef.current = true;
      return;
    }

    const shouldPushSystemNotification = document.hidden || !isWindowFocused;
    const newItems = activityItems.filter((task) => {
      const activityKey = getActivityKey(task);
      if (seenActivityKeysRef.current.has(activityKey)) {
        return false;
      }

      seenActivityKeysRef.current.add(activityKey);
      return true;
    });

    if (newItems.length === 0) return;

    if (shouldPushSystemNotification) {
      newItems.slice(0, 3).forEach((task) => pushSystemNotification(task));
    }

    persistSeenActivityKeys();
  }, [needsAuth, hasInitialLoad, isWindowFocused, mentionTasks, notificationTasks]);

  const handleLogin = async () => {
    setIsLoggingIn(true);
    setStatusText(appRuntime.isBundledDesktop() ? 'BASECAMP GIRISI ACILIYOR...' : 'PENCERE BEKLENİYOR...');

    if (appRuntime.isBundledDesktop()) {
      const desktopReturnUrl = `${window.location.origin}${window.location.pathname}`;
      window.location.href = `${desktopBackendBaseUrl}/auth/basecamp?desktop_return=${encodeURIComponent(desktopReturnUrl)}`;
      return;
    }

    const width = 600;
    const height = 700;
    const left = window.innerWidth / 2 - width / 2 + window.screenX;
    const top = window.innerHeight / 2 - height / 2 + window.screenY;
    
    const popup = window.open('/auth/basecamp', 'BasecampOAuth', `width=${width},height=${height},left=${left},top=${top}`);
    
    if (!popup) {
      setStatusText('HATA: Lütfen açılır pencerelere (pop-up) izin verin.');
      setIsLoggingIn(false);
    }
  };

  const handleToggleLaunchAtLogin = async () => {
    if (!appRuntime.isTauriDesktop() || isAutostartPending) return;

    setIsAutostartPending(true);
    try {
      const nextValue = await invoke<boolean>('set_launch_at_login_enabled', {
        enabled: !launchAtLoginEnabled,
      });
      setLaunchAtLoginEnabled(Boolean(nextValue));
      setStatusText(
        nextValue ? 'TASKOFONICO GIRISTE OTOMATIK ACILACAK.' : 'TASKOFONICO GIRISTE OTOMATIK ACILMAYACAK.'
      );
    } catch (error) {
      console.error('Autostart toggle error:', error);
      setStatusText('HATA: OTOMATIK ACILIS GUNCELLENEMEDI.');
    } finally {
      setIsAutostartPending(false);
    }
  };

  const handleLogout = async () => {
    await logout();
    sessionStore.clearBasecampToken();
    setTasks([]);
    setCompletedTasks([]);
    setPlatedTasks([]);
    setMentionTasks([]);
    setNotificationTasks([]);
    setNotificationDebug(EMPTY_NOTIFICATION_DEBUG);
    setIsNotificationsOpen(false);
    setHasInitialLoad(false);
    lastFullSyncAtRef.current = 0;
    pollingErrorCountRef.current = 0;
    hasPrimedActivityNotificationsRef.current = false;
    setNeedsAuth(true);
  };

  const formatDeadline = (deadline: string | null) => {
    const parsedDeadline = parseDeadlineDate(deadline);
    if (!parsedDeadline) {
       return { text: 'Tarih atanmamış', overdue: false, dueDateText: null };
    }
    const today = getTodayDate();
    const diffTime = parsedDeadline.getTime() - today.getTime();
    const diffDays = Math.round(diffTime / (1000 * 60 * 60 * 24));
    const dueDateText = formatDeadlineDate(parsedDeadline);
    
    if (diffDays < 0) return { text: `${Math.abs(diffDays)} gün gecikti`, overdue: true, dueDateText };
    if (diffDays === 0) return { text: 'Bugün teslim edilecek', overdue: false, dueDateText };
    if (diffDays === 1) return { text: 'Yarın teslim edilecek', overdue: false, dueDateText };
    return { text: `${diffDays} gün kaldı`, overdue: false, dueDateText };
  };

  const sourceTasks = activeTab === 'completed'
    ? completedTasks
    : activeTab === 'mentions'
      ? mentionTasks
    : activeTab === 'plated'
      ? platedTasks
      : tasks;
  const projects = Array.from(new Set(sourceTasks.map(t => t.projectName))).filter(Boolean);

  const filteredTasks = sourceTasks.filter((task) => {
    if (selectedProject !== 'all' && task.projectName !== selectedProject) return false;
    
    if (activeTab === 'mentions') return task.category === 'mention';
    if (activeTab === 'completed') return isTaskCompleted(task);
    if (activeTab === 'plated') return true;
    if (activeTab === 'ongoing') return !isTaskCompleted(task) && task.category !== 'mention';
    if (activeTab === 'today') {
      const parsedDeadline = parseDeadlineDate(task.deadline);
      return parsedDeadline?.getTime() === getTodayDate().getTime();
    }
    return true; // 'all'
  });

  const emptyTabLabel = {
    all: 'Genel',
    mentions: 'Bahsetmeler',
    ongoing: 'Devam Eden',
    completed: 'Tamamlanan',
    plated: 'Tabaktakiler',
    today: 'Bugünkü',
  }[activeTab];

  const loginCatGifSrc = '/assets/login-cat.gif';
  const headerCatIconSrc = '/assets/header-cat.webp';
  const desktopBackendBaseUrl =
    (import.meta.env.VITE_DESKTOP_BACKEND_URL as string | undefined)?.replace(/\/$/, '') ||
    'https://taskofonico.onrender.com';
  const apiBaseUrl = appRuntime.isBundledDesktop() ? desktopBackendBaseUrl : '';
  const shouldShowInitialLoadingScreen =
    !needsAuth &&
    isLoading &&
    !hasInitialLoad &&
    tasks.length === 0 &&
    completedTasks.length === 0 &&
    mentionTasks.length === 0 &&
    notificationTasks.length === 0;

  const handleTabReorder = (sourceTabId: string, targetTabId: string) => {
    if (sourceTabId === targetTabId) return;
    const sourceIndex = tabOrder.indexOf(sourceTabId as typeof DEFAULT_TAB_ORDER[number]);
    const targetIndex = tabOrder.indexOf(targetTabId as typeof DEFAULT_TAB_ORDER[number]);
    if (sourceIndex === -1 || targetIndex === -1) return;

    const nextTabOrder = [...tabOrder];
    const [movedTab] = nextTabOrder.splice(sourceIndex, 1);
    nextTabOrder.splice(targetIndex, 0, movedTab);
    setTabOrder(nextTabOrder);
    setDraggedTabId(null);
    setTabDropTargetId(null);
  };

  if (needsAuth) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center p-6 bg-[var(--bg-main)]">
        <div className="card-bg border text-center flex flex-col items-center gap-6 shadow-xl relative overflow-hidden rounded-2xl p-8 max-w-md w-full">
          
          {/* Cute Decorative Stars background */}
          <div className="absolute top-4 left-4 text-yellow-300 animate-pulse text-2xl">✨</div>
          <div className="absolute top-12 right-6 text-pink-300 animate-pulse text-xl delay-150">✧</div>
          <div className="absolute bottom-6 left-8 text-[var(--accent)] animate-pulse text-lg delay-300">✦</div>
          <div className="absolute bottom-16 right-4 text-yellow-300 animate-pulse text-2xl delay-700">✨</div>

          <div className="relative z-10 flex flex-col items-center gap-3">
            <img
              src={loginCatGifSrc}
              alt="Taskofonico giris kedisi"
              className="w-56 max-w-full rounded-3xl border border-[var(--border-main)] bg-white/50 object-contain shadow-lg"
            />
            <div className="rounded-full border border-[var(--border-main)] bg-[var(--bg-main)] px-4 py-2 text-sm font-medium tracking-wide text-themed">
              {isLoggingIn ? 'iplik pesinde...' : 'giris icin bekliyor'}
            </div>
          </div>

          <h1 className="text-4xl sm:text-5xl font-bold text-themed mb-2 tracking-wide">
             Taskofonico
          </h1>
          
          <p className="text-lg text-muted font-medium px-2">
            Basecamp'e güvenle bağlan, tüm görevlerini otomatik olarak senkronize et ve kolayca takip et! 🚀
          </p>
          
          <div className="text-sm bg-[var(--bg-main)] px-4 py-2 rounded-full text-themed mt-2 font-medium tracking-wide border border-[var(--border-main)]">
            {statusText}
          </div>
          
          <button 
            onClick={handleLogin} 
            disabled={isLoggingIn}
            className="mt-4 bg-[var(--text-main)] hover:opacity-80 disabled:opacity-50 text-[var(--bg-main)] rounded-xl px-6 py-4 w-full flex items-center justify-center gap-3 text-xl font-semibold transition-opacity"
          >
            {isLoggingIn ? <Loader2 className="animate-spin" size={28} /> : <Zap size={28} className="fill-current" />}
            {isLoggingIn ? 'BEKLENİYOR...' : 'BASECAMP İLE BAĞLAN'}
          </button>
        </div>
      </div>
    );
  }

  if (shouldShowInitialLoadingScreen) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center p-6 bg-[var(--bg-main)]">
        <div className="loading-stage card-bg border text-center shadow-2xl rounded-[2rem] p-8 sm:p-10 max-w-2xl w-full overflow-hidden relative">
          <div className="loading-stage-glow" aria-hidden="true" />
          <div className="relative z-10 flex flex-col items-center gap-5">
            <div className="rounded-[2rem] border border-[var(--border-main)] bg-white/50 px-5 py-4 shadow-lg">
              <img
                src={loginCatGifSrc}
                alt="Taskofonico yukleme kedisi"
                className="w-48 sm:w-56 max-w-full object-contain"
              />
            </div>

            <div className="space-y-2">
              <div className="text-xs uppercase tracking-[0.35em] text-[var(--accent)]">
                Taskofonico hazirlaniyor
              </div>
              <h2 className="text-3xl sm:text-4xl font-bold text-themed">
                Gorevler sofraya diziliyor
              </h2>
              <p className="text-sm sm:text-base text-muted">
                Basecamp kayitlari okunuyor, kartlar hazirlaniyor ve bildirimler yerlesiyor.
              </p>
            </div>

            <div className="loading-bars w-full max-w-xl">
              <span />
              <span />
              <span />
            </div>

            <div className="inline-flex items-center gap-3 rounded-full border border-[var(--border-main)] bg-[var(--bg-main)] px-4 py-2 text-sm font-medium text-themed shadow-sm">
              <Loader2 size={16} className="animate-spin text-[var(--accent)]" />
              <span>{statusText}</span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell min-h-screen p-4 md:p-8 flex flex-col gap-8 max-w-6xl mx-auto text-base">
      <header className="card-bg app-panel relative z-30 rounded-[1.75rem] shadow-sm p-4 md:p-6 flex flex-col md:flex-row justify-between items-center gap-4">
        <div className="flex items-center gap-4">
           <img
             src={headerCatIconSrc}
             alt="Taskofonico kedi ikonu"
             className="h-12 w-12 shrink-0 rounded-2xl border border-[var(--border-main)] bg-[var(--bg-main)] p-2 object-contain shadow-sm"
           />
           <div>
             <h1 className="text-3xl font-bold text-themed flex items-center gap-3">
                Taskofonico
                <span className="inline-flex items-center rounded-full border border-[var(--border-main)] bg-[var(--bg-main)] px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.22em] text-[var(--accent)] shadow-sm">
                  Test Surumu
                </span>
             </h1>
             <p className="text-muted text-sm mt-1">Basecamp akisini sakin, hizli ve duzenli tutar.</p>
           </div>
        </div>
        <div className="flex items-center gap-4">
           <div className="text-right hidden md:block">
             <div className="text-xs text-muted font-semibold uppercase tracking-widest">Hoşgeldin,</div>
             <div className="text-themed text-xl font-bold">{basecampUser?.name || basecampUser?.first_name || user?.email?.split('@')[0] || "Kullanıcı"}</div>
             {basecampUser?.email_address && (
                <div className="text-xs text-muted mt-0.5">{basecampUser.email_address}</div>
             )}
           </div>
           
           {basecampUser?.avatar_url && (
             <img src={basecampUser.avatar_url} alt="Profile" className="w-12 h-12 rounded-full border-2 border-[var(--accent)] shadow-sm object-cover" referrerPolicy="no-referrer" />
           )}

           <div ref={notificationsMenuRef} className="relative">
             <button
               onClick={() => setIsNotificationsOpen((prev) => !prev)}
               className={`app-icon-button relative ${isNotificationsOpen ? 'app-icon-button-active' : ''}`}
               title="Bildirimler"
             >
               <Bell size={24} />
               {notificationsUnreadCount > 0 && (
                 <span className="absolute -right-1 -top-1 min-w-5 rounded-full bg-rose-600 px-1.5 py-0.5 text-[10px] font-bold leading-none text-white">
                   {notificationsUnreadCount > 99 ? '99+' : notificationsUnreadCount}
                 </span>
               )}
             </button>

             {isNotificationsOpen && (
               <div className="absolute right-0 top-full z-[70] mt-3 w-[min(26rem,85vw)] overflow-hidden rounded-2xl border border-[var(--border-main)] bg-[var(--bg-card)] shadow-xl">
                   <div className="flex items-center justify-between border-b border-[var(--border-main)] px-4 py-3">
                     <div>
                       <div className="text-sm font-bold text-themed">Bildirimler</div>
                       <div className="text-xs text-muted">Basecamp Hey menusuyle ayni resmi akistan gelir</div>
                     </div>
                   {notificationsUnreadCount > 0 && (
                     <span className="rounded-full bg-rose-600 px-2 py-1 text-[10px] font-bold leading-none text-white">
                       {notificationsUnreadCount > 99 ? '99+' : notificationsUnreadCount} yeni
                     </span>
                   )}
                 </div>

                 {notificationTasks.length > 0 ? (
                   <div className="max-h-[28rem] overflow-y-auto">
                     {notificationTasks.map((notificationTask) => (
                       <a
                         key={`${notificationTask.taskUrl || notificationTask.taskName}-${notificationTask.mentionAt || ''}`}
                         href={notificationTask.taskUrl || '#'}
                         target={notificationTask.taskUrl ? '_blank' : undefined}
                         rel={notificationTask.taskUrl ? 'noopener noreferrer' : undefined}
                         onClick={() => markNotificationAsReadLocally(notificationTask)}
                         className="block border-b border-[var(--border-main)] px-4 py-3 transition-colors hover:bg-[var(--bg-main)] last:border-b-0"
                       >
                         <div className="flex items-start justify-between gap-3">
                           <div className="min-w-0">
                             <div className="truncate text-sm font-semibold text-themed">
                               {notificationTask.taskName}
                             </div>
                             <div className="mt-1 truncate text-xs text-[var(--accent)]">
                               {notificationTask.projectName || 'Bilinmeyen Proje'}
                             </div>
                             {notificationTask.creatorName && (
                               <div className="mt-1 truncate text-[11px] text-muted">
                                 {notificationTask.creatorName}
                               </div>
                             )}
                           </div>
                           <div className="shrink-0 text-right">
                             {notificationTask.mentionAt && (
                               <div className="text-[11px] text-muted">
                                 {formatRelativeMentionTime(notificationTask.mentionAt)}
                               </div>
                             )}
                             {notificationTask.unreadCount && notificationTask.unreadCount > 0 && (
                               <div className="mt-1 rounded-full bg-rose-600 px-2 py-0.5 text-[10px] font-bold leading-none text-white">
                                 {notificationTask.unreadCount} okunmamis
                               </div>
                             )}
                           </div>
                         </div>
                         {notificationTask.mentionText && (
                           <div className="mt-2 line-clamp-3 text-sm text-muted">
                             {notificationTask.mentionText}
                           </div>
                         )}
                       </a>
                     ))}
                   </div>
                 ) : (
                   <div className="px-4 py-6 text-sm text-muted">
                    Basecamp resmi bildirim kutusundan kayit gelmedi. Bu, hesapta gorunen bildirim olmadigi ya da API'nin bu kullanici icin bos dondugu anlamina gelebilir.
                    <div className="mt-3 rounded-xl border border-[var(--border-main)] bg-[var(--bg-main)] px-3 py-2 text-xs">
                       kaynak: {(notificationDebug || EMPTY_NOTIFICATION_DEBUG).source} | sayfa: {(notificationDebug || EMPTY_NOTIFICATION_DEBUG).readingsPages} | toplam: {(notificationDebug || EMPTY_NOTIFICATION_DEBUG).readingsTotal} | mentions: {(notificationDebug || EMPTY_NOTIFICATION_DEBUG).mentionMatches} | unreads: {(notificationDebug || EMPTY_NOTIFICATION_DEBUG).unreads} | reads: {(notificationDebug || EMPTY_NOTIFICATION_DEBUG).reads} | memories: {(notificationDebug || EMPTY_NOTIFICATION_DEBUG).memories} | fallback recordings: {(notificationDebug || EMPTY_NOTIFICATION_DEBUG).fallbackRecordings}
                    </div>
                   </div>
                  )}
                </div>
             )}
           </div>
           
           <div className="relative group">
              <button className="app-icon-button" title="Tema Değiştir">
                <Palette size={22} />
              </button>
              <div className="absolute right-0 top-full z-[70] mt-2 w-56 card-bg border border-main rounded-2xl shadow-lg opacity-0 group-hover:opacity-100 transition-opacity overflow-hidden flex flex-col p-2">
                {THEME_OPTIONS.map((option) => {
                  const Icon = option.icon;
                  const isActive = theme === option.id;
                  return (
                    <button
                      key={option.id}
                      onClick={() => setTheme(option.id)}
                      className={`flex items-center gap-3 rounded-xl px-3 py-2 text-left text-sm transition-all ${isActive ? 'bg-[var(--accent)] text-white shadow-sm' : 'text-themed hover:bg-[var(--bg-main)]'}`}
                    >
                      <Icon size={16} />
                      <span>{option.label}</span>
                    </button>
                  );
                })}
                {appRuntime.isTauriDesktop() && (
                  <button
                    onClick={() => void handleToggleLaunchAtLogin()}
                    disabled={isAutostartPending}
                    className="mt-2 flex items-center justify-between rounded-xl border border-[var(--border-main)] px-3 py-2 text-left text-sm text-themed transition-all hover:bg-[var(--bg-main)] disabled:opacity-60"
                  >
                    <span className="flex items-center gap-3">
                      {isAutostartPending ? <Loader2 size={16} className="animate-spin" /> : <Rocket size={16} />}
                      <span>Acilista Baslat</span>
                    </span>
                    <span
                      className={`rounded-full px-2 py-1 text-[10px] font-bold uppercase tracking-[0.18em] ${
                        launchAtLoginEnabled
                          ? 'bg-emerald-500/15 text-emerald-600'
                          : 'bg-slate-500/15 text-muted'
                      }`}
                    >
                      {launchAtLoginEnabled ? 'Acik' : 'Kapali'}
                    </span>
                  </button>
                )}
              </div>
           </div>

           <button 
             onClick={handleLogout}
             className="app-icon-button"
             title="Çıkış Yap"
           >
             <LogOut size={24} />
           </button>
        </div>
      </header>

      <main className="relative z-10 flex-grow flex flex-col gap-6">
        <div className="flex flex-col md:flex-row justify-between items-center card-bg app-panel rounded-[1.5rem] shadow-sm p-3 gap-4">
          <div className="flex gap-2 text-sm sm:text-base overflow-x-auto whitespace-nowrap scrollbar-hide py-2 px-2 w-full">
            {tabOrder.map((tabId) => {
              const tabLabel = TAB_META[tabId].label;
              const TabIcon = TAB_META[tabId].icon;

              return (
                <button
                  key={tabId}
                  draggable
                  onDragStart={() => {
                    setDraggedTabId(tabId);
                    setTabDropTargetId(tabId);
                  }}
                  onDragEnter={() => {
                    if (draggedTabId && draggedTabId !== tabId) {
                      setTabDropTargetId(tabId);
                    }
                  }}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => {
                    event.preventDefault();
                    if (!draggedTabId) return;
                    handleTabReorder(draggedTabId, tabId);
                  }}
                  onDragEnd={() => {
                    setDraggedTabId(null);
                    setTabDropTargetId(null);
                  }}
                  onClick={() => setActiveTab(tabId)}
                  className={`tab-chip ${activeTab === tabId ? 'tab-chip-active' : 'tab-chip-idle'} ${draggedTabId === tabId ? 'tab-chip-dragging' : ''} ${tabDropTargetId === tabId && draggedTabId !== tabId ? 'tab-chip-target' : ''}`}
                >
                  <TabIcon size={15} />
                  {tabLabel}
                </button>
              );
            })}
          </div>
        </div>

        {projects.length > 0 && (
          <div className="flex gap-2 overflow-x-auto scrollbar-hide pb-2">
            <button
               onClick={() => setSelectedProject('all')}
               className={`px-3 py-1.5 rounded-full text-xs font-bold whitespace-nowrap transition-colors ${selectedProject === 'all' ? 'bg-[var(--accent)] text-white' : 'bg-transparent border border-main text-muted hover:border-[var(--accent)]'}`}
            >
               Tümü
            </button>
            {projects.map(proj => (
              <button
                 key={proj}
                 onClick={() => setSelectedProject(proj)}
                 className={`px-3 py-1.5 rounded-full text-xs font-bold whitespace-nowrap transition-colors ${selectedProject === proj ? 'bg-[var(--accent)] text-white' : 'bg-transparent border border-main text-muted hover:border-[var(--accent)]'}`}
              >
                 {proj}
              </button>
            ))}
          </div>
        )}

        {activeTab === 'completed' && (
          <div className="rounded-xl border border-[var(--border-main)] bg-[var(--bg-main)] px-4 py-3 text-sm text-muted">
            Not: Bu alanda yalnızca son 7 günde tamamlanan görevler gösterilir.
          </div>
        )}

        {activeTab === 'mentions' && (
          <div className="rounded-xl border border-[var(--border-main)] bg-[var(--bg-main)] px-4 py-3 text-sm text-muted">
            Not: Bu alanda `Mentioned in ...` tipindeki son 15 bahsedilme kaydi gosterilir; eski bahsetmeler de dahil olabilir.
          </div>
        )}

        {activeTab === 'plated' && (
          <div className="rounded-xl border border-[var(--border-main)] bg-[var(--bg-main)] px-4 py-3 text-sm text-muted">
            Not: Buradaki görevler Basecamp'ten silinmez. Kartları sürükleyip bırakarak sıralarını değiştirebilirsin.
          </div>
        )}

        {filteredTasks.length > 0 ? (
          <div className={activeTab === 'mentions' ? 'grid grid-cols-1 gap-4' : 'grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6'}>
            {filteredTasks.map((task, i) => {
              const deadlineInfo = formatDeadline(task.deadline);
              const taskKey = getTaskKey(task);
              const plated = isTaskPlated(task);
              const isPlateView = activeTab === 'plated';
              const isMentionCompactView = activeTab === 'mentions' && task.category === 'mention';

              if (isMentionCompactView) {
                return (
                  <div
                    key={taskKey}
                    className="card-bg border rounded-xl px-4 py-4 shadow-sm transition-all hover:shadow-md"
                  >
                    <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="rounded-full bg-pink-100 px-2.5 py-1 text-[11px] font-bold text-pink-700">
                            Bahsedildiniz
                          </span>
                          {task.mentionAt && (
                            <span className="text-xs font-medium text-muted">
                              {formatRelativeMentionTime(task.mentionAt)}
                            </span>
                          )}
                        </div>
                        <div className="mt-3 text-xs font-semibold uppercase tracking-[0.18em] text-[var(--accent)]">
                          {task.projectName || 'Bilinmeyen Proje'}
                        </div>
                        <div className={`mt-1 text-base font-bold leading-snug text-themed ${isTaskCompleted(task) ? 'line-through opacity-70' : ''}`}>
                          {task.taskName}
                        </div>
                        {task.mentionText && (
                          <div className="mt-2 line-clamp-2 text-sm text-muted">
                            {task.mentionText}
                          </div>
                        )}
                        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted">
                          <span>
                            {deadlineInfo.dueDateText ? `Due on: ${deadlineInfo.dueDateText}` : 'Due on: Tarih atanmamış'}
                          </span>
                          <span className={deadlineInfo.overdue ? 'font-semibold text-rose-600' : 'font-semibold text-themed'}>
                            {deadlineInfo.text}
                          </span>
                        </div>
                      </div>

                      <div className="flex shrink-0 flex-row items-center gap-2 md:w-48 md:flex-col md:items-end">
                        <button
                          onClick={() => void handlePlateTask(task)}
                          className={`flex items-center gap-2 rounded-full border border-[var(--border-main)] bg-[var(--bg-card)] px-3 py-1.5 text-xs font-semibold text-themed shadow-sm transition-all hover:border-[var(--accent)] hover:text-[var(--accent)] ${plated ? 'plate-action-active' : ''}`}
                          title={plated ? 'Bu görev zaten tabakta' : 'Tabağa Al'}
                        >
                          <span className="plate-icon" aria-hidden="true">
                            <span className="plate-icon-rim" />
                            <span className="plate-icon-core" />
                          </span>
                          <span>{plated ? 'Tabakta' : 'Tabağa Al'}</span>
                        </button>

                        {task.taskUrl ? (
                          <a
                            href={task.taskUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center justify-center gap-2 rounded-full border border-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-[var(--accent)] transition-colors hover:bg-[var(--accent)] hover:text-white"
                          >
                            <ExternalLink size={14} />
                            Göreve Git
                          </a>
                        ) : null}
                      </div>
                    </div>
                  </div>
                );
              }

              return (
              <div
                key={isPlateView ? taskKey : i}
                draggable={isPlateView}
                onDragStart={() => {
                  if (!isPlateView) return;
                  setDraggedPlateTaskId(taskKey);
                }}
                onDragOver={(event) => {
                  if (!isPlateView) return;
                  event.preventDefault();
                }}
                onDrop={(event) => {
                  if (!isPlateView || !draggedPlateTaskId) return;
                  event.preventDefault();
                  void reorderPlatedTasks(draggedPlateTaskId, taskKey);
                }}
                onDragEnd={() => setDraggedPlateTaskId(null)}
                className={`group relative card-bg border rounded-xl p-5 flex flex-col gap-3 shadow-sm hover:shadow-md transition-all ${isTaskCompleted(task) ? 'opacity-60 grayscale' : ''} ${draggedPlateTaskId === taskKey ? 'ring-2 ring-[var(--accent)]' : ''}`}
              >
                {!isPlateView && (
                  <button
                    onClick={() => void handlePlateTask(task)}
                    className={`plate-action-button absolute right-4 top-4 z-10 flex items-center gap-2 rounded-full border border-[var(--border-main)] bg-[var(--bg-card)] px-2 py-1 text-xs font-semibold text-themed shadow-sm opacity-0 transition-all duration-200 group-hover:opacity-100 ${plated ? 'plate-action-active' : ''}`}
                    title={plated ? 'Bu görev zaten tabakta' : 'Tabağa Al'}
                  >
                    <span className="plate-icon" aria-hidden="true">
                      <span className="plate-icon-rim" />
                      <span className="plate-icon-core" />
                    </span>
                    <span className="plate-action-label">
                      {plated ? 'Tabakta' : 'Tabağa Al'}
                    </span>
                  </button>
                )}

                {isPlateView && (
                  <div className="absolute right-4 top-4 z-10 flex items-center gap-2">
                    <div className="flex items-center gap-1 rounded-full border border-[var(--border-main)] bg-[var(--bg-card)] px-2 py-1 text-xs text-muted">
                      <GripVertical size={14} />
                      <span>Sırala</span>
                    </div>
                    <button
                      onClick={() => void handleRemoveFromPlate(task as PlatedTask)}
                      className="flex items-center gap-1 rounded-full border border-rose-200 bg-rose-50 px-2 py-1 text-xs font-semibold text-rose-600 transition-colors hover:bg-rose-100"
                      title="Tabaktan Kaldır"
                    >
                      <X size={14} />
                      <span>Tabaktan Kaldır</span>
                    </button>
                  </div>
                )}

                <div className="flex justify-between items-start">
                  <div className="flex flex-col gap-1 pr-4">
                    <div className="text-xs text-[var(--accent)] font-semibold uppercase tracking-wider">Proje / Liste</div>
                    <div className="font-bold text-lg text-themed leading-tight">{task.projectName || 'Bilinmiyor'}</div>
                  </div>
                  <div className="flex flex-col gap-2 items-end">
                    {task.category === 'mention' && (
                      <div className="text-xs bg-pink-100 text-pink-700 font-bold px-2 py-1 rounded-md">
                        Bahsedildiniz
                      </div>
                    )}
                    {task.category === 'notification' && (
                      <div className="text-xs bg-rose-100 text-rose-700 font-bold px-2 py-1 rounded-md">
                        Bildirim
                      </div>
                    )}
                    {task.category === 'mention' && task.mentionAt && (
                      <div className="text-xs text-muted font-medium">
                        {formatRelativeMentionTime(task.mentionAt)}
                      </div>
                    )}
                    {task.category === 'notification' && task.mentionAt && (
                      <div className="text-xs text-muted font-medium">
                        {formatRelativeMentionTime(task.mentionAt)}
                      </div>
                    )}
                  </div>
                </div>
                
                <div className="flex flex-col gap-1 mt-2">
                  <div className={`font-medium text-themed ${isTaskCompleted(task) ? 'line-through opacity-70' : ''}`}>{task.taskName}</div>
                </div>
                
                {task.mentionText && (
                  <div className="block mt-2 p-3 rounded-lg border card-bg opacity-90">
                    <div className="text-xs text-[var(--accent)] font-semibold mb-1">
                      {task.category === 'notification' ? 'Bildirim Detayı:' : 'Son Yorumlar:'}
                    </div>
                    <div className="text-sm text-muted italic">"{task.mentionText}"</div>
                  </div>
                )}
                
                <div className="mt-auto pt-4 flex flex-col gap-3 border-t border-[var(--border-main)]">
                  <div className="flex items-center justify-between">
                    <div className="flex flex-col gap-1">
                      {isPlateView && (task as PlatedTask).platedAt && (
                        <div className="text-xs uppercase tracking-wide text-muted">
                          Tabaga alindi: {formatDeadlineDate(parseDeadlineDate((task as PlatedTask).platedAt) || new Date((task as PlatedTask).platedAt))}
                        </div>
                      )}
                      {task.category === 'mention' && task.mentionAt && (
                        <div className="text-xs uppercase tracking-wide text-muted">
                          Bahsedilme: {formatRelativeMentionTime(task.mentionAt)}
                        </div>
                      )}
                      {task.category === 'notification' && task.mentionAt && (
                        <div className="text-xs uppercase tracking-wide text-muted">
                          Bildirim: {formatRelativeMentionTime(task.mentionAt)}
                        </div>
                      )}
                      <div className="text-xs uppercase tracking-wide text-muted">
                        {deadlineInfo.dueDateText ? `Due on: ${deadlineInfo.dueDateText}` : 'Due on: Tarih atanmamış'}
                      </div>
                      <div className={`flex items-center gap-2 font-semibold text-sm ${deadlineInfo.overdue ? 'text-rose-600' : 'text-themed'}`}>
                        {deadlineInfo.text}
                      </div>
                    </div>
                  </div>
                  {task.taskUrl ? (
                    <a 
                      href={task.taskUrl} 
                      target="_blank" 
                      rel="noopener noreferrer"
                      className="mt-3 flex items-center justify-center gap-2 w-full py-2.5 px-4 bg-transparent hover:bg-[var(--accent)] text-[var(--accent)] hover:text-white border border-[var(--accent)] transition-colors font-semibold rounded-lg"
                    >
                      <ExternalLink size={18} />
                      Göreve Git
                    </a>
                  ) : null}
                </div>
              </div>
            )})}
          </div>
        ) : (
          <div className="h-64 flex flex-col items-center justify-center card-bg rounded-xl border border-dashed border-[var(--border-main)]">
            <p className="text-xl text-muted font-medium">{activeTab === 'all' ? 'Henüz görev bulunmuyor.' : `${emptyTabLabel} kategorisinde kayıt yok.`}</p>
            <p className="text-sm text-muted mt-2">Görevleriniz otomatik olarak arka planda güncellenmektedir.</p>
            {activeTab === 'mentions' && (
              <div className="mt-3 rounded-xl border border-[var(--border-main)] bg-[var(--bg-main)] px-3 py-2 text-xs text-muted">
                Tanilama: kaynak {(notificationDebug || EMPTY_NOTIFICATION_DEBUG).source} | sayfa {(notificationDebug || EMPTY_NOTIFICATION_DEBUG).readingsPages} | toplam {(notificationDebug || EMPTY_NOTIFICATION_DEBUG).readingsTotal} | mention eslesmesi {(notificationDebug || EMPTY_NOTIFICATION_DEBUG).mentionMatches}
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
