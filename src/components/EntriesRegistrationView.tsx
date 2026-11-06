import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  Search,
  Trash2,
  UserCheck,
  UserPlus,
} from 'lucide-react';
import type {
  CardPunch,
  ClubSettings,
  CompClass,
  Competitor,
  RunnerDbEntry,
  RunnerDbSource,
  SICardSeries,
} from '../types/sportident';
import {
  formatSecondsAsClock,
  formatSiNumber,
  inferCardSeries,
  parseClockToSeconds,
} from '../services/sportidentProtocol';
import type {
  SerialConnectionStatus,
  UsbStationMode,
} from '../services/sportidentWebSerial';
import { RunnerStatusIndicator } from './StatusLabels';
import { UsbStationBar, UsbStationErrorBanner } from './UsbStationBar';

function formatRunnerSource(source: RunnerDbSource): string {
  switch (source) {
    case 'EVENTOR_API':
      return 'Eventor API';
    case 'EVENTOR_XML':
      return 'Eventor XML';
    case 'MEOS_CSV':
      return 'MeOS CSV';
    case 'LEARNED_ENTRY':
      return 'Sparad vid anmälan';
  }
}

interface EntriesRegistrationViewProps {
  classes: CompClass[];
  competitors: Competitor[];
  runnerDb: RunnerDbEntry[];
  clubSettings?: ClubSettings;
  enableFeesAndSwish?: boolean;
  serialStatus: SerialConnectionStatus;
  onConnectUsb: () => Promise<void>;
  onConnectWebUsb: () => Promise<void>;
  onDisconnectUsb: () => Promise<void>;
  onSetUsbMode: (mode: UsbStationMode) => void;
  onTriggerStationBeep: () => Promise<void>;
  onClearUsbError: () => void;
  onOpenHardwareSettings?: () => void;
  capturedCard: {
    siNumber: number;
    cardSeries: SICardSeries;
    capturedAt: number;
    mode: UsbStationMode;
  } | null;
  pendingUnknownReadout: {
    siNumber: number;
    checkTimeSec?: number | null;
    startTimeSec?: number | null;
    finishTimeSec?: number | null;
    punches?: CardPunch[];
    suggestedRunner?: RunnerDbEntry | null;
  } | null;
  onClearPendingUnknown: () => void;
  onSimulateCardScanForEntry: () => void;
  onCreateCompetitor: (
    payload: Partial<Competitor> & {
      pendingReadout?: {
        checkTimeSec?: number | null;
        startTimeSec?: number | null;
        finishTimeSec?: number | null;
        punches?: CardPunch[];
      };
    }
  ) => Promise<string | null>;
  onUpdateCompetitor: (id: string, patch: Partial<Competitor>) => Promise<void>;
  onDeleteCompetitor: (id: string) => Promise<void>;
  initialSiNumber?: number | null;
  onInitialSiNumberConsumed?: () => void;
}

export function EntriesRegistrationView({
  classes,
  competitors,
  runnerDb,
  clubSettings,
  enableFeesAndSwish = false,
  serialStatus,
  onConnectUsb,
  onConnectWebUsb,
  onDisconnectUsb,
  onSetUsbMode,
  onTriggerStationBeep,
  onClearUsbError,
  onOpenHardwareSettings,
  capturedCard,
  pendingUnknownReadout,
  onClearPendingUnknown,
  onSimulateCardScanForEntry,
  onCreateCompetitor,
  onUpdateCompetitor,
  onDeleteCompetitor,
  initialSiNumber,
  onInitialSiNumberConsumed,
}: EntriesRegistrationViewProps) {
  const [siInput, setSiInput] = useState('');
  const [fullName, setFullName] = useState('');
  const [nameSuggestionOpen, setNameSuggestionOpen] = useState(false);
  const [activeNameSuggestionIndex, setActiveNameSuggestionIndex] = useState(0);
  const [club, setClub] = useState('');
  const [classId, setClassId] = useState<string>(classes[3]?.id ?? classes[0]?.id ?? '');
  const [isRentalCard, setIsRentalCard] = useState(false);
  const [isBorrowedCard, setIsBorrowedCard] = useState(false);
  const [feePaid, setFeePaid] = useState(false);
  const [startClock, setStartClock] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successNotice, setSuccessNotice] = useState<string | null>(null);
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const lastAutoFilledSiRef = useRef<number | null>(null);

  const rentalFeeExtra = clubSettings?.rentalCardFeeSek ?? 30;
  const defaultEntryFee = clubSettings?.defaultDirectEntryFeeSek ?? 100;
  const selectedFormClass = useMemo(
    () => classes.find((c) => c.id === classId) ?? classes[0] ?? null,
    [classes, classId]
  );
  const formCalculatedFeeSek =
    (selectedFormClass?.feeSek ?? defaultEntryFee) + (isRentalCard ? rentalFeeExtra : 0);

  const nameSuggestions = useMemo(() => {
    const query = fullName
      .trim()
      .toLocaleLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
    if (query.length < 2) return [];
    return runnerDb
      .filter((runner) =>
        runner.fullName
          .toLocaleLowerCase()
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .split(/\s+/)
          .some((part) => part.startsWith(query))
      )
      .slice(0, 8);
  }, [fullName, runnerDb]);

  useEffect(() => {
    if (classes.length > 0 && !classes.some((c) => c.id === classId)) {
      setClassId(classes[0].id);
    }
  }, [classes, classId]);

  useEffect(() => {
    if (initialSiNumber === undefined || initialSiNumber === null) return;
    lastAutoFilledSiRef.current = null;
    setSiInput(String(initialSiNumber));
    onInitialSiNumberConsumed?.();
  }, [initialSiNumber, onInitialSiNumberConsumed]);

  const [search, setSearch] = useState('');

  const numericSiInput = useMemo(() => {
    const cleaned = siInput.replace(/\D/g, '');
    if (!cleaned) return 0;
    const num = Number(cleaned);
    return Number.isFinite(num) ? num : 0;
  }, [siInput]);

  // Instant lookup in MeOS / Eventor Runner Database when SI-card is scanned or typed!
  const matchedRunnerFromDb = useMemo(() => {
    if (numericSiInput < 1000) return null;
    return runnerDb.find((r) => r.siNumber === numericSiInput) ?? null;
  }, [numericSiInput, runnerDb]);

  const alreadyEnteredCompetitor = useMemo(() => {
    if (numericSiInput < 1000) return null;
    return (
      competitors.find(
        (c) =>
          c.siNumber === numericSiInput &&
          (c.status === 'REGISTERED' ||
            c.status === 'CHECKED' ||
            c.status === 'IN_FOREST' ||
            c.status === 'PRELIMINARY_FIN')
      ) ?? null
    );
  }, [numericSiInput, competitors]);

  // Automatically populate runner name, club & default class when an SI number in runnerDb is entered/scanned
  useEffect(() => {
    if (!matchedRunnerFromDb) {
      if (numericSiInput === 0) {
        lastAutoFilledSiRef.current = null;
      }
      return;
    }
    if (lastAutoFilledSiRef.current === matchedRunnerFromDb.siNumber) return;

    lastAutoFilledSiRef.current = matchedRunnerFromDb.siNumber;
    setFullName(matchedRunnerFromDb.fullName);
    setClub(matchedRunnerFromDb.club);
    setIsRentalCard(false);
    setIsBorrowedCard(false);

    if (matchedRunnerFromDb.defaultClassName) {
      const targetCls = classes.find(
        (c) => c.name.toLowerCase() === matchedRunnerFromDb.defaultClassName!.toLowerCase()
      );
      if (targetCls) {
        setClassId(targetCls.id);
      }
    }
  }, [matchedRunnerFromDb, numericSiInput, classes]);

  // Populate SI-number when captured on USB station in Registration mode
  const lastHandledCaptureAtRef = useRef<number>(0);
  useEffect(() => {
    if (!capturedCard || capturedCard.mode !== 'REGISTRATION') return;
    if (lastHandledCaptureAtRef.current === capturedCard.capturedAt) return;
    lastHandledCaptureAtRef.current = capturedCard.capturedAt;

    lastAutoFilledSiRef.current = null;
    setSiInput(String(capturedCard.siNumber));
    const found = runnerDb.find((r) => r.siNumber === capturedCard.siNumber);
    if (found) {
      setSuccessNotice(
        `SI-bricka ${formatSiNumber(capturedCard.siNumber)} avläst — hämtade ${found.fullName} (${found.club}) automatiskt från Löpardatabasen!`
      );
    } else {
      setSuccessNotice(
        `SI-bricka ${formatSiNumber(capturedCard.siNumber)} (${capturedCard.cardSeries}) avläst till anmälan!`
      );
    }
  }, [capturedCard, runnerDb]);

  // Populate SI-number (and suggested runner if any) when linking an unknown read-out card from Finish
  useEffect(() => {
    if (pendingUnknownReadout) {
      lastAutoFilledSiRef.current = null;
      setSiInput(String(pendingUnknownReadout.siNumber));
      if (pendingUnknownReadout.suggestedRunner) {
        setFullName(pendingUnknownReadout.suggestedRunner.fullName);
        setClub(pendingUnknownReadout.suggestedRunner.club);
      }
    }
  }, [pendingUnknownReadout]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const parsedSi = Number(siInput.replace(/\D/g, ''));
    if (!Number.isFinite(parsedSi) || parsedSi <= 0) {
      setError('Ange eller läs av ett giltigt SI-bricknummer.');
      return;
    }
    if (!fullName.trim()) {
      setError('Ange deltagarens för- och efternamn.');
      return;
    }

    setSaving(true);
    setError(null);
    setSuccessNotice(null);

    const allocSec = startClock.trim() ? parseClockToSeconds(startClock) : null;
    const isLinkingUnknown =
      pendingUnknownReadout && pendingUnknownReadout.siNumber === parsedSi;

    const err = await onCreateCompetitor({
      siNumber: parsedSi,
      cardSeries: inferCardSeries(parsedSi),
      fullName: fullName.trim(),
      club: club.trim() || clubSettings?.clubName || 'Klubblös',
      classId: classId || classes[0]?.id,
      isRentalCard,
      isBorrowedCard,
      feePaid: enableFeesAndSwish ? feePaid : false,
      allocatedStartSec: allocSec,
      pendingReadout: isLinkingUnknown ? pendingUnknownReadout : undefined,
    });

    setSaving(false);
    if (err) {
      setError(err);
    } else {
      if (isLinkingUnknown) onClearPendingUnknown();
      setSuccessNotice(
        `${fullName.trim()} anmäld med SI ${formatSiNumber(parsedSi)}${
          isLinkingUnknown
            ? ' — sparade stämplingar validerades direkt!'
            : isBorrowedCard || isRentalCard
            ? ' (lånad/hyrbricka — ägare i Löpardatabasen ändrades ej)!'
            : '!'
        }`
      );
      lastAutoFilledSiRef.current = null;
      setSiInput('');
      setFullName('');
      setClub('');
      setIsRentalCard(false);
      setIsBorrowedCard(false);
      setFeePaid(false);
      setStartClock('');
    }
  };

  const filteredCompetitors = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return competitors;
    return competitors.filter(
      (c) =>
        c.fullName.toLowerCase().includes(q) ||
        c.club.toLowerCase().includes(q) ||
        String(c.siNumber).includes(q) ||
        String(c.bib).includes(q)
    );
  }, [competitors, search]);

  const selectNameSuggestion = (runner: RunnerDbEntry) => {
    setFullName(runner.fullName);
    setClub(runner.club);
    setNameSuggestionOpen(false);
    setActiveNameSuggestionIndex(0);
    if (runner.defaultClassName) {
      const targetClass = classes.find(
        (candidate) =>
          candidate.name.toLocaleLowerCase() === runner.defaultClassName!.toLocaleLowerCase()
      );
      if (targetClass) setClassId(targetClass.id);
    }
  };

  const handleNameInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!nameSuggestionOpen || nameSuggestions.length === 0) {
      if (e.key === 'ArrowDown' && nameSuggestions.length > 0) {
        setNameSuggestionOpen(true);
        setActiveNameSuggestionIndex(0);
        e.preventDefault();
      }
      return;
    }

    if (e.key === 'ArrowDown') {
      setActiveNameSuggestionIndex((index) => (index + 1) % nameSuggestions.length);
      e.preventDefault();
    } else if (e.key === 'ArrowUp') {
      setActiveNameSuggestionIndex(
        (index) => (index - 1 + nameSuggestions.length) % nameSuggestions.length
      );
      e.preventDefault();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      selectNameSuggestion(nameSuggestions[activeNameSuggestionIndex]);
    } else if (e.key === 'Escape') {
      setNameSuggestionOpen(false);
    }
  };

  return (
    <div className="space-y-3.5">
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-2.5">
        <div>
          <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
            Direktanmälan
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Anmäl löpare till den aktuella tävlingen och hantera tävlingsspecifika uppgifter.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <UsbStationBar
            serialStatus={serialStatus}
            roleLabel="Anmälan"
            expectedMode="REGISTRATION"
            onConnectUsb={onConnectUsb}
            onConnectWebUsb={onConnectWebUsb}
            onDisconnectUsb={onDisconnectUsb}
            onSetUsbMode={onSetUsbMode}
            onTriggerBeep={onTriggerStationBeep}
            onClearError={onClearUsbError}
            onOpenHardwareSettings={onOpenHardwareSettings}
          />

          <button
            type="button"
            onClick={onSimulateCardScanForEntry}
            className="px-2.5 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800 rounded-lg transition-colors whitespace-nowrap shrink-0"
          >
            Simulera bricka
          </button>
        </div>
      </div>

      <UsbStationErrorBanner
        serialStatus={serialStatus}
        onConnectWebUsb={onConnectWebUsb}
        onClearError={onClearUsbError}
        onOpenHardwareSettings={onOpenHardwareSettings}
      />

      {/* MeOS Direct Entry Card */}
      <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-3 space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2 pb-2 border-b border-slate-200 dark:border-slate-800">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            Ny direktanmälan / Koppla SI-bricka
          </h2>
          <span className="text-[11px] text-slate-500 dark:text-slate-400">
            Läser bricknummer direkt vid dopp utan att radera eller kräva tömning
          </span>
        </div>

        {pendingUnknownReadout && (
          <div className="px-4 py-3 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900/60 rounded-lg flex items-center justify-between gap-3 text-xs text-amber-800 dark:text-amber-300">
            <span>
              Kopplar utläst SI-bricka{' '}
              <strong className="font-mono">{formatSiNumber(pendingUnknownReadout.siNumber)}</strong>{' '}
              ({pendingUnknownReadout.punches?.length ?? 0} stämplingar i minnet valideras direkt vid
              sparande).
            </span>
            <button
              type="button"
              onClick={onClearPendingUnknown}
              className="underline font-medium shrink-0"
            >
              Rensa
            </button>
          </div>
        )}

        {/* Instant Runner Database Match Banner */}
        {matchedRunnerFromDb && !alreadyEnteredCompetitor && (
          <div className="px-3.5 py-2.5 bg-sky-50 dark:bg-sky-950/40 border border-sky-200 dark:border-sky-900/60 rounded-lg flex flex-wrap items-center justify-between gap-2 text-xs text-sky-900 dark:text-sky-200">
            <div className="flex items-center gap-2 min-w-0">
              <UserCheck className="w-4 h-4 text-sky-700 dark:text-sky-400 shrink-0" />
              <span>
                {isBorrowedCard ? (
                  <>
                    Lånad bricka som i Löpardatabas tillhör{' '}
                    <strong>{matchedRunnerFromDb.fullName}</strong> ({matchedRunnerFromDb.club} behålls
                    som ägare i databasen).
                  </>
                ) : (
                  <>
                    Hittad i Löpardatabas ({formatRunnerSource(matchedRunnerFromDb.source)}):{' '}
                    <strong>{matchedRunnerFromDb.fullName}</strong> · {matchedRunnerFromDb.club}
                    {matchedRunnerFromDb.birthYear ? ` · född ${matchedRunnerFromDb.birthYear}` : ''}
                  </>
                )}
              </span>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {!isBorrowedCard && (
                <button
                  type="button"
                  onClick={() => {
                    setIsBorrowedCard(true);
                    setFullName('');
                    setClub(clubSettings?.clubName || matchedRunnerFromDb.club);
                    setSuccessNotice(null);
                    setTimeout(() => nameInputRef.current?.focus(), 20);
                  }}
                  className="px-2 py-0.5 font-medium bg-white dark:bg-slate-900 text-sky-900 dark:text-sky-200 border border-sky-300 dark:border-sky-700 rounded hover:bg-sky-100/60 dark:hover:bg-slate-800 whitespace-nowrap"
                >
                  Lånad av annan löpare
                </button>
              )}
              <span className="font-mono tabular-nums text-sky-700 dark:text-sky-400">
                SI {formatSiNumber(matchedRunnerFromDb.siNumber)}
              </span>
            </div>
          </div>
        )}

        {alreadyEnteredCompetitor && (
          <div className="px-4 py-2.5 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900/60 rounded-lg text-xs text-amber-800 dark:text-amber-300">
            SI-bricka <strong className="font-mono">{formatSiNumber(alreadyEnteredCompetitor.siNumber)}</strong> är redan
            anmäld på <strong>{alreadyEnteredCompetitor.fullName}</strong> ({alreadyEnteredCompetitor.club}, startnr #
            {alreadyEnteredCompetitor.bib}).
          </div>
        )}

        {error && (
          <div className="px-4 py-2.5 text-xs font-medium text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900/60 rounded-lg">
            {error}
          </div>
        )}

        {successNotice && (
          <div className="px-4 py-2.5 text-xs font-medium text-emerald-800 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900/60 rounded-lg">
            {successNotice}
          </div>
        )}

        <form
          onSubmit={handleSubmit}
          className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2.5 items-end"
        >
          <div>
            <label className="block text-[11px] font-medium text-slate-700 dark:text-slate-300 mb-1">
              SI-bricknummer
            </label>
            <input
              type="text"
              inputMode="numeric"
              value={siInput}
              onChange={(e) => {
                lastAutoFilledSiRef.current = null;
                setSiInput(e.target.value);
              }}
              placeholder="t.ex. 8540219"
              className="w-full px-2.5 py-1.5 text-xs font-mono tabular-nums bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-100"
              required
            />
          </div>

          <div className="relative">
            <label className="block text-[11px] font-medium text-slate-700 dark:text-slate-300 mb-1">
              Löparens namn
            </label>
            <input
              ref={nameInputRef}
              type="text"
              value={fullName}
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={nameSuggestionOpen && nameSuggestions.length > 0}
              aria-controls="direct-entry-runner-suggestions"
              aria-activedescendant={
                nameSuggestionOpen && nameSuggestions.length > 0
                  ? `direct-entry-runner-suggestion-${activeNameSuggestionIndex}`
                  : undefined
              }
              onFocus={() => {
                if (nameSuggestions.length > 0) setNameSuggestionOpen(true);
              }}
              onBlur={() => setNameSuggestionOpen(false)}
              onKeyDown={handleNameInputKeyDown}
              onChange={(e) => {
                setFullName(e.target.value);
                setNameSuggestionOpen(true);
                setActiveNameSuggestionIndex(0);
              }}
              placeholder="Förnamn Efternamn"
              className="w-full px-2.5 py-1.5 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-100"
              required
            />
            {nameSuggestionOpen && nameSuggestions.length > 0 && (
              <div
                id="direct-entry-runner-suggestions"
                role="listbox"
                aria-label="Löpare i databasen"
                className="absolute left-0 right-0 top-full z-30 mt-1 max-h-56 overflow-y-auto rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 py-1 shadow-lg"
              >
                {nameSuggestions.map((runner, index) => (
                  <button
                    id={`direct-entry-runner-suggestion-${index}`}
                    key={`${runner.siNumber}-${runner.id}`}
                    type="button"
                    role="option"
                    aria-selected={index === activeNameSuggestionIndex}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => selectNameSuggestion(runner)}
                    className={`flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left text-xs ${
                      index === activeNameSuggestionIndex
                        ? 'bg-slate-100 dark:bg-slate-800'
                        : 'hover:bg-slate-50 dark:hover:bg-slate-800/70'
                    }`}
                  >
                    <span className="truncate font-medium text-slate-900 dark:text-slate-100">
                      {runner.fullName}
                      <span className="ml-1.5 font-normal text-slate-500 dark:text-slate-400">
                        {runner.club}
                      </span>
                    </span>
                    <span className="shrink-0 font-mono tabular-nums text-[10px] text-slate-500 dark:text-slate-400">
                      SI {formatSiNumber(runner.siNumber)}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div>
            <label className="block text-[11px] font-medium text-slate-700 dark:text-slate-300 mb-1">
              Klubb
            </label>
            <input
              type="text"
              value={club}
              onChange={(e) => setClub(e.target.value)}
              placeholder="t.ex. OK Österåker"
              className="w-full px-2.5 py-1.5 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-100"
            />
          </div>

          <div>
            <label className="block text-[11px] font-medium text-slate-700 dark:text-slate-300 mb-1">
              Klass
            </label>
            <select
              value={classId}
              onChange={(e) => setClassId(e.target.value)}
              className="w-full px-2.5 py-1.5 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-100"
            >
              {classes.map((cls) => (
                <option key={cls.id} value={cls.id}>
                  {cls.name}
                  {enableFeesAndSwish ? ` (${cls.feeSek} kr)` : ''}
                  {cls.freeStart ? ' · Fri start' : ''}
                </option>
              ))}
            </select>
          </div>

          <div>
            <button
              type="submit"
              disabled={saving}
              className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-red-600 hover:bg-red-700 disabled:opacity-50 rounded-lg transition-colors whitespace-nowrap shrink-0"
            >
              <UserPlus className="w-3.5 h-3.5" />
              <span>{saving ? 'Sparar...' : 'Spara anmälan'}</span>
            </button>
          </div>

          <div className="sm:col-span-2 lg:col-span-5 flex flex-wrap items-center gap-x-5 gap-y-2 pt-1">
            <label className="inline-flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={isRentalCard}
                onChange={(e) => setIsRentalCard(e.target.checked)}
                className="w-3.5 h-3.5 rounded border-slate-300 text-red-600 focus:ring-red-600"
              />
              <span>
                {enableFeesAndSwish ? (
                  <>
                    Klubbens hyrbricka (
                    <span className="font-mono tabular-nums">+{rentalFeeExtra} kr</span> · flaggar
                    vid mål)
                  </>
                ) : (
                  'Klubbens hyrbricka (flaggar vid mål)'
                )}
              </span>
            </label>

            <label className="inline-flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={isBorrowedCard}
                onChange={(e) => setIsBorrowedCard(e.target.checked)}
                className="w-3.5 h-3.5 rounded border-slate-300 text-red-600 focus:ring-red-600"
              />
              <span>Lånad privatbricka (ändra ej ägare i Löpardatabas)</span>
            </label>

            {enableFeesAndSwish && (
              <label className="inline-flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={feePaid}
                  onChange={(e) => setFeePaid(e.target.checked)}
                  className="w-3.5 h-3.5 rounded border-slate-300 text-red-600 focus:ring-red-600"
                />
                <span>
                  Betald (<span className="font-mono tabular-nums">{formCalculatedFeeSek} kr</span>{' '}
                  Swish/kontant)
                </span>
              </label>
            )}

            <div className="flex items-center gap-2 text-xs">
              <span className="text-slate-600 dark:text-slate-400">Valfri starttid (HH:MM:SS):</span>
              <input
                type="text"
                value={startClock}
                onChange={(e) => setStartClock(e.target.value)}
                placeholder="t.ex. 10:15:00"
                className="w-28 px-2.5 py-1 text-xs font-mono tabular-nums bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-md"
              />
            </div>
          </div>
        </form>
      </section>

      {/* Current competition entries */}
      <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden">
        <div className="px-3.5 py-2.5 border-b border-slate-200 dark:border-slate-800 flex flex-col lg:flex-row lg:items-center justify-between gap-2.5">
          <span className="text-xs font-medium text-slate-700 dark:text-slate-200">
            Anmälda ({competitors.length})
          </span>
          <div className="relative w-full lg:w-64">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Sök anmäld deltagare, klubb, SI..."
              className="w-full pl-8 pr-2.5 py-1 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg"
            />
          </div>
        </div>

        <div>
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 text-[11px] font-medium text-slate-500 dark:text-slate-400 bg-slate-50/70 dark:bg-slate-950/40">
                  <th className="py-1.5 pl-3.5 pr-2">Löpare · Klubb</th>
                  <th className="py-1.5 px-2">Klass</th>
                  <th className="hidden md:table-cell py-1.5 px-2">SI-bricka</th>
                  <th className="hidden lg:table-cell py-1.5 px-2">Starttid</th>
                  {enableFeesAndSwish && <th className="hidden sm:table-cell py-1.5 px-2">Avgift</th>}
                  <th className="hidden sm:table-cell py-1.5 px-2">Status</th>
                  <th className="py-1.5 pl-2 pr-3.5 text-right">Hantera</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200/80 dark:divide-slate-800/80">
                {filteredCompetitors.map((c) => {
                  const runnerCls = classes.find((cls) => cls.id === c.classId);
                  const runnerFeeSek =
                    (runnerCls?.feeSek ?? defaultEntryFee) +
                    (c.isRentalCard ? rentalFeeExtra : 0);
                  return (
                    <tr
                      key={c.id}
                      className="hover:bg-slate-50/80 dark:hover:bg-slate-800/40 transition-colors"
                    >
                      <td className="py-1.5 pl-3.5 pr-2 max-w-[165px] sm:max-w-none">
                        <div className="flex flex-wrap items-baseline gap-x-1.5 truncate">
                          <span className="font-mono tabular-nums text-slate-500">#{c.bib}</span>
                          <span className="font-medium text-slate-900 dark:text-slate-100 truncate">
                            {c.fullName}
                          </span>
                          <span className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
                            · {c.club}
                          </span>
                        </div>
                      </td>
                      <td className="py-1.5 px-2">
                        <select
                          value={c.classId}
                          onChange={(e) =>
                            void onUpdateCompetitor(c.id, { classId: e.target.value })
                          }
                          aria-label={`Klass för ${c.fullName}`}
                          className="max-w-[100px] sm:max-w-none px-1.5 py-0.5 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded text-slate-900 dark:text-slate-100"
                        >
                          {classes.map((cls) => (
                            <option key={cls.id} value={cls.id}>
                              {cls.name}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="hidden md:table-cell py-1.5 px-2 font-mono tabular-nums whitespace-nowrap">
                        <span className="font-medium text-slate-900 dark:text-slate-100">
                          {formatSiNumber(c.siNumber)}
                        </span>
                        <span className="font-sans text-[11px] text-slate-500 dark:text-slate-400 ml-1">
                          ·{' '}
                          {c.isRentalCard
                            ? c.rentalReturned
                              ? 'Hyr (Åter)'
                              : 'Hyr (Ute)'
                            : c.cardSeries}
                        </span>
                      </td>
                      <td className="hidden lg:table-cell py-1.5 px-2 font-mono tabular-nums whitespace-nowrap text-slate-600 dark:text-slate-400">
                        {formatSecondsAsClock(c.startTimeSec ?? c.allocatedStartSec)}
                      </td>
                      {enableFeesAndSwish && (
                        <td className="hidden sm:table-cell py-1.5 px-2 whitespace-nowrap">
                          <button
                            type="button"
                            onClick={() =>
                              void onUpdateCompetitor(c.id, { feePaid: !c.feePaid })
                            }
                            className={`px-2 py-0.5 text-[11px] font-medium rounded border transition-colors whitespace-nowrap shrink-0 ${
                              c.feePaid
                                ? 'text-emerald-800 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-900/60'
                                : 'text-slate-600 dark:text-slate-300 bg-slate-50 dark:bg-slate-950 border-slate-200 dark:border-slate-800 hover:bg-slate-100 dark:hover:bg-slate-800'
                            }`}
                          >
                            <span className="font-mono tabular-nums">{runnerFeeSek} kr</span> ·{' '}
                            {c.feePaid ? 'Betald' : 'Obet.'}
                          </button>
                        </td>
                      )}
                      <td className="hidden sm:table-cell py-1.5 px-2 whitespace-nowrap">
                        <RunnerStatusIndicator status={c.status} compact />
                      </td>
                      <td className="py-1.5 pl-2 pr-3.5 text-right whitespace-nowrap">
                        {deletingId === c.id ? (
                          <div className="inline-flex items-center gap-1">
                            <button
                              type="button"
                              onClick={async () => {
                                await onDeleteCompetitor(c.id);
                                setDeletingId(null);
                              }}
                              className="px-2 py-0.5 text-[11px] font-medium text-white bg-red-600 rounded whitespace-nowrap shrink-0"
                            >
                              Radera
                            </button>
                            <button
                              type="button"
                              onClick={() => setDeletingId(null)}
                              className="px-1.5 py-0.5 text-[11px] text-slate-600 dark:text-slate-300 whitespace-nowrap shrink-0"
                            >
                              Avbryt
                            </button>
                          </div>
                        ) : (
                          <div className="inline-flex items-center gap-1.5">
                            {c.isRentalCard && !c.rentalReturned && (
                              <button
                                type="button"
                                onClick={() =>
                                  void onUpdateCompetitor(c.id, { rentalReturned: true })
                                }
                                className="inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[11px] font-medium text-amber-800 dark:text-amber-300 border border-amber-300 dark:border-amber-800 rounded whitespace-nowrap shrink-0"
                              >
                                <Check className="w-3 h-3" />
                                <span>Åter</span>
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => setDeletingId(c.id)}
                              className="p-1 text-slate-400 hover:text-red-600 dark:hover:text-red-400 rounded"
                              aria-label={`Ta bort ${c.fullName}`}
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
      </section>
    </div>
  );
}
