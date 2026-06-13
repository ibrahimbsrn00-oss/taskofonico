import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
const PORT = 3000;
const APP_BUILD_VERSION = process.env.RENDER_GIT_COMMIT || process.env.APP_BUILD_VERSION || "local";

const BASECAMP_CLIENT_ID = process.env.BASECAMP_CLIENT_ID;
const BASECAMP_CLIENT_SECRET = process.env.BASECAMP_CLIENT_SECRET;
const AUTH_CACHE_TTL_MS = 10 * 60 * 1000;
const PROFILE_CACHE_TTL_MS = 5 * 60 * 1000;

let APP_URL = `http://localhost:${PORT}`;
if (process.env.APP_URL) {
  APP_URL = process.env.APP_URL.replace(/\/$/, '');
} else if (process.env.NODE_ENV === 'production' || process.env.RENDER) {
  APP_URL = 'https://taskofonico.onrender.com';
}

const REDIRECT_URI = `${APP_URL}/auth/basecamp/callback`;

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    appUrl: APP_URL,
    version: APP_BUILD_VERSION,
    desktopAuthBridgeEnabled: true,
    timestamp: new Date().toISOString(),
  });
});

const stripHtml = (value: unknown) => {
  if (typeof value !== "string" || !value) return "";

  return value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
};

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const buildUserMentionMatchers = (userProfile: any, identity: any) => {
  const rawCandidates = [
    userProfile?.name,
    userProfile?.first_name,
    identity?.name,
    identity?.first_name,
    identity?.email_address,
    identity?.email,
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);

  const normalizedCandidates = Array.from(
    new Set(
      rawCandidates.flatMap((value) => {
        const trimmed = value.trim();
        const emailLocalPart = trimmed.includes("@") ? trimmed.split("@")[0] : null;
        return [trimmed, emailLocalPart].filter(
          (item): item is string => Boolean(item && item.trim().length >= 3)
        );
      })
    )
  );

  return normalizedCandidates.map((candidate) => {
    const escaped = escapeRegex(candidate.toLocaleLowerCase("tr-TR"));
    return new RegExp(`(^|[^\\p{L}\\p{N}_])@?${escaped}([^\\p{L}\\p{N}_]|$)`, "iu");
  });
};

const textMentionsUser = (text: string, mentionMatchers: RegExp[]) => {
  if (!text.trim()) return false;
  const normalizedText = text.toLocaleLowerCase("tr-TR");
  return mentionMatchers.some((matcher) => matcher.test(normalizedText));
};

const getCommentText = (comment: any) =>
  stripHtml(
    comment?.content ||
      comment?.body ||
      comment?.description ||
      comment?.summary ||
      comment?.title ||
      ""
  );

const getItemActivityDate = (item: any) =>
  item?.updated_at || item?.created_at || item?.completed_at || item?.completed_on || item?.date || null;

const getNotificationActivityDate = (item: any) =>
  item?.unread_at || item?.read_at || item?.updated_at || item?.created_at || null;

const isMentionReading = (item: any) => {
  const title = typeof item?.title === "string" ? item.title.trim().toLocaleLowerCase("en-US") : "";
  return title.includes("mentioned in") || item?.section === "mentions";
};

const flattenReadingItems = (payload: { unreads?: any[]; reads?: any[]; memories?: any[] } | null | undefined) =>
  payload ? [...(payload.unreads || []), ...(payload.reads || []), ...(payload.memories || [])] : [];

const mergeReadingPayloads = (payloads: Array<{ unreads?: any[]; reads?: any[]; memories?: any[] }>) => ({
  unreads: payloads.flatMap((payload) => payload.unreads || []),
  reads: payloads.flatMap((payload) => payload.reads || []),
  memories: payloads.flatMap((payload) => payload.memories || []),
});

type CacheEntry<T> = {
  expiresAt: number;
  value: T;
};

type BasecampAuthContext = {
  authData: any;
  identity: any;
  apiBaseUrl: string;
};

const authContextCache = new Map<string, CacheEntry<BasecampAuthContext>>();
const profileCache = new Map<string, CacheEntry<any>>();

const getCachedValue = <T>(cache: Map<string, CacheEntry<T>>, key: string) => {
  const entry = cache.get(key);
  if (!entry) return null;

  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }

  return entry.value;
};

const setCachedValue = <T>(cache: Map<string, CacheEntry<T>>, key: string, value: T, ttlMs: number) => {
  cache.set(key, {
    expiresAt: Date.now() + ttlMs,
    value,
  });
};

const getBasecampAuthContext = async (accessToken: string) => {
  const cachedContext = getCachedValue(authContextCache, accessToken);
  if (cachedContext) {
    return cachedContext;
  }

  const authRes = await fetch("https://launchpad.37signals.com/authorization.json", {
    headers: { "Authorization": `Bearer ${accessToken}` }
  });

  if (!authRes.ok) {
    throw new Error("Failed to get Basecamp identity");
  }

  const authData = await authRes.json();
  const identity = authData.identity || {};
  const bc3Account = authData.accounts.find((act: any) => act.product === "bc3");

  if (!bc3Account) {
    throw new Error("No Basecamp 3 account found.");
  }

  const apiBaseUrl = typeof bc3Account.href === "string" && bc3Account.href.includes("basecampapi.com")
    ? bc3Account.href.replace(/\/$/, "")
    : `https://3.basecampapi.com/${bc3Account.id}`;

  const context = {
    authData,
    identity,
    apiBaseUrl,
  };

  setCachedValue(authContextCache, accessToken, context, AUTH_CACHE_TTL_MS);
  return context;
};

const resolveDesktopReturnUrl = (value: unknown) => {
  if (typeof value !== "string" || !value.trim()) return null;

  try {
    const parsed = new URL(value);
    const allowedProtocols = new Set(["http:", "https:", "tauri:"]);
    if (!allowedProtocols.has(parsed.protocol)) return null;
    return parsed;
  } catch {
    return null;
  }
};

const buildOAuthReturnUrl = (desktopReturnUrl: URL | null, accessToken: string) => {
  if (!desktopReturnUrl) {
    return `/?basecamp_token=${encodeURIComponent(accessToken)}`;
  }

  const normalizedBase = desktopReturnUrl.toString().replace(/\/$/, "");
  const encodedToken = encodeURIComponent(accessToken);

  if (desktopReturnUrl.protocol === "tauri:") {
    return `${normalizedBase}/#basecamp_token=${encodedToken}`;
  }

  return `${normalizedBase}/?basecamp_token=${encodedToken}`;
};

app.get('/auth/basecamp', (req, res) => {
  if (!BASECAMP_CLIENT_ID) {
    return res.status(500).send("BASECAMP_CLIENT_ID is not configured in environment variables.");
  }
  const desktopReturnUrl = resolveDesktopReturnUrl(req.query.desktop_return);
  const stateParam = desktopReturnUrl ? `&state=${encodeURIComponent(desktopReturnUrl.toString())}` : "";
  const authUrl = `https://launchpad.37signals.com/authorization/new?type=web_server&client_id=${BASECAMP_CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}${stateParam}`;
  res.redirect(authUrl);
});

app.get('/auth/basecamp/callback', async (req, res) => {
  if (!BASECAMP_CLIENT_ID || !BASECAMP_CLIENT_SECRET) {
    return res.status(500).send("Basecamp credentials are not fully configured in environment variables.");
  }

  const code = req.query.code as string;
  const desktopReturnUrl = resolveDesktopReturnUrl(req.query.state);
  if (!code) {
    return res.status(400).send("No code provided by Basecamp.");
  }
  
  try {
    const tokenResponse = await fetch(`https://launchpad.37signals.com/authorization/token?type=web_server&client_id=${BASECAMP_CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&client_secret=${BASECAMP_CLIENT_SECRET}&code=${code}`, {
      method: 'POST'
    });
    
    if (!tokenResponse.ok) {
       const text = await tokenResponse.text();
       throw new Error(`Token request failed: ${text}`);
    }
    
    const data = await tokenResponse.json();
    const accessToken = data.access_token;
    const returnUrl = buildOAuthReturnUrl(desktopReturnUrl, accessToken);
    const serializedAccessToken = JSON.stringify(accessToken);
    const serializedReturnUrl = JSON.stringify(returnUrl);
    
    // Return HTML to post message to main window and close popup
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Bağlantı Başarılı</title>
        <style>
          body { font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; background: #f8fafc; color: #0f172a; margin: 0; }
          .card { background: white; padding: 2rem; border-radius: 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); text-align: center; }
          h2 { margin-top: 0; }
        </style>
      </head>
      <body>
        <div class="card">
          <h2>Bağlantı Başarılı! 🎉</h2>
          <p>Yönlendiriliyorsunuz, bu pencere otomatik olarak kapanacak...</p>
        </div>
        <script>
          if (window.opener) {
            window.opener.postMessage({ type: 'BASECAMP_AUTH_SUCCESS', token: ${serializedAccessToken} }, '*');
            setTimeout(function() { window.close(); }, 100);
          } else {
            // Fallback if not opened in a popup
            window.location.replace(${serializedReturnUrl});
          }
        </script>
      </body>
      </html>
    `;
    res.send(html);
  } catch (error: any) {
    console.error("Basecamp Callback Error:", error);
    res.status(500).send("Error during Basecamp authentication: " + error.message);
  }
});

app.post("/api/basecamp/tasks", async (req, res) => {
  try {
    const {
      accessToken,
      includeCompleted,
      includeMentions,
      includeNotifications,
      syncMode = "full",
    } = req.body;
    if (!accessToken) {
      return res.status(401).json({ error: "Missing Basecamp access token" });
    }

    const activityOnly = syncMode === "activity";
    const { identity, apiBaseUrl } = await getBasecampAuthContext(accessToken);
    const userAgent = "Taskofonico (taskofonico@example.com)";
    
    const headers = {
      "Authorization": `Bearer ${accessToken}`,
      "User-Agent": userAgent
    };

    const parseApiDate = (value: unknown) => {
      if (typeof value !== "string" || !value) return null;
      const parsed = new Date(value);
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    };

    const getCompletedAtValue = (item: any) =>
      item?.completed_at || item?.completed_on || item?.updated_at || item?.updated_on || null;

    const completedCutoff = new Date();
    completedCutoff.setHours(0, 0, 0, 0);
    completedCutoff.setDate(completedCutoff.getDate() - 6);
    const shouldFetchCompletedAssignments = !activityOnly && Boolean(includeCompleted || includeMentions || includeNotifications);
    const shouldFetchReadings = Boolean(includeMentions || includeNotifications);
    const shouldFetchProfile = !activityOnly || !getCachedValue(profileCache, accessToken);

    // 2. Fetch profile and active assignments in parallel
    let userProfile: any = getCachedValue(profileCache, accessToken);
    let activeAssignments: any[] = [];
    let completedAssignments: any[] = [];
    let allCompletedAssignments: any[] = [];
    let notificationsPayload: { unreads?: any[]; reads?: any[]; memories?: any[] } | null = null;
    const notificationDebug = {
      source: "none",
      unreads: 0,
      reads: 0,
      memories: 0,
      fallbackRecordings: 0,
      readingsPages: 0,
      readingsTotal: 0,
      mentionMatches: 0,
    };

    try {
      const profileRequest = shouldFetchProfile
        ? fetch(`${apiBaseUrl}/my/profile.json`, { headers }).catch(err => {
            console.error("Profile fetch error:", err);
            return null;
          })
        : Promise.resolve(null);
      const assignmentsRequest = activityOnly
        ? Promise.resolve(null)
        : fetch(`${apiBaseUrl}/my/assignments.json`, { headers }).catch(err => {
            console.error("Active assignments fetch error:", err);
            return null;
          });
      const completedAssignmentsRequest = shouldFetchCompletedAssignments
        ? fetch(`${apiBaseUrl}/my/assignments/completed.json`, { headers }).catch(err => {
            console.error("Completed assignments fetch error:", err);
            return null;
          })
        : Promise.resolve(null);
      const readingsRequest = shouldFetchReadings
        ? fetch(`${apiBaseUrl}/my/readings.json`, { headers }).catch(err => {
            console.error("Notifications fetch error:", err);
            return null;
          })
        : Promise.resolve(null);

      const [profileRes, assignRes, completedAssignRes, notificationsRes] = await Promise.all([
        profileRequest,
        assignmentsRequest,
        completedAssignmentsRequest,
        readingsRequest,
      ]);

      // Parse user profile
      if (profileRes && profileRes.ok) {
        userProfile = await profileRes.json().catch(() => null);
        if (userProfile) {
          setCachedValue(profileCache, accessToken, userProfile, PROFILE_CACHE_TTL_MS);
        }
      }

      // Parse active assignments
      if (!activityOnly && assignRes && assignRes.ok) {
        const assignmentsData = await assignRes.json().catch(() => null);
        if (assignmentsData) {
          const priorities = assignmentsData.priorities || [];
          const nonPriorities = assignmentsData.non_priorities || [];
          activeAssignments = [...priorities, ...nonPriorities];
        }
      }

      if (shouldFetchCompletedAssignments && completedAssignRes && completedAssignRes.ok) {
        const completedData = await completedAssignRes.json().catch(() => null);
        if (Array.isArray(completedData)) {
          allCompletedAssignments = completedData;
          completedAssignments = completedData.filter((item: any) => {
            const completedAt = parseApiDate(getCompletedAtValue(item));
            return completedAt ? completedAt >= completedCutoff : false;
          });
        }
      }

      if (shouldFetchReadings && notificationsRes && notificationsRes.ok) {
        const firstPage = await notificationsRes.json().catch(() => null);
        if (firstPage) {
          const readingPages: Array<{ unreads?: any[]; reads?: any[]; memories?: any[] }> = [firstPage];
          const maxReadingPages = 8;
          const minNotificationItems = includeNotifications ? 25 : 0;
          const minMentionItems = includeMentions ? 15 : 0;

          let aggregatedReadings = flattenReadingItems(firstPage);
          let mentionMatchCount = aggregatedReadings.filter(isMentionReading).length;

          for (let page = 2; page <= maxReadingPages; page += 1) {
            const hasEnoughNotifications = aggregatedReadings.length >= minNotificationItems;
            const hasEnoughMentions = mentionMatchCount >= minMentionItems;
            if (hasEnoughNotifications && hasEnoughMentions) {
              break;
            }

            const pageResponse = await fetch(`${apiBaseUrl}/my/readings.json?page=${page}`, { headers }).catch(err => {
              console.error(`Notifications page ${page} fetch error:`, err);
              return null;
            });

            if (!pageResponse || !pageResponse.ok) {
              break;
            }

            const pagePayload = await pageResponse.json().catch(() => null);
            if (!pagePayload) {
              break;
            }

            const pageItems = flattenReadingItems(pagePayload);
            if (pageItems.length === 0) {
              break;
            }

            readingPages.push(pagePayload);
            aggregatedReadings = aggregatedReadings.concat(pageItems);
            mentionMatchCount = aggregatedReadings.filter(isMentionReading).length;
          }

          notificationsPayload = mergeReadingPayloads(readingPages);
          notificationDebug.readingsPages = readingPages.length;
          notificationDebug.readingsTotal = aggregatedReadings.length;
    notificationDebug.mentionMatches = mentionMatchCount;
        }
      }

      if (notificationsPayload) {
        notificationDebug.unreads = Array.isArray(notificationsPayload.unreads) ? notificationsPayload.unreads.length : 0;
        notificationDebug.reads = Array.isArray(notificationsPayload.reads) ? notificationsPayload.reads.length : 0;
        notificationDebug.memories = Array.isArray(notificationsPayload.memories) ? notificationsPayload.memories.length : 0;
        notificationDebug.source = "readings";
      }
    } catch (parallelErr) {
      console.error("Parallel fetch failed:", parallelErr);
    }

    // Fallback if profile fetch failed or returned invalid data
    if (!userProfile || !userProfile.name) {
      const firstName = identity.first_name || "";
      const lastName = identity.last_name || "";
      userProfile = {
        ...identity,
        name: userProfile?.name || `${firstName} ${lastName}`.trim() || "Kullanıcı",
        avatar_url: userProfile?.avatar_url || null
      };
    }

    const mentionMatchers = buildUserMentionMatchers(userProfile, identity);

    const rawActiveTasks = activeAssignments.map((item: any) => ({
      taskName: item.content || item.title || "Bilinmeyen Görev",
      projectName: item.bucket?.name || item.project?.name || "Bilinmeyen Proje",
      mentionText: stripHtml(item.description || ""),
      deadline: item.due_on || null,
      isCompleted: false,
      category: "task",
      taskUrl: item.app_url || item.url || null,
    }));

    const mentionTaskMap = new Map<string, any>();
    const fallbackMentionTaskMap = new Map<string, any>();
    const notificationTaskMap = new Map<string, any>();
    const registerMentionTask = (task: any, useFallback: boolean = false) => {
      const mentionText = stripHtml(task.mentionText || "");
      if (!mentionText) return;

      const mentionAt = task.mentionAt || null;
      const dedupeKey = [
        task.taskUrl || "",
        task.taskName || "",
        task.projectName || "",
        mentionAt || "",
        mentionText,
      ].join("::");

      const targetMap = useFallback ? fallbackMentionTaskMap : mentionTaskMap;
      if (targetMap.has(dedupeKey)) return;
      targetMap.set(dedupeKey, {
        ...task,
        mentionText,
        mentionAt,
      });
    };

    const registerNotificationTask = (task: any) => {
      const messageText = stripHtml(task.mentionText || "");
      const activityAt = task.mentionAt || task.completedAt || null;
      if (!messageText || !activityAt) return;

      const dedupeKey = [
        task.taskUrl || "",
        task.taskName || "",
        task.projectName || "",
        task.category || "notification",
        activityAt,
        messageText,
      ].join("::");

      if (notificationTaskMap.has(dedupeKey)) return;
      notificationTaskMap.set(dedupeKey, {
        ...task,
        mentionText: messageText,
        mentionAt: activityAt,
      });
    };

    for (const item of [...activeAssignments, ...allCompletedAssignments]) {
      const descriptionText = stripHtml(item?.description || "");
      if (includeNotifications && descriptionText) {
        registerNotificationTask({
          taskName: item.content || item.title || "Bilinmeyen Görev",
          projectName: item.bucket?.name || item.project?.name || "Bilinmeyen Proje",
          mentionText: descriptionText,
          deadline: item.due_on || null,
          isCompleted: false,
          category: "notification",
          taskUrl: item.app_url || item.url || null,
          mentionAt: getItemActivityDate(item),
        });
      }

      if (!descriptionText || !textMentionsUser(descriptionText, mentionMatchers)) continue;

      registerMentionTask({
        taskName: item.content || item.title || "Bilinmeyen Görev",
        projectName: item.bucket?.name || item.project?.name || "Bilinmeyen Proje",
        mentionText: descriptionText,
        deadline: item.due_on || null,
        isCompleted: false,
        category: "mention",
        taskUrl: item.app_url || item.url || null,
        mentionAt: item.updated_at || item.created_at || item.completed_at || item.completed_on || item.date || null,
      });

      registerMentionTask({
        taskName: item.content || item.title || "Bilinmeyen Görev",
        projectName: item.bucket?.name || item.project?.name || "Bilinmeyen Proje",
        mentionText: descriptionText,
        deadline: item.due_on || null,
        isCompleted: false,
        category: "mention",
        taskUrl: item.app_url || item.url || null,
        mentionAt: item.updated_at || item.created_at || item.completed_at || item.completed_on || item.date || null,
      }, true);
    }

    if (includeNotifications && !notificationsPayload) {
      completedAssignments.forEach((item: any) => {
        registerNotificationTask({
          taskName: item.content || item.title || "Bilinmeyen Görev",
          projectName: item.bucket?.name || item.project?.name || "Bilinmeyen Proje",
          mentionText: "Görev tamamlandı.",
          deadline: item.due_on || null,
          isCompleted: true,
          category: "notification",
          taskUrl: item.app_url || item.url || null,
          mentionAt: getCompletedAtValue(item),
        });
      });
    }

    if ((includeMentions || includeNotifications) && !notificationsPayload && !activityOnly) {
      const commentCandidates = [...activeAssignments, ...allCompletedAssignments]
        .filter((item: any) => item?.url || item?.comments_url || item?.parent?.url)
        .sort((a: any, b: any) => {
          const dateA = new Date(getItemActivityDate(a) || 0).getTime();
          const dateB = new Date(getItemActivityDate(b) || 0).getTime();
          return dateB - dateA;
        })
        .slice(0, 30);

      const detailCache = new Map<string, any>();
      const loadItemDetail = async (item: any) => {
        const detailUrl = item?.url || item?.parent?.url;
        if (!detailUrl) return null;
        if (detailCache.has(detailUrl)) return detailCache.get(detailUrl);

        try {
          const response = await fetch(detailUrl, { headers });
          if (!response.ok) {
            detailCache.set(detailUrl, null);
            return null;
          }
          const payload = await response.json().catch(() => null);
          detailCache.set(detailUrl, payload);
          return payload;
        } catch (error) {
          console.error("Detail fetch error:", error);
          detailCache.set(detailUrl, null);
          return null;
        }
      };

      const mentionTargetReached = () => !includeMentions || mentionTaskMap.size >= 10;
      const notificationTargetReached = () => !includeNotifications || notificationTaskMap.size >= 25;

      for (
        let i = 0;
        i < commentCandidates.length && (!mentionTargetReached() || !notificationTargetReached());
        i += 8
      ) {
        const batch = commentCandidates.slice(i, i + 8);
        const detailResults = await Promise.all(batch.map((item: any) => loadItemDetail(item)));

        detailResults.forEach((detail, index) => {
          if (!detail) return;

          const item = batch[index];
          const detailText = stripHtml(
            detail?.description || detail?.content || detail?.body || detail?.summary || ""
          );
          if (!detailText) return;

          const detailPayload = {
            taskName: detail?.title || detail?.content || item.content || item.title || "Bilinmeyen Görev",
            projectName: item.bucket?.name || item.project?.name || detail?.bucket?.name || detail?.parent?.title || "Bilinmeyen Proje",
            mentionText: detailText,
            deadline: detail?.due_on || item.due_on || null,
            isCompleted: false,
            category: "mention",
            taskUrl: detail?.app_url || item.app_url || item.url || null,
            mentionAt: getItemActivityDate(detail) || getItemActivityDate(item),
          };

          if (includeMentions && textMentionsUser(detailText, mentionMatchers)) {
            registerMentionTask(detailPayload);
          }
          if (includeMentions) {
            registerMentionTask(detailPayload, true);
          }
          if (includeNotifications) {
            registerNotificationTask({
              ...detailPayload,
              category: "notification",
            });
          }
        });

        const commentResponses = await Promise.allSettled(
          batch.map(async (item: any) => {
            const detail = await loadItemDetail(item);
            const commentsUrl =
              item.comments_url ||
              detail?.comments_url ||
              item?.parent?.comments_url ||
              detail?.parent?.comments_url;

            if (!commentsUrl) return [];

            const response = await fetch(commentsUrl, { headers });
            if (!response.ok) return [];
            const payload = await response.json().catch(() => []);
            return Array.isArray(payload) ? payload : [];
          })
        );

        commentResponses.forEach((result, index) => {
          if (result.status !== "fulfilled") return;

          const item = batch[index];
          for (const comment of result.value) {
            const commentText = getCommentText(comment);
            if (!commentText) continue;

            const mentionPayload = {
              taskName: item.content || item.title || "Bilinmeyen Görev",
              projectName: item.bucket?.name || item.project?.name || "Bilinmeyen Proje",
              mentionText: commentText,
              deadline: item.due_on || null,
              isCompleted: false,
              category: "mention",
              taskUrl: comment.app_url || item.app_url || item.url || null,
              mentionAt: comment.updated_at || comment.created_at || item.updated_at || item.created_at || null,
            };

            if (includeMentions && textMentionsUser(commentText, mentionMatchers)) {
              registerMentionTask(mentionPayload);
            }

            if (includeMentions) {
              registerMentionTask(mentionPayload, true);
            }
            if (includeNotifications) {
              registerNotificationTask({
                ...mentionPayload,
                category: "notification",
              });
            }
          }
        });
      }
    }

    const primaryMentionTasks = Array.from(mentionTaskMap.values());
    const mentionSource = primaryMentionTasks.length > 0
      ? primaryMentionTasks
      : Array.from(fallbackMentionTaskMap.values());

    const officialReadings = notificationsPayload
      ? [...(notificationsPayload.unreads || []), ...(notificationsPayload.reads || []), ...(notificationsPayload.memories || [])]
      : [];

    let recordingsFallback: any[] = [];
    if ((includeMentions || includeNotifications) && officialReadings.length === 0 && !activityOnly) {
      const recordingTypes = ["Comment", "Message", "Todo"];
      const recordingResponses = await Promise.allSettled(
        recordingTypes.map(async (type) => {
          const response = await fetch(
            `${apiBaseUrl}/projects/recordings.json?type=${encodeURIComponent(type)}&sort=updated_at&direction=desc`,
            { headers }
          );
          if (!response.ok) return [];
          const payload = await response.json().catch(() => []);
          return Array.isArray(payload) ? payload : [];
        })
      );

      recordingsFallback = recordingResponses.flatMap((result) =>
        result.status === "fulfilled" ? result.value : []
      );

      notificationDebug.fallbackRecordings = recordingsFallback.length;
      if (recordingsFallback.length > 0) {
        notificationDebug.source = "recordings_fallback";
      }
    }

    const matchesOfficialMention = (item: any) => {
      const title = stripHtml(item?.title || "");
      const excerpt = stripHtml(item?.content_excerpt || "");
      const readableIdentifier = typeof item?.readable_identifier === "string"
        ? item.readable_identifier.toLocaleLowerCase("en-US")
        : "";
      const combinedText = `${title}\n${excerpt}`.trim();

      return (
        isMentionReading(item) ||
        readableIdentifier.includes("mention") ||
        (combinedText.length > 0 && textMentionsUser(combinedText, mentionMatchers))
      );
    };

    const officialMentionTasks = officialReadings
      .filter((item: any) => matchesOfficialMention(item))
      .map((item: any) => ({
        taskName: item.title || item.readable_identifier || "Bilinmeyen Bahsetme",
        projectName: item.bucket_name || "Bilinmeyen Proje",
        mentionText: stripHtml(item.content_excerpt || ""),
        deadline: null,
        isCompleted: false,
        category: "mention",
        taskUrl: item.app_url || null,
        mentionAt: getNotificationActivityDate(item),
        unreadAt: item.unread_at || null,
        readAt: item.read_at || null,
        unreadCount: typeof item.unread_count === "number" ? item.unread_count : 0,
        notificationSection: item.section || null,
        readableSgid: item.readable_sgid || null,
        creatorName: item.creator?.name || null,
      }))
      .sort((a: any, b: any) => {
        const dateA = a.mentionAt ? new Date(a.mentionAt).getTime() : 0;
        const dateB = b.mentionAt ? new Date(b.mentionAt).getTime() : 0;
        return dateB - dateA;
      })
      .slice(0, 15);

    notificationDebug.mentionMatches = officialMentionTasks.length;

    const recordingsMentionTasks = recordingsFallback
      .map((item: any) => ({
        taskName: item.title || item.readable_identifier || item.content || "Bilinmeyen Bahsetme",
        projectName: item.bucket?.name || item.bucket_name || "Bilinmeyen Proje",
        mentionText: stripHtml(item.content || item.description || item.content_excerpt || item.summary || item.title || ""),
        deadline: null,
        isCompleted: false,
        category: "mention",
        taskUrl: item.app_url || null,
        mentionAt: item.updated_at || item.created_at || null,
        creatorName: item.creator?.name || null,
      }))
      .filter((item: any) => item.mentionText && textMentionsUser(item.mentionText, mentionMatchers))
      .sort((a: any, b: any) => {
        const dateA = a.mentionAt ? new Date(a.mentionAt).getTime() : 0;
        const dateB = b.mentionAt ? new Date(b.mentionAt).getTime() : 0;
        return dateB - dateA;
      })
      .slice(0, 15);

    const mentionTasks = officialMentionTasks.length > 0
      ? officialMentionTasks
      : recordingsMentionTasks.length > 0
        ? recordingsMentionTasks
      : mentionSource
          .sort((a: any, b: any) => {
            const dateA = a.mentionAt ? new Date(a.mentionAt).getTime() : 0;
            const dateB = b.mentionAt ? new Date(b.mentionAt).getTime() : 0;
            return dateB - dateA;
          })
          .slice(0, 15);

    const rawCompletedTasks = completedAssignments.map((item: any) => ({
      taskName: item.content || item.title || "Bilinmeyen Görev",
      projectName: item.bucket?.name || item.project?.name || "Bilinmeyen Proje",
      mentionText: stripHtml(item.description || ""),
      deadline: item.due_on || null,
      isCompleted: true,
      category: "completed",
      taskUrl: item.app_url || item.url || null,
      completedAt: getCompletedAtValue(item),
    }));

    const recordingsNotificationTasks = recordingsFallback
      .map((item: any) => ({
        taskName: item.title || item.readable_identifier || item.content || "Bilinmeyen Bildirim",
        projectName: item.bucket?.name || item.bucket_name || "Bilinmeyen Proje",
        mentionText: stripHtml(item.content || item.description || item.content_excerpt || item.summary || ""),
        deadline: null,
        isCompleted: false,
        category: "notification",
        taskUrl: item.app_url || null,
        mentionAt: item.updated_at || item.created_at || null,
        creatorName: item.creator?.name || null,
      }))
      .filter((item: any) => item.taskName || item.mentionText)
      .sort((a: any, b: any) => {
        const dateA = a.mentionAt ? new Date(a.mentionAt).getTime() : 0;
        const dateB = b.mentionAt ? new Date(b.mentionAt).getTime() : 0;
        return dateB - dateA;
      })
      .slice(0, 25);

    const notificationTasks = includeNotifications && officialReadings.length > 0
      ? officialReadings
          .map((item: any) => ({
            taskName: item.title || item.readable_identifier || "Bilinmeyen Bildirim",
            projectName: item.bucket_name || "Bilinmeyen Proje",
            mentionText: stripHtml(item.content_excerpt || ""),
            deadline: null,
            isCompleted: false,
            category: "notification",
            taskUrl: item.app_url || null,
            mentionAt: getNotificationActivityDate(item),
            unreadAt: item.unread_at || null,
            readAt: item.read_at || null,
            unreadCount: typeof item.unread_count === "number" ? item.unread_count : 0,
            notificationSection: item.section || null,
            readableSgid: item.readable_sgid || null,
            creatorName: item.creator?.name || null,
          }))
          .sort((a: any, b: any) => {
            const dateA = a.mentionAt ? new Date(a.mentionAt).getTime() : 0;
            const dateB = b.mentionAt ? new Date(b.mentionAt).getTime() : 0;
            return dateB - dateA;
          })
          .slice(0, 25)
      : recordingsNotificationTasks.length > 0
        ? recordingsNotificationTasks
      : Array.from(notificationTaskMap.values())
          .sort((a: any, b: any) => {
            const dateA = a.mentionAt ? new Date(a.mentionAt).getTime() : 0;
            const dateB = b.mentionAt ? new Date(b.mentionAt).getTime() : 0;
            return dateB - dateA;
          })
          .slice(0, 25);

    res.json({ tasks: rawActiveTasks, completedTasks: rawCompletedTasks, mentionTasks, notificationTasks, notificationDebug, user: userProfile });
  } catch (error: any) {
    console.error("Extraction error:", error);
    res.status(500).json({ error: "Server error during extraction: " + error.message });
  }
});

async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*all", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
