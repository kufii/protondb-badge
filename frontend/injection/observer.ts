import {
  UIMode,
  detectGamePage,
  setRoutePatchData,
  clearRoutePatchData
} from './detector';
import { fetchProtonDbRating } from '../services/protondbApi';
import { findToolbarRow, createBadge } from '../display/badge';

const BADGE_ID = 'protondb-status-badge';

let observer: MutationObserver | null = null;
let intervalId: ReturnType<typeof setInterval> | null = null;
let currentAppId: number | null = null;
let processingAppId: number | null = null;
let panelDoc: Document | null = null; // iframe/doc where badge actually lives
let _lastLoggedAppId: number | null | undefined = undefined;

let routePatchCleanup: (() => void) | null = null;

function setupRoutePatch(): void {
  const routerHook = (window as any).__ROUTER_HOOK_INSTANCE;
  if (!routerHook) {
    console.log(
      '[ProtonDB] Router hook not available, Big Picture detection will not work'
    );
    return;
  }

  const patchFn = (props: any) => {
    const renderFunc = props.children?.props?.renderFunc;
    if (renderFunc) {
      const orig = renderFunc;
      props.children.props.renderFunc = (...args: any[]) => {
        const ret = orig(...args);
        const overview = ret?.props?.children?.props?.overview;
        if (overview?.appid) {
          setRoutePatchData(
            overview.appid,
            UIMode.BigPicture,
            overview.display_name
          );
        }
        return ret;
      };
    }
    return props;
  };

  const EUIMODE_GAMEPAD = 4;
  routerHook.addPatch('/library/app/:appid', patchFn, EUIMODE_GAMEPAD);
  routePatchCleanup = () =>
    routerHook.removePatch('/library/app/:appid', patchFn, EUIMODE_GAMEPAD);
}

function clearCurrentBadge(): void {
  panelDoc?.getElementById(BADGE_ID)?.remove();
  panelDoc = null;
}

function resetStateForNoGame(): void {
  clearCurrentBadge();
  currentAppId = null;
  processingAppId = null;
}

export function disconnectObserver(): void {
  observer?.disconnect();
  observer = null;
  if (intervalId !== null) {
    clearInterval(intervalId);
    intervalId = null;
  }
  currentAppId = null;
  processingAppId = null;
  panelDoc = null;

  if (routePatchCleanup) {
    routePatchCleanup();
    routePatchCleanup = null;
  }
}

export function setupObserver(doc: Document, mode: UIMode): void {
  disconnectObserver();
  _lastLoggedAppId = undefined;

  if (routePatchCleanup) {
    routePatchCleanup();
    routePatchCleanup = null;
  }

  if (mode === UIMode.BigPicture) {
    setupRoutePatch();
  }

  console.log(
    '[ProtonDB] setupObserver: doc is global document?',
    doc === document,
    '| MainWindowBrowserManager?',
    !!(window as any).MainWindowBrowserManager
  );

  // MutationObserver catches DOM inserts at startup and after navigations
  observer = new MutationObserver(() => handleGamePage(doc, mode));
  observer.observe(doc.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class']
  });

  // setInterval as fallback — catches pathname changes via CSS show/hide
  intervalId = setInterval(() => handleGamePage(doc, mode), 500);

  handleGamePage(doc, mode);
}

async function handleGamePage(doc: Document, mode: UIMode): Promise<void> {
  try {
    await _handleGamePage(doc, mode);
  } catch (e) {
    console.error('[ProtonDB] handleGamePage threw:', e);
  }
}

async function _handleGamePage(doc: Document, mode: UIMode): Promise<void> {
  const info = detectGamePage(doc, mode);
  const detectedAppId = info?.appId ?? null;

  if (detectedAppId !== _lastLoggedAppId) {
    _lastLoggedAppId = detectedAppId;
    const w = window as any;
    console.log(
      '[ProtonDB] detection changed → appId:',
      detectedAppId,
      '| pathname:',
      w.MainWindowBrowserManager?.m_lastLocation?.pathname,
      '| playtimeIcons:',
      doc.querySelectorAll('[class*="SVGIcon_PlayTime"]').length
    );
  }

  if (!info) {
    if (currentAppId !== null) {
      resetStateForNoGame();
    }
    if (mode === UIMode.BigPicture) {
      clearRoutePatchData();
    }
    return;
  }

  const { appId, title } = info;

  if (currentAppId !== appId) {
    clearCurrentBadge();
    currentAppId = appId;
    processingAppId = null;
  }

  const existingBadge = panelDoc?.getElementById(BADGE_ID);
  if (existingBadge) {
    // Clean up stale placeholders from older builds.
    if (existingBadge.textContent?.includes('Pending')) {
      existingBadge.remove();
      return;
    }

    // Keep badge as the last tile — Steam may render achievements after us.
    if (
      existingBadge.parentElement &&
      existingBadge !== existingBadge.parentElement.lastElementChild
    ) {
      existingBadge.parentElement.appendChild(existingBadge);
    }
    return;
  }

  if (processingAppId === appId) return;

  processingAppId = appId;

  const target = findToolbarRow();
  if (!target) {
    console.log('[ProtonDB] toolbar row not found — retrying on next mutation');
    processingAppId = null;
    return;
  }
  panelDoc = target.doc;

  // Fetch rating before touching the DOM — no loading placeholder
  const rating = await fetchProtonDbRating(appId, title);

  if (currentAppId !== appId) {
    processingAppId = null;
    return;
  }
  if (!rating) {
    processingAppId = null;
    return;
  } // no rating = no badge

  // Wait briefly for achievements tile to load so we can append after it
  const ACHIEVEMENTS_WAIT_MS = 400;
  const deadline = Date.now() + ACHIEVEMENTS_WAIT_MS;
  while (Date.now() < deadline) {
    // Check if an achievements tile has appeared in the row
    const rowNow =
      target.doc.getElementById(target.row.id as string) ?? target.row;
    const hasAchievements = Array.from(rowNow.children).some(el =>
      el.textContent?.includes('Achievements')
    );
    if (hasAchievements) break;
    await new Promise(r => setTimeout(r, 50));
  }

  if (currentAppId !== appId) {
    processingAppId = null;
    return;
  }

  // Re-find row in case DOM was rebuilt while we waited
  const freshTarget = findToolbarRow() ?? target;
  panelDoc = freshTarget.doc;

  console.log('[ProtonDB] rating fetched:', rating.tier);
  freshTarget.row.appendChild(createBadge(rating, freshTarget.doc));
  processingAppId = null;
}
