import React, { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Binary,
  Clock,
  ExternalLink,
  Pencil,
  Plus,
  Radio,
  RefreshCw,
  Sliders,
  Smartphone,
  Trash2,
  Usb,
  Volume2,
  Wrench,
  X,
} from 'lucide-react';
import type {
  CompClass,
  CompetitionMeta,
  Competitor,
  Course,
  EmergencySettings,
  HardwareModel,
  RocIntegrationStatus,
  SIStation,
  StationFunction,
} from '../types/sportident';
import type { SerialConnectionStatus, UsbStationMode } from '../services/sportidentWebSerial';
import { formatStationFunctionLabel } from './StatusLabels';

interface HardwareStationsViewProps {
  isAdmin?: boolean;
  competition: CompetitionMeta;
  courses: Course[];
  classes: CompClass[];
  competitors: Competitor[];
  emergency: EmergencySettings;
  roc: RocIntegrationStatus;
  stations: SIStation[];
  serialStatus: SerialConnectionStatus;
  onUpdateEmergency: (patch: Partial<EmergencySettings>) => Promise<{
    recalculatedCount: number;
  }>;
  onRecalculateAll: () => Promise<{ recalculatedCount: number }>;
  onAssignManualFinish: (params: {
    competitorId: string;
    finishClockStr: string;
  }) => Promise<string | null>;
  onUpdateRocSettings: (patch: Partial<RocIntegrationStatus>) => Promise<void>;
  onPollRocNow: () => Promise<{ ingested: number; error: string | null }>;
  onSimulateRocBatch: () => Promise<{ ingested: number; samplePayload: string }>;
  onConnectUsb: (baudRate: 38400 | 4800) => Promise<void>;
  onConnectWebUsb: (baudRate: 38400 | 4800) => Promise<void>;
  onDisconnectUsb: () => Promise<void>;
  onSetUsbMode: (mode: UsbStationMode) => void;
  onSetBaudRate: (baud: 38400 | 4800) => void;
  onSendDirectMode: () => Promise<void>;
  onRequestSysConfig: () => Promise<void>;
  onTriggerStationBeep: () => Promise<void>;
  onCreateStation: (payload: Partial<SIStation>) => Promise<string | null>;
  onSaveStation: (payload: Partial<SIStation>) => Promise<string | null>;
  onDeleteStation: (id: string) => Promise<void>;
  onOpenProtocolInspector?: () => void;
}

const HARDWARE_MODELS: HardwareModel[] = [
  'BSM8-USB',
  'BSM7-USB',
  'SRR-USB (Air+)',
  'BSF9 Master',
  'BSF8 Master',
];

const STATION_FUNCTIONS: StationFunction[] = [
  'CHECK',
  'START',
  'RADIO',
  'PREWARNING',
  'FINISH',
  'READOUT',
  'CLEAR',
];

export function HardwareStationsView({
  isAdmin = true,
  competition,
  courses,
  classes,
  competitors,
  emergency,
  roc,
  stations,
  serialStatus,
  onUpdateEmergency,
  onRecalculateAll,
  onAssignManualFinish,
  onUpdateRocSettings,
  onPollRocNow,
  onSimulateRocBatch,
  onConnectUsb,
  onConnectWebUsb,
  onDisconnectUsb,
  onSetUsbMode,
  onSetBaudRate,
  onSendDirectMode,
  onRequestSysConfig,
  onTriggerStationBeep,
  onCreateStation,
  onSaveStation,
  onDeleteStation,
  onOpenProtocolInspector,
}: HardwareStationsViewProps) {
  // New station modal
  const [modalOpen, setModalOpen] = useState(false);
  const [stationCode, setStationCode] = useState('73');
  const [stationName, setStationName] = useState('');
  const [hardwareModel, setHardwareModel] = useState<HardwareModel>('BSM8-USB');
  const [stationFunction, setStationFunction] = useState<StationFunction>('RADIO');
  const [editingStationId, setEditingStationId] = useState<string | null>(null);
  const [stationErr, setStationErr] = useState<string | null>(null);
  const stationFormRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (modalOpen) {
      stationFormRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [modalOpen, editingStationId]);

  // Emergency Form State
  const [brokenCodeInput, setBrokenCodeInput] = useState<string>('');
  const [offsetCodeInput, setOffsetCodeInput] = useState<string>('');
  const [offsetSecInput, setOffsetSecInput] = useState<number>(0);
  const [manualRunnerId, setManualRunnerId] = useState<string>(competitors[0]?.id ?? '');
  const [manualFinishClock, setManualFinishClock] = useState<string>('11:45:00');
  const [emergencyBusy, setEmergencyBusy] = useState(false);
  const [emergencyFeedback, setEmergencyFeedback] = useState<{ ok: boolean; msg: string } | null>(
    null
  );

  // ROC Form State
  const [rocPassId, setRocPassId] = useState(roc.unitId ?? '');
  const [rocAutoPoll, setRocAutoPoll] = useState(roc.enabled);
  const [rocBusy, setRocBusy] = useState(false);
  const [rocFeedback, setRocFeedback] = useState<{ ok: boolean; msg: string } | null>(null);

  const handleCreateStationSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setStationErr(null);
    try {
      const payload: Partial<SIStation> = {
        ...(editingStationId ? { id: editingStationId } : {}),
        stationCode: Number(stationCode),
        name: stationName.trim(),
        hardwareModel,
        stationFunction,
        baudRate: 38400,
      };
      const err = editingStationId
        ? await onSaveStation(payload)
        : await onCreateStation(payload);
      if (err) {
        setStationErr(err);
      } else {
        setStationName('');
        setEditingStationId(null);
        setModalOpen(false);
      }
    } catch (error) {
      setStationErr(
        error instanceof Error ? error.message : 'Kunde inte spara stationen.'
      );
    }
  };

  const handleEditStation = (station: SIStation) => {
    setEditingStationId(station.id);
    setStationCode(String(station.stationCode));
    setStationName(station.name);
    setHardwareModel(station.hardwareModel);
    setStationFunction(station.stationFunction);
    setStationErr(null);
    setModalOpen(true);
  };

  const handleOpenNewStation = () => {
    setEditingStationId(null);
    setStationCode('73');
    setStationName('');
    setHardwareModel('BSM8-USB');
    setStationFunction('RADIO');
    setStationErr(null);
    setModalOpen(true);
  };

  const handleAddBrokenControl = async (e: React.FormEvent) => {
    e.preventDefault();
    const code = Number(brokenCodeInput);
    if (!Number.isFinite(code) || code <= 0) return;
    if (emergency.brokenControls.includes(code)) return;
    setEmergencyBusy(true);
    setEmergencyFeedback(null);
    try {
      const next = [...emergency.brokenControls, code].sort((a, b) => a - b);
      const res = await onUpdateEmergency({ brokenControls: next });
      setBrokenCodeInput('');
      setEmergencyFeedback({
        ok: true,
        msg: `Kontroll ${code} är nu undantagen (ur funktion). Räknade om ${res.recalculatedCount} avlästa brickor.`,
      });
    } finally {
      setEmergencyBusy(false);
    }
  };

  const handleRemoveBrokenControl = async (code: number) => {
    setEmergencyBusy(true);
    setEmergencyFeedback(null);
    try {
      const next = emergency.brokenControls.filter((c) => c !== code);
      const res = await onUpdateEmergency({ brokenControls: next });
      setEmergencyFeedback({
        ok: true,
        msg: `Kontroll ${code} återaktiverad. Räknade om ${res.recalculatedCount} avlästa brickor.`,
      });
    } finally {
      setEmergencyBusy(false);
    }
  };

  const handleSetTimeOffset = async (e: React.FormEvent) => {
    e.preventDefault();
    const code = Number(offsetCodeInput);
    if (!Number.isFinite(code) || code <= 0) return;
    setEmergencyBusy(true);
    setEmergencyFeedback(null);
    try {
      const nextOffsets = { ...emergency.controlTimeOffsets };
      if (offsetSecInput === 0) {
        delete nextOffsets[String(code)];
      } else {
        nextOffsets[String(code)] = offsetSecInput;
      }
      const res = await onUpdateEmergency({ controlTimeOffsets: nextOffsets });
      setEmergencyFeedback({
        ok: true,
        msg: `Tidsjustering på ${offsetSecInput > 0 ? `+${offsetSecInput}` : offsetSecInput}s satt för kontroll ${code}. Räknade om ${res.recalculatedCount} brickor.`,
      });
    } finally {
      setEmergencyBusy(false);
    }
  };

  const handleRemoveOffset = async (codeStr: string) => {
    setEmergencyBusy(true);
    setEmergencyFeedback(null);
    try {
      const nextOffsets = { ...emergency.controlTimeOffsets };
      delete nextOffsets[codeStr];
      const res = await onUpdateEmergency({ controlTimeOffsets: nextOffsets });
      setEmergencyFeedback({
        ok: true,
        msg: `Tidsjustering borttagen för kontroll ${codeStr}. Räknade om ${res.recalculatedCount} brickor.`,
      });
    } finally {
      setEmergencyBusy(false);
    }
  };

  const handleManualFinishSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const targetId = manualRunnerId || competitors[0]?.id;
    if (!targetId) return;
    setEmergencyBusy(true);
    setEmergencyFeedback(null);
    try {
      const err = await onAssignManualFinish({
        competitorId: targetId,
        finishClockStr: manualFinishClock,
      });
      if (err) {
        setEmergencyFeedback({ ok: false, msg: err });
      } else {
        const r = competitors.find((c) => c.id === targetId);
        setEmergencyFeedback({
          ok: true,
          msg: `Manuell måltid (${manualFinishClock}) registrerad för ${r?.fullName ?? 'löpare'}.`,
        });
      }
    } finally {
      setEmergencyBusy(false);
    }
  };

  const handleRecalcClick = async () => {
    setEmergencyBusy(true);
    setEmergencyFeedback(null);
    try {
      const res = await onRecalculateAll();
      setEmergencyFeedback({
        ok: true,
        msg: `Räknade om ${res.recalculatedCount} utlästa SI-brickor från arkiverad rådata mot aktuella banor och inställningar.`,
      });
    } finally {
      setEmergencyBusy(false);
    }
  };

  const handleSaveRocPassId = async (e: React.FormEvent) => {
    e.preventDefault();
    await onUpdateRocSettings({ unitId: rocPassId.trim() });
    setRocFeedback({ ok: true, msg: 'ROC Passnings-ID sparat!' });
  };

  const handleToggleRocAuto = async () => {
    const next = !rocAutoPoll;
    setRocAutoPoll(next);
    await onUpdateRocSettings({ enabled: next });
  };

  const handlePollRoc = async () => {
    setRocBusy(true);
    setRocFeedback(null);
    try {
      const res = await onPollRocNow();
      if (res.error) {
        setRocFeedback({ ok: false, msg: res.error });
      } else {
        setRocFeedback({
          ok: true,
          msg: `ROC-hämtning klar: ${res.ingested} nya stämplingar mottagna.`,
        });
      }
    } finally {
      setRocBusy(false);
    }
  };

  const handleSimulateRoc = async () => {
    setRocBusy(true);
    setRocFeedback(null);
    try {
      const res = await onSimulateRocBatch();
      setRocFeedback({
        ok: true,
        msg: `Simulerade ROC: ${res.ingested} radiostämplingar injicerade.`,
      });
    } finally {
      setRocBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
        <div>
          <h1 className="text-lg sm:text-xl font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-2">
            <Radio className="w-5 h-5 text-red-600 dark:text-red-400" />
            <span>SportIdent, ROC & USB</span>
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            SPORTident USB-avläsare, nödlägen i skogen & omräkning, ROC-radiokontroller samt hårdvarustationer.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 self-start sm:self-auto">
          {onOpenProtocolInspector && (
            <button
              type="button"
              onClick={onOpenProtocolInspector}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800 rounded-lg transition-colors whitespace-nowrap"
            >
              <Binary className="w-3.5 h-3.5" />
              <span>Protokollinspektör</span>
            </button>
          )}

        </div>
      </div>

      {modalOpen && (
        <section
          ref={stationFormRef}
          className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden"
        >
          <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200 dark:border-slate-800">
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              {editingStationId
                ? 'Ändra SI-station / Radiokontroll'
                : 'Lägg till SI-station / Radiokontroll'}
            </h2>
            <button
              type="button"
              onClick={() => setModalOpen(false)}
              className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 rounded-lg"
              aria-label="Stäng"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          <form onSubmit={handleCreateStationSubmit} className="p-4 space-y-3">
            {stationErr && (
              <div className="px-3 py-1.5 text-xs text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900/60 rounded-lg">
                {stationErr}
              </div>
            )}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Kod (CN)
                </label>
                <input
                  type="number"
                  min={1}
                  max={511}
                  value={stationCode}
                  onChange={(e) => setStationCode(e.target.value)}
                  className="w-full px-2.5 py-1.5 text-xs font-mono bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg"
                  required
                />
              </div>
              <div className="col-span-2">
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Namn / Placering
                </label>
                <input
                  type="text"
                  placeholder="t.ex. Målstation 1 eller Radiokontroll 33"
                  value={stationName}
                  onChange={(e) => setStationName(e.target.value)}
                  className="w-full px-2.5 py-1.5 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg"
                  required
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Funktion
                </label>
                <select
                  value={stationFunction}
                  onChange={(e) => setStationFunction(e.target.value as StationFunction)}
                  className="w-full px-2.5 py-1.5 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg"
                >
                  {STATION_FUNCTIONS.map((f) => (
                    <option key={f} value={f}>
                      {formatStationFunctionLabel(f)}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2 border-t border-slate-100 dark:border-slate-800">
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                className="px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg"
              >
                Avbryt
              </button>
              <button
                type="submit"
                className="px-3.5 py-1.5 text-xs font-medium text-white bg-red-600 hover:bg-red-700 rounded-lg"
              >
                {editingStationId ? 'Spara ändringar' : 'Lägg till station'}
              </button>
            </div>
          </form>
        </section>
      )}

      {/* 1. SPORTident USB-avläsare — Web Serial & WebUSB CP210x (Android OTG) */}
      <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 sm:p-5 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 pb-3 border-b border-slate-100 dark:border-slate-800">
          <div>
            <div className="flex items-center gap-2">
              <Usb className="w-4 h-4 text-slate-700 dark:text-slate-300 shrink-0" />
              <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                SPORTident USB-avläsare — Web Serial & WebUSB CP210x (Android OTG)
              </h2>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Koppla USB-master (BSM7, BSM8, SRR) direkt i Chrome/Edge på PC, Mac eller Android OTG.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <span
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${
                serialStatus.connected
                  ? 'bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-900'
                  : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-700'
              }`}
            >
              <span
                className={`w-2 h-2 rounded-full ${
                  serialStatus.connected ? 'bg-emerald-500 animate-pulse' : 'bg-slate-400'
                }`}
              />
              <span>{serialStatus.connected ? 'USB Ansluten' : 'Ingen enhet ansluten'}</span>
            </span>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Connection Controls */}
          <div className="p-3.5 bg-slate-50 dark:bg-slate-950/50 rounded-lg border border-slate-200 dark:border-slate-800 space-y-3">
            <h3 className="text-xs font-semibold text-slate-800 dark:text-slate-200 uppercase tracking-wider">
              Anslut SPORTident-hårdvara
            </h3>
            <div className="flex flex-wrap items-center gap-2">
              {!serialStatus.connected ? (
                <>
                  <button
                    type="button"
                    onClick={() => void onConnectUsb(38400)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-slate-900 dark:bg-slate-100 dark:text-slate-900 hover:bg-slate-800 rounded-lg transition-colors whitespace-nowrap"
                  >
                    <Usb className="w-3.5 h-3.5" />
                    <span>Web Serial (38400 baud)</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => void onConnectUsb(4800)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors whitespace-nowrap"
                  >
                    <span>Äldre enhet (4800 baud)</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => void onConnectWebUsb(38400)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors whitespace-nowrap"
                  >
                    <Smartphone className="w-3.5 h-3.5" />
                    <span>Android WebUSB (OTG)</span>
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => void onDisconnectUsb()}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-red-600 hover:bg-red-700 rounded-lg transition-colors whitespace-nowrap"
                  >
                    <X className="w-3.5 h-3.5" />
                    <span>Koppla från USB</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => void onTriggerStationBeep()}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors whitespace-nowrap"
                  >
                    <Volume2 className="w-3.5 h-3.5" />
                    <span>Skicka test-pip</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => void onRequestSysConfig()}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors whitespace-nowrap"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    <span>Läs stationsinfo</span>
                  </button>
                </>
              )}
            </div>
            {serialStatus.error && (
              <p className="text-xs text-red-600 dark:text-red-400 font-medium">
                {serialStatus.error}
              </p>
            )}
          </div>

          {/* Mode & Station Info */}
          <div className="p-3.5 bg-slate-50 dark:bg-slate-950/50 rounded-lg border border-slate-200 dark:border-slate-800 space-y-3">
            <h3 className="text-xs font-semibold text-slate-800 dark:text-slate-200 uppercase tracking-wider">
              Arbetsläge för USB-enheten
            </h3>
            <div className="grid grid-cols-3 gap-2">
              <button
                type="button"
                onClick={() => onSetUsbMode('READOUT')}
                className={`px-2.5 py-1.5 text-xs font-medium rounded-lg border text-center transition-colors ${
                  serialStatus.usbMode === 'READOUT'
                    ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900 border-slate-900'
                    : 'bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-800'
                }`}
              >
                Målavläsning
              </button>
              <button
                type="button"
                onClick={() => onSetUsbMode('START_CORRAL')}
                className={`px-2.5 py-1.5 text-xs font-medium rounded-lg border text-center transition-colors ${
                  serialStatus.usbMode === 'START_CORRAL'
                    ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900 border-slate-900'
                    : 'bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-800'
                }`}
              >
                Start / Check
              </button>
              <button
                type="button"
                onClick={() => onSetUsbMode('REGISTRATION')}
                className={`px-2.5 py-1.5 text-xs font-medium rounded-lg border text-center transition-colors ${
                  serialStatus.usbMode === 'REGISTRATION'
                    ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900 border-slate-900'
                    : 'bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-800'
                }`}
              >
                Direktanmälan
              </button>
            </div>
            <div className="text-[11px] text-slate-500 dark:text-slate-400 font-mono flex items-center justify-between">
              <span>Baud: {serialStatus.baudRate} bps</span>
              <span>Drivrutin: {serialStatus.activeTransport ? (serialStatus.activeTransport === 'WEB_USB' ? 'WebUSB (CP210x)' : 'WebSerial') : 'Ingen'}</span>
            </div>
          </div>
        </div>
      </section>

      {/* 2. Nödlägen i skogen & Omräkning */}
      <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 sm:p-5 space-y-4">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-2.5 pb-3 border-b border-slate-100 dark:border-slate-800">
          <div>
            <div className="flex items-center gap-2">
              <Wrench className="w-4 h-4 text-red-600 dark:text-red-400 shrink-0" />
              <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                Nödlägen i skogen & Omräkning
              </h2>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Undanta trasiga kontroller, justera felställda enhetsklockor eller tilldela manuell måltid.
            </p>
          </div>

          <button
            type="button"
            disabled={emergencyBusy}
            onClick={() => void handleRecalcClick()}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-slate-900 dark:bg-slate-100 dark:text-slate-900 hover:bg-slate-800 rounded-lg transition-colors whitespace-nowrap shrink-0 self-start md:self-auto"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${emergencyBusy ? 'animate-spin' : ''}`} />
            <span>Räkna om alla sparade avläsningar</span>
          </button>
        </div>

        {emergencyFeedback && (
          <div
            className={`px-3 py-2 text-xs font-medium rounded-lg border ${
              emergencyFeedback.ok
                ? 'text-emerald-800 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-900/60'
                : 'text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-950/40 border-red-200 dark:border-red-900/60'
            }`}
          >
            {emergencyFeedback.msg}
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {/* Kontroll ur funktion */}
          <div className="p-3.5 bg-slate-50 dark:bg-slate-950/50 rounded-lg border border-slate-200 dark:border-slate-800 space-y-3">
            <h3 className="text-xs font-semibold text-slate-800 dark:text-slate-200 uppercase tracking-wider flex items-center gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 text-amber-500" />
              <span>Kontroll ur funktion</span>
            </h3>
            <p className="text-[11px] text-slate-500 dark:text-slate-400">
              Stryk stämplingskrav för trasig eller stulen kontrollenhet.
            </p>
            <form onSubmit={handleAddBrokenControl} className="flex gap-2">
              <input
                type="number"
                placeholder="Kod (t.ex. 42)"
                value={brokenCodeInput}
                onChange={(e) => setBrokenCodeInput(e.target.value)}
                className="w-24 px-2.5 py-1 text-xs font-mono bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg"
              />
              <button
                type="submit"
                disabled={emergencyBusy || !brokenCodeInput}
                className="px-2.5 py-1 text-xs font-medium text-white bg-red-600 hover:bg-red-700 disabled:opacity-50 rounded-lg"
              >
                Undanta
              </button>
            </form>
            {emergency.brokenControls.length > 0 && (
              <div className="flex flex-wrap gap-1.5 pt-1">
                {emergency.brokenControls.map((c) => (
                  <span
                    key={c}
                    className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-mono bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-900 rounded-md"
                  >
                    <span>({c})</span>
                    <button
                      type="button"
                      onClick={() => void handleRemoveBrokenControl(c)}
                      className="text-red-500 hover:text-red-800"
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Tidsjustering */}
          <div className="p-3.5 bg-slate-50 dark:bg-slate-950/50 rounded-lg border border-slate-200 dark:border-slate-800 space-y-3">
            <h3 className="text-xs font-semibold text-slate-800 dark:text-slate-200 uppercase tracking-wider flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5 text-blue-500" />
              <span>Tidsjustering stationsklocka</span>
            </h3>
            <p className="text-[11px] text-slate-500 dark:text-slate-400">
              Kompensera för felställd enhetsklocka (+/- sekunder).
            </p>
            <form onSubmit={handleSetTimeOffset} className="flex flex-wrap gap-2">
              <input
                type="number"
                placeholder="Kod"
                value={offsetCodeInput}
                onChange={(e) => setOffsetCodeInput(e.target.value)}
                className="w-16 px-2.5 py-1 text-xs font-mono bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg"
              />
              <input
                type="number"
                placeholder="+/- sekunder"
                value={offsetSecInput || ''}
                onChange={(e) => setOffsetSecInput(Number(e.target.value))}
                className="w-24 px-2.5 py-1 text-xs font-mono bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg"
              />
              <button
                type="submit"
                disabled={emergencyBusy || !offsetCodeInput}
                className="px-2.5 py-1 text-xs font-medium text-slate-900 dark:text-slate-100 bg-slate-200 dark:bg-slate-800 hover:bg-slate-300 dark:hover:bg-slate-700 disabled:opacity-50 rounded-lg"
              >
                Sätt offset
              </button>
            </form>
            {Object.keys(emergency.controlTimeOffsets).length > 0 && (
              <div className="flex flex-wrap gap-1.5 pt-1">
                {Object.entries(emergency.controlTimeOffsets).map(([code, off]) => (
                  <span
                    key={code}
                    className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-mono bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-900 rounded-md"
                  >
                    <span>({code}): {off > 0 ? `+${off}` : off}s</span>
                    <button
                      type="button"
                      onClick={() => void handleRemoveOffset(code)}
                      className="text-blue-500 hover:text-blue-800"
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Manuell måltid */}
          <div className="p-3.5 bg-slate-50 dark:bg-slate-950/50 rounded-lg border border-slate-200 dark:border-slate-800 space-y-3">
            <h3 className="text-xs font-semibold text-slate-800 dark:text-slate-200 uppercase tracking-wider flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5 text-emerald-500" />
              <span>Manuell måltid (Reservklocka)</span>
            </h3>
            <p className="text-[11px] text-slate-500 dark:text-slate-400">
              Tilldela måltid från måldomarklocka om målstämpel saknas på brickan.
            </p>
            <form onSubmit={handleManualFinishSubmit} className="space-y-2">
              <select
                value={manualRunnerId}
                onChange={(e) => setManualRunnerId(e.target.value)}
                className="w-full px-2.5 py-1 text-xs bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg font-medium"
              >
                {competitors.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.bib ? `#${c.bib} ` : ''}{c.fullName} ({c.club})
                  </option>
                ))}
              </select>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={manualFinishClock}
                  onChange={(e) => setManualFinishClock(e.target.value)}
                  className="w-24 px-2.5 py-1 text-xs font-mono bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg"
                />
                <button
                  type="submit"
                  disabled={emergencyBusy || !manualRunnerId}
                  className="flex-1 px-2.5 py-1 text-xs font-medium text-white bg-slate-900 dark:bg-slate-100 dark:text-slate-900 hover:bg-slate-800 disabled:opacity-50 rounded-lg"
                >
                  Registrera måltid
                </button>
              </div>
            </form>
          </div>
        </div>
      </section>

      {/* 3. ROC Radiokontroller i skogen (roc.olresultat.se) */}
      <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 sm:p-5 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 pb-3 border-b border-slate-100 dark:border-slate-800">
          <div>
            <div className="flex items-center gap-2">
              <Radio className="w-4 h-4 text-slate-700 dark:text-slate-300 shrink-0" />
              <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                ROC Radiokontroller i skogen (roc.olresultat.se)
              </h2>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Live-stämplingar från 4G/GPRS-radiomodem i skogen via ROC REST API.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <span
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${
                roc.enabled
                  ? 'bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-900'
                  : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-700'
              }`}
            >
              <span
                className={`w-2 h-2 rounded-full ${
                  roc.enabled ? 'bg-emerald-500' : 'bg-slate-400'
                }`}
              />
              <span>{roc.enabled ? 'ROC Aktiv' : 'ROC Ej aktiv'}</span>
            </span>
          </div>
        </div>

        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          <form onSubmit={handleSaveRocPassId} className="flex flex-wrap items-center gap-2">
            <label htmlFor="roc-unit-id" className="text-xs font-medium text-slate-700 dark:text-slate-300">
              ROC Passnings-ID:
            </label>
            <input
              id="roc-unit-id"
              type="text"
              value={rocPassId}
              onChange={(e) => setRocPassId(e.target.value)}
              placeholder="t.ex. 1042"
              className="w-28 px-2.5 py-1.5 text-xs font-mono bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg"
            />
            <button
              type="submit"
              className="px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg transition-colors whitespace-nowrap"
            >
              Spara ID
            </button>
          </form>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleToggleRocAuto}
              className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors ${
                rocAutoPoll
                  ? 'bg-emerald-600 text-white border-emerald-600'
                  : 'bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-800'
              }`}
            >
              {rocAutoPoll ? 'Automatisk polling (var 15s)' : 'Manuell polling'}
            </button>

            <button
              type="button"
              disabled={rocBusy}
              onClick={() => void handlePollRoc()}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-900 dark:text-slate-100 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg transition-colors whitespace-nowrap"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${rocBusy ? 'animate-spin' : ''}`} />
              <span>Hämta nu</span>
            </button>

            <button
              type="button"
              disabled={rocBusy}
              onClick={() => void handleSimulateRoc()}
              className="px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors whitespace-nowrap"
            >
              Simulera ROC-stämpling
            </button>
          </div>
        </div>

        {rocFeedback && (
          <div
            className={`px-3 py-2 text-xs font-medium rounded-lg border ${
              rocFeedback.ok
                ? 'text-emerald-800 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-900/60'
                : 'text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-950/40 border-red-200 dark:border-red-900/60'
            }`}
          >
            {rocFeedback.msg}
          </div>
        )}
      </section>

      {/* 4. Konfigurerade SI-stationer & Radiokontroller */}
      <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            Konfigurerade SI-stationer & Radiokontroller ({stations.length})
          </h2>
          {isAdmin && (
            <button
              type="button"
              onClick={handleOpenNewStation}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-red-600 hover:bg-red-700 rounded-lg transition-colors whitespace-nowrap"
            >
              {modalOpen && !editingStationId ? (
                <X className="w-3.5 h-3.5" />
              ) : (
                <Plus className="w-3.5 h-3.5" />
              )}
              <span>
                {modalOpen && !editingStationId ? 'Stäng formulär' : 'Lägg till station'}
              </span>
            </button>
          )}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 dark:bg-slate-950/70 border-b border-slate-200 dark:border-slate-800 text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase">
              <tr>
                <th className="px-4 py-2.5">Kod (CN)</th>
                <th className="px-4 py-2.5">Namn / Placering</th>
                <th className="px-4 py-2.5">Funktion</th>
                <th className="px-4 py-2.5">Hårdvara</th>
                <th className="px-4 py-2.5">Baud</th>
                <th className="px-4 py-2.5 text-right">Åtgärd</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {stations.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-6 text-center text-slate-400">
                    Inga stationer konfigurerade.
                  </td>
                </tr>
              ) : (
                stations.map((st) => (
                  <tr key={st.id} className="hover:bg-slate-50/50 dark:hover:bg-slate-800/40">
                    <td className="px-4 py-2.5 font-mono font-bold text-slate-900 dark:text-slate-100">
                      {st.stationCode}
                    </td>
                    <td className="px-4 py-2.5 font-medium text-slate-900 dark:text-slate-100">
                      {st.name}
                    </td>
                    <td className="px-4 py-2.5">
                      <span className="inline-flex px-2 py-0.5 rounded text-[11px] font-medium bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300">
                        {formatStationFunctionLabel(st.stationFunction)}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-slate-600 dark:text-slate-400">
                      {st.hardwareModel}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-slate-500">
                      {st.baudRate}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      {isAdmin && (
                        <div className="inline-flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => handleEditStation(st)}
                            className="p-1 text-slate-400 hover:text-blue-600 rounded transition-colors"
                            title="Ändra station"
                            aria-label={`Ändra station ${st.name}`}
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => void onDeleteStation(st.id)}
                            className="p-1 text-slate-400 hover:text-red-600 rounded transition-colors"
                            title="Ta bort station"
                            aria-label={`Ta bort station ${st.name}`}
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
