import { useMemo, useState } from 'react';
import type { ChangeEvent } from 'react';
import { Check, Download, Pencil, Search, Trash2, Upload, X } from 'lucide-react';
import type { RunnerDbEntry, RunnerDbSource } from '../types/sportident';
import { formatSiNumber } from '../services/sportidentProtocol';
import { exportRunnerDbCsv, parseRunnerDbCsvOrXml } from '../utils/iofXml';

interface RunnerDatabaseViewProps {
  runnerDb: RunnerDbEntry[];
  enteredSiNumbers: number[];
  canSelectForEntry: boolean;
  onSelectForEntry: (siNumber: number) => void;
  onImportRunnerDb: (
    runners: {
      siNumber: number;
      fullName: string;
      club: string;
      birthYear?: number | null;
      defaultClassName?: string | null;
    }[],
    source: RunnerDbSource
  ) => Promise<{ importedCount: number; totalRunnerDb: number }>;
  onUpdateRunnerDbEntry: (
    id: string,
    patch: Pick<RunnerDbEntry, 'siNumber' | 'fullName' | 'club'>
  ) => Promise<void>;
  onDeleteRunnerDbEntry: (id: string) => Promise<void>;
}

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

export function RunnerDatabaseView({
  runnerDb,
  enteredSiNumbers,
  canSelectForEntry,
  onSelectForEntry,
  onImportRunnerDb,
  onUpdateRunnerDbEntry,
  onDeleteRunnerDbEntry,
}: RunnerDatabaseViewProps) {
  const [search, setSearch] = useState('');
  const [feedback, setFeedback] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editSiNumber, setEditSiNumber] = useState('');
  const [editFullName, setEditFullName] = useState('');
  const [editClub, setEditClub] = useState('');
  const [savingId, setSavingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const filteredRunnerDb = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    if (!query) return runnerDb;
    return runnerDb.filter(
      (runner) =>
        runner.fullName.toLocaleLowerCase().includes(query) ||
        runner.club.toLocaleLowerCase().includes(query) ||
        String(runner.siNumber).includes(query) ||
        (runner.defaultClassName?.toLocaleLowerCase().includes(query) ?? false)
    );
  }, [runnerDb, search]);
  const enteredSiNumberSet = useMemo(
    () => new Set(enteredSiNumbers),
    [enteredSiNumbers]
  );

  const handleImport = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = parseRunnerDbCsvOrXml(text);
      if (parsed.length === 0) {
        setFeedback(
          'Hittade inga giltiga rader med SI-bricknummer. Använd Eventor CompetitorList XML eller CSV (SI;Namn;Klubb).'
        );
      } else {
        const source = text.trim().startsWith('<') ? 'EVENTOR_XML' : 'MEOS_CSV';
        const result = await onImportRunnerDb(parsed, source);
        setFeedback(
          `Importerade ${result.importedCount} löpare med SI-bricka till Löpardatabasen (totalt ${result.totalRunnerDb} poster).`
        );
      }
    } catch (error: unknown) {
      setFeedback(error instanceof Error ? error.message : 'Kunde inte läsa filen.');
    }
    event.target.value = '';
  };

  const beginEdit = (runner: RunnerDbEntry) => {
    setEditingId(runner.id);
    setEditSiNumber(String(runner.siNumber));
    setEditFullName(runner.fullName);
    setEditClub(runner.club);
  };

  const saveEdit = async (runner: RunnerDbEntry) => {
    const siNumber = Number(editSiNumber.trim());
    const fullName = editFullName.trim();
    const club = editClub.trim();
    if (!Number.isInteger(siNumber) || siNumber < 1 || siNumber > 99999999) {
      setFeedback('Ange ett giltigt SI-bricknummer.');
      return;
    }
    if (!fullName) {
      setFeedback('Löparens namn får inte vara tomt.');
      return;
    }
    if (
      siNumber !== runner.siNumber &&
      runnerDb.some((candidate) => candidate.siNumber === siNumber)
    ) {
      setFeedback('SI-bricknumret finns redan i löpardatabasen.');
      return;
    }
    setSavingId(runner.id);
    try {
      await onUpdateRunnerDbEntry(runner.id, {
        siNumber,
        fullName,
        club: club || 'Klubblös',
      });
      setFeedback('Löparuppgifterna har sparats.');
      setEditingId(null);
    } catch (error: unknown) {
      setFeedback(error instanceof Error ? error.message : 'Kunde inte spara löparuppgifterna.');
    } finally {
      setSavingId(null);
    }
  };

  const deleteRunner = async (runner: RunnerDbEntry) => {
    setDeletingId(runner.id);
    try {
      await onDeleteRunnerDbEntry(runner.id);
      setFeedback(`${runner.fullName} har tagits bort från löpardatabasen.`);
    } catch (error: unknown) {
      setFeedback(error instanceof Error ? error.message : 'Kunde inte ta bort löparen.');
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="space-y-3.5">
      <header>
        <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
          Löpardatabas
        </h1>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Klubbens centrala personregister med SI-brickor och Eventor-/MeOS-data.
        </p>
      </header>

      <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden">
        <div className="px-3.5 py-2.5 border-b border-slate-200 dark:border-slate-800 flex flex-col lg:flex-row lg:items-center justify-between gap-2.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <label className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 rounded-lg cursor-pointer whitespace-nowrap">
              <Upload className="w-3.5 h-3.5" />
              <span>Importera Eventor/MeOS</span>
              <input
                type="file"
                accept=".csv,.txt,.xml,text/csv,text/xml,application/xml"
                onChange={(event) => void handleImport(event)}
                className="hidden"
              />
            </label>
            <button
              type="button"
              onClick={() => exportRunnerDbCsv(runnerDb)}
              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 rounded-lg whitespace-nowrap"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Exportera CSV</span>
            </button>
            <span className="text-xs text-slate-500">{runnerDb.length} löpare</span>
          </div>
          <div className="relative w-full lg:w-64">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Sök namn, klubb eller SI-nummer..."
              className="w-full pl-8 pr-2.5 py-1 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg"
            />
          </div>
        </div>

        {feedback && (
          <div className="px-3.5 py-2 bg-slate-50 dark:bg-slate-950/60 border-b border-slate-200 dark:border-slate-800 text-xs text-slate-700 dark:text-slate-300">
            {feedback}
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800 text-[11px] font-medium text-slate-500 dark:text-slate-400 bg-slate-50/70 dark:bg-slate-950/40">
                <th className="py-2 pl-3.5 pr-2">SI-bricka</th>
                <th className="py-2 px-2">Löpare & Klubb</th>
                <th className="hidden sm:table-cell py-2 px-2">Klass</th>
                <th className="hidden md:table-cell py-2 px-2">Källa</th>
                <th className="py-2 pl-2 pr-3.5 text-right">Åtgärd</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200/80 dark:divide-slate-800/80">
              {filteredRunnerDb.map((runner) => {
                const isEditing = editingId === runner.id;
                return (
                  <tr
                    key={runner.id}
                    className="hover:bg-slate-50/80 dark:hover:bg-slate-800/40 transition-colors"
                  >
                    <td className="py-1.5 pl-3.5 pr-2 font-mono tabular-nums whitespace-nowrap">
                      {isEditing ? (
                        <input
                          aria-label={`SI-bricka för ${runner.fullName}`}
                          value={editSiNumber}
                          onChange={(event) => setEditSiNumber(event.target.value)}
                          className="w-24 px-1.5 py-1 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded"
                        />
                      ) : (
                        <>
                          <span className="font-medium text-slate-900 dark:text-slate-100">
                            {formatSiNumber(runner.siNumber)}
                          </span>
                          <span className="hidden sm:inline text-slate-400 mx-1" aria-hidden="true">
                            ·
                          </span>
                          <span className="hidden sm:inline font-sans text-slate-500 dark:text-slate-400">
                            {runner.cardSeries}
                          </span>
                        </>
                      )}
                    </td>
                    <td className="py-1.5 px-2 max-w-[150px] sm:max-w-[260px]">
                      {isEditing ? (
                        <div className="flex flex-col gap-1">
                          <input
                            aria-label={`Namn för ${runner.fullName}`}
                            value={editFullName}
                            onChange={(event) => setEditFullName(event.target.value)}
                            className="w-full min-w-32 px-1.5 py-1 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded"
                          />
                          <input
                            aria-label={`Klubb för ${runner.fullName}`}
                            value={editClub}
                            onChange={(event) => setEditClub(event.target.value)}
                            className="w-full min-w-32 px-1.5 py-1 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded"
                          />
                        </div>
                      ) : (
                        <div className="flex items-baseline gap-1.5 min-w-0 truncate">
                          <span className="font-medium text-slate-900 dark:text-slate-100 truncate">
                            {runner.fullName}
                          </span>
                          {runner.birthYear && (
                            <span className="hidden sm:inline text-slate-500 dark:text-slate-400 font-mono tabular-nums shrink-0">
                              ({runner.birthYear})
                            </span>
                          )}
                          <span className="text-slate-300 dark:text-slate-700 shrink-0" aria-hidden="true">
                            ·
                          </span>
                          <span className="text-slate-500 dark:text-slate-400 truncate">
                            {runner.club}
                          </span>
                        </div>
                      )}
                    </td>
                    <td className="hidden sm:table-cell py-1.5 px-2 text-slate-600 dark:text-slate-400 whitespace-nowrap">
                      {runner.defaultClassName ?? '—'}
                    </td>
                    <td className="hidden md:table-cell py-1.5 px-2 text-slate-500 dark:text-slate-400 whitespace-nowrap">
                      {formatRunnerSource(runner.source)}
                    </td>
                    <td className="py-1.5 pl-2 pr-3.5 text-right whitespace-nowrap">
                      {isEditing ? (
                        <div className="inline-flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => void saveEdit(runner)}
                            disabled={savingId === runner.id}
                            className="p-1 text-emerald-700 hover:text-emerald-900 disabled:opacity-50 dark:text-emerald-400"
                            aria-label={`Tillämpa ändringar för ${runner.fullName}`}
                          >
                            <Check className="w-4 h-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditingId(null)}
                            disabled={savingId === runner.id}
                            className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                            aria-label="Avbryt redigering"
                          >
                            <X className="w-4 h-4" />
                          </button>
                        </div>
                      ) : (
                        <div className="inline-flex items-center gap-1">
                          {canSelectForEntry &&
                            (enteredSiNumberSet.has(runner.siNumber) ? (
                              <span className="text-[11px] text-slate-400 dark:text-slate-500">
                                Anmäld
                              </span>
                            ) : (
                              <button
                                type="button"
                                onClick={() => onSelectForEntry(runner.siNumber)}
                                className="text-xs font-medium text-red-600 dark:text-red-400 hover:underline whitespace-nowrap"
                              >
                                Välj till anmälan
                              </button>
                            ))}
                          <button
                            type="button"
                            onClick={() => beginEdit(runner)}
                            className="p-1 text-slate-400 hover:text-blue-700 dark:hover:text-blue-300 rounded"
                            aria-label={`Redigera ${runner.fullName}`}
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => void deleteRunner(runner)}
                            disabled={deletingId === runner.id}
                            className="p-1 text-slate-400 hover:text-red-600 disabled:opacity-50 dark:hover:text-red-400 rounded"
                            aria-label={`Ta bort ${runner.fullName} ur löpardatabasen`}
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
