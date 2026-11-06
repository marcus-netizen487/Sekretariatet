import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Check,
  Cloud,
  Copy,
  Download,
  ExternalLink,
  FolderPlus,
  ImagePlus,
  KeyRound,
  Palette,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Trash2,
  Trophy,
  Upload,
  UserPlus,
  WifiOff,
} from 'lucide-react';
import type {
  AuthManagePayload,
  AuthSessionUser,
  CloudCompetitionRecord,
  CloudSeasonSnapshot,
  ClubAdminAccount,
  ClubAdminTier,
  ClubSettings,
  CompClass,
  CompetitionSummary,
  Competitor,
  EventLifecycleStatus,
  MeosAppState,
  OfficialPinRole,
  RentalCardOverviewItem,
  RolePinMap,
  SeriesScoringConfig,
  SeriesStandingsBundle,
} from '../types/sportident';
import { formatSiNumber } from '../services/sportidentProtocol';
import {
  DEFAULT_SERIES_SCORING_CONFIG,
} from '../services/seriesStandings';
import { apiFetch } from '../services/authClient';
import {
  BOOTSTRAP_SUPER_ADMIN_EMAILS,
  DEFAULT_CLUB_SETTINGS,
  TOKEN_SERVICE_ACTIVATION_URL,
  auth,
  createCompetitionInFirestore,
  deleteCompetitionFromFirestore,
  ensureAdminRoleInFirestore,
  ensureValidFirestoreUser,
  getStockholmTodayIso,
  isTokenServiceApiDisabled,
  listMyAdminInvitesFromFirestore,
  listClubCloudCompetitionsFromFirestore,
  loadClubSettingsFromFirestore,
  loadFullSeasonFromFirestore,
  removeAdminInviteFromFirestore,
  saveClubSettingsToFirestore,
  seedDemoSeasonToFirestore,
  signInWithGooglePopup,
  subscribeFirebaseAuth,
  subscribeTokenServiceStatus,
  syncFullSeasonToFirestore,
  upsertAdminInviteInFirestore,
} from '../firebase';
import { RunnerStatusIndicator } from './StatusLabels';
import {
  CLUB_COLOR_PRESETS,
  applyClubThemeToDocument,
  processClubLogoFile,
} from '../utils/clubTheme';

interface AccessControlViewProps {
  view?: 'events' | 'admin';
  activeEventId: string;
  competitionName: string;
  enableFeesAndSwish?: boolean;
  competitionsList: CompetitionSummary[];
  competitors: Competitor[];
  classes: CompClass[];
  clubSettings: ClubSettings;
  seriesStandings: SeriesStandingsBundle[];
  currentUser: AuthSessionUser;
  onApplyStateSnapshot: (snap: MeosAppState) => void;
  onActivateCompetition: (eventId: string) => Promise<boolean>;
  onUpdateCompetitionMeta: (
    eventId: string,
    patch: {
      status?: EventLifecycleStatus;
      date?: string;
      zeroTimeStr?: string;
      seriesName?: string;
      enableFeesAndSwish?: boolean;
    }
  ) => Promise<void>;
  onOpenCreateCompetition: () => void;
  onOpenPublicEvent: (shortCode: string | null) => void;
  onApplySeriesScoringUpdate: (
    settings: ClubSettings,
    standings: SeriesStandingsBundle[]
  ) => void;
  onUpdateClubSettings?: (settings: ClubSettings) => void;
}

type AdminWorkspaceTab = 'events' | 'series' | 'admins' | 'club' | 'rentals_series';

const PIN_ROLE_META: {
  role: OfficialPinRole;
  title: string;
  allowedViews: string;
}[] = [
  {
    role: 'START',
    title: 'Startfålla & E-start',
    allowedViews: 'Startfålla · Direktanmälan · Kvar i skogen · USB-station',
  },
  {
    role: 'READOUT',
    title: 'Mål & Avläsning',
    allowedViews: 'Avläsning & Översikt · Direktanmälan · Kvar i skogen · Resultat · USB',
  },
  {
    role: 'FOREST',
    title: 'Skogssäkerhet & Sök',
    allowedViews: 'Kvar i skogen · Startfålla · Avläsning · Nödlägen',
  },
  {
    role: 'SPEAKER',
    title: 'Speaker & Resultat',
    allowedViews: 'Speaker & Resultat · Förvarning · Kvar i skogen · Startfålla',
  },
];

function generateUniqueRandomPins(): RolePinMap {
  const used = new Set<string>();
  const pick = (): string => {
    for (let i = 0; i < 50; i++) {
      const code = String(1000 + Math.floor(Math.random() * 9000));
      if (!used.has(code)) {
        used.add(code);
        return code;
      }
    }
    return String(1000 + used.size);
  };
  return {
    START: pick(),
    READOUT: pick(),
    FOREST: pick(),
    SPEAKER: pick(),
  };
}

export function AccessControlView({
  view = 'admin',
  activeEventId,
  competitionName,
  enableFeesAndSwish = false,
  competitionsList,
  competitors,
  classes,
  clubSettings,
  seriesStandings,
  currentUser,
  onApplyStateSnapshot,
  onActivateCompetition,
  onUpdateCompetitionMeta,
  onOpenCreateCompetition,
  onOpenPublicEvent,
  onApplySeriesScoringUpdate,
  onUpdateClubSettings,
}: AccessControlViewProps) {
  const [subTab, setSubTab] = useState<AdminWorkspaceTab>(
    view === 'events' ? 'events' : 'admins'
  );
  const [loading, setLoading] = useState<boolean>(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Competition management state
  const [eventBusyId, setEventBusyId] = useState<string | null>(null);
  const [confirmDeleteEventId, setConfirmDeleteEventId] = useState<string | null>(null);
  const [confirmClearAll, setConfirmClearAll] = useState<boolean>(false);
  const [confirmResetSeed, setConfirmResetSeed] = useState<boolean>(false);
  const [zeroDrafts, setZeroDrafts] = useState<Record<string, string>>({});
  const [eventsNotice, setEventsNotice] = useState<{ ok: boolean; msg: string } | null>(null);
  const [backupBusy, setBackupBusy] = useState<boolean>(false);

  // PINs state
  const [rolePins, setRolePins] = useState<RolePinMap>({
    START: '1100',
    READOUT: '2200',
    FOREST: '3300',
    SPEAKER: '4400',
  });
  const [pinsCustomized, setPinsCustomized] = useState<boolean>(false);
  const [pinsBusy, setPinsBusy] = useState<boolean>(false);
  const [pinsNotice, setPinsNotice] = useState<{ ok: boolean; msg: string } | null>(null);
  const [copiedRole, setCopiedRole] = useState<string | null>(null);

  // Google Administrators state
  const [admins, setAdmins] = useState<ClubAdminAccount[]>([]);
  const [newAdminEmail, setNewAdminEmail] = useState<string>('');
  const [newAdminName, setNewAdminName] = useState<string>('');
  const [newAdminRole, setNewAdminRole] = useState<ClubAdminTier>('RACE_ADMIN');
  const [adminBusy, setAdminBusy] = useState<boolean>(false);
  const [adminNotice, setAdminNotice] = useState<{ ok: boolean; msg: string } | null>(null);
  const [confirmRemoveEmail, setConfirmRemoveEmail] = useState<string | null>(null);

  // Offline backup code state
  const [offlineEnabled, setOfflineEnabled] = useState<boolean>(true);
  const [offlineCustomized, setOfflineCustomized] = useState<boolean>(false);
  const [newOfflineCode, setNewOfflineCode] = useState<string>('');
  const [offlineBusy, setOfflineBusy] = useState<boolean>(false);
  const [offlineNotice, setOfflineNotice] = useState<{ ok: boolean; msg: string } | null>(null);

  // Cloud Firestore state
  const [cloudRecords, setCloudRecords] = useState<CloudCompetitionRecord[]>([]);
  const [cloudBusy, setCloudBusy] = useState<boolean>(false);
  const [cloudNotice, setCloudNotice] = useState<{ ok: boolean; msg: string } | null>(null);
  const [firebaseReadyUser, setFirebaseReadyUser] = useState<boolean>(false);
  const [tokenServiceDisabled, setTokenServiceDisabled] = useState<boolean>(() =>
    isTokenServiceApiDisabled()
  );

  useEffect(() => {
    const unsubAuth = subscribeFirebaseAuth((u) => {
      setFirebaseReadyUser(Boolean(u && u.emailVerified));
    });
    const unsubTokenSvc = subscribeTokenServiceStatus((disabled) => {
      setTokenServiceDisabled(disabled);
    });
    return () => {
      unsubAuth();
      unsubTokenSvc();
    };
  }, []);

  // Club, Appearance & Swish settings state
  const [clubForm, setClubForm] = useState<ClubSettings>(clubSettings);
  const [clubBusy, setClubBusy] = useState<boolean>(false);
  const [logoBusy, setLogoBusy] = useState<boolean>(false);
  const [logoPreviewBroken, setLogoPreviewBroken] = useState<boolean>(false);
  const [clubNotice, setClubNotice] = useState<{ ok: boolean; msg: string } | null>(null);

  // Rental cards & Series state
  const [rentals, setRentals] = useState<RentalCardOverviewItem[]>([]);
  const [rentalFilter, setRentalFilter] = useState<'UNRETURNED' | 'ALL'>('UNRETURNED');
  const [rentalBusyKey, setRentalBusyKey] = useState<string | null>(null);
  const [selectedSeriesName, setSelectedSeriesName] = useState<string>('');
  const [selectedSeriesClass, setSelectedSeriesClass] = useState<string>('');
  const [seriesScoringModel, setSeriesScoringModel] =
    useState<SeriesScoringConfig['model']>('PLACEMENT');
  const [seriesPlacementScale, setSeriesPlacementScale] = useState<string>(
    DEFAULT_SERIES_SCORING_CONFIG.placementPoints.join(',')
  );
  const [seriesParticipationPoints, setSeriesParticipationPoints] = useState<string>(
    String(DEFAULT_SERIES_SCORING_CONFIG.participationPoints)
  );
  const [seriesScoringBusy, setSeriesScoringBusy] = useState<boolean>(false);
  const [seriesScoringNotice, setSeriesScoringNotice] = useState<{
    ok: boolean;
    msg: string;
  } | null>(null);
  const [newSeriesName, setNewSeriesName] = useState('');
  const [newSeriesBusy, setNewSeriesBusy] = useState(false);
  const [newSeriesNotice, setNewSeriesNotice] = useState<{
    ok: boolean;
    msg: string;
  } | null>(null);
  const [editingSeriesName, setEditingSeriesName] = useState<string | null>(null);
  const [seriesNameDraft, setSeriesNameDraft] = useState('');
  const [renamingSeries, setRenamingSeries] = useState(false);
  const [renameSeriesNotice, setRenameSeriesNotice] = useState<{
    ok: boolean;
    msg: string;
  } | null>(null);

  const isSuperAdmin = currentUser.adminTier === 'SUPER_ADMIN';
  const anyEventHasFees = Boolean(enableFeesAndSwish);

  useEffect(() => {
    setClubForm(clubSettings);
    setLogoPreviewBroken(false);
  }, [clubSettings]);

  // Live theme preview while editing Klubbprofil & Utseende
  useEffect(() => {
    if (subTab !== 'club') return;
    const isDark = document.documentElement.classList.contains('dark');
    applyClubThemeToDocument(clubForm, isDark);
    return () => {
      applyClubThemeToDocument(
        clubSettings,
        document.documentElement.classList.contains('dark')
      );
    };
  }, [subTab, clubForm, clubSettings]);

  useEffect(() => {
    const nextZero: Record<string, string> = {};
    for (const ev of competitionsList) {
      nextZero[ev.id] = ev.zeroTimeStr || '18:00:00';
    }
    setZeroDrafts(nextZero);
  }, [competitionsList]);

  useEffect(() => {
    if (seriesStandings.length === 0) {
      setSelectedSeriesName('');
      setSelectedSeriesClass('');
      return;
    }
    const activeBundle =
      seriesStandings.find((b) => b.seriesName === selectedSeriesName) ?? seriesStandings[0];
    if (activeBundle.seriesName !== selectedSeriesName) {
      setSelectedSeriesName(activeBundle.seriesName);
    }
    const hasCls = activeBundle.classes.some((c) => c.className === selectedSeriesClass);
    if (!hasCls) {
      setSelectedSeriesClass(activeBundle.classes[0]?.className ?? '');
    }
  }, [seriesStandings, selectedSeriesName, selectedSeriesClass]);

  const loadManageData = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      try {
        const [manageRes, rentalsRes] = await Promise.all([
          apiFetch('/api/auth/manage'),
          apiFetch('/api/club/rentals'),
        ]);
        if (manageRes.ok) {
          const data = (await manageRes.json()) as AuthManagePayload;
          setRolePins(data.rolePins);
          setPinsCustomized(data.pinsCustomized);
          setAdmins(data.admins);
          setOfflineEnabled(data.offlineCodeEnabled);
          setOfflineCustomized(data.offlineCodeCustomized);
        } else {
          setRolePins({ START: '1100', READOUT: '2200', FOREST: '3300', SPEAKER: '4400' });
          setPinsCustomized(false);
          setAdmins([
            {
              email: currentUser.email || 'instagram.okosteraker@gmail.com',
              displayName: currentUser.displayName || 'Huvudadministratör',
              role: currentUser.adminTier || 'SUPER_ADMIN',
              isBootstrapOwner: true,
              addedAt: new Date().toISOString(),
            },
          ]);
          setOfflineEnabled(true);
          setOfflineCustomized(false);
        }

        if (firebaseReadyUser) {
          try {
            const firebaseUser = await ensureValidFirestoreUser();
            const roleClaim = firebaseUser
              ? await ensureAdminRoleInFirestore(firebaseUser)
              : { claimed: false, role: null };
            const currentClaimedRole = roleClaim.claimed ? roleClaim.role : null;
            const currentEmail = firebaseUser?.email?.trim().toLowerCase();
            const invites = await listMyAdminInvitesFromFirestore();
            setAdmins((currentAdmins) => {
              const byEmail = new Map(
                currentAdmins.map((admin) => [admin.email.toLowerCase(), admin])
              );
              for (const invite of invites) {
                const email = invite.email.toLowerCase();
                const existing = byEmail.get(email);
                const isBootstrapAdmin = BOOTSTRAP_SUPER_ADMIN_EMAILS.includes(email);
                const isCurrentClaimedUser = email === currentEmail && currentClaimedRole !== null;
                byEmail.set(email, {
                  ...existing,
                  email: invite.email,
                  displayName: invite.displayName,
                  role: isBootstrapAdmin
                    ? 'SUPER_ADMIN'
                    : email === currentEmail
                      ? currentClaimedRole ?? invite.role
                      : invite.role,
                  isBootstrapOwner: Boolean(existing?.isBootstrapOwner || isBootstrapAdmin),
                  isPendingInvite:
                    !isBootstrapAdmin && !isCurrentClaimedUser && invite.active,
                  addedAt: existing?.addedAt || new Date().toISOString(),
                });
              }
              if (currentEmail && currentClaimedRole) {
                const existing = byEmail.get(currentEmail);
                byEmail.set(currentEmail, {
                  ...existing,
                  email: firebaseUser?.email || currentEmail,
                  displayName:
                    firebaseUser?.displayName || existing?.displayName || currentEmail,
                  role: currentClaimedRole,
                  isBootstrapOwner:
                    existing?.isBootstrapOwner ||
                    BOOTSTRAP_SUPER_ADMIN_EMAILS.includes(currentEmail),
                  isPendingInvite: false,
                  addedAt: existing?.addedAt || new Date().toISOString(),
                });
              }
              return Array.from(byEmail.values());
            });
          } catch (error) {
            console.error('Kunde inte läsa Google-administratörsinbjudningar från Firestore:', error);
          }
        }

        if (rentalsRes.ok) {
          const rData = (await rentalsRes.json()) as { rentals?: RentalCardOverviewItem[] };
          setRentals(rData.rentals ?? []);
        } else {
          const localRentals: RentalCardOverviewItem[] = competitors
            .filter((c) => c.isRentalCard)
            .map((c) => ({
              eventId: activeEventId,
              eventName: competitionName,
              eventDate: getStockholmTodayIso(),
              shortCode: '',
              competitorId: c.id,
              bib: c.bib,
              fullName: c.fullName,
              club: c.club,
              className: classes.find((cl) => cl.id === c.classId)?.name || 'Klass',
              siNumber: c.siNumber,
              cardSeries: c.cardSeries || 'SI-Card 10',
              rentalReturned: c.rentalReturned,
              feePaid: Boolean(c.feePaid),
              enableFeesAndSwish: true,
              status: c.status,
            }));
          setRentals(localRentals);
        }
      } catch {
        setRolePins({ START: '1100', READOUT: '2200', FOREST: '3300', SPEAKER: '4400' });
        setPinsCustomized(false);
        setAdmins([
          {
            email: currentUser.email || 'instagram.okosteraker@gmail.com',
            displayName: currentUser.displayName || 'Huvudadministratör',
            role: currentUser.adminTier || 'SUPER_ADMIN',
            isBootstrapOwner: true,
            addedAt: new Date().toISOString(),
          },
        ]);
        setOfflineEnabled(true);
        setOfflineCustomized(false);
      }

      // Single-document read for /clubSettings/default from Firestore (never getDocs)
      if (auth.currentUser) {
        try {
          const cloudSettings = await loadClubSettingsFromFirestore();
          if (cloudSettings) {
            setClubForm((prev) => ({
              ...prev,
              ...cloudSettings,
            }));
          }
        } catch (cloudErr) {
          const msg = cloudErr instanceof Error ? cloudErr.message : String(cloudErr);
          if (msg.includes('permission-denied') || msg.includes('under /admins')) {
            setClubNotice({
              ok: false,
              msg,
            });
          }
        }
      }
    } finally {
      setLoading(false);
    }
  }, [
    activeEventId,
    classes,
    competitionName,
    competitors,
    currentUser,
    firebaseReadyUser,
  ]);

  const loadCloudCompetitions = useCallback(async () => {
    const validUser = await ensureValidFirestoreUser();
    if (!validUser) {
      setCloudRecords([]);
      return;
    }
    try {
      const items = await listClubCloudCompetitionsFromFirestore();
      setCloudRecords(items);
    } catch {
      // ignore if offline
    }
  }, []);

  useEffect(() => {
    void loadManageData();
    void loadCloudCompetitions();
  }, [activeEventId, competitionsList.length, firebaseReadyUser, loadManageData, loadCloudCompetitions]);

  const pushSeasonSnapshotToFirestore = useCallback(async (): Promise<number | null> => {
    const validUser = await ensureValidFirestoreUser();
    if (!validUser) return null;
    const expRes = await apiFetch('/api/system/cloud-export');
    if (!expRes.ok) return null;
    const cloudSnap = (await expRes.json()) as CloudSeasonSnapshot;
    const result = await syncFullSeasonToFirestore(cloudSnap, isSuperAdmin);
    await loadCloudCompetitions();
    return result.syncedEvents;
  }, [isSuperAdmin, loadCloudCompetitions]);

  // Competition actions
  const handleActivateEvent = async (eventId: string) => {
    setEventBusyId(eventId);
    setEventsNotice(null);
    try {
      const activated = await onActivateCompetition(eventId);
      if (activated) {
        await loadCloudCompetitions();
        setEventsNotice({ ok: true, msg: 'Tävlingen aktiverades.' });
      }
    } catch (error) {
      setEventsNotice({
        ok: false,
        msg: error instanceof Error ? error.message : 'Kunde inte aktivera tävlingen.',
      });
    } finally {
      setEventBusyId(null);
    }
  };

  const handleUpdateEventMeta = async (
    eventId: string,
    patch: {
      status?: EventLifecycleStatus;
      date?: string;
      zeroTimeStr?: string;
      seriesName?: string;
      enableFeesAndSwish?: boolean;
    }
  ) => {
    setEventBusyId(eventId);
    setEventsNotice(null);
    try {
      await onUpdateCompetitionMeta(eventId, patch);
      await loadCloudCompetitions();
      setEventsNotice({ ok: true, msg: 'Tävlingsinställningarna sparades.' });
    } catch (error) {
      setEventsNotice({
        ok: false,
        msg: error instanceof Error ? error.message : 'Kunde inte uppdatera tävlingen.',
      });
    } finally {
      setEventBusyId(null);
    }
  };

  const handleDuplicateEvent = async (ev: CompetitionSummary) => {
    setEventBusyId(ev.id);
    setEventsNotice(null);
    try {
      let res: Response | null = null;
      try {
        res = await apiFetch(`/api/competitions/${encodeURIComponent(ev.id)}/duplicate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
      }

      if (res?.ok) {
        const snap = (await res.json()) as MeosAppState;
        onApplyStateSnapshot(snap);
      } else {
        if (res && res.status !== 404 && res.status !== 405) {
          const errorBody = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(errorBody.error ?? 'Kunde inte duplicera tävlingen.');
        }
        const cloudSnap = await loadFullSeasonFromFirestore({ competitionId: ev.id });
        const source = cloudSnap?.events.find((item) => item.competition.id === ev.id);
        if (!source) throw new Error('Tävlingen hittades inte i Firestore.');
        const suffix = Date.now().toString().slice(-6);
        await createCompetitionInFirestore({
          competitionId: `evt-copy-${Date.now()}`,
          shortCode: `${source.competition.shortCode.slice(0, 20)}-${suffix}`,
          name: `${source.competition.name} (kopia)`.slice(0, 140),
          organizer: source.competition.organizer,
          date: getStockholmTodayIso(),
          status: 'UPCOMING',
          zeroTimeStr: source.competition.zeroTimeStr,
          zeroTimeSec: source.competition.zeroTimeSec,
          arenaInfo: source.competition.arenaInfo,
          seriesName: source.competition.seriesName,
          enableFeesAndSwish: source.competition.enableFeesAndSwish,
          courses: source.courses,
          classes: source.classes,
        });
        await loadCloudCompetitions();
      }
      setEventsNotice({
        ok: true,
        msg: `Duplicerade banor och klasser från "${ev.name}" till en ny tävling.`,
      });
    } catch (error) {
      setEventsNotice({
        ok: false,
        msg: error instanceof Error ? error.message : 'Kunde inte duplicera tävlingen.',
      });
    } finally {
      setEventBusyId(null);
    }
  };

  const handleDeleteEvent = async (ev: CompetitionSummary) => {
    setEventBusyId(ev.id);
    setEventsNotice(null);
    try {
      let removedFromServer = false;
      let serverError = '';
      try {
        const res = await apiFetch(`/api/competitions/${encodeURIComponent(ev.id)}`, {
          method: 'DELETE',
        });
        if (res.ok) {
          const body = await res.text();
          if (body.trim() && res.headers.get('content-type')?.includes('application/json')) {
            try {
              onApplyStateSnapshot(JSON.parse(body) as MeosAppState);
            } catch {
              serverError = 'Tävlingsservern returnerade ett ogiltigt svar efter radering.';
            }
          }
          removedFromServer = !body.trim() || Boolean(
            res.headers.get('content-type')?.includes('application/json') && !serverError
          );
        } else {
          const body = await res.text();
          if (res.status !== 404 && !res.headers.get('content-type')?.includes('text/html')) {
            try {
              const data = JSON.parse(body) as { error?: string };
              serverError = data.error || body.trim().slice(0, 240);
            } catch {
              serverError = body.trim().slice(0, 240);
            }
          }
        }
      } catch (error) {
        serverError = error instanceof Error ? error.message : String(error);
      }

      let removedFromCloud = false;
      let cloudError = '';
      if (firebaseReadyUser) {
        try {
          await deleteCompetitionFromFirestore(ev.id);
          removedFromCloud = true;
          await loadCloudCompetitions();
        } catch (error) {
          cloudError = error instanceof Error ? error.message : String(error);
        }
      }

      if (!removedFromServer && !removedFromCloud) {
        throw new Error(
          [cloudError, serverError].filter(Boolean).join(' ') || 'Kunde inte radera tävlingen.'
        );
      }

      setConfirmDeleteEventId(null);
      setEventsNotice({
        ok: true,
        msg:
          removedFromServer && removedFromCloud
            ? `Raderade "${ev.name}" från tävlingsservern och Firestore.`
            : removedFromCloud
            ? `Raderade "${ev.name}" från Firestore.${serverError ? ` Tävlingsservern svarade: ${serverError}` : ''}`
            : `Raderade "${ev.name}" från tävlingsservern, men inte från Firestore.${cloudError ? ` ${cloudError}` : ''}`,
      });
    } catch (error) {
      setEventsNotice({
        ok: false,
        msg: error instanceof Error ? error.message : 'Kunde inte radera tävlingen.',
      });
    } finally {
      setEventBusyId(null);
    }
  };

  const handleClearAllEvents = async () => {
    setEventBusyId('CLEAR_ALL');
    setEventsNotice(null);
    try {
      const res = await apiFetch('/api/system/clear-demo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clearRunnerDb: false }),
      });
      if (!res.ok) {
        setEventsNotice({ ok: false, msg: 'Kunde inte rensa tävlingslistan.' });
        return;
      }
      const snap = (await res.json()) as MeosAppState;
      onApplyStateSnapshot(snap);
      setConfirmClearAll(false);

      if (firebaseReadyUser) {
        try {
          await pushSeasonSnapshotToFirestore();
        } catch {
          // ignore offline
        }
      }
      setEventsNotice({
        ok: true,
        msg: 'Alla tävlingar raderades. Säsongen är tom och redo för skarpa tävlingar.',
      });
    } finally {
      setEventBusyId(null);
    }
  };

  const handleResetDemoSeed = async () => {
    setEventBusyId('RESET_SEED');
    setEventsNotice(null);
    try {
      try {
        const res = await apiFetch('/api/system/reset-seed', { method: 'POST' });
        if (res.ok) {
          const snap = (await res.json()) as MeosAppState;
          onApplyStateSnapshot(snap);
          setConfirmResetSeed(false);
          void loadManageData();
          setEventsNotice({
            ok: true,
            msg: 'Återställde klubbens demotävlingar och exempeldata.',
          });
          return;
        }
      } catch {
        // Fallback to client-side Firestore seeding
      }

      const cloudSnap = await seedDemoSeasonToFirestore(currentUser.uid);
      if (cloudSnap && cloudSnap.events.length > 0) {
        const firstEvt = cloudSnap.events[0];
        onApplyStateSnapshot({
          activeEventId: firstEvt.competition.id,
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
          demoCleared: false,
          clubSettings: cloudSnap.clubSettings,
          seriesStandings: [],
          competition: firstEvt.competition,
          courses: firstEvt.courses,
          classes: firstEvt.classes,
          stations: [],
          competitors: firstEvt.competitors,
          runnerDb: [],
          eventor: {
            apiKeyConfigured: false,
            baseUrl: '',
            connectedOrgId: null,
            connectedOrgName: null,
            connectedEventId: null,
            lastSyncedAt: null,
            autoCreateFromRunnerDbOnReadout: true,
          },
          emergency: { brokenControls: [], controlTimeOffsets: {} },
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
      }
      setConfirmResetSeed(false);
      void loadManageData();
      setEventsNotice({
        ok: true,
        msg: 'Återställde klubbens demotävlingar och exempeldata direkt i Firestore.',
      });
    } catch (err) {
      setEventsNotice({
        ok: false,
        msg: err instanceof Error ? err.message : 'Kunde inte återställa demodata.',
      });
    } finally {
      setEventBusyId(null);
    }
  };

  const handleDownloadBackup = async () => {
    setBackupBusy(true);
    setEventsNotice(null);
    try {
      const res = await apiFetch('/api/system/backup');
      if (!res.ok) {
        setEventsNotice({ ok: false, msg: 'Kunde inte exportera säkerhetskopia.' });
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const cd = res.headers.get('content-disposition') || '';
      const match = cd.match(/filename="([^"]+)"/);
      a.download = match?.[1] || 'passersi-season-db.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } finally {
      setBackupBusy(false);
    }
  };

  const handleRestoreBackupFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBackupBusy(true);
    setEventsNotice(null);
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as unknown;
      const res = await apiFetch('/api/system/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsed),
      });
      const payload = (await res.json().catch(() => ({}))) as {
        eventCount?: number;
        error?: string;
      };
      if (!res.ok) {
        setEventsNotice({
          ok: false,
          msg: payload.error || 'Filen kunde inte läsas in som säkerhetskopia.',
        });
        return;
      }
      const stateRes = await apiFetch('/api/state');
      if (stateRes.ok) {
        const snap = (await stateRes.json()) as MeosAppState;
        onApplyStateSnapshot(snap);
      }
      void loadManageData();
      setEventsNotice({
        ok: true,
        msg: `Läste in säkerhetskopia (${payload.eventCount ?? 0} tävlingar).`,
      });
    } catch {
      setEventsNotice({ ok: false, msg: 'Ogiltig JSON-fil.' });
    } finally {
      setBackupBusy(false);
    }
  };

  const handleConnectGoogleForCloud = async () => {
    setCloudBusy(true);
    setCloudNotice(null);
    try {
      const { user } = await signInWithGooglePopup();
      if (!user) {
        setCloudNotice({
          ok: false,
          msg: 'Token Service API (securetoken.googleapis.com) är fortfarande inaktiverat i Google Cloud-projektet. Aktivera API:et via länken nedan, vänta ca 1 minut och prova igen.',
        });
        return;
      }
      try {
        await ensureAdminRoleInFirestore(user);
      } catch {
        // ignore if role claim already exists
      }
      await loadCloudCompetitions();
      setCloudNotice({
        ok: true,
        msg: 'Google-kontot är nu anslutet mot Firestore.',
      });
    } catch {
      setCloudNotice({
        ok: false,
        msg: 'Kunde inte ansluta Google-kontot i det här fönstret. Öppna appen i en egen flik om popup-fönstret blockerades.',
      });
    } finally {
      setCloudBusy(false);
    }
  };

  // Cloud Firestore manual sync & hydrate
  const handleSyncCloudNow = async () => {
    const validUser = await ensureValidFirestoreUser();
    if (!validUser) {
      setCloudNotice({
        ok: false,
        msg: isTokenServiceApiDisabled()
          ? 'Aktivera Token Service API i Google Cloud-projektet först och klicka sedan på "Anslut Google".'
          : 'Klicka på "Anslut Google" för att synka hela säsongen mot Firestore.',
      });
      return;
    }
    setCloudBusy(true);
    setCloudNotice(null);
    try {
      const count = await pushSeasonSnapshotToFirestore();
      setCloudNotice({
        ok: true,
        msg: `Synkade klubbinställningar och ${count ?? 0} tävlingar (inkl. banor, klasser och deltagare) till Firestore.`,
      });
    } catch {
      setCloudNotice({
        ok: false,
        msg: 'Kunde inte nå Firestore just nu. Kontrollera internetuppkopplingen.',
      });
    } finally {
      setCloudBusy(false);
    }
  };

  const handleHydrateFromCloudNow = async () => {
    const validUser = await ensureValidFirestoreUser();
    if (!validUser) {
      setCloudNotice({
        ok: false,
        msg: isTokenServiceApiDisabled()
          ? 'Aktivera Token Service API i Google Cloud-projektet först och klicka sedan på "Anslut Google".'
          : 'Klicka på "Anslut Google" för att läsa in klubbens molndata från Firestore.',
      });
      return;
    }
    setCloudBusy(true);
    setCloudNotice(null);
    try {
      const cloudSnap = await loadFullSeasonFromFirestore();
      if (!cloudSnap) {
        setCloudNotice({
          ok: false,
          msg: 'Ingen sparad molnsäsong hittades i Firestore ännu. Klicka på "Synka till Firestore" först.',
        });
        return;
      }
      const res = await apiFetch('/api/system/cloud-hydrate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cloudSnap),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        setCloudNotice({
          ok: false,
          msg: err.error || 'Kunde inte aktivera molnsäsongen i servern.',
        });
        return;
      }
      const hydrated = (await res.json()) as MeosAppState;
      onApplyStateSnapshot(hydrated);
      await loadManageData();
      setCloudNotice({
        ok: true,
        msg: `Läste in ${cloudSnap.events.length} tävlingar och klubbinställningar från Firestore.`,
      });
    } catch {
      setCloudNotice({
        ok: false,
        msg: 'Kunde inte hämta data från Firestore.',
      });
    } finally {
      setCloudBusy(false);
    }
  };

  // PINs handlers
  const handleRandomizeSingleRole = (targetRole: OfficialPinRole) => {
    const others = new Set(
      (Object.keys(rolePins) as OfficialPinRole[])
        .filter((k) => k !== targetRole)
        .map((k) => rolePins[k])
    );
    let candidate = '1000';
    for (let i = 0; i < 50; i++) {
      const next = String(1000 + Math.floor(Math.random() * 9000));
      if (!others.has(next)) {
        candidate = next;
        break;
      }
    }
    setRolePins((prev) => ({ ...prev, [targetRole]: candidate }));
    setPinsNotice(null);
  };

  const handleSavePins = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeEventId) return;
    setPinsBusy(true);
    setPinsNotice(null);
    try {
      const res = await apiFetch('/api/auth/pins', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventId: activeEventId,
          rolePins,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        rolePins?: RolePinMap;
        pinsCustomized?: boolean;
        error?: string;
      };
      if (!res.ok || !data.rolePins) {
        setPinsNotice({
          ok: false,
          msg: data.error || 'Kunde inte spara PIN-koderna.',
        });
        return;
      }
      setRolePins(data.rolePins);
      setPinsCustomized(true);
      setPinsNotice({
        ok: true,
        msg: `Sparade funktionärernas PIN-koder för ${competitionName}.`,
      });
    } finally {
      setPinsBusy(false);
    }
  };

  const handleCopyPin = async (role: OfficialPinRole, title: string) => {
    const text = `${competitionName} — ${title}: PIN ${rolePins[role]}`;
    try {
      await navigator.clipboard.writeText(text);
      setCopiedRole(role);
      setTimeout(() => setCopiedRole(null), 1800);
    } catch {
      // ignore clipboard restrictions
    }
  };

  // Google Admin handlers
  const handleAddAdmin = async (e: React.FormEvent) => {
    e.preventDefault();
    const normEmail = newAdminEmail.trim().toLowerCase();
    const cleanName = newAdminName.trim() || normEmail.split('@')[0];
    if (!normEmail) return;

    const grantedRole: ClubAdminTier = isSuperAdmin ? newAdminRole : 'RACE_ADMIN';
    setAdminBusy(true);
    setAdminNotice(null);
    try {
      if (firebaseReadyUser) {
        const user = await ensureValidFirestoreUser();
        if (!user) {
          throw new Error('Logga in med ett verifierat Google-konto innan du lägger till administratörer.');
        }
        const roleClaim = await ensureAdminRoleInFirestore(user);
        if (!roleClaim.claimed) {
          throw new Error('Ditt Google-konto saknar Firestore-administratörsbehörighet.');
        }
        await upsertAdminInviteInFirestore({
          email: normEmail,
          displayName: cleanName,
          role: grantedRole,
          isSuperAdmin,
        });
        setAdmins((current) => [
          ...current.filter((admin) => admin.email.toLowerCase() !== normEmail),
          {
            email: normEmail,
            displayName: cleanName,
            role: grantedRole,
            isPendingInvite: true,
            addedAt: new Date().toISOString(),
          },
        ]);
        setNewAdminEmail('');
        setNewAdminName('');
        setNewAdminRole('RACE_ADMIN');
        setAdminNotice({
          ok: true,
          msg: `Inbjudan till ${normEmail} skapad. Personen behöver logga in med det Google-kontot för att aktivera behörigheten.`,
        });
        return;
      }

      const res = await apiFetch('/api/auth/admins', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: normEmail,
          displayName: cleanName,
          role: grantedRole,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        admins?: ClubAdminAccount[];
        error?: string;
      };
      if (!res.ok || !data.admins) {
        setAdminNotice({
          ok: false,
          msg: data.error || 'Kunde inte lägga till Google-administratör.',
        });
        return;
      }

      setAdmins(data.admins);
      let cloudSynced = false;
      if (firebaseReadyUser) {
        try {
          await upsertAdminInviteInFirestore({
            email: normEmail,
            displayName: cleanName,
            role: grantedRole,
            isSuperAdmin,
          });
          cloudSynced = true;
        } catch {
          cloudSynced = false;
        }
      }

      setNewAdminEmail('');
      setNewAdminName('');
      setNewAdminRole('RACE_ADMIN');
      setAdminNotice({
        ok: true,
        msg: cloudSynced
          ? `Lade till ${normEmail} (${
              grantedRole === 'SUPER_ADMIN' ? 'Huvudadministratör' : 'Tävlingsledare'
            }) i både tävlingsservern och Firestore RBAC.`
          : `Lade till ${normEmail} i tävlingsservern.`,
      });
    } catch (error) {
      setAdminNotice({
        ok: false,
        msg:
          error instanceof Error
            ? error.message
            : 'Kunde inte lägga till Google-administratör.',
      });
    } finally {
      setAdminBusy(false);
    }
  };

  const handleChangeAdminRole = async (adm: ClubAdminAccount, nextRole: ClubAdminTier) => {
    setAdminBusy(true);
    setAdminNotice(null);
    try {
      if (adm.isPendingInvite && firebaseReadyUser) {
        await upsertAdminInviteInFirestore({
          email: adm.email,
          displayName: adm.displayName,
          role: nextRole,
          isSuperAdmin,
        });
        setAdmins((current) =>
          current.map((admin) =>
            admin.email.toLowerCase() === adm.email.toLowerCase()
              ? { ...admin, role: nextRole }
              : admin
          )
        );
        setAdminNotice({
          ok: true,
          msg: `Uppdaterade inbjudan för ${adm.email}. Behörigheten aktiveras när personen loggar in.`,
        });
        return;
      }

      let res: Response | null = null;
      try {
        res = await apiFetch(`/api/auth/admins/${encodeURIComponent(adm.email)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ role: nextRole }),
        });
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
      }
      if (res && res.status !== 404 && res.status !== 405) {
        const data = (await res.json().catch(() => ({}))) as {
          admins?: ClubAdminAccount[];
          error?: string;
        };
        if (!res.ok || !data.admins) {
          setAdminNotice({
            ok: false,
            msg: data.error || 'Kunde inte ändra behörighetsnivå.',
          });
          return;
        }
        setAdmins(data.admins);
      } else {
        if (!firebaseReadyUser || !isSuperAdmin) {
          throw new Error('Kunde inte nå administratörstjänsten för att ändra behörigheten.');
        }
        await upsertAdminInviteInFirestore({
          email: adm.email,
          displayName: adm.displayName,
          role: nextRole,
          isSuperAdmin,
        });
        setAdmins((current) =>
          current.map((admin) =>
            admin.email.toLowerCase() === adm.email.toLowerCase()
              ? { ...admin, role: nextRole }
              : admin
          )
        );
        setAdminNotice({
          ok: true,
          msg: `Uppdaterade ${adm.email} till ${
            nextRole === 'SUPER_ADMIN' ? 'Huvudadministratör' : 'Tävlingsledare'
          } i Firestore.`,
        });
        return;
      }
      if (firebaseReadyUser) {
        await upsertAdminInviteInFirestore({
          email: adm.email,
          displayName: adm.displayName,
          role: nextRole,
          isSuperAdmin,
        });
      }
      setAdminNotice({
        ok: true,
        msg: `Uppdaterade ${adm.email} till ${
          nextRole === 'SUPER_ADMIN' ? 'Huvudadministratör' : 'Tävlingsledare'
        }.`,
      });
    } catch (error) {
      setAdminNotice({
        ok: false,
        msg:
          error instanceof Error
            ? error.message
            : 'Kunde inte ändra behörighetsnivå.',
      });
    } finally {
      setAdminBusy(false);
    }
  };

  const handleRemoveAdmin = async (email: string) => {
    setAdminBusy(true);
    setAdminNotice(null);
    try {
      const pendingInvite = admins.find(
        (admin) =>
          admin.email.toLowerCase() === email.toLowerCase() && admin.isPendingInvite
      );
      if (pendingInvite && firebaseReadyUser) {
        await removeAdminInviteFromFirestore(email);
        setAdmins((current) =>
          current.filter((admin) => admin.email.toLowerCase() !== email.toLowerCase())
        );
        setConfirmRemoveEmail(null);
        setAdminNotice({
          ok: true,
          msg: `Tog bort den ännu ej aktiverade inbjudan för ${email}.`,
        });
        return;
      }

      let res: Response | null = null;
      try {
        res = await apiFetch(`/api/auth/admins/${encodeURIComponent(email)}`, {
          method: 'DELETE',
        });
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
      }
      if (res && res.status !== 404 && res.status !== 405) {
        const data = (await res.json().catch(() => ({}))) as {
          admins?: ClubAdminAccount[];
          error?: string;
        };
        if (!res.ok || !data.admins) {
          setAdminNotice({
            ok: false,
            msg: data.error || 'Kunde inte ta bort kontot.',
          });
          return;
        }
        setAdmins(data.admins);
      } else {
        if (!firebaseReadyUser || !isSuperAdmin) {
          throw new Error('Kunde inte nå administratörstjänsten för att ta bort behörigheten.');
        }
        await removeAdminInviteFromFirestore(email);
        setAdmins((current) =>
          current.filter((admin) => admin.email.toLowerCase() !== email.toLowerCase())
        );
      }
      setConfirmRemoveEmail(null);

      if (firebaseReadyUser && isSuperAdmin && res) {
        await removeAdminInviteFromFirestore(email);
      }
      setAdminNotice({
        ok: true,
        msg: `Tog bort Google-behörigheten för ${email}.`,
      });
    } catch (error) {
      setAdminNotice({
        ok: false,
        msg:
          error instanceof Error
            ? error.message
            : 'Kunde inte ta bort kontot.',
      });
    } finally {
      setAdminBusy(false);
    }
  };

  const handleSaveOfflineSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    setOfflineBusy(true);
    setOfflineNotice(null);
    try {
      const res = await apiFetch('/api/auth/offline-code', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: offlineEnabled,
          ...(newOfflineCode.trim() ? { newCode: newOfflineCode.trim() } : {}),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        offlineCodeEnabled?: boolean;
        offlineCodeCustomized?: boolean;
        error?: string;
      };
      if (!res.ok) {
        setOfflineNotice({
          ok: false,
          msg: data.error || 'Kunde inte uppdatera offline reservkod.',
        });
        return;
      }
      setOfflineEnabled(Boolean(data.offlineCodeEnabled));
      setOfflineCustomized(Boolean(data.offlineCodeCustomized));
      setNewOfflineCode('');
      setOfflineNotice({
        ok: true,
        msg: newOfflineCode.trim()
          ? 'Ny offline reservkod sparad (krypterad med scrypt).'
          : 'Inställning för offline reservläge sparad.',
      });
    } finally {
      setOfflineBusy(false);
    }
  };

  const handleLogoFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setLogoBusy(true);
    setClubNotice(null);
    try {
      const encoded = await processClubLogoFile(file);
      setLogoPreviewBroken(false);
      setClubForm((prev) => ({ ...prev, logoDataUrl: encoded }));
      setClubNotice({
        ok: true,
        msg: 'Klubblogga inläst. Klicka på Spara klubbprofil för att publicera den.',
      });
    } catch (err) {
      setClubNotice({
        ok: false,
        msg: err instanceof Error ? err.message : 'Kunde inte läsa in logotypen.',
      });
    } finally {
      setLogoBusy(false);
    }
  };

  const handleResetAppearance = () => {
    setClubForm((prev) => ({
      ...prev,
      portalTitle: '',
      customBgColor: '',
      customTextColor: '',
      customAccentColor: '',
    }));
  };

  // Club, Appearance & Swish settings save
  const handleSaveClubSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    setClubBusy(true);
    setClubNotice(null);
    try {
      try {
        const res = await apiFetch('/api/club-settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(clubForm),
        });
        if (res.ok) {
          const stateRes = await apiFetch('/api/state');
          if (stateRes.ok) {
            const snap = (await stateRes.json()) as MeosAppState;
            onApplyStateSnapshot(snap);
          }
        }
      } catch {
        // Backend offline / Vercel static
      }

      let savedToFirestore = false;
      if (auth.currentUser) {
        try {
          await saveClubSettingsToFirestore(clubForm, isSuperAdmin);
          savedToFirestore = true;
        } catch (cloudErr) {
          console.warn('Firestore club save error:', cloudErr);
          const msg = cloudErr instanceof Error ? cloudErr.message : String(cloudErr);
          if (msg.includes('permission-denied') || msg.includes('under /admins')) {
            setClubNotice({
              ok: false,
              msg,
            });
            return;
          }
        }
      }

      if (onUpdateClubSettings) {
        onUpdateClubSettings(clubForm);
      }
      applyClubThemeToDocument(clubForm, false);

      setClubNotice({
        ok: true,
        msg: savedToFirestore
          ? 'Sparade klubbprofil, logotyp, utseende och Swish-inställningar i Firestore.'
          : 'Sparade klubbprofil, logotyp och grundutseende.',
      });
    } catch (err) {
      setClubNotice({
        ok: false,
        msg: err instanceof Error ? err.message : 'Kunde inte spara klubbinställningar.',
      });
    } finally {
      setClubBusy(false);
    }
  };

  // Rental card return toggle
  const handleToggleRentalReturned = async (item: RentalCardOverviewItem) => {
    const key = `${item.eventId}:${item.competitorId}`;
    setRentalBusyKey(key);
    try {
      const res = await apiFetch(
        `/api/club/rentals/${encodeURIComponent(item.eventId)}/${encodeURIComponent(
          item.competitorId
        )}/return`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rentalReturned: !item.rentalReturned }),
        }
      );
      if (res.ok) {
        const data = (await res.json()) as { rentals?: RentalCardOverviewItem[] };
        setRentals(data.rentals ?? []);
        const stateRes = await apiFetch('/api/state');
        if (stateRes.ok) {
          onApplyStateSnapshot((await stateRes.json()) as MeosAppState);
        }
      }
    } finally {
      setRentalBusyKey(null);
    }
  };

  const unreturnedRentalsCount = useMemo(
    () => rentals.filter((r) => !r.rentalReturned).length,
    [rentals]
  );

  const visibleRentals = useMemo(
    () =>
      rentalFilter === 'UNRETURNED'
        ? rentals.filter((r) => !r.rentalReturned)
        : rentals,
    [rentals, rentalFilter]
  );

  const activePaymentSummary = useMemo(() => {
    let paidCount = 0;
    let unpaidCount = 0;
    let totalPaidSek = 0;
    let totalOutstandingSek = 0;

    for (const c of competitors) {
      const cls = classes.find((x) => x.id === c.classId);
      const fee =
        (cls?.feeSek ?? clubSettings.defaultDirectEntryFeeSek) +
        (c.isRentalCard ? clubSettings.rentalCardFeeSek : 0);
      if (c.feePaid) {
        paidCount += 1;
        totalPaidSek += fee;
      } else if (enableFeesAndSwish) {
        unpaidCount += 1;
        totalOutstandingSek += fee;
      }
    }
    return { paidCount, unpaidCount, totalPaidSek, totalOutstandingSek };
  }, [competitors, classes, clubSettings, enableFeesAndSwish]);

  const activeSeriesBundle = useMemo(
    () =>
      seriesStandings.find((b) => b.seriesName === selectedSeriesName) ??
      seriesStandings[0] ??
      null,
    [seriesStandings, selectedSeriesName]
  );

  const activeSeriesClassGroup = useMemo(
    () =>
      activeSeriesBundle?.classes.find((c) => c.className === selectedSeriesClass) ??
      activeSeriesBundle?.classes[0] ??
      null,
    [activeSeriesBundle, selectedSeriesClass]
  );
  const activeSeriesScoringConfig =
    (activeSeriesBundle &&
      clubSettings.seriesScoringSettings?.[activeSeriesBundle.seriesName]) ??
    DEFAULT_SERIES_SCORING_CONFIG;
  const availableSeriesNames = useMemo(
    () =>
      Array.from(
        new Set([
          ...competitionsList
            .map((event) => event.seriesName?.trim() ?? '')
            .filter(Boolean),
          ...Object.keys(clubSettings.seriesScoringSettings ?? {}),
        ])
      ).sort((a, b) => a.localeCompare(b, 'sv')),
    [clubSettings.seriesScoringSettings, competitionsList]
  );

  useEffect(() => {
    if (!activeSeriesBundle) return;
    const config =
      clubSettings.seriesScoringSettings?.[activeSeriesBundle.seriesName] ??
      DEFAULT_SERIES_SCORING_CONFIG;
    setSeriesScoringModel(config.model);
    setSeriesPlacementScale(config.placementPoints.join(','));
    setSeriesParticipationPoints(String(config.participationPoints));
    setSeriesScoringNotice(null);
  }, [activeSeriesBundle?.seriesName, clubSettings.seriesScoringSettings]);

  const handleSaveSeriesScoring = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeSeriesBundle) return;

    const placementTokens = seriesPlacementScale
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    const placementPoints = placementTokens.map(Number);
    const participationPoints = Number(seriesParticipationPoints);
    if (
      placementPoints.length === 0 ||
      placementPoints.some(
        (points) => !Number.isInteger(points) || points < 0 || points > 10000
      )
    ) {
      setSeriesScoringNotice({
        ok: false,
        msg: 'Ange placeringspoäng som heltal separerade med kommatecken.',
      });
      return;
    }
    if (
      !Number.isInteger(participationPoints) ||
      participationPoints < 0 ||
      participationPoints > 10000
    ) {
      setSeriesScoringNotice({
        ok: false,
        msg: 'Ange deltagandepoäng som ett heltal mellan 0 och 10 000.',
      });
      return;
    }

    const nextConfig: SeriesScoringConfig = {
      model: seriesScoringModel,
      placementPoints,
      participationPoints,
    };

    const nextSettings: ClubSettings = {
      ...clubSettings,
      seriesScoringSettings: {
        ...clubSettings.seriesScoringSettings,
        [activeSeriesBundle.seriesName]: nextConfig,
      },
    };
    setSeriesScoringBusy(true);
    setSeriesScoringNotice(null);
    try {
      let savedToServer = false;
      try {
        const response = await apiFetch('/api/club-settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(nextSettings),
        });
        if (response.ok) {
          savedToServer = true;
          const stateResponse = await apiFetch('/api/state');
          if (stateResponse.ok) {
            onApplyStateSnapshot((await stateResponse.json()) as MeosAppState);
          }
        }
      } catch {
        // Use Firestore directly when the Express API is unavailable.
      }

      if (auth.currentUser) {
        await saveClubSettingsToFirestore(nextSettings, isSuperAdmin);
        const cloudSnapshot = await loadFullSeasonFromFirestore();
        if (cloudSnapshot) {
          onApplySeriesScoringUpdate(
            cloudSnapshot.clubSettings,
            cloudSnapshot.seriesStandings ?? []
          );
        }
      } else if (!savedToServer) {
        throw new Error('Logga in för att spara poängmodellen för serien.');
      }

      setSeriesScoringNotice({
        ok: true,
        msg: 'Poängmodellen är sparad och serietabellen har uppdaterats.',
      });
    } catch (error) {
      setSeriesScoringNotice({
        ok: false,
        msg:
          error instanceof Error
            ? error.message
            : 'Kunde inte spara poängmodellen för serien.',
      });
    } finally {
      setSeriesScoringBusy(false);
    }
  };

  const handleCreateSeries = async (e: React.FormEvent) => {
    e.preventDefault();
    const seriesName = newSeriesName.trim();
    if (!seriesName) {
      setNewSeriesNotice({ ok: false, msg: 'Ange ett serienamn.' });
      return;
    }
    if (seriesName.length > 80) {
      setNewSeriesNotice({ ok: false, msg: 'Serienamnet får vara högst 80 tecken.' });
      return;
    }
    if (
      availableSeriesNames.some(
        (existingName) => existingName.toLocaleLowerCase() === seriesName.toLocaleLowerCase()
      )
    ) {
      setNewSeriesNotice({ ok: false, msg: 'En serie med det namnet finns redan.' });
      return;
    }

    const nextSettings: ClubSettings = {
      ...clubSettings,
      seriesScoringSettings: {
        ...clubSettings.seriesScoringSettings,
        [seriesName]: DEFAULT_SERIES_SCORING_CONFIG,
      },
    };
    setNewSeriesBusy(true);
    setNewSeriesNotice(null);
    try {
      let savedToServer = false;
      try {
        const response = await apiFetch('/api/club-settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(nextSettings),
        });
        if (response.ok) {
          savedToServer = true;
          const stateResponse = await apiFetch('/api/state');
          if (stateResponse.ok) {
            onApplyStateSnapshot((await stateResponse.json()) as MeosAppState);
          }
        } else if (response.status !== 404 && response.status !== 405) {
          const errorBody = (await response.json().catch(() => ({}))) as {
            error?: string;
          };
          throw new Error(errorBody.error ?? 'Kunde inte skapa serien.');
        }
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
      }

      if (auth.currentUser) {
        await saveClubSettingsToFirestore(nextSettings, isSuperAdmin);
        const cloudSnapshot = await loadFullSeasonFromFirestore();
        if (cloudSnapshot) {
          onApplySeriesScoringUpdate(
            cloudSnapshot.clubSettings,
            cloudSnapshot.seriesStandings ?? []
          );
        } else {
          onApplySeriesScoringUpdate(nextSettings, seriesStandings);
        }
      } else if (savedToServer) {
        onUpdateClubSettings?.(nextSettings);
        onApplySeriesScoringUpdate(nextSettings, seriesStandings);
      } else {
        throw new Error('Logga in för att skapa en serie.');
      }

      setNewSeriesName('');
      setNewSeriesNotice({ ok: true, msg: `Serien "${seriesName}" har skapats.` });
    } catch (error) {
      setNewSeriesNotice({
        ok: false,
        msg: error instanceof Error ? error.message : 'Kunde inte skapa serien.',
      });
    } finally {
      setNewSeriesBusy(false);
    }
  };

  const handleRenameSeries = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingSeriesName) return;

    const previousName = editingSeriesName;
    const nextName = seriesNameDraft.trim();
    if (!nextName) {
      setRenameSeriesNotice({ ok: false, msg: 'Ange ett serienamn.' });
      return;
    }
    if (nextName.length > 80) {
      setRenameSeriesNotice({ ok: false, msg: 'Serienamnet får vara högst 80 tecken.' });
      return;
    }
    if (
      availableSeriesNames.some(
        (existingName) =>
          existingName.toLocaleLowerCase() === nextName.toLocaleLowerCase() &&
          existingName !== previousName
      )
    ) {
      setRenameSeriesNotice({ ok: false, msg: 'En serie med det namnet finns redan.' });
      return;
    }
    if (nextName === previousName) {
      setEditingSeriesName(null);
      setRenameSeriesNotice(null);
      return;
    }

    const oldSettings = clubSettings;
    const nextScoringSettings = { ...clubSettings.seriesScoringSettings };
    if (Object.prototype.hasOwnProperty.call(nextScoringSettings, previousName)) {
      nextScoringSettings[nextName] = nextScoringSettings[previousName];
      delete nextScoringSettings[previousName];
    }
    const nextSettings: ClubSettings = {
      ...clubSettings,
      seriesScoringSettings: nextScoringSettings,
    };
    const affectedCompetitions = competitionsList.filter(
      (event) => event.seriesName?.trim() === previousName
    );
    const changedCompetitions: CompetitionSummary[] = [];
    let serverSettingsSaved = false;
    let firestoreSettingsSaveAttempted = false;
    setRenamingSeries(true);
    setRenameSeriesNotice(null);

    try {
      for (const event of affectedCompetitions) {
        changedCompetitions.push(event);
        await onUpdateCompetitionMeta(event.id, { seriesName: nextName });
      }

      try {
        const response = await apiFetch('/api/club-settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(nextSettings),
        });
        if (response.ok) {
          serverSettingsSaved = true;
        } else if (response.status !== 404 && response.status !== 405) {
          const errorBody = (await response.json().catch(() => ({}))) as {
            error?: string;
          };
          throw new Error(errorBody.error ?? 'Kunde inte spara det nya serienamnet.');
        }
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
      }

      if (auth.currentUser) {
        firestoreSettingsSaveAttempted = true;
        await saveClubSettingsToFirestore(nextSettings, isSuperAdmin);
        const cloudSnapshot = await loadFullSeasonFromFirestore();
        if (cloudSnapshot) {
          onApplySeriesScoringUpdate(
            cloudSnapshot.clubSettings,
            cloudSnapshot.seriesStandings ?? []
          );
        } else {
          onApplySeriesScoringUpdate(nextSettings, seriesStandings);
        }
      } else if (serverSettingsSaved) {
        onUpdateClubSettings?.(nextSettings);
      } else {
        throw new Error('Logga in för att ändra en serie.');
      }

      try {
        const stateResponse = await apiFetch('/api/state');
        if (stateResponse.ok) {
          onApplyStateSnapshot((await stateResponse.json()) as MeosAppState);
        }
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
      }
      setSelectedSeriesName((selected) =>
        selected === previousName ? nextName : selected
      );
      setEditingSeriesName(null);
      setRenameSeriesNotice({
        ok: true,
        msg: `Serien har bytt namn till "${nextName}".`,
      });
    } catch (error) {
      const rollbackErrors: string[] = [];
      for (const event of changedCompetitions.reverse()) {
        try {
          await onUpdateCompetitionMeta(event.id, { seriesName: previousName });
        } catch (rollbackError) {
          rollbackErrors.push(
            rollbackError instanceof Error ? rollbackError.message : `Tävlingen ${event.name}`
          );
        }
      }

      if (serverSettingsSaved) {
        try {
          const response = await apiFetch('/api/club-settings', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(oldSettings),
          });
          if (!response.ok) {
            rollbackErrors.push('Kunde inte återställa serieinställningarna på servern.');
          }
        } catch (rollbackError) {
          rollbackErrors.push(
            rollbackError instanceof Error
              ? rollbackError.message
              : 'Kunde inte återställa serieinställningarna.'
          );
        }
      }
      if (firestoreSettingsSaveAttempted && auth.currentUser) {
        try {
          await saveClubSettingsToFirestore(oldSettings, isSuperAdmin);
        } catch (rollbackError) {
          rollbackErrors.push(
            rollbackError instanceof Error
              ? rollbackError.message
              : 'Kunde inte återställa serieinställningarna i Firestore.'
          );
        }
      }

      const message =
        error instanceof Error ? error.message : 'Kunde inte ändra seriens namn.';
      setRenameSeriesNotice({
        ok: false,
        msg:
          rollbackErrors.length > 0
            ? `${message} Återställningen lyckades inte helt: ${rollbackErrors.join('; ')}`
            : message,
      });
    } finally {
      setRenamingSeries(false);
    }
  };

  useEffect(() => {
    setSubTab(view === 'events' ? 'events' : 'admins');
  }, [view]);

  if (loading) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-14 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl" />
        <div className="h-72 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl" />
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6">
        <p className="text-sm font-medium text-red-700 dark:text-red-300">{loadError}</p>
        <button
          type="button"
          onClick={() => void loadManageData()}
          className="mt-3 px-4 py-2 text-xs font-medium text-white bg-slate-900 dark:bg-slate-100 dark:text-slate-900 rounded-lg whitespace-nowrap shrink-0"
        >
          Försök igen
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-3.5">
      {/* Top Header & Segmented Admin Navigation */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-2.5">
        <div>
          <h1 className="text-lg font-display font-bold text-slate-900 dark:text-slate-100">
            {view === 'events' ? 'Tävlingar och Serier' : 'Klubbadmin & Behörighet'}
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {view === 'events'
              ? 'Hantera tävlingar, serier, molnsynk och säkerhetskopior.'
              : 'Hantera administratörer, PIN-koder, klubbprofil, hyrbrickor och klubbserier.'}
          </p>
        </div>

        {view === 'events' && (
          <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-200/70 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg">
            <button
              type="button"
              onClick={() => setSubTab('events')}
              className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                subTab === 'events'
                  ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-sm'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              Tävlingar
            </button>
            <button
              type="button"
              onClick={() => setSubTab('series')}
              className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                subTab === 'series'
                  ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-sm'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              Serier
            </button>
          </div>
        )}

        {view === 'admin' && (
          <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-200/70 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg">
            <button
              type="button"
              onClick={() => setSubTab('admins')}
              className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                subTab === 'admins'
                  ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-sm'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              Admin & PIN ({admins.length})
            </button>
            <button
              type="button"
              onClick={() => setSubTab('club')}
              className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                subTab === 'club'
                  ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-sm'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              {anyEventHasFees ? 'Klubb, Utseende & Swish' : 'Klubbprofil & Utseende'}
            </button>
            <button
              type="button"
              onClick={() => setSubTab('rentals_series')}
              className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                subTab === 'rentals_series'
                  ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-sm'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              Hyrbrickor ({unreturnedRentalsCount})
            </button>
          </div>
        )}
      </div>

      {/* =====================================================================
          TAB 1: TÄVLINGAR, RADERING, MOLNLAGRING & SÄKERHETSKOPIA
         ===================================================================== */}
      {view === 'events' && subTab === 'events' && (
        <div className="space-y-3">
          <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden">
            <div className="px-4 py-2.5 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2.5">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <h2 className="text-sm font-display font-bold text-slate-900 dark:text-slate-100">
                  Säsongens tävlingar & träningar
                </h2>
                <span className="text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums">
                  {competitionsList.length} st
                </span>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {competitionsList.length > 0 &&
                  (confirmClearAll ? (
                    <div className="inline-flex items-center gap-1.5">
                      <button
                        type="button"
                        disabled={eventBusyId === 'CLEAR_ALL'}
                        onClick={() => void handleClearAllEvents()}
                        className="px-2.5 py-1.5 text-xs font-medium text-white bg-red-600 hover:bg-red-700 rounded-lg whitespace-nowrap shrink-0"
                      >
                        {eventBusyId === 'CLEAR_ALL' ? 'Rensar...' : 'Bekräfta radera alla'}
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmClearAll(false)}
                        className="px-2.5 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg whitespace-nowrap shrink-0"
                      >
                        Avbryt
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmClearAll(true)}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-red-700 dark:text-red-400 border border-red-200 dark:border-red-900/70 hover:bg-red-50 dark:hover:bg-red-950/40 rounded-lg transition-colors whitespace-nowrap shrink-0"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      <span>Rensa alla</span>
                    </button>
                  ))}

                <button
                  type="button"
                  onClick={onOpenCreateCompetition}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-red-600 hover:bg-red-700 rounded-lg transition-colors whitespace-nowrap shrink-0"
                >
                  <FolderPlus className="w-3.5 h-3.5" />
                  <span>Ny tävling</span>
                </button>
              </div>
            </div>

            {eventsNotice && (
              <div className="px-4 py-2 border-b border-slate-200 dark:border-slate-800">
                <div
                  className={`px-3 py-1.5 text-xs font-medium rounded-lg border ${
                    eventsNotice.ok
                      ? 'text-emerald-800 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-900'
                      : 'text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-950/40 border-red-200 dark:border-red-900'
                  }`}
                >
                  {eventsNotice.msg}
                </div>
              </div>
            )}

            {competitionsList.length === 0 ? (
              <div className="p-5 text-center space-y-3">
                <div className="space-y-0.5 max-w-md mx-auto">
                  <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                    Inga tävlingar i säsongen
                  </h3>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    Skapa klubbens första skarpa tävling eller läs in en sparad säsong från Firestore.
                  </p>
                </div>
                <div className="flex flex-wrap items-center justify-center gap-2">
                  <button
                    type="button"
                    onClick={onOpenCreateCompetition}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-red-600 hover:bg-red-700 rounded-lg whitespace-nowrap shrink-0"
                  >
                    <FolderPlus className="w-3.5 h-3.5" />
                    <span>Skapa första tävlingen</span>
                  </button>
                </div>
              </div>
            ) : (
              <div className="divide-y divide-slate-200/80 dark:divide-slate-800/80 text-xs">
                {competitionsList.map((ev) => {
                  const isActive = ev.id === activeEventId;
                  const isDeleting = confirmDeleteEventId === ev.id;
                  const isBusy = eventBusyId === ev.id;
                  return (
                    <div
                      key={ev.id}
                      className="px-3.5 py-2 hover:bg-slate-50/80 dark:hover:bg-slate-800/40 transition-colors flex flex-col xl:flex-row xl:items-center justify-between gap-2"
                    >
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 min-w-0">
                        <span className="font-semibold text-slate-900 dark:text-slate-100 truncate">
                          {ev.name}
                        </span>
                        <span className="text-slate-400" aria-hidden="true">
                          ·
                        </span>
                        <button
                          type="button"
                          onClick={() => onOpenPublicEvent(ev.shortCode)}
                          className="inline-flex items-center gap-1 text-[11px] font-medium text-slate-700 dark:text-slate-300 hover:underline whitespace-nowrap shrink-0"
                        >
                          <span>Publik vy</span>
                          <ExternalLink className="w-3 h-3" />
                        </button>
                        <span className="text-slate-400" aria-hidden="true">
                          ·
                        </span>
                        <span className="font-mono tabular-nums text-[11px] text-slate-600 dark:text-slate-300 whitespace-nowrap">
                          {ev.finishedCount}/{ev.competitorCount} i mål
                        </span>
                        <span className="text-slate-400" aria-hidden="true">
                          ·
                        </span>
                        <span
                          className={`font-semibold text-[11px] whitespace-nowrap ${
                            ev.status === 'LIVE'
                              ? 'text-emerald-700 dark:text-emerald-400'
                              : ev.status === 'UPCOMING'
                              ? 'text-amber-700 dark:text-amber-400'
                              : 'text-slate-500 dark:text-slate-400'
                          }`}
                        >
                          {ev.status === 'LIVE'
                            ? 'Pågår'
                            : ev.status === 'UPCOMING'
                            ? 'Kommande'
                            : 'Avslutad'}
                        </span>
                      </div>

                      <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                        <input
                          type="date"
                          value={ev.date}
                          disabled={isBusy}
                          onChange={(e) => {
                            if (e.target.value) {
                              void handleUpdateEventMeta(ev.id, { date: e.target.value });
                            }
                          }}
                          aria-label={`Datum för ${ev.name}`}
                          className="px-2 py-1 text-xs font-mono tabular-nums bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-md text-slate-900 dark:text-slate-100"
                        />

                        <input
                          type="text"
                          value={zeroDrafts[ev.id] ?? ev.zeroTimeStr}
                          disabled={isBusy}
                          title="Nolltid (HH:MM:SS) — styr när tävlingen övergår från Kommande till Pågår"
                          onChange={(e) =>
                            setZeroDrafts((prev) => ({ ...prev, [ev.id]: e.target.value }))
                          }
                          onBlur={() => {
                            const draft = (zeroDrafts[ev.id] ?? '').trim();
                            if (draft && draft !== ev.zeroTimeStr) {
                              void handleUpdateEventMeta(ev.id, { zeroTimeStr: draft });
                            }
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.currentTarget.blur();
                            }
                          }}
                          aria-label={`Nolltid för ${ev.name}`}
                          className="w-20 px-2 py-1 text-xs font-mono tabular-nums bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-md text-slate-900 dark:text-slate-100"
                        />

                        {ev.date === getStockholmTodayIso() && ev.status === 'LIVE' && (
                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() =>
                              void handleUpdateEventMeta(ev.id, { status: 'COMPLETED' })
                            }
                            title="Avsluta dagens tävling i förtid"
                            className="px-2 py-1 text-xs font-medium text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-md whitespace-nowrap shrink-0"
                          >
                            Avsluta
                          </button>
                        )}
                        {ev.date === getStockholmTodayIso() && ev.status === 'COMPLETED' && (
                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() =>
                              void handleUpdateEventMeta(ev.id, { status: 'LIVE' })
                            }
                            className="px-2 py-1 text-xs font-medium text-emerald-700 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-900/70 hover:bg-emerald-50 dark:hover:bg-emerald-950/40 rounded-md whitespace-nowrap shrink-0"
                          >
                            Återöppna
                          </button>
                        )}

                        <select
                          value={ev.seriesName || ''}
                          disabled={isBusy}
                          onChange={(e) => {
                            const seriesName = e.target.value;
                            void handleUpdateEventMeta(ev.id, { seriesName });
                          }}
                          aria-label={`Klubbserie för ${ev.name}`}
                          className="w-36 px-2 py-1 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-md text-slate-900 dark:text-slate-100"
                        >
                          <option value="">Ingen serie</option>
                          {availableSeriesNames.map((seriesName) => (
                            <option key={seriesName} value={seriesName}>
                              {seriesName}
                            </option>
                          ))}
                        </select>

                        <label
                          title="Aktivera avgiftsuppföljning för denna tävling"
                          className="inline-flex items-center gap-1.5 px-2 py-1 text-xs text-slate-700 dark:text-slate-300 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-md cursor-pointer select-none whitespace-nowrap"
                        >
                          <input
                            type="checkbox"
                            checked={Boolean(ev.enableFeesAndSwish)}
                            disabled={isBusy}
                            onChange={(e) =>
                              void handleUpdateEventMeta(ev.id, {
                                enableFeesAndSwish: e.target.checked,
                              })
                            }
                            className="w-3.5 h-3.5 rounded border-slate-300 text-red-600"
                          />
                          <span>Avgift</span>
                        </label>

                        {isDeleting ? (
                          <div className="inline-flex items-center gap-1">
                            <button
                              type="button"
                              disabled={isBusy}
                              onClick={() => void handleDeleteEvent(ev)}
                              className="px-2 py-1 text-xs font-medium text-white bg-red-600 hover:bg-red-700 rounded-md whitespace-nowrap shrink-0"
                            >
                              {isBusy ? 'Raderar...' : 'Bekräfta'}
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteEventId(null)}
                              className="px-2 py-1 text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-md whitespace-nowrap shrink-0"
                            >
                              Avbryt
                            </button>
                          </div>
                        ) : (
                          <div className="inline-flex items-center gap-1">
                            {isActive ? (
                              <span className="px-2 py-1 text-[11px] font-semibold text-emerald-700 dark:text-emerald-400 whitespace-nowrap">
                                Aktiv
                              </span>
                            ) : (
                              <button
                                type="button"
                                disabled={isBusy}
                                onClick={() => void handleActivateEvent(ev.id)}
                                className="px-2 py-1 text-xs font-medium text-slate-800 dark:text-slate-200 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-md whitespace-nowrap shrink-0"
                              >
                                Öppna
                              </button>
                            )}

                            <button
                              type="button"
                              disabled={isBusy}
                              onClick={() => void handleDuplicateEvent(ev)}
                              title="Skapa kopia med samma banor och klasser"
                              className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 rounded-md whitespace-nowrap shrink-0"
                            >
                              <Copy className="w-3 h-3" />
                              <span className="hidden sm:inline">Kopia</span>
                            </button>

                            <button
                              type="button"
                              disabled={isBusy}
                              onClick={() => setConfirmDeleteEventId(ev.id)}
                              title="Radera tävling"
                              className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 rounded-md whitespace-nowrap shrink-0"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                              <span className="hidden sm:inline">Radera</span>
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* Cloud Persistence + Local JSON Backup Split */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3.5 items-stretch">
            <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 flex flex-col justify-between gap-3">
              <div className="space-y-2.5">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-display font-bold text-slate-900 dark:text-slate-100">
                      Permanent molnlagring (Firestore)
                    </h3>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400">
                      Sparar tävlingar, banor, deltagare, SI-stämplingar och PIN-koder i ert Firebase-projekt.
                    </p>
                  </div>
                  <Cloud className="w-4 h-4 text-slate-400 shrink-0" />
                </div>

                {tokenServiceDisabled && (
                  <div className="px-3 py-2 text-xs text-amber-900 dark:text-amber-200 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900/80 rounded-lg space-y-1.5">
                    <p>
                      <span className="font-semibold">Token Service API</span> är inaktiverat i ert Google Cloud-projekt, vilket krävs för att förnya inloggning mot Firestore. Tävlingsservern och lokal backup (.json) fungerar som vanligt.
                    </p>
                    <a
                      href={TOKEN_SERVICE_ACTIVATION_URL}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 font-semibold underline hover:no-underline"
                    >
                      <span>Aktivera Token Service API i Google Cloud Console</span>
                      <ExternalLink className="w-3 h-3 shrink-0" />
                    </a>
                  </div>
                )}

                {cloudNotice && (
                  <div
                    className={`px-3 py-1.5 text-xs font-medium rounded-lg border ${
                      cloudNotice.ok
                        ? 'text-emerald-800 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-900'
                        : 'text-amber-800 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/40 border-amber-200 dark:border-amber-900'
                    }`}
                  >
                    {cloudNotice.msg}
                  </div>
                )}

                {cloudRecords.length > 0 ? (
                  <div className="divide-y divide-slate-200 dark:divide-slate-800 border border-slate-200 dark:border-slate-800 rounded-lg text-xs max-h-36 overflow-y-auto">
                    {cloudRecords.map((rec) => (
                      <div
                        key={rec.competitionId}
                        className="px-3 py-1.5 flex items-center justify-between gap-2"
                      >
                        <div className="min-w-0 truncate">
                          <span className="font-medium text-slate-900 dark:text-slate-100">
                            {rec.name}
                          </span>
                          <span className="font-mono tabular-nums text-[11px] text-slate-500 dark:text-slate-400 ml-1.5">
                            {rec.date}
                          </span>
                        </div>
                        <span className="font-mono tabular-nums text-[11px] text-slate-600 dark:text-slate-300 shrink-0">
                          {rec.finishedCount}/{rec.competitorCount} i mål
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="px-3 py-2 text-xs text-slate-500 dark:text-slate-400 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg">
                    {firebaseReadyUser
                      ? 'Inga tävlingar lagrade i Firestore just nu.'
                      : tokenServiceDisabled
                      ? 'Firestore-synk pausad tills Token Service API har aktiverats.'
                      : 'Anslut Google-konto för att aktivera automatisk Firestore-synk.'}
                  </div>
                )}
              </div>

              <div className="pt-2.5 border-t border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-end gap-2">
                {!firebaseReadyUser ? (
                  <button
                    type="button"
                    disabled={cloudBusy}
                    onClick={() => void handleConnectGoogleForCloud()}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-slate-900 hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white disabled:opacity-50 rounded-lg transition-colors whitespace-nowrap shrink-0"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${cloudBusy ? 'animate-spin' : ''}`} />
                    <span>{cloudBusy ? 'Kontrollerar...' : 'Anslut Google'}</span>
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      disabled={cloudBusy}
                      onClick={() => void handleHydrateFromCloudNow()}
                      className="px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50 rounded-lg transition-colors whitespace-nowrap shrink-0"
                    >
                      Läs in från Firestore
                    </button>
                    <button
                      type="button"
                      disabled={cloudBusy}
                      onClick={() => void handleSyncCloudNow()}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-slate-900 hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white disabled:opacity-50 rounded-lg transition-colors whitespace-nowrap shrink-0"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${cloudBusy ? 'animate-spin' : ''}`} />
                      <span>{cloudBusy ? 'Arbetar...' : 'Synka till Firestore'}</span>
                    </button>
                  </>
                )}
              </div>
            </section>

            <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 flex flex-col justify-between gap-3">
              <div className="space-y-2.5">
                <div>
                  <h3 className="text-sm font-display font-bold text-slate-900 dark:text-slate-100">
                    Lokal säkerhetskopia (.json) & Demodata
                  </h3>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400">
                    Spara lokal backup av alla tävlingar och löpardatabas eller läs in fil på ny dator.
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2 pt-0.5">
                  <button
                    type="button"
                    disabled={backupBusy}
                    onClick={() => void handleDownloadBackup()}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-800 dark:text-slate-200 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg transition-colors whitespace-nowrap shrink-0"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>Ladda ner .json</span>
                  </button>

                  <label className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 rounded-lg cursor-pointer transition-colors whitespace-nowrap shrink-0">
                    <Upload className="w-3.5 h-3.5" />
                    <span>Återställ .json</span>
                    <input
                      type="file"
                      accept=".json,application/json"
                      onChange={handleRestoreBackupFile}
                      className="hidden"
                    />
                  </label>
                </div>
              </div>
            </section>
          </div>
        </div>
      )}

      {/* =====================================================================
          TAB 2: GOOGLE-ADMINISTRATÖRER, PIN-KODER & OFFLINE RESERVKOD
         ===================================================================== */}
      {subTab === 'admins' && (
        <div className="space-y-3.5">
          <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
            <div className="px-4 py-2.5 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-sm font-display font-bold text-slate-900 dark:text-slate-100">
                Administratörer & Tävlingsledare (Google-inloggning)
              </h2>
              <span className="text-xs font-mono tabular-nums text-slate-500 dark:text-slate-400">
                {admins.length} konton/inbjudningar
              </span>
            </div>

            <div className="p-4 space-y-3">
              {adminNotice && (
                <div
                  className={`px-3 py-1.5 text-xs font-medium rounded-lg border ${
                    adminNotice.ok
                      ? 'text-emerald-800 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-900'
                      : 'text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-950/40 border-red-200 dark:border-red-900'
                  }`}
                >
                  {adminNotice.msg}
                </div>
              )}

              <div className="divide-y divide-slate-200 dark:divide-slate-800 border border-slate-200 dark:border-slate-800 rounded-lg text-xs">
                {admins.map((adm) => {
                  const isConfirming = confirmRemoveEmail === adm.email;
                  return (
                    <div
                      key={adm.email}
                      className="px-3.5 py-2 hover:bg-slate-50/80 dark:hover:bg-slate-800/40 flex flex-wrap items-center justify-between gap-2"
                    >
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 min-w-0">
                        <ShieldCheck className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                        <span className="font-semibold text-slate-900 dark:text-slate-100">
                          {adm.displayName}
                        </span>
                        <span className="text-slate-400" aria-hidden="true">
                          ·
                        </span>
                        <span className="font-mono text-[11px] text-slate-600 dark:text-slate-300 break-all sm:break-normal">
                          {adm.email}
                        </span>
                        {adm.isPendingInvite && (
                          <span className="text-[10px] text-amber-700 dark:text-amber-300">
                            Inbjuden · väntar på första inloggning
                          </span>
                        )}
                      </div>

                      <div className="flex flex-wrap items-center gap-2 shrink-0">
                        {adm.isBootstrapOwner ? (
                          <span className="text-[11px] text-slate-500 dark:text-slate-400">
                            Huvudadmin · Låst grundkonto
                          </span>
                        ) : (
                          <>
                            {isSuperAdmin ? (
                              <select
                                value={adm.role}
                                disabled={adminBusy}
                                onChange={(e) =>
                                  void handleChangeAdminRole(adm, e.target.value as ClubAdminTier)
                                }
                                aria-label={`Behörighet för ${adm.email}`}
                                className="px-2 py-1 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-md text-slate-900 dark:text-slate-100"
                              >
                                <option value="RACE_ADMIN">Tävlingsledare</option>
                                <option value="SUPER_ADMIN">Huvudadmin</option>
                              </select>
                            ) : (
                              <span className="text-slate-600 dark:text-slate-400">
                                {adm.role === 'SUPER_ADMIN' ? 'Huvudadmin' : 'Tävlingsledare'}
                              </span>
                            )}

                            {isConfirming ? (
                              <div className="inline-flex items-center gap-1">
                                <button
                                  type="button"
                                  disabled={adminBusy}
                                  onClick={() => void handleRemoveAdmin(adm.email)}
                                  className="px-2 py-1 text-xs font-medium text-white bg-red-600 hover:bg-red-700 rounded-md whitespace-nowrap shrink-0"
                                >
                                  Bekräfta
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setConfirmRemoveEmail(null)}
                                  className="px-2 py-1 text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-md whitespace-nowrap shrink-0"
                                >
                                  Avbryt
                                </button>
                              </div>
                            ) : (
                              <button
                                type="button"
                                onClick={() => setConfirmRemoveEmail(adm.email)}
                                className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 rounded-md whitespace-nowrap shrink-0"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                                <span>Ta bort</span>
                              </button>
                            )}
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              <form
                onSubmit={handleAddAdmin}
                className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-12 gap-2.5 items-end pt-1"
              >
                <div className="lg:col-span-4">
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                    Google e-postadress
                  </label>
                  <input
                    type="email"
                    required
                    value={newAdminEmail}
                    onChange={(e) => setNewAdminEmail(e.target.value)}
                    placeholder="namn@gmail.com"
                    className="w-full px-3 py-1.5 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-100"
                  />
                </div>
                <div className="lg:col-span-3">
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                    Namn
                  </label>
                  <input
                    type="text"
                    value={newAdminName}
                    onChange={(e) => setNewAdminName(e.target.value)}
                    placeholder="t.ex. Anna Lindström"
                    className="w-full px-3 py-1.5 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-100"
                  />
                </div>
                <div className="lg:col-span-2">
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                    Roll
                  </label>
                  <select
                    value={isSuperAdmin ? newAdminRole : 'RACE_ADMIN'}
                    disabled={!isSuperAdmin}
                    onChange={(e) => setNewAdminRole(e.target.value as ClubAdminTier)}
                    className="w-full px-2.5 py-1.5 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-100 disabled:opacity-60"
                  >
                    <option value="RACE_ADMIN">Tävlingsledare</option>
                    {isSuperAdmin && <option value="SUPER_ADMIN">Huvudadmin</option>}
                  </select>
                </div>
                <div className="lg:col-span-3">
                  <button
                    type="submit"
                    disabled={adminBusy || !newAdminEmail.trim()}
                    className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-slate-900 hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white disabled:opacity-50 rounded-lg transition-colors whitespace-nowrap shrink-0"
                  >
                    <UserPlus className="w-3.5 h-3.5" />
                    <span>Lägg till admin</span>
                  </button>
                </div>
              </form>
            </div>
          </section>

          {/* 4-Digit Official PINs per Role */}
          <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
            <div className="px-4 py-2.5 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2.5">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 min-w-0">
                <h2 className="text-sm font-display font-bold text-slate-900 dark:text-slate-100 truncate">
                  Funktionärernas 4-siffriga PIN-koder
                  {activeEventId ? ` — ${competitionName}` : ''}
                </h2>
                <span className="text-xs text-slate-500 dark:text-slate-400">
                  {activeEventId
                    ? pinsCustomized
                      ? 'Anpassade koder'
                      : 'Standardkoder'
                    : 'Ingen tävling vald'}
                </span>
              </div>

              {activeEventId && (
                <button
                  type="button"
                  onClick={() => {
                    setRolePins(generateUniqueRandomPins());
                    setPinsNotice(null);
                  }}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-800 dark:text-slate-200 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg transition-colors whitespace-nowrap shrink-0"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  <span>Slumpa alla 4</span>
                </button>
              )}
            </div>

            {!activeEventId ? (
              <div className="p-4 text-xs text-slate-500 dark:text-slate-400">
                Skapa eller välj en aktiv tävling under Tävlingar för att ställa in PIN-koder.
              </div>
            ) : (
              <form onSubmit={handleSavePins} className="p-4 space-y-3">
                {pinsNotice && (
                  <div
                    className={`px-3 py-1.5 text-xs font-medium rounded-lg border ${
                      pinsNotice.ok
                        ? 'text-emerald-800 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-900'
                        : 'text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-950/40 border-red-200 dark:border-red-900'
                    }`}
                  >
                    {pinsNotice.msg}
                  </div>
                )}

                <div className="divide-y divide-slate-200 dark:divide-slate-800 border border-slate-200 dark:border-slate-800 rounded-lg">
                  {PIN_ROLE_META.map((item) => (
                    <div
                      key={item.role}
                      className="px-3.5 py-2 flex flex-col sm:flex-row sm:items-center justify-between gap-2"
                    >
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-baseline gap-x-2">
                          <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-900 dark:text-slate-100">
                            <KeyRound className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                            <span>{item.title}</span>
                          </span>
                          <span className="text-[11px] text-slate-500 dark:text-slate-400">
                            {item.allowedViews}
                          </span>
                        </div>
                      </div>

                      <div className="flex items-center gap-1.5 shrink-0">
                        <input
                          type="text"
                          inputMode="numeric"
                          maxLength={6}
                          value={rolePins[item.role]}
                          onChange={(e) => {
                            const clean = e.target.value.replace(/\D/g, '').slice(0, 6);
                            setRolePins((prev) => ({ ...prev, [item.role]: clean }));
                            setPinsNotice(null);
                          }}
                          aria-label={`PIN-kod för ${item.title}`}
                          className="w-24 px-2 py-1 text-center text-sm font-mono tabular-nums font-bold tracking-widest bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-100"
                        />
                        <button
                          type="button"
                          onClick={() => handleRandomizeSingleRole(item.role)}
                          className="px-2.5 py-1 text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg transition-colors whitespace-nowrap shrink-0"
                        >
                          Slumpa
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleCopyPin(item.role, item.title)}
                          className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg transition-colors whitespace-nowrap shrink-0"
                        >
                          {copiedRole === item.role ? (
                            <>
                              <Check className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                              <span>Kopierad</span>
                            </>
                          ) : (
                            <>
                              <Copy className="w-3.5 h-3.5" />
                              <span>Kopiera</span>
                            </>
                          )}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    PIN-kod låser enheten till denna tävling och döljer adminvyer.
                  </p>
                  <button
                    type="submit"
                    disabled={pinsBusy}
                    className="px-3.5 py-1.5 text-xs font-medium text-white bg-red-600 hover:bg-red-700 disabled:opacity-50 rounded-lg transition-colors whitespace-nowrap shrink-0"
                  >
                    {pinsBusy ? 'Sparar...' : 'Spara PIN-koder'}
                  </button>
                </div>
              </form>
            )}
          </section>

          {/* Offline Emergency Backup Code */}
          <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
            <form onSubmit={handleSaveOfflineSettings} className="space-y-2.5 max-w-2xl">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-sm font-display font-bold text-slate-900 dark:text-slate-100">
                    Offline reservkod för tävlingsledare
                  </h3>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400">
                    {offlineCustomized ? 'Egen reservkod satt' : 'Standardkod aktiv'} · Låser upp adminläge utan internet i skogen.
                  </p>
                </div>
                <WifiOff className="w-4 h-4 text-slate-400 shrink-0" />
              </div>

              {offlineNotice && (
                <div
                  className={`px-3 py-1.5 text-xs font-medium rounded-lg border ${
                    offlineNotice.ok
                      ? 'text-emerald-800 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-900'
                      : 'text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-950/40 border-red-200 dark:border-red-900'
                  }`}
                >
                  {offlineNotice.msg}
                </div>
              )}

              <label className="flex items-center gap-2 text-xs font-medium text-slate-800 dark:text-slate-200 cursor-pointer">
                <input
                  type="checkbox"
                  checked={offlineEnabled}
                  onChange={(e) => setOfflineEnabled(e.target.checked)}
                  className="rounded border-slate-300 dark:border-slate-700"
                />
                <span>Tillåt inloggning med offline reservkod</span>
              </label>

              <div className="flex flex-col sm:flex-row items-stretch sm:items-end gap-2">
                <div className="flex-1 min-w-0">
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                    Ny offline reservkod (minst 6 tecken)
                  </label>
                  <input
                    type="password"
                    value={newOfflineCode}
                    onChange={(e) => setNewOfflineCode(e.target.value)}
                    disabled={!offlineEnabled}
                    placeholder="Lämna tomt för att behålla nuvarande"
                    className="w-full px-3 py-1.5 text-xs font-mono bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-100 disabled:opacity-50"
                  />
                </div>
                <button
                  type="submit"
                  disabled={offlineBusy}
                  className="px-3.5 py-1.5 text-xs font-medium text-white bg-slate-900 hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white disabled:opacity-50 rounded-lg transition-colors whitespace-nowrap shrink-0"
                >
                  {offlineBusy ? 'Sparar...' : 'Spara offline-kod'}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}

      {/* =====================================================================
          TAB 3: KLUBBPROFIL, LOGOTYP, GRUNDUTSEENDE & SWISH
         ===================================================================== */}
      {subTab === 'club' && (
        <form onSubmit={handleSaveClubSettings} className="space-y-3.5">
          {clubNotice && (
            <div
              className={`px-3 py-2 text-xs font-medium rounded-lg border ${
                clubNotice.ok
                  ? 'text-emerald-800 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-900'
                  : 'text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-950/40 border-red-200 dark:border-red-900'
              }`}
            >
              {clubNotice.msg}
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-3.5 items-stretch">
            {/* Left Column: Club Identity & Color Appearance */}
            <section className="lg:col-span-7 min-w-0 club-surface bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 space-y-3.5">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h2 className="text-sm font-display font-bold text-slate-900 dark:text-slate-100">
                    Klubbprofil & Grundutseende
                  </h2>
                  <p className="text-[11px] club-muted text-slate-500 dark:text-slate-400">
                    Styr klubbens namn (gäller hela appen), sidrubrik samt bakgrunds-, text- och accentfärger.
                  </p>
                </div>
                <Palette className="w-4 h-4 text-slate-400 shrink-0 mt-0.5" />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                    Klubbens namn
                  </label>
                  <input
                    type="text"
                    required
                    value={clubForm.clubName}
                    onChange={(e) => setClubForm((p) => ({ ...p, clubName: e.target.value }))}
                    className="w-full px-2.5 py-1.5 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-100"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                    Appens namn (visas till höger om loggan i toppmenyn)
                  </label>
                  <input
                    type="text"
                    maxLength={80}
                    value={clubForm.portalTitle ?? ''}
                    onChange={(e) => setClubForm((p) => ({ ...p, portalTitle: e.target.value }))}
                    placeholder="t.ex. PasserSI eller OK Österåker"
                    className="w-full px-2.5 py-1.5 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-100"
                  />
                  <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">
                    Byter ut namnet som visas bredvid loggan högst upp till vänster i både sekretariatet och den publika vyn.
                  </p>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                    Eventor Org-ID (valfritt)
                  </label>
                  <input
                    type="text"
                    value={clubForm.eventorOrgId}
                    onChange={(e) => setClubForm((p) => ({ ...p, eventorOrgId: e.target.value }))}
                    placeholder="t.ex. 258"
                    className="w-full px-2.5 py-1.5 text-xs font-mono tabular-nums bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-100"
                  />
                </div>
              </div>

              <div className="pt-2.5 border-t border-slate-200 dark:border-slate-800 space-y-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-slate-800 dark:text-slate-200">
                    Färgtema (förvalda klubbpaletter eller egna färger)
                  </span>
                  <button
                    type="button"
                    onClick={handleResetAppearance}
                    className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-slate-100 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-md transition-colors whitespace-nowrap shrink-0"
                  >
                    <RotateCcw className="w-3 h-3 shrink-0" />
                    <span>Återställ standard</span>
                  </button>
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  {CLUB_COLOR_PRESETS.map((preset) => {
                    const isSelected =
                      (clubForm.customBgColor || '') === preset.bgColor &&
                      (clubForm.customTextColor || '') === preset.textColor &&
                      (clubForm.customAccentColor || '') === preset.accentColor;
                    return (
                      <button
                        key={preset.id}
                        type="button"
                        onClick={() =>
                          setClubForm((p) => ({
                            ...p,
                            customBgColor: preset.bgColor,
                            customTextColor: preset.textColor,
                            customAccentColor: preset.accentColor,
                          }))
                        }
                        className={`px-2.5 py-1 text-[11px] font-medium rounded-md border transition-colors whitespace-nowrap shrink-0 ${
                          isSelected
                            ? 'bg-slate-900 text-white border-slate-900 dark:bg-slate-100 dark:text-slate-900 dark:border-slate-100'
                            : 'bg-slate-50 dark:bg-slate-950 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:border-slate-400'
                        }`}
                      >
                        {preset.label}
                      </button>
                    );
                  })}
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                  <div>
                    <label className="block text-[11px] font-medium text-slate-700 dark:text-slate-300 mb-1">
                      Bakgrundsfärg (ljust läge)
                    </label>
                    <div className="flex items-center gap-1.5 min-w-0">
                      <input
                        type="color"
                        value={
                          /^#[0-9a-fA-F]{6}$/.test(clubForm.customBgColor || '')
                            ? clubForm.customBgColor!
                            : '#f8fafc'
                        }
                        onChange={(e) =>
                          setClubForm((p) => ({ ...p, customBgColor: e.target.value }))
                        }
                        className="h-8 w-9 p-0.5 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded cursor-pointer shrink-0"
                        aria-label="Välj bakgrundsfärg"
                      />
                      <input
                        type="text"
                        maxLength={7}
                        value={clubForm.customBgColor ?? ''}
                        onChange={(e) =>
                          setClubForm((p) => ({ ...p, customBgColor: e.target.value }))
                        }
                        placeholder="#f8fafc"
                        className="min-w-0 flex-1 px-2 py-1.5 text-xs font-mono border border-slate-300 dark:border-slate-700 rounded-lg"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-[11px] font-medium text-slate-700 dark:text-slate-300 mb-1">
                      Textfärg (ljust läge)
                    </label>
                    <div className="flex items-center gap-1.5 min-w-0">
                      <input
                        type="color"
                        value={
                          /^#[0-9a-fA-F]{6}$/.test(clubForm.customTextColor || '')
                            ? clubForm.customTextColor!
                            : '#0f172a'
                        }
                        onChange={(e) =>
                          setClubForm((p) => ({ ...p, customTextColor: e.target.value }))
                        }
                        className="h-8 w-9 p-0.5 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded cursor-pointer shrink-0"
                        aria-label="Välj textfärg"
                      />
                      <input
                        type="text"
                        maxLength={7}
                        value={clubForm.customTextColor ?? ''}
                        onChange={(e) =>
                          setClubForm((p) => ({ ...p, customTextColor: e.target.value }))
                        }
                        placeholder="#0f172a"
                        className="min-w-0 flex-1 px-2 py-1.5 text-xs font-mono border border-slate-300 dark:border-slate-700 rounded-lg"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-[11px] font-medium text-slate-700 dark:text-slate-300 mb-1">
                      Accentfärg (knappar & flikar)
                    </label>
                    <div className="flex items-center gap-1.5 min-w-0">
                      <input
                        type="color"
                        value={
                          /^#[0-9a-fA-F]{6}$/.test(clubForm.customAccentColor || '')
                            ? clubForm.customAccentColor!
                            : '#dc2626'
                        }
                        onChange={(e) =>
                          setClubForm((p) => ({ ...p, customAccentColor: e.target.value }))
                        }
                        className="h-8 w-9 p-0.5 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded cursor-pointer shrink-0"
                        aria-label="Välj accentfärg"
                      />
                      <input
                        type="text"
                        maxLength={7}
                        value={clubForm.customAccentColor ?? ''}
                        onChange={(e) =>
                          setClubForm((p) => ({ ...p, customAccentColor: e.target.value }))
                        }
                        placeholder="#dc2626"
                        className="min-w-0 flex-1 px-2 py-1.5 text-xs font-mono border border-slate-300 dark:border-slate-700 rounded-lg"
                      />
                    </div>
                  </div>
                </div>
              </div>
            </section>

            {/* Right Column: Club Logo Upload (JPG / PNG) & Header Preview */}
            <section className="lg:col-span-5 min-w-0 club-surface bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 flex flex-col justify-between space-y-3">
              <div className="space-y-3">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <h3 className="text-sm font-display font-bold text-slate-900 dark:text-slate-100">
                      Klubblogga (JPG eller PNG)
                    </h3>
                    <p className="text-[11px] club-muted text-slate-500 dark:text-slate-400">
                      Visas i sidhuvudet på publiksidan, inloggningen och sekretariatet.
                    </p>
                  </div>
                  <ImagePlus className="w-4 h-4 text-slate-400 shrink-0 mt-0.5" />
                </div>

                {/* Live Header Brand Preview */}
                <div className="p-3 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl space-y-1.5">
                  <div className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
                    Förhandsvisning av sidhuvud
                  </div>
                  <div className="min-h-11 px-3 py-2 club-surface bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg flex items-center gap-2.5 min-w-0">
                    {clubForm.logoDataUrl && !logoPreviewBroken ? (
                      <img
                        src={clubForm.logoDataUrl}
                        alt={`${clubForm.clubName || 'Klubb'} logotyp`}
                        referrerPolicy="no-referrer"
                        onError={() => setLogoPreviewBroken(true)}
                        className="h-8 w-auto max-w-[130px] object-contain shrink-0"
                      />
                    ) : null}
                    <div className="min-w-0">
                      <div className="text-sm font-display font-bold truncate">
                        {clubForm.portalTitle?.trim() || 'PasserSI Live'}
                      </div>
                      <div className="text-[11px] club-muted text-slate-500 dark:text-slate-400 truncate">
                        {clubForm.clubName || 'Klubbnamn'} — Tävlingar & Träningar
                      </div>
                    </div>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <label className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-900 dark:text-slate-100 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 border border-slate-300 dark:border-slate-700 rounded-lg cursor-pointer transition-colors whitespace-nowrap shrink-0">
                    <Upload className="w-3.5 h-3.5 shrink-0" />
                    <span>{logoBusy ? 'Läser bild...' : 'Välj logotyp (JPG / PNG)'}</span>
                    <input
                      type="file"
                      accept="image/png,image/jpeg,.png,.jpg,.jpeg"
                      onChange={(e) => void handleLogoFileChange(e)}
                      disabled={logoBusy}
                      className="sr-only"
                    />
                  </label>

                  {clubForm.logoDataUrl && (
                    <button
                      type="button"
                      onClick={() => {
                        setLogoPreviewBroken(false);
                        setClubForm((p) => ({ ...p, logoDataUrl: '' }));
                      }}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/40 border border-red-200 dark:border-red-900/60 rounded-lg transition-colors whitespace-nowrap shrink-0"
                    >
                      <Trash2 className="w-3.5 h-3.5 shrink-0" />
                      <span>Ta bort logga</span>
                    </button>
                  )}
                </div>

                <p className="text-[11px] club-muted text-slate-500 dark:text-slate-400">
                  PNG med transparent bakgrund eller JPG rekommenderas. Skalas automatiskt till
                  optimal storlek.
                </p>
              </div>

              <div className="pt-2.5 border-t border-slate-200 dark:border-slate-800 flex items-center justify-end">
                <button
                  type="submit"
                  disabled={clubBusy || logoBusy}
                  className="px-4 py-1.5 text-xs font-semibold club-accent-btn disabled:opacity-50 rounded-lg transition-colors whitespace-nowrap shrink-0"
                >
                  {clubBusy ? 'Sparar...' : 'Spara klubbprofil & utseende'}
                </button>
              </div>
            </section>
          </div>

          {/* Optional fee settings and payment status */}
          {anyEventHasFees && (
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-3.5 items-stretch">
              <section className="lg:col-span-12 min-w-0 club-surface bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 space-y-3">
                <div>
                  <h3 className="text-sm font-display font-bold text-slate-900 dark:text-slate-100">
                    Swish-betalning & Hyrbricksavgifter
                  </h3>
                  <p className="text-[11px] club-muted text-slate-500 dark:text-slate-400">
                    Används för avgiftsuppföljning vid sekretariatets direktanmälan.
                  </p>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  <div>
                    <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                      Swish-nummer
                    </label>
                    <input
                      type="text"
                      value={clubForm.swishNumber}
                      onChange={(e) => setClubForm((p) => ({ ...p, swishNumber: e.target.value }))}
                      placeholder="t.ex. 123 481 92 04"
                      className="w-full px-3 py-1.5 text-xs font-mono tabular-nums bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-100"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                      Swish-mottagare
                    </label>
                    <input
                      type="text"
                      value={clubForm.swishRecipientName}
                      onChange={(e) =>
                        setClubForm((p) => ({ ...p, swishRecipientName: e.target.value }))
                      }
                      placeholder="t.ex. OK Österåker Tävlingskassa"
                      className="w-full px-3 py-1.5 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-100"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                  <div>
                    <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                      Startavgift (kr)
                    </label>
                    <input
                      type="number"
                      min={0}
                      max={10000}
                      value={clubForm.defaultDirectEntryFeeSek}
                      onChange={(e) =>
                        setClubForm((p) => ({
                          ...p,
                          defaultDirectEntryFeeSek: Number(e.target.value) || 0,
                        }))
                      }
                      className="w-full px-3 py-1.5 text-xs font-mono tabular-nums bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-100"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                      Hyrbricka (kr)
                    </label>
                    <input
                      type="number"
                      min={0}
                      max={5000}
                      value={clubForm.rentalCardFeeSek}
                      onChange={(e) =>
                        setClubForm((p) => ({
                          ...p,
                          rentalCardFeeSek: Number(e.target.value) || 0,
                        }))
                      }
                      className="w-full px-3 py-1.5 text-xs font-mono tabular-nums bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-100"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                      Saknad bricka (kr)
                    </label>
                    <input
                      type="number"
                      min={0}
                      max={20000}
                      value={clubForm.missingRentalFeeSek}
                      onChange={(e) =>
                        setClubForm((p) => ({
                          ...p,
                          missingRentalFeeSek: Number(e.target.value) || 0,
                        }))
                      }
                      className="w-full px-3 py-1.5 text-xs font-mono tabular-nums bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-100"
                    />
                  </div>
                </div>
              </section>

              <section className="lg:col-span-12 min-w-0 club-surface bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 flex flex-col justify-between space-y-3">
                {enableFeesAndSwish && (
                  <div className="pt-2.5 border-t border-slate-200 dark:border-slate-800 space-y-1 text-xs">
                    <div className="font-semibold text-slate-900 dark:text-slate-100 truncate">
                      Betalningsstatus ({competitionName})
                    </div>
                    <div className="flex items-center justify-between text-slate-600 dark:text-slate-400">
                      <span>Betalda</span>
                      <span className="font-mono tabular-nums font-medium text-emerald-700 dark:text-emerald-400">
                        {activePaymentSummary.paidCount} st · {activePaymentSummary.totalPaidSek} kr
                      </span>
                    </div>
                    <div className="flex items-center justify-between text-slate-600 dark:text-slate-400">
                      <span>Obetalda</span>
                      <span className="font-mono tabular-nums font-medium text-amber-700 dark:text-amber-400">
                        {activePaymentSummary.unpaidCount} st ·{' '}
                        {activePaymentSummary.totalOutstandingSek} kr
                      </span>
                    </div>
                  </div>
                )}
              </section>
            </div>
          )}
        </form>
      )}

      {/* =====================================================================
          TAB 4: UTLÅNADE HYRBRICKOR & SERIER
         ===================================================================== */}
      {(subTab === 'rentals_series' || subTab === 'series') && (
        <div className="space-y-3.5">
          {subTab === 'series' && (
          <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-3.5">
            <div className="mb-2">
              <h2 className="text-sm font-display font-bold text-slate-900 dark:text-slate-100">
                Serier
              </h2>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                Skapa en serie här. Därefter kan du välja den vid skapande eller redigering av tävlingar.
              </p>
            </div>
            <form
              onSubmit={handleCreateSeries}
              className="flex flex-col sm:flex-row sm:items-end gap-2"
            >
              <label className="flex-1 text-[11px] font-medium text-slate-700 dark:text-slate-300">
                Nytt serienamn
                <input
                  type="text"
                  value={newSeriesName}
                  maxLength={80}
                  onChange={(event) => setNewSeriesName(event.target.value)}
                  placeholder="t.ex. Höstserien 2026"
                  className="mt-1 w-full px-2.5 py-1.5 text-xs bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-lg"
                />
              </label>
              <button
                type="submit"
                disabled={newSeriesBusy}
                className="px-3 py-1.5 text-xs font-semibold club-accent-btn disabled:opacity-50 rounded-lg whitespace-nowrap"
              >
                {newSeriesBusy ? 'Skapar...' : 'Skapa serie'}
              </button>
            </form>
            {newSeriesNotice && (
              <p
                role="status"
                className={`mt-2 text-xs ${
                  newSeriesNotice.ok
                    ? 'text-emerald-700 dark:text-emerald-400'
                    : 'text-red-700 dark:text-red-400'
                }`}
              >
                {newSeriesNotice.msg}
              </p>
            )}
            {renameSeriesNotice && (
              <p
                role="status"
                className={`mt-2 text-xs ${
                  renameSeriesNotice.ok
                    ? 'text-emerald-700 dark:text-emerald-400'
                    : 'text-red-700 dark:text-red-400'
                }`}
              >
                {renameSeriesNotice.msg}
              </p>
            )}
            {availableSeriesNames.length > 0 && (
              <ul className="mt-3 divide-y divide-slate-200 dark:divide-slate-800 border-y border-slate-200 dark:border-slate-800">
                {availableSeriesNames.map((seriesName) => {
                  const linkedCompetitions = competitionsList.filter(
                    (event) => event.seriesName?.trim() === seriesName
                  ).length;
                  const isEditing = editingSeriesName === seriesName;
                  return (
                    <li
                      key={seriesName}
                      className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 py-2"
                    >
                      {isEditing ? (
                        <form
                          onSubmit={handleRenameSeries}
                          className="flex flex-1 flex-col sm:flex-row sm:items-center gap-2"
                        >
                          <label className="flex-1 text-[11px] font-medium text-slate-700 dark:text-slate-300">
                            Nytt namn för {seriesName}
                            <input
                              autoFocus
                              type="text"
                              value={seriesNameDraft}
                              maxLength={80}
                              onChange={(event) => setSeriesNameDraft(event.target.value)}
                              className="mt-1 w-full px-2.5 py-1.5 text-xs bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-lg"
                            />
                          </label>
                          <div className="flex items-center gap-1.5">
                            <button
                              type="submit"
                              disabled={renamingSeries}
                              className="px-3 py-1.5 text-xs font-semibold club-accent-btn disabled:opacity-50 rounded-lg whitespace-nowrap"
                            >
                              {renamingSeries ? 'Sparar...' : 'Spara namn'}
                            </button>
                            <button
                              type="button"
                              disabled={renamingSeries}
                              onClick={() => {
                                setEditingSeriesName(null);
                                setRenameSeriesNotice(null);
                              }}
                              className="px-3 py-1.5 text-xs font-medium text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700 rounded-lg whitespace-nowrap disabled:opacity-50"
                            >
                              Avbryt
                            </button>
                          </div>
                        </form>
                      ) : (
                        <>
                          <div className="min-w-0">
                            <span className="text-xs font-medium text-slate-900 dark:text-slate-100">
                              {seriesName}
                            </span>
                            <span className="ml-2 text-[11px] text-slate-500 dark:text-slate-400">
                              {linkedCompetitions} tävlingar
                            </span>
                          </div>
                          <button
                            type="button"
                            disabled={renamingSeries}
                            onClick={() => {
                              setEditingSeriesName(seriesName);
                              setSeriesNameDraft(seriesName);
                              setRenameSeriesNotice(null);
                            }}
                            className="self-start sm:self-auto px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 rounded-lg whitespace-nowrap disabled:opacity-50"
                          >
                            Ändra
                          </button>
                        </>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
          )}

          {/* Rental SI-Card Follow-Up Across Entire Season */}
          {subTab === 'rentals_series' && (
          <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2.5">
              <div className="min-w-0">
                <h2 className="text-sm font-display font-bold text-slate-900 dark:text-slate-100">
                  Utlånade SI-hyrbrickor ({unreturnedRentalsCount} ej återlämnade)
                </h2>
                <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-400">
                  <span>Säsongsuppföljning</span>
                  {anyEventHasFees && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span className="font-mono tabular-nums">
                        Ersättningsavgift {clubSettings.missingRentalFeeSek} kr
                      </span>
                    </>
                  )}
                </div>
              </div>

              <div className="inline-flex items-center gap-1 p-0.5 bg-slate-100 dark:bg-slate-800 rounded-lg">
                <button
                  type="button"
                  onClick={() => setRentalFilter('UNRETURNED')}
                  className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                    rentalFilter === 'UNRETURNED'
                      ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm'
                      : 'text-slate-600 dark:text-slate-400'
                  }`}
                >
                  Ej återlämnade ({unreturnedRentalsCount})
                </button>
                <button
                  type="button"
                  onClick={() => setRentalFilter('ALL')}
                  className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                    rentalFilter === 'ALL'
                      ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm'
                      : 'text-slate-600 dark:text-slate-400'
                  }`}
                >
                  Alla ({rentals.length})
                </button>
              </div>
            </div>

            {visibleRentals.length === 0 ? (
              <div className="px-4 py-3 text-xs text-slate-500 dark:text-slate-400">
                {rentalFilter === 'UNRETURNED'
                  ? 'Alla utlånade hyrbrickor är inlämnade och avprickade.'
                  : 'Inga deltagare med hyrbricka registrerade i säsongens tävlingar ännu.'}
              </div>
            ) : (
              <div className="divide-y divide-slate-200/80 dark:divide-slate-800/80">
                {visibleRentals.map((r) => {
                  const key = `${r.eventId}:${r.competitorId}`;
                  const busy = rentalBusyKey === key;
                  return (
                    <div
                      key={key}
                      className="px-3.5 py-2 flex flex-col sm:flex-row sm:items-center justify-between gap-2 hover:bg-slate-50/80 dark:hover:bg-slate-800/40 transition-colors text-xs"
                    >
                      <div className="min-w-0 flex flex-wrap items-center gap-x-2 gap-y-0.5">
                        <span className="font-mono tabular-nums font-semibold text-slate-900 dark:text-slate-100 whitespace-nowrap">
                          SI {formatSiNumber(r.siNumber)}
                        </span>
                        <span className="text-slate-300 dark:text-slate-700" aria-hidden="true">·</span>
                        <span className="font-medium text-slate-900 dark:text-slate-100 truncate">
                          {r.fullName}
                        </span>
                        <span className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
                          #{r.bib} · {r.club} · {r.eventName} ({r.className})
                        </span>
                      </div>

                      <div className="flex items-center justify-between sm:justify-end gap-2.5 shrink-0">
                        <RunnerStatusIndicator status={r.status} compact />
                        {r.rentalReturned ? (
                          <span className="text-[11px] text-emerald-700 dark:text-emerald-400 font-medium whitespace-nowrap">
                            Återlämnad
                          </span>
                        ) : (
                          <span className="text-[11px] text-amber-700 dark:text-amber-400 font-semibold whitespace-nowrap">
                            {r.enableFeesAndSwish
                              ? `Ute (${clubSettings.missingRentalFeeSek} kr)`
                              : 'Ej inlämnad'}
                          </span>
                        )}
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void handleToggleRentalReturned(r)}
                          className={`inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                            r.rentalReturned
                              ? 'text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800'
                              : 'text-white bg-emerald-600 hover:bg-emerald-700'
                          }`}
                        >
                          <Check className="w-3 h-3" />
                          <span>{r.rentalReturned ? 'Ångra' : 'Återlämna'}</span>
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
          )}

          {/* Club Series Standings (O-Tid Multi-Stage Leaderboard) */}
          {subTab === 'series' && (
          <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2.5">
              <div className="min-w-0">
                <h2 className="text-sm font-display font-bold text-slate-900 dark:text-slate-100 flex items-center gap-1.5">
                  <Trophy className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                  <span>Klubbserie & Etappsammanställning</span>
                </h2>
                <div className="text-[11px] text-slate-500 dark:text-slate-400">
                  {activeSeriesScoringConfig.model === 'PLACEMENT'
                    ? `Placeringspoäng: ${activeSeriesScoringConfig.placementPoints.join(' · ')} · Övriga ${activeSeriesScoringConfig.participationPoints} p`
                    : `${activeSeriesScoringConfig.participationPoints} p per startande`}
                </div>
              </div>

              {seriesStandings.length > 1 && (
                <select
                  value={activeSeriesBundle?.seriesName ?? ''}
                  onChange={(e) => setSelectedSeriesName(e.target.value)}
                  aria-label="Välj klubbserie"
                  className="px-2.5 py-1 text-xs font-medium bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-100"
                >
                  {seriesStandings.map((b) => (
                    <option key={b.seriesName} value={b.seriesName}>
                      {b.seriesName} ({b.stages.length} etapper)
                    </option>
                  ))}
                </select>
              )}
            </div>

            {!activeSeriesBundle ? (
              <div className="px-4 py-3 text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                Ingen klubbserie finns ännu. Ange ett gemensamt serienamn på tävlingarna under{' '}
                <em>Tävlingar och Serier</em>. Lägg till tävlingar där och välj sedan poängmodell
                för serien här.
              </div>
            ) : (
              <div className="p-3.5 space-y-2.5">
                <form
                  onSubmit={handleSaveSeriesScoring}
                  className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/40 p-3 space-y-2.5"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                      Poängmodell · {activeSeriesBundle.seriesName}
                    </h3>
                    <select
                      value={seriesScoringModel}
                      onChange={(event) =>
                        setSeriesScoringModel(
                          event.target.value === 'PARTICIPATION'
                            ? 'PARTICIPATION'
                            : 'PLACEMENT'
                        )
                      }
                      aria-label="Poängmodell för serie"
                      className="px-2.5 py-1 text-xs bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg"
                    >
                      <option value="PLACEMENT">Placeringspoäng (Modell A)</option>
                      <option value="PARTICIPATION">Fast deltagandepoäng</option>
                    </select>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                    {seriesScoringModel === 'PLACEMENT' && (
                      <label className="block text-[11px] text-slate-600 dark:text-slate-400">
                        Placeringsskala (poäng, separerade med kommatecken)
                        <input
                          type="text"
                          value={seriesPlacementScale}
                          onChange={(event) => setSeriesPlacementScale(event.target.value)}
                          placeholder="10,8,6,5,4,3,2,1"
                          className="mt-1 w-full px-2.5 py-1.5 text-xs border border-slate-200 dark:border-slate-700 rounded-lg"
                        />
                      </label>
                    )}
                    <label className="block text-[11px] text-slate-600 dark:text-slate-400">
                      {seriesScoringModel === 'PLACEMENT'
                        ? 'Deltagandepoäng för övriga startande'
                        : 'Poäng per startande/fullföljande deltagare'}
                      <input
                        type="number"
                        min="0"
                        max="10000"
                        step="1"
                        value={seriesParticipationPoints}
                        onChange={(event) =>
                          setSeriesParticipationPoints(event.target.value)
                        }
                        className="mt-1 w-full px-2.5 py-1.5 text-xs border border-slate-200 dark:border-slate-700 rounded-lg"
                      />
                    </label>
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-[10px] text-slate-500 dark:text-slate-400">
                      Gäller alla etapper med detta serienamn. Deltagandepoäng ges till startande
                      som inte får placeringspoäng, eller till alla startande i fast modell.
                    </p>
                    <button
                      type="submit"
                      disabled={seriesScoringBusy}
                      className="px-3 py-1.5 text-xs font-semibold club-accent-btn disabled:opacity-50 rounded-lg whitespace-nowrap"
                    >
                      {seriesScoringBusy ? 'Sparar...' : 'Spara poängmodell'}
                    </button>
                  </div>
                  {seriesScoringNotice && (
                    <p
                      role="status"
                      className={`text-xs ${
                        seriesScoringNotice.ok
                          ? 'text-emerald-700 dark:text-emerald-400'
                          : 'text-red-700 dark:text-red-400'
                      }`}
                    >
                      {seriesScoringNotice.msg}
                    </p>
                  )}
                </form>

                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-xs text-slate-600 dark:text-slate-400 min-w-0">
                    <strong className="text-slate-900 dark:text-slate-100">
                      {activeSeriesBundle.seriesName}
                    </strong>{' '}
                    ({activeSeriesBundle.stages.length} etapper):{' '}
                    {activeSeriesBundle.stages.map((s) => s.name).join(' · ')}
                  </div>

                  {activeSeriesBundle.classes.length > 0 && (
                    <div className="inline-flex flex-wrap items-center gap-1 p-0.5 bg-slate-100 dark:bg-slate-800 rounded-lg">
                      {activeSeriesBundle.classes.map((clsGroup) => (
                        <button
                          key={clsGroup.className}
                          type="button"
                          onClick={() => setSelectedSeriesClass(clsGroup.className)}
                          className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                            activeSeriesClassGroup?.className === clsGroup.className
                              ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm'
                              : 'text-slate-600 dark:text-slate-400'
                          }`}
                        >
                          {clsGroup.className} ({clsGroup.rows.length})
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {!activeSeriesClassGroup ? (
                  <div className="px-3 py-2.5 text-xs text-slate-500 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg">
                    Inga godkända målgångar (OK) registrerade i seriens tävlingar ännu.
                  </div>
                ) : (
                  <div className="border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden">
                    <table className="w-full text-left border-collapse text-xs">
                      <thead>
                        <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/50 text-[11px] font-semibold text-slate-600 dark:text-slate-400">
                          <th className="py-1.5 pl-3 pr-1.5 w-9">Plac</th>
                          <th className="py-1.5 px-2">Löpare · Klubb</th>
                          {activeSeriesBundle.stages.map((st, idx) => (
                            <th
                              key={st.eventId}
                              title={`${st.name} (${st.date})`}
                              className="hidden sm:table-cell py-1.5 px-2 text-right font-mono whitespace-nowrap"
                            >
                              E{idx + 1}
                            </th>
                          ))}
                          <th className="hidden md:table-cell py-1.5 px-2 text-right">Segrar</th>
                          <th className="py-1.5 pl-2 pr-3 text-right">Totalt</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-200/80 dark:divide-slate-800/80">
                        {activeSeriesClassGroup.rows.map((row, idx) => (
                          <tr
                            key={row.runnerKey}
                            className="hover:bg-slate-50/80 dark:hover:bg-slate-800/40"
                          >
                            <td className="py-1.5 pl-3 pr-1.5 font-mono tabular-nums text-slate-500">
                              {idx + 1}
                            </td>
                            <td className="py-1.5 px-2 max-w-[180px] sm:max-w-none truncate">
                              <span className="font-semibold text-slate-900 dark:text-slate-100">
                                {row.fullName}
                              </span>
                              <span className="text-slate-500 dark:text-slate-400">
                                {' '}
                                · {row.club}
                              </span>
                            </td>
                            {activeSeriesBundle.stages.map((st) => {
                              const pts = row.stagePoints[st.eventId];
                              return (
                                <td
                                  key={st.eventId}
                                  className="hidden sm:table-cell py-1.5 px-2 text-right font-mono tabular-nums text-slate-600 dark:text-slate-300 whitespace-nowrap"
                                >
                                  {pts !== undefined ? `${pts} p` : '—'}
                                </td>
                              );
                            })}
                            <td className="hidden md:table-cell py-1.5 px-2 text-right font-mono tabular-nums text-slate-600 dark:text-slate-400">
                              {row.wins}
                            </td>
                            <td className="py-1.5 pl-2 pr-3 text-right font-mono tabular-nums font-bold text-slate-900 dark:text-slate-100 whitespace-nowrap">
                              {row.totalPoints} p
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </section>
          )}
        </div>
      )}
    </div>
  );
}
