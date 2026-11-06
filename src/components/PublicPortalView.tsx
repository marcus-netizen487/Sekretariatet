import React, { useCallback, useEffect, useMemo, useState } from 'react';
import QRCode from 'qrcode';
import {
  ArrowLeft,
  Calendar,
  Check,
  Copy,
  MapPin,
  Moon,
  QrCode,
  Share2,
  Sun,
  Trophy,
  Wrench,
  X,
} from 'lucide-react';
import type {
  ClubSettings,
  CompetitionSummary,
  Competitor,
  PublicRacePayload,
  PublicSeasonOverviewPayload,
  SeriesStandingsBundle,
} from '../types/sportident';
import {
  formatDurationMmSs,
  formatSecondsAsClock,
  formatSiNumber,
} from '../services/sportidentProtocol';
import { SplitsAnalysisTable } from './SplitsAnalysisTable';
import { RunnerSplitCardModal } from './RunnerSplitCardModal';
import { RunnerStatusIndicator } from './StatusLabels';
import { PWAInstallButton } from './PWAInstallButton';
import { applyClubThemeToDocument } from '../utils/clubTheme';
import {
  loadFullSeasonFromFirestore,
  loadPublicRaceFromFirestore,
  subscribePublicCompetitionSummaries,
} from '../firebase';
import { apiWebSocketUrl } from '../services/authClient';

interface PublicPortalViewProps {
  shortCode: string | null; // null means Season Overview (/publik)
  darkMode: boolean;
  onToggleDarkMode: () => void;
  onSelectEventShortCode: (shortCode: string | null) => void;
  onSwitchToSecretariat: () => void;
}

type PublicEventTab = 'RESULTS' | 'STARTLIST';

export function PublicPortalView({
  shortCode,
  darkMode,
  onToggleDarkMode,
  onSelectEventShortCode,
  onSwitchToSecretariat,
}: PublicPortalViewProps) {
  const [apiCompetitionsList, setApiCompetitionsList] = useState<CompetitionSummary[]>([]);
  const [firestoreCompetitionsList, setFirestoreCompetitionsList] = useState<
    CompetitionSummary[]
  >([]);
  const [seasonClubSettings, setSeasonClubSettings] = useState<ClubSettings | null>(null);
  const [seasonSeriesStandings, setSeasonSeriesStandings] = useState<SeriesStandingsBundle[]>([]);
  const [selectedSeriesName, setSelectedSeriesName] = useState<string>('');
  const [selectedSeriesClass, setSelectedSeriesClass] = useState<string>('');

  const [raceData, setRaceData] = useState<PublicRacePayload | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const [activeTab, setActiveTab] = useState<PublicEventTab>('RESULTS');
  const [resultsGrouping, setResultsGrouping] = useState<'CLASS' | 'CLUB'>('CLASS');
  const [selectedClassId, setSelectedClassId] = useState<string>('ALL');
  const [selectedClubName, setSelectedClubName] = useState<string | null>(null);

  // Runner detail inline panel
  const [inspectedRunner, setInspectedRunner] = useState<Competitor | null>(null);

  // QR & Share inline footer panel
  const [qrModalOpen, setQrModalOpen] = useState<boolean>(false);
  const [qrSvgMarkup, setQrSvgMarkup] = useState<string>('');
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const competitionsList = useMemo(() => {
    const firestoreById = new Map(
      firestoreCompetitionsList.map((competition) => [competition.id, competition])
    );
    const apiIds = new Set(apiCompetitionsList.map((competition) => competition.id));
    const merged = apiCompetitionsList.map((competition) => {
      const firestoreCompetition = firestoreById.get(competition.id);
      if (!firestoreCompetition) return competition;
      return {
        ...competition,
        ...firestoreCompetition,
        classCount: firestoreCompetition.classCount || competition.classCount,
      };
    });
    for (const competition of firestoreCompetitionsList) {
      if (!apiIds.has(competition.id)) merged.push(competition);
    }
    return merged;
  }, [apiCompetitionsList, firestoreCompetitionsList]);

  const loadData = useCallback(async () => {
    try {
      if (!shortCode) {
        let overview: PublicSeasonOverviewPayload | null = null;
        try {
          const res = await fetch('/api/public/season');
          if (res.ok) overview = (await res.json()) as PublicSeasonOverviewPayload;
        } catch {
          // Use Firestore when the optional Express API is unavailable.
        }
        if (overview) {
          setApiCompetitionsList(overview.competitions);
          setSeasonClubSettings(overview.clubSettings);
          setSeasonSeriesStandings(overview.seriesStandings ?? []);
          setError(null);
        } else {
          let fallbackCompetitions: CompetitionSummary[] | null = null;
          try {
            const fallback = await fetch('/api/public/competitions');
            if (fallback.ok) {
              fallbackCompetitions = (await fallback.json()) as CompetitionSummary[];
            }
          } catch {
            // Fall through to the direct Firestore season read.
          }
          if (fallbackCompetitions) {
            setApiCompetitionsList(fallbackCompetitions);
            setError(null);
          } else {
            const cloudSeason = await loadFullSeasonFromFirestore({
              includeRunnerDb: false,
            });
            if (cloudSeason) {
              setApiCompetitionsList(
                cloudSeason.events.map((event) => ({
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
                  enableFeesAndSwish: event.competition.enableFeesAndSwish,
                  competitorCount: event.competitors.length,
                  finishedCount: event.competitors.filter(
                    (competitor) =>
                      competitor.status === 'OK' || competitor.status === 'MP'
                  ).length,
                  classCount: event.classes.length,
                }))
              );
              setSeasonClubSettings(cloudSeason.clubSettings);
              setSeasonSeriesStandings(cloudSeason.seriesStandings ?? []);
              setError(null);
            }
          }
        }
      } else {
        let payload: PublicRacePayload | null = null;
        try {
          const res = await fetch(`/api/public/events/${encodeURIComponent(shortCode)}`);
          if (res.ok) {
            payload = (await res.json()) as PublicRacePayload;
          }
        } catch {
          // Use Firestore for events that have not yet been hydrated to the server.
        }

        if (!payload) {
          payload = await loadPublicRaceFromFirestore(shortCode);
        }

        if (!payload) {
          setError('Tävlingen eller kortlänken hittades inte.');
          setRaceData(null);
        } else {
          setRaceData(payload);
          setApiCompetitionsList(payload.competitionsList);
          if (payload.clubSettings) setSeasonClubSettings(payload.clubSettings);
          if (payload.seriesStandings) setSeasonSeriesStandings(payload.seriesStandings);
          setError(null);
        }
      }
    } catch {
      setError('Kunde inte nå resultatservern — visar senast hämtade data.');
    } finally {
      setLoading(false);
    }
  }, [shortCode]);

  useEffect(() => {
    setLoading(true);
    setSelectedClubName(null);
    void loadData();
  }, [loadData]);

  useEffect(() => {
    if (shortCode) {
      setFirestoreCompetitionsList([]);
      return;
    }
    return subscribePublicCompetitionSummaries(
      setFirestoreCompetitionsList,
      (error) => {
        console.error('Kunde inte prenumerera på publika tävlingar från Firestore:', error);
      }
    );
  }, [shortCode]);

  useEffect(() => {
    if (seasonSeriesStandings.length === 0) {
      setSelectedSeriesName('');
      setSelectedSeriesClass('');
      return;
    }
    const bundle =
      seasonSeriesStandings.find((b) => b.seriesName === selectedSeriesName) ??
      seasonSeriesStandings[0];
    if (bundle.seriesName !== selectedSeriesName) {
      setSelectedSeriesName(bundle.seriesName);
    }
    if (!bundle.classes.some((c) => c.className === selectedSeriesClass)) {
      setSelectedSeriesClass(bundle.classes[0]?.className ?? '');
    }
  }, [seasonSeriesStandings, selectedSeriesName, selectedSeriesClass]);

  // Real-time WebSocket auto-refresh for spectators
  useEffect(() => {
    let active = true;
    let ws: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (!active) return;
      ws = new WebSocket(apiWebSocketUrl('/api/ws'));
      ws.onmessage = () => {
        if (active) void loadData();
      };
      ws.onclose = () => {
        if (active) retryTimer = setTimeout(connect, 3000);
      };
    };

    connect();
    return () => {
      active = false;
      if (retryTimer) clearTimeout(retryTimer);
      if (ws) ws.close();
    };
  }, [loadData]);

  // Generate SVG QR code for public portal URL (/publik)
  const publicEventUrl = useMemo(() => {
    if (typeof window === 'undefined') return '';
    return `${window.location.origin}/publik`;
  }, []);

  const iofResultsXmlUrl = useMemo(() => {
    if (typeof window === 'undefined') return '';
    const code = shortCode || raceData?.competition.shortCode;
    return code
      ? `${window.location.origin}/api/public/events/${code}/iof-results`
      : '';
  }, [shortCode, raceData]);

  useEffect(() => {
    if (!publicEventUrl) return;
    let mounted = true;
    QRCode.toString(publicEventUrl, {
      type: 'svg',
      margin: 1,
      width: 200,
      color: {
        dark: '#0f172a',
        light: '#ffffff',
      },
    })
      .then((svg) => {
        if (mounted) setQrSvgMarkup(svg);
      })
      .catch(() => {
        // ignore
      });
    return () => {
      mounted = false;
    };
  }, [publicEventUrl]);

  const effectiveClubSettings = raceData?.clubSettings ?? seasonClubSettings;
  const [logoBroken, setLogoBroken] = useState<boolean>(false);

  useEffect(() => {
    setLogoBroken(false);
  }, [effectiveClubSettings?.logoDataUrl]);

  useEffect(() => {
    applyClubThemeToDocument(effectiveClubSettings, darkMode);
  }, [effectiveClubSettings, darkMode]);

  const copyText = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 2200);
    } catch {
      // ignore
    }
  };

  const uniqueClubs = useMemo(() => {
    if (!raceData) return [];
    const set = new Set<string>();
    for (const c of raceData.competitors) {
      if (c.club.trim()) set.add(c.club.trim());
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'sv'));
  }, [raceData]);

  const filteredCompetitors = useMemo(() => {
    if (!raceData) return [];
    return selectedClubName
      ? raceData.competitors.filter((competitor) => competitor.club.trim() === selectedClubName)
      : raceData.competitors;
  }, [raceData, selectedClubName]);

  // ============================================================================
  // VIEW A: SEASON OVERVIEW (/publik)
  // ============================================================================
  if (!shortCode) {
    const liveList = competitionsList.filter((c) => c.status === 'LIVE');
    const upcomingList = competitionsList.filter((c) => c.status === 'UPCOMING');
    const completedList = competitionsList.filter((c) => c.status === 'COMPLETED');

    const activeSeriesBundle =
      seasonSeriesStandings.find((b) => b.seriesName === selectedSeriesName) ??
      seasonSeriesStandings[0] ??
      null;
    const activeSeriesClassGroup =
      activeSeriesBundle?.classes.find((c) => c.className === selectedSeriesClass) ??
      activeSeriesBundle?.classes[0] ??
      null;

    const renderGroup = (title: string, items: CompetitionSummary[]) => {
      if (items.length === 0) return null;
      return (
        <section className="space-y-1.5">
          <h2 className="text-xs font-semibold club-muted text-slate-600 dark:text-slate-400 px-0.5">
            {title} ({items.length})
          </h2>
          <div className="club-surface bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl divide-y divide-slate-200/80 dark:divide-slate-800/80 overflow-hidden">
            {items.map((ev) => (
              <button
                key={ev.id}
                type="button"
                onClick={() => onSelectEventShortCode(ev.shortCode)}
                className="w-full text-left px-3.5 py-2 hover:bg-slate-50/80 dark:hover:bg-slate-800/50 transition-colors flex flex-col sm:flex-row sm:items-center justify-between gap-1 sm:gap-3"
              >
                <div className="min-w-0 flex-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <span className="text-sm font-display font-bold truncate">
                    {ev.name}
                  </span>
                  <span className="text-xs club-muted text-slate-500 dark:text-slate-400 truncate">
                    <span className="font-mono tabular-nums">
                      {ev.date}
                      {ev.status !== 'COMPLETED' ? ` kl. ${ev.zeroTimeStr.slice(0, 5)}` : ''}
                    </span>
                    {ev.seriesName ? ` · ${ev.seriesName}` : ''}
                    {ev.arenaInfo ? ` · ${ev.arenaInfo}` : ''}
                  </span>
                </div>

                <div className="shrink-0 flex items-center text-xs font-mono tabular-nums club-muted text-slate-600 dark:text-slate-400">
                  <span>
                    {ev.finishedCount}/{ev.competitorCount} i mål
                  </span>
                </div>
              </button>
            ))}
          </div>
        </section>
      );
    };

    return (
      <div className="min-h-screen flex flex-col club-canvas bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 overflow-x-clip">
        <header className="min-h-12 py-1.5 px-3 sm:px-6 lg:px-8 club-surface bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-2 sm:gap-4">
          <div className="flex items-center gap-2.5 min-w-0 flex-1">
            {effectiveClubSettings?.logoDataUrl && !logoBroken && (
              <img
                src={effectiveClubSettings.logoDataUrl}
                alt={`${effectiveClubSettings.clubName || 'Klubb'} logotyp`}
                referrerPolicy="no-referrer"
                onError={() => setLogoBroken(true)}
                className="h-7 w-auto max-w-[96px] sm:max-w-[130px] object-contain shrink-0"
              />
            )}
            <span className="text-sm sm:text-base font-display font-bold truncate">
              {effectiveClubSettings?.portalTitle?.trim() || 'PasserSI Live'}
            </span>
            <span className="text-xs club-muted text-slate-500 dark:text-slate-400 hidden md:inline truncate">
              Liveresultat & sträcktider
            </span>
          </div>

          <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
            <button
              type="button"
              onClick={onToggleDarkMode}
              className="p-1.5 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors shrink-0"
              aria-label="Växla tema"
            >
              {darkMode ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </button>

            <button
              type="button"
              onClick={onSwitchToSecretariat}
              className="inline-flex items-center gap-1.5 px-2.5 sm:px-3 py-1.5 text-xs font-semibold text-slate-800 dark:text-slate-100 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 border border-slate-200/80 dark:border-slate-700 rounded-lg transition-colors whitespace-nowrap shrink-0"
            >
              <Wrench className="w-3.5 h-3.5 shrink-0" />
              <span>Sekretariat</span>
            </button>
          </div>
        </header>

        <main className="flex-1 w-full p-2 sm:p-3.5 space-y-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h1 className="text-lg sm:text-xl font-display font-bold">
              {seasonClubSettings?.clubName
                ? `${seasonClubSettings.clubName} — Tävlingar & Träningar`
                : 'Tävlingar & Klubbarrangemang'}
            </h1>
            <p className="text-xs club-muted text-slate-500 dark:text-slate-400">
              Välj tävling för liveresultat och sträcktider.
            </p>
          </div>

          {!loading && competitionsList.length === 0 ? (
            <section className="p-5 club-surface bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl text-center space-y-1">
              <h2 className="text-sm font-semibold">
                Inga publicerade tävlingar just nu
              </h2>
              <p className="text-xs club-muted text-slate-500 dark:text-slate-400 max-w-md mx-auto">
                Nya tävlingar och klubbträningar visas här så snart sekretariatet har lagt upp dem.
              </p>
            </section>
          ) : (
            <div className="space-y-3.5">
              {renderGroup('Pågår nu', liveList)}
              {renderGroup('Kommande tävlingar & träningar', upcomingList)}
              {renderGroup('Avslutade tävlingar', completedList)}
            </div>
          )}

          {/* Public Multi-Stage Club Series Leaderboard */}
          {activeSeriesBundle && activeSeriesBundle.classes.length > 0 && (
            <section className="club-surface bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
              <div className="px-3.5 py-2.5 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <h2 className="text-sm font-display font-bold text-slate-900 dark:text-slate-100 inline-flex items-center gap-1.5">
                    <Trophy className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                    <span>{activeSeriesBundle.seriesName}</span>
                  </h2>
                  <span className="text-[11px] text-slate-500 dark:text-slate-400">
                    Poängskala 25-20-16-13...
                  </span>
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  {seasonSeriesStandings.length > 1 && (
                    <select
                      value={activeSeriesBundle.seriesName}
                      onChange={(e) => setSelectedSeriesName(e.target.value)}
                      className="px-2 py-1 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-md"
                    >
                      {seasonSeriesStandings.map((b) => (
                        <option key={b.seriesName} value={b.seriesName}>
                          {b.seriesName}
                        </option>
                      ))}
                    </select>
                  )}

                  <div className="flex flex-wrap items-center gap-1 p-0.5 bg-slate-100 dark:bg-slate-800 rounded-lg">
                    {activeSeriesBundle.classes.map((c) => (
                      <button
                        key={c.className}
                        type="button"
                        onClick={() => setSelectedSeriesClass(c.className)}
                        className={`px-2 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
                          activeSeriesClassGroup?.className === c.className
                            ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm'
                            : 'text-slate-600 dark:text-slate-400'
                        }`}
                      >
                        {c.className}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {activeSeriesClassGroup && (
                <div className="w-full overflow-x-auto">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/50 text-[11px] font-semibold text-slate-600 dark:text-slate-400">
                        <th className="py-1.5 pl-3.5 pr-1.5 w-10">#</th>
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
                        <th className="py-1.5 pl-2 pr-3.5 text-right">Totalt</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200/80 dark:divide-slate-800/80">
                      {activeSeriesClassGroup.rows.map((row, idx) => (
                        <tr
                          key={row.runnerKey}
                          className="hover:bg-slate-50/80 dark:hover:bg-slate-800/40"
                        >
                          <td className="py-1.5 pl-3.5 pr-1.5 font-mono tabular-nums text-slate-500">
                            {idx + 1}
                          </td>
                          <td className="py-1.5 px-2 min-w-0">
                            <span className="font-semibold text-slate-900 dark:text-slate-100">
                              {row.fullName}
                            </span>
                            <span className="text-slate-500 dark:text-slate-400">
                              {' · '}
                              {row.club}
                            </span>
                          </td>
                          {activeSeriesBundle.stages.map((st) => {
                            const pts = row.stagePoints[st.eventId];
                            return (
                              <td
                                key={st.eventId}
                                className="hidden sm:table-cell py-1.5 px-2 text-right font-mono tabular-nums text-slate-600 dark:text-slate-300 whitespace-nowrap"
                              >
                                {pts !== undefined ? `${pts}` : '—'}
                              </td>
                            );
                          })}
                          <td className="py-1.5 pl-2 pr-3.5 text-right font-mono tabular-nums font-bold text-slate-900 dark:text-slate-100 whitespace-nowrap">
                            {row.totalPoints} p
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}
        </main>

        <footer className="mt-4 club-surface bg-white dark:bg-slate-900 border-t border-slate-200 dark:border-slate-800">
          <div className="w-full px-2 sm:px-4 py-2 flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs club-muted text-slate-500 dark:text-slate-400">
              {effectiveClubSettings?.portalTitle?.trim() || 'PasserSI Live'} · Orienteringsresultat i realtid
            </span>
            <div className="flex flex-wrap items-center gap-1.5">
              <PWAInstallButton />
            </div>
          </div>
        </footer>
      </div>
    );
  }

  // ============================================================================
  // VIEW B: PUBLIC RACE PAGE (/t/{shortCode})
  // ============================================================================
  return (
    <div className="min-h-screen flex flex-col club-canvas bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 overflow-x-clip">
      {/* Top Spectator Header */}
      <header className="club-surface bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800">
        <div className="min-h-12 py-1.5 px-3 sm:px-6 lg:px-8 flex items-center justify-between gap-2 sm:gap-4">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            {effectiveClubSettings?.logoDataUrl && !logoBroken && (
              <img
                src={effectiveClubSettings.logoDataUrl}
                alt={`${effectiveClubSettings.clubName || 'Klubb'} logotyp`}
                referrerPolicy="no-referrer"
                onError={() => setLogoBroken(true)}
                className="h-6 w-auto max-w-[84px] sm:max-w-[100px] object-contain shrink-0"
              />
            )}
            <button
              type="button"
              onClick={() => onSelectEventShortCode(null)}
              className="inline-flex items-center gap-1 text-xs font-medium club-muted text-slate-700 dark:text-slate-300 hover:underline whitespace-nowrap shrink-0"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              <span>Alla</span>
            </button>
            <span className="text-slate-300 dark:text-slate-700 shrink-0" aria-hidden="true">
              /
            </span>
            <h1 className="text-sm sm:text-base font-display font-bold truncate">
              {raceData?.competition.name ?? 'Laddar tävling...'}
            </h1>
            {raceData && (
              <div className="hidden lg:flex items-center gap-1.5 text-xs club-muted text-slate-500 dark:text-slate-400 min-w-0 truncate">
                <span aria-hidden="true">·</span>
                <span className="inline-flex items-center gap-1 font-mono tabular-nums shrink-0">
                  <Calendar className="w-3 h-3 shrink-0" />
                  {raceData.competition.date}
                </span>
                {raceData.competition.seriesName && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span className="truncate">{raceData.competition.seriesName}</span>
                  </>
                )}
                {raceData.competition.arenaInfo && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span className="inline-flex items-center gap-1 truncate">
                      <MapPin className="w-3 h-3 club-accent-text shrink-0" />
                      <span className="truncate">{raceData.competition.arenaInfo}</span>
                    </span>
                  </>
                )}
              </div>
            )}
          </div>

          <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
            <button
              type="button"
              onClick={onToggleDarkMode}
              className="p-1.5 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors shrink-0"
              aria-label="Växla tema"
            >
              {darkMode ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </button>

            <button
              type="button"
              onClick={onSwitchToSecretariat}
              className="inline-flex items-center gap-1.5 px-2.5 sm:px-3 py-1.5 text-xs font-semibold text-slate-800 dark:text-slate-100 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 border border-slate-200/80 dark:border-slate-700 rounded-lg transition-colors whitespace-nowrap shrink-0"
            >
              <Wrench className="w-3.5 h-3.5 shrink-0" />
              <span>Sekretariat</span>
            </button>
          </div>
        </div>

        {raceData && (
          <div className="lg:hidden px-3 sm:px-6 pb-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs club-muted text-slate-500 dark:text-slate-400">
            <span className="inline-flex items-center gap-1 font-mono tabular-nums">
              <Calendar className="w-3 h-3 shrink-0" />
              {raceData.competition.date}
            </span>
            {raceData.competition.seriesName && (
              <>
                <span aria-hidden="true">·</span>
                <span>{raceData.competition.seriesName}</span>
              </>
            )}
            {raceData.competition.arenaInfo && (
              <>
                <span aria-hidden="true">·</span>
                <span className="inline-flex items-center gap-1">
                  <MapPin className="w-3 h-3 club-accent-text shrink-0" />
                  <span>{raceData.competition.arenaInfo}</span>
                </span>
              </>
            )}
          </div>
        )}

        {/* Navigation Tabs */}
        {raceData && (
          <div className="w-full px-2 sm:px-4 flex flex-wrap items-center gap-x-1 border-t border-slate-100 dark:border-slate-800/80">
            <button
              type="button"
              onClick={() => setActiveTab('RESULTS')}
              className={`px-2.5 sm:px-3 py-2 text-xs font-semibold border-b-2 transition-colors whitespace-nowrap shrink-0 ${
                activeTab === 'RESULTS'
                  ? 'club-accent-tab-active'
                  : 'border-transparent club-muted text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              Resultat & Sträcktider
            </button>

            <button
              type="button"
              onClick={() => setActiveTab('STARTLIST')}
              className={`px-2.5 sm:px-3 py-2 text-xs font-semibold border-b-2 transition-colors whitespace-nowrap shrink-0 ${
                activeTab === 'STARTLIST'
                  ? 'club-accent-tab-active'
                  : 'border-transparent club-muted text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              Startlista ({raceData.competitors.length})
            </button>

          </div>
        )}
      </header>

      <main className="flex-1 w-full p-1.5 sm:p-2.5 space-y-2.5">
        {loading && !raceData ? (
          <div className="p-6 text-center text-xs text-slate-500">Hämtar tävlingsdata...</div>
        ) : error && !raceData ? (
          <div className="p-4 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl text-xs text-red-600">
            {error}
          </div>
        ) : (
          raceData && (
            <>
              {/* Emergency Broken Control Notice for Spectators */}
              {raceData.emergency.brokenControls.length > 0 && (
                <div className="px-3 py-2 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900/60 rounded-lg text-xs text-amber-800 dark:text-amber-300">
                  <strong>Tävlingsinfo:</strong> Kontroll{' '}
                  {raceData.emergency.brokenControls.map((c) => `(${c})`).join(', ')} är ur
                  funktion och har undantagits.
                </div>
              )}

              {(activeTab === 'RESULTS' || activeTab === 'STARTLIST') &&
                selectedClubName && (
                  <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 dark:border-slate-800 dark:bg-slate-900">
                    <h2 className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                      {activeTab === 'STARTLIST' ? 'Klubb-startlista' : 'Klubb-resultatlista'}:{' '}
                      {selectedClubName}
                    </h2>
                    <button
                      type="button"
                      onClick={() => setSelectedClubName(null)}
                      className="text-xs font-semibold text-blue-700 underline decoration-dotted underline-offset-2 hover:text-blue-900 dark:text-blue-300 dark:hover:text-blue-100"
                    >
                      Visa alla klubbar
                    </button>
                  </div>
                )}

              {/* Results Grouping Bar */}
              {activeTab === 'RESULTS' && (
                <div className="flex items-center justify-end gap-2">
                  <div className="inline-flex items-center gap-0.5 p-0.5 bg-slate-100 dark:bg-slate-800 rounded-md text-xs">
                    <button
                      type="button"
                      onClick={() => setResultsGrouping('CLASS')}
                      className={`px-2.5 py-1 rounded whitespace-nowrap shrink-0 transition-colors ${
                        resultsGrouping === 'CLASS'
                          ? 'bg-white dark:bg-slate-950 font-medium text-slate-900 dark:text-slate-100 shadow-xs'
                          : 'text-slate-500 hover:text-slate-900 dark:hover:text-slate-200'
                      }`}
                    >
                      Per klass
                    </button>
                    <button
                      type="button"
                      onClick={() => setResultsGrouping('CLUB')}
                      className={`px-2.5 py-1 rounded whitespace-nowrap shrink-0 transition-colors ${
                        resultsGrouping === 'CLUB'
                          ? 'bg-white dark:bg-slate-950 font-medium text-slate-900 dark:text-slate-100 shadow-xs'
                          : 'text-slate-500 hover:text-slate-900 dark:hover:text-slate-200'
                      }`}
                    >
                      Per klubb
                    </button>
                  </div>
                </div>
              )}

              {/* TAB 1: RESULTS & SPLITS */}
              {activeTab === 'RESULTS' &&
                (resultsGrouping === 'CLASS' ? (
                  <SplitsAnalysisTable
                    classes={
                      selectedClubName
                        ? raceData.classes.filter((cls) =>
                            filteredCompetitors.some((competitor) => competitor.classId === cls.id)
                          )
                        : raceData.classes
                    }
                    courses={raceData.courses}
                    competitors={filteredCompetitors}
                    radioControls={raceData.radioControls}
                    selectedClassId={selectedClassId}
                    onSelectClassId={setSelectedClassId}
                    onSelectClub={setSelectedClubName}
                    liveUpdates
                    liveUpdateScope={raceData.competition.id}
                  />
                ) : (
                  <div className="space-y-2.5">
                    {uniqueClubs.map((clubName) => {
                      const clubRunners = filteredCompetitors.filter(
                        (c) => c.club.trim() === clubName
                      );
                      if (clubRunners.length === 0) return null;
                      return (
                        <section
                          key={clubName}
                          className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden"
                        >
                          <div className="px-3.5 py-2 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between bg-slate-50/50 dark:bg-slate-950/40">
                            <h3 className="text-xs font-semibold">
                              <button
                                type="button"
                                onClick={() => setSelectedClubName(clubName)}
                                className="text-left text-blue-700 underline decoration-dotted underline-offset-2 hover:text-blue-900 dark:text-blue-300 dark:hover:text-blue-100"
                              >
                                {clubName}
                              </button>
                            </h3>
                            <span className="text-[11px] font-mono tabular-nums text-slate-500">
                              {clubRunners.length} delt.
                            </span>
                          </div>
                          <div className="divide-y divide-slate-200/80 dark:divide-slate-800/80">
                            {clubRunners.map((r) => {
                              const cls = raceData.classes.find((c) => c.id === r.classId);
                              const isExpanded = inspectedRunner?.id === r.id;
                              const isRogaining = cls?.classFormat === 'ROGAINING';
                              return (
                                <div key={r.id}>
                                  <button
                                    type="button"
                                    onClick={() =>
                                      setInspectedRunner((prev) =>
                                        prev?.id === r.id ? null : r
                                      )
                                    }
                                    className="w-full px-3.5 py-1.5 flex items-center justify-between gap-2 text-left hover:bg-slate-50 dark:hover:bg-slate-800/40 text-xs"
                                  >
                                    <div className="min-w-0 truncate">
                                      <span className="font-semibold text-slate-900 dark:text-slate-100">
                                        {r.fullName}
                                      </span>
                                      <span className="text-slate-500 ml-1.5">
                                        {cls?.name ?? '-'} · #{r.bib}
                                      </span>
                                    </div>
                                    <div className="flex items-center gap-2 font-mono tabular-nums shrink-0">
                                      {isRogaining &&
                                        r.validation?.rogainingPoints !== undefined && (
                                          <span className="font-semibold text-emerald-700 dark:text-emerald-400">
                                            {r.validation.rogainingPoints} p
                                          </span>
                                        )}
                                      <span className="font-semibold">
                                        {formatDurationMmSs(r.runningTimeSec)}
                                      </span>
                                      <RunnerStatusIndicator status={r.status} compact />
                                    </div>
                                  </button>
                                  {isExpanded && (
                                    <div className="p-2.5 sm:p-3 bg-slate-50/70 dark:bg-slate-950/50 border-t border-slate-200/80 dark:border-slate-800/80">
                                      <RunnerSplitCardModal
                                        runner={r}
                                        compClass={cls ?? null}
                                        course={
                                          raceData.courses.find(
                                            (crs) =>
                                              crs.id ===
                                              (r.validation?.matchedCourseId ?? cls?.courseId)
                                          ) ?? null
                                        }
                                        classCompetitors={raceData.competitors.filter(
                                          (c) => c.classId === r.classId
                                        )}
                                        onClose={() => setInspectedRunner(null)}
                                      />
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </section>
                      );
                    })}
                  </div>
                ))}

              {/* TAB 2: START LIST */}
              {activeTab === 'STARTLIST' && (
                <div className="space-y-2 w-full">
                  {raceData.classes.map((cls) => {
                    const inCls = filteredCompetitors
                      .filter((c) => c.classId === cls.id)
                      .sort(
                        (a, b) =>
                          (a.allocatedStartSec ?? 999999) - (b.allocatedStartSec ?? 999999)
                      );
                    if (selectedClubName && inCls.length === 0) return null;
                    return (
                      <section
                        key={cls.id}
                        className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden"
                      >
                        <div className="px-3 py-1.5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between bg-slate-50/60 dark:bg-slate-950/40">
                          <h3 className="text-xs font-semibold text-slate-900 dark:text-slate-100">{cls.name}</h3>
                          <span className="text-[11px] font-mono tabular-nums text-slate-500">
                            {inCls.length} anmälda
                          </span>
                        </div>
                        {inCls.length === 0 ? (
                          <div className="p-3 text-center text-xs text-slate-400">
                            Inga löpare anmälda i {cls.name}.
                          </div>
                        ) : (
                          <div className="overflow-x-auto">
                            <table className="w-full text-left text-xs border-collapse">
                              <thead>
                                <tr className="border-b border-slate-200 dark:border-slate-800 text-[11px] font-semibold text-slate-500 dark:text-slate-400 bg-slate-50/50 dark:bg-slate-950/30">
                                  <th className="py-2 pl-3 pr-2 w-16 font-mono">Nr-lapp</th>
                                  <th className="py-2 px-2.5 w-28 font-mono">Bricknummer</th>
                                  <th className="py-2 px-2.5">Namn</th>
                                  <th className="py-2 px-2.5">Klubb</th>
                                  <th className="py-2 pl-2.5 pr-3 text-right font-mono w-24">Starttid</th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-slate-100 dark:divide-slate-800/80">
                                {inCls.map((r) => {
                                  const startClock =
                                    r.allocatedStartSec !== null
                                      ? formatSecondsAsClock(r.allocatedStartSec)
                                      : 'Fri';
                                  return (
                                    <tr key={r.id} className="hover:bg-slate-50/60 dark:hover:bg-slate-800/40">
                                      <td className="py-1.5 pl-3 pr-2 font-mono tabular-nums text-slate-600 dark:text-slate-400">
                                        {r.bib ?? '—'}
                                      </td>
                                      <td className="py-1.5 px-2.5 font-mono tabular-nums text-slate-700 dark:text-slate-300">
                                        {formatSiNumber(r.siNumber)}
                                      </td>
                                      <td className="py-1.5 px-2.5 font-medium text-slate-900 dark:text-slate-100">
                                        {r.fullName}
                                      </td>
                                      <td className="py-1.5 px-2.5 text-slate-600 dark:text-slate-400">
                                        {r.club.trim() ? (
                                          <button
                                            type="button"
                                            onClick={() => setSelectedClubName(r.club.trim())}
                                            className="text-blue-700 underline decoration-dotted underline-offset-2 hover:text-blue-900 dark:text-blue-300 dark:hover:text-blue-100 text-left"
                                          >
                                            {r.club}
                                          </button>
                                        ) : (
                                          'Klubblös'
                                        )}
                                      </td>
                                      <td className="py-1.5 pl-2.5 pr-3 text-right font-mono tabular-nums font-semibold text-slate-900 dark:text-slate-100 whitespace-nowrap">
                                        {startClock}
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </section>
                    );
                  })}
                </div>
              )}

            </>
          )
        )}
      </main>

      {/* Bottom Action & Share Footer */}
      <footer className="mt-6 club-surface bg-white dark:bg-slate-900 border-t border-slate-200 dark:border-slate-800">
        <div className="w-full px-2 sm:px-4 py-2.5 space-y-2.5">
          {qrModalOpen && (
            <section className="bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl p-3.5 space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 min-w-0">
                  <Share2 className="w-4 h-4 club-accent-text shrink-0" />
                  <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100 truncate">
                    Dela publiksida, QR & Livelox
                  </h2>
                </div>
                <button
                  type="button"
                  onClick={() => setQrModalOpen(false)}
                  className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 rounded-lg shrink-0"
                  aria-label="Stäng"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-12 gap-3.5 items-center">
                {qrSvgMarkup && (
                  <div className="md:col-span-4 flex flex-col items-center justify-center p-3 bg-white border border-slate-200 rounded-xl">
                    <div
                      className="w-32 h-32"
                      dangerouslySetInnerHTML={{ __html: qrSvgMarkup }}
                    />
                    <span className="mt-1.5 text-[11px] font-mono text-slate-600 text-center">
                      Skanna för Liveresultat
                    </span>
                  </div>
                )}

                <div className="md:col-span-8 space-y-2.5 text-xs min-w-0">
                  <div>
                    <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                      Publik länk till liveresultat
                    </label>
                    <div className="flex items-center gap-2 min-w-0">
                      <input
                        type="text"
                        readOnly
                        value={publicEventUrl}
                        className="min-w-0 flex-1 px-2.5 py-1.5 font-mono text-[11px] bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg"
                      />
                      <button
                        type="button"
                        onClick={() => void copyText('pub', publicEventUrl)}
                        className="inline-flex items-center gap-1 px-2.5 py-1.5 font-medium bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg whitespace-nowrap shrink-0"
                      >
                        {copiedKey === 'pub' ? (
                          <Check className="w-3.5 h-3.5 text-emerald-600" />
                        ) : (
                          <Copy className="w-3.5 h-3.5" />
                        )}
                        <span>{copiedKey === 'pub' ? 'Kopierad' : 'Kopiera'}</span>
                      </button>
                    </div>
                  </div>

                  <div>
                    <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                      IOF XML 3.0 Resultat-URL (Livelox / WinSplits)
                    </label>
                    <div className="flex items-center gap-2 min-w-0">
                      <input
                        type="text"
                        readOnly
                        value={iofResultsXmlUrl}
                        className="min-w-0 flex-1 px-2.5 py-1.5 font-mono text-[11px] bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg"
                      />
                      <button
                        type="button"
                        onClick={() => void copyText('iof', iofResultsXmlUrl)}
                        className="inline-flex items-center gap-1 px-2.5 py-1.5 font-medium bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg whitespace-nowrap shrink-0"
                      >
                        {copiedKey === 'iof' ? (
                          <Check className="w-3.5 h-3.5 text-emerald-600" />
                        ) : (
                          <Copy className="w-3.5 h-3.5" />
                        )}
                        <span>{copiedKey === 'iof' ? 'Kopierad' : 'Kopiera'}</span>
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </section>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <PWAInstallButton />

              <button
                type="button"
                onClick={() => setQrModalOpen((v) => !v)}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium club-accent-btn rounded-lg transition-colors whitespace-nowrap shrink-0"
              >
                {qrModalOpen ? <X className="w-3.5 h-3.5" /> : <QrCode className="w-3.5 h-3.5" />}
                <span>{qrModalOpen ? 'Dölj QR' : 'QR & Livelox'}</span>
              </button>
            </div>

            <span className="text-[11px] text-slate-500 dark:text-slate-400">
              {effectiveClubSettings?.portalTitle?.trim() || effectiveClubSettings?.clubName || 'PasserSI'}
            </span>
          </div>
        </div>
      </footer>
    </div>
  );
}
