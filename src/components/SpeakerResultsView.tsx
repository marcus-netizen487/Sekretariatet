import React, { useMemo, useState } from 'react';
import { Check, Copy, Download, ExternalLink, FileCode, Mic } from 'lucide-react';
import type {
  CompClass,
  CompetitionMeta,
  Competitor,
  Course,
  SIStation,
} from '../types/sportident';
import { formatDurationMmSs } from '../services/sportidentProtocol';
import { SplitsAnalysisTable } from './SplitsAnalysisTable';
import { RunnerSplitCardModal } from './RunnerSplitCardModal';
import {
  buildIofResultListXml,
  exportClassResultsCsv,
  triggerTextFileDownload,
} from '../utils/iofXml';

interface SpeakerResultsViewProps {
  competition: CompetitionMeta;
  courses: Course[];
  classes: CompClass[];
  competitors: Competitor[];
  stations: SIStation[];
  onOpenPublicPortal?: () => void;
}

export function SpeakerResultsView({
  competition,
  courses,
  classes,
  competitors,
  stations,
  onOpenPublicPortal,
}: SpeakerResultsViewProps) {
  const [selectedClassId, setSelectedClassId] = useState<string>('ALL');
  const [inspectedRunner, setInspectedRunner] = useState<Competitor | null>(null);
  const [copiedLivelox, setCopiedLivelox] = useState<boolean>(false);
  const prewarningStations = stations.filter(
    (station) => station.active && station.stationFunction === 'PREWARNING'
  );
  const prewarningLabel =
    prewarningStations.length > 0
      ? prewarningStations.map((station) => `(${station.stationCode}) ${station.name}`).join(', ')
      : 'inga förvarningskontroller konfigurerade';

  // Incoming runners are identified by configured prewarning stations, not a control code.
  const incomingRunners = useMemo(() => {
    return competitors
      .filter(
        (c) =>
          c.status === 'PRELIMINARY_FIN' ||
          (c.status === 'IN_FOREST' && c.radioSplits.some((r) => r.isPrewarning))
      )
      .sort((a, b) => (b.lastSeenTimeSec ?? 0) - (a.lastSeenTimeSec ?? 0));
  }, [competitors]);

  const handleDownloadIofXml = () => {
    const xml = buildIofResultListXml({
      competition,
      classes,
      courses,
      competitors,
    });
    triggerTextFileDownload(
      `iof-resultat-3.0-${competition.date}.xml`,
      xml,
      'application/xml;charset=utf-8;'
    );
  };

  const handleCopyLiveloxUrl = async () => {
    if (typeof window === 'undefined') return;
    const code = competition.shortCode || competition.id || 'oko26a';
    const url = `${window.location.origin}/api/public/events/${code}/iof-results`;
    try {
      await navigator.clipboard.writeText(url);
      setCopiedLivelox(true);
      setTimeout(() => setCopiedLivelox(false), 2400);
    } catch {
      // ignore
    }
  };

  return (
    <div className="space-y-3.5">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-2.5">
        <div>
          <h1 className="text-lg font-display font-bold text-slate-900 dark:text-slate-100">
            Speakerstöd & Sträcktidsanalys (Idealtid & Bomtid)
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Klicka på en löpare för individuellt löparkort och schematisk bankarta, eller se sträcktider och bomtid per kontroll.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {onOpenPublicPortal && (
            <button
              type="button"
              onClick={onOpenPublicPortal}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800 rounded-lg transition-colors whitespace-nowrap shrink-0"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              <span>Publikvy</span>
            </button>
          )}

          <button
            type="button"
            onClick={() => void handleCopyLiveloxUrl()}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800 rounded-lg transition-colors whitespace-nowrap shrink-0"
          >
            {copiedLivelox ? (
              <Check className="w-3.5 h-3.5 text-emerald-600" />
            ) : (
              <Copy className="w-3.5 h-3.5" />
            )}
            <span>{copiedLivelox ? 'Kopierad' : 'Livelox-URL'}</span>
          </button>

          <button
            type="button"
            onClick={handleDownloadIofXml}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-white bg-red-600 hover:bg-red-700 rounded-lg transition-colors whitespace-nowrap shrink-0"
          >
            <FileCode className="w-3.5 h-3.5" />
            <span>IOF XML 3.0</span>
          </button>

          <button
            type="button"
            onClick={() => exportClassResultsCsv(competitors, classes)}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800 rounded-lg transition-colors whitespace-nowrap shrink-0"
          >
            <Download className="w-3.5 h-3.5" />
            <span>CSV</span>
          </button>
        </div>
      </div>

      <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden">
        <div className="px-3.5 py-2 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-3 bg-slate-50/50 dark:bg-slate-950/40">
          <div className="flex items-center gap-2 min-w-0">
            <Mic className="w-3.5 h-3.5 text-red-600 dark:text-red-400 shrink-0" />
            <h2 className="text-xs font-semibold text-slate-900 dark:text-slate-100 truncate">
              Speakerbevakning — Förvarning ({prewarningLabel}) & preliminärt i mål
            </h2>
          </div>
          <span className="text-[11px] text-slate-500 dark:text-slate-400 font-mono tabular-nums shrink-0">
            {incomingRunners.length} aktiva
          </span>
        </div>

        {incomingRunners.length === 0 ? (
          <p className="px-3.5 py-2 text-xs text-slate-500 dark:text-slate-400">
            Inga löpare har stämplat vid en konfigurerad förvarningskontroll eller gått i preliminärt mål.
          </p>
        ) : (
          <div className="divide-y divide-slate-200/80 dark:divide-slate-800/80 text-xs">
            {incomingRunners.map((r) => {
              const cls = classes.find((c) => c.id === r.classId)?.name ?? '-';
              const preSplit = r.radioSplits.find((s) => s.isPrewarning);
              const isSelected = inspectedRunner?.id === r.id;
              return (
                <button
                  key={r.id}
                  type="button"
                  onClick={() =>
                    setInspectedRunner((prev) => (prev?.id === r.id ? null : r))
                  }
                  className={`w-full text-left px-3.5 py-1.5 transition-colors flex items-center justify-between gap-2 ${
                    isSelected
                      ? 'bg-slate-100/90 dark:bg-slate-800/70'
                      : 'hover:bg-slate-50 dark:hover:bg-slate-800/40'
                  }`}
                >
                  <div className="min-w-0 truncate">
                    <span className="font-semibold text-slate-900 dark:text-slate-100">
                      #{r.bib} {r.fullName}
                    </span>
                    <span className="text-[11px] text-slate-500 dark:text-slate-400 ml-1.5">
                      {cls} · {r.club}
                    </span>
                  </div>
                  <div className="text-right shrink-0 font-mono tabular-nums whitespace-nowrap">
                    {r.status === 'PRELIMINARY_FIN' ? (
                      <span className="font-semibold text-sky-700 dark:text-sky-400">
                        Prel. mål {formatDurationMmSs(r.runningTimeSec)}
                      </span>
                    ) : (
                      <span className="font-semibold text-amber-700 dark:text-amber-400">
                        {preSplit?.stationName} ·{' '}
                        {formatDurationMmSs(preSplit?.runningTimeSec ?? null)}
                      </span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        )}

        {inspectedRunner && (
          <div className="p-3 border-t border-slate-200 dark:border-slate-800">
            <RunnerSplitCardModal
              runner={inspectedRunner}
              compClass={classes.find((c) => c.id === inspectedRunner.classId) ?? null}
              course={
                courses.find(
                  (crs) =>
                    crs.id ===
                    (inspectedRunner.validation?.matchedCourseId ??
                      classes.find((c) => c.id === inspectedRunner.classId)?.courseId)
                ) ?? null
              }
              classCompetitors={competitors.filter(
                (c) => c.classId === inspectedRunner.classId
              )}
              onClose={() => setInspectedRunner(null)}
            />
          </div>
        )}
      </section>

      <SplitsAnalysisTable
        classes={classes}
        courses={courses}
        competitors={competitors}
        radioControls={stations}
        selectedClassId={selectedClassId}
        onSelectClassId={setSelectedClassId}
        liveUpdates
        liveUpdateScope={competition.id}
      />
    </div>
  );
}
