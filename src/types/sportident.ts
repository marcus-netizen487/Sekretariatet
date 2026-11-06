export type SICardSeries =
  | 'SI-Card 5'
  | 'SI-Card 6'
  | 'SI-Card 8'
  | 'SI-Card 9'
  | 'SI-Card 10'
  | 'SI-Card 11'
  | 'SIAC Air+';

export type StationFunction =
  | 'CLEAR'
  | 'CHECK'
  | 'START'
  | 'RADIO'
  | 'PREWARNING'
  | 'FINISH'
  | 'READOUT';

export type HardwareModel =
  | 'BSM8-USB'
  | 'BSM7-USB'
  | 'SRR-USB (Air+)'
  | 'BSF9 Master'
  | 'BSF8 Master';

export type RunnerStatus =
  | 'REGISTERED'
  | 'CHECKED'
  | 'IN_FOREST'
  | 'PRELIMINARY_FIN'
  | 'OK'
  | 'MP'
  | 'DNF'
  | 'DNS';

export type EventLifecycleStatus = 'LIVE' | 'UPCOMING' | 'COMPLETED';

export type ClassCompetitionFormat = 'STANDARD' | 'FORKED' | 'ROGAINING';

export interface SeriesScoringConfig {
  model: 'PLACEMENT' | 'PARTICIPATION';
  placementPoints: number[];
  participationPoints: number;
}

export type OfficialRoleMode =
  | 'ALL'
  | 'READOUT'
  | 'START'
  | 'FOREST'
  | 'SPEAKER';

export interface ClubSettings {
  clubName: string;
  eventorOrgId: string;
  swishNumber: string;
  swishRecipientName: string;
  defaultDirectEntryFeeSek: number;
  rentalCardFeeSek: number;
  missingRentalFeeSek: number;
  portalTitle?: string;
  logoDataUrl?: string;
  customBgColor?: string;
  customTextColor?: string;
  customAccentColor?: string;
  seriesScoringSettings?: Record<string, SeriesScoringConfig>;
}

export interface CompetitionMeta {
  id?: string;
  shortCode?: string;
  status?: EventLifecycleStatus;
  name: string;
  organizer: string;
  date: string;
  zeroTimeStr: string; // e.g. "10:00:00"
  zeroTimeSec: number; // seconds since midnight, e.g. 36000
  arenaInfo?: string;
  seriesName?: string;
  allowSelfRegistration?: boolean;
  enableFeesAndSwish?: boolean;
}

export interface CompetitionSummary {
  id: string;
  competitionId?: string;
  shortCode: string;
  status: EventLifecycleStatus;
  name: string;
  organizer: string;
  date: string;
  zeroTimeStr: string;
  arenaInfo: string;
  seriesName?: string;
  allowSelfRegistration?: boolean;
  enableFeesAndSwish: boolean;
  competitorCount: number;
  finishedCount: number;
  classCount: number;
}

export interface Course {
  id: string;
  name: string;
  lengthMeters: number;
  climbMeters: number;
  controls: number[]; // Ordered list of control codes, e.g. [31, 38, 42, 55, 61, 100]
}

export interface CompClass {
  id: string;
  name: string;
  courseId: string | null; // null if purely dynamic open course matching
  classFormat?: ClassCompetitionFormat;
  forkCourseIds?: string[]; // Pool of forked course IDs when classFormat === 'FORKED'
  rogainingMaxTimeSec?: number | null; // Time limit in seconds when classFormat === 'ROGAINING'
  rogainingPenaltyPerMin?: number | null; // Points deducted per started overtime minute
  allowDirectEntry: boolean;
  freeStart: boolean;
  autoMatchCourse: boolean;
  feeSek: number;
}

export interface SIStation {
  id: string;
  stationCode: number;
  name: string;
  hardwareModel: HardwareModel;
  stationFunction: StationFunction;
  baudRate: 38400 | 4800;
  extendedProtocol: boolean;
  batteryMv: number;
  firmware: string;
  lastSeenAt: string | null;
  active: boolean;
}

export interface CardPunch {
  code: number;
  timeSec: number; // Seconds since midnight (0..86399)
}

export interface RadioSplit {
  controlCode: number;
  stationName: string;
  punchTimeSec: number;
  runningTimeSec: number | null;
  isPrewarning: boolean;
}

export interface SplitLegResult {
  order: number;
  controlCode: number; // 999 represents Finish leg ("Mål")
  label: string; // e.g. "(31)", "(100)", "Mål"
  status: 'OK' | 'MISSING' | 'BROKEN_CTRL';
  punchTimeSec: number | null;
  cumulativeSec: number | null;
  legSec: number | null;
  pointsAwarded?: number | null;
  legRank?: number | null;
  legBehindSec?: number | null;
  bestLegSec?: number | null;
  timeLossSec?: number | null;
  cumulativeRank?: number | null;
  cumulativeBehindSec?: number | null;
}

export interface ReadoutValidation {
  ok: boolean;
  matchedCourseId: string | null;
  matchedCourseName: string | null;
  missingControls: number[];
  extraControls: CardPunch[];
  splits: SplitLegResult[];
  idealTimeSec?: number | null;
  totalTimeLossSec?: number | null;
  mistakeFreeTimeSec?: number | null;
  rogainingPoints?: number | null;
  rogainingGrossPoints?: number | null;
  rogainingOvertimePenalty?: number | null;
  rogainingOvertimeSec?: number | null;
}

export interface RawCardReadoutArchive {
  checkTimeSec: number | null;
  startTimeSec: number | null;
  finishTimeSec: number | null;
  punches: CardPunch[];
  rawHex?: string;
  receivedAt: string;
  clientReadoutId?: string;
}

export interface Competitor {
  id: string;
  bib: number;
  fullName: string;
  club: string;
  classId: string;
  siNumber: number;
  cardSeries: SICardSeries;
  isRentalCard: boolean;
  isBorrowedCard?: boolean;
  rentalReturned: boolean;
  feePaid?: boolean;
  status: RunnerStatus;
  allocatedStartSec: number | null;
  checkTimeSec: number | null;
  startTimeSec: number | null;
  finishTimeSec: number | null;
  manualFinishTimeSec?: number | null;
  runningTimeSec: number | null;
  lastSeenControl: number | null;
  lastSeenTimeSec: number | null;
  readoutAt: string | null;
  radioSplits: RadioSplit[];
  cardPunches: CardPunch[];
  rawReadout?: RawCardReadoutArchive | null;
  validation: ReadoutValidation | null;
}

export interface RentalCardOverviewItem {
  eventId: string;
  eventName: string;
  eventDate: string;
  shortCode: string;
  competitorId: string;
  bib: number;
  fullName: string;
  club: string;
  className: string;
  siNumber: number;
  cardSeries: SICardSeries;
  rentalReturned: boolean;
  feePaid: boolean;
  enableFeesAndSwish: boolean;
  status: RunnerStatus;
}

export interface SeriesStandingRow {
  runnerKey: string;
  fullName: string;
  club: string;
  totalPoints: number;
  participations: number;
  wins: number;
  stagePoints: Record<string, number>;
}

export interface SeriesStandingClassGroup {
  className: string;
  rows: SeriesStandingRow[];
}

export interface SeriesStandingsBundle {
  seriesName: string;
  stages: {
    eventId: string;
    shortCode: string;
    name: string;
    date: string;
    status: EventLifecycleStatus;
  }[];
  classes: SeriesStandingClassGroup[];
}

export interface LiveEventItem {
  id: string;
  timestamp: string;
  clock24h: string;
  eventType:
    | 'CHECK'
    | 'START'
    | 'RADIO'
    | 'PREWARNING'
    | 'FINISH'
    | 'READOUT_OK'
    | 'READOUT_MP'
    | 'UNKNOWN_CARD'
    | 'DIRECT_ENTRY'
    | 'EMERGENCY';
  siNumber: number;
  competitorId: string | null;
  competitorName: string | null;
  club: string | null;
  className: string | null;
  stationCode: number;
  stationName: string;
  runningTimeSec: number | null;
  message: string;
  rawHex?: string;
}

export type FrameHardwareSource = 'USB_WEBSERIAL' | 'USB_WEBUSB' | 'PROTOCOL_TESTBENCH';

export interface FullCardReadoutPayload {
  clientReadoutId?: string;
  siNumber: number;
  cardSeries: SICardSeries;
  stationCode: number;
  checkTimeSec: number | null;
  startTimeSec: number | null;
  finishTimeSec: number | null;
  punches: CardPunch[];
  rawHex?: string;
  source: FrameHardwareSource;
}

export interface FrameByteSegment {
  label: string;
  hex: string;
  meaning: string;
}

export interface RawSIFrameLog {
  id: string;
  timestamp: string;
  direction: 'RX' | 'TX';
  commandHex: string;
  commandName: string;
  rawHex: string;
  crcValid: boolean;
  computedCrcHex: string;
  receivedCrcHex: string;
  stationCode?: number;
  siNumber?: number;
  cardSeries?: SICardSeries;
  punchTime24h?: string;
  punchTimeSec?: number;
  blockNumber?: number;
  blockData?: number[];
  siacBatteryLow?: boolean;
  segments: FrameByteSegment[];
  source: FrameHardwareSource;
}

export type RunnerDbSource =
  | 'EVENTOR_API'
  | 'EVENTOR_XML'
  | 'MEOS_CSV'
  | 'LEARNED_ENTRY';

export interface RunnerDbEntry {
  id: string;
  siNumber: number;
  cardSeries: SICardSeries;
  fullName: string;
  club: string;
  birthYear: number | null;
  defaultClassName: string | null;
  eventorPersonId: string | null;
  eventorOrgId: string | null;
  source: RunnerDbSource;
  updatedAt: string;
}

export interface EventorIntegrationStatus {
  apiKeyConfigured: boolean;
  baseUrl: string;
  connectedOrgId: string | null;
  connectedOrgName: string | null;
  connectedEventId: string | null;
  lastSyncedAt: string | null;
  autoCreateFromRunnerDbOnReadout: boolean;
}

export interface EmergencySettings {
  brokenControls: number[];
  controlTimeOffsets: Record<string, number>;
}

export interface RocIntegrationStatus {
  enabled: boolean;
  unitId: string;
  baseUrl: string;
  pollIntervalSec: number;
  lastPunchId: number;
  lastPolledAt: string | null;
  totalReceived: number;
  lastError: string | null;
}

export interface MeosAppState {
  activeEventId: string;
  isEmptySeason?: boolean;
  isFreshColdStart?: boolean;
  demoCleared?: boolean;
  clubSettings?: ClubSettings;
  seriesStandings?: SeriesStandingsBundle[];
  competitionsList: CompetitionSummary[];
  competition: CompetitionMeta;
  courses: Course[];
  classes: CompClass[];
  stations: SIStation[];
  competitors: Competitor[];
  runnerDb: RunnerDbEntry[];
  eventor: EventorIntegrationStatus;
  emergency: EmergencySettings;
  roc: RocIntegrationStatus;
  events: LiveEventItem[];
  connectedMonitors: number;
}

export interface PublicRacePayload {
  competition: CompetitionMeta;
  courses: Course[];
  classes: CompClass[];
  competitors: Competitor[];
  radioControls?: Pick<SIStation, 'stationCode' | 'name' | 'stationFunction' | 'active'>[];
  events: LiveEventItem[];
  emergency: EmergencySettings;
  competitionsList: CompetitionSummary[];
  clubSettings?: ClubSettings;
  seriesStandings?: SeriesStandingsBundle[];
  updatedAt: string;
}

export interface PublicSeasonOverviewPayload {
  competitions: CompetitionSummary[];
  clubSettings: ClubSettings;
  seriesStandings: SeriesStandingsBundle[];
}

export type OfficialPinRole = 'START' | 'READOUT' | 'FOREST' | 'SPEAKER';

export type RolePinMap = Record<OfficialPinRole, string>;

export type AuthSessionKind = 'ADMIN' | 'PIN_OFFICIAL';

export type ClubAdminTier = 'SUPER_ADMIN' | 'RACE_ADMIN';

export interface AuthSessionUser {
  sessionKind: AuthSessionKind;
  uid: string;
  displayName: string;
  email: string | null;
  adminTier: ClubAdminTier | null;
  officialRole: OfficialRoleMode;
  lockedEventId: string | null;
  lockedEventName: string | null;
  authMethod: 'GOOGLE' | 'PIN' | 'OFFLINE_CODE';
  issuedAt: string;
  expiresAt: string;
}

export interface ClubAdminAccount {
  email: string;
  displayName: string;
  role: ClubAdminTier;
  isBootstrapOwner?: boolean;
  isPendingInvite?: boolean;
  addedAt: string;
}

export interface AuthPublicInfoPayload {
  competitions: {
    id: string;
    shortCode: string;
    name: string;
    organizer: string;
    date: string;
    status: EventLifecycleStatus;
    pinsCustomized: boolean;
    demoPinHints?: RolePinMap;
  }[];
  activeEventId: string;
  offlineCodeEnabled: boolean;
  offlineCodeCustomized: boolean;
  demoOfflineCodeHint?: string;
  firebaseProjectId: string;
  clubSettings?: Pick<
    ClubSettings,
    | 'clubName'
    | 'portalTitle'
    | 'logoDataUrl'
    | 'customBgColor'
    | 'customTextColor'
    | 'customAccentColor'
  >;
}

export interface AuthManagePayload {
  eventId: string;
  eventName: string;
  rolePins: RolePinMap;
  pinsCustomized: boolean;
  admins: ClubAdminAccount[];
  offlineCodeEnabled: boolean;
  offlineCodeCustomized: boolean;
  clubSettings?: ClubSettings;
  demoCleared?: boolean;
}

export interface CloudCompetitionRecord {
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
  updatedAtIso: string | null;
}

export interface CloudEventExportItem {
  competition: {
    id: string;
    shortCode: string;
    status: EventLifecycleStatus;
    name: string;
    organizer: string;
    date: string;
    zeroTimeStr: string;
    zeroTimeSec: number;
    arenaInfo: string;
    seriesName: string;
    enableFeesAndSwish: boolean;
  };
  courses: Course[];
  classes: CompClass[];
  competitors: Competitor[];
  stations?: SIStation[];
  brokenControls: number[];
  emergency?: EmergencySettings;
  rolePins: RolePinMap;
  pinsCustomized: boolean;
}

export interface CloudSeasonSnapshot {
  activeEventId: string;
  demoCleared: boolean;
  clubSettings: ClubSettings;
  events: CloudEventExportItem[];
  seriesStandings?: SeriesStandingsBundle[];
  runnerDb?: RunnerDbEntry[];
}
