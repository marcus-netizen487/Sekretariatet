import { initializeApp } from 'firebase/app';
import {
  GoogleAuthProvider,
  getAuth,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
  type User,
} from 'firebase/auth';
import {
  Timestamp,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocFromServer,
  getDocs,
  getFirestore,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
  type DocumentReference,
  type DocumentSnapshot,
} from 'firebase/firestore';
import { applyEmergencyTimeOffsets, validateCompetitorReadout } from './utils/readoutValidation';
import {
  calculateSeriesStandings,
  normalizeSeriesScoringSettings,
} from './services/seriesStandings';
import firebaseConfig from '../firebase-applet-config.json';
import type {
  CardPunch,
  ClassCompetitionFormat,
  CloudCompetitionRecord,
  CloudEventExportItem,
  CloudSeasonSnapshot,
  ClubAdminTier,
  ClubSettings,
  CompClass,
  CompetitionSummary,
  Competitor,
  Course,
  EmergencySettings,
  EventLifecycleStatus,
  FullCardReadoutPayload,
  PublicRacePayload,
  RunnerDbEntry,
  RunnerStatus,
  SICardSeries,
  SIStation,
  StationFunction,
} from './types/sportident';

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });

// Blueprint validation constants synchronized verbatim with firebase-blueprint.json & firestore.rules
export const BOOTSTRAP_SUPER_ADMIN_EMAIL = 'instagram.okosteraker@gmail.com';
export const BOOTSTRAP_SUPER_ADMIN_EMAILS = [
  'instagram.okosteraker@gmail.com',
  'marcus.o.ahlen@gmail.com',
];
const SAFE_ID_REGEX = /^[a-zA-Z0-9_\-]+$/;
const SAFE_EMAIL_REGEX = /^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/;
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const CLOCK_REGEX = /^\d{2}:\d{2}(:\d{2})?$/;
const PIN_REGEX = /^\d{4,6}$/;
const HEX_COLOR_REGEX = /^#[0-9a-fA-F]{6}$/;
const MAX_LOGO_DATA_URL_LEN = 200_000;
const BATCH_CHUNK_LIMIT = 350;

function sanitizeCloudHexColor(raw?: string | null): string {
  if (!raw || typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  return HEX_COLOR_REGEX.test(trimmed) ? trimmed.toLowerCase() : '';
}

function sanitizeCloudLogoDataUrl(raw?: string | null): string {
  if (!raw || typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_LOGO_DATA_URL_LEN) return '';
  if (
    trimmed.startsWith('data:image/png;base64,') ||
    trimmed.startsWith('data:image/jpeg;base64,')
  ) {
    return trimmed;
  }
  return '';
}

export function getStockholmTodayIso(date = new Date()): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Stockholm',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function clampInt(val: unknown, min: number, max: number, fallback: number): number {
  const num = Number(val);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.round(num)));
}

function normalizeControlTimeOffsets(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const offsets: Record<string, number> = {};
  for (const [code, rawOffset] of Object.entries(raw)) {
    const stationCode = Number(code);
    const offset = Number(rawOffset);
    if (
      Number.isInteger(stationCode) &&
      stationCode >= 1 &&
      stationCode <= 999 &&
      Number.isFinite(offset) &&
      offset >= -7200 &&
      offset <= 7200
    ) {
      const rounded = Math.round(offset);
      if (rounded !== 0) offsets[String(stationCode)] = rounded;
    }
  }
  return offsets;
}

function encodeNullableSec(val: number | null | undefined): number {
  if (val === null || val === undefined || !Number.isFinite(val)) return -1;
  return clampInt(val, 0, 86400, -1);
}

function decodeNullableSec(val: unknown): number | null {
  const num = Number(val);
  if (!Number.isFinite(num) || num < 0) return null;
  return Math.min(86400, Math.round(num));
}

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

const TOKEN_SERVICE_STORAGE_KEY = 'passersi_token_service_disabled_v1';
const TOKEN_SERVICE_PROJECT_REF = firebaseConfig.messagingSenderId || firebaseConfig.projectId;
export const TOKEN_SERVICE_ACTIVATION_URL = `https://console.developers.google.com/apis/api/securetoken.googleapis.com/overview?project=${TOKEN_SERVICE_PROJECT_REF}`;

let tokenServiceDisabledFlag = (() => {
  if (typeof window === 'undefined') return false;
  try {
    return sessionStorage.getItem(TOKEN_SERVICE_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
})();
const tokenServiceListeners = new Set<(disabled: boolean) => void>();

export function isTokenServiceApiDisabled(): boolean {
  return tokenServiceDisabledFlag;
}

export function subscribeTokenServiceStatus(cb: (disabled: boolean) => void): () => void {
  tokenServiceListeners.add(cb);
  cb(tokenServiceDisabledFlag);
  return () => {
    tokenServiceListeners.delete(cb);
  };
}

function setTokenServiceDisabled(disabled: boolean): void {
  if (typeof window !== 'undefined') {
    try {
      if (disabled) {
        sessionStorage.setItem(TOKEN_SERVICE_STORAGE_KEY, '1');
      } else {
        sessionStorage.removeItem(TOKEN_SERVICE_STORAGE_KEY);
      }
    } catch {
      // ignore storage restrictions
    }
  }
  if (tokenServiceDisabledFlag !== disabled) {
    tokenServiceDisabledFlag = disabled;
    tokenServiceListeners.forEach((fn) => fn(disabled));
  }
}

export function isTokenServiceError(error: unknown): boolean {
  const code = String((error as { code?: string })?.code || '').toLowerCase();
  const msg = (error instanceof Error ? error.message : String(error || '')).toLowerCase();
  return (
    code.includes('token-service-api') ||
    msg.includes('token-service-api') ||
    msg.includes('securetoken.googleapis.com')
  );
}

function isTransientOfflineFirestoreError(error: unknown): boolean {
  if (isTokenServiceError(error)) return true;
  const code = String((error as { code?: string })?.code || '').toLowerCase();
  const msg = (error instanceof Error ? error.message : String(error || '')).toLowerCase();
  return (
    code === 'unavailable' ||
    code.includes('network-request-failed') ||
    msg.includes('the client is offline') ||
    msg.includes('fetching auth token failed') ||
    msg.includes('could not reach cloud firestore backend')
  );
}

function isPermissionDeniedFirestoreError(error: unknown): boolean {
  const code = String((error as { code?: string })?.code || '').toLowerCase();
  const message = (error instanceof Error ? error.message : String(error || '')).toLowerCase();
  return (
    code.includes('permission-denied') ||
    message.includes('permission-denied') ||
    message.includes('missing or insufficient permissions')
  );
}

let pendingAuthValidation: Promise<User | null> | null = null;
let proactiveRefreshTimer: ReturnType<typeof setTimeout> | null = null;

function clearProactiveRefreshTimer(): void {
  if (proactiveRefreshTimer) {
    clearTimeout(proactiveRefreshTimer);
    proactiveRefreshTimer = null;
  }
}

function getStsExpirationMs(user: User): number | null {
  const exp = (
    user as unknown as { stsTokenManager?: { expirationTime?: number } }
  ).stsTokenManager?.expirationTime;
  return typeof exp === 'number' && Number.isFinite(exp) ? exp : null;
}

function scheduleProactiveTokenRefresh(user: User): void {
  clearProactiveRefreshTimer();
  const expMs = getStsExpirationMs(user);
  if (!expMs) return;
  const delayMs = Math.max(5_000, expMs - Date.now() - 3 * 60_000);
  proactiveRefreshTimer = setTimeout(() => {
    void ensureValidFirestoreUser(true);
  }, delayMs);
}

/**
 * Verifies that any cached Firebase Auth user has a valid, refreshable ID token BEFORE
 * Firestore opens a backend stream. If `securetoken.googleapis.com` is disabled in GCP,
 * signs out the stale Firebase Auth cache cleanly (leaving PasserSI's Secretariat session intact)
 * so `@firebase/firestore` never fails with `Fetching auth token failed`.
 */
export async function ensureValidFirestoreUser(forceRefresh = false): Promise<User | null> {
  if (pendingAuthValidation && !forceRefresh) {
    return pendingAuthValidation;
  }

  const run = (async (): Promise<User | null> => {
    try {
      if (typeof auth.authStateReady === 'function') {
        await auth.authStateReady();
      }
    } catch {
      // ignore
    }

    const current = auth.currentUser;
    if (!current) {
      clearProactiveRefreshTimer();
      return null;
    }

    const expMs = getStsExpirationMs(current);
    const nearExpiry = expMs !== null && expMs - Date.now() < 3 * 60_000;
    const shouldForce = forceRefresh || nearExpiry;

    try {
      const token = await current.getIdToken(shouldForce);
      if (!token) {
        clearProactiveRefreshTimer();
        await signOut(auth).catch(() => {});
        return null;
      }
      if (shouldForce) {
        setTokenServiceDisabled(false);
      }
      scheduleProactiveTokenRefresh(current);
      return current;
    } catch (err) {
      clearProactiveRefreshTimer();
      if (isTokenServiceError(err)) {
        setTokenServiceDisabled(true);
        await signOut(auth).catch(() => {});
        return null;
      }
      const code = String((err as { code?: string })?.code || '').toLowerCase();
      if (
        code.includes('user-token-expired') ||
        code.includes('invalid-user-token') ||
        code.includes('user-disabled') ||
        code.includes('user-not-found')
      ) {
        await signOut(auth).catch(() => {});
        return null;
      }
      if (expMs !== null && expMs <= Date.now()) {
        return null;
      }
      return current;
    }
  })();

  pendingAuthValidation = run;
  try {
    return await run;
  } finally {
    if (pendingAuthValidation === run) {
      pendingAuthValidation = null;
    }
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && auth.currentUser) {
      void ensureValidFirestoreUser(false);
    }
  });
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  if (isTokenServiceError(error)) {
    setTokenServiceDisabled(true);
    void signOut(auth).catch(() => {});
  }
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

function handleWriteOrOfflineError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  if (isTokenServiceError(error)) {
    setTokenServiceDisabled(true);
    void signOut(auth).catch(() => {});
    throw new Error(
      'Token Service API (securetoken.googleapis.com) är inaktiverat i Google Cloud-projektet.'
    );
  }
  if (isTransientOfflineFirestoreError(error)) {
    throw new Error('Kunde inte nå Firestore i offlineläge.');
  }
  return handleFirestoreError(error, operationType, path);
}

// Validate connection to Firestore on boot (after ensuring cached auth token is healthy)
async function testConnection(): Promise<void> {
  try {
    await ensureValidFirestoreUser();
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes('the client is offline') &&
      !isTokenServiceApiDisabled() &&
      (typeof navigator === 'undefined' || navigator.onLine !== false)
    ) {
      console.error('Please check your Firebase configuration.');
    }
  }
}
void testConnection();

export function sanitizeFirestoreId(raw: string, fallbackPrefix = 'id'): string {
  const cleaned = raw
    .trim()
    .replace(/[^a-zA-Z0-9_\-]/g, '_')
    .slice(0, 128);
  if (!cleaned || !SAFE_ID_REGEX.test(cleaned)) {
    return `${fallbackPrefix}_${Date.now()}`;
  }
  return cleaned;
}

/**
 * Deterministic, collision-safe invite document ID derived from normalized lowercase email.
 * Matches ^[a-zA-Z0-9_\-]+$ and stays <= 128 characters.
 */
export function emailToInviteId(email: string): string {
  const norm = email.trim().toLowerCase();
  let hex = '';
  for (let i = 0; i < norm.length; i++) {
    hex += norm.charCodeAt(i).toString(16).padStart(2, '0');
  }
  return `inv_${hex}`.slice(0, 128);
}

export function subscribeFirebaseAuth(cb: (user: User | null) => void): () => void {
  let cancelled = false;
  const unsub = onAuthStateChanged(auth, (u) => {
    if (!u) {
      if (!cancelled) cb(null);
      return;
    }
    void ensureValidFirestoreUser().then((validUser) => {
      if (!cancelled) {
        cb(validUser);
      }
    });
  });
  return () => {
    cancelled = true;
    unsub();
  };
}

/**
 * Pre-warms Firebase Auth's BrowserPopupRedirectResolver iframe (`gapi.iframes`) on desktop
 * browsers so clicking "Logga in med Google" opens the OAuth window synchronously within the
 * browser's transient user-activation window instead of timing out with `auth/popup-blocked`.
 */
export function prewarmGooglePopupAuth(): void {
  if (typeof window === 'undefined') return;
  try {
    const internalAuth = auth as unknown as {
      _popupRedirectResolver?: {
        _initialize?: (authInstance: unknown) => Promise<unknown>;
      };
    };
    if (typeof internalAuth._popupRedirectResolver?._initialize === 'function') {
      void internalAuth._popupRedirectResolver._initialize(auth).catch(() => {
        // Ignore background pre-warm errors (e.g., when offline in the forest)
      });
    }
  } catch {
    // Ignore
  }
}

export async function signInWithGooglePopup(): Promise<{ user: User | null; idToken: string }> {
  const credential = await signInWithPopup(auth, googleProvider);
  let idToken = '';
  try {
    idToken = await credential.user.getIdToken(false);
  } catch (err) {
    const fallbackToken = (
      credential.user as unknown as { stsTokenManager?: { accessToken?: string } }
    ).stsTokenManager?.accessToken;
    if (fallbackToken) {
      idToken = fallbackToken;
    } else {
      throw err;
    }
  }

  // Proactively verify whether Token Service API (`securetoken.googleapis.com`) is enabled in GCP.
  // If disabled, keep `idToken` so Secretariat login succeeds, and clear Firebase Auth's local cache
  // so Firestore never fails later when the 1h token expires.
  try {
    const refreshedToken = await credential.user.getIdToken(true);
    if (refreshedToken) {
      idToken = refreshedToken;
    }
    setTokenServiceDisabled(false);
    scheduleProactiveTokenRefresh(credential.user);
    return { user: credential.user, idToken };
  } catch (refreshErr) {
    clearProactiveRefreshTimer();
    if (isTokenServiceError(refreshErr)) {
      setTokenServiceDisabled(true);
      await signOut(auth).catch(() => {});
      return { user: null, idToken };
    }
    scheduleProactiveTokenRefresh(credential.user);
    return { user: credential.user, idToken };
  }
}

export async function signOutFirebase(): Promise<void> {
  clearProactiveRefreshTimer();
  if (auth.currentUser) {
    await signOut(auth);
  }
}

/**
 * Claims or refreshes the verified Google user's non-PII `/admins/{uid}` role document in Firestore.
 */
export async function ensureAdminRoleInFirestore(
  user: User
): Promise<{ claimed: boolean; role: ClubAdminTier | null }> {
  const validUser = await ensureValidFirestoreUser();
  if (!validUser || validUser.uid !== user.uid || !user.email || !user.emailVerified) {
    return { claimed: false, role: null };
  }
  const normalizedEmail = user.email.trim().toLowerCase();
  const uid = sanitizeFirestoreId(user.uid, 'usr');
  const displayName = (user.displayName || normalizedEmail.split('@')[0] || 'Tävlingsledare')
    .trim()
    .slice(0, 100);

  const adminPath = `admins/${uid}`;
  let existingRole: ClubAdminTier | null = null;
  const isBootstrapAdmin = BOOTSTRAP_SUPER_ADMIN_EMAILS.includes(normalizedEmail);

  const consumeInvite = async () => {
    const inviteId = emailToInviteId(normalizedEmail);
    const inviteRef = doc(db, 'adminInvites', inviteId);
    let inviteSnap: DocumentSnapshot | null = null;
    try {
      inviteSnap = await getDoc(inviteRef);
    } catch (err) {
      if (isTransientOfflineFirestoreError(err)) return;
      handleFirestoreError(err, OperationType.GET, `adminInvites/${inviteId}`);
    }
    if (!inviteSnap?.exists()) return;
    const invite = inviteSnap.data();
    if (invite.email !== normalizedEmail || invite.active !== true) return;
    try {
      await updateDoc(inviteRef, {
        active: false,
        claimedUid: uid,
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      handleWriteOrOfflineError(err, OperationType.UPDATE, `adminInvites/${inviteId}`);
    }
  };

  let existingAdminSnap: DocumentSnapshot | null = null;
  try {
    existingAdminSnap = await getDoc(doc(db, 'admins', uid));
  } catch (err) {
    if (isTransientOfflineFirestoreError(err)) {
      return { claimed: false, role: null };
    }
    handleFirestoreError(err, OperationType.GET, adminPath);
  }
  if (existingAdminSnap?.exists()) {
    const data = existingAdminSnap.data() as { role?: ClubAdminTier; displayName?: string };
    existingRole =
      isBootstrapAdmin || data.role === 'SUPER_ADMIN' ? 'SUPER_ADMIN' : 'RACE_ADMIN';
    if (data.displayName !== displayName || data.role !== existingRole) {
      try {
        await updateDoc(doc(db, 'admins', uid), {
          displayName,
          role: existingRole,
          updatedAt: serverTimestamp(),
        });
      } catch (err) {
        handleWriteOrOfflineError(err, OperationType.UPDATE, adminPath);
      }
    }
    await consumeInvite();
    return { claimed: true, role: existingRole };
  }

  // Bootstrapped primary owner
  if (isBootstrapAdmin) {
    try {
      const defaultName =
        normalizedEmail === 'instagram.okosteraker@gmail.com'
          ? 'OK Österåker (Huvudadmin)'
          : 'Marcus Åhlén (Huvudadmin)';
      await setDoc(doc(db, 'admins', uid), {
        uid,
        displayName: displayName || defaultName,
        role: 'SUPER_ADMIN',
        inviteId: 'bootstrap_super_admin',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      handleWriteOrOfflineError(err, OperationType.CREATE, adminPath);
    }
    await consumeInvite();
    return { claimed: true, role: 'SUPER_ADMIN' };
  }

  // Otherwise check if an active invite exists for this verified email
  const inviteId = emailToInviteId(normalizedEmail);
  let invSnap: DocumentSnapshot | null = null;
  try {
    invSnap = await getDoc(doc(db, 'adminInvites', inviteId));
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
    const code = String((err as { code?: string })?.code || '').toLowerCase();
    if (
      code.includes('permission-denied') ||
      message.includes('permission-denied') ||
      message.includes('missing or insufficient permissions')
    ) {
      // Non-invited users cannot read invitations because they contain personal data.
      return { claimed: false, role: null };
    }
    if (isTransientOfflineFirestoreError(err)) {
      return { claimed: false, role: null };
    }
    handleFirestoreError(err, OperationType.GET, `adminInvites/${inviteId}`);
  }
  if (!invSnap?.exists()) {
    return { claimed: false, role: null };
  }
  const invData = invSnap.data() as { active?: boolean; role?: ClubAdminTier };
  if (!invData.active) return { claimed: false, role: null };
  const grantedRole: ClubAdminTier =
    invData.role === 'SUPER_ADMIN' ? 'SUPER_ADMIN' : 'RACE_ADMIN';

  try {
    await setDoc(doc(db, 'admins', uid), {
      uid,
      displayName,
      role: grantedRole,
      inviteId,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  } catch (createErr) {
    handleWriteOrOfflineError(createErr, OperationType.CREATE, adminPath);
  }
  await consumeInvite();
  return { claimed: true, role: grantedRole };
}

export interface FirestoreAdminInviteItem {
  inviteId: string;
  email: string;
  displayName: string;
  role: ClubAdminTier;
  active: boolean;
  claimedUid?: string;
}

export async function listMyAdminInvitesFromFirestore(): Promise<FirestoreAdminInviteItem[]> {
  const current = await ensureValidFirestoreUser();
  if (!current) return [];
  const path = 'adminInvites';
  try {
    const q = query(collection(db, 'adminInvites'), where('createdByUid', '==', current.uid));
    const snap = await getDocs(q);
    return snap.docs.map((d) => {
      const data = d.data() as {
        inviteId: string;
        email: string;
        displayName: string;
        role: ClubAdminTier;
        active: boolean;
        claimedUid?: string;
      };
      return {
        inviteId: data.inviteId,
        email: data.email,
        displayName: data.displayName,
        role: data.role,
        active: data.active,
        claimedUid: data.claimedUid,
      };
    });
  } catch (err) {
    if (isTransientOfflineFirestoreError(err)) {
      return [];
    }
    handleFirestoreError(err, OperationType.LIST, path);
  }
}

export async function upsertAdminInviteInFirestore(params: {
  email: string;
  displayName: string;
  role?: ClubAdminTier;
  isSuperAdmin?: boolean;
}): Promise<string | null> {
  const current = await ensureValidFirestoreUser();
  if (!current) return null;

  const normEmail = params.email.trim().toLowerCase().slice(0, 120);
  if (!SAFE_EMAIL_REGEX.test(normEmail)) {
    throw new Error('Ange en giltig e-postadress med små bokstäver.');
  }
  const cleanName = (params.displayName.trim() || normEmail.split('@')[0]).slice(0, 100);
  const inviteId = emailToInviteId(normEmail);
  const role: ClubAdminTier = params.role === 'SUPER_ADMIN' ? 'SUPER_ADMIN' : 'RACE_ADMIN';
  const path = `adminInvites/${inviteId}`;

  let existingInvite: FirestoreAdminInviteItem | null = null;
  try {
    const existing = await getDoc(doc(db, 'adminInvites', inviteId));
    if (existing.exists()) {
      existingInvite = existing.data() as FirestoreAdminInviteItem;
    }
  } catch (err) {
    handleWriteOrOfflineError(err, OperationType.GET, path);
  }

  if (existingInvite) {
    try {
      if (params.isSuperAdmin) {
        await updateDoc(doc(db, 'adminInvites', inviteId), {
          displayName: cleanName,
          role,
          active: true,
          updatedAt: serverTimestamp(),
        });
        if (existingInvite.claimedUid) {
          const claimedAdminRef = doc(db, 'admins', existingInvite.claimedUid);
          const claimedAdminSnap = await getDoc(claimedAdminRef);
          if (claimedAdminSnap.exists()) {
            await updateDoc(claimedAdminRef, {
              role,
              updatedAt: serverTimestamp(),
            });
          }
        }
      } else {
        await updateDoc(doc(db, 'adminInvites', inviteId), {
          displayName: cleanName,
          active: true,
          updatedAt: serverTimestamp(),
        });
      }
      return inviteId;
    } catch (err) {
      handleWriteOrOfflineError(err, OperationType.UPDATE, path);
    }
  } else {
    try {
      await setDoc(doc(db, 'adminInvites', inviteId), {
        inviteId,
        email: normEmail,
        displayName: cleanName,
        role: params.isSuperAdmin ? role : 'RACE_ADMIN',
        active: true,
        createdByUid: sanitizeFirestoreId(current.uid, 'usr'),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      return inviteId;
    } catch (err) {
      handleWriteOrOfflineError(err, OperationType.CREATE, path);
    }
  }
}

export async function removeAdminInviteFromFirestore(email: string): Promise<void> {
  const current = await ensureValidFirestoreUser();
  if (!current) return;
  const normEmail = email.trim().toLowerCase();
  const inviteId = emailToInviteId(normEmail);
  const path = `adminInvites/${inviteId}`;

  let inviteData: Record<string, unknown> | null = null;
  try {
    const snap = await getDoc(doc(db, 'adminInvites', inviteId));
    inviteData = snap.exists() ? snap.data() : null;
  } catch (err) {
    handleWriteOrOfflineError(err, OperationType.GET, path);
  }
  if (!inviteData) return;

  try {
    const claimedUid =
      typeof inviteData.claimedUid === 'string' ? inviteData.claimedUid : null;
    if (claimedUid) {
      const adminRef = doc(db, 'admins', claimedUid);
      const adminSnap = await getDoc(adminRef);
      if (adminSnap.exists()) {
        await deleteDoc(adminRef);
      }
    }
    await deleteDoc(doc(db, 'adminInvites', inviteId));
  } catch (err) {
    handleWriteOrOfflineError(err, OperationType.DELETE, path);
  }
}

type QueuedBatchOp =
  | { kind: 'set'; ref: DocumentReference; data: Record<string, unknown>; path: string }
  | { kind: 'update'; ref: DocumentReference; data: Record<string, unknown>; path: string }
  | { kind: 'delete'; ref: DocumentReference; path: string };

async function commitQueuedBatchOps(ops: QueuedBatchOp[]): Promise<void> {
  for (let i = 0; i < ops.length; i += BATCH_CHUNK_LIMIT) {
    const slice = ops.slice(i, i + BATCH_CHUNK_LIMIT);
    const batch = writeBatch(db);
    for (const op of slice) {
      if (op.kind === 'set') {
        batch.set(op.ref, op.data);
      } else if (op.kind === 'update') {
        batch.update(op.ref, op.data);
      } else {
        batch.delete(op.ref);
      }
    }
    try {
      await batch.commit();
    } catch (err) {
      handleWriteOrOfflineError(err, OperationType.WRITE, slice[0]?.path || 'batch');
    }
  }
}

/**
 * Deletes all competition child documents before deleting the parent document.
 */
export async function deleteCompetitionFromFirestore(rawCompetitionId: string): Promise<void> {
  const current = await ensureValidFirestoreUser();
  if (
    !current ||
    !current.emailVerified ||
    !current.providerData.some((provider) => provider.providerId === 'google.com')
  ) {
    throw new Error('Radering kräver ett inloggat, verifierat Google-administratörskonto.');
  }

  const competitionId = sanitizeFirestoreId(rawCompetitionId, 'evt');
  const ownerUid = sanitizeFirestoreId(current.uid, 'usr');
  const compPath = `competitions/${competitionId}`;

  let competitionData: { ownerUid?: string; status?: string } | null = null;
  try {
    const snap = await getDoc(doc(db, 'competitions', competitionId));
    competitionData = snap.exists()
      ? (snap.data() as { ownerUid?: string; status?: string })
      : null;
  } catch (err) {
    handleWriteOrOfflineError(err, OperationType.GET, compPath);
  }
  if (!competitionData) return;

  const isBootstrapAdmin = BOOTSTRAP_SUPER_ADMIN_EMAILS.includes(
    (current.email || '').toLowerCase()
  );
  const adminSnap = isBootstrapAdmin
    ? null
    : await getDoc(doc(db, 'admins', ownerUid));
  const role = adminSnap?.exists() ? adminSnap.data().role : null;
  const isSuperAdmin = isBootstrapAdmin || role === 'SUPER_ADMIN';
  if (!isSuperAdmin && role !== 'RACE_ADMIN') {
    throw new Error('Ditt Google-konto saknar administratörsbehörighet för att radera tävlingar.');
  }
  if (competitionData.ownerUid !== current.uid && !isSuperAdmin) {
    throw new Error('Du kan bara radera tävlingar du själv äger. Be en huvudadministratör om hjälp.');
  }
  if (competitionData.status === 'COMPLETED' && !isSuperAdmin) {
    throw new Error('Endast en huvudadministratör kan radera avslutade tävlingar.');
  }

  const deleteOps: QueuedBatchOp[] = [];
  for (const subName of [
    'courses',
    'classes',
    'competitors',
    'stations',
    'stationPunches',
    'readoutReceipts',
  ] as const) {
    const subPath = `competitions/${competitionId}/${subName}`;
    try {
      const subCollection = collection(db, 'competitions', competitionId, subName);
      const q = isSuperAdmin
        ? query(subCollection)
        : query(subCollection, where('ownerUid', '==', ownerUid));
      const subSnap = await getDocs(q);
      for (const d of subSnap.docs) {
        deleteOps.push({
          kind: 'delete',
          ref: doc(db, 'competitions', competitionId, subName, d.id),
          path: `${subPath}/${d.id}`,
        });
      }
    } catch (err) {
      handleWriteOrOfflineError(err, OperationType.LIST, subPath);
    }
  }

  if (deleteOps.length > 0) {
    await commitQueuedBatchOps(deleteOps);
  }

  try {
    await deleteDoc(doc(db, 'competitions', competitionId));
  } catch (err) {
    handleWriteOrOfflineError(err, OperationType.DELETE, compPath);
  }

  const clubRef = doc(db, 'clubSettings', 'default');
  const clubSnap = await getDoc(clubRef);
  if (clubSnap.exists()) {
    const clubData = clubSnap.data() as {
      activeEventId?: unknown;
      competitionIds?: unknown;
    };
    const remainingIds = Array.isArray(clubData.competitionIds)
      ? clubData.competitionIds.filter(
          (id): id is string => typeof id === 'string' && id !== competitionId
        )
      : [];
    await updateDoc(clubRef, {
      activeEventId:
        clubData.activeEventId === competitionId
          ? remainingIds[0] ?? ''
          : typeof clubData.activeEventId === 'string'
            ? clubData.activeEventId
            : '',
      competitionIds: remainingIds,
      updatedAt: serverTimestamp(),
    });
  }
}

export async function updateCompetitionMetadataInFirestore(
  competitionId: string,
  patch: {
    name?: string;
    organizer?: string;
    date?: string;
    status?: EventLifecycleStatus;
    zeroTimeStr?: string;
    zeroTimeSec?: number;
    arenaInfo?: string;
    seriesName?: string;
    enableFeesAndSwish?: boolean;
  }
): Promise<void> {
  const context = await getCompetitionMutationContext(competitionId);
  const mutable: Record<string, unknown> = {};
  if ('name' in patch) mutable.name = (patch.name || '').trim().slice(0, 140);
  if ('organizer' in patch) mutable.organizer = (patch.organizer || '').trim().slice(0, 100);
  if ('date' in patch) {
    if (!patch.date || !ISO_DATE_REGEX.test(patch.date)) {
      throw new Error('Tävlingens datum måste anges som ÅÅÅÅ-MM-DD.');
    }
    mutable.date = patch.date;
  }
  if ('status' in patch) mutable.status = patch.status;
  if ('zeroTimeStr' in patch) {
    if (!patch.zeroTimeStr || !CLOCK_REGEX.test(patch.zeroTimeStr)) {
      throw new Error('Ogiltig nolltid.');
    }
    mutable.zeroTimeStr = patch.zeroTimeStr;
    const [hours, minutes, seconds = '0'] = patch.zeroTimeStr.split(':');
    mutable.zeroTimeSec =
      Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
  }
  if ('zeroTimeSec' in patch && !('zeroTimeStr' in patch)) {
    mutable.zeroTimeSec = clampInt(patch.zeroTimeSec, 0, 86400, 36000);
  }
  if ('arenaInfo' in patch) mutable.arenaInfo = (patch.arenaInfo || '').trim().slice(0, 500);
  if ('seriesName' in patch) mutable.seriesName = (patch.seriesName || '').trim().slice(0, 80);
  if ('enableFeesAndSwish' in patch) {
    mutable.enableFeesAndSwish = Boolean(patch.enableFeesAndSwish);
  }
  if (Object.keys(mutable).length === 0) return;
  await updateDoc(doc(db, 'competitions', context.competitionId), {
    ...mutable,
    updatedAt: serverTimestamp(),
  });
}

export async function activateCompetitionInFirestore(
  rawCompetitionId: string
): Promise<void> {
  const current = await ensureValidFirestoreUser();
  if (
    !current ||
    !current.emailVerified ||
    !current.providerData.some((provider) => provider.providerId === 'google.com')
  ) {
    throw new Error('Aktivering kräver ett inloggat, verifierat Google-administratörskonto.');
  }
  const ownerUid = sanitizeFirestoreId(current.uid, 'usr');
  const isBootstrapAdmin = BOOTSTRAP_SUPER_ADMIN_EMAILS.includes(
    (current.email || '').toLowerCase()
  );
  const adminSnap = isBootstrapAdmin
    ? null
    : await getDoc(doc(db, 'admins', ownerUid));
  const role = adminSnap?.exists() ? adminSnap.data().role : null;
  const isSuperAdmin = isBootstrapAdmin || role === 'SUPER_ADMIN';
  if (!isSuperAdmin && role !== 'RACE_ADMIN') {
    throw new Error('Ditt Google-konto saknar administratörsbehörighet.');
  }
  const competitionId = sanitizeFirestoreId(rawCompetitionId, 'evt');
  const competitionSnap = await getDoc(doc(db, 'competitions', competitionId));
  if (!competitionSnap.exists()) throw new Error('Tävlingen hittades inte i Firestore.');
  if (competitionSnap.data().ownerUid !== current.uid && !isSuperAdmin) {
    throw new Error('Du saknar behörighet att aktivera den här tävlingen.');
  }

  const clubRef = doc(db, 'clubSettings', 'default');
  const clubSnap = await getDoc(clubRef);
  if (!clubSnap.exists()) throw new Error('Klubbinställningarna saknas i Firestore.');
  const clubData = clubSnap.data();
  if (clubData.ownerUid !== current.uid && !isSuperAdmin) {
    throw new Error('Du saknar behörighet att ändra klubbens aktiva tävling.');
  }
  const competitionIds = Array.isArray(clubData.competitionIds)
    ? clubData.competitionIds.filter(
        (id: unknown): id is string => typeof id === 'string' && SAFE_ID_REGEX.test(id)
      )
    : [];
  await updateDoc(clubRef, {
    activeEventId: competitionId,
    competitionIds: Array.from(new Set([...competitionIds, competitionId])),
    updatedAt: serverTimestamp(),
  });
}

/**
 * Syncs the entire club season (clubSettings, competitions, courses, classes, competitors, SI punches,
 * role PINs, and empty/demoCleared states) to Firestore under Zero-Trust rules.
 */
export async function syncFullSeasonToFirestore(
  snapshot: CloudSeasonSnapshot,
  isSuperAdmin: boolean
): Promise<{ syncedEvents: number }> {
  const current = await ensureValidFirestoreUser();
  if (!current || !current.emailVerified) {
    return { syncedEvents: 0 };
  }

  const ownerUid = sanitizeFirestoreId(current.uid, 'usr');
  const competitionIds = snapshot.events
    .slice(0, 100)
    .map((ev) => sanitizeFirestoreId(ev.competition.id, 'evt'));

  // 1. Upsert /clubSettings/default
  const clubPath = 'clubSettings/default';
  const clubMutable = {
    clubName: (snapshot.clubSettings.clubName || 'OK Österåker').trim().slice(0, 100) || 'OK Österåker',
    eventorOrgId: (snapshot.clubSettings.eventorOrgId || '').trim().slice(0, 32),
    swishNumber: (snapshot.clubSettings.swishNumber || '').trim().slice(0, 20),
    swishRecipientName: (snapshot.clubSettings.swishRecipientName || '').trim().slice(0, 100),
    defaultDirectEntryFeeSek: clampInt(
      snapshot.clubSettings.defaultDirectEntryFeeSek,
      0,
      10000,
      100
    ),
    rentalCardFeeSek: clampInt(snapshot.clubSettings.rentalCardFeeSek, 0, 5000, 30),
    missingRentalFeeSek: clampInt(snapshot.clubSettings.missingRentalFeeSek, 0, 20000, 650),
    portalTitle: (snapshot.clubSettings.portalTitle || '').trim().slice(0, 80),
    logoDataUrl: sanitizeCloudLogoDataUrl(snapshot.clubSettings.logoDataUrl),
    customBgColor: sanitizeCloudHexColor(snapshot.clubSettings.customBgColor),
    customTextColor: sanitizeCloudHexColor(snapshot.clubSettings.customTextColor),
    customAccentColor: sanitizeCloudHexColor(snapshot.clubSettings.customAccentColor),
    activeEventId: snapshot.activeEventId
      ? sanitizeFirestoreId(snapshot.activeEventId, 'evt')
      : '',
    demoCleared: Boolean(snapshot.demoCleared),
    competitionIds,
  };

  let existingClubOwner: string | null = null;
  try {
    const clubSnap = await getDoc(doc(db, 'clubSettings', 'default'));
    if (clubSnap.exists()) {
      existingClubOwner = (clubSnap.data() as { ownerUid?: string }).ownerUid || null;
    }
  } catch (err) {
    handleWriteOrOfflineError(err, OperationType.GET, clubPath);
  }

  if (!existingClubOwner) {
    try {
      await setDoc(doc(db, 'clubSettings', 'default'), {
        settingId: 'default',
        ...clubMutable,
        ownerUid,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      handleWriteOrOfflineError(err, OperationType.CREATE, clubPath);
    }
  } else if (existingClubOwner === ownerUid || isSuperAdmin) {
    try {
      await updateDoc(doc(db, 'clubSettings', 'default'), {
        ...clubMutable,
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      handleWriteOrOfflineError(err, OperationType.UPDATE, clubPath);
    }
  }

  // 2. Sync each competition + its courses, classes, and competitors
  let syncedEvents = 0;
  const activeCompSet = new Set<string>(competitionIds);

  for (const ev of snapshot.events.slice(0, 100)) {
    const competitionId = sanitizeFirestoreId(ev.competition.id, 'evt');
    const rawShort = sanitizeFirestoreId(ev.competition.shortCode || 'oko26', 'sc').slice(0, 32);
    const shortCode = rawShort.length >= 2 ? rawShort : 'ev26';
    const targetStatus: EventLifecycleStatus =
      ev.competition.status === 'LIVE' ||
      ev.competition.status === 'UPCOMING' ||
      ev.competition.status === 'COMPLETED'
        ? ev.competition.status
        : 'LIVE';
    const competitorCount = clampInt(ev.competitors.length, 0, 50000, 0);
    const rawFinished = ev.competitors.filter(
      (c) => c.status === 'OK' || c.status === 'MP' || c.status === 'PRELIMINARY_FIN'
    ).length;
    const finishedCount = Math.min(competitorCount, clampInt(rawFinished, 0, 50000, 0));

    const compMutableBase = {
      shortCode,
      name: (ev.competition.name || 'Tävling').trim().slice(0, 140) || 'Tävling',
      organizer: (ev.competition.organizer || 'Klubb').trim().slice(0, 100) || 'Klubb',
      date: ISO_DATE_REGEX.test(ev.competition.date)
        ? ev.competition.date
        : getStockholmTodayIso(),
      zeroTimeStr: CLOCK_REGEX.test(ev.competition.zeroTimeStr)
        ? ev.competition.zeroTimeStr
        : '10:00:00',
      zeroTimeSec: clampInt(ev.competition.zeroTimeSec, 0, 86400, 36000),
      arenaInfo: (ev.competition.arenaInfo || '').trim().slice(0, 500),
      seriesName: (ev.competition.seriesName || '').trim().slice(0, 80),
      enableFeesAndSwish: Boolean(ev.competition.enableFeesAndSwish),
      competitorCount,
      finishedCount,
      brokenControls: (ev.brokenControls || [])
        .slice(0, 64)
        .map((n) => clampInt(n, 1, 999, 31)),
      ...(ev.emergency
        ? { controlTimeOffsets: normalizeControlTimeOffsets(ev.emergency.controlTimeOffsets) }
        : {}),
      pinStart: PIN_REGEX.test(ev.rolePins?.START || '') ? ev.rolePins.START : '1100',
      pinReadout: PIN_REGEX.test(ev.rolePins?.READOUT || '') ? ev.rolePins.READOUT : '2200',
      pinForest: PIN_REGEX.test(ev.rolePins?.FOREST || '') ? ev.rolePins.FOREST : '3300',
      pinSpeaker: PIN_REGEX.test(ev.rolePins?.SPEAKER || '') ? ev.rolePins.SPEAKER : '4400',
      pinsCustomized: Boolean(ev.pinsCustomized),
    };

    const compPath = `competitions/${competitionId}`;
    let existingComp: { status?: string; ownerUid?: string } | null = null;
    try {
      const snap = await getDoc(doc(db, 'competitions', competitionId));
      if (snap.exists()) {
        existingComp = snap.data() as { status?: string; ownerUid?: string };
      }
    } catch (err) {
      handleWriteOrOfflineError(err, OperationType.GET, compPath);
    }

    if (existingComp) {
      const isOwner = existingComp.ownerUid === ownerUid;
      const lockedTerminal = existingComp.status === 'COMPLETED' && !isSuperAdmin;
      if ((!isOwner && !isSuperAdmin) || lockedTerminal) {
        continue;
      }
    }

    // Create parent competition first if missing so subcollection Master Gate exists() passes
    const deferCompletedLock = !isSuperAdmin && targetStatus === 'COMPLETED';
    if (!existingComp) {
      try {
        await setDoc(doc(db, 'competitions', competitionId), {
          competitionId,
          ...compMutableBase,
          status: deferCompletedLock ? 'LIVE' : targetStatus,
          ownerUid,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      } catch (err) {
        handleWriteOrOfflineError(err, OperationType.CREATE, compPath);
      }
    }

    // Sync courses, classes, and competitors in chunked batches
    const childOps: QueuedBatchOp[] = [];

    // 2a. Courses
    const existingCourseIds = new Set<string>();
    try {
      const crsSnap = await getDocs(
        query(
          collection(db, 'competitions', competitionId, 'courses'),
          where('ownerUid', '==', ownerUid)
        )
      );
      crsSnap.docs.forEach((d) => existingCourseIds.add(d.id));
    } catch (err) {
      handleWriteOrOfflineError(err, OperationType.LIST, `competitions/${competitionId}/courses`);
    }

    const nextCourseIds = new Set<string>();
    for (const crs of ev.courses) {
      const courseId = sanitizeFirestoreId(crs.id, 'crs');
      nextCourseIds.add(courseId);
      const crsRef = doc(db, 'competitions', competitionId, 'courses', courseId);
      const crsPath = `competitions/${competitionId}/courses/${courseId}`;
      const crsMutable = {
        name: (crs.name || 'Bana').trim().slice(0, 120) || 'Bana',
        lengthMeters: clampInt(crs.lengthMeters, 0, 200000, 3000),
        climbMeters: clampInt(crs.climbMeters, 0, 20000, 0),
        controls: (crs.controls || []).slice(0, 128).map((c) => clampInt(c, 1, 999, 31)),
      };
      if (existingCourseIds.has(courseId)) {
        childOps.push({
          kind: 'update',
          ref: crsRef,
          path: crsPath,
          data: { ...crsMutable, updatedAt: serverTimestamp() },
        });
      } else {
        childOps.push({
          kind: 'set',
          ref: crsRef,
          path: crsPath,
          data: {
            courseId,
            competitionId,
            ...crsMutable,
            ownerUid,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          },
        });
      }
    }
    for (const oldId of existingCourseIds) {
      if (!nextCourseIds.has(oldId)) {
        childOps.push({
          kind: 'delete',
          ref: doc(db, 'competitions', competitionId, 'courses', oldId),
          path: `competitions/${competitionId}/courses/${oldId}`,
        });
      }
    }

    // 2b. Classes
    const existingClassIds = new Set<string>();
    try {
      const clsSnap = await getDocs(
        query(
          collection(db, 'competitions', competitionId, 'classes'),
          where('ownerUid', '==', ownerUid)
        )
      );
      clsSnap.docs.forEach((d) => existingClassIds.add(d.id));
    } catch (err) {
      handleWriteOrOfflineError(err, OperationType.LIST, `competitions/${competitionId}/classes`);
    }

    const nextClassIds = new Set<string>();
    for (const cls of ev.classes) {
      const classId = sanitizeFirestoreId(cls.id, 'cls');
      nextClassIds.add(classId);
      const clsRef = doc(db, 'competitions', competitionId, 'classes', classId);
      const clsPath = `competitions/${competitionId}/classes/${classId}`;
      const classFormat: ClassCompetitionFormat =
        cls.classFormat === 'FORKED' || cls.classFormat === 'ROGAINING'
          ? cls.classFormat
          : 'STANDARD';
      const clsMutable = {
        name: (cls.name || 'Klass').trim().slice(0, 80) || 'Klass',
        courseId: cls.courseId ? sanitizeFirestoreId(cls.courseId, 'crs') : '',
        classFormat,
        forkCourseIds: (cls.forkCourseIds || [])
          .slice(0, 32)
          .map((id) => sanitizeFirestoreId(id, 'crs')),
        rogainingMaxTimeSec:
          cls.rogainingMaxTimeSec !== null && cls.rogainingMaxTimeSec !== undefined
            ? clampInt(cls.rogainingMaxTimeSec, 0, 86400, -1)
            : -1,
        rogainingPenaltyPerMin:
          cls.rogainingPenaltyPerMin !== null && cls.rogainingPenaltyPerMin !== undefined
            ? clampInt(cls.rogainingPenaltyPerMin, 0, 1000, -1)
            : -1,
        allowDirectEntry: Boolean(cls.allowDirectEntry),
        freeStart: Boolean(cls.freeStart),
        autoMatchCourse: Boolean(cls.autoMatchCourse),
        feeSek: clampInt(cls.feeSek, 0, 10000, 100),
      };
      if (existingClassIds.has(classId)) {
        childOps.push({
          kind: 'update',
          ref: clsRef,
          path: clsPath,
          data: { ...clsMutable, updatedAt: serverTimestamp() },
        });
      } else {
        childOps.push({
          kind: 'set',
          ref: clsRef,
          path: clsPath,
          data: {
            classId,
            competitionId,
            ...clsMutable,
            ownerUid,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          },
        });
      }
    }
    for (const oldId of existingClassIds) {
      if (!nextClassIds.has(oldId)) {
        childOps.push({
          kind: 'delete',
          ref: doc(db, 'competitions', competitionId, 'classes', oldId),
          path: `competitions/${competitionId}/classes/${oldId}`,
        });
      }
    }

    // 2c. Competitors (including raw punches & rental/payment flags)
    const existingCompIds = new Set<string>();
    try {
      const cmpSnap = await getDocs(
        query(
          collection(db, 'competitions', competitionId, 'competitors'),
          where('ownerUid', '==', ownerUid)
        )
      );
      cmpSnap.docs.forEach((d) => existingCompIds.add(d.id));
    } catch (err) {
      handleWriteOrOfflineError(err, OperationType.LIST, `competitions/${competitionId}/competitors`);
    }

    const nextCompIds = new Set<string>();
    for (const cmp of ev.competitors) {
      const competitorId = sanitizeFirestoreId(cmp.id, 'cmp');
      nextCompIds.add(competitorId);
      const cmpRef = doc(db, 'competitions', competitionId, 'competitors', competitorId);
      const cmpPath = `competitions/${competitionId}/competitors/${competitorId}`;
      const rawPunches = (cmp.rawReadout?.punches ?? cmp.cardPunches ?? []).slice(0, 192);
      const punchCodes = rawPunches.map((p) => clampInt(p.code, 1, 999, 31));
      const punchTimes = rawPunches.map((p) => clampInt(p.timeSec, 0, 86400, 0));
      const status: RunnerStatus =
        cmp.status === 'REGISTERED' ||
        cmp.status === 'CHECKED' ||
        cmp.status === 'IN_FOREST' ||
        cmp.status === 'PRELIMINARY_FIN' ||
        cmp.status === 'OK' ||
        cmp.status === 'MP' ||
        cmp.status === 'DNF' ||
        cmp.status === 'DNS'
          ? cmp.status
          : 'REGISTERED';

      const cmpMutable = {
        bib: clampInt(cmp.bib, 1, 99999, 1),
        fullName: (cmp.fullName || 'Deltagare').trim().slice(0, 120) || 'Deltagare',
        club: (cmp.club || 'Klubblös').trim().slice(0, 100) || 'Klubblös',
        classId: sanitizeFirestoreId(cmp.classId || 'cls_open', 'cls'),
        siNumber: clampInt(cmp.siNumber, 1, 99999999, 1000),
        cardSeries: (cmp.cardSeries || 'SI-Card 10').trim().slice(0, 24) || 'SI-Card 10',
        isRentalCard: Boolean(cmp.isRentalCard),
        rentalReturned: Boolean(cmp.rentalReturned),
        feePaid: Boolean(cmp.feePaid),
        status,
        allocatedStartSec: encodeNullableSec(cmp.allocatedStartSec),
        checkTimeSec: encodeNullableSec(cmp.rawReadout?.checkTimeSec ?? cmp.checkTimeSec),
        startTimeSec: encodeNullableSec(cmp.rawReadout?.startTimeSec ?? cmp.startTimeSec),
        finishTimeSec: encodeNullableSec(cmp.rawReadout?.finishTimeSec ?? cmp.finishTimeSec),
        manualFinishTimeSec: encodeNullableSec(cmp.manualFinishTimeSec),
        runningTimeSec: encodeNullableSec(cmp.runningTimeSec),
        readoutAtIso: (cmp.readoutAt || '').trim().slice(0, 40),
        punchCodes,
        punchTimes,
      };

      if (existingCompIds.has(competitorId)) {
        childOps.push({
          kind: 'update',
          ref: cmpRef,
          path: cmpPath,
          data: { ...cmpMutable, updatedAt: serverTimestamp() },
        });
      } else {
        childOps.push({
          kind: 'set',
          ref: cmpRef,
          path: cmpPath,
          data: {
            competitorId,
            competitionId,
            ...cmpMutable,
            ownerUid,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          },
        });
      }
    }
    for (const oldId of existingCompIds) {
      if (!nextCompIds.has(oldId)) {
        childOps.push({
          kind: 'delete',
          ref: doc(db, 'competitions', competitionId, 'competitors', oldId),
          path: `competitions/${competitionId}/competitors/${oldId}`,
        });
      }
    }

    if (ev.stations) {
      const existingStationIds = new Set<string>();
      try {
        const stationSnap = await getDocs(
          query(
            collection(db, 'competitions', competitionId, 'stations'),
            where('ownerUid', '==', ownerUid)
          )
        );
        stationSnap.docs.forEach((station) => existingStationIds.add(station.id));
      } catch (err) {
        handleWriteOrOfflineError(err, OperationType.LIST, `competitions/${competitionId}/stations`);
      }

      const nextStationIds = new Set<string>();
      for (const station of ev.stations) {
        const stationId = sanitizeFirestoreId(station.id, 'st');
        nextStationIds.add(stationId);
        const stationRef = doc(db, 'competitions', competitionId, 'stations', stationId);
        const stationMutable = {
          stationCode: clampInt(station.stationCode, 1, 999, 42),
          name: (station.name || 'SI-station').trim().slice(0, 120) || 'SI-station',
          hardwareModel: station.hardwareModel,
          stationFunction: station.stationFunction,
          baudRate: station.baudRate === 4800 ? 4800 : 38400,
          extendedProtocol: Boolean(station.extendedProtocol),
          batteryMv: clampInt(station.batteryMv, 0, 6000, 0),
          firmware: (station.firmware || '').trim().slice(0, 80),
          lastSeenAt: station.lastSeenAt || '',
          active: station.active !== false,
        };
        if (existingStationIds.has(stationId)) {
          childOps.push({
            kind: 'update',
            ref: stationRef,
            path: `competitions/${competitionId}/stations/${stationId}`,
            data: { ...stationMutable, updatedAt: serverTimestamp() },
          });
        } else {
          childOps.push({
            kind: 'set',
            ref: stationRef,
            path: `competitions/${competitionId}/stations/${stationId}`,
            data: {
              stationId,
              competitionId,
              ownerUid,
              ...stationMutable,
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            },
          });
        }
      }
      for (const oldId of existingStationIds) {
        if (!nextStationIds.has(oldId)) {
          childOps.push({
            kind: 'delete',
            ref: doc(db, 'competitions', competitionId, 'stations', oldId),
            path: `competitions/${competitionId}/stations/${oldId}`,
          });
        }
      }
    }

    if (childOps.length > 0) {
      await commitQueuedBatchOps(childOps);
    }

    // Update parent competition metadata (or finalize deferred COMPLETED lock)
    if (existingComp || deferCompletedLock) {
      try {
        await updateDoc(doc(db, 'competitions', competitionId), {
          ...compMutableBase,
          status: targetStatus,
          updatedAt: serverTimestamp(),
        });
      } catch (err) {
        handleWriteOrOfflineError(err, OperationType.UPDATE, compPath);
      }
    }

    syncedEvents += 1;
  }

  // 3. Remove any competitions owned by this user that were deleted locally
  try {
    const ownedSnap = await getDocs(
      query(collection(db, 'competitions'), where('ownerUid', '==', ownerUid))
    );
    for (const compDoc of ownedSnap.docs) {
      if (!activeCompSet.has(compDoc.id)) {
        await deleteCompetitionFromFirestore(compDoc.id);
      }
    }
  } catch (err) {
    handleWriteOrOfflineError(err, OperationType.LIST, 'competitions');
  }

  return { syncedEvents };
}

/**
 * Loads the complete season or a single competition from Firestore.
 * Returns null if `clubSettings/default` has not been created yet so fresh apps sync upward first.
 */
export async function loadFullSeasonFromFirestore(options?: {
  competitionId?: string;
  includeRunnerDb?: boolean;
}): Promise<CloudSeasonSnapshot | null> {
  const clubPath = 'clubSettings/default';

  interface CloudClubDocData {
    clubName?: string;
    eventorOrgId?: string;
    swishNumber?: string;
    swishRecipientName?: string;
    defaultDirectEntryFeeSek?: number;
    rentalCardFeeSek?: number;
    missingRentalFeeSek?: number;
    portalTitle?: string;
    logoDataUrl?: string;
    customBgColor?: string;
    customTextColor?: string;
    customAccentColor?: string;
    seriesScoringSettings?: unknown;
    activeEventId?: string;
    demoCleared?: boolean;
    competitionIds?: string[];
  }

  let clubData: CloudClubDocData | null = null;

  try {
    const clubSnap = await getDoc(doc(db, 'clubSettings', 'default'));
    if (clubSnap.exists()) {
      clubData = clubSnap.data() as CloudClubDocData;
    }
  } catch (err) {
    if (isTransientOfflineFirestoreError(err)) {
      if (isTokenServiceError(err)) {
        setTokenServiceDisabled(true);
        void signOut(auth).catch(() => {});
      }
      return null;
    }
    handleFirestoreError(err, OperationType.GET, clubPath);
  }

  const clubSettings: ClubSettings = {
    clubName: (clubData?.clubName || 'OK Österåker').trim().slice(0, 100) || 'OK Österåker',
    eventorOrgId: clubData?.eventorOrgId || '',
    swishNumber: clubData?.swishNumber || '',
    swishRecipientName: clubData?.swishRecipientName || '',
    defaultDirectEntryFeeSek: Number(clubData?.defaultDirectEntryFeeSek ?? 0),
    rentalCardFeeSek: Number(clubData?.rentalCardFeeSek ?? 0),
    missingRentalFeeSek: Number(clubData?.missingRentalFeeSek ?? 0),
    portalTitle: (clubData?.portalTitle || '').trim().slice(0, 80),
    logoDataUrl: sanitizeCloudLogoDataUrl(clubData?.logoDataUrl),
    customBgColor: sanitizeCloudHexColor(clubData?.customBgColor),
    customTextColor: sanitizeCloudHexColor(clubData?.customTextColor),
    customAccentColor: sanitizeCloudHexColor(clubData?.customAccentColor),
    seriesScoringSettings: normalizeSeriesScoringSettings(clubData?.seriesScoringSettings),
  };

  let targetIds = options?.competitionId
    ? [sanitizeFirestoreId(options.competitionId, 'evt')]
    : Array.isArray(clubData?.competitionIds)
      ? clubData.competitionIds
      : [];
  
  // Merge targetIds with all reachable competitions from /competitions directly
  try {
    const compCol = collection(db, 'competitions');
    const compListSnap = await getDocs(compCol).catch(async () => {
      const current = auth.currentUser;
      return current ? await getDocs(query(compCol, where('ownerUid', '==', current.uid))) : null;
    });
    if (compListSnap) {
      const colIds = compListSnap.docs.map((d) => d.id);
      targetIds = Array.from(new Set([...targetIds, ...colIds]));
    }
  } catch {
    // If collection listing is restricted, keep existing targetIds
  }

  if (targetIds.length === 0) {
    return {
      activeEventId: '',
      demoCleared: Boolean(clubData?.demoCleared),
      clubSettings,
      events: [],
      runnerDb: options?.includeRunnerDb === false ? [] : await loadRunnerDbFromFirestore(),
    };
  }

  const events: CloudEventExportItem[] = [];
  for (const rawCompId of targetIds) {
    const competitionId = sanitizeFirestoreId(rawCompId, 'evt');
    const compPath = `competitions/${competitionId}`;
    let compDocData: Record<string, unknown> | null = null;
    try {
      const cSnap = await getDoc(doc(db, 'competitions', competitionId));
      if (cSnap.exists()) {
        compDocData = cSnap.data() as Record<string, unknown>;
      }
    } catch (err) {
      if (isTransientOfflineFirestoreError(err)) {
        return null;
      }
      handleFirestoreError(err, OperationType.GET, compPath);
    }
    if (!compDocData) continue;

    const courses: Course[] = [];
    const classes: CompClass[] = [];
    const competitors: Competitor[] = [];
    const brokenControls = Array.isArray(compDocData.brokenControls)
      ? (compDocData.brokenControls as unknown[]).map(Number)
      : [];
    const controlTimeOffsets = normalizeControlTimeOffsets(compDocData.controlTimeOffsets);
    const emergency: EmergencySettings = { brokenControls, controlTimeOffsets };

    try {
      const crsSnap = await getDocs(
        collection(db, 'competitions', competitionId, 'courses')
      );
      for (const d of crsSnap.docs) {
        const cd = d.data() as {
          courseId: string;
          name: string;
          lengthMeters: number;
          climbMeters: number;
          controls: number[];
        };
        courses.push({
          id: cd.courseId || d.id,
          name: cd.name || 'Bana',
          lengthMeters: Number(cd.lengthMeters || 0),
          climbMeters: Number(cd.climbMeters || 0),
          controls: Array.isArray(cd.controls) ? cd.controls.map(Number) : [],
        });
      }
    } catch (err) {
      if (isTransientOfflineFirestoreError(err)) {
        return null;
      }
      handleFirestoreError(err, OperationType.LIST, `competitions/${competitionId}/courses`);
    }

    try {
      const clsSnap = await getDocs(
        collection(db, 'competitions', competitionId, 'classes')
      );
      for (const d of clsSnap.docs) {
        const cld = d.data() as {
          classId: string;
          name: string;
          courseId: string;
          classFormat: ClassCompetitionFormat;
          forkCourseIds: string[];
          rogainingMaxTimeSec: number;
          rogainingPenaltyPerMin: number;
          allowDirectEntry: boolean;
          freeStart: boolean;
          autoMatchCourse: boolean;
          feeSek: number;
        };
        classes.push({
          id: cld.classId || d.id,
          name: cld.name || 'Klass',
          courseId: cld.courseId ? cld.courseId : null,
          classFormat: cld.classFormat || 'STANDARD',
          forkCourseIds: Array.isArray(cld.forkCourseIds) ? cld.forkCourseIds : [],
          rogainingMaxTimeSec: decodeNullableSec(cld.rogainingMaxTimeSec),
          rogainingPenaltyPerMin:
            Number(cld.rogainingPenaltyPerMin) >= 0 ? Number(cld.rogainingPenaltyPerMin) : null,
          allowDirectEntry: Boolean(cld.allowDirectEntry),
          freeStart: Boolean(cld.freeStart),
          autoMatchCourse: Boolean(cld.autoMatchCourse),
          feeSek: Number(cld.feeSek ?? 100),
        });
      }
    } catch (err) {
      if (isTransientOfflineFirestoreError(err)) {
        return null;
      }
      handleFirestoreError(err, OperationType.LIST, `competitions/${competitionId}/classes`);
    }

    let stationDocs: DocumentSnapshot[] = [];
    try {
      const stationSnapshots = await getDocs(
        collection(db, 'competitions', competitionId, 'stations')
      );
      stationDocs = stationSnapshots.docs;
    } catch (err) {
      if (isTransientOfflineFirestoreError(err)) {
        return null;
      }
      if (isPermissionDeniedFirestoreError(err)) {
        console.error(
          `Behörighet saknas för stationsinställningar i competitions/${competitionId}/stations:`,
          err
        );
      } else {
        handleFirestoreError(err, OperationType.LIST, `competitions/${competitionId}/stations`);
      }
    }
    const stationFunctions = new Map<number, StationFunction>();
    for (const stationDoc of stationDocs) {
      const station = stationDoc.data();
      if (!station) continue;
      const code = Number(station.stationCode);
      const stationFunction = station.stationFunction as StationFunction;
      if (Number.isInteger(code) && code >= 1 && code <= 999) {
        stationFunctions.set(code, stationFunction);
      }
    }

    try {
      const cmpSnap = await getDocs(
        collection(db, 'competitions', competitionId, 'competitors')
      );
      for (const d of cmpSnap.docs) {
        const cmd = d.data() as {
          competitorId: string;
          bib: number;
          fullName: string;
          club: string;
          classId: string;
          siNumber: number;
          cardSeries: SICardSeries;
          isRentalCard: boolean;
          rentalReturned: boolean;
          feePaid: boolean;
          status: RunnerStatus;
          allocatedStartSec: number;
          checkTimeSec: number;
          startTimeSec: number;
          finishTimeSec: number;
          manualFinishTimeSec: number;
          runningTimeSec: number;
          readoutAtIso: string;
          punchCodes: number[];
          punchTimes: number[];
        };
        const codes = Array.isArray(cmd.punchCodes) ? cmd.punchCodes.map(Number) : [];
        const times = Array.isArray(cmd.punchTimes) ? cmd.punchTimes.map(Number) : [];
        const len = Math.min(codes.length, times.length);
        const punches = [];
        for (let idx = 0; idx < len; idx++) {
          punches.push({ code: codes[idx], timeSec: times[idx] });
        }
        const checkSec = decodeNullableSec(cmd.checkTimeSec);
        const startSec = decodeNullableSec(cmd.startTimeSec);
        const finishSec = decodeNullableSec(cmd.finishTimeSec);
        const manualFinishSec = decodeNullableSec(cmd.manualFinishTimeSec);
        const allocatedStartSec = decodeNullableSec(cmd.allocatedStartSec);
        const hasReadout = Boolean(cmd.readoutAtIso) || punches.length > 0;
        const effectiveFinish = manualFinishSec ?? finishSec;
        const validation =
          hasReadout && effectiveFinish !== null
            ? validateCompetitorReadout(
                classes.find((candidate) => candidate.id === cmd.classId),
                courses,
                startSec ??
                  allocatedStartSec ??
                  Number(compDocData.zeroTimeSec ?? 36000),
                effectiveFinish,
                punches,
                  emergency
              )
            : null;

        competitors.push({
          id: cmd.competitorId || d.id,
          bib: Number(cmd.bib || 1),
          fullName: cmd.fullName || 'Deltagare',
          club: cmd.club || 'Klubblös',
          classId: cmd.classId || classes[0]?.id || 'cls_open',
          siNumber: Number(cmd.siNumber || 1000),
          cardSeries: cmd.cardSeries || 'SI-Card 10',
          isRentalCard: Boolean(cmd.isRentalCard),
          rentalReturned: Boolean(cmd.rentalReturned),
          feePaid: Boolean(cmd.feePaid),
          status: cmd.status || 'REGISTERED',
          allocatedStartSec,
          checkTimeSec: checkSec,
          startTimeSec: startSec,
          finishTimeSec: finishSec,
          manualFinishTimeSec: manualFinishSec,
          runningTimeSec: decodeNullableSec(cmd.runningTimeSec),
          lastSeenControl: punches.length > 0 ? 1 : null,
          lastSeenTimeSec: finishSec ?? startSec ?? checkSec,
          readoutAt: cmd.readoutAtIso ? cmd.readoutAtIso : null,
          radioSplits: [],
          cardPunches: punches,
          rawReadout: hasReadout
            ? {
                checkTimeSec: checkSec,
                startTimeSec: startSec,
                finishTimeSec: finishSec,
                punches,
                receivedAt: cmd.readoutAtIso || new Date().toISOString(),
              }
            : null,
          validation,
        });
      }
      let stationPunchDocs: DocumentSnapshot[] = [];
      try {
        const stationPunchSnap = await getDocs(
          collection(db, 'competitions', competitionId, 'stationPunches')
        );
        stationPunchDocs = stationPunchSnap.docs;
      } catch (err) {
        if (isTransientOfflineFirestoreError(err)) {
          return null;
        }
        if (isPermissionDeniedFirestoreError(err)) {
          console.error(
            `Behörighet saknas för radiostämplingar i competitions/${competitionId}/stationPunches:`,
            err
          );
        } else {
          handleFirestoreError(
            err,
            OperationType.LIST,
            `competitions/${competitionId}/stationPunches`
          );
        }
      }
      for (const punchDoc of stationPunchDocs) {
        const punch = punchDoc.data();
        if (!punch) continue;
        const stationFunction =
          stationFunctions.get(Number(punch.stationCode)) ?? 'RADIO';
        if (
          stationFunction !== 'RADIO' &&
          stationFunction !== 'PREWARNING'
        ) {
          continue;
        }
        const competitor = competitors.find(
          (candidate) =>
            candidate.id === punch.competitorId &&
            candidate.siNumber === Number(punch.siNumber)
        );
        if (!competitor) continue;
        const split = {
          controlCode: Number(punch.stationCode),
          stationName: String(punch.stationName || `(${punch.stationCode})`),
          punchTimeSec: Number(punch.punchTimeSec),
          runningTimeSec: decodeNullableSec(punch.runningTimeSec),
          isPrewarning: stationFunction === 'PREWARNING',
        };
        competitor.radioSplits = [
          ...competitor.radioSplits.filter(
            (existing) => existing.controlCode !== split.controlCode
          ),
          split,
        ].sort((a, b) => a.punchTimeSec - b.punchTimeSec);
      }
      competitors.sort((a, b) => a.bib - b.bib);
    } catch (err) {
      if (isTransientOfflineFirestoreError(err)) {
        return null;
      }
      handleFirestoreError(err, OperationType.LIST, `competitions/${competitionId}/competitors`);
    }

    const statusRaw = String(compDocData.status || 'LIVE');
    const status: EventLifecycleStatus =
      statusRaw === 'LIVE' || statusRaw === 'UPCOMING' || statusRaw === 'COMPLETED'
        ? statusRaw
        : 'LIVE';
    const stations: SIStation[] = stationDocs.flatMap((stationDoc) => {
      const station = stationDoc.data();
      if (!station) return [];
      const hardwareModels: SIStation['hardwareModel'][] = [
        'BSM8-USB',
        'BSM7-USB',
        'SRR-USB (Air+)',
        'BSF9 Master',
        'BSF8 Master',
      ];
      const stationFunctions: StationFunction[] = [
        'CLEAR',
        'CHECK',
        'START',
        'RADIO',
        'PREWARNING',
        'FINISH',
        'READOUT',
      ];
      return [{
        id: station.stationId || stationDoc.id,
        stationCode: Number(station.stationCode || 42),
        name: String(station.name || `Station ${station.stationCode || 42}`),
        hardwareModel: hardwareModels.includes(station.hardwareModel)
          ? station.hardwareModel
          : 'SRR-USB (Air+)',
        stationFunction: stationFunctions.includes(station.stationFunction)
          ? station.stationFunction
          : 'RADIO',
        baudRate: station.baudRate === 4800 ? 4800 : 38400,
        extendedProtocol: Boolean(station.extendedProtocol),
        batteryMv: Number(station.batteryMv || 0),
        firmware: String(station.firmware || ''),
        lastSeenAt: typeof station.lastSeenAt === 'string' && station.lastSeenAt
          ? station.lastSeenAt
          : null,
        active: station.active !== false,
      }];
    });

    events.push({
      competition: {
        id: competitionId,
        shortCode: String(compDocData.shortCode || 'oko26'),
        status,
        name: String(compDocData.name || 'Tävling'),
        organizer: String(compDocData.organizer || clubSettings.clubName),
        date: String(compDocData.date || getStockholmTodayIso()),
        zeroTimeStr: String(compDocData.zeroTimeStr || '10:00:00'),
        zeroTimeSec: Number(compDocData.zeroTimeSec ?? 36000),
        arenaInfo: String(compDocData.arenaInfo || ''),
        seriesName: String(compDocData.seriesName || ''),
        enableFeesAndSwish: Boolean(compDocData.enableFeesAndSwish),
      },
      courses,
      classes,
      competitors,
      stations,
      brokenControls,
      emergency,
      rolePins: {
        START: String(compDocData.pinStart || '1100'),
        READOUT: String(compDocData.pinReadout || '2200'),
        FOREST: String(compDocData.pinForest || '3300'),
        SPEAKER: String(compDocData.pinSpeaker || '4400'),
      },
      pinsCustomized: Boolean(compDocData.pinsCustomized),
    });
  }

  return {
    activeEventId: clubData?.activeEventId || events[0]?.competition.id || '',
    demoCleared: Boolean(clubData?.demoCleared),
    clubSettings,
    events,
    seriesStandings: calculateSeriesStandings(
      events.map((event) => ({
        competition: event.competition,
        classes: event.classes,
        competitors: event.competitors,
      })),
      clubSettings.seriesScoringSettings
    ),
    runnerDb: options?.includeRunnerDb === false ? [] : await loadRunnerDbFromFirestore(),
  };
}

async function loadRunnerDbFromFirestore(): Promise<RunnerDbEntry[]> {
  const current = auth.currentUser;
  if (!current?.emailVerified) return [];
  const isBootstrapAdmin = BOOTSTRAP_SUPER_ADMIN_EMAILS.includes(
    (current.email || '').toLowerCase()
  );
  const adminSnap = isBootstrapAdmin
    ? null
    : await getDoc(doc(db, 'admins', sanitizeFirestoreId(current.uid, 'usr')));
  const role = adminSnap?.exists() ? adminSnap.data().role : null;
  if (!isBootstrapAdmin && role !== 'RACE_ADMIN' && role !== 'SUPER_ADMIN') return [];

  const runnerSnap = await getDocs(collection(db, 'runnerDb'));
  return runnerSnap.docs.flatMap((runnerDoc) => {
    const data = runnerDoc.data();
    const siNumber = Number(data.siNumber);
    if (!Number.isInteger(siNumber) || siNumber < 1 || siNumber > 99999999) return [];
    const cardSeries = [
      'SI-Card 5',
      'SI-Card 6',
      'SI-Card 8',
      'SI-Card 9',
      'SI-Card 10',
      'SI-Card 11',
      'SIAC Air+',
    ].includes(data.cardSeries)
      ? (data.cardSeries as SICardSeries)
      : 'SI-Card 10';
    const source =
      data.source === 'EVENTOR_API' ||
      data.source === 'EVENTOR_XML' ||
      data.source === 'MEOS_CSV'
        ? data.source
        : 'LEARNED_ENTRY';
    return [
      {
        id: runnerDoc.id,
        siNumber,
        cardSeries,
        fullName: String(data.fullName || ''),
        club: String(data.club || ''),
        birthYear:
          typeof data.birthYear === 'number' && Number.isInteger(data.birthYear)
            ? data.birthYear
            : null,
        defaultClassName:
          typeof data.defaultClassName === 'string' ? data.defaultClassName : null,
        eventorPersonId: typeof data.eventorPersonId === 'string' ? data.eventorPersonId : null,
        eventorOrgId: typeof data.eventorOrgId === 'string' ? data.eventorOrgId : null,
        source,
        updatedAt:
          typeof data.updatedAtIso === 'string' ? data.updatedAtIso : new Date(0).toISOString(),
      },
    ];
  });
}

export async function saveCompetitionImportToFirestore(params: {
  competitionId: string;
  courses: Course[];
  classes: CompClass[];
  competitors: Competitor[];
  runnerDbEntries: RunnerDbEntry[];
  competitorCount: number;
  replaceCoursesAndClasses?: boolean;
}): Promise<void> {
  const current = await ensureValidFirestoreUser();
  if (
    !current ||
    !current.emailVerified ||
    !current.providerData.some((provider) => provider.providerId === 'google.com')
  ) {
    throw new Error('Importen kräver ett inloggat, verifierat Google-administratörskonto.');
  }
  const adminSnap = await getDoc(doc(db, 'admins', sanitizeFirestoreId(current.uid, 'usr')));
  const role = adminSnap.exists() ? adminSnap.data().role : null;
  const isBootstrapAdmin = BOOTSTRAP_SUPER_ADMIN_EMAILS.includes(
    (current.email || '').toLowerCase()
  );
  if (!isBootstrapAdmin && role !== 'RACE_ADMIN' && role !== 'SUPER_ADMIN') {
    throw new Error('Ditt Google-konto saknar administratörsbehörighet för Firestore-import.');
  }

  const competitionId = sanitizeFirestoreId(params.competitionId, 'evt');
  const competitionRef = doc(db, 'competitions', competitionId);
  const competitionSnap = await getDoc(competitionRef);
  if (!competitionSnap.exists()) {
    throw new Error('Tävlingen hittades inte i Firestore.');
  }
  const competitionData = competitionSnap.data();
  const isSuperAdmin = isBootstrapAdmin || role === 'SUPER_ADMIN';
  if (competitionData.ownerUid !== current.uid && !isSuperAdmin) {
    throw new Error('Du saknar behörighet att importera data till den här tävlingen.');
  }
  if (competitionData.status === 'COMPLETED' && !isSuperAdmin) {
    throw new Error('Import kan inte göras till en avslutad tävling.');
  }

  const operations: Array<{
    ref: DocumentReference;
    existing: boolean;
    mutable: Record<string, unknown>;
    createData: Record<string, unknown>;
  }> = [];
  const ownerUid = sanitizeFirestoreId(current.uid, 'usr');
  const nowFields = { createdAt: serverTimestamp(), updatedAt: serverTimestamp() };

  const addOperation = async (
    collectionName: 'courses' | 'classes' | 'competitors',
    id: string,
    mutable: Record<string, unknown>,
    createData: Record<string, unknown>
  ) => {
    const ref = doc(db, 'competitions', competitionId, collectionName, id);
    const snap = await getDoc(ref);
    if (snap.exists() && snap.data().ownerUid !== ownerUid && !isSuperAdmin) {
      throw new Error('Importerad data tillhör ett annat konto.');
    }
    operations.push({ ref, existing: snap.exists(), mutable, createData });
  };

  for (const course of params.courses) {
    const id = sanitizeFirestoreId(course.id, 'crs');
    const mutable = {
      name: (course.name || 'Bana').trim().slice(0, 120) || 'Bana',
      lengthMeters: clampInt(course.lengthMeters, 0, 200000, 0),
      climbMeters: clampInt(course.climbMeters, 0, 20000, 0),
      controls: (course.controls || []).slice(0, 128).map((code) => clampInt(code, 1, 999, 31)),
    };
    await addOperation('courses', id, mutable, {
      courseId: id,
      competitionId,
      ...mutable,
      ownerUid,
      ...nowFields,
    });
  }

  for (const cls of params.classes) {
    const id = sanitizeFirestoreId(cls.id, 'cls');
    const classFormat: ClassCompetitionFormat =
      cls.classFormat === 'FORKED' || cls.classFormat === 'ROGAINING'
        ? cls.classFormat
        : 'STANDARD';
    const mutable = {
      name: (cls.name || 'Klass').trim().slice(0, 80) || 'Klass',
      courseId: cls.courseId ? sanitizeFirestoreId(cls.courseId, 'crs') : '',
      classFormat,
      forkCourseIds: (cls.forkCourseIds || [])
        .slice(0, 32)
        .map((courseId) => sanitizeFirestoreId(courseId, 'crs')),
      rogainingMaxTimeSec:
        cls.rogainingMaxTimeSec !== null && cls.rogainingMaxTimeSec !== undefined
          ? clampInt(cls.rogainingMaxTimeSec, 0, 86400, -1)
          : -1,
      rogainingPenaltyPerMin:
        cls.rogainingPenaltyPerMin !== null && cls.rogainingPenaltyPerMin !== undefined
          ? clampInt(cls.rogainingPenaltyPerMin, 0, 1000, -1)
          : -1,
      allowDirectEntry: Boolean(cls.allowDirectEntry),
      freeStart: Boolean(cls.freeStart),
      autoMatchCourse: Boolean(cls.autoMatchCourse),
      feeSek: clampInt(cls.feeSek, 0, 10000, 100),
    };
    await addOperation('classes', id, mutable, {
      classId: id,
      competitionId,
      ...mutable,
      ownerUid,
      ...nowFields,
    });
  }

  for (const competitor of params.competitors) {
    const id = sanitizeFirestoreId(competitor.id, 'cmp');
    const punches = (competitor.rawReadout?.punches ?? competitor.cardPunches ?? []).slice(0, 192);
    const mutable = {
      bib: clampInt(competitor.bib, 1, 99999, 1),
      fullName: (competitor.fullName || 'Deltagare').trim().slice(0, 120) || 'Deltagare',
      club: (competitor.club || 'Klubblös').trim().slice(0, 100) || 'Klubblös',
      classId: sanitizeFirestoreId(competitor.classId || 'cls_open', 'cls'),
      siNumber: clampInt(competitor.siNumber, 1, 99999999, 1000),
      cardSeries: competitor.cardSeries || 'SI-Card 10',
      isRentalCard: Boolean(competitor.isRentalCard),
      rentalReturned: Boolean(competitor.rentalReturned),
      feePaid: Boolean(competitor.feePaid),
      status: competitor.status || 'REGISTERED',
      allocatedStartSec: encodeNullableSec(competitor.allocatedStartSec),
      checkTimeSec: encodeNullableSec(competitor.checkTimeSec),
      startTimeSec: encodeNullableSec(competitor.startTimeSec),
      finishTimeSec: encodeNullableSec(competitor.finishTimeSec),
      manualFinishTimeSec: encodeNullableSec(competitor.manualFinishTimeSec),
      runningTimeSec: encodeNullableSec(competitor.runningTimeSec),
      readoutAtIso: (competitor.readoutAt || '').slice(0, 40),
      punchCodes: punches.map((punch) => clampInt(punch.code, 1, 999, 31)),
      punchTimes: punches.map((punch) => clampInt(punch.timeSec, 0, 86400, 0)),
    };
    await addOperation('competitors', id, mutable, {
      competitorId: id,
      competitionId,
      ...mutable,
      ownerUid,
      ...nowFields,
    });
  }

  for (const runner of params.runnerDbEntries) {
    if (!Number.isInteger(runner.siNumber) || runner.siNumber < 1 || runner.siNumber > 99999999) {
      continue;
    }
    const id = String(runner.siNumber);
    const ref = doc(db, 'runnerDb', id);
    const snap = await getDoc(ref);
    const mutable = {
      siNumber: runner.siNumber,
      cardSeries: runner.cardSeries,
      fullName: (runner.fullName || '').trim().slice(0, 120),
      club: (runner.club || '').trim().slice(0, 100),
      birthYear:
        runner.birthYear !== null &&
        runner.birthYear !== undefined &&
        Number.isInteger(runner.birthYear)
          ? runner.birthYear
          : null,
      defaultClassName: (runner.defaultClassName || '').trim().slice(0, 80),
      eventorPersonId: (runner.eventorPersonId || '').trim().slice(0, 128),
      eventorOrgId: (runner.eventorOrgId || '').trim().slice(0, 32),
      source: runner.source,
      updatedAtIso: runner.updatedAt,
    };
    if (snap.exists()) {
      operations.push({ ref, existing: true, mutable, createData: {} });
    } else {
      operations.push({
        ref,
        existing: false,
        mutable,
        createData: {
          runnerId: id,
          ...mutable,
          ownerUid,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        },
      });
    }
  }

  for (let offset = 0; offset < operations.length; offset += 400) {
    const batch = writeBatch(db);
    for (const operation of operations.slice(offset, offset + 400)) {
      if (operation.existing) {
        batch.update(operation.ref, {
          ...operation.mutable,
          updatedAt: serverTimestamp(),
        });
      } else {
        batch.set(operation.ref, operation.createData);
      }
    }
    await batch.commit();
  }

  if (params.replaceCoursesAndClasses) {
    const retainedIds = {
      courses: new Set(params.courses.map((course) => sanitizeFirestoreId(course.id, 'crs'))),
      classes: new Set(params.classes.map((cls) => sanitizeFirestoreId(cls.id, 'cls'))),
    };
    const staleRefs: DocumentReference[] = [];
    for (const collectionName of ['courses', 'classes'] as const) {
      const snapshots = await getDocs(
        collection(db, 'competitions', competitionId, collectionName)
      );
      for (const snapshot of snapshots.docs) {
        if (
          !retainedIds[collectionName].has(snapshot.id) &&
          (snapshot.data().ownerUid === ownerUid || isSuperAdmin)
        ) {
          staleRefs.push(snapshot.ref);
        }
      }
    }
    for (let offset = 0; offset < staleRefs.length; offset += 400) {
      const batch = writeBatch(db);
      for (const ref of staleRefs.slice(offset, offset + 400)) batch.delete(ref);
      await batch.commit();
    }
  }

  await updateDoc(competitionRef, {
    competitorCount: clampInt(params.competitorCount, 0, 50000, 0),
    finishedCount: Math.min(
      clampInt(params.competitorCount, 0, 50000, 0),
      params.competitors.filter((competitor) =>
        ['OK', 'MP', 'PRELIMINARY_FIN'].includes(competitor.status)
      ).length
    ),
    updatedAt: serverTimestamp(),
  });
}

interface CompetitionMutationContext {
  competitionId: string;
  ownerUid: string;
  isSuperAdmin: boolean;
}

async function getCompetitionMutationContext(
  rawCompetitionId: string
): Promise<CompetitionMutationContext> {
  const current = await ensureValidFirestoreUser();
  if (
    !current ||
    !current.emailVerified ||
    !current.providerData.some((provider) => provider.providerId === 'google.com')
  ) {
    throw new Error('Ändringen kräver ett inloggat, verifierat Google-administratörskonto.');
  }

  const ownerUid = sanitizeFirestoreId(current.uid, 'usr');
  const isBootstrapAdmin = BOOTSTRAP_SUPER_ADMIN_EMAILS.includes(
    (current.email || '').toLowerCase()
  );
  const adminSnap = isBootstrapAdmin
    ? null
    : await getDoc(doc(db, 'admins', ownerUid));
  const role = adminSnap?.exists() ? adminSnap.data().role : null;
  const isSuperAdmin = isBootstrapAdmin || role === 'SUPER_ADMIN';
  if (!isSuperAdmin && role !== 'RACE_ADMIN') {
    throw new Error('Ditt Google-konto saknar administratörsbehörighet för Firestore.');
  }

  const competitionId = sanitizeFirestoreId(rawCompetitionId, 'evt');
  const competitionSnap = await getDoc(doc(db, 'competitions', competitionId));
  if (!competitionSnap.exists()) {
    throw new Error('Tävlingen hittades inte i Firestore.');
  }
  const competition = competitionSnap.data();
  if (competition.ownerUid !== current.uid && !isSuperAdmin) {
    throw new Error('Ditt konto saknar behörighet att ändra den här tävlingen.');
  }
  if (competition.status === 'COMPLETED' && !isSuperAdmin) {
    throw new Error('Det går inte att ändra en avslutad tävling.');
  }

  return { competitionId, ownerUid, isSuperAdmin };
}

export async function saveCourseToFirestore(
  competitionId: string,
  payload: Partial<Course>,
  existingId?: string
): Promise<Course> {
  const context = await getCompetitionMutationContext(competitionId);
  const id = existingId
    ? sanitizeFirestoreId(existingId, 'crs')
    : doc(collection(db, 'competitions', context.competitionId, 'courses')).id;
  const ref = doc(db, 'competitions', context.competitionId, 'courses', id);
  const mutable = {
    name: (payload.name || '').trim().slice(0, 120),
    lengthMeters: clampInt(payload.lengthMeters, 0, 200000, 0),
    climbMeters: clampInt(payload.climbMeters, 0, 20000, 0),
    controls: (payload.controls || []).slice(0, 128).map((code) => clampInt(code, 1, 999, 31)),
  };
  if (!mutable.name || mutable.controls.length === 0) {
    throw new Error('Banan måste ha ett namn och minst en kontroll.');
  }

  const existing = await getDoc(ref);
  if (existing.exists()) {
    if (existing.data().ownerUid !== context.ownerUid && !context.isSuperAdmin) {
      throw new Error('Banan tillhör ett annat administratörskonto.');
    }
    await updateDoc(ref, { ...mutable, updatedAt: serverTimestamp() });
  } else {
    await setDoc(ref, {
      courseId: id,
      competitionId: context.competitionId,
      ...mutable,
      ownerUid: context.ownerUid,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  }
  return { id, ...mutable };
}

export async function deleteCourseFromFirestore(
  competitionId: string,
  courseId: string
): Promise<void> {
  const context = await getCompetitionMutationContext(competitionId);
  const id = sanitizeFirestoreId(courseId, 'crs');
  await deleteDoc(doc(db, 'competitions', context.competitionId, 'courses', id));
}

export async function saveClassToFirestore(
  competitionId: string,
  payload: Partial<CompClass>,
  existingId?: string
): Promise<CompClass> {
  const context = await getCompetitionMutationContext(competitionId);
  const id = existingId
    ? sanitizeFirestoreId(existingId, 'cls')
    : doc(collection(db, 'competitions', context.competitionId, 'classes')).id;
  const ref = doc(db, 'competitions', context.competitionId, 'classes', id);
  const classFormat: ClassCompetitionFormat =
    payload.classFormat === 'FORKED' || payload.classFormat === 'ROGAINING'
      ? payload.classFormat
      : 'STANDARD';
  const mutable: {
    name: string;
    courseId: string;
    classFormat: ClassCompetitionFormat;
    forkCourseIds: string[];
    rogainingMaxTimeSec: number;
    rogainingPenaltyPerMin: number;
    allowDirectEntry: boolean;
    freeStart: boolean;
    autoMatchCourse: boolean;
    feeSek: number;
  } = {
    name: (payload.name || '').trim().slice(0, 80),
    courseId: payload.courseId ? sanitizeFirestoreId(payload.courseId, 'crs') : '',
    classFormat,
    forkCourseIds: (payload.forkCourseIds || [])
      .slice(0, 32)
      .map((courseId) => sanitizeFirestoreId(courseId, 'crs')),
    rogainingMaxTimeSec:
      payload.rogainingMaxTimeSec !== null && payload.rogainingMaxTimeSec !== undefined
        ? clampInt(payload.rogainingMaxTimeSec, 60, 86400, 2700)
        : -1,
    rogainingPenaltyPerMin:
      payload.rogainingPenaltyPerMin !== null && payload.rogainingPenaltyPerMin !== undefined
        ? clampInt(payload.rogainingPenaltyPerMin, 0, 1000, 10)
        : -1,
    allowDirectEntry: payload.allowDirectEntry !== false,
    freeStart: payload.freeStart !== false,
    autoMatchCourse: Boolean(payload.autoMatchCourse),
    feeSek: clampInt(payload.feeSek, 0, 10000, 100),
  };
  if (!mutable.name) {
    throw new Error('Klassen måste ha ett namn.');
  }

  const existing = await getDoc(ref);
  if (existing.exists()) {
    if (existing.data().ownerUid !== context.ownerUid && !context.isSuperAdmin) {
      throw new Error('Klassen tillhör ett annat administratörskonto.');
    }
    if (payload.feeSek === undefined) {
      mutable.feeSek = clampInt(existing.data().feeSek, 0, 10000, 100);
    }
    await updateDoc(ref, { ...mutable, updatedAt: serverTimestamp() });
  } else {
    await setDoc(ref, {
      classId: id,
      competitionId: context.competitionId,
      ...mutable,
      ownerUid: context.ownerUid,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  }
  return {
    id,
    ...mutable,
    courseId: mutable.courseId || null,
    rogainingMaxTimeSec: mutable.rogainingMaxTimeSec < 0 ? null : mutable.rogainingMaxTimeSec,
    rogainingPenaltyPerMin:
      mutable.rogainingPenaltyPerMin < 0 ? null : mutable.rogainingPenaltyPerMin,
  };
}

export async function deleteClassFromFirestore(
  competitionId: string,
  classId: string
): Promise<void> {
  const context = await getCompetitionMutationContext(competitionId);
  const id = sanitizeFirestoreId(classId, 'cls');
  await deleteDoc(doc(db, 'competitions', context.competitionId, 'classes', id));
}

export async function saveStationToFirestore(
  competitionId: string,
  payload: Partial<SIStation>
): Promise<SIStation> {
  const context = await getCompetitionMutationContext(competitionId);
  const id = payload.id
    ? sanitizeFirestoreId(payload.id, 'st')
    : doc(collection(db, 'competitions', context.competitionId, 'stations')).id;
  const ref = doc(db, 'competitions', context.competitionId, 'stations', id);
  const hardwareModels: SIStation['hardwareModel'][] = [
    'BSM8-USB',
    'BSM7-USB',
    'SRR-USB (Air+)',
    'BSF9 Master',
    'BSF8 Master',
  ];
  const stationFunctions: StationFunction[] = [
    'CLEAR',
    'CHECK',
    'START',
    'RADIO',
    'PREWARNING',
    'FINISH',
    'READOUT',
  ];
  const station: SIStation = {
    id,
    stationCode: clampInt(payload.stationCode, 1, 999, 42),
    name: (payload.name || '').trim().slice(0, 120),
    hardwareModel: hardwareModels.includes(payload.hardwareModel as SIStation['hardwareModel'])
      ? (payload.hardwareModel as SIStation['hardwareModel'])
      : 'SRR-USB (Air+)',
    stationFunction: stationFunctions.includes(payload.stationFunction as StationFunction)
      ? (payload.stationFunction as StationFunction)
      : 'RADIO',
    baudRate: payload.baudRate === 4800 ? 4800 : 38400,
    extendedProtocol: Boolean(payload.extendedProtocol),
    batteryMv: clampInt(payload.batteryMv, 0, 6000, 0),
    firmware: (payload.firmware || '').trim().slice(0, 80),
    lastSeenAt: payload.lastSeenAt || null,
    active: payload.active !== false,
  };
  if (!station.name) throw new Error('Stationen måste ha ett namn.');

  const duplicateStations = await getDocs(
    query(
      collection(db, 'competitions', context.competitionId, 'stations'),
      where('stationCode', '==', station.stationCode)
    )
  );
  if (duplicateStations.docs.some((stationDoc) => stationDoc.id !== id)) {
    throw new Error(`Stationskod CN ${station.stationCode} är redan konfigurerad.`);
  }

  const existing = await getDoc(ref);
  if (existing.exists()) {
    if (existing.data().ownerUid !== context.ownerUid && !context.isSuperAdmin) {
      throw new Error('Stationen tillhör ett annat administratörskonto.');
    }
    await updateDoc(ref, {
      stationCode: station.stationCode,
      name: station.name,
      hardwareModel: station.hardwareModel,
      stationFunction: station.stationFunction,
      baudRate: station.baudRate,
      extendedProtocol: station.extendedProtocol,
      batteryMv: station.batteryMv,
      firmware: station.firmware,
      lastSeenAt: station.lastSeenAt || '',
      active: station.active,
      updatedAt: serverTimestamp(),
    });
  } else {
    await setDoc(ref, {
      stationId: id,
      competitionId: context.competitionId,
      ownerUid: context.ownerUid,
      stationCode: station.stationCode,
      name: station.name,
      hardwareModel: station.hardwareModel,
      stationFunction: station.stationFunction,
      baudRate: station.baudRate,
      extendedProtocol: station.extendedProtocol,
      batteryMv: station.batteryMv,
      firmware: station.firmware,
      lastSeenAt: station.lastSeenAt || '',
      active: station.active,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  }
  return station;
}

export async function deleteStationFromFirestore(
  competitionId: string,
  stationId: string
): Promise<void> {
  const context = await getCompetitionMutationContext(competitionId);
  await deleteDoc(
    doc(
      db,
      'competitions',
      context.competitionId,
      'stations',
      sanitizeFirestoreId(stationId, 'st')
    )
  );
}

export async function updateCompetitorInFirestore(
  competitionId: string,
  competitorId: string,
  patch: Partial<Competitor>
): Promise<void> {
  const context = await getCompetitionMutationContext(competitionId);
  const id = sanitizeFirestoreId(competitorId, 'cmp');
  const mutable: Record<string, unknown> = {};
  const fields: Array<keyof Competitor> = [
    'bib',
    'fullName',
    'club',
    'classId',
    'siNumber',
    'cardSeries',
    'isRentalCard',
    'rentalReturned',
    'feePaid',
    'status',
    'allocatedStartSec',
    'checkTimeSec',
    'startTimeSec',
    'finishTimeSec',
    'manualFinishTimeSec',
    'runningTimeSec',
  ];
  for (const field of fields) {
    if (field in patch) {
      const value = patch[field];
      if (value === undefined) continue;
      mutable[field] =
        field === 'allocatedStartSec' ||
        field === 'checkTimeSec' ||
        field === 'startTimeSec' ||
        field === 'finishTimeSec' ||
        field === 'manualFinishTimeSec' ||
        field === 'runningTimeSec'
          ? encodeNullableSec(value as number | null | undefined)
          : value;
    }
  }
  if ('readoutAt' in patch) {
    mutable.readoutAtIso = (patch.readoutAt || '').slice(0, 40);
  }
  if ('cardPunches' in patch) {
    const punches = (patch.cardPunches || []).slice(0, 192);
    mutable.punchCodes = punches.map((punch) => clampInt(punch.code, 1, 999, 31));
    mutable.punchTimes = punches.map((punch) => clampInt(punch.timeSec, 0, 86400, 0));
  }
  if (Object.keys(mutable).length === 0) return;

  const competitionRef = doc(db, 'competitions', context.competitionId);
  const competitorRef = doc(
    db,
    'competitions',
    context.competitionId,
    'competitors',
    id
  );
  await runTransaction(db, async (transaction) => {
    const [competitionSnap, competitorSnap] = await Promise.all([
      transaction.get(competitionRef),
      transaction.get(competitorRef),
    ]);
    if (!competitionSnap.exists() || !competitorSnap.exists()) {
      throw new Error('Tävlingen eller deltagaren hittades inte i Firestore.');
    }
    const competition = competitionSnap.data();
    const existing = competitorSnap.data();
    if (competition.ownerUid !== context.ownerUid && !context.isSuperAdmin) {
      throw new Error('Ditt konto saknar behörighet att uppdatera deltagaren.');
    }
    transaction.update(competitorRef, { ...mutable, updatedAt: serverTimestamp() });
    if (typeof mutable.status === 'string') {
      const finishedStatuses = new Set(['OK', 'MP', 'PRELIMINARY_FIN']);
      const previouslyFinished = finishedStatuses.has(String(existing.status));
      const willBeFinished = finishedStatuses.has(mutable.status);
      if (previouslyFinished !== willBeFinished) {
        transaction.update(competitionRef, {
          finishedCount: clampInt(
            Number(competition.finishedCount || 0) + (willBeFinished ? 1 : -1),
            0,
            Number(competition.competitorCount || 0),
            0
          ),
          updatedAt: serverTimestamp(),
        });
      }
    }
  });
}

export async function deleteCompetitorFromFirestore(
  competitionId: string,
  competitorId: string
): Promise<void> {
  const context = await getCompetitionMutationContext(competitionId);
  const competitionRef = doc(db, 'competitions', context.competitionId);
  const competitorRef = doc(
    db,
    'competitions',
    context.competitionId,
    'competitors',
    sanitizeFirestoreId(competitorId, 'cmp')
  );

  await runTransaction(db, async (transaction) => {
    const [competitionSnap, competitorSnap] = await Promise.all([
      transaction.get(competitionRef),
      transaction.get(competitorRef),
    ]);
    if (!competitionSnap.exists() || !competitorSnap.exists()) {
      throw new Error('Tävlingen eller deltagaren hittades inte i Firestore.');
    }
    const competition = competitionSnap.data();
    const competitor = competitorSnap.data();
    if (
      competition.ownerUid !== context.ownerUid &&
      !context.isSuperAdmin
    ) {
      throw new Error('Ditt konto saknar behörighet att ta bort deltagaren.');
    }
    if (competition.status === 'COMPLETED' && !context.isSuperAdmin) {
      throw new Error('Deltagare kan inte tas bort från en avslutad tävling.');
    }
    const finished = ['OK', 'MP', 'PRELIMINARY_FIN'].includes(String(competitor.status));
    transaction.delete(competitorRef);
    transaction.update(competitionRef, {
      competitorCount: Math.max(0, Number(competition.competitorCount || 0) - 1),
      ...(finished
        ? { finishedCount: Math.max(0, Number(competition.finishedCount || 0) - 1) }
        : {}),
      updatedAt: serverTimestamp(),
    });
  });
}

export async function deleteRunnerDbEntryFromFirestore(siNumber: number): Promise<void> {
  const current = await ensureValidFirestoreUser();
  if (
    !current ||
    !current.emailVerified ||
    !current.providerData.some((provider) => provider.providerId === 'google.com')
  ) {
    throw new Error('Raderingen kräver ett inloggat, verifierat Google-administratörskonto.');
  }
  const isBootstrapAdmin = BOOTSTRAP_SUPER_ADMIN_EMAILS.includes(
    (current.email || '').toLowerCase()
  );
  const adminSnap = isBootstrapAdmin
    ? null
    : await getDoc(doc(db, 'admins', sanitizeFirestoreId(current.uid, 'usr')));
  const role = adminSnap?.exists() ? adminSnap.data().role : null;
  if (!isBootstrapAdmin && role !== 'RACE_ADMIN' && role !== 'SUPER_ADMIN') {
    throw new Error('Ditt Google-konto saknar administratörsbehörighet.');
  }
  if (!Number.isInteger(siNumber) || siNumber < 1 || siNumber > 99999999) {
    throw new Error('Ogiltigt SI-nummer.');
  }
  await deleteDoc(doc(db, 'runnerDb', String(siNumber)));
}

async function ensureRunnerDbAdmin(): Promise<User> {
  const current = await ensureValidFirestoreUser();
  if (
    !current ||
    !current.emailVerified ||
    !current.providerData.some((provider) => provider.providerId === 'google.com')
  ) {
    throw new Error('Löpardatabasen kräver ett inloggat, verifierat Google-administratörskonto.');
  }
  const isBootstrapAdmin = BOOTSTRAP_SUPER_ADMIN_EMAILS.includes(
    (current.email || '').toLowerCase()
  );
  const adminSnap = isBootstrapAdmin
    ? null
    : await getDoc(doc(db, 'admins', sanitizeFirestoreId(current.uid, 'usr')));
  const role = adminSnap?.exists() ? adminSnap.data().role : null;
  if (!isBootstrapAdmin && role !== 'RACE_ADMIN' && role !== 'SUPER_ADMIN') {
    throw new Error('Ditt Google-konto saknar administratörsbehörighet för löpardatabasen.');
  }
  return current;
}

function runnerDbFirestoreFields(runner: RunnerDbEntry) {
  return {
    siNumber: runner.siNumber,
    cardSeries: runner.cardSeries,
    fullName: runner.fullName.trim().slice(0, 120),
    club: runner.club.trim().slice(0, 100),
    birthYear: runner.birthYear,
    defaultClassName: (runner.defaultClassName || '').trim().slice(0, 80),
    eventorPersonId: (runner.eventorPersonId || '').trim().slice(0, 128),
    eventorOrgId: (runner.eventorOrgId || '').trim().slice(0, 32),
    source: runner.source,
    updatedAtIso: runner.updatedAt,
  };
}

export async function saveRunnerDbEntriesToFirestore(
  runners: RunnerDbEntry[]
): Promise<void> {
  const current = await ensureRunnerDbAdmin();
  const ownerUid = sanitizeFirestoreId(current.uid, 'usr');
  const isBootstrapAdmin = BOOTSTRAP_SUPER_ADMIN_EMAILS.includes(
    (current.email || '').toLowerCase()
  );
  const adminSnap = isBootstrapAdmin
    ? null
    : await getDoc(doc(db, 'admins', ownerUid));
  const isSuperAdmin = isBootstrapAdmin || adminSnap?.data().role === 'SUPER_ADMIN';
  for (let offset = 0; offset < runners.length; offset += 400) {
    const batch = writeBatch(db);
    for (const runner of runners.slice(offset, offset + 400)) {
      if (
        !Number.isInteger(runner.siNumber) ||
        runner.siNumber < 1 ||
        runner.siNumber > 99999999 ||
        !runner.fullName.trim()
      ) {
        continue;
      }
      const id = String(runner.siNumber);
      const runnerRef = doc(db, 'runnerDb', id);
      const existing = await getDoc(runnerRef);
      if (
        existing.exists() &&
        existing.data().ownerUid !== ownerUid &&
        !isSuperAdmin
      ) {
        throw new Error('Importerad löpare tillhör ett annat konto.');
      }
      batch.set(
        runnerRef,
        {
          runnerId: id,
          ...runnerDbFirestoreFields(runner),
          ownerUid,
          ...(!existing.exists() ? { createdAt: serverTimestamp() } : {}),
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );
    }
    await batch.commit();
  }
}

export async function updateRunnerDbEntryInFirestore(
  previousSiNumber: number,
  runner: RunnerDbEntry
): Promise<void> {
  const current = await ensureRunnerDbAdmin();
  if (
    !Number.isInteger(previousSiNumber) ||
    previousSiNumber < 1 ||
    previousSiNumber > 99999999 ||
    !Number.isInteger(runner.siNumber) ||
    runner.siNumber < 1 ||
    runner.siNumber > 99999999 ||
    !runner.fullName.trim()
  ) {
    throw new Error('Ange ett giltigt namn och SI-bricknummer.');
  }

  const previousRef = doc(db, 'runnerDb', String(previousSiNumber));
  const nextRef = doc(db, 'runnerDb', String(runner.siNumber));
  const [previousSnap, nextSnap] = await Promise.all([getDoc(previousRef), getDoc(nextRef)]);
  if (!previousSnap.exists()) {
    throw new Error('Löparen hittades inte i Firestore.');
  }
  const ownerUid = sanitizeFirestoreId(current.uid, 'usr');
  const isBootstrapAdmin = BOOTSTRAP_SUPER_ADMIN_EMAILS.includes(
    (current.email || '').toLowerCase()
  );
  const adminSnap = isBootstrapAdmin
    ? null
    : await getDoc(doc(db, 'admins', ownerUid));
  const isSuperAdmin = isBootstrapAdmin || adminSnap?.data().role === 'SUPER_ADMIN';
  if (previousSnap.data().ownerUid !== ownerUid && !isSuperAdmin) {
    throw new Error('Du saknar behörighet att ändra den här löparen.');
  }
  if (previousSiNumber !== runner.siNumber && nextSnap.exists()) {
    throw new Error('SI-bricknumret finns redan i löpardatabasen.');
  }

  const batch = writeBatch(db);
  batch.set(
    nextRef,
    {
      runnerId: String(runner.siNumber),
      ...runnerDbFirestoreFields(runner),
      ownerUid,
      ...(previousSiNumber !== runner.siNumber
        ? { createdAt: serverTimestamp() }
        : {}),
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );
  if (previousSiNumber !== runner.siNumber) batch.delete(previousRef);
  await batch.commit();
}

export async function recalculateCompetitionFromFirestore(
  competitionId: string,
  patch?: Partial<EmergencySettings>
): Promise<{
  recalculatedCount: number;
  emergency: EmergencySettings;
  competitors: Competitor[];
}> {
  const context = await getCompetitionMutationContext(competitionId);
  const season = await loadFullSeasonFromFirestore({
    competitionId: context.competitionId,
    includeRunnerDb: false,
  });
  const event = season?.events.find(
    (candidate) => candidate.competition.id === context.competitionId
  );
  if (!event) throw new Error('Tävlingen hittades inte i Firestore.');

  const emergency: EmergencySettings = {
    brokenControls: Array.from(
      new Set(
        (patch?.brokenControls ?? event.brokenControls)
          .map((code) => clampInt(code, 1, 999, 31))
      )
    ).slice(0, 64),
    controlTimeOffsets: normalizeControlTimeOffsets(
      patch?.controlTimeOffsets ?? event.emergency?.controlTimeOffsets
    ),
  };
  const competitors = event.competitors.map((runner) => ({ ...runner }));
  const updates: Array<{ ref: DocumentReference; data: Record<string, unknown> }> = [];
  let recalculatedCount = 0;
  for (const runner of competitors) {
    const raw = runner.rawReadout;
    const sourcePunches = raw ? raw.punches : runner.cardPunches;
    const hasReadoutData = Boolean(raw || runner.readoutAt || sourcePunches.length > 0);
    if (!hasReadoutData) continue;

    const effectiveStart =
      runner.startTimeSec ??
      raw?.startTimeSec ??
      runner.allocatedStartSec ??
      event.competition.zeroTimeSec;
    const effectiveFinish =
      runner.manualFinishTimeSec ?? raw?.finishTimeSec ?? runner.finishTimeSec;
    const validation = validateCompetitorReadout(
      event.classes.find((candidate) => candidate.id === runner.classId),
      event.courses,
      effectiveStart,
      effectiveFinish,
      sourcePunches,
      emergency
    );
    runner.cardPunches = applyEmergencyTimeOffsets(
      sourcePunches,
      emergency.controlTimeOffsets
    );
    runner.finishTimeSec = effectiveFinish;
    runner.runningTimeSec =
      effectiveFinish !== null && effectiveFinish >= effectiveStart
        ? effectiveFinish - effectiveStart
        : null;
    runner.validation = validation;
    if (runner.status !== 'DNF' && runner.status !== 'DNS') {
      runner.status = validation.ok ? 'OK' : 'MP';
    }

    updates.push({
      ref: doc(
        db,
        'competitions',
        context.competitionId,
        'competitors',
        sanitizeFirestoreId(runner.id, 'cmp')
      ),
      data: {
        status: runner.status,
        finishTimeSec: encodeNullableSec(runner.finishTimeSec),
        runningTimeSec: encodeNullableSec(runner.runningTimeSec),
        punchCodes: runner.cardPunches.map((punch) => clampInt(punch.code, 1, 999, 31)),
        punchTimes: runner.cardPunches.map((punch) => clampInt(punch.timeSec, 0, 86400, 0)),
        updatedAt: serverTimestamp(),
      },
    });
    recalculatedCount += 1;
  }

  const finishedCount = competitors.filter((runner) =>
    ['OK', 'MP', 'PRELIMINARY_FIN'].includes(runner.status)
  ).length;
  for (let offset = 0; offset < updates.length; offset += 400) {
    const batch = writeBatch(db);
    for (const update of updates.slice(offset, offset + 400)) {
      batch.update(update.ref, update.data);
    }
    await batch.commit();
  }
  await updateDoc(doc(db, 'competitions', context.competitionId), {
    brokenControls: emergency.brokenControls,
    controlTimeOffsets: emergency.controlTimeOffsets,
    finishedCount,
    updatedAt: serverTimestamp(),
  });

  return { recalculatedCount, emergency, competitors };
}

export async function submitOnlinePunchToFirestore(
  competitionId: string,
  punch: {
    clientPunchId: string;
    siNumber: number;
    stationCode: number;
    punchTimeSec?: number;
    rawHex?: string;
    stationName?: string;
    stationFunction?: StationFunction;
    timeOffsetSec?: number;
  }
): Promise<{ deduplicated: boolean }> {
  const context = await getCompetitionMutationContext(competitionId);
  if (!Number.isInteger(punch.siNumber) || punch.siNumber < 1 || punch.siNumber > 99999999) {
    throw new Error('Ogiltigt SI-nummer vid online-stämpling.');
  }
  if (!Number.isInteger(punch.stationCode) || punch.stationCode < 1 || punch.stationCode > 999) {
    throw new Error('Ogiltig kontrollkod vid online-stämpling.');
  }
  const rawTimeSec = punch.punchTimeSec ?? Number.NaN;
  if (punch.punchTimeSec !== undefined && (!Number.isInteger(rawTimeSec) || rawTimeSec < 0 || rawTimeSec > 86400)) {
    throw new Error('Ogiltig tid vid online-stämpling.');
  }
  const clientPunchId = sanitizeFirestoreId(punch.clientPunchId, 'op');
  const season = await loadFullSeasonFromFirestore({
    competitionId: context.competitionId,
    includeRunnerDb: false,
  });
  const event = season?.events.find((candidate) => candidate.competition.id === context.competitionId);
  if (!event) throw new Error('Tävlingen hittades inte i Firestore för online-stämplingen.');
  const configuredStation = (event.stations || []).find(
    (station) => station.active && station.stationCode === punch.stationCode
  );
  const stationFunction: StationFunction = configuredStation?.stationFunction ?? 'RADIO';
  const stationName = (
    configuredStation?.name ||
    punch.stationName ||
    `Radiokontroll (${punch.stationCode})`
  )
    .trim()
    .slice(0, 120);
  const now = new Date();
  const rawSec =
    punch.punchTimeSec ??
    Number(
      new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/Stockholm',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
      })
        .format(now)
        .split(':')
        .reduce((acc, part) => acc * 60 + Number(part), 0)
    );
  const offsetSec = Number.isFinite(punch.timeOffsetSec)
    ? Math.round(Number(punch.timeOffsetSec))
    : 0;
  const punchTimeSec = (((rawSec + offsetSec) % 86400) + 86400) % 86400;
  const matchingRunners = event.competitors.filter(
    (competitor) =>
      competitor.siNumber === punch.siNumber && competitor.status !== 'DNS'
  );
  const runner =
    matchingRunners.find((competitor) =>
      ['IN_FOREST', 'CHECKED', 'REGISTERED', 'PRELIMINARY_FIN'].includes(competitor.status)
    ) ??
    matchingRunners[0] ??
    null;
  const competitorId = runner ? sanitizeFirestoreId(runner.id, 'cmp') : '';
  const competitorRef = runner
    ? doc(db, 'competitions', context.competitionId, 'competitors', competitorId)
    : null;
  const competitionRef = doc(db, 'competitions', context.competitionId);
  const punchRef = doc(
    db,
    'competitions',
    context.competitionId,
    'stationPunches',
    clientPunchId
  );
  const startRef =
    runner?.startTimeSec ?? runner?.allocatedStartSec ?? event.competition.zeroTimeSec;
  const runningTimeSec = runner && punchTimeSec >= startRef ? punchTimeSec - startRef : -1;
  const isPrewarning = stationFunction === 'PREWARNING';

  return runTransaction(db, async (transaction) => {
    const [existingPunch, competitionSnap] = await Promise.all([
      transaction.get(punchRef),
      transaction.get(competitionRef),
    ]);
    if (existingPunch.exists()) return { deduplicated: true };
    if (!competitionSnap.exists()) throw new Error('Tävlingen hittades inte i Firestore.');

    const competitorSnap = competitorRef ? await transaction.get(competitorRef) : null;
    const competition = competitionSnap.data();
    const createdAt = serverTimestamp();
    transaction.set(punchRef, {
      punchId: clientPunchId,
      competitionId: context.competitionId,
      ownerUid: context.ownerUid,
      clientPunchId,
      siNumber: punch.siNumber,
      stationCode: punch.stationCode,
      punchTimeSec,
      rawHex: (punch.rawHex || '').slice(0, 2000),
      stationName,
      stationFunction,
      competitorId: competitorSnap?.exists() ? competitorId : '',
      runningTimeSec,
      isPrewarning,
      createdAt,
    });

    if (!competitorSnap?.exists() || !competitorRef) {
      return { deduplicated: false };
    }

    const competitor = competitorSnap.data();
    const update: Record<string, unknown> = { updatedAt: serverTimestamp() };
    if (stationFunction === 'CHECK') {
      update.checkTimeSec = punchTimeSec;
      if (competitor.status === 'REGISTERED' || competitor.status === 'DNS') {
        update.status = 'CHECKED';
      }
    } else if (stationFunction === 'START') {
      update.startTimeSec = punchTimeSec;
      if (
        competitor.status === 'REGISTERED' ||
        competitor.status === 'CHECKED' ||
        competitor.status === 'DNS'
      ) {
        update.status = 'IN_FOREST';
      }
    } else if (stationFunction === 'FINISH') {
      update.finishTimeSec = punchTimeSec;
      update.runningTimeSec = runningTimeSec;
      if (competitor.status !== 'OK' && competitor.status !== 'MP') {
        update.status = 'PRELIMINARY_FIN';
      }
      if (
        !['OK', 'MP', 'DNF', 'PRELIMINARY_FIN'].includes(String(competitor.status))
      ) {
        transaction.update(competitionRef, {
          finishedCount: Math.min(
            Number(competition.competitorCount || 0),
            Number(competition.finishedCount || 0) + 1
          ),
          updatedAt: serverTimestamp(),
        });
      }
    } else if (
      (stationFunction === 'RADIO' || stationFunction === 'PREWARNING') &&
      (competitor.status === 'REGISTERED' || competitor.status === 'CHECKED')
    ) {
      update.status = 'IN_FOREST';
    }
    transaction.update(competitorRef, update);
    return { deduplicated: false };
  });
}

export async function submitReadoutToFirestore(
  eventId: string | undefined,
  readout: FullCardReadoutPayload
): Promise<{
  competitor?: Competitor | null;
  unknownCardReadout?: {
    siNumber: number;
    checkTimeSec?: number | null;
    startTimeSec?: number | null;
    finishTimeSec?: number | null;
    punches?: FullCardReadoutPayload['punches'];
  };
}> {
  const current = await ensureValidFirestoreUser();
  if (
    !current ||
    !current.emailVerified ||
    !current.providerData.some((provider) => provider.providerId === 'google.com')
  ) {
    throw new Error('Synkning kräver ett inloggat, verifierat Google-administratörskonto.');
  }
  if (!BOOTSTRAP_SUPER_ADMIN_EMAILS.includes((current.email || '').toLowerCase())) {
    const adminSnap = await getDoc(doc(db, 'admins', current.uid));
    const role = adminSnap.exists() ? adminSnap.data().role : null;
    if (role !== 'RACE_ADMIN' && role !== 'SUPER_ADMIN') {
      throw new Error('Ditt Google-konto saknar administratörsbehörighet för Firestore-synkning.');
    }
  }
  if (!eventId) {
    throw new Error('Tävlingen för den köade avläsningen saknas.');
  }

  const siNumber = Number(readout.siNumber);
  if (!Number.isInteger(siNumber) || siNumber < 1 || siNumber > 99999999) {
    throw new Error('Ogiltigt SI-nummer vid utläsning.');
  }
  if (!Array.isArray(readout.punches) || readout.punches.length > 192) {
    throw new Error('Avläsningen innehåller ett ogiltigt antal stämplingar.');
  }
  const normalizeReadoutTime = (value: number | null | undefined): number | null => {
    if (value === null || value === undefined) return null;
    if (!Number.isInteger(value) || value < 0 || value > 86400) {
      throw new Error('Avläsningen innehåller en ogiltig tid.');
    }
    return value;
  };
  const checkTimeSec = normalizeReadoutTime(readout.checkTimeSec);
  const cardStartTimeSec = normalizeReadoutTime(readout.startTimeSec);
  const cardFinishTimeSec = normalizeReadoutTime(readout.finishTimeSec);
  if (
    typeof readout.cardSeries !== 'string' ||
    readout.cardSeries.length === 0 ||
    readout.cardSeries.length > 24
  ) {
    throw new Error('Avläsningen innehåller en ogiltig SI-bricktyp.');
  }
  const punches = readout.punches.map((punch) => {
    const code = Number(punch.code);
    const timeSec = Number(punch.timeSec);
    if (
      !Number.isInteger(code) ||
      code < 1 ||
      code > 999 ||
      !Number.isInteger(timeSec) ||
      timeSec < 0 ||
      timeSec > 86400
    ) {
      throw new Error('Avläsningen innehåller en ogiltig stämpling.');
    }
    return { code, timeSec };
  });

  const season = await loadFullSeasonFromFirestore();
  const event = season?.events.find(
    (candidate) =>
      candidate.competition.id === eventId ||
      candidate.competition.shortCode.toLowerCase() === eventId.toLowerCase()
  );
  if (!event) {
    throw new Error('Tävlingen hittades inte i Firestore för den köade avläsningen.');
  }

  const competitionId = sanitizeFirestoreId(event.competition.id, 'evt');
  const eligibleRunners = event.competitors.filter(
    (runner) => runner.siNumber === siNumber && runner.status !== 'DNS'
  );
  const runner =
    eligibleRunners.find(
      (candidate) =>
        candidate.status === 'IN_FOREST' ||
        candidate.status === 'CHECKED' ||
        candidate.status === 'REGISTERED' ||
        candidate.status === 'PRELIMINARY_FIN'
    ) ??
    eligibleRunners[0] ??
    null;

  const clientReadoutId = sanitizeFirestoreId(
    readout.clientReadoutId || `ro-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    'ro'
  );
  const now = new Date();
  const nowIso = now.toISOString();
  const nowSec = Number(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Stockholm',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .format(now)
      .split(':')
      .reduce((acc, part) => acc * 60 + Number(part), 0)
  );
  const cardStartIsStale =
    cardStartTimeSec !== null &&
    punches.length > 0 &&
    cardStartTimeSec > punches[0].timeSec &&
    runner?.startTimeSec !== null &&
    runner?.startTimeSec !== undefined &&
    runner.startTimeSec <= punches[0].timeSec;
  const usableCardStart = cardStartIsStale ? null : cardStartTimeSec;
  const effectiveStart =
    usableCardStart ??
    runner?.startTimeSec ??
    runner?.allocatedStartSec ??
    event.competition.zeroTimeSec;
  const effectiveFinish =
    runner?.manualFinishTimeSec ??
    cardFinishTimeSec ??
    runner?.finishTimeSec ??
    nowSec;
  const validation = runner
    ? validateCompetitorReadout(
        event.classes.find((candidate) => candidate.id === runner.classId),
        event.courses,
        effectiveStart,
        effectiveFinish,
        punches,
        event.emergency ?? { brokenControls: event.brokenControls, controlTimeOffsets: {} }
      )
    : null;
  const updatedCompetitor: Competitor | null =
    runner && validation
      ? {
          ...runner,
          checkTimeSec: checkTimeSec ?? runner.checkTimeSec,
          startTimeSec: usableCardStart ?? runner.startTimeSec,
          finishTimeSec: effectiveFinish,
          runningTimeSec:
            effectiveFinish >= effectiveStart ? effectiveFinish - effectiveStart : null,
          lastSeenControl: 1,
          lastSeenTimeSec: effectiveFinish,
          readoutAt: nowIso,
          cardPunches: applyEmergencyTimeOffsets(punches, {}),
          rawReadout: {
            checkTimeSec,
            startTimeSec: usableCardStart ?? null,
            finishTimeSec: cardFinishTimeSec ?? effectiveFinish,
            punches,
            rawHex: readout.rawHex?.slice(0, 2000),
            receivedAt: nowIso,
            clientReadoutId,
          },
          status: validation.ok ? 'OK' : 'MP',
          validation,
        }
      : null;

  const competitionRef = doc(db, 'competitions', competitionId);
  const receiptRef = doc(
    db,
    'competitions',
    competitionId,
    'readoutReceipts',
    clientReadoutId
  );
  const ownerUid = current.uid;
  const result = await runTransaction(db, async (transaction) => {
    const [competitionSnap, receiptSnap] = await Promise.all([
      transaction.get(competitionRef),
      transaction.get(receiptRef),
    ]);
    if (!competitionSnap.exists()) {
      throw new Error('Tävlingen finns inte längre i Firestore.');
    }
    const competitionData = competitionSnap.data();
    if (competitionData.ownerUid !== current.uid) {
      throw new Error('Du saknar behörighet att synka till den här tävlingen.');
    }
    if (receiptSnap.exists()) {
      const receipt = receiptSnap.data();
      return {
        status: receipt.status === 'UNKNOWN' ? ('UNKNOWN' as const) : ('PROCESSED' as const),
        competitorId:
          typeof receipt.competitorId === 'string' ? receipt.competitorId : null,
      };
    }
    if (competitionData.status === 'COMPLETED') {
      throw new Error('Tävlingen är avslutad och tar inte emot fler avläsningar.');
    }

    const commonReceipt = {
      receiptId: clientReadoutId,
      competitionId,
      ownerUid,
      clientReadoutId,
      siNumber,
      cardSeries: readout.cardSeries,
      stationCode:
        Number.isInteger(readout.stationCode) &&
        readout.stationCode >= 1 &&
        readout.stationCode <= 999
          ? readout.stationCode
          : 1,
      checkTimeSec: encodeNullableSec(checkTimeSec),
      startTimeSec: encodeNullableSec(cardStartTimeSec),
      finishTimeSec: encodeNullableSec(cardFinishTimeSec),
      punchCodes: punches.map((punch) => punch.code),
      punchTimes: punches.map((punch) => punch.timeSec),
      rawHex: (readout.rawHex || '').slice(0, 2000),
      createdAt: serverTimestamp(),
    };

    if (!runner || !updatedCompetitor || !validation) {
      transaction.set(receiptRef, {
        ...commonReceipt,
        status: 'UNKNOWN',
        competitorId: '',
      });
      return { status: 'UNKNOWN' as const, competitorId: null };
    }

    const competitorId = sanitizeFirestoreId(runner.id, 'cmp');
    const competitorRef = doc(
      db,
      'competitions',
      competitionId,
      'competitors',
      competitorId
    );
    const competitorSnap = await transaction.get(competitorRef);
    if (!competitorSnap.exists()) {
      throw new Error('Deltagaren hittades inte längre i Firestore.');
    }

    const previousStatus = String(competitorSnap.data().status || 'REGISTERED');
    const wasFinished =
      previousStatus === 'OK' ||
      previousStatus === 'MP' ||
      previousStatus === 'DNF' ||
      previousStatus === 'PRELIMINARY_FIN';
    const finishedCount = Math.max(0, Number(competitionData.finishedCount) || 0);

    transaction.update(competitorRef, {
      status: updatedCompetitor.status,
      checkTimeSec: encodeNullableSec(updatedCompetitor.checkTimeSec),
      startTimeSec: encodeNullableSec(updatedCompetitor.startTimeSec),
      finishTimeSec: encodeNullableSec(updatedCompetitor.finishTimeSec),
      runningTimeSec: encodeNullableSec(updatedCompetitor.runningTimeSec),
      readoutAtIso: nowIso,
      punchCodes: punches.map((punch) => punch.code),
      punchTimes: punches.map((punch) => punch.timeSec),
      updatedAt: serverTimestamp(),
    });
    transaction.update(competitionRef, {
      finishedCount: finishedCount + (wasFinished ? 0 : 1),
      updatedAt: serverTimestamp(),
    });
    transaction.set(receiptRef, {
      ...commonReceipt,
      status: 'PROCESSED',
      competitorId,
    });
    return { status: 'PROCESSED' as const, competitorId };
  });

  if (result.status === 'UNKNOWN') {
    return {
      unknownCardReadout: {
        siNumber,
        checkTimeSec: readout.checkTimeSec,
        startTimeSec: readout.startTimeSec,
        finishTimeSec: readout.finishTimeSec,
        punches,
      },
    };
  }
  return {
    competitor:
      result.competitorId ===
      (runner ? sanitizeFirestoreId(runner.id, 'cmp') : null)
        ? updatedCompetitor
        : event.competitors.find(
            (candidate) =>
              sanitizeFirestoreId(candidate.id, 'cmp') === result.competitorId
          ) ?? runner,
  };
}

export async function saveDirectCompetitionEntryToFirestore(params: {
  competitionId: string;
  payload: Partial<Competitor> & {
    pendingReadout?: {
      checkTimeSec?: number | null;
      startTimeSec?: number | null;
      finishTimeSec?: number | null;
      punches?: CardPunch[];
    };
  };
  competitors: Competitor[];
  classes: CompClass[];
  courses: Course[];
  emergency: EmergencySettings;
}): Promise<{ competitor: Competitor; runnerDbEntry: RunnerDbEntry | null }> {
  const current = await ensureValidFirestoreUser();
  if (
    !current ||
    !current.emailVerified ||
    !current.providerData.some((provider) => provider.providerId === 'google.com')
  ) {
    throw new Error('Direktanmäla kräver ett inloggat, verifierat Google-administratörskonto.');
  }

  const ownerUid = sanitizeFirestoreId(current.uid, 'usr');
  const isBootstrapAdmin = BOOTSTRAP_SUPER_ADMIN_EMAILS.includes(
    (current.email || '').toLowerCase()
  );
  const adminSnap = isBootstrapAdmin
    ? null
    : await getDoc(doc(db, 'admins', ownerUid));
  const role = adminSnap?.exists() ? adminSnap.data().role : null;
  const isSuperAdmin = isBootstrapAdmin || role === 'SUPER_ADMIN';
  if (!isSuperAdmin && role !== 'RACE_ADMIN') {
    throw new Error('Ditt Google-konto saknar administratörsbehörighet för direktanmälan.');
  }

  const competitionId = sanitizeFirestoreId(params.competitionId, 'evt');
  const competitionRef = doc(db, 'competitions', competitionId);
  const competitionSnap = await getDoc(competitionRef);
  if (!competitionSnap.exists()) {
    throw new Error('Tävlingen hittades inte i Firestore.');
  }
  const competitionData = competitionSnap.data();
  if (competitionData.status === 'COMPLETED' && !isSuperAdmin) {
    throw new Error('Det går inte att direktanmäla till en avslutad tävling.');
  }

  const siNumber = Number(params.payload.siNumber);
  const fullName = (params.payload.fullName || '').trim();
  if (!Number.isInteger(siNumber) || siNumber < 1 || siNumber > 99999999 || !fullName) {
    throw new Error('Ange ett giltigt SI-bricknummer och löparens namn.');
  }

  const competitorSnapshots = await getDocs(
    collection(db, 'competitions', competitionId, 'competitors')
  );
  const existingCompetitors = competitorSnapshots.docs.map((snapshot) => snapshot.data());
  const activeStatuses = new Set(['REGISTERED', 'CHECKED', 'IN_FOREST', 'PRELIMINARY_FIN']);
  const activeConflict = existingCompetitors.find(
    (competitor) =>
      Number(competitor.siNumber) === siNumber && activeStatuses.has(String(competitor.status))
  );
  if (activeConflict) {
    throw new Error(
      `SI-bricka ${siNumber} används redan av en aktiv deltagare (#${activeConflict.bib} ${activeConflict.fullName}).`
    );
  }

  const classId = sanitizeFirestoreId(
    params.payload.classId || params.classes[0]?.id || 'cls_open',
    'cls'
  );
  const targetClass = params.classes.find((candidate) => candidate.id === classId) ?? null;
  const bib = Math.max(
    400,
    ...params.competitors.map((competitor) => competitor.bib),
    ...existingCompetitors.map((competitor) => Number(competitor.bib) || 0)
  ) + 1;
  const nowIso = new Date().toISOString();
  const pendingReadout = params.payload.pendingReadout;
  const rawPunches = Array.isArray(pendingReadout?.punches)
    ? pendingReadout.punches.slice(0, 192).map((punch) => ({ ...punch }))
    : [];
  const allocatedStartSec = params.payload.allocatedStartSec ?? null;
  const effectiveStart =
    pendingReadout?.startTimeSec ?? allocatedStartSec ?? Number(competitionData.zeroTimeSec ?? 36000);
  const finishTimeSec = pendingReadout?.finishTimeSec ?? null;
  const hasPendingReadout = Boolean(pendingReadout && Array.isArray(pendingReadout.punches));
  const validation =
    hasPendingReadout && finishTimeSec !== null
      ? validateCompetitorReadout(
          targetClass ?? undefined,
          params.courses,
          effectiveStart,
          finishTimeSec,
          rawPunches,
          params.emergency
        )
      : null;
  const cardPunches = hasPendingReadout
    ? applyEmergencyTimeOffsets(rawPunches, params.emergency.controlTimeOffsets)
    : [];
  const status = validation
    ? validation.ok
      ? 'OK'
      : 'MP'
    : params.payload.status || 'REGISTERED';
  const competitorId = `cmp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const competitor: Competitor = {
    id: competitorId,
    bib,
    fullName,
    club: (params.payload.club || 'Klubblös').trim() || 'Klubblös',
    classId,
    siNumber,
    cardSeries: params.payload.cardSeries || 'SI-Card 10',
    isRentalCard: Boolean(params.payload.isRentalCard),
    isBorrowedCard: Boolean(params.payload.isBorrowedCard),
    rentalReturned: false,
    feePaid: Boolean(params.payload.feePaid),
    status,
    allocatedStartSec,
    checkTimeSec: hasPendingReadout ? pendingReadout?.checkTimeSec ?? null : null,
    startTimeSec: hasPendingReadout ? pendingReadout?.startTimeSec ?? null : null,
    finishTimeSec,
    manualFinishTimeSec: null,
    runningTimeSec:
      finishTimeSec !== null && finishTimeSec >= effectiveStart
        ? finishTimeSec - effectiveStart
        : null,
    lastSeenControl: cardPunches.length > 0 ? 1 : null,
    lastSeenTimeSec: finishTimeSec ?? pendingReadout?.startTimeSec ?? null,
    readoutAt: hasPendingReadout ? nowIso : null,
    radioSplits: [],
    cardPunches,
    rawReadout: hasPendingReadout
      ? {
          checkTimeSec: pendingReadout?.checkTimeSec ?? null,
          startTimeSec: pendingReadout?.startTimeSec ?? null,
          finishTimeSec,
          punches: rawPunches,
          receivedAt: nowIso,
        }
      : null,
    validation,
  };

  const createdAt = serverTimestamp();
  const mutableCompetitor = {
    bib,
    fullName: competitor.fullName.slice(0, 120),
    club: competitor.club.slice(0, 100) || 'Klubblös',
    classId,
    siNumber,
    cardSeries: competitor.cardSeries,
    isRentalCard: competitor.isRentalCard,
    rentalReturned: false,
    feePaid: competitor.feePaid ?? false,
    status: competitor.status,
    allocatedStartSec: encodeNullableSec(allocatedStartSec),
    checkTimeSec: encodeNullableSec(competitor.checkTimeSec),
    startTimeSec: encodeNullableSec(competitor.startTimeSec),
    finishTimeSec: encodeNullableSec(finishTimeSec),
    manualFinishTimeSec: -1,
    runningTimeSec: encodeNullableSec(competitor.runningTimeSec),
    readoutAtIso: competitor.readoutAt || '',
    punchCodes: rawPunches.map((punch) => clampInt(punch.code, 1, 999, 31)),
    punchTimes: rawPunches.map((punch) => clampInt(punch.timeSec, 0, 86400, 0)),
  };
  const nextCompetitorCount = existingCompetitors.length + 1;
  const batch = writeBatch(db);
  batch.set(doc(db, 'competitions', competitionId, 'competitors', competitorId), {
    competitorId,
    competitionId,
    ...mutableCompetitor,
    ownerUid,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  batch.update(competitionRef, {
    competitorCount: nextCompetitorCount,
    finishedCount: Math.min(
      nextCompetitorCount,
      Number(competitionData.finishedCount || 0) + (status === 'OK' || status === 'MP' ? 1 : 0)
    ),
    updatedAt: serverTimestamp(),
  });

  let runnerDbEntry: RunnerDbEntry | null = null;
  if (!competitor.isRentalCard && !competitor.isBorrowedCard) {
    const runnerId = String(siNumber);
    const runnerRef = doc(db, 'runnerDb', runnerId);
    const runnerSnap = await getDoc(runnerRef);
    const existingRunner = runnerSnap.exists() ? runnerSnap.data() : null;
    const sameRunner =
      existingRunner?.fullName?.trim().toLowerCase() === fullName.toLowerCase();

    if (!existingRunner || sameRunner) {
      const runnerData = {
        cardSeries: competitor.cardSeries,
        fullName: fullName.slice(0, 120),
        club: competitor.club.slice(0, 100) || 'Klubblös',
        birthYear:
          typeof existingRunner?.birthYear === 'number' ? existingRunner.birthYear : null,
        defaultClassName: targetClass?.name || '',
        eventorPersonId:
          typeof existingRunner?.eventorPersonId === 'string'
            ? existingRunner.eventorPersonId
            : '',
        eventorOrgId:
          typeof existingRunner?.eventorOrgId === 'string' ? existingRunner.eventorOrgId : '',
        source: existingRunner?.source || 'LEARNED_ENTRY',
        updatedAtIso: nowIso,
      };

      if (existingRunner) {
        batch.update(runnerRef, {
          ...runnerData,
          updatedAt: serverTimestamp(),
        });
      } else {
        batch.set(runnerRef, {
          runnerId,
          siNumber,
          ...runnerData,
          source: 'LEARNED_ENTRY',
          ownerUid,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }

      runnerDbEntry = {
        id: runnerId,
        siNumber,
        ...runnerData,
        source: runnerData.source as RunnerDbEntry['source'],
        updatedAt: nowIso,
      };
    }
  }

  try {
    await batch.commit();
  } catch (err) {
    handleWriteOrOfflineError(
      err,
      OperationType.CREATE,
      `competitions/${competitionId}/competitors/${competitorId}`
    );
  }

  return { competitor, runnerDbEntry };
}

export async function loadPublicRaceFromFirestore(
  shortCode: string
): Promise<PublicRacePayload | null> {
  const season = await loadFullSeasonFromFirestore();
  if (!season) return null;

  const target = season.events.find(
    (event) => event.competition.shortCode.toLowerCase() === shortCode.toLowerCase()
  );
  if (!target) return null;

  const competitionsList: CompetitionSummary[] = season.events
    .map((event) => ({
      id: event.competition.id,
      competitionId: event.competition.id,
      shortCode: event.competition.shortCode,
      status: event.competition.status,
      name: event.competition.name,
      organizer: event.competition.organizer,
      date: event.competition.date,
      zeroTimeStr: event.competition.zeroTimeStr,
      arenaInfo: event.competition.arenaInfo,
      seriesName: event.competition.seriesName,
      enableFeesAndSwish: Boolean(event.competition.enableFeesAndSwish),
      competitorCount: event.competitors.length,
      finishedCount: event.competitors.filter(
        (competitor) => competitor.status === 'OK' || competitor.status === 'MP'
      ).length,
      classCount: event.classes.length,
    }))
    .sort((a, b) => b.date.localeCompare(a.date));

  const feesEnabled = Boolean(target.competition.enableFeesAndSwish);
  const clubSettings = feesEnabled
    ? season.clubSettings
    : {
        ...season.clubSettings,
        swishNumber: '',
        swishRecipientName: '',
        defaultDirectEntryFeeSek: 0,
        rentalCardFeeSek: 0,
        missingRentalFeeSek: 0,
      };

  return {
    competition: target.competition,
    courses: target.courses,
    classes: feesEnabled
      ? target.classes
      : target.classes.map((compClass) => ({ ...compClass, feeSek: 0 })),
    competitors: target.competitors,
    radioControls: (target.stations ?? [])
      .filter(
        (station) =>
          station.active &&
          (station.stationFunction === 'RADIO' || station.stationFunction === 'PREWARNING')
      )
      .map(({ stationCode, name, stationFunction, active }) => ({
        stationCode,
        name,
        stationFunction,
        active,
      })),
    events: [],
    emergency: {
      brokenControls: target.brokenControls,
      controlTimeOffsets: {},
    },
    competitionsList,
    clubSettings,
    seriesStandings: season.seriesStandings ?? [],
    updatedAt: new Date().toISOString(),
  };
}

export async function listClubCloudCompetitionsFromFirestore(): Promise<
  CloudCompetitionRecord[]
> {
  const current = await ensureValidFirestoreUser();
  if (!current) return [];
  const path = 'clubSettings/default';
  try {
    const clubSnap = await getDoc(doc(db, 'clubSettings', 'default'));
    const clubData = clubSnap.exists()
      ? (clubSnap.data() as { competitionIds?: unknown })
      : null;
    const competitionIds = Array.isArray(clubData?.competitionIds)
      ? Array.from(
          new Set(
            clubData.competitionIds.filter(
              (id): id is string => typeof id === 'string' && SAFE_ID_REGEX.test(id)
            )
          )
        )
      : [];

    const toRecord = (
      id: string,
      data: {
        competitionId: string;
        shortCode: string;
        name: string;
        organizer: string;
        date: string;
        status: EventLifecycleStatus;
        seriesName?: string;
        enableFeesAndSwish?: boolean;
        competitorCount: number;
        finishedCount: number;
        ownerUid: string;
        updatedAt?: Timestamp;
      }
    ): CloudCompetitionRecord => ({
      competitionId: data.competitionId || id,
      shortCode: data.shortCode,
      name: data.name,
      organizer: data.organizer,
      date: data.date,
      status: data.status,
      seriesName: data.seriesName || '',
      enableFeesAndSwish: Boolean(data.enableFeesAndSwish),
      competitorCount: data.competitorCount,
      finishedCount: data.finishedCount,
      ownerUid: data.ownerUid,
      updatedAtIso:
        data.updatedAt && typeof data.updatedAt.toDate === 'function'
          ? data.updatedAt.toDate().toISOString()
          : null,
    });

    if (competitionIds.length > 0) {
      const competitionSnapshots = await Promise.all(
        competitionIds.map((competitionId) =>
          getDoc(doc(db, 'competitions', competitionId))
        )
      );
      return competitionSnapshots
        .filter((snapshot) => snapshot.exists())
        .map((snapshot) =>
          toRecord(
            snapshot.id,
            snapshot.data() as {
              competitionId: string;
              shortCode: string;
              name: string;
              organizer: string;
              date: string;
              status: EventLifecycleStatus;
              seriesName?: string;
              enableFeesAndSwish?: boolean;
              competitorCount: number;
              finishedCount: number;
              ownerUid: string;
              updatedAt?: Timestamp;
            }
          )
        )
        .sort((a, b) => b.date.localeCompare(a.date));
    }

    const ownCompetitions = await getDocs(
      query(collection(db, 'competitions'), where('ownerUid', '==', current.uid))
    );
    return ownCompetitions.docs
      .map((snapshot) =>
        toRecord(
          snapshot.id,
          snapshot.data() as {
            competitionId: string;
            shortCode: string;
            name: string;
            organizer: string;
            date: string;
            status: EventLifecycleStatus;
            seriesName?: string;
            enableFeesAndSwish?: boolean;
            competitorCount: number;
            finishedCount: number;
            ownerUid: string;
            updatedAt?: Timestamp;
          }
        )
      )
      .sort((a, b) => b.date.localeCompare(a.date));
  } catch (err) {
    if (isTransientOfflineFirestoreError(err)) {
      if (isTokenServiceError(err)) {
        setTokenServiceDisabled(true);
        void signOut(auth).catch(() => {});
      }
      return [];
    }
    handleFirestoreError(err, OperationType.LIST, path);
  }
}

export function subscribePublicCompetitionSummaries(
  onUpdate: (competitions: CompetitionSummary[]) => void,
  onError: (error: Error) => void
): () => void {
  const competitionUnsubscribers = new Map<string, () => void>();
  const competitionsById = new Map<string, CompetitionSummary>();

  const publish = () => {
    onUpdate(
      Array.from(competitionsById.values()).sort((a, b) =>
        b.date.localeCompare(a.date)
      )
    );
  };

  const parseCompDoc = (docId: string, data: Partial<CompetitionSummary>): CompetitionSummary => {
    const status =
      data.status === 'LIVE' ||
      data.status === 'UPCOMING' ||
      data.status === 'COMPLETED'
        ? data.status
        : 'UPCOMING';
    return {
      id: docId,
      competitionId: docId,
      shortCode: data.shortCode ?? '',
      status,
      name: data.name ?? '',
      organizer: data.organizer ?? '',
      date: data.date ?? '',
      zeroTimeStr: data.zeroTimeStr ?? '18:00:00',
      arenaInfo: data.arenaInfo ?? '',
      seriesName: data.seriesName,
      allowSelfRegistration: Boolean((data as { allowSelfRegistration?: boolean }).allowSelfRegistration),
      enableFeesAndSwish: Boolean(data.enableFeesAndSwish),
      competitorCount: data.competitorCount ?? 0,
      finishedCount: data.finishedCount ?? 0,
      classCount: data.classCount ?? 0,
    };
  };

  // 1. Direct collection listener for all competitions
  let unsubscribeCol: (() => void) | null = null;
  try {
    const compCol = collection(db, 'competitions');
    unsubscribeCol = onSnapshot(
      compCol,
      (snapshot) => {
        for (const change of snapshot.docChanges()) {
          const docId = change.doc.id;
          if (change.type === 'removed') {
            competitionsById.delete(docId);
          } else {
            competitionsById.set(docId, parseCompDoc(docId, change.doc.data() as Partial<CompetitionSummary>));
          }
        }
        publish();
      },
      () => {
        // Fallback gracefully if collection listing is restricted for current auth state
      }
    );
  } catch {
    // Ignore fallback
  }

  // 2. ClubSettings default listener to discover and listen to individually indexed competition IDs
  const unsubscribeClub = onSnapshot(
    doc(db, 'clubSettings', 'default'),
    (clubSnapshot) => {
      const clubData = clubSnapshot.exists()
        ? (clubSnapshot.data() as { competitionIds?: unknown })
        : null;
      const competitionIds = Array.isArray(clubData?.competitionIds)
        ? Array.from(
            new Set(
              clubData.competitionIds.filter(
                (id): id is string => typeof id === 'string' && SAFE_ID_REGEX.test(id)
              )
            )
          )
        : [];
      const desiredIds = new Set(competitionIds);

      for (const [competitionId, unsubscribe] of competitionUnsubscribers) {
        if (!desiredIds.has(competitionId)) {
          unsubscribe();
          competitionUnsubscribers.delete(competitionId);
        }
      }

      for (const competitionId of competitionIds) {
        if (competitionUnsubscribers.has(competitionId)) continue;
        const unsubscribe = onSnapshot(
          doc(db, 'competitions', competitionId),
          (competitionSnapshot) => {
            if (!competitionSnapshot.exists()) {
              publish();
              return;
            }
            competitionsById.set(
              competitionId,
              parseCompDoc(competitionId, competitionSnapshot.data() as Partial<CompetitionSummary>)
            );
            publish();
          },
          (error) => {
            onError(error);
          }
        );
        competitionUnsubscribers.set(competitionId, unsubscribe);
      }

      publish();
    },
    (error) => {
      onError(error);
    }
  );

  return () => {
    if (unsubscribeCol) unsubscribeCol();
    unsubscribeClub();
    for (const unsubscribe of competitionUnsubscribers.values()) {
      unsubscribe();
    }
    competitionUnsubscribers.clear();
    competitionsById.clear();
  };
}

export const DEFAULT_CLUB_SETTINGS: ClubSettings = {
  clubName: 'OK Österåker',
  eventorOrgId: '',
  swishNumber: '',
  swishRecipientName: '',
  defaultDirectEntryFeeSek: 0,
  rentalCardFeeSek: 0,
  missingRentalFeeSek: 0,
  portalTitle: '',
  logoDataUrl: '',
  customBgColor: '',
  customTextColor: '',
  customAccentColor: '',
  seriesScoringSettings: {},
};

/**
 * Loads club settings from Firestore via a single document read:
 * `getDoc(doc(db, 'clubSettings', 'default'))`
 * NEVER uses `getDocs()` on the whole collection because collection listing is forbidden in firestore.rules (`allow list: if false;`).
 * - If the document does not exist yet, returns default settings cleanly without throwing an error.
 * The document allows public single-document reads, so branding can load before login.
 * - On permission-denied, throws a clear error rather than silently hiding a rules issue.
 */
export async function loadClubSettingsFromFirestore(): Promise<ClubSettings> {
  try {
    const clubSnap = await getDoc(doc(db, 'clubSettings', 'default'));
    if (!clubSnap.exists()) {
      return { ...DEFAULT_CLUB_SETTINGS };
    }
    const data = clubSnap.data() as Partial<ClubSettings>;
    return {
      clubName: (data.clubName || DEFAULT_CLUB_SETTINGS.clubName).trim().slice(0, 100) || DEFAULT_CLUB_SETTINGS.clubName,
      eventorOrgId: (data.eventorOrgId || '').trim().slice(0, 32),
      swishNumber: (data.swishNumber || '').trim().slice(0, 20),
      swishRecipientName: (data.swishRecipientName || data.clubName || DEFAULT_CLUB_SETTINGS.clubName).trim().slice(0, 100),
      defaultDirectEntryFeeSek: clampInt(data.defaultDirectEntryFeeSek, 0, 10000, DEFAULT_CLUB_SETTINGS.defaultDirectEntryFeeSek),
      rentalCardFeeSek: clampInt(data.rentalCardFeeSek, 0, 5000, DEFAULT_CLUB_SETTINGS.rentalCardFeeSek),
      missingRentalFeeSek: clampInt(data.missingRentalFeeSek, 0, 20000, DEFAULT_CLUB_SETTINGS.missingRentalFeeSek),
      portalTitle: (data.portalTitle || '').trim().slice(0, 80),
      logoDataUrl: sanitizeCloudLogoDataUrl(data.logoDataUrl),
      customBgColor: sanitizeCloudHexColor(data.customBgColor),
      customTextColor: sanitizeCloudHexColor(data.customTextColor),
      customAccentColor: sanitizeCloudHexColor(data.customAccentColor),
      seriesScoringSettings: normalizeSeriesScoringSettings(data.seriesScoringSettings),
    };
  } catch (err: unknown) {
    const msg = (err instanceof Error ? err.message : String(err || '')).toLowerCase();
    const code = String((err as { code?: string })?.code || '').toLowerCase();
    if (
      code.includes('permission-denied') ||
      msg.includes('permission-denied') ||
      msg.includes('missing or insufficient permissions')
    ) {
      throw new Error(
        'Behörighet saknas när klubbinställningarna hämtas från Firestore.'
      );
    }
    if (isTransientOfflineFirestoreError(err)) {
      return { ...DEFAULT_CLUB_SETTINGS };
    }
    throw err;
  }
}

/**
 * Subscribes to /clubSettings/default in real-time so custom themes, branding, and Swish
 * updates automatically propagate across all views and open browser tabs.
 */
export function subscribeClubSettingsFromFirestore(
  onUpdate: (settings: ClubSettings) => void
): () => void {
  const clubRef = doc(db, 'clubSettings', 'default');
  const unsubscribe = onSnapshot(
    clubRef,
    (snap) => {
      if (!snap.exists()) {
        onUpdate({ ...DEFAULT_CLUB_SETTINGS });
        return;
      }
      const data = snap.data() as Partial<ClubSettings>;
      onUpdate({
        clubName: (data.clubName || DEFAULT_CLUB_SETTINGS.clubName).trim().slice(0, 100) || DEFAULT_CLUB_SETTINGS.clubName,
        eventorOrgId: (data.eventorOrgId || '').trim().slice(0, 32),
        swishNumber: (data.swishNumber || '').trim().slice(0, 20),
        swishRecipientName: (data.swishRecipientName || data.clubName || DEFAULT_CLUB_SETTINGS.clubName).trim().slice(0, 100),
        defaultDirectEntryFeeSek: clampInt(data.defaultDirectEntryFeeSek, 0, 10000, DEFAULT_CLUB_SETTINGS.defaultDirectEntryFeeSek),
        rentalCardFeeSek: clampInt(data.rentalCardFeeSek, 0, 5000, DEFAULT_CLUB_SETTINGS.rentalCardFeeSek),
        missingRentalFeeSek: clampInt(data.missingRentalFeeSek, 0, 20000, DEFAULT_CLUB_SETTINGS.missingRentalFeeSek),
        portalTitle: (data.portalTitle || '').trim().slice(0, 80),
        logoDataUrl: sanitizeCloudLogoDataUrl(data.logoDataUrl),
        customBgColor: sanitizeCloudHexColor(data.customBgColor),
        customTextColor: sanitizeCloudHexColor(data.customTextColor),
        customAccentColor: sanitizeCloudHexColor(data.customAccentColor),
        seriesScoringSettings: normalizeSeriesScoringSettings(data.seriesScoringSettings),
      });
    },
    (err) => {
      console.warn('Realtime-lyssnare på clubSettings misslyckades:', err);
    }
  );
  return unsubscribe;
}

export interface CreateCompetitionInFirestoreParams {
  competitionId: string;
  shortCode?: string;
  name: string;
  organizer?: string;
  date?: string;
  status?: EventLifecycleStatus;
  zeroTimeStr?: string;
  zeroTimeSec?: number;
  arenaInfo?: string;
  seriesName?: string;
  allowSelfRegistration?: boolean;
  enableFeesAndSwish?: boolean;
  pinStart?: string;
  pinReadout?: string;
  pinForest?: string;
  pinSpeaker?: string;
  pinsCustomized?: boolean;
  courses?: Course[];
  classes?: CompClass[];
}

/**
 * Atomically writes a new competition to Firestore under Zero-Trust schema rules:
 * - Guarantees all required fields are present with NO undefined values.
 * - Empty string fallback for optional strings and safe defaults for booleans/numbers.
 * - Writes child courses and classes to subcollections.
 * - Updates /clubSettings/default activeEventId and competitionIds.
 */
export async function createCompetitionInFirestore(
  params: CreateCompetitionInFirestoreParams
): Promise<string> {
  const current = await ensureValidFirestoreUser();
  if (!current || !current.emailVerified) {
    throw new Error('Du måste vara inloggad med ett verifierat Google-konto för att skapa och spara en tävling i Firestore.');
  }

  // Ensure /admins/{uid} exists so isAdmin() passes in Firestore security rules
  await ensureAdminRoleInFirestore(current).catch(() => {});

  const ownerUid = sanitizeFirestoreId(current.uid, 'usr');
  const competitionId = sanitizeFirestoreId(params.competitionId, 'evt');
  const rawShort = sanitizeFirestoreId(params.shortCode || 'oko26', 'sc').slice(0, 32);
  const shortCode = rawShort.length >= 2 ? rawShort : 'ev26';

  const name = (params.name || '').trim().slice(0, 140) || 'Tävling';
  const organizer = (params.organizer || 'OK Österåker').trim().slice(0, 100) || 'OK Österåker';
  const date = params.date && ISO_DATE_REGEX.test(params.date.trim())
    ? params.date.trim()
    : getStockholmTodayIso();

  const rawStatus = (params.status || 'UPCOMING').toUpperCase();
  const status: EventLifecycleStatus =
    rawStatus === 'LIVE' || rawStatus === 'UPCOMING' || rawStatus === 'COMPLETED'
      ? (rawStatus as EventLifecycleStatus)
      : 'UPCOMING';

  const zeroTimeStr = params.zeroTimeStr && CLOCK_REGEX.test(params.zeroTimeStr.trim())
    ? params.zeroTimeStr.trim()
    : '18:00:00';
  const zeroTimeSec = Number.isFinite(params.zeroTimeSec)
    ? clampInt(params.zeroTimeSec, 0, 86400, 18 * 3600)
    : 18 * 3600;

  const arenaInfo = (params.arenaInfo ?? '').trim().slice(0, 500);
  const seriesName = (params.seriesName ?? '').trim().slice(0, 80);
  const allowSelfRegistration = Boolean(params.allowSelfRegistration);
  const enableFeesAndSwish = Boolean(params.enableFeesAndSwish);

  const pinStart = PIN_REGEX.test(params.pinStart || '') ? params.pinStart! : '1100';
  const pinReadout = PIN_REGEX.test(params.pinReadout || '') ? params.pinReadout! : '2200';
  const pinForest = PIN_REGEX.test(params.pinForest || '') ? params.pinForest! : '3300';
  const pinSpeaker = PIN_REGEX.test(params.pinSpeaker || '') ? params.pinSpeaker! : '4400';
  const pinsCustomized = Boolean(params.pinsCustomized);

  // Required keys per firestore.rules isValidCloudCompetition.
  const compDocData = {
    competitionId,
    shortCode,
    name,
    organizer,
    date,
    status,
    zeroTimeStr,
    zeroTimeSec,
    arenaInfo,
    seriesName,
    allowSelfRegistration,
    enableFeesAndSwish,
    competitorCount: 0,
    finishedCount: 0,
    brokenControls: [] as number[],
    controlTimeOffsets: {},
    pinStart,
    pinReadout,
    pinForest,
    pinSpeaker,
    pinsCustomized,
    ownerUid,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };

  const compRef = doc(db, 'competitions', competitionId);
  await setDoc(compRef, compDocData);

  // Child subcollections: courses and classes
  const childBatchOps: QueuedBatchOp[] = [];
  if (Array.isArray(params.courses) && params.courses.length > 0) {
    for (const crs of params.courses) {
      const courseId = sanitizeFirestoreId(crs.id, 'crs');
      const crsRef = doc(db, 'competitions', competitionId, 'courses', courseId);
      childBatchOps.push({
        kind: 'set',
        ref: crsRef,
        path: `competitions/${competitionId}/courses/${courseId}`,
        data: {
          courseId,
          competitionId,
          name: (crs.name || 'Bana').trim().slice(0, 120) || 'Bana',
          lengthMeters: clampInt(crs.lengthMeters, 0, 200000, 3000),
          climbMeters: clampInt(crs.climbMeters, 0, 20000, 0),
          controls: (crs.controls || []).slice(0, 128).map((c) => clampInt(c, 1, 999, 31)),
          ownerUid,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        },
      });
    }
  }

  if (Array.isArray(params.classes) && params.classes.length > 0) {
    for (const cls of params.classes) {
      const classId = sanitizeFirestoreId(cls.id, 'cls');
      const clsRef = doc(db, 'competitions', competitionId, 'classes', classId);
      const classFormat: ClassCompetitionFormat =
        cls.classFormat === 'FORKED' || cls.classFormat === 'ROGAINING'
          ? cls.classFormat
          : 'STANDARD';
      childBatchOps.push({
        kind: 'set',
        ref: clsRef,
        path: `competitions/${competitionId}/classes/${classId}`,
        data: {
          classId,
          competitionId,
          name: (cls.name || 'Klass').trim().slice(0, 80) || 'Klass',
          courseId: cls.courseId ? sanitizeFirestoreId(cls.courseId, 'crs') : '',
          classFormat,
          forkCourseIds: (cls.forkCourseIds || [])
            .slice(0, 32)
            .map((id) => sanitizeFirestoreId(id, 'crs')),
          rogainingMaxTimeSec:
            cls.rogainingMaxTimeSec !== null && cls.rogainingMaxTimeSec !== undefined
              ? clampInt(cls.rogainingMaxTimeSec, 0, 86400, -1)
              : -1,
          rogainingPenaltyPerMin:
            cls.rogainingPenaltyPerMin !== null && cls.rogainingPenaltyPerMin !== undefined
              ? clampInt(cls.rogainingPenaltyPerMin, 0, 1000, -1)
              : -1,
          allowDirectEntry: Boolean(cls.allowDirectEntry),
          freeStart: Boolean(cls.freeStart),
          autoMatchCourse: Boolean(cls.autoMatchCourse),
          feeSek: clampInt(cls.feeSek, 0, 10000, 100),
          ownerUid,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        },
      });
    }
  }

  if (childBatchOps.length > 0) {
    await commitQueuedBatchOps(childBatchOps);
  }

  // Update /clubSettings/default
  try {
    const clubRef = doc(db, 'clubSettings', 'default');
    const clubSnap = await getDoc(clubRef);
    if (clubSnap.exists()) {
      const existingClub = clubSnap.data() as { competitionIds?: string[] };
      const currentIds = Array.isArray(existingClub.competitionIds) ? existingClub.competitionIds : [];
      const updatedIds = Array.from(new Set([competitionId, ...currentIds])).slice(0, 100);
      await updateDoc(clubRef, {
        activeEventId: competitionId,
        competitionIds: updatedIds,
        demoCleared: false,
        updatedAt: serverTimestamp(),
      });
    } else {
      await setDoc(clubRef, {
        settingId: 'default',
        clubName: organizer,
        eventorOrgId: '',
        swishNumber: '',
        swishRecipientName: '',
        defaultDirectEntryFeeSek: 0,
        rentalCardFeeSek: 0,
        missingRentalFeeSek: 0,
        activeEventId: competitionId,
        demoCleared: true,
        competitionIds: [competitionId],
        ownerUid,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }
  } catch (clubErr) {
    console.warn('Kunde inte uppdatera clubSettings i Firestore:', clubErr);
  }

  return competitionId;
}

/**
 * Saves club profile, branding, and Swish settings directly to Firestore (/clubSettings/default)
 * ensuring all keys conform strictly to isValidClubSettings rules.
 */
export async function saveClubSettingsToFirestore(
  settings: Partial<ClubSettings>,
  isSuperAdmin = false
): Promise<void> {
  const current = await ensureValidFirestoreUser();
  if (!current) {
    throw new Error('Du måste vara inloggad med Google för att spara klubbinställningar.');
  }

  const ownerUid = sanitizeFirestoreId(current.uid, 'usr');
  const clubRef = doc(db, 'clubSettings', 'default');
  const clubSnap = await getDoc(clubRef);

  const clubName =
    (settings.clubName || DEFAULT_CLUB_SETTINGS.clubName).trim().slice(0, 100) ||
    DEFAULT_CLUB_SETTINGS.clubName;
  const eventorOrgId = (settings.eventorOrgId || '').trim().slice(0, 32);
  const swishNumber = (settings.swishNumber || '').trim().slice(0, 20);
  const swishRecipientName = (settings.swishRecipientName || clubName).trim().slice(0, 100);
  const defaultDirectEntryFeeSek = clampInt(settings.defaultDirectEntryFeeSek, 0, 10000, 100);
  const rentalCardFeeSek = clampInt(settings.rentalCardFeeSek, 0, 5000, 30);
  const missingRentalFeeSek = clampInt(settings.missingRentalFeeSek, 0, 20000, 650);
  const portalTitle = (settings.portalTitle || '').trim().slice(0, 80);
  const logoDataUrl = sanitizeCloudLogoDataUrl(settings.logoDataUrl);
  const customBgColor = sanitizeCloudHexColor(settings.customBgColor);
  const customTextColor = sanitizeCloudHexColor(settings.customTextColor);
  const customAccentColor = sanitizeCloudHexColor(settings.customAccentColor);
  const seriesScoringSettings =
    settings.seriesScoringSettings === undefined
      ? undefined
      : normalizeSeriesScoringSettings(settings.seriesScoringSettings);

  if (clubSnap.exists()) {
    await updateDoc(clubRef, {
      clubName,
      eventorOrgId,
      swishNumber,
      swishRecipientName,
      defaultDirectEntryFeeSek,
      rentalCardFeeSek,
      missingRentalFeeSek,
      portalTitle,
      logoDataUrl,
      customBgColor,
      customTextColor,
      customAccentColor,
      ...(seriesScoringSettings === undefined ? {} : { seriesScoringSettings }),
      updatedAt: serverTimestamp(),
    });
  } else {
    await setDoc(clubRef, {
      settingId: 'default',
      clubName,
      eventorOrgId,
      swishNumber,
      swishRecipientName,
      defaultDirectEntryFeeSek,
      rentalCardFeeSek,
      missingRentalFeeSek,
      portalTitle,
      logoDataUrl,
      customBgColor,
      customTextColor,
      customAccentColor,
      seriesScoringSettings: seriesScoringSettings ?? {},
      activeEventId: '',
      demoCleared: false,
      competitionIds: [] as string[],
      ownerUid,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  }
}

/**
 * Clears demo competitions directly in Firestore when the season is reset.
 */
export async function seedDemoSeasonToFirestore(_ownerUidParam?: string): Promise<CloudSeasonSnapshot> {
  await ensureValidFirestoreUser();

  const clubRef = doc(db, 'clubSettings', 'default');
  const clubSnap = await getDoc(clubRef);
  if (clubSnap.exists()) {
    await updateDoc(clubRef, {
      activeEventId: '',
      competitionIds: [],
      demoCleared: true,
      updatedAt: serverTimestamp(),
    });
  }

  return {
    activeEventId: '',
    demoCleared: true,
    clubSettings: DEFAULT_CLUB_SETTINGS,
    events: [],
  };
}
