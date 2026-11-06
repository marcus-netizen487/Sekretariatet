/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  Binary,
  CloudOff,
  Compass,
  Database,
  Eye,
  FolderPlus,
  GitBranch,
  KeyRound,
  Lock,
  LogOut,
  Menu,
  Mic,
  Moon,
  Plus,
  Radio,
  Shuffle,
  SlidersHorizontal,
  Sun,
  Timer,
  Trophy,
  Upload,
  UserPlus,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import type {
  CardPunch,
  CloudSeasonSnapshot,
  ClubSettings,
  CompClass,
  CompetitionMeta,
  CompetitionSummary,
  Competitor,
  Course,
  EmergencySettings,
  EventLifecycleStatus,
  EventorIntegrationStatus,
  FullCardReadoutPayload,
  LiveEventItem,
  MeosAppState,
  OfficialRoleMode,
  RawSIFrameLog,
  RocIntegrationStatus,
  RunnerDbEntry,
  RunnerStatus,
  SeriesStandingsBundle,
  SICardSeries,
  SIStation,
} from './types/sportident';
import {
  buildSi5ReadoutFrame,
  buildSi6ReadoutBlockFrames,
  buildSi10ReadoutBlockFrames,
  buildTransRecFrame,
  decodeSingleFrame,
  hexToBytes,
  inferCardSeries,
  parseSi5SheetToReadout,
  parseSi6BlocksToReadout,
  parseSi9BlocksToReadout,
} from './services/sportidentProtocol';
import {
  playMeosFeedbackTone,
  sportidentSerial,
  type SerialConnectionStatus,
  type UsbStationMode,
} from './services/sportidentWebSerial';
import {
  offlineReadoutQueue,
  type OfflineQueueSnapshot,
  type ReadoutDeliveryResult,
} from './services/offlineReadoutQueue';
import {
  apiFetch,
  getStoredAuthSession,
  setStoredAuthSession,
  logoutSecretariatSession,
  subscribeAuthSession,
  verifyStoredSessionOnline,
  type StoredAuthSession,
} from './services/authClient';
import {
  getStockholmTodayIso,
  loadFullSeasonFromFirestore,
  ensureAdminRoleInFirestore,
  subscribeFirebaseAuth,
  syncFullSeasonToFirestore,
  createCompetitionInFirestore,
  saveCompetitionImportToFirestore,
  saveDirectCompetitionEntryToFirestore,
  activateCompetitionInFirestore,
  updateCompetitionMetadataInFirestore,
  saveCourseToFirestore,
  deleteCourseFromFirestore,
  saveClassToFirestore,
  deleteClassFromFirestore,
  saveStationToFirestore,
  deleteStationFromFirestore,
  updateCompetitorInFirestore,
  deleteCompetitorFromFirestore,
  deleteRunnerDbEntryFromFirestore,
  saveRunnerDbEntriesToFirestore,
  updateRunnerDbEntryInFirestore,
  recalculateCompetitionFromFirestore,
  auth,
  googleProvider,
  BOOTSTRAP_SUPER_ADMIN_EMAILS,
  subscribePublicCompetitionSummaries,
  loadClubSettingsFromFirestore,
  subscribeClubSettingsFromFirestore,
} from './firebase';
import { onAuthStateChanged } from 'firebase/auth';
import { ReadoutDashboard } from './components/ReadoutDashboard';
import { ForestSafetyView } from './components/ForestSafetyView';
import { SpeakerResultsView } from './components/SpeakerResultsView';
import { EntriesRegistrationView } from './components/EntriesRegistrationView';
import { RunnerDatabaseView } from './components/RunnerDatabaseView';
import { DrawView } from './components/DrawView';
import { CompetitionSettingsView } from './components/CompetitionSettingsView';
import { CoursesClassesView } from './components/CoursesClassesView';
import { HardwareStationsView } from './components/HardwareStationsView';
import { ProtocolInspectorView } from './components/ProtocolInspectorView';
import { PublicPortalView } from './components/PublicPortalView';
import { StartCorralView } from './components/StartCorralView';
import { PWAInstallButton } from './components/PWAInstallButton';
import { AuthGateView } from './components/AuthGateView';
import { AccessControlView } from './components/AccessControlView';
import { applyClubThemeToDocument } from './utils/clubTheme';
import {
  buildEffectiveCourseImportBatch,
  parseIofXmlDocument,
  type ParsedIofDocument,
} from './utils/iofXml';

type MeosTab =
  | 'competition_settings'
  | 'courses'
  | 'entries'
  | 'readout'
  | 'start_corral'
  | 'forest'
  | 'results'
  | 'draw'
  | 'hardware'
  | 'season'
  | 'runner_db'
  | 'access'
  | 'protocol';

interface AppRouteState {
  mode: 'SECRETARIAT' | 'PUBLIC';
  shortCode: string | null;
}

function parsePathnameToRoute(pathname: string): AppRouteState {
  const shortMatch = pathname.match(/^\/t\/([^/?#]+)/i);
  if (shortMatch && shortMatch[1]) {
    return {
      mode: 'PUBLIC',
      shortCode: decodeURIComponent(shortMatch[1]),
    };
  }
  if (/^\/publik(\/|$)/i.test(pathname)) {
    return {
      mode: 'PUBLIC',
      shortCode: null,
    };
  }
  return {
    mode: 'SECRETARIAT',
    shortCode: null,
  };
}

const NAV_ITEMS: {
  id: MeosTab;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}[] = [
  { id: 'competition_settings', label: 'Tävlingsinställningar', icon: SlidersHorizontal },
  { id: 'courses', label: 'Banor & Klasser', icon: GitBranch },
  { id: 'entries', label: 'Direktanmälan', icon: UserPlus },
  { id: 'readout', label: 'Avläsning & Översikt', icon: Activity },
  { id: 'start_corral', label: 'Startfålla och startlista', icon: Timer },
  { id: 'forest', label: 'Kvar i skogen', icon: Compass },
  { id: 'results', label: 'Speaker & Resultat', icon: Mic },
  { id: 'draw', label: 'Lottning', icon: Shuffle },
  { id: 'hardware', label: 'SportIdent, ROC & USB', icon: Radio },
  { id: 'season', label: 'Tävlingar och Serier', icon: Trophy },
  { id: 'runner_db', label: 'Löpardatabas', icon: Database },
  { id: 'access', label: 'Klubbadmin och behörighet', icon: KeyRound },
];

const ROLE_MODE_LABELS: Record<OfficialRoleMode, string> = {
  ALL: 'Tävlingsledare (Alla vyer)',
  READOUT: 'Mål & Avläsning',
  START: 'Startpersonal & Startfålla',
  FOREST: 'Skogssäkerhet & Sök',
  SPEAKER: 'Speaker & Resultat',
};

const ROLE_ALLOWED_TABS: Record<OfficialRoleMode, MeosTab[]> = {
  ALL: [
    'competition_settings',
    'courses',
    'entries',
    'readout',
    'start_corral',
    'forest',
    'results',
    'draw',
    'hardware',
    'season',
    'runner_db',
    'access',
    'protocol',
  ],
  READOUT: ['readout', 'entries', 'forest', 'results', 'hardware'],
  START: ['start_corral', 'draw', 'entries', 'forest', 'hardware'],
  FOREST: ['forest', 'start_corral', 'readout', 'hardware'],
  SPEAKER: ['results', 'readout', 'forest', 'start_corral'],
};

function formatLifecycleLabel(status?: EventLifecycleStatus): string {
  if (status === 'LIVE') return 'Pågår';
  if (status === 'UPCOMING') return 'Kommande';
  return 'Avslutad';
}

async function apiRequestUnavailable(
  input: RequestInfo | URL,
  init: RequestInit,
  fallbackMessage: string
): Promise<boolean> {
  let response: Response;
  try {
    response = await apiFetch(input, init);
  } catch (error) {
    if (error instanceof TypeError) return true;
    throw error;
  }
  if (response.ok) return false;
  if (response.status === 404 || response.status === 405) return true;
  const errorBody = (await response.json().catch(() => ({}))) as { error?: string };
  throw new Error(errorBody.error ?? fallbackMessage);
}

export default function App() {
  const [route, setRoute] = useState<AppRouteState>(() =>
    typeof window !== 'undefined'
      ? parsePathnameToRoute(window.location.pathname)
      : { mode: 'SECRETARIAT', shortCode: null }
  );
  const [lastPublicShortCode, setLastPublicShortCode] = useState<
    string | null | undefined
  >(() => {
    if (typeof window === 'undefined') return undefined;
    const initial = parsePathnameToRoute(window.location.pathname);
    return initial.mode === 'PUBLIC' ? initial.shortCode : undefined;
  });

  const [authSession, setAuthSession] = useState<StoredAuthSession | null>(() =>
    getStoredAuthSession()
  );
  const [authReady, setAuthReady] = useState<boolean>(false);

  const [roleMode, setRoleMode] = useState<OfficialRoleMode>(() => {
    if (typeof window === 'undefined') return 'ALL';
    const storedSess = getStoredAuthSession();
    if (storedSess?.user.sessionKind === 'PIN_OFFICIAL') {
      return storedSess.user.officialRole as OfficialRoleMode;
    }
    const saved = localStorage.getItem('passersi_role_mode') as OfficialRoleMode | null;
    if (saved && saved in ROLE_ALLOWED_TABS) return saved;
    return 'ALL';
  });

  const [activeTab, setActiveTab] = useState<MeosTab>(() => {
    if (typeof window === 'undefined') return 'readout';
    const storedSess = getStoredAuthSession();
    if (storedSess?.user.sessionKind === 'PIN_OFFICIAL') {
      const lockedRole = storedSess.user.officialRole as OfficialRoleMode;
      return ROLE_ALLOWED_TABS[lockedRole]?.[0] ?? 'readout';
    }
    const saved = localStorage.getItem('passersi_role_mode') as OfficialRoleMode | null;
    if (saved && saved in ROLE_ALLOWED_TABS) {
      return ROLE_ALLOWED_TABS[saved][0];
    }
    return 'readout';
  });
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [createEventModalOpen, setCreateEventModalOpen] = useState(false);

  useEffect(() => {
    const unsubAuth = onAuthStateChanged(auth, async (u) => {
      if (u) {
        setFirebaseUserPresent(true);
        try {
          const token = await u.getIdToken();
          const emailLower = (u.email ?? '').toLowerCase();
          let claimedRole: 'SUPER_ADMIN' | 'RACE_ADMIN' | null = null;
          try {
            const roleClaim = await ensureAdminRoleInFirestore(u);
            if (roleClaim.claimed) claimedRole = roleClaim.role;
          } catch (error) {
            console.error('Kunde inte aktivera Google-administratörens Firestore-roll:', error);
          }
          const isSuper =
            claimedRole === 'SUPER_ADMIN' ||
            BOOTSTRAP_SUPER_ADMIN_EMAILS.includes(emailLower);
          const session: StoredAuthSession = {
            token,
            user: {
              sessionKind: 'ADMIN',
              uid: u.uid,
              displayName: u.displayName || u.email || 'Administratör',
              email: u.email,
              adminTier: claimedRole ?? (isSuper ? 'SUPER_ADMIN' : 'RACE_ADMIN'),
              officialRole: 'ALL',
              lockedEventId: null,
              lockedEventName: null,
              authMethod: 'GOOGLE',
              issuedAt: new Date().toISOString(),
              expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
            },
          };
          setStoredAuthSession(session);
          setAuthSession(session);
        } catch {
          // If token fetch fails, preserve existing session
        }
      } else {
        setFirebaseUserPresent(false);
        const existing = getStoredAuthSession();
        if (!existing || existing.user.authMethod === 'GOOGLE') {
          setStoredAuthSession(null);
          setAuthSession(null);
        }
      }
      setAuthReady(true);
    });

    const unsubSession = subscribeAuthSession((next) => {
      setAuthSession(next);
    });

    return () => {
      unsubAuth();
      unsubSession();
    };
  }, []);

  const handleChangeRoleMode = useCallback(
    (nextRole: OfficialRoleMode, persistPreference = true) => {
      setRoleMode(nextRole);
      if (persistPreference) {
        localStorage.setItem('passersi_role_mode', nextRole);
      }
      const allowed = ROLE_ALLOWED_TABS[nextRole];
      setActiveTab((prev) => (allowed.includes(prev) ? prev : allowed[0]));
      if (nextRole === 'START') {
        sportidentSerial.setUsbMode('START_CORRAL');
      } else if (nextRole === 'READOUT') {
        sportidentSerial.setUsbMode('READOUT');
      }
    },
    []
  );

  // Enforce role & station locking whenever a PIN_OFFICIAL session is active
  useEffect(() => {
    if (!authSession) return;
    if (authSession.user.sessionKind === 'PIN_OFFICIAL') {
      const lockedRole = authSession.user.officialRole as OfficialRoleMode;
      handleChangeRoleMode(lockedRole, false);
      setCreateEventModalOpen(false);
    }
  }, [authSession, handleChangeRoleMode]);

  const handleLogout = useCallback(async () => {
    setMobileNavOpen(false);
    setCreateEventModalOpen(false);
    await logoutSecretariatSession();
  }, []);

  // New competition modal form state
  const [newEvtName, setNewEvtName] = useState('');
  const [newEvtDate, setNewEvtDate] = useState(() => getStockholmTodayIso());
  const [newEvtZeroTime, setNewEvtZeroTime] = useState('18:00:00');
  const [newEvtArena, setNewEvtArena] = useState('');
  const [newEvtSeriesName, setNewEvtSeriesName] = useState('');
  const [newEvtSelfReg, setNewEvtSelfReg] = useState(true);
  const [newEvtFeesAndSwish, setNewEvtFeesAndSwish] = useState(false);
  const [newEvtCopyCourses, setNewEvtCopyCourses] = useState(true);
  const [newEvtCourseParsed, setNewEvtCourseParsed] = useState<ParsedIofDocument | null>(null);
  const [newEvtCourseFileName, setNewEvtCourseFileName] = useState('');
  const [newEvtAutoClasses, setNewEvtAutoClasses] = useState(true);
  const [newEvtFreeStart, setNewEvtFreeStart] = useState(true);
  const [createEvtBusy, setCreateEvtBusy] = useState(false);
  const [createEvtError, setCreateEvtError] = useState<string | null>(null);

  const handleNewEvtCourseFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setCreateEvtError(null);
    try {
      const rawText = await file.text();
      const parsed = parseIofXmlDocument(rawText);
      if (parsed.type !== 'CourseData' || parsed.courses.length === 0) {
        setCreateEvtError(
          'Filen innehöll inga banor (<CourseData>). Välj en IOF XML-banfil från Purple Pen, Condes eller OCAD.'
        );
        return;
      }
      setNewEvtCourseParsed(parsed);
      setNewEvtCourseFileName(file.name);
      if (!newEvtName.trim() && parsed.eventName) {
        setNewEvtName(parsed.eventName);
      }
    } catch (err: unknown) {
      setCreateEvtError(
        err instanceof Error ? err.message : 'Kunde inte läsa XML-banfilen.'
      );
    } finally {
      e.target.value = '';
    }
  };

  const [firebaseUserPresent, setFirebaseUserPresent] = useState<boolean>(false);
  const [firebaseUserUid, setFirebaseUserUid] = useState<string | null>(null);
  const firestoreCompetitionsRef = useRef<CompetitionSummary[] | null>(null);
  const hydratingCompetitionListRef = useRef(false);
  useEffect(() => {
    const unsub = subscribeFirebaseAuth((u) => {
      const verifiedUid = u?.emailVerified ? u.uid : null;
      setFirebaseUserPresent(Boolean(verifiedUid));
      setFirebaseUserUid(verifiedUid);
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    firestoreCompetitionsRef.current = null;
    if (!firebaseUserUid) return;

    return subscribePublicCompetitionSummaries(
      (competitions) => {
        firestoreCompetitionsRef.current = competitions;
        setCompetitionsList(competitions);
      },
      (error) => {
        console.error('Kunde inte prenumerera på tävlingar från Firestore:', error);
      }
    );
  }, [firebaseUserUid]);

  const [darkMode, setDarkMode] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return localStorage.getItem('passersi_theme') === 'dark';
  });
  const [soundEnabled, setSoundEnabled] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    return localStorage.getItem('passersi_sound') !== 'off';
  });
  const soundEnabledRef = useRef(soundEnabled);

  useEffect(() => {
    soundEnabledRef.current = soundEnabled;
    localStorage.setItem('passersi_sound', soundEnabled ? 'on' : 'off');
  }, [soundEnabled]);

  useEffect(() => {
    const root = document.documentElement;
    if (darkMode) {
      root.classList.add('dark');
      localStorage.setItem('passersi_theme', 'dark');
    } else {
      root.classList.remove('dark');
      localStorage.setItem('passersi_theme', 'light');
    }
  }, [darkMode]);

  // Browser URL history synchronization for /t/:shortCode and /publik
  useEffect(() => {
    const onPopState = () => {
      const next = parsePathnameToRoute(window.location.pathname);
      if (next.mode === 'PUBLIC') {
        setLastPublicShortCode(next.shortCode);
      }
      setRoute(next);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const navigatePublicPortal = useCallback((shortCode: string | null) => {
    const targetPath = '/publik';
    if (window.location.pathname !== targetPath) {
      window.history.pushState({}, '', targetPath);
    }
    setLastPublicShortCode(shortCode);
    setRoute({ mode: 'PUBLIC', shortCode });
  }, []);

  const navigateSecretariat = useCallback(() => {
    if (window.location.pathname !== '/') {
      window.history.pushState({}, '', '/');
    }
    setRoute({ mode: 'SECRETARIAT', shortCode: null });
  }, []);

  // Authoritative MeOS state synced via WebSockets
  const [loading, setLoading] = useState(true);
  const [wsConnected, setWsConnected] = useState(false);
  const [connectedMonitors, setConnectedMonitors] = useState(1);

  const [activeEventId, setActiveEventId] = useState<string>('');
  const activeEventIdRef = useRef<string>('');
  const [competitionsList, setCompetitionsList] = useState<CompetitionSummary[]>([]);
  const [competitionSwitchError, setCompetitionSwitchError] = useState<string | null>(null);
  const [isEmptySeason, setIsEmptySeason] = useState<boolean>(true);
  const [isFreshColdStart, setIsFreshColdStart] = useState<boolean>(false);
  const [demoCleared, setDemoCleared] = useState<boolean>(false);
  const [clubSettings, setClubSettings] = useState<ClubSettings>({
    clubName: 'OK Österåker',
    eventorOrgId: '',
    swishNumber: '',
    swishRecipientName: '',
    defaultDirectEntryFeeSek: 0,
    rentalCardFeeSek: 0,
    missingRentalFeeSek: 0,
  });
  const [logoBroken, setLogoBroken] = useState<boolean>(false);
  const availableSeriesNames = useMemo(
    () =>
      Array.from(
        new Set([
          ...competitionsList
            .map((item) => item.seriesName?.trim() ?? '')
            .filter(Boolean),
          ...Object.keys(clubSettings.seriesScoringSettings ?? {}),
        ])
      ).sort((a, b) => a.localeCompare(b, 'sv')),
    [clubSettings.seriesScoringSettings, competitionsList]
  );

  useEffect(() => {
    const unsubscribe = subscribeClubSettingsFromFirestore((settings) => {
      setClubSettings(settings);
    });
    return () => {
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    setLogoBroken(false);
  }, [clubSettings.logoDataUrl]);

  useEffect(() => {
    applyClubThemeToDocument(clubSettings, darkMode);
  }, [clubSettings, darkMode]);
  const [seriesStandings, setSeriesStandings] = useState<SeriesStandingsBundle[]>([]);

  const [competition, setCompetition] = useState<CompetitionMeta>({
    id: '',
    shortCode: '',
    status: 'UPCOMING',
    name: 'Ingen aktiv tävling',
    organizer: 'OK Österåker',
    date: getStockholmTodayIso(),
    zeroTimeStr: '18:00:00',
    zeroTimeSec: 18 * 3600,
  });
  const [courses, setCourses] = useState<Course[]>([]);
  const [classes, setClasses] = useState<CompClass[]>([]);
  const [stations, setStations] = useState<SIStation[]>([]);
  const [competitors, setCompetitors] = useState<Competitor[]>([]);
  const [runnerDb, setRunnerDb] = useState<RunnerDbEntry[]>([]);
  const [runnerForDirectEntry, setRunnerForDirectEntry] = useState<number | null>(null);
  useEffect(() => {
    if (
      !firebaseUserUid ||
      (!isEmptySeason && activeEventId && competitionsList.some((item) => item.id === activeEventId)) ||
      hydratingCompetitionListRef.current
    ) {
      return;
    }

    hydratingCompetitionListRef.current = true;
    void loadFullSeasonFromFirestore()
      .then((cloudSnap) => {
        if (!cloudSnap) return;
        if (cloudSnap.events.length === 0) {
          setIsEmptySeason(true);
          return;
        }
        const selectedEvent =
          cloudSnap.events.find((event) => event.competition.id === activeEventId) ??
          cloudSnap.events.find(
            (event) => event.competition.id === cloudSnap.activeEventId
          ) ??
          cloudSnap.events[0];
        if (!selectedEvent) return;

        setActiveEventId(selectedEvent.competition.id);
        setCompetition(selectedEvent.competition);
        setCourses(selectedEvent.courses);
        setClasses(selectedEvent.classes);
        setCompetitors(selectedEvent.competitors);
        setRunnerDb(cloudSnap.runnerDb ?? []);
        setClubSettings(cloudSnap.clubSettings);
        setSeriesStandings(cloudSnap.seriesStandings ?? []);
        setDemoCleared(cloudSnap.demoCleared);
        setIsEmptySeason(false);
      })
      .catch((error: unknown) => {
        console.error('Kunde inte läsa aktiv tävling från Firestore:', error);
      })
      .finally(() => {
        hydratingCompetitionListRef.current = false;
      });
  }, [activeEventId, competitionsList, firebaseUserUid, isEmptySeason]);

  const [eventor, setEventor] = useState<EventorIntegrationStatus>({
    apiKeyConfigured: false,
    baseUrl: 'https://eventor.orientering.se/api',
    connectedOrgId: null,
    connectedOrgName: null,
    connectedEventId: null,
    lastSyncedAt: null,
    autoCreateFromRunnerDbOnReadout: true,
  });
  const [emergency, setEmergency] = useState<EmergencySettings>({
    brokenControls: [],
    controlTimeOffsets: {},
  });
  const [roc, setRoc] = useState<RocIntegrationStatus>({
    enabled: false,
    unitId: '1042',
    baseUrl: 'https://roc.olresultat.se/getpunches.asp',
    pollIntervalSec: 5,
    lastPunchId: 0,
    lastPolledAt: null,
    totalReceived: 0,
    lastError: null,
  });
  const [events, setEvents] = useState<LiveEventItem[]>([]);

  const [offlineSnap, setOfflineSnap] = useState<OfflineQueueSnapshot>(() =>
    offlineReadoutQueue.getSnapshot()
  );

  const [selectedRunnerId, setSelectedRunnerId] = useState<string | null>(null);
  const [serialStatus, setSerialStatus] = useState<SerialConnectionStatus>(() =>
    sportidentSerial.getStatus()
  );
  const [frameLogs, setFrameLogs] = useState<RawSIFrameLog[]>([]);
  const [inspectHexTarget, setInspectHexTarget] = useState<string | null>(null);

  // Registration & Start Corral Card Capture State (scoped by timestamp + USB mode)
  const [capturedCard, setCapturedCard] = useState<{
    siNumber: number;
    cardSeries: SICardSeries;
    capturedAt: number;
    mode: UsbStationMode;
  } | null>(null);
  const simDbCursorRef = useRef(0);

  // Automatically switch USB station role when the official changes view on the same computer!
  useEffect(() => {
    if (activeTab === 'entries') {
      sportidentSerial.setUsbMode('REGISTRATION');
    } else if (activeTab === 'start_corral') {
      sportidentSerial.setUsbMode('START_CORRAL');
    } else if (
      activeTab === 'readout' ||
      activeTab === 'results' ||
      activeTab === 'forest' ||
      activeTab === 'draw' ||
      activeTab === 'hardware' ||
      activeTab === 'courses'
    ) {
      sportidentSerial.setUsbMode('READOUT');
    }
  }, [activeTab]);

  const [pendingUnknownReadout, setPendingUnknownReadout] = useState<{
    siNumber: number;
    checkTimeSec?: number | null;
    startTimeSec?: number | null;
    finishTimeSec?: number | null;
    punches?: CardPunch[];
    suggestedRunner?: RunnerDbEntry | null;
  } | null>(null);

  useEffect(() => {
    activeEventIdRef.current = activeEventId;
  }, [activeEventId]);

  const handleReadoutResultFeedback = useCallback((res: ReadoutDeliveryResult) => {
    const syncedCompetitor = res.competitor;
    if (res.queuedOffline) {
      if (soundEnabledRef.current) playMeosFeedbackTone('registration');
      return;
    }
    if (res.unknownCardReadout) {
      setPendingUnknownReadout({
        ...res.unknownCardReadout,
        suggestedRunner: res.suggestedRunner ?? null,
      });
      if (soundEnabledRef.current) playMeosFeedbackTone('mp');
    } else if (syncedCompetitor) {
      setCompetitors((current) =>
        current.map((competitor) =>
          competitor.id === syncedCompetitor.id ? syncedCompetitor : competitor
        )
      );
      setSelectedRunnerId(syncedCompetitor.id);
      if (soundEnabledRef.current) {
        playMeosFeedbackTone(syncedCompetitor.status === 'OK' ? 'ok' : 'mp');
      }
    }
  }, []);

  // Subscribe to durable offline readout queue
  useEffect(() => {
    const unsubSnap = offlineReadoutQueue.subscribe(setOfflineSnap);
    const unsubSynced = offlineReadoutQueue.onItemSynced((res) => {
      handleReadoutResultFeedback(res);
    });
    return () => {
      unsubSnap();
      unsubSynced();
    };
  }, [handleReadoutResultFeedback]);

  const appendFrameLog = useCallback((frame: RawSIFrameLog) => {
    setFrameLogs((prev) => [frame, ...prev.slice(0, 149)]);
  }, []);

  const submitFullReadoutToServer = useCallback(
    async (readout: FullCardReadoutPayload) => {
      const res = await offlineReadoutQueue.submitReadoutGuaranteed(
        readout,
        activeEventIdRef.current
      );
      handleReadoutResultFeedback(res);
    },
    [handleReadoutResultFeedback]
  );

  const submitOnlinePunchToServer = useCallback(
    async (params: {
      siNumber: number;
      stationCode: number;
      punchTimeSec?: number;
      rawHex?: string;
    }) => {
      const station = stations.find(
        (candidate) => candidate.stationCode === params.stationCode
      );
      const res = await offlineReadoutQueue.submitOnlinePunchGuaranteed(
        {
          ...params,
          stationName: station?.name,
          stationFunction: station?.stationFunction,
          timeOffsetSec:
            emergency.controlTimeOffsets[String(params.stationCode)] ?? 0,
        },
        activeEventIdRef.current
      );
      if (!res.queuedOffline) {
        const cloudSnap = await loadFullSeasonFromFirestore({
          competitionId: activeEventIdRef.current,
          includeRunnerDb: false,
        });
        const event = cloudSnap?.events.find(
          (candidate) => candidate.competition.id === activeEventIdRef.current
        );
        if (event) setCompetitors(event.competitors);
      }
      if (soundEnabledRef.current) {
        playMeosFeedbackTone(res.queuedOffline ? 'registration' : 'radio');
      }
    },
    [emergency.controlTimeOffsets, stations]
  );

  // Wire physical Web Serial & WebUSB hardware callbacks
  useEffect(() => {
    const unsubStatus = sportidentSerial.onStatusChange(setSerialStatus);
    const unsubFrame = sportidentSerial.onFrame((frame) => {
      appendFrameLog(frame);
      if (
        sportidentSerial.getStatus().usbMode === 'READOUT' &&
        frame.direction === 'RX' &&
        frame.commandHex === '0xD3' &&
        frame.crcValid &&
        frame.siNumber
      ) {
        void submitOnlinePunchToServer({
          siNumber: frame.siNumber,
          stationCode: frame.stationCode ?? 42,
          punchTimeSec: frame.punchTimeSec,
          rawHex: frame.rawHex,
        });
      }
    });
    const unsubReadout = sportidentSerial.onFullCardReadout((readout) => {
      void submitFullReadoutToServer(readout);
    });
    const unsubRegCard = sportidentSerial.onRegistrationCard((siNumber, cardSeries) => {
      const currentMode = sportidentSerial.getStatus().usbMode;
      setCapturedCard({
        siNumber,
        cardSeries,
        capturedAt: Date.now(),
        mode: currentMode,
      });
      if (currentMode === 'START_CORRAL') {
        setActiveTab((prev) => (prev === 'start_corral' ? prev : 'start_corral'));
      } else {
        setActiveTab((prev) => (prev === 'entries' ? prev : 'entries'));
        if (soundEnabledRef.current) playMeosFeedbackTone('registration');
      }
    });

    // Silently reconnect previously authorized USB / WebUSB SI-stations without browser popup
    void sportidentSerial.tryAutoReconnect();

    return () => {
      unsubStatus();
      unsubFrame();
      unsubReadout();
      unsubRegCard();
    };
  }, [appendFrameLog, submitFullReadoutToServer, submitOnlinePunchToServer]);

  const applySnapshot = useCallback((snap: MeosAppState) => {
    if (snap.activeEventId !== undefined) setActiveEventId(snap.activeEventId);
    if (snap.competitionsList) {
      setCompetitionsList(firestoreCompetitionsRef.current ?? snap.competitionsList);
    }
    setIsEmptySeason(Boolean(snap.isEmptySeason));
    if (snap.isFreshColdStart !== undefined) {
      setIsFreshColdStart(Boolean(snap.isFreshColdStart));
    }
    setDemoCleared(Boolean(snap.demoCleared));
    if (snap.clubSettings) setClubSettings(snap.clubSettings);
    if (snap.seriesStandings) setSeriesStandings(snap.seriesStandings);
    setCompetition(snap.competition);
    setCourses(snap.courses);
    setClasses(snap.classes);
    setStations(snap.stations);
    setCompetitors(snap.competitors);
    setRunnerDb(snap.runnerDb ?? []);
    if (snap.eventor) setEventor(snap.eventor);
    if (snap.emergency) setEmergency(snap.emergency);
    if (snap.roc) setRoc(snap.roc);
    setEvents(snap.events);
    setConnectedMonitors(snap.connectedMonitors);
    setLoading(false);
  }, []);

  // Initial state + authenticated WebSocket synchronization for Secretariat
  const authToken = authSession?.token ?? null;
  useEffect(() => {
    if (!authToken) {
      setWsConnected(false);
      return;
    }

    let active = true;
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const loadInitial = async () => {
      try {
        const res = await apiFetch('/api/state');
        if (res.ok && active) {
          const snap = (await res.json()) as MeosAppState;
          applySnapshot(snap);
          return;
        }
      } catch {
        // Express backend not running (e.g. static host on Vercel)
      }

      // Direct client-side Firestore hydration fallback
      try {
        const cloudSnap = await loadFullSeasonFromFirestore();
        if (!active) return;
        if (cloudSnap && cloudSnap.events.length > 0) {
          const activeEvt =
            cloudSnap.events.find((e) => e.competition.id === cloudSnap.activeEventId) ||
            cloudSnap.events[0];
          applySnapshot({
            activeEventId: activeEvt.competition.id,
            competitionsList: cloudSnap.events.map((e) => ({
              id: e.competition.id,
              shortCode: e.competition.shortCode,
              status: e.competition.status,
              name: e.competition.name,
              organizer: e.competition.organizer,
              date: e.competition.date,
              zeroTimeStr: e.competition.zeroTimeStr || '18:00:00',
              arenaInfo: e.competition.arenaInfo || '',
              seriesName: e.competition.seriesName,
              enableFeesAndSwish: Boolean(e.competition.enableFeesAndSwish),
              competitorCount: e.competitors.length,
              finishedCount: e.competitors.filter((c) => c.status === 'OK' || c.status === 'MP').length,
              classCount: e.classes.length,
            })),
            isEmptySeason: false,
            isFreshColdStart: false,
            demoCleared: cloudSnap.demoCleared,
            clubSettings: cloudSnap.clubSettings,
            seriesStandings: cloudSnap.seriesStandings ?? [],
            competition: activeEvt.competition,
            courses: activeEvt.courses,
            classes: activeEvt.classes,
            stations: activeEvt.stations ?? [],
            competitors: activeEvt.competitors,
            runnerDb: cloudSnap.runnerDb ?? [],
            eventor: {
              apiKeyConfigured: false,
              baseUrl: '',
              connectedOrgId: null,
              connectedOrgName: null,
              connectedEventId: null,
              lastSyncedAt: null,
              autoCreateFromRunnerDbOnReadout: true,
            },
            emergency:
              activeEvt.emergency ?? {
                brokenControls: activeEvt.brokenControls,
                controlTimeOffsets: {},
              },
            roc: {
              enabled: false,
              unitId: '1042',
              baseUrl: '',
              pollIntervalSec: 5,
              lastPunchId: 0,
              lastPolledAt: null,
              totalReceived: 0,
              lastError: null,
            },
            events: [],
            connectedMonitors: 1,
          });
        } else {
          setActiveEventId('');
          setCompetitionsList([]);
          setIsEmptySeason(true);
          setCompetition({
            id: '',
            shortCode: '',
            status: 'UPCOMING',
            name: 'Ingen aktiv tävling',
            organizer: cloudSnap?.clubSettings?.clubName || 'OK Österåker',
            date: getStockholmTodayIso(),
            zeroTimeStr: '18:00:00',
            zeroTimeSec: 18 * 3600,
          });
          setCourses([]);
          setClasses([]);
          setCompetitors([]);
          if (cloudSnap?.clubSettings) {
            setClubSettings(cloudSnap.clubSettings);
          }
        }
      } catch (err) {
        console.warn('Kunde inte läsa in tävlingar från Firestore på klienten:', err);
      } finally {
        if (active) setLoading(false);
      }
    };

    const connectWs = () => {
      if (!active) return;
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(
        `${proto}//${window.location.host}/api/ws?token=${encodeURIComponent(authToken)}`
      );

      ws.onopen = () => {
        if (active) setWsConnected(true);
      };

      ws.onmessage = (event) => {
        if (!active) return;
        try {
          const msg = JSON.parse(event.data as string) as {
            type: string;
            payload?: MeosAppState;
          };
          if (msg.type === 'state:sync' && msg.payload) {
            applySnapshot(msg.payload);
          }
        } catch {
          // ignore
        }
      };

      ws.onclose = () => {
        if (!active) return;
        setWsConnected(false);
        reconnectTimer = setTimeout(connectWs, 2500);
      };
    };

    setLoading(true);
    void loadInitial();
    connectWs();

    return () => {
      active = false;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws) ws.close();
    };
  }, [applySnapshot, authToken]);

  // 1. Cold-Start Firestore Hydration: if the server booted without local disk state,
  // restore full club season from Firestore BEFORE enabling upward cloud auto-sync.
  const coldHydrationDoneRef = useRef<boolean>(false);
  const hydratingCloudRef = useRef<boolean>(false);

  useEffect(() => {
    if (
      authSession?.user.sessionKind !== 'ADMIN' ||
      !firebaseUserPresent ||
      loading ||
      !isFreshColdStart ||
      coldHydrationDoneRef.current
    ) {
      return;
    }
    coldHydrationDoneRef.current = true;
    hydratingCloudRef.current = true;

    void (async () => {
      try {
        const cloudSnap = await loadFullSeasonFromFirestore();
        if (cloudSnap && Array.isArray(cloudSnap.events) && cloudSnap.events.length > 0) {
          const res = await apiFetch('/api/system/cloud-hydrate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(cloudSnap),
          });
          if (res.ok) {
            const hydrated = (await res.json()) as MeosAppState;
            applySnapshot(hydrated);
            return;
          }
        } else {
          // If Firestore is empty, export local season and populate Firestore immediately
          const expRes = await apiFetch('/api/system/cloud-export');
          if (expRes.ok) {
            const currentSnap = (await expRes.json()) as CloudSeasonSnapshot;
            await syncFullSeasonToFirestore(
              currentSnap,
              authSession.user.adminTier === 'SUPER_ADMIN'
            );
          }
        }
        setIsFreshColdStart(false);
      } catch {
        setIsFreshColdStart(false);
      } finally {
        hydratingCloudRef.current = false;
      }
    })();
  }, [applySnapshot, authSession, firebaseUserPresent, isFreshColdStart, loading]);

  // 2. Debounced Full-Season Firestore Auto-Sync when a Google Admin is signed in
  const lastCloudSyncSigRef = useRef<string>('');
  useEffect(() => {
    if (
      authSession?.user.sessionKind !== 'ADMIN' ||
      !firebaseUserPresent ||
      loading ||
      isFreshColdStart ||
      hydratingCloudRef.current
    ) {
      return;
    }

    const sig = [
      activeEventId,
      String(demoCleared),
      String(isEmptySeason),
      `${clubSettings.clubName}:${clubSettings.swishNumber}:${clubSettings.defaultDirectEntryFeeSek}:${clubSettings.rentalCardFeeSek}:${clubSettings.missingRentalFeeSek}`,
      competitionsList
        .map(
          (c) =>
            `${c.id}:${c.name}:${c.status}:${c.date}:${c.seriesName || ''}:${String(c.enableFeesAndSwish)}:${c.competitorCount}:${c.finishedCount}`
        )
        .join('|'),
      `${competition.id}:${competition.zeroTimeStr}:${competition.arenaInfo || ''}:${String(competition.enableFeesAndSwish)}`,
      courses
        .map((cr) => `${cr.id}:${cr.name}:${cr.lengthMeters}:${cr.climbMeters}:${cr.controls.join(',')}`)
        .join('|'),
      classes
        .map(
          (cl) =>
            `${cl.id}:${cl.name}:${cl.courseId || ''}:${cl.classFormat || 'STANDARD'}:${(cl.forkCourseIds || []).join(',')}:${String(cl.freeStart)}:${String(cl.autoMatchCourse)}:${cl.feeSek}`
        )
        .join('|'),
      competitors
        .map(
          (cp) =>
            `${cp.id}:${cp.siNumber}:${cp.classId}:${cp.status}:${cp.checkTimeSec ?? -1}:${cp.startTimeSec ?? -1}:${cp.runningTimeSec ?? -1}:${String(cp.feePaid)}:${String(cp.rentalReturned)}`
        )
        .join('|'),
    ].join('::');

    if (sig === lastCloudSyncSigRef.current) return;

    const timer = setTimeout(() => {
      if (hydratingCloudRef.current) return;
      lastCloudSyncSigRef.current = sig;
      void (async () => {
        try {
          const expRes = await apiFetch('/api/system/cloud-export');
          if (!expRes.ok) return;
          const snapshot = (await expRes.json()) as CloudSeasonSnapshot;
          await syncFullSeasonToFirestore(
            snapshot,
            authSession.user.adminTier === 'SUPER_ADMIN'
          );
        } catch {
          // Offline or Firestore unavailable — never disrupt local Secretariat work
        }
      })();
    }, 1200);

    return () => clearTimeout(timer);
  }, [
    activeEventId,
    authSession,
    classes,
    clubSettings,
    competition,
    competitionsList,
    competitors,
    courses,
    demoCleared,
    firebaseUserPresent,
    isEmptySeason,
    isFreshColdStart,
    loading,
  ]);

  function parseTimeToSec(str?: string): number {
    if (!str) return 18 * 3600;
    const parts = str.split(':').map((p) => parseInt(p, 10));
    if (parts.length >= 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
      return parts[0] * 3600 + parts[1] * 60 + (parts[2] || 0);
    }
    return 18 * 3600;
  }

  const handleActivateCompetition = async (eventId: string) => {
    setCompetitionSwitchError(null);
    setSelectedRunnerId(null);
    setPendingUnknownReadout(null);
    if (eventId === activeEventId) return true;
    try {
      const res = await apiFetch(`/api/competitions/${encodeURIComponent(eventId)}/activate`, {
        method: 'POST',
      });
      if (res.ok) {
        const snap = (await res.json()) as MeosAppState;
        if (snap.activeEventId === eventId) {
          applySnapshot(snap);
          return true;
        }
      }
    } catch {
      // Backend not running (Vercel)
    }

    try {
      const cloudSnap = await loadFullSeasonFromFirestore({
        competitionId: eventId,
        includeRunnerDb: false,
      });
      if (!cloudSnap) {
        throw new Error('Tävlingarna kunde inte hämtas från Firestore.');
      }
      const targetEvt = cloudSnap.events.find((e) => e.competition.id === eventId);
      if (!targetEvt) {
        throw new Error('Den valda tävlingen kunde inte hämtas från Firestore.');
      }

      await activateCompetitionInFirestore(eventId);
      setActiveEventId(eventId);
      setCompetition(targetEvt.competition);
      setCourses(targetEvt.courses);
      setClasses(targetEvt.classes);
      setStations(targetEvt.stations ?? []);
      setCompetitors(targetEvt.competitors);
      setEmergency(
        targetEvt.emergency ?? {
          brokenControls: targetEvt.brokenControls,
          controlTimeOffsets: {},
        }
      );
      setIsEmptySeason(false);
      return true;
    } catch (err) {
      console.error('Kunde inte aktivera vald tävling:', err);
      setCompetitionSwitchError(
        err instanceof Error
          ? err.message
          : 'Tävlingen kunde inte aktiveras. Kontrollera anslutningen och försök igen.'
      );
      return false;
    }
  };

  const handleUpdateCompetitionMetadata = async (
    eventId: string,
    patch: {
      status?: EventLifecycleStatus;
      date?: string;
      zeroTimeStr?: string;
      seriesName?: string;
      enableFeesAndSwish?: boolean;
    }
  ) => {
    const useFirestore = await apiRequestUnavailable(
      `/api/competitions/${encodeURIComponent(eventId)}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      },
      'Kunde inte uppdatera tävlingen.'
    );
    if (useFirestore) {
      await updateCompetitionMetadataInFirestore(eventId, patch);
    }
    setCompetitionsList((current) =>
      current.map((item) => (item.id === eventId ? { ...item, ...patch } : item))
    );
    if (activeEventId === eventId) {
      setCompetition((current) => ({ ...current, ...patch }));
    }
  };

  const saveDirectEntryToFirestore = async (
    payload: Parameters<typeof saveDirectCompetitionEntryToFirestore>[0]['payload']
  ) => {
    try {
      return await saveDirectCompetitionEntryToFirestore({
        competitionId: activeEventId,
        payload,
        competitors,
        classes,
        courses,
        emergency,
      });
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.message !== 'Tävlingen hittades inte i Firestore.' ||
        !activeEventId ||
        competition.id !== activeEventId
      ) {
        throw error;
      }

      await createCompetitionInFirestore({
        competitionId: activeEventId,
        shortCode: competition.shortCode,
        name: competition.name,
        organizer: competition.organizer,
        date: competition.date,
        status: competition.status,
        zeroTimeStr: competition.zeroTimeStr,
        zeroTimeSec: competition.zeroTimeSec,
        arenaInfo: competition.arenaInfo,
        seriesName: competition.seriesName,
        enableFeesAndSwish: competition.enableFeesAndSwish,
        courses,
        classes,
      });
      if (competitors.length > 0) {
        await saveCompetitionImportToFirestore({
          competitionId: activeEventId,
          courses,
          classes,
          competitors,
          runnerDbEntries: [],
          competitorCount: competitors.length,
        });
      }
      return saveDirectCompetitionEntryToFirestore({
        competitionId: activeEventId,
        payload,
        competitors,
        classes,
        courses,
        emergency,
      });
    }
  };

  const handleCreateCompetition = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newEvtName.trim()) {
      setCreateEvtError('Ange ett namn på tävlingen eller träningen.');
      return;
    }
    setCreateEvtBusy(true);
    setCreateEvtError(null);
    try {
      const effectiveCourseImport = newEvtCourseParsed
        ? buildEffectiveCourseImportBatch(newEvtCourseParsed, {
            autoCreateClassesIfMissing: newEvtAutoClasses,
            freeStart: newEvtFreeStart,
          })
        : null;

      let snap: MeosAppState | null = null;
      try {
        const res = await apiFetch('/api/competitions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: newEvtName.trim(),
            date: newEvtDate,
            zeroTimeStr: newEvtZeroTime.trim() || '18:00:00',
            arenaInfo: newEvtArena.trim(),
            seriesName: newEvtSeriesName.trim(),
            enableFeesAndSwish: newEvtFeesAndSwish,
            copyCoursesFromActive:
              !effectiveCourseImport && !isEmptySeason && newEvtCopyCourses,
            ...(effectiveCourseImport
              ? {
                  importedCourses: effectiveCourseImport.courses,
                  importedClasses: effectiveCourseImport.classes,
                }
              : {}),
          }),
        });
        if (res.ok) {
          snap = (await res.json()) as MeosAppState;
          applySnapshot(snap);
        }
      } catch {
        // Express backend not available (e.g. running on Vercel)
      }

      const compId = snap?.competition?.id || snap?.activeEventId || `evt-${Date.now()}`;
      const sc = snap?.competition?.shortCode || `oko${Math.floor(1000 + Math.random() * 9000)}`;
      const importedCourses: Course[] = effectiveCourseImport
        ? effectiveCourseImport.courses.map((c, idx) => ({
            id: `crs-${idx + 1}`,
            name: c.name,
            lengthMeters: c.lengthMeters,
            climbMeters: c.climbMeters,
            controls: c.controls,
          }))
        : [];
      const importedClasses: CompClass[] = effectiveCourseImport
        ? effectiveCourseImport.classes.map((cls, idx) => {
            const matched = importedCourses.find((c) => c.name === cls.courseName);
            return {
              id: `cls-${idx + 1}`,
              name: cls.name,
              courseId: matched ? matched.id : null,
              classFormat: cls.classFormat || 'STANDARD',
              allowDirectEntry: true,
              freeStart: cls.freeStart ?? true,
              autoMatchCourse: cls.autoMatchCourse ?? true,
              feeSek: 100,
            };
          })
        : [];

      // ATOMIC FIRESTORE STORAGE: Guarantees all 23 schema fields without undefined
      if (auth.currentUser) {
        await createCompetitionInFirestore({
          competitionId: compId,
          shortCode: sc,
          name: newEvtName.trim(),
          organizer: clubSettings.clubName || 'OK Österåker',
          date: newEvtDate,
          status: 'UPCOMING',
          zeroTimeStr: newEvtZeroTime.trim() || '18:00:00',
          zeroTimeSec: parseTimeToSec(newEvtZeroTime),
          arenaInfo: newEvtArena.trim(),
          seriesName: newEvtSeriesName.trim(),
          allowSelfRegistration: newEvtSelfReg,
          enableFeesAndSwish: newEvtFeesAndSwish,
          courses: snap ? snap.courses : importedCourses,
          classes: snap ? snap.classes : importedClasses,
        });
      } else if (!snap) {
        throw new Error('Du måste vara inloggad med Google för att skapa tävling i Firestore.');
      }

      if (!snap) {
        const newComp: CompetitionMeta = {
          id: compId,
          shortCode: sc,
          name: newEvtName.trim(),
          organizer: clubSettings.clubName || 'OK Österåker',
          date: newEvtDate,
          status: 'UPCOMING',
          zeroTimeStr: newEvtZeroTime.trim() || '18:00:00',
          zeroTimeSec: parseTimeToSec(newEvtZeroTime),
          arenaInfo: newEvtArena.trim(),
          seriesName: newEvtSeriesName.trim(),
          allowSelfRegistration: newEvtSelfReg,
          enableFeesAndSwish: newEvtFeesAndSwish,
        };
        setCompetition(newComp);
        setActiveEventId(compId);
        setCourses(importedCourses);
        setClasses(importedClasses);
        setCompetitors([]);
        setIsEmptySeason(false);
        setCompetitionsList((prev) => [
          {
            id: compId,
            shortCode: sc,
            status: 'UPCOMING',
            name: newEvtName.trim(),
            organizer: clubSettings.clubName || 'OK Österåker',
            date: newEvtDate,
            zeroTimeStr: newEvtZeroTime.trim() || '18:00:00',
            arenaInfo: newEvtArena.trim(),
            seriesName: newEvtSeriesName.trim(),
            enableFeesAndSwish: newEvtFeesAndSwish,
            competitorCount: 0,
            finishedCount: 0,
            classCount: importedClasses.length,
          },
          ...prev,
        ]);
      }

      setSelectedRunnerId(null);
      setPendingUnknownReadout(null);
      setNewEvtName('');
      setNewEvtSeriesName('');
      setNewEvtFeesAndSwish(false);
      setNewEvtCourseParsed(null);
      setNewEvtCourseFileName('');
      setNewEvtAutoClasses(true);
      setNewEvtFreeStart(true);
      setCreateEventModalOpen(false);

      // Trigger full season sync if server is alive
      void (async () => {
        try {
          const expRes = await apiFetch('/api/system/cloud-export');
          if (expRes.ok) {
            const currentSnap = (await expRes.json()) as CloudSeasonSnapshot;
            await syncFullSeasonToFirestore(
              currentSnap,
              authSession?.user.adminTier === 'SUPER_ADMIN'
            );
          }
        } catch {
          // ignore
        }
      })();
    } catch (err: unknown) {
      console.error('Kunde inte skapa tävling:', err);
      const technicalMsg = err instanceof Error ? err.message : String(err || 'Ett tekniskt fel inträffade.');
      setCreateEvtError(technicalMsg);
    } finally {
      setCreateEvtBusy(false);
    }
  };

  // Testbench: build authentic 0xEF (SI10/SIAC), 0xE1 (SI6), or 0xB1 (SI5) binary frames, decode them, and send via offlineReadoutQueue!
  const handleSimulateFullReadout = async (params: {
    protocolKind?: 'SI10_EF' | 'SI6_E1' | 'SI5_B1';
    siNumber: number;
    checkTimeSec: number | null;
    startTimeSec: number | null;
    finishTimeSec: number | null;
    punches: CardPunch[];
  }) => {
    if (params.protocolKind === 'SI5_B1') {
      const rawSi5 = buildSi5ReadoutFrame({
        stationCode: 1,
        siNumber: params.siNumber,
        checkTimeSec: params.checkTimeSec,
        startTimeSec: params.startTimeSec,
        finishTimeSec: params.finishTimeSec,
        punches: params.punches,
      });
      const decoded = decodeSingleFrame(rawSi5, 'RX', 'PROTOCOL_TESTBENCH');
      if (decoded && decoded.blockData) {
        appendFrameLog(decoded);
        const parsedReadout = parseSi5SheetToReadout(
          1,
          decoded.blockData,
          decoded.rawHex,
          'PROTOCOL_TESTBENCH'
        );
        if (parsedReadout) {
          await submitFullReadoutToServer(parsedReadout);
        }
      }
      return;
    }

    if (params.protocolKind === 'SI6_E1') {
      const rawFrames = buildSi6ReadoutBlockFrames({
        stationCode: 1,
        siNumber: params.siNumber,
        checkTimeSec: params.checkTimeSec,
        startTimeSec: params.startTimeSec,
        finishTimeSec: params.finishTimeSec,
        punches: params.punches,
      });
      const blockMap = new Map<number, number[]>();
      let firstHex = '';
      for (const raw of rawFrames) {
        const decoded = decodeSingleFrame(raw, 'RX', 'PROTOCOL_TESTBENCH');
        if (decoded) {
          if (!firstHex) firstHex = decoded.rawHex;
          appendFrameLog(decoded);
          if (decoded.blockNumber !== undefined && decoded.blockData) {
            blockMap.set(decoded.blockNumber, decoded.blockData);
          }
        }
      }
      const parsedReadout = parseSi6BlocksToReadout(
        1,
        blockMap,
        firstHex,
        'PROTOCOL_TESTBENCH'
      );
      if (parsedReadout) {
        await submitFullReadoutToServer(parsedReadout);
      }
      return;
    }

    const rawFrames = buildSi10ReadoutBlockFrames({
      stationCode: 1,
      siNumber: params.siNumber,
      checkTimeSec: params.checkTimeSec,
      startTimeSec: params.startTimeSec,
      finishTimeSec: params.finishTimeSec,
      punches: params.punches,
    });

    const blockMap = new Map<number, number[]>();
    let firstHex = '';

    for (const raw of rawFrames) {
      const decoded = decodeSingleFrame(raw, 'RX', 'PROTOCOL_TESTBENCH');
      if (decoded) {
        if (!firstHex) firstHex = decoded.rawHex;
        appendFrameLog(decoded);
        if (decoded.blockNumber !== undefined && decoded.blockData) {
          blockMap.set(decoded.blockNumber, decoded.blockData);
        }
      }
    }

    const parsedReadout = parseSi9BlocksToReadout(
      1,
      blockMap,
      firstHex,
      'PROTOCOL_TESTBENCH'
    );
    if (parsedReadout) {
      await submitFullReadoutToServer(parsedReadout);
    }
  };

  const handleSimulateOnlinePunch = async (params: {
    stationCode: number;
    siNumber: number;
    punchTimeSec?: number;
  }) => {
    const raw = buildTransRecFrame({
      stationCode: params.stationCode,
      siNumber: params.siNumber,
      timeSec: params.punchTimeSec,
    });
    const decoded = decodeSingleFrame(raw, 'RX', 'PROTOCOL_TESTBENCH');
    if (!decoded || !decoded.siNumber) return;
    appendFrameLog(decoded);

    if (serialStatus.usbMode === 'REGISTRATION' || serialStatus.usbMode === 'START_CORRAL') {
      setCapturedCard({
        siNumber: decoded.siNumber,
        cardSeries: decoded.cardSeries ?? inferCardSeries(decoded.siNumber),
        capturedAt: Date.now(),
        mode: serialStatus.usbMode,
      });
      setActiveTab(serialStatus.usbMode === 'START_CORRAL' ? 'start_corral' : 'entries');
      if (soundEnabledRef.current && serialStatus.usbMode === 'REGISTRATION') {
        playMeosFeedbackTone('registration');
      }
      return;
    }

    await submitOnlinePunchToServer({
      siNumber: decoded.siNumber,
      stationCode: decoded.stationCode ?? params.stationCode,
      punchTimeSec: decoded.punchTimeSec,
      rawHex: decoded.rawHex,
    });
  };

  const handleInjectOnlineHex = async (rawHex: string) => {
    const bytes = hexToBytes(rawHex);
    if (!bytes) return;
    const decoded = decodeSingleFrame(bytes, 'RX', 'PROTOCOL_TESTBENCH');
    if (!decoded || !decoded.crcValid || !decoded.siNumber) return;
    appendFrameLog(decoded);
    await submitOnlinePunchToServer({
      siNumber: decoded.siNumber,
      stationCode: decoded.stationCode ?? 42,
      punchTimeSec: decoded.punchTimeSec,
      rawHex: decoded.rawHex,
    });
  };

  // 1. Public spectator portal (/t/:shortCode & /publik) — zero login required
  if (route.mode === 'PUBLIC') {
    return (
      <PublicPortalView
        shortCode={route.shortCode}
        darkMode={darkMode}
        onToggleDarkMode={() => setDarkMode((d) => !d)}
        onSelectEventShortCode={(sc) => navigatePublicPortal(sc)}
        onSwitchToSecretariat={navigateSecretariat}
      />
    );
  }

  // 2. Quiet initial session verification state
  if (!authReady && !authSession) {
    return (
      <div className="min-h-screen bg-slate-50 dark:bg-slate-950" aria-busy="true" />
    );
  }

  // 3. Inline Secretariat Login Gate (4-digit Role PIN + Google Admin Auth + Offline Emergency Code)
  if (!authSession) {
    return (
      <AuthGateView
        darkMode={darkMode}
        onToggleDarkMode={() => setDarkMode((d) => !d)}
        preferredPublicShortCode={lastPublicShortCode}
        competitions={competitionsList.map((c) => ({
          id: c.id,
          shortCode: c.shortCode,
          name: c.name,
          organizer: c.organizer,
          date: c.date,
          status: c.status,
          pinsCustomized: false,
        }))}
        clubSettings={clubSettings}
        onAuthenticated={(sess) => {
          setAuthSession(sess);
          if (sess.user.sessionKind === 'PIN_OFFICIAL') {
            handleChangeRoleMode(sess.user.officialRole as OfficialRoleMode, false);
          } else {
            handleChangeRoleMode('ALL', true);
          }
        }}
        onOpenPublicPortal={navigatePublicPortal}
      />
    );
  }

  const isPinOfficial = authSession.user.sessionKind === 'PIN_OFFICIAL';
  const isAdminSession = authSession.user.sessionKind === 'ADMIN';
  const sidebarCompetition =
    competitionsList.find((item) => item.id === activeEventId) ??
    (isEmptySeason ? competitionsList[0] : undefined);
  const sidebarIsEmptySeason = isEmptySeason && !sidebarCompetition;
  const effectiveRoleMode: OfficialRoleMode = isPinOfficial
    ? (authSession.user.officialRole as OfficialRoleMode)
    : roleMode;

  // Count badge for "Kvar i skogen" in sidebar
  const forestCount = competitors.filter(
    (c) =>
      c.status === 'CHECKED' ||
      c.status === 'IN_FOREST' ||
      c.status === 'PRELIMINARY_FIN'
  ).length;

  const emergencyActiveCount =
    emergency.brokenControls.length + Object.keys(emergency.controlTimeOffsets).length;

  const visibleNavItems = NAV_ITEMS.filter((item) =>
    ROLE_ALLOWED_TABS[effectiveRoleMode].includes(item.id)
  );
  const activeNavLabel = NAV_ITEMS.find((n) => n.id === activeTab)?.label ?? 'Översikt';
  const activePublicShortCode = competition.shortCode || 'oko26a';

  return (
    <div className="min-h-screen flex club-canvas bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 overflow-x-clip">
      {/* Desktop Sidebar */}
      <aside className="hidden lg:flex lg:flex-col lg:w-60 lg:shrink-0 club-surface bg-white dark:bg-slate-900 border-r border-slate-200 dark:border-slate-800">
        <div className="min-h-12 py-1.5 px-3.5 flex items-center justify-between gap-2 border-b border-slate-200 dark:border-slate-800">
          <button
            type="button"
            onClick={() => setActiveTab(visibleNavItems[0]?.id ?? 'readout')}
            className="inline-flex items-center gap-2 min-w-0 text-left"
          >
            {clubSettings.logoDataUrl && !logoBroken && (
              <img
                src={clubSettings.logoDataUrl}
                alt={`${clubSettings.clubName || 'Klubb'} logotyp`}
                referrerPolicy="no-referrer"
                onError={() => setLogoBroken(true)}
                className="h-6 w-auto max-w-[84px] object-contain shrink-0"
              />
            )}
            <span className="text-sm font-display font-bold tracking-tight truncate">
              {clubSettings.portalTitle?.trim() || 'PasserSI'}
            </span>
          </button>
        </div>

        {/* Competition & Role Context (Admin Multi-Event Switcher vs Locked Official Station) */}
        <div className="p-2.5 border-b border-slate-200 dark:border-slate-800 relative">
          {isPinOfficial ? (
            <div className="px-2.5 py-2 bg-slate-50 dark:bg-slate-800/70 border border-slate-200 dark:border-slate-700 rounded-lg space-y-0.5">
              <div className="flex items-center justify-between gap-2 text-[11px] text-slate-500 dark:text-slate-400">
                <span className="inline-flex items-center gap-1 font-medium">
                  <Lock className="w-3 h-3 shrink-0" />
                  <span>Låst station</span>
                </span>
                <button
                  type="button"
                  onClick={() => void handleLogout()}
                  className="font-semibold club-accent-text hover:underline whitespace-nowrap shrink-0"
                >
                  Byt roll
                </button>
              </div>
              <div className="text-xs font-semibold text-slate-900 dark:text-slate-100 truncate">
                {authSession.user.lockedEventName || competition.name}
              </div>
              <div className="text-[11px] text-slate-600 dark:text-slate-300 truncate">
                {authSession.user.displayName}
              </div>
            </div>
          ) : (
            <>
              {competitionsList.length > 1 ? (
                <label className="block">
                  <span className="sr-only">Aktiv tävling</span>
                  <select
                    id="desktop-event-select"
                    value={
                      competitionsList.some((item) => item.id === activeEventId)
                        ? activeEventId
                        : competitionsList[0].id
                    }
                    onChange={(e) => void handleActivateCompetition(e.target.value)}
                    aria-describedby={
                      competitionSwitchError ? 'competition-switch-error' : undefined
                    }
                    className="w-full px-2.5 py-2 text-xs font-semibold bg-slate-50 dark:bg-slate-800/70 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-100"
                  >
                    {competitionsList.map((ev) => (
                      <option key={ev.id} value={ev.id}>
                        {ev.name} ({ev.date})
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <div className="px-2.5 py-1.5 bg-slate-50 dark:bg-slate-800/70 border border-slate-200 dark:border-slate-700 rounded-lg">
                  <div className="text-xs font-semibold text-slate-900 dark:text-slate-100 truncate">
                    {sidebarIsEmptySeason
                      ? 'Ingen aktiv tävling'
                      : sidebarCompetition?.name || competition.name}
                  </div>
                  <div className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
                    {sidebarIsEmptySeason
                      ? 'Tom säsong'
                      : `${formatLifecycleLabel(sidebarCompetition?.status ?? competition.status)} · ${sidebarCompetition?.date ?? competition.date} kl. ${(sidebarCompetition?.zeroTimeStr ?? competition.zeroTimeStr).slice(0, 5)}`}
                  </div>
                </div>
              )}
              {competitionsList.length > 1 && sidebarCompetition && (
                <div className="mt-1 px-2.5 text-[11px] text-slate-500 dark:text-slate-400 truncate">
                  {formatLifecycleLabel(sidebarCompetition.status)} · {sidebarCompetition.date} kl.{' '}
                  {sidebarCompetition.zeroTimeStr.slice(0, 5)}
                </div>
              )}
              {competitionSwitchError && (
                <p
                  id="competition-switch-error"
                  role="alert"
                  className="mt-1 px-2.5 text-[11px] text-red-600 dark:text-red-400"
                >
                  {competitionSwitchError}
                </p>
              )}

              {/* Funktionärsläge (Admin Workspace Preview Filter) */}
              <div className="mt-2 flex items-center gap-2">
                <label
                  htmlFor="desktop-role-select"
                  className="text-[11px] font-medium text-slate-500 dark:text-slate-400 shrink-0"
                >
                  Roll:
                </label>
                <select
                  id="desktop-role-select"
                  value={roleMode}
                  onChange={(e) => handleChangeRoleMode(e.target.value as OfficialRoleMode)}
                  className="w-0 max-w-full flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap px-2 py-1 text-xs font-medium bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-md text-slate-800 dark:text-slate-200"
                >
                  {(Object.keys(ROLE_MODE_LABELS) as OfficialRoleMode[]).map((rKey) => (
                    <option key={rKey} value={rKey}>
                      {ROLE_MODE_LABELS[rKey]}
                    </option>
                  ))}
                </select>
              </div>
            </>
          )}
        </div>

        <nav className="flex-1 p-2 space-y-0.5 overflow-y-auto" aria-label="Tävlingsmeny">
          {visibleNavItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveTab(item.id)}
                className={`w-full flex items-center justify-between gap-2 px-2.5 py-2 text-[13px] font-medium rounded-lg transition-colors whitespace-nowrap ${
                  isActive
                    ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100/80 dark:hover:bg-slate-800/60'
                }`}
              >
                <span className="flex items-center gap-2.5 min-w-0">
                  <Icon className="w-4 h-4 shrink-0" />
                  <span className="truncate">{item.label}</span>
                </span>
                {item.id === 'forest' && forestCount > 0 && (
                  <span
                    className={`text-xs font-mono tabular-nums ${
                      isActive
                        ? 'text-slate-200 dark:text-slate-700'
                        : 'text-amber-700 dark:text-amber-400'
                    }`}
                  >
                    {forestCount}
                  </span>
                )}
                {item.id === 'hardware' && emergencyActiveCount > 0 && (
                  <span
                    className={`text-xs font-mono tabular-nums ${
                      isActive
                        ? 'text-slate-200 dark:text-slate-700'
                        : 'text-red-600 dark:text-red-400'
                    }`}
                  >
                    {emergencyActiveCount}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        <div className="p-3 border-t border-slate-200 dark:border-slate-800 space-y-1.5 text-xs">
          <div className="flex items-center justify-between text-[11px] text-slate-600 dark:text-slate-400">
            <span>Synk · USB</span>
            <span className="font-mono tabular-nums font-medium text-slate-900 dark:text-slate-200 truncate">
              {offlineSnap.simulatedOffline || !offlineSnap.browserOnline
                ? `Skog (${offlineSnap.pendingItems.length})`
                : wsConnected
                ? `Live (${connectedMonitors})`
                : 'Synkar'}{' '}
              ·{' '}
              {!serialStatus.connected
                ? 'USB ej ansl.'
                : serialStatus.usbMode === 'REGISTRATION'
                ? 'USB: Anm.'
                : serialStatus.usbMode === 'START_CORRAL'
                ? 'USB: Start'
                : 'USB: Mål'}
            </span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => setSoundEnabled((v) => !v)}
              className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 rounded transition-colors whitespace-nowrap shrink-0"
            >
              {soundEnabled ? <Volume2 className="w-3.5 h-3.5" /> : <VolumeX className="w-3.5 h-3.5" />}
              <span>Ljud {soundEnabled ? 'på' : 'av'}</span>
            </button>
            <PWAInstallButton />
          </div>
          <div className="pt-1.5 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="text-xs font-medium text-slate-900 dark:text-slate-100 truncate">
                {authSession.user.displayName}
              </div>
              <div className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
                {authSession.user.email ||
                  (isPinOfficial ? 'Funktionärs-PIN' : 'Offline reservkod')}
              </div>
            </div>
            <button
              type="button"
              onClick={() => void handleLogout()}
              className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded transition-colors whitespace-nowrap shrink-0"
              title={
                isPinOfficial
                  ? 'Byt funktionärsroll / tillbaka till PIN-sidan'
                  : 'Logga ut från sekretariatet'
              }
            >
              <LogOut className="w-3.5 h-3.5" />
              <span>{isPinOfficial ? 'Byt roll' : 'Logga ut'}</span>
            </button>
          </div>
        </div>
      </aside>

      {/* Mobile Drawer */}
      {mobileNavOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div
            className="fixed inset-0 bg-slate-950/50"
            onClick={() => setMobileNavOpen(false)}
          />
          <aside className="relative z-10 w-68 max-w-[85vw] club-surface bg-white dark:bg-slate-900 border-r border-slate-200 dark:border-slate-800 flex flex-col">
            <div className="min-h-12 py-1.5 px-4 flex items-center justify-between gap-2 border-b border-slate-200 dark:border-slate-800">
              <div className="flex items-center gap-2 min-w-0">
                {clubSettings.logoDataUrl && !logoBroken && (
                  <img
                    src={clubSettings.logoDataUrl}
                    alt={`${clubSettings.clubName || 'Klubb'} logotyp`}
                    referrerPolicy="no-referrer"
                    onError={() => setLogoBroken(true)}
                    className="h-6 w-auto max-w-[96px] object-contain shrink-0"
                  />
                )}
                <span className="text-base font-display font-bold truncate">
                  {clubSettings.portalTitle?.trim() || 'PasserSI'}
                </span>
              </div>
              <button
                type="button"
                onClick={() => setMobileNavOpen(false)}
                className="p-1.5 text-slate-500 rounded-lg shrink-0"
                aria-label="Stäng meny"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-2.5 border-b border-slate-200 dark:border-slate-800 space-y-1.5">
              {isPinOfficial ? (
                <div className="px-2.5 py-1.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg space-y-0.5">
                  <div className="flex items-center justify-between gap-2 text-[11px] font-medium text-slate-500 dark:text-slate-400">
                    <span>Låst station · {competition.date}</span>
                    <button
                      type="button"
                      onClick={() => void handleLogout()}
                      className="font-semibold club-accent-text hover:underline whitespace-nowrap shrink-0"
                    >
                      Byt roll
                    </button>
                  </div>
                  <div className="text-xs font-semibold text-slate-900 dark:text-slate-100 truncate">
                    {authSession.user.lockedEventName || competition.name}
                  </div>
                </div>
              ) : (
                <>
                  {competitionsList.length > 1 ? (
                    <label className="block">
                      <span className="block mb-1 text-[11px] font-medium text-slate-500 dark:text-slate-400">
                        Aktiv tävling
                      </span>
                      <select
                        id="mobile-event-select"
                        value={
                          competitionsList.some((item) => item.id === activeEventId)
                            ? activeEventId
                            : competitionsList[0].id
                        }
                        onChange={(e) => {
                          void handleActivateCompetition(e.target.value);
                          setMobileNavOpen(false);
                        }}
                        className="w-full px-2.5 py-1.5 text-xs font-medium bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-100"
                      >
                        {competitionsList.map((ev) => (
                          <option key={ev.id} value={ev.id}>
                            {ev.name} ({ev.date})
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null}
                  {competitionSwitchError && (
                    <p
                      id="mobile-competition-switch-error"
                      role="alert"
                      className="text-[11px] text-red-600 dark:text-red-400"
                    >
                      {competitionSwitchError}
                    </p>
                  )}
                  <div className="flex items-center gap-2 pt-0.5">
                    <label
                      htmlFor="mobile-role-select"
                      className="text-[11px] font-medium text-slate-500 dark:text-slate-400 shrink-0"
                    >
                      Roll:
                    </label>
                    <select
                      id="mobile-role-select"
                      value={roleMode}
                      onChange={(e) => handleChangeRoleMode(e.target.value as OfficialRoleMode)}
                      className="w-0 max-w-full flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap px-2 py-1 text-xs font-medium bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-100"
                    >
                      {(Object.keys(ROLE_MODE_LABELS) as OfficialRoleMode[]).map((rKey) => (
                        <option key={rKey} value={rKey}>
                          {ROLE_MODE_LABELS[rKey]}
                        </option>
                      ))}
                    </select>
                  </div>
                </>
              )}
            </div>
            <nav className="flex-1 p-2 space-y-0.5 overflow-y-auto">
              {visibleNavItems.map((item) => {
                const Icon = item.icon;
                const isActive = activeTab === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      setActiveTab(item.id);
                      setMobileNavOpen(false);
                    }}
                    className={`w-full flex items-center gap-2.5 px-2.5 py-2 text-[13px] font-medium rounded-lg ${
                      isActive
                        ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900'
                        : 'text-slate-600 dark:text-slate-400'
                    }`}
                  >
                    <Icon className="w-4 h-4 shrink-0" />
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </nav>
            <div className="p-2.5 border-t border-slate-200 dark:border-slate-800 space-y-2">
              <div className="flex items-center justify-between gap-2 text-xs">
                <div className="min-w-0">
                  <div className="font-medium text-slate-900 dark:text-slate-100 truncate">
                    {authSession.user.displayName}
                  </div>
                  <div className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
                    {authSession.user.email ||
                      (isPinOfficial ? 'Funktionärs-PIN' : 'Offline reservkod')}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void handleLogout()}
                  className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-md whitespace-nowrap shrink-0"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  <span>{isPinOfficial ? 'Byt roll' : 'Logga ut'}</span>
                </button>
              </div>
              <PWAInstallButton />
            </div>
          </aside>
        </div>
      )}

      {/* Main Content */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top Bar Contract: Breadcrumb Left — Actions Right */}
        <header className="h-12 px-3 sm:px-5 lg:px-6 club-surface bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-2 sm:gap-4">
          <div className="flex items-center gap-2 min-w-0">
            <button
              type="button"
              onClick={() => setMobileNavOpen(true)}
              className="lg:hidden p-1.5 -ml-1 text-slate-600 dark:text-slate-300 rounded-lg shrink-0"
              aria-label="Öppna meny"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div className="flex items-center gap-1.5 text-xs sm:text-sm min-w-0">
              <span className="club-muted text-slate-500 dark:text-slate-400 hidden md:inline truncate max-w-[240px]">
                {isEmptySeason ? clubSettings.clubName : competition.name}
              </span>
              <span className="text-slate-300 dark:text-slate-700 hidden md:inline">/</span>
              <span className="font-semibold truncate">
                {activeNavLabel}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
            {(offlineSnap.simulatedOffline ||
              !offlineSnap.browserOnline ||
              offlineSnap.pendingItems.length > 0) && (
              <button
                type="button"
                onClick={() => setActiveTab('readout')}
                className="hidden md:inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-amber-800 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/50 border border-amber-200 dark:border-amber-900 rounded-lg whitespace-nowrap shrink-0"
              >
                <CloudOff className="w-3.5 h-3.5 shrink-0" />
                <span className="font-mono tabular-nums">
                  Kö ({offlineSnap.pendingItems.length})
                </span>
              </button>
            )}

            <button
              type="button"
              onClick={() => void handleLogout()}
              title={
                isPinOfficial
                  ? 'Byt funktionärsroll / tillbaka till PIN-inloggning'
                  : 'Logga ut från sekretariatet'
              }
              aria-label={isPinOfficial ? 'Byt roll' : 'Logga ut'}
              className="inline-flex items-center gap-1.5 p-1.5 sm:px-2.5 sm:py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 border border-transparent sm:border-slate-200/80 sm:dark:border-slate-700 rounded-lg transition-colors whitespace-nowrap shrink-0"
            >
              <LogOut className="w-3.5 h-3.5 shrink-0" />
              <span className="hidden sm:inline">
                {isPinOfficial ? 'Byt roll' : 'Logga ut'}
              </span>
            </button>

            <button
              type="button"
              onClick={() => setDarkMode((d) => !d)}
              className="p-1.5 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors shrink-0"
              aria-label="Växla tema"
            >
              {darkMode ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </button>

            <button
              type="button"
              onClick={() =>
                navigatePublicPortal(isEmptySeason ? null : activePublicShortCode)
              }
              className="inline-flex items-center gap-1.5 px-2.5 sm:px-3 py-1.5 text-xs font-semibold text-slate-800 dark:text-slate-100 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 border border-slate-200/80 dark:border-slate-700 rounded-lg transition-colors whitespace-nowrap shrink-0"
            >
              <Eye className="w-3.5 h-3.5 shrink-0" />
              <span>Publik vy</span>
            </button>
          </div>
        </header>

        <main className="flex-1 min-w-0 p-1.5 sm:p-2.5 lg:p-3 w-full">
          {createEventModalOpen && isAdminSession && (
            <section className="mb-4 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
              <div className="px-4 py-2.5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <FolderPlus className="w-4 h-4 text-slate-700 dark:text-slate-300 shrink-0" />
                  <h2 className="text-sm font-display font-bold text-slate-900 dark:text-slate-100 truncate">
                    Skapa ny tävling eller klubbträning
                  </h2>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setNewEvtCourseParsed(null);
                    setNewEvtCourseFileName('');
                    setCreateEvtError(null);
                    setCreateEventModalOpen(false);
                  }}
                  className="p-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg shrink-0"
                  aria-label="Stäng"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <form onSubmit={handleCreateCompetition} className="p-4 space-y-3">
                {createEvtError && (
                  <div className="px-3 py-2 text-xs font-medium text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-900 rounded-lg">
                    {createEvtError}
                  </div>
                )}

                <div>
                  <label className="block text-[11px] font-medium text-slate-700 dark:text-slate-300 mb-1">
                    Tävlingens / träningens namn
                  </label>
                  <input
                    type="text"
                    required
                    value={newEvtName}
                    onChange={(e) => setNewEvtName(e.target.value)}
                    placeholder="t.ex. Torsdagsträning Lunsen — Medeldistans"
                    className="w-full px-2.5 py-1.5 text-xs sm:text-sm bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-100"
                  />
                </div>

                <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                  <div>
                    <label className="block text-[11px] font-medium text-slate-700 dark:text-slate-300 mb-1">
                      Datum
                    </label>
                    <input
                      type="date"
                      value={newEvtDate}
                      onChange={(e) => setNewEvtDate(e.target.value)}
                      className="w-full px-2.5 py-1.5 text-xs sm:text-sm font-mono tabular-nums bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-100"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-slate-700 dark:text-slate-300 mb-1">
                      Nolltid (styr när den pågår)
                    </label>
                    <input
                      type="text"
                      value={newEvtZeroTime}
                      onChange={(e) => setNewEvtZeroTime(e.target.value)}
                      placeholder="18:00:00"
                      className="w-full px-2.5 py-1.5 text-xs sm:text-sm font-mono tabular-nums bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-100"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-slate-700 dark:text-slate-300 mb-1">
                      Serie (valfritt)
                    </label>
                    <select
                      value={newEvtSeriesName}
                      onChange={(e) => setNewEvtSeriesName(e.target.value)}
                      className="w-full px-2.5 py-1.5 text-xs sm:text-sm bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-100"
                    >
                      <option value="">Ingen serie</option>
                      {availableSeriesNames.map((seriesName) => (
                        <option key={seriesName} value={seriesName}>
                          {seriesName}
                        </option>
                      ))}
                    </select>
                    {availableSeriesNames.length === 0 && (
                      <p className="mt-1 text-[10px] text-slate-500">
                        Skapa serier under Tävlingar och Serier → Serier.
                      </p>
                    )}
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-slate-700 dark:text-slate-300 mb-1">
                      Arenainfo / PM
                    </label>
                    <input
                      type="text"
                      value={newEvtArena}
                      onChange={(e) => setNewEvtArena(e.target.value)}
                      placeholder="Samling vid klubbstugan"
                      className="w-full px-2.5 py-1.5 text-xs sm:text-sm bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-100"
                    />
                  </div>
                </div>

                {/* Optional Direct Course File Upload (Purple Pen / Condes / OCAD) */}
                <div className="px-3 py-2 rounded-lg bg-slate-50/80 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800 space-y-1.5">
                  {!newEvtCourseParsed ? (
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="text-xs text-slate-700 dark:text-slate-300 min-w-0">
                        <span className="font-medium text-slate-900 dark:text-slate-100">
                          Banfil från Purple Pen / Condes / OCAD
                        </span>
                        <span className="text-slate-500 dark:text-slate-400">
                          {' '}
                          · valfritt (IOF XML 3.0 eller 2.0.3)
                        </span>
                      </div>
                      <label className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-slate-800 dark:text-slate-100 bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 border border-slate-300 dark:border-slate-700 rounded-md cursor-pointer transition-colors whitespace-nowrap shrink-0">
                        <Upload className="w-3.5 h-3.5 shrink-0" />
                        <span>Ladda upp banfil (.xml)</span>
                        <input
                          type="file"
                          accept=".xml,text/xml,application/xml"
                          onChange={(e) => void handleNewEvtCourseFileUpload(e)}
                          className="sr-only"
                        />
                      </label>
                    </div>
                  ) : (
                    (() => {
                      const eff = buildEffectiveCourseImportBatch(newEvtCourseParsed, {
                        autoCreateClassesIfMissing: newEvtAutoClasses,
                        freeStart: newEvtFreeStart,
                      });
                      return (
                        <div className="space-y-1.5">
                          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                            <div className="font-medium text-emerald-800 dark:text-emerald-300 min-w-0 truncate">
                              {newEvtCourseFileName} · IOF XML{' '}
                              {newEvtCourseParsed.iofVersion ?? '3.0'} · {eff.courses.length} banor ·{' '}
                              {eff.classes.length} klasser
                              {eff.classesSynthesized
                                ? ' (skapas automatiskt)'
                                : newEvtCourseParsed.classes.length > 0
                                ? ' (från banfilen)'
                                : ''}
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                              <label className="text-xs font-medium text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-slate-100 cursor-pointer whitespace-nowrap">
                                <span>Byt fil</span>
                                <input
                                  type="file"
                                  accept=".xml,text/xml,application/xml"
                                  onChange={(e) => void handleNewEvtCourseFileUpload(e)}
                                  className="sr-only"
                                />
                              </label>
                              <span className="text-slate-300 dark:text-slate-700">·</span>
                              <button
                                type="button"
                                onClick={() => {
                                  setNewEvtCourseParsed(null);
                                  setNewEvtCourseFileName('');
                                }}
                                className="text-xs font-medium text-red-600 dark:text-red-400 hover:underline whitespace-nowrap"
                              >
                                Ta bort fil
                              </button>
                            </div>
                          </div>

                          <div className="text-[11px] font-mono tabular-nums text-slate-600 dark:text-slate-400 truncate">
                            {eff.courses
                              .map(
                                (cr) =>
                                  `${cr.name} (${
                                    cr.lengthMeters > 0 ? `${cr.lengthMeters} m, ` : ''
                                  }${cr.controls.length} ktr)`
                              )
                              .join(' · ')}
                          </div>

                          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pt-0.5">
                            <label className="inline-flex items-center gap-1.5 text-xs text-slate-700 dark:text-slate-300 cursor-pointer">
                              <input
                                type="checkbox"
                                checked={newEvtFreeStart}
                                onChange={(e) => setNewEvtFreeStart(e.target.checked)}
                                className="rounded border-slate-300 dark:border-slate-700"
                              />
                              <span>Fri starttid på importerade klasser</span>
                            </label>
                            {newEvtCourseParsed.classes.length === 0 && (
                              <label className="inline-flex items-center gap-1.5 text-xs text-slate-700 dark:text-slate-300 cursor-pointer">
                                <input
                                  type="checkbox"
                                  checked={newEvtAutoClasses}
                                  onChange={(e) => setNewEvtAutoClasses(e.target.checked)}
                                  className="rounded border-slate-300 dark:border-slate-700"
                                />
                                <span>Skapa klasser automatiskt (1 per bana)</span>
                              </label>
                            )}
                          </div>
                        </div>
                      );
                    })()
                  )}
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-slate-200 dark:border-slate-800">
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
                    <label className="flex items-center gap-1.5 text-xs text-slate-700 dark:text-slate-300 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={newEvtSelfReg}
                        onChange={(e) => setNewEvtSelfReg(e.target.checked)}
                        className="rounded border-slate-300 dark:border-slate-700"
                      />
                      <span>Mobil självregistrering</span>
                    </label>
                    <label className="flex items-center gap-1.5 text-xs text-slate-700 dark:text-slate-300 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={newEvtFeesAndSwish}
                        onChange={(e) => setNewEvtFeesAndSwish(e.target.checked)}
                        className="rounded border-slate-300 dark:border-slate-700"
                      />
                      <span>Avgift / Swish-QR</span>
                    </label>
                    {!isEmptySeason && !newEvtCourseParsed && (
                      <label className="flex items-center gap-1.5 text-xs text-slate-700 dark:text-slate-300 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={newEvtCopyCourses}
                          onChange={(e) => setNewEvtCopyCourses(e.target.checked)}
                          className="rounded border-slate-300 dark:border-slate-700"
                        />
                        <span>Kopiera banor</span>
                      </label>
                    )}
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => {
                        setNewEvtCourseParsed(null);
                        setNewEvtCourseFileName('');
                        setCreateEvtError(null);
                        setCreateEventModalOpen(false);
                      }}
                      className="px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg whitespace-nowrap shrink-0"
                    >
                      Avbryt
                    </button>
                    <button
                      type="submit"
                      disabled={createEvtBusy}
                      className="px-3.5 py-1.5 text-xs font-medium club-accent-btn disabled:opacity-50 rounded-lg transition-colors whitespace-nowrap shrink-0"
                    >
                      {createEvtBusy ? 'Skapar...' : 'Skapa & öppna'}
                    </button>
                  </div>
                </div>
              </form>
            </section>
          )}

          {loading ? (
            <div className="space-y-3 animate-pulse">
              <div className="h-14 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl" />
              <div className="h-80 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl" />
            </div>
          ) : isEmptySeason &&
            competitionsList.length === 0 &&
            activeTab !== 'access' &&
            activeTab !== 'season' &&
            activeTab !== 'runner_db' &&
            activeTab !== 'protocol' ? (
            <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 max-w-2xl">
              <h1 className="text-lg font-display font-bold text-slate-900 dark:text-slate-100">
                Inga aktiva tävlingar i {clubSettings.clubName}
              </h1>
              <p className="text-xs sm:text-sm text-slate-600 dark:text-slate-400 mt-1.5">
                Säsongen är tom och redo för klubbens egna tävlingar och träningar. Skapa en ny
                tävling direkt eller öppna Klubbadmin för att hämta data från molnet eller en
                säkerhetskopia (.json).
              </p>
              <div className="flex flex-wrap items-center gap-2.5 mt-4">
                {isAdminSession && (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        setNewEvtFeesAndSwish(false);
                        setCreateEventModalOpen(true);
                      }}
                      className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-white bg-red-600 hover:bg-red-700 rounded-lg transition-colors whitespace-nowrap shrink-0"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      <span>Skapa ny tävling / träning</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setActiveTab('season')}
                      className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg transition-colors whitespace-nowrap shrink-0"
                    >
                      <KeyRound className="w-3.5 h-3.5" />
                      <span>Klubbadmin & Molnsynk</span>
                    </button>
                  </>
                )}
              </div>
            </section>
          ) : (
            <>
              {activeTab === 'competition_settings' && (
                <CompetitionSettingsView
                  isAdmin={isAdminSession}
                  competition={competition}
                  eventor={eventor}
                  runnerDbCount={runnerDb.length}
                  onUpdateCompetition={async (patch) => {
                    const useFirestore = await apiRequestUnavailable(
                      '/api/competition',
                      {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(patch),
                      },
                      'Kunde inte spara tävlingsinställningarna.'
                    );
                    if (!useFirestore) return;
                    await updateCompetitionMetadataInFirestore(activeEventId, patch);
                    setCompetition((current) => ({ ...current, ...patch }));
                  }}
                  onOpenPublicPortal={() => navigatePublicPortal(activePublicShortCode)}
                  onUpdateEventorSettings={async (patch) => {
                    await apiFetch('/api/eventor/settings', {
                      method: 'PUT',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify(patch),
                    });
                  }}
                  onSyncEventorClub={async () => {
                    const res = await apiFetch('/api/eventor/sync-club', { method: 'POST' });
                    const data = (await res.json()) as {
                      error?: string;
                      orgName?: string;
                      syncedRunners?: number;
                      totalRunnerDb?: number;
                    };
                    if (!res.ok) {
                      return {
                        ok: false,
                        message: data.error ?? 'Kunde inte synka mot Eventor API.',
                      };
                    }
                    return {
                      ok: true,
                      message: `Synkade ${data.syncedRunners ?? 0} klubbmedlemmar med SI-brickor från ${data.orgName ?? 'Eventor'} (totalt ${data.totalRunnerDb ?? 0} i Löpardatabasen).`,
                    };
                  }}
                  onImportEventorEvent={async (eventId) => {
                    const res = await apiFetch('/api/eventor/import-event', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ eventId }),
                    });
                    const data = (await res.json()) as {
                      error?: string;
                      eventName?: string;
                      addedClasses?: number;
                      addedEntries?: number;
                    };
                    if (!res.ok) {
                      return {
                        ok: false,
                        message: data.error ?? 'Kunde inte hämta tävling från Eventor.',
                      };
                    }
                    return {
                      ok: true,
                      message: `Hämtade "${data.eventName ?? eventId}" från Eventor: +${data.addedClasses ?? 0} klasser och +${data.addedEntries ?? 0} anmälda deltagare.`,
                    };
                  }}
                  onImportIofBatch={async (batch) => {
                    const res = await apiFetch('/api/import/batch', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify(batch),
                    });
                    const contentType = res.headers.get('content-type') || '';
                    const responseBody = await res.text();
                    interface ImportBatchResult {
                      error?: string;
                      addedCourses?: number;
                      addedClasses?: number;
                      addedEntries?: number;
                      syncedRunnerDb?: number;
                    }
                    let responseData: ImportBatchResult | null = null;
                    try {
                      const parsedResponse: unknown = JSON.parse(responseBody);
                      if (
                        parsedResponse !== null &&
                        typeof parsedResponse === 'object' &&
                        !Array.isArray(parsedResponse)
                      ) {
                        responseData = parsedResponse as ImportBatchResult;
                      }
                    } catch {
                      responseData = null;
                    }
                    if (
                      contentType.includes('application/json') &&
                      res.status !== 404 &&
                      !responseData
                    ) {
                      throw new Error('Importservern returnerade ett ogiltigt JSON-svar.');
                    }
                    if (res.ok && responseData) {
                      if (
                        typeof responseData.addedCourses !== 'number' ||
                        !Number.isInteger(responseData.addedCourses) ||
                        responseData.addedCourses < 0 ||
                        typeof responseData.addedClasses !== 'number' ||
                        !Number.isInteger(responseData.addedClasses) ||
                        responseData.addedClasses < 0 ||
                        typeof responseData.addedEntries !== 'number' ||
                        !Number.isInteger(responseData.addedEntries) ||
                        responseData.addedEntries < 0 ||
                        (responseData.syncedRunnerDb !== undefined &&
                          (typeof responseData.syncedRunnerDb !== 'number' ||
                            !Number.isInteger(responseData.syncedRunnerDb) ||
                            responseData.syncedRunnerDb < 0))
                      ) {
                        throw new Error('Importservern returnerade ofullständig statistik.');
                      }
                      return {
                        addedCourses: responseData.addedCourses,
                        addedClasses: responseData.addedClasses,
                        addedEntries: responseData.addedEntries,
                        syncedRunnerDb: responseData.syncedRunnerDb,
                      };
                    }
                    if (!res.ok && responseData && res.status !== 404) {
                      throw new Error(responseData.error || 'Kunde inte importera XML-filen.');
                    }
                    if (!res.ok && res.status !== 404) {
                      throw new Error(
                        responseBody.trim().slice(0, 240) || 'Kunde inte importera XML-filen.'
                      );
                    }

                    const makeImportId = (prefix: string, index: number) =>
                      `${prefix}-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 7)}`;
                    const normalizedName = (value: string) => value.trim().toLocaleLowerCase();
                    const nextCourses = [...courses];
                    const importedCourses: Course[] = [];
                    for (const [index, parsed] of batch.courses.entries()) {
                      const previous = nextCourses.find(
                        (course) => normalizedName(course.name) === normalizedName(parsed.name)
                      );
                      const course: Course = {
                        id: previous?.id || makeImportId('crs', index),
                        name: parsed.name.trim(),
                        lengthMeters: parsed.lengthMeters,
                        climbMeters: parsed.climbMeters,
                        controls: parsed.controls,
                      };
                      if (previous) {
                        nextCourses[nextCourses.indexOf(previous)] = course;
                      } else {
                        nextCourses.push(course);
                      }
                      importedCourses.push(course);
                    }

                    const nextClasses = [...classes];
                    const importedClasses: CompClass[] = [];
                    for (const [index, parsed] of batch.classes.entries()) {
                      const previous = nextClasses.find(
                        (cls) => normalizedName(cls.name) === normalizedName(parsed.name)
                      );
                      const forkCourseIds = (parsed.forkCourseNames || [])
                        .map(
                          (name) =>
                            nextCourses.find(
                              (course) =>
                                normalizedName(course.name) === normalizedName(name)
                            )?.id
                        )
                        .filter((id): id is string => Boolean(id))
                        .slice(0, 32);
                      const linkedCourse = parsed.courseName
                        ? nextCourses.find(
                            (course) =>
                              normalizedName(course.name) ===
                              normalizedName(parsed.courseName || '')
                          )
                        : undefined;
                      const isForked =
                        parsed.classFormat === 'FORKED' && forkCourseIds.length > 0;
                      const cls: CompClass = {
                        id: previous?.id || makeImportId('cls', index),
                        name: parsed.name.trim(),
                        courseId: isForked
                          ? forkCourseIds[0]
                          : linkedCourse?.id || previous?.courseId || nextCourses[0]?.id || null,
                        classFormat: isForked ? 'FORKED' : 'STANDARD',
                        forkCourseIds: isForked ? forkCourseIds : [],
                        allowDirectEntry: previous?.allowDirectEntry ?? true,
                        freeStart: parsed.freeStart ?? previous?.freeStart ?? false,
                        autoMatchCourse: isForked
                          ? true
                          : Boolean(
                              parsed.autoMatchCourse ??
                                previous?.autoMatchCourse ??
                                parsed.freeStart
                            ),
                        feeSek: previous?.feeSek ?? clubSettings.defaultDirectEntryFeeSek,
                      };
                      if (previous) {
                        nextClasses[nextClasses.indexOf(previous)] = cls;
                      } else {
                        nextClasses.push(cls);
                      }
                      importedClasses.push(cls);
                    }

                    let nextBib =
                      competitors.reduce((max, competitor) => Math.max(max, competitor.bib), 500) +
                      1;
                    const nextCompetitors = [...competitors];
                    const importedCompetitors: Competitor[] = [];
                    for (const entry of batch.entries) {
                      let targetClass = nextClasses.find(
                        (cls) => normalizedName(cls.name) === normalizedName(entry.className)
                      );
                      if (!targetClass) {
                        targetClass = {
                          id: makeImportId('cls', nextClasses.length),
                          name: entry.className.trim(),
                          courseId: nextCourses[0]?.id || null,
                          classFormat: 'STANDARD',
                          forkCourseIds: [],
                          allowDirectEntry: true,
                          freeStart: false,
                          autoMatchCourse: false,
                          feeSek: clubSettings.defaultDirectEntryFeeSek,
                        };
                        nextClasses.push(targetClass);
                        importedClasses.push(targetClass);
                      }
                      const siNumber =
                        entry.siNumber > 0 ? entry.siNumber : 8900000 + nextBib;
                      if (nextCompetitors.some((competitor) => competitor.siNumber === siNumber)) {
                        continue;
                      }
                      const bib = nextBib++;
                      const competitor: Competitor = {
                        id: makeImportId('cmp', importedCompetitors.length),
                        bib,
                        fullName: entry.fullName.trim(),
                        club: entry.club.trim(),
                        classId: targetClass.id,
                        siNumber,
                        cardSeries: inferCardSeries(siNumber),
                        isRentalCard: entry.siNumber <= 0,
                        rentalReturned: false,
                        feePaid: false,
                        status: 'REGISTERED',
                        allocatedStartSec: Math.min(86400, competition.zeroTimeSec + bib * 30),
                        checkTimeSec: null,
                        startTimeSec: null,
                        finishTimeSec: null,
                        runningTimeSec: null,
                        lastSeenControl: null,
                        lastSeenTimeSec: null,
                        readoutAt: null,
                        radioSplits: [],
                        cardPunches: [],
                        validation: null,
                      };
                      nextCompetitors.push(competitor);
                      importedCompetitors.push(competitor);
                    }

                    const runnerDbImports = new Map<number, RunnerDbEntry>();
                    for (const entry of batch.entries) {
                      if (entry.siNumber > 0) {
                        runnerDbImports.set(entry.siNumber, {
                          id: String(entry.siNumber),
                          siNumber: entry.siNumber,
                          cardSeries: inferCardSeries(entry.siNumber),
                          fullName: entry.fullName.trim(),
                          club: entry.club.trim(),
                          birthYear: null,
                          defaultClassName: entry.className || null,
                          eventorPersonId: null,
                          eventorOrgId: clubSettings.eventorOrgId || null,
                          source: 'EVENTOR_XML',
                          updatedAt: new Date().toISOString(),
                        });
                      }
                    }
                    for (const entry of batch.runnerDbEntries) {
                      if (entry.siNumber > 0) {
                        runnerDbImports.set(entry.siNumber, {
                          id: String(entry.siNumber),
                          siNumber: entry.siNumber,
                          cardSeries: inferCardSeries(entry.siNumber),
                          fullName: entry.fullName.trim(),
                          club: entry.club.trim(),
                          birthYear: entry.birthYear ?? null,
                          defaultClassName: entry.defaultClassName ?? null,
                          eventorPersonId: entry.eventorPersonId ?? null,
                          eventorOrgId: clubSettings.eventorOrgId || null,
                          source: 'EVENTOR_XML',
                          updatedAt: new Date().toISOString(),
                        });
                      }
                    }
                    const importedRunnerDbEntries = Array.from(runnerDbImports.values());
                    const nextRunnerDb = [...runnerDb];
                    for (const entry of importedRunnerDbEntries) {
                      const previousIndex = nextRunnerDb.findIndex(
                        (candidate) => candidate.siNumber === entry.siNumber
                      );
                      if (previousIndex >= 0) {
                        nextRunnerDb[previousIndex] = {
                          ...nextRunnerDb[previousIndex],
                          ...entry,
                          birthYear:
                            entry.birthYear ?? nextRunnerDb[previousIndex].birthYear,
                          defaultClassName:
                            entry.defaultClassName ??
                            nextRunnerDb[previousIndex].defaultClassName,
                          eventorPersonId:
                            entry.eventorPersonId ??
                            nextRunnerDb[previousIndex].eventorPersonId,
                        };
                      } else {
                        nextRunnerDb.push(entry);
                      }
                    }

                    await saveCompetitionImportToFirestore({
                      competitionId: activeEventId,
                      courses: importedCourses,
                      classes: importedClasses,
                      competitors: importedCompetitors,
                      runnerDbEntries: importedRunnerDbEntries,
                      competitorCount: nextCompetitors.length,
                    });
                    setCourses(nextCourses);
                    setClasses(nextClasses);
                    setCompetitors(nextCompetitors);
                    setRunnerDb(nextRunnerDb);
                    setCompetitionsList((current) =>
                      current.map((item) =>
                        item.id === activeEventId
                          ? { ...item, competitorCount: nextCompetitors.length }
                          : item
                      )
                    );
                    return {
                      addedCourses: importedCourses.filter(
                        (course) => !courses.some((existing) => existing.id === course.id)
                      ).length,
                      addedClasses: importedClasses.filter(
                        (cls) => !classes.some((existing) => existing.id === cls.id)
                      ).length,
                      addedEntries: importedCompetitors.length,
                      syncedRunnerDb: importedRunnerDbEntries.length,
                    };
                  }}
                />
              )}

              {activeTab === 'readout' && (
                <ReadoutDashboard
                  courses={courses}
                  classes={classes}
                  stations={stations}
                  competitors={competitors}
                  runnerDbCount={runnerDb.length}
                  events={events}
                  offlineSnap={offlineSnap}
                  serialStatus={serialStatus}
                  onConnectUsb={async () => {
                    await sportidentSerial.connect();
                  }}
                  onConnectWebUsb={async () => {
                    await sportidentSerial.connectWebUsb();
                  }}
                  onDisconnectUsb={async () => {
                    await sportidentSerial.disconnect();
                  }}
                  onSetUsbMode={(mode) => sportidentSerial.setUsbMode(mode)}
                  onTriggerStationBeep={async () => {
                    await sportidentSerial.triggerStationBeep(1);
                  }}
                  onClearUsbError={() => sportidentSerial.clearError()}
                  onOpenHardwareSettings={
                    ROLE_ALLOWED_TABS[effectiveRoleMode].includes('hardware')
                      ? () => setActiveTab('hardware')
                      : undefined
                  }
                  onSetSimulatedOffline={(offline) =>
                    offlineReadoutQueue.setSimulatedOffline(offline)
                  }
                  onFlushOfflineQueue={async () => {
                    await offlineReadoutQueue.flushQueue();
                  }}
                  selectedRunnerId={selectedRunnerId}
                  onSelectRunner={(id) => setSelectedRunnerId(id)}
                  onMarkRentalReturned={async (id) => {
                    const patch = { rentalReturned: true };
                    const useFirestore = await apiRequestUnavailable(
                      `/api/competitors/${id}`,
                      {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(patch),
                      },
                      'Kunde inte uppdatera hyrbrickan.'
                    );
                    if (!useFirestore) return;
                    await updateCompetitorInFirestore(activeEventId, id, patch);
                    setCompetitors((current) =>
                      current.map((competitor) =>
                        competitor.id === id ? { ...competitor, ...patch } : competitor
                      )
                    );
                  }}
                  onSimulateFullReadout={handleSimulateFullReadout}
                  onSimulateOnlinePunch={handleSimulateOnlinePunch}
                  onLinkUnknownCardToEntry={(siNumber) => {
                    const dbSuggested =
                      runnerDb.find((r) => r.siNumber === siNumber) ?? null;
                    setPendingUnknownReadout((prev) =>
                      prev && prev.siNumber === siNumber
                        ? prev
                        : { siNumber, suggestedRunner: dbSuggested }
                    );
                    setActiveTab('entries');
                  }}
                  onInspectHex={(hex) => {
                    setInspectHexTarget(hex);
                    if (ROLE_ALLOWED_TABS[effectiveRoleMode].includes('protocol')) {
                      setActiveTab('protocol');
                    }
                  }}
                  onNavigateForest={() => setActiveTab('forest')}
                />
              )}

              {activeTab === 'start_corral' && (
                <StartCorralView
                  competition={competition}
                  classes={classes}
                  competitors={competitors}
                  runnerDb={runnerDb}
                  serialStatus={serialStatus}
                  capturedCard={capturedCard}
                  soundEnabled={soundEnabled}
                  onConnectUsb={async () => {
                    await sportidentSerial.connect();
                  }}
                  onConnectWebUsb={async () => {
                    await sportidentSerial.connectWebUsb();
                  }}
                  onDisconnectUsb={async () => {
                    await sportidentSerial.disconnect();
                  }}
                  onSetUsbMode={(mode) => sportidentSerial.setUsbMode(mode)}
                  onTriggerStationBeep={async () => {
                    await sportidentSerial.triggerStationBeep(1);
                  }}
                  onClearUsbError={() => sportidentSerial.clearError()}
                  onOpenHardwareSettings={
                    ROLE_ALLOWED_TABS[effectiveRoleMode].includes('hardware')
                      ? () => setActiveTab('hardware')
                      : undefined
                  }
                  onOpenEntriesWithSi={(siNumber, cardSeries) => {
                    setActiveTab('entries');
                    setCapturedCard({
                      siNumber,
                      cardSeries,
                      capturedAt: Date.now(),
                      mode: 'REGISTRATION',
                    });
                  }}
                  onCreateCompetitor={async (payload) => {
                    try {
                      const useFirestore = await apiRequestUnavailable(
                        '/api/competitors',
                        {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify(payload),
                        },
                        'Kunde inte spara deltagare.'
                      );
                      if (!useFirestore) return null;
                      const saved = await saveDirectEntryToFirestore(payload);
                      setCompetitors((current) => [saved.competitor, ...current]);
                      const savedIsFinished =
                        saved.competitor.status === 'OK' || saved.competitor.status === 'MP';
                      setCompetitionsList((current) =>
                        current.map((item) =>
                          item.id === activeEventId
                            ? {
                                ...item,
                                competitorCount: item.competitorCount + 1,
                                finishedCount: Math.min(
                                  item.competitorCount + 1,
                                  item.finishedCount + (savedIsFinished ? 1 : 0)
                                ),
                              }
                            : item
                        )
                      );
                      const savedRunner = saved.runnerDbEntry;
                      if (savedRunner) {
                        setRunnerDb((current) => {
                          const existingIndex = current.findIndex(
                            (runner) => runner.siNumber === savedRunner.siNumber
                          );
                          if (existingIndex < 0) return [savedRunner, ...current];
                          return current.map((runner, index) =>
                            index === existingIndex ? savedRunner : runner
                          );
                        });
                      }
                      return null;
                    } catch (error) {
                      console.error('Kunde inte spara deltagare i Firestore:', error);
                      return error instanceof Error ? error.message : 'Kunde inte spara deltagare.';
                    }
                  }}
                  onUpdateCompetitor={async (id, patch) => {
                    const useFirestore = await apiRequestUnavailable(
                      `/api/competitors/${id}`,
                      {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(patch),
                      },
                      'Kunde inte uppdatera deltagaren.'
                    );
                    if (!useFirestore) return;
                    await updateCompetitorInFirestore(activeEventId, id, patch);
                    setCompetitors((current) =>
                      current.map((competitor) =>
                        competitor.id === id ? { ...competitor, ...patch } : competitor
                      )
                    );
                  }}
                />
              )}

              {activeTab === 'forest' && (
                <ForestSafetyView
                  competitors={competitors}
                  classes={classes}
                  zeroTimeSec={competition.zeroTimeSec}
                  onUpdateRunnerStatus={async (id, status: RunnerStatus) => {
                    const patch = { status };
                    const useFirestore = await apiRequestUnavailable(
                      `/api/competitors/${id}`,
                      {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(patch),
                      },
                      'Kunde inte uppdatera löparstatus.'
                    );
                    if (!useFirestore) return;
                    await updateCompetitorInFirestore(activeEventId, id, patch);
                    setCompetitors((current) =>
                      current.map((competitor) =>
                        competitor.id === id ? { ...competitor, ...patch } : competitor
                      )
                    );
                  }}
                />
              )}

              {activeTab === 'results' && (
                <SpeakerResultsView
                  competition={competition}
                  courses={courses}
                  classes={classes}
                  competitors={competitors}
                  stations={stations}
                  onOpenPublicPortal={() => navigatePublicPortal(activePublicShortCode)}
                />
              )}

              {activeTab === 'entries' && (
                <EntriesRegistrationView
                  classes={classes}
                  competitors={competitors}
                  runnerDb={runnerDb}
                  clubSettings={clubSettings}
                  enableFeesAndSwish={Boolean(competition.enableFeesAndSwish)}
                  serialStatus={serialStatus}
                  onConnectUsb={async () => {
                    await sportidentSerial.connect();
                  }}
                  onConnectWebUsb={async () => {
                    await sportidentSerial.connectWebUsb();
                  }}
                  onDisconnectUsb={async () => {
                    await sportidentSerial.disconnect();
                  }}
                  onSetUsbMode={(mode) => sportidentSerial.setUsbMode(mode)}
                  onTriggerStationBeep={async () => {
                    await sportidentSerial.triggerStationBeep(1);
                  }}
                  onClearUsbError={() => sportidentSerial.clearError()}
                  onOpenHardwareSettings={
                    ROLE_ALLOWED_TABS[effectiveRoleMode].includes('hardware')
                      ? () => setActiveTab('hardware')
                      : undefined
                  }
                  capturedCard={capturedCard}
                  pendingUnknownReadout={pendingUnknownReadout}
                  onClearPendingUnknown={() => setPendingUnknownReadout(null)}
                  onSimulateCardScanForEntry={() => {
                    const enteredSet = new Set(competitors.map((c) => c.siNumber));
                    const unenteredInDb = runnerDb.filter((r) => !enteredSet.has(r.siNumber));
                    if (unenteredInDb.length > 0) {
                      const picked =
                        unenteredInDb[simDbCursorRef.current % unenteredInDb.length];
                      simDbCursorRef.current += 1;
                      setCapturedCard({
                        siNumber: picked.siNumber,
                        cardSeries: picked.cardSeries,
                        capturedAt: Date.now(),
                        mode: 'REGISTRATION',
                      });
                    } else {
                      const randomSi = 8520000 + Math.floor(Math.random() * 79000);
                      setCapturedCard({
                        siNumber: randomSi,
                        cardSeries: inferCardSeries(randomSi),
                        capturedAt: Date.now(),
                        mode: 'REGISTRATION',
                      });
                    }
                    if (soundEnabledRef.current) playMeosFeedbackTone('registration');
                  }}
                  onCreateCompetitor={async (payload) => {
                    try {
                      const res = await apiFetch('/api/competitors', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(payload),
                      });
                      if (res.ok) return null;
                      if (res.status !== 404 && res.status !== 405) {
                        const err = (await res.json().catch(() => ({}))) as { error?: string };
                        return err.error ?? 'Kunde inte spara anmälan.';
                      }
                    } catch {
                      // Use Firestore when the optional Secretariat API is unavailable.
                    }

                    try {
                      const saved = await saveDirectEntryToFirestore(payload);
                      setCompetitors((current) => [saved.competitor, ...current]);
                      const savedIsFinished =
                        saved.competitor.status === 'OK' || saved.competitor.status === 'MP';
                      setCompetitionsList((current) =>
                        current.map((item) =>
                          item.id === activeEventId
                            ? {
                                ...item,
                                competitorCount: item.competitorCount + 1,
                                finishedCount: Math.min(
                                  item.competitorCount + 1,
                                  item.finishedCount + (savedIsFinished ? 1 : 0)
                                ),
                              }
                            : item
                        )
                      );
                      const savedRunner = saved.runnerDbEntry;
                      if (savedRunner) {
                        setRunnerDb((current) => {
                          const existingIndex = current.findIndex(
                            (runner) => runner.siNumber === savedRunner.siNumber
                          );
                          if (existingIndex < 0) return [savedRunner, ...current];
                          return current.map((runner, index) =>
                            index === existingIndex ? savedRunner : runner
                          );
                        });
                      }
                      const now = new Date();
                      const className =
                        classes.find((candidate) => candidate.id === saved.competitor.classId)
                          ?.name ?? null;
                      setEvents((current) => [
                        {
                          id: `ev_${Date.now()}`,
                          timestamp: now.toISOString(),
                          clock24h: new Intl.DateTimeFormat('sv-SE', {
                            timeZone: 'Europe/Stockholm',
                            hour: '2-digit',
                            minute: '2-digit',
                            second: '2-digit',
                          }).format(now),
                          eventType: 'DIRECT_ENTRY',
                          siNumber: saved.competitor.siNumber,
                          competitorId: saved.competitor.id,
                          competitorName: saved.competitor.fullName,
                          club: saved.competitor.club,
                          className,
                          stationCode: 1,
                          stationName: 'Sekretariat — Direktanmälan',
                          runningTimeSec: saved.competitor.runningTimeSec,
                          message: `Direktanmäld i ${className ?? '-'}${
                            saved.competitor.isRentalCard ? ' (Hyrbricka utlämnad)' : ''
                          }`,
                        },
                        ...current,
                      ]);
                      return null;
                    } catch (error) {
                      console.error('Kunde inte spara direktanmälan till Firestore:', error);
                      return error instanceof Error
                        ? error.message
                        : 'Kunde inte spara anmälan i Firestore.';
                    }
                  }}
                  onUpdateCompetitor={async (id, patch) => {
                    const useFirestore = await apiRequestUnavailable(
                      `/api/competitors/${id}`,
                      {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(patch),
                      },
                      'Kunde inte uppdatera deltagaren.'
                    );
                    if (!useFirestore) return;
                    await updateCompetitorInFirestore(activeEventId, id, patch);
                    setCompetitors((current) =>
                      current.map((competitor) =>
                        competitor.id === id ? { ...competitor, ...patch } : competitor
                      )
                    );
                  }}
                  onDeleteCompetitor={async (id) => {
                    const useFirestore = await apiRequestUnavailable(
                      `/api/competitors/${id}`,
                      { method: 'DELETE' },
                      'Kunde inte ta bort deltagaren.'
                    );
                    if (!useFirestore) return;
                    await deleteCompetitorFromFirestore(activeEventId, id);
                    setCompetitors((current) =>
                      current.filter((competitor) => competitor.id !== id)
                    );
                  }}
                  initialSiNumber={runnerForDirectEntry}
                  onInitialSiNumberConsumed={() => setRunnerForDirectEntry(null)}
                />
              )}

              {activeTab === 'runner_db' && isAdminSession && (
                <RunnerDatabaseView
                  runnerDb={runnerDb}
                  enteredSiNumbers={competitors.map((competitor) => competitor.siNumber)}
                  canSelectForEntry={!isEmptySeason}
                  onSelectForEntry={(siNumber) => {
                    setRunnerForDirectEntry(siNumber);
                    setActiveTab('entries');
                  }}
                  onImportRunnerDb={async (runners, source) => {
                    let response: Response | null = null;
                    let importedRunners: RunnerDbEntry[] | null = null;
                    try {
                      response = await apiFetch('/api/runner-db/import', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ runners, source }),
                      });
                    } catch (error) {
                      if (!(error instanceof TypeError)) throw error;
                    }
                    let importedCount = runners.length;
                    if (response?.ok) {
                      const result = (await response.json()) as {
                        importedCount: number;
                        totalRunnerDb: number;
                        importedRunners?: RunnerDbEntry[];
                      };
                      importedCount = result.importedCount;
                      importedRunners = result.importedRunners ?? null;
                    } else if (response && response.status !== 404 && response.status !== 405) {
                      const errorBody = (await response.json().catch(() => ({}))) as {
                        error?: string;
                      };
                      throw new Error(errorBody.error ?? 'Kunde inte importera löpardatabasen.');
                    } else {
                      const imported: RunnerDbEntry[] = runners.map((runner) => ({
                        id: String(runner.siNumber),
                        siNumber: runner.siNumber,
                        cardSeries: inferCardSeries(runner.siNumber),
                        fullName: runner.fullName,
                        club: runner.club,
                        birthYear: runner.birthYear ?? null,
                        defaultClassName: runner.defaultClassName ?? null,
                        eventorPersonId: null,
                        eventorOrgId: null,
                        source,
                        updatedAt: new Date().toISOString(),
                      }));
                      await saveRunnerDbEntriesToFirestore(imported);
                    }
                    const bySiNumber = new Map(
                      runnerDb.map((runner) => [runner.siNumber, runner])
                    );
                    if (importedRunners) {
                      for (const runner of importedRunners) {
                        bySiNumber.set(runner.siNumber, runner);
                      }
                    } else {
                      for (const runner of runners) {
                        const existing = bySiNumber.get(runner.siNumber);
                        bySiNumber.set(runner.siNumber, {
                          id: existing?.id ?? String(runner.siNumber),
                          siNumber: runner.siNumber,
                          cardSeries: inferCardSeries(runner.siNumber),
                          fullName: runner.fullName,
                          club: runner.club,
                          birthYear: runner.birthYear ?? existing?.birthYear ?? null,
                          defaultClassName:
                            runner.defaultClassName ?? existing?.defaultClassName ?? null,
                          eventorPersonId: existing?.eventorPersonId ?? null,
                          eventorOrgId: existing?.eventorOrgId ?? null,
                          source,
                          updatedAt: new Date().toISOString(),
                        });
                      }
                    }
                    const nextRunnerDb = Array.from(bySiNumber.values());
                    setRunnerDb(nextRunnerDb);
                    return { importedCount, totalRunnerDb: nextRunnerDb.length };
                  }}
                  onUpdateRunnerDbEntry={async (id, patch) => {
                    const existing = runnerDb.find((runner) => runner.id === id);
                    if (!existing) throw new Error('Löparen hittades inte i databasen.');
                    const updated: RunnerDbEntry = {
                      ...existing,
                      ...patch,
                      id:
                        patch.siNumber === existing.siNumber
                          ? existing.id
                          : String(patch.siNumber),
                      cardSeries: inferCardSeries(patch.siNumber),
                      updatedAt: new Date().toISOString(),
                    };
                    let response: Response | null = null;
                    try {
                      response = await apiFetch(`/api/runner-db/${encodeURIComponent(id)}`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(patch),
                      });
                    } catch (error) {
                      if (!(error instanceof TypeError)) throw error;
                    }
                    if (response?.ok) {
                      const saved = (await response.json()) as RunnerDbEntry;
                      Object.assign(updated, saved);
                    } else if (response && response.status !== 404 && response.status !== 405) {
                      const errorBody = (await response.json().catch(() => ({}))) as {
                        error?: string;
                      };
                      throw new Error(errorBody.error ?? 'Kunde inte spara löparuppgifterna.');
                    } else {
                      await updateRunnerDbEntryInFirestore(existing.siNumber, updated);
                    }
                    setRunnerDb((current) =>
                      current.map((runner) => (runner.id === id ? updated : runner))
                    );
                  }}
                  onDeleteRunnerDbEntry={async (id) => {
                    const useFirestore = await apiRequestUnavailable(
                      `/api/runner-db/${encodeURIComponent(id)}`,
                      { method: 'DELETE' },
                      'Kunde inte ta bort löparen.'
                    );
                    if (useFirestore) {
                      const runner = runnerDb.find((candidate) => candidate.id === id);
                      if (!runner) throw new Error('Löparen hittades inte i databasen.');
                      await deleteRunnerDbEntryFromFirestore(runner.siNumber);
                    }
                    setRunnerDb((current) => current.filter((runner) => runner.id !== id));
                  }}
                />
              )}

              {activeTab === 'draw' && (
                <DrawView
                  competition={competition}
                  courses={courses}
                  classes={classes}
                  competitors={competitors}
                  onDrawClass={async (params) => {
                    const res = await apiFetch('/api/draw/class', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify(params),
                    });
                    return (await res.json()) as {
                      className: string;
                      drawnCount: number;
                      mode: string;
                      vacantStartTimes: string[];
                    };
                  }}
                />
              )}

              {activeTab === 'courses' && (
                <CoursesClassesView
                  courses={courses}
                  classes={classes}
                  competitors={competitors}
                  enableFeesAndSwish={Boolean(competition.enableFeesAndSwish)}
                  onSaveCourse={async (payload, existingId) => {
                    const useFirestore = await apiRequestUnavailable(
                      existingId ? `/api/courses/${existingId}` : '/api/courses',
                      {
                        method: existingId ? 'PUT' : 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(payload),
                      },
                      'Kunde inte spara banan.'
                    );
                    if (!useFirestore) return;
                    const saved = await saveCourseToFirestore(
                      activeEventId,
                      payload,
                      existingId
                    );
                    setCourses((current) =>
                      existingId
                        ? current.map((course) => (course.id === existingId ? saved : course))
                        : [...current, saved]
                    );
                    const recalculated = await recalculateCompetitionFromFirestore(activeEventId);
                    setCompetitors(recalculated.competitors);
                    setEmergency(recalculated.emergency);
                  }}
                  onDeleteCourse={async (id) => {
                    const useFirestore = await apiRequestUnavailable(
                      `/api/courses/${id}`,
                      { method: 'DELETE' },
                      'Kunde inte ta bort banan.'
                    );
                    if (!useFirestore) return;
                    await deleteCourseFromFirestore(activeEventId, id);
                    setCourses((current) => current.filter((course) => course.id !== id));
                    const recalculated = await recalculateCompetitionFromFirestore(activeEventId);
                    setCompetitors(recalculated.competitors);
                    setEmergency(recalculated.emergency);
                  }}
                  onSaveClass={async (payload, existingId) => {
                    const useFirestore = await apiRequestUnavailable(
                      existingId ? `/api/classes/${existingId}` : '/api/classes',
                      {
                        method: existingId ? 'PUT' : 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(payload),
                      },
                      'Kunde inte spara klassen.'
                    );
                    if (!useFirestore) return;
                    const saved = await saveClassToFirestore(
                      activeEventId,
                      payload,
                      existingId
                    );
                    setClasses((current) =>
                      existingId
                        ? current.map((cls) => (cls.id === existingId ? saved : cls))
                        : [...current, saved]
                    );
                    const recalculated = await recalculateCompetitionFromFirestore(activeEventId);
                    setCompetitors(recalculated.competitors);
                    setEmergency(recalculated.emergency);
                  }}
                  onImportCourseBatch={async (payload) => {
                    let res: Response | null = null;
                    try {
                      res = await apiFetch('/api/import/batch', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                          courses: payload.courses,
                          classes: payload.classes,
                          entries: [],
                          runnerDbEntries: [],
                          replaceExisting: payload.replaceExisting,
                          defaultFreeStart: payload.defaultFreeStart,
                        }),
                      });
                    } catch (error) {
                      if (!(error instanceof TypeError)) throw error;
                    }
                    if (res?.ok) {
                      return (await res.json()) as {
                        addedCourses: number;
                        addedClasses: number;
                        replaced?: boolean;
                      };
                    }
                    if (res && res.status !== 404 && res.status !== 405) {
                      const errorBody = (await res.json().catch(() => ({}))) as {
                        error?: string;
                      };
                      throw new Error(errorBody.error ?? 'Kunde inte importera banfil.');
                    }
                    const makeImportId = (prefix: string, index: number) =>
                      `${prefix}-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 7)}`;
                    const normalizeName = (name: string) => name.trim().toLocaleLowerCase();
                    const importedCourses: Course[] = payload.courses.map((course, index) => {
                      const previous = courses.find(
                        (existing) =>
                          normalizeName(existing.name) === normalizeName(course.name)
                      );
                      return {
                        id: previous?.id || makeImportId('crs', index),
                        name: course.name,
                        lengthMeters: course.lengthMeters,
                        climbMeters: course.climbMeters,
                        controls: course.controls,
                      };
                    });
                    const nextCourses = payload.replaceExisting
                      ? importedCourses
                      : Array.from(
                          new Map(
                            [...courses, ...importedCourses].map((course) => [
                              course.id,
                              course,
                            ])
                          ).values()
                        );
                    const importedClasses: CompClass[] = payload.classes.map((cls, index) => {
                      const previous = classes.find(
                        (existing) => normalizeName(existing.name) === normalizeName(cls.name)
                      );
                      const forkCourseIds = (cls.forkCourseNames || [])
                        .map(
                          (name) =>
                            nextCourses.find(
                              (course) =>
                                normalizeName(course.name) === normalizeName(name)
                            )?.id
                        )
                        .filter((id): id is string => Boolean(id))
                        .slice(0, 32);
                      const linkedCourse = cls.courseName
                        ? nextCourses.find(
                            (course) =>
                              normalizeName(course.name) === normalizeName(cls.courseName!)
                          )
                        : undefined;
                      const isForked = cls.classFormat === 'FORKED' && forkCourseIds.length > 0;
                      const freeStart = payload.defaultFreeStart ?? cls.freeStart ?? true;
                      return {
                        id: previous?.id || makeImportId('cls', index),
                        name: cls.name,
                        courseId: isForked
                          ? forkCourseIds[0]
                          : linkedCourse?.id || previous?.courseId || nextCourses[0]?.id || null,
                        classFormat: isForked ? 'FORKED' : 'STANDARD',
                        forkCourseIds: isForked ? forkCourseIds : [],
                        rogainingMaxTimeSec: null,
                        rogainingPenaltyPerMin: null,
                        allowDirectEntry: previous?.allowDirectEntry ?? true,
                        freeStart,
                        autoMatchCourse: isForked
                          ? true
                          : cls.autoMatchCourse ?? previous?.autoMatchCourse ?? freeStart,
                        feeSek: previous?.feeSek ?? 100,
                      };
                    });
                    const nextClasses = payload.replaceExisting
                      ? importedClasses
                      : Array.from(
                          new Map(
                            [...classes, ...importedClasses].map((cls) => [cls.id, cls])
                          ).values()
                        );
                    await saveCompetitionImportToFirestore({
                      competitionId: activeEventId,
                      courses: nextCourses,
                      classes: nextClasses,
                      competitors,
                      runnerDbEntries: [],
                      competitorCount: competitors.length,
                      replaceCoursesAndClasses: payload.replaceExisting,
                    });
                    setCourses(nextCourses);
                    setClasses(nextClasses);
                    const recalculated = await recalculateCompetitionFromFirestore(activeEventId);
                    setCompetitors(recalculated.competitors);
                    setEmergency(recalculated.emergency);
                    return {
                      addedCourses: payload.courses.length,
                      addedClasses: importedClasses.length,
                      replaced: payload.replaceExisting,
                    };
                  }}
                />
              )}

              {activeTab === 'hardware' && (
                <HardwareStationsView
                  isAdmin={isAdminSession}
                  competition={competition}
                  courses={courses}
                  classes={classes}
                  competitors={competitors}
                  emergency={emergency}
                  roc={roc}
                  stations={stations}
                  serialStatus={serialStatus}
                  onUpdateEmergency={async (patch) => {
                    let res: Response | null = null;
                    try {
                      res = await apiFetch('/api/emergency', {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(patch),
                      });
                    } catch (error) {
                      if (!(error instanceof TypeError)) throw error;
                    }
                    if (res?.ok) {
                      const result = (await res.json()) as { recalculatedCount: number };
                      return result;
                    }
                    if (res && res.status !== 404 && res.status !== 405) {
                      const errorBody = (await res.json().catch(() => ({}))) as {
                        error?: string;
                      };
                      throw new Error(errorBody.error ?? 'Kunde inte spara nödlägesinställningarna.');
                    }
                    const result = await recalculateCompetitionFromFirestore(activeEventId, patch);
                    setEmergency(result.emergency);
                    setCompetitors(result.competitors);
                    return { recalculatedCount: result.recalculatedCount };
                  }}
                  onRecalculateAll={async () => {
                    let res: Response | null = null;
                    try {
                      res = await apiFetch('/api/emergency/recalculate-all', {
                        method: 'POST',
                      });
                    } catch (error) {
                      if (!(error instanceof TypeError)) throw error;
                    }
                    if (res?.ok) {
                      return (await res.json()) as { recalculatedCount: number };
                    }
                    if (res && res.status !== 404 && res.status !== 405) {
                      const errorBody = (await res.json().catch(() => ({}))) as {
                        error?: string;
                      };
                      throw new Error(errorBody.error ?? 'Kunde inte räkna om tävlingens tider.');
                    }
                    const result = await recalculateCompetitionFromFirestore(activeEventId);
                    setEmergency(result.emergency);
                    setCompetitors(result.competitors);
                    return { recalculatedCount: result.recalculatedCount };
                  }}
                  onAssignManualFinish={async (params) => {
                    let res: Response | null = null;
                    try {
                      res = await apiFetch('/api/emergency/manual-finish', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(params),
                      });
                    } catch (error) {
                      if (!(error instanceof TypeError)) throw error;
                    }
                    if (res?.ok) return null;
                    if (res && res.status !== 404 && res.status !== 405) {
                      const errorBody = (await res.json().catch(() => ({}))) as {
                        error?: string;
                      };
                      return errorBody.error ?? 'Kunde inte spara manuell måltid.';
                    }
                    const runner = competitors.find(
                      (candidate) => candidate.id === params.competitorId
                    );
                    if (!runner) return 'Deltagaren hittades inte.';
                    const parts = (params.finishClockStr || '').split(':').map(Number);
                    if (
                      parts.length < 2 ||
                      parts.length > 3 ||
                      parts.some((value) => !Number.isInteger(value)) ||
                      parts[0] < 0 ||
                      parts[0] > 23 ||
                      parts[1] < 0 ||
                      parts[1] > 59 ||
                      (parts[2] !== undefined && (parts[2] < 0 || parts[2] > 59))
                    ) {
                      return 'Ange giltigt klockslag i format HH:MM:SS.';
                    }
                    const finishTimeSec =
                      parts[0] * 3600 + parts[1] * 60 + (parts[2] ?? 0);
                    const startTimeSec =
                      runner.startTimeSec ??
                      runner.allocatedStartSec ??
                      competition.zeroTimeSec;
                    const hasReadout = Boolean(
                      runner.rawReadout || runner.cardPunches.length > 0
                    );
                    await updateCompetitorInFirestore(activeEventId, runner.id, {
                      manualFinishTimeSec: finishTimeSec,
                      finishTimeSec,
                      runningTimeSec:
                        finishTimeSec >= startTimeSec
                          ? finishTimeSec - startTimeSec
                          : null,
                      ...(hasReadout ? {} : { status: 'OK' as RunnerStatus }),
                    });
                    const result = await recalculateCompetitionFromFirestore(activeEventId);
                    setEmergency(result.emergency);
                    setCompetitors(result.competitors);
                    return null;
                  }}
                  onUpdateRocSettings={async (patch) => {
                    await apiFetch('/api/roc/settings', {
                      method: 'PUT',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify(patch),
                    });
                  }}
                  onPollRocNow={async () => {
                    const res = await apiFetch('/api/roc/poll-now', { method: 'POST' });
                    const data = (await res.json()) as {
                      ingested?: number;
                      error?: string | null;
                    };
                    return {
                      ingested: data.ingested ?? 0,
                      error: data.error ?? null,
                    };
                  }}
                  onSimulateRocBatch={async () => {
                    const res = await apiFetch('/api/roc/simulate-batch', { method: 'POST' });
                    const data = (await res.json()) as {
                      ingested?: number;
                      samplePayload?: string;
                    };
                    if (soundEnabledRef.current && (data.ingested ?? 0) > 0) {
                      playMeosFeedbackTone('radio');
                    }
                    return {
                      ingested: data.ingested ?? 0,
                      samplePayload: data.samplePayload ?? '',
                    };
                  }}
                  onConnectUsb={async (baud) => {
                    await sportidentSerial.connect(baud);
                  }}
                  onConnectWebUsb={async (baud) => {
                    await sportidentSerial.connectWebUsb(baud);
                  }}
                  onDisconnectUsb={() => sportidentSerial.disconnect()}
                  onSetUsbMode={(mode) => sportidentSerial.setUsbMode(mode)}
                  onSetBaudRate={(baud) => sportidentSerial.setBaudRate(baud)}
                  onSendDirectMode={async () => {
                    await sportidentSerial.requestDirectMode();
                  }}
                  onRequestSysConfig={async () => {
                    await sportidentSerial.requestSystemConfig();
                  }}
                  onTriggerStationBeep={async () => {
                    await sportidentSerial.triggerStationBeep(1);
                  }}
                  onCreateStation={async (payload) => {
                    try {
                      const useFirestore = await apiRequestUnavailable(
                        '/api/stations',
                        {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify(payload),
                        },
                        'Kunde inte spara station.'
                      );
                      if (!useFirestore) return null;
                      const saved = await saveStationToFirestore(activeEventId, payload);
                      setStations((current) => [...current, saved]);
                      return null;
                    } catch (error) {
                      return error instanceof Error ? error.message : 'Kunde inte spara station.';
                    }
                  }}
                  onSaveStation={async (payload) => {
                    if (!payload.id) return 'Stationens ID saknas.';
                    try {
                      const useFirestore = await apiRequestUnavailable(
                        `/api/stations/${encodeURIComponent(payload.id)}`,
                        {
                          method: 'PUT',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify(payload),
                        },
                        'Kunde inte uppdatera stationen.'
                      );
                      if (useFirestore) {
                        const saved = await saveStationToFirestore(activeEventId, payload);
                        setStations((current) =>
                          current
                            .map((station) => (station.id === saved.id ? saved : station))
                            .sort((a, b) => a.stationCode - b.stationCode)
                        );
                      } else {
                        setStations((current) =>
                          current
                            .map((station) =>
                              station.id === payload.id
                                ? { ...station, ...payload }
                                : station
                            )
                            .sort((a, b) => a.stationCode - b.stationCode)
                        );
                      }
                      return null;
                    } catch (error) {
                      return error instanceof Error
                        ? error.message
                        : 'Kunde inte uppdatera stationen.';
                    }
                  }}
                  onDeleteStation={async (id) => {
                    const useFirestore = await apiRequestUnavailable(
                      `/api/stations/${id}`,
                      { method: 'DELETE' },
                      'Kunde inte ta bort stationen.'
                    );
                    if (!useFirestore) return;
                    await deleteStationFromFirestore(activeEventId, id);
                    setStations((current) => current.filter((station) => station.id !== id));
                  }}
                  onOpenProtocolInspector={() => setActiveTab('protocol')}
                />
              )}

              {(activeTab === 'access' || activeTab === 'season') && isAdminSession && (
                <AccessControlView
                  key={activeTab === 'season' ? 'season' : 'access'}
                  view={activeTab === 'season' ? 'events' : 'admin'}
                  activeEventId={activeEventId}
                  competitionName={isEmptySeason ? 'Ingen aktiv tävling' : competition.name}
                  enableFeesAndSwish={!isEmptySeason && Boolean(competition.enableFeesAndSwish)}
                  competitionsList={competitionsList}
                  competitors={competitors}
                  classes={classes}
                  clubSettings={clubSettings}
                  seriesStandings={seriesStandings}
                  currentUser={authSession.user}
                  onApplyStateSnapshot={applySnapshot}
                  onActivateCompetition={handleActivateCompetition}
                  onUpdateCompetitionMeta={handleUpdateCompetitionMetadata}
                  onOpenCreateCompetition={() => {
                    setNewEvtFeesAndSwish(false);
                    setCreateEventModalOpen(true);
                  }}
                  onOpenPublicEvent={(code) => navigatePublicPortal(code)}
                  onApplySeriesScoringUpdate={(settings, standings) => {
                    setClubSettings(settings);
                    setSeriesStandings(standings);
                  }}
                  onUpdateClubSettings={(settings) => {
                    setClubSettings(settings);
                  }}
                />
              )}

              {activeTab === 'protocol' && (
                <ProtocolInspectorView
                  frameLogs={frameLogs}
                  initialHexToInspect={inspectHexTarget}
                  onInjectOnlineHexFrame={handleInjectOnlineHex}
                  onClearFrameLogs={() => setFrameLogs([])}
                />
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}
