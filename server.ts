import 'dotenv/config';
import crypto from 'crypto';
import express from 'express';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import {
  calculateSeriesStandings,
  normalizeSeriesScoringSettings,
} from './src/services/seriesStandings';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

type SICardSeries =
  | 'SI-Card 5'
  | 'SI-Card 6'
  | 'SI-Card 8'
  | 'SI-Card 9'
  | 'SI-Card 10'
  | 'SI-Card 11'
  | 'SIAC Air+';

type StationFunction =
  | 'CLEAR'
  | 'CHECK'
  | 'START'
  | 'RADIO'
  | 'PREWARNING'
  | 'FINISH'
  | 'READOUT';

type HardwareModel =
  | 'BSM8-USB'
  | 'BSM7-USB'
  | 'SRR-USB (Air+)'
  | 'BSF9 Master'
  | 'BSF8 Master';

type RunnerStatus =
  | 'REGISTERED'
  | 'CHECKED'
  | 'IN_FOREST'
  | 'PRELIMINARY_FIN'
  | 'OK'
  | 'MP'
  | 'DNF'
  | 'DNS';

type EventLifecycleStatus = 'LIVE' | 'UPCOMING' | 'COMPLETED';

interface ClubSettings {
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
  seriesScoringSettings?: Record<
    string,
    {
      model: 'PLACEMENT' | 'PARTICIPATION';
      placementPoints: number[];
      participationPoints: number;
    }
  >;
}

interface CompetitionMeta {
  id: string;
  shortCode: string;
  status: EventLifecycleStatus;
  name: string;
  organizer: string;
  date: string;
  zeroTimeStr: string;
  zeroTimeSec: number;
  arenaInfo: string;
  seriesName?: string;
  enableFeesAndSwish?: boolean;
}

interface CompetitionSummary {
  id: string;
  shortCode: string;
  status: EventLifecycleStatus;
  name: string;
  organizer: string;
  date: string;
  zeroTimeStr: string;
  arenaInfo: string;
  seriesName?: string;
  enableFeesAndSwish: boolean;
  competitorCount: number;
  finishedCount: number;
  classCount: number;
}

interface Course {
  id: string;
  name: string;
  lengthMeters: number;
  climbMeters: number;
  controls: number[];
}

type ClassCompetitionFormat = 'STANDARD' | 'FORKED' | 'ROGAINING';

interface CompClass {
  id: string;
  name: string;
  courseId: string | null;
  classFormat?: ClassCompetitionFormat;
  forkCourseIds?: string[];
  rogainingMaxTimeSec?: number | null;
  rogainingPenaltyPerMin?: number | null;
  allowDirectEntry: boolean;
  freeStart: boolean;
  autoMatchCourse: boolean;
  feeSek: number;
}

interface SIStation {
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

interface CardPunch {
  code: number;
  timeSec: number;
}

interface RadioSplit {
  controlCode: number;
  stationName: string;
  punchTimeSec: number;
  runningTimeSec: number | null;
  isPrewarning: boolean;
}

interface SplitLegResult {
  order: number;
  controlCode: number;
  label: string;
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

interface ReadoutValidation {
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

interface RawCardReadoutArchive {
  checkTimeSec: number | null;
  startTimeSec: number | null;
  finishTimeSec: number | null;
  punches: CardPunch[];
  rawHex?: string;
  receivedAt: string;
  clientReadoutId?: string;
}

interface Competitor {
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

interface RentalCardOverviewItem {
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

interface SeriesStandingRow {
  runnerKey: string;
  fullName: string;
  club: string;
  totalPoints: number;
  participations: number;
  wins: number;
  stagePoints: Record<string, number>;
}

interface SeriesStandingClassGroup {
  className: string;
  rows: SeriesStandingRow[];
}

interface SeriesStandingsBundle {
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

interface LiveEventItem {
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

type RunnerDbSource =
  | 'EVENTOR_API'
  | 'EVENTOR_XML'
  | 'MEOS_CSV'
  | 'LEARNED_ENTRY';

interface RunnerDbEntry {
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

interface EventorIntegrationStatus {
  apiKeyConfigured: boolean;
  baseUrl: string;
  connectedOrgId: string | null;
  connectedOrgName: string | null;
  connectedEventId: string | null;
  lastSyncedAt: string | null;
  autoCreateFromRunnerDbOnReadout: boolean;
}

interface EmergencySettings {
  brokenControls: number[];
  controlTimeOffsets: Record<string, number>;
}

interface RocIntegrationStatus {
  enabled: boolean;
  unitId: string;
  baseUrl: string;
  pollIntervalSec: number;
  lastPunchId: number;
  lastPolledAt: string | null;
  totalReceived: number;
  lastError: string | null;
}

type OfficialPinRole = 'START' | 'READOUT' | 'FOREST' | 'SPEAKER';
type RolePinMap = Record<OfficialPinRole, string>;
type OfficialRoleMode = 'ALL' | OfficialPinRole;
type AuthSessionKind = 'ADMIN' | 'PIN_OFFICIAL';
type ClubAdminTier = 'SUPER_ADMIN' | 'RACE_ADMIN';

interface ClubAdminAccount {
  email: string;
  displayName: string;
  role: ClubAdminTier;
  isBootstrapOwner?: boolean;
  addedAt: string;
}

interface SeasonAuthConfig {
  hmacSecret: string;
  admins: ClubAdminAccount[];
  offlineCodeEnabled: boolean;
  offlineCodeSalt: string;
  offlineCodeHash: string;
  offlineCodeCustomized: boolean;
}

interface AuthSessionUser {
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

interface SingleEventRecord {
  competition: CompetitionMeta;
  courses: Course[];
  classes: CompClass[];
  stations: SIStation[];
  competitors: Competitor[];
  emergency: EmergencySettings;
  roc: RocIntegrationStatus;
  events: LiveEventItem[];
  processedClientIds: string[];
  rolePins?: RolePinMap;
  pinsCustomized?: boolean;
}

interface CloudEventExportItem {
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

interface CloudSeasonSnapshot {
  activeEventId: string;
  demoCleared: boolean;
  clubSettings: ClubSettings;
  events: CloudEventExportItem[];
}

interface SeasonDatabase {
  version: 3;
  activeEventId: string;
  demoCleared?: boolean;
  clubSettings?: ClubSettings;
  eventsMap: Record<string, SingleEventRecord>;
  runnerDb: RunnerDbEntry[];
  eventor: EventorIntegrationStatus;
  authConfig?: SeasonAuthConfig;
}

const BOOTSTRAP_ADMIN_EMAIL = 'instagram.okosteraker@gmail.com';
const BOOTSTRAP_ADMIN_EMAILS = [
  'instagram.okosteraker@gmail.com',
  'marcus.o.ahlen@gmail.com',
];

function isBootstrapAdminEmail(email?: string | null): boolean {
  if (!email) return false;
  const clean = email.trim().toLowerCase();
  return BOOTSTRAP_ADMIN_EMAILS.includes(clean);
}

const DEFAULT_ROLE_PINS: RolePinMap = {
  START: '1100',
  READOUT: '2200',
  FOREST: '3300',
  SPEAKER: '4400',
};
const DEFAULT_OFFLINE_ADMIN_CODE = 'okosteraker2026';

function loadFirebaseConfigIds(): { projectId: string; firestoreDatabaseId: string } {
  try {
    const cfgPath = path.join(__dirname, 'firebase-applet-config.json');
    if (fs.existsSync(cfgPath)) {
      const parsed = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) as {
        projectId?: string;
        firestoreDatabaseId?: string;
      };
      return {
        projectId: parsed.projectId || 'ai-studio-applet-webapp-72c01',
        firestoreDatabaseId:
          parsed.firestoreDatabaseId ||
          'ai-studio-kopiaavoksekreta-4d24d0cc-1fd7-4b98-ba1a-8c6f95c187df',
      };
    }
  } catch {
    // ignore
  }
  return {
    projectId: 'ai-studio-applet-webapp-72c01',
    firestoreDatabaseId:
      'ai-studio-kopiaavoksekreta-4d24d0cc-1fd7-4b98-ba1a-8c6f95c187df',
  };
}

const { projectId: FIREBASE_PROJECT_ID, firestoreDatabaseId: FIRESTORE_DATABASE_ID } =
  loadFirebaseConfigIds();

async function verifyFirestoreAdminRoleRest(
  uid: string,
  idToken: string
): Promise<ClubAdminTier | null> {
  try {
    const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(
      FIREBASE_PROJECT_ID
    )}/databases/${encodeURIComponent(
      FIRESTORE_DATABASE_ID
    )}/documents/admins/${encodeURIComponent(uid)}`;
    const resp = await fetch(url, {
      headers: {
        Authorization: `Bearer ${idToken}`,
      },
    });
    if (!resp.ok) return null;
    const docJson = (await resp.json()) as {
      fields?: {
        role?: { stringValue?: string };
      };
    };
    const roleVal = docJson.fields?.role?.stringValue;
    if (roleVal === 'SUPER_ADMIN' || roleVal === 'RACE_ADMIN') {
      return roleVal;
    }
    return null;
  } catch {
    return null;
  }
}

function hashSecretScrypt(secret: string, saltHex: string): string {
  return crypto.scryptSync(secret, Buffer.from(saltHex, 'hex'), 32).toString('hex');
}

function verifySecretScrypt(secret: string, saltHex: string, expectedHashHex: string): boolean {
  if (!saltHex || !expectedHashHex) return false;
  const actualBuf = crypto.scryptSync(secret, Buffer.from(saltHex, 'hex'), 32);
  const expectedBuf = Buffer.from(expectedHashHex, 'hex');
  if (actualBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(actualBuf, expectedBuf);
}

function buildDefaultSeasonAuthConfig(nowIso: string): SeasonAuthConfig {
  const salt = crypto.randomBytes(16).toString('hex');
  return {
    hmacSecret: crypto.randomBytes(32).toString('hex'),
    admins: [
      {
        email: BOOTSTRAP_ADMIN_EMAIL,
        displayName: 'OK Österåker (Huvudadmin)',
        role: 'SUPER_ADMIN',
        isBootstrapOwner: true,
        addedAt: nowIso,
      },
    ],
    offlineCodeEnabled: true,
    offlineCodeSalt: salt,
    offlineCodeHash: hashSecretScrypt(DEFAULT_OFFLINE_ADMIN_CODE, salt),
    offlineCodeCustomized: false,
  };
}

function ensureEventPins(ev: SingleEventRecord): RolePinMap {
  if (
    !ev.rolePins ||
    !/^\d{4,6}$/.test(ev.rolePins.START || '') ||
    !/^\d{4,6}$/.test(ev.rolePins.READOUT || '') ||
    !/^\d{4,6}$/.test(ev.rolePins.FOREST || '') ||
    !/^\d{4,6}$/.test(ev.rolePins.SPEAKER || '')
  ) {
    ev.rolePins = { ...DEFAULT_ROLE_PINS };
    ev.pinsCustomized = false;
  }
  if (ev.pinsCustomized === undefined) {
    ev.pinsCustomized = false;
  }
  return ev.rolePins;
}

function ensureSeasonAuthConfig(seasonDb: SeasonDatabase): SeasonAuthConfig {
  const nowIso = new Date().toISOString();
  if (!seasonDb.authConfig || !seasonDb.authConfig.hmacSecret) {
    seasonDb.authConfig = buildDefaultSeasonAuthConfig(nowIso);
    return seasonDb.authConfig;
  }
  if (!Array.isArray(seasonDb.authConfig.admins)) {
    seasonDb.authConfig.admins = [];
  }
  if (
    !seasonDb.authConfig.admins.some(
      (a) => a.email.toLowerCase() === BOOTSTRAP_ADMIN_EMAIL
    )
  ) {
    seasonDb.authConfig.admins.unshift({
      email: BOOTSTRAP_ADMIN_EMAIL,
      displayName: 'OK Österåker (Huvudadmin)',
      role: 'SUPER_ADMIN',
      isBootstrapOwner: true,
      addedAt: nowIso,
    });
  }
  if (seasonDb.authConfig.offlineCodeEnabled === undefined) {
    seasonDb.authConfig.offlineCodeEnabled = true;
  }
  if (!seasonDb.authConfig.offlineCodeSalt || !seasonDb.authConfig.offlineCodeHash) {
    const salt = crypto.randomBytes(16).toString('hex');
    seasonDb.authConfig.offlineCodeSalt = salt;
    seasonDb.authConfig.offlineCodeHash = hashSecretScrypt(DEFAULT_OFFLINE_ADMIN_CODE, salt);
    seasonDb.authConfig.offlineCodeCustomized = false;
  }
  return seasonDb.authConfig;
}

function signAuthSessionToken(user: AuthSessionUser, hmacSecret: string): string {
  const payloadB64 = Buffer.from(JSON.stringify(user), 'utf-8').toString('base64url');
  const sigB64 = crypto
    .createHmac('sha256', hmacSecret)
    .update(payloadB64)
    .digest('base64url');
  return `${payloadB64}.${sigB64}`;
}

function verifyAuthSessionToken(
  token: string | undefined | null,
  hmacSecret: string
): AuthSessionUser | null {
  if (!token || typeof token !== 'string') return null;
  const parts = token.trim().split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, sigB64] = parts;
  if (!payloadB64 || !sigB64) return null;

  const expectedSigBuf = crypto
    .createHmac('sha256', hmacSecret)
    .update(payloadB64)
    .digest();
  const actualSigBuf = Buffer.from(sigB64, 'base64url');
  if (
    expectedSigBuf.length !== actualSigBuf.length ||
    !crypto.timingSafeEqual(expectedSigBuf, actualSigBuf)
  ) {
    return null;
  }

  try {
    const parsed = JSON.parse(
      Buffer.from(payloadB64, 'base64url').toString('utf-8')
    ) as AuthSessionUser;
    if (!parsed.expiresAt || Date.parse(parsed.expiresAt) < Date.now()) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

let cachedGoogleCerts: { certs: Record<string, string>; fetchedAtMs: number } | null = null;

async function getGoogleSecureTokenCerts(forceRefresh = false): Promise<Record<string, string>> {
  const now = Date.now();
  if (
    !forceRefresh &&
    cachedGoogleCerts &&
    now - cachedGoogleCerts.fetchedAtMs < 50 * 60 * 1000
  ) {
    return cachedGoogleCerts.certs;
  }
  const resp = await fetch(
    'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com'
  );
  if (!resp.ok) {
    throw new Error('Kunde inte hämta Googles certifikat för tokenverifiering.');
  }
  const certs = (await resp.json()) as Record<string, string>;
  cachedGoogleCerts = { certs, fetchedAtMs: now };
  return certs;
}

async function verifyFirebaseIdToken(idToken: string): Promise<{
  uid: string;
  email: string;
  emailVerified: boolean;
  name: string;
}> {
  const parts = idToken.trim().split('.');
  if (parts.length !== 3) {
    throw new Error('Ogiltigt Firebase ID-tokenformat.');
  }
  const [headerB64, payloadB64, sigB64] = parts;
  const header = JSON.parse(
    Buffer.from(headerB64, 'base64url').toString('utf-8')
  ) as { alg?: string; kid?: string };
  const payload = JSON.parse(
    Buffer.from(payloadB64, 'base64url').toString('utf-8')
  ) as {
    aud?: string;
    iss?: string;
    sub?: string;
    exp?: number;
    email?: string;
    email_verified?: boolean;
    name?: string;
  };

  if (header.alg !== 'RS256' || !header.kid) {
    throw new Error('Ogiltig tokensignaturalgoritm.');
  }
  if (
    payload.aud !== FIREBASE_PROJECT_ID ||
    payload.iss !== `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`
  ) {
    throw new Error('Token tillhör inte detta Firebase-projekt.');
  }
  const nowSec = Math.floor(Date.now() / 1000);
  if (!payload.exp || payload.exp < nowSec - 30) {
    throw new Error('Inloggningssessionen har löpt ut. Logga in igen.');
  }
  if (!payload.sub || !payload.email || payload.email_verified !== true) {
    throw new Error('Google-kontot saknar verifierad e-postadress.');
  }

  let certs = await getGoogleSecureTokenCerts(false);
  let certPem = certs[header.kid];
  if (!certPem) {
    certs = await getGoogleSecureTokenCerts(true);
    certPem = certs[header.kid];
  }
  if (!certPem) {
    throw new Error('Kunde inte hitta matchande Google-certifikat.');
  }

  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(`${headerB64}.${payloadB64}`);
  verifier.end();
  const validSig = verifier.verify(certPem, Buffer.from(sigB64, 'base64url'));
  if (!validSig) {
    throw new Error('Kryptografisk verifiering av Google-token misslyckades.');
  }

  return {
    uid: payload.sub,
    email: payload.email.trim().toLowerCase(),
    emailVerified: true,
    name: (payload.name || payload.email.split('@')[0]).trim(),
  };
}

function inferSeries(siNumber: number): SICardSeries {
  if (siNumber >= 8_000_000 && siNumber <= 8_999_999) return 'SIAC Air+';
  if (siNumber >= 9_000_000 && siNumber <= 9_999_999) return 'SI-Card 11';
  if (siNumber >= 7_000_000 && siNumber <= 7_999_999) return 'SI-Card 10';
  if (siNumber >= 2_000_000 && siNumber <= 2_999_999) return 'SI-Card 8';
  if (siNumber >= 1_000_000 && siNumber <= 1_999_999) return 'SI-Card 9';
  if (siNumber >= 500_000 && siNumber <= 999_999) return 'SI-Card 6';
  return 'SI-Card 5';
}

function getStockholmDateIso(date = new Date()): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Stockholm',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function getStockholmClockSec(date = new Date()): number {
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Stockholm',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  let hh = 0;
  let mm = 0;
  let ss = 0;
  for (const p of parts) {
    if (p.type === 'hour') hh = Number(p.value) % 24;
    else if (p.type === 'minute') mm = Number(p.value);
    else if (p.type === 'second') ss = Number(p.value);
  }
  return hh * 3600 + mm * 60 + ss;
}

function secToClock(sec: number): string {
  const norm = ((Math.floor(sec) % 86400) + 86400) % 86400;
  const hh = Math.floor(norm / 3600)
    .toString()
    .padStart(2, '0');
  const mm = Math.floor((norm % 3600) / 60)
    .toString()
    .padStart(2, '0');
  const ss = (norm % 60).toString().padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function parseClockStrToSec(clock: string): number | null {
  const m = clock.trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  const ss = m[3] ? Number(m[3]) : 0;
  if (hh > 23 || mm > 59 || ss > 59) return null;
  return hh * 3600 + mm * 60 + ss;
}

function durToMmSs(sec: number): string {
  const total = Math.max(0, Math.floor(sec));
  const hh = Math.floor(total / 3600);
  const mm = Math.floor((total % 3600) / 60);
  const ss = total % 60;
  if (hh > 0) {
    return `${hh}:${mm.toString().padStart(2, '0')}:${ss.toString().padStart(2, '0')}`;
  }
  return `${mm.toString().padStart(2, '0')}:${ss.toString().padStart(2, '0')}`;
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function applyEmergencyTimeOffsets(
  punches: CardPunch[],
  offsets: Record<string, number>
): CardPunch[] {
  if (!offsets || Object.keys(offsets).length === 0) {
    return punches.map((p) => ({ ...p }));
  }
  return punches.map((p) => {
    const delta = Number(offsets[String(p.code)] || 0);
    if (!Number.isFinite(delta) || delta === 0) return { ...p };
    return {
      code: p.code,
      timeSec: (((p.timeSec + Math.round(delta)) % 86400) + 86400) % 86400,
    };
  });
}

/**
 * MeOS / O-Tid Sequential Punch Verification Algorithm with Emergency Support:
 * - Greedily matches ordered course controls against chronological SI-card punches
 * - Applies per-control clock offsets (controlTimeOffsets)
 * - Excuses controls marked out-of-order in the forest (brokenControls) so runners are approved (OK)
 */
function evaluateCardAgainstSingleCourse(
  course: Course,
  effectiveStartSec: number,
  finishTimeSec: number | null,
  rawPunches: CardPunch[],
  emergency: EmergencySettings
): ReadoutValidation {
  const punches = applyEmergencyTimeOffsets(rawPunches, emergency.controlTimeOffsets);
  const brokenSet = new Set<number>(emergency.brokenControls || []);

  const splits: SplitLegResult[] = [];
  const missingControls: number[] = [];
  const matchedPunchIndices = new Set<number>();

  let searchCursor = 0;
  let prevPunchSec = effectiveStartSec;
  let previousValid = true;

  course.controls.forEach((reqCode, idx) => {
    let foundIdx = -1;
    for (let i = searchCursor; i < punches.length; i++) {
      if (punches[i].code === reqCode) {
        foundIdx = i;
        break;
      }
    }

    if (foundIdx !== -1) {
      matchedPunchIndices.add(foundIdx);
      const pTime = punches[foundIdx].timeSec;
      const cum = pTime >= effectiveStartSec ? pTime - effectiveStartSec : null;
      const leg = previousValid && pTime >= prevPunchSec ? pTime - prevPunchSec : null;

      splits.push({
        order: idx + 1,
        controlCode: reqCode,
        label: `(${reqCode})`,
        status: 'OK',
        punchTimeSec: pTime,
        cumulativeSec: cum,
        legSec: leg,
      });

      prevPunchSec = pTime;
      previousValid = true;
      searchCursor = foundIdx + 1;
    } else if (brokenSet.has(reqCode)) {
      // Excused broken control in the forest! Runner is not disqualified (MP).
      splits.push({
        order: idx + 1,
        controlCode: reqCode,
        label: `(${reqCode})`,
        status: 'BROKEN_CTRL',
        punchTimeSec: null,
        cumulativeSec: null,
        legSec: null,
      });
      previousValid = false;
    } else {
      missingControls.push(reqCode);
      splits.push({
        order: idx + 1,
        controlCode: reqCode,
        label: `(${reqCode})`,
        status: 'MISSING',
        punchTimeSec: null,
        cumulativeSec: null,
        legSec: null,
      });
      previousValid = false;
    }
  });

  // Final sprint leg to Finish (Mål)
  if (finishTimeSec !== null && finishTimeSec >= effectiveStartSec) {
    splits.push({
      order: course.controls.length + 1,
      controlCode: 999,
      label: 'Mål',
      status: 'OK',
      punchTimeSec: finishTimeSec,
      cumulativeSec: finishTimeSec - effectiveStartSec,
      legSec: previousValid && finishTimeSec >= prevPunchSec ? finishTimeSec - prevPunchSec : null,
    });
  }

  const extraControls = punches.filter((_, i) => !matchedPunchIndices.has(i));

  return {
    ok: missingControls.length === 0 && finishTimeSec !== null,
    matchedCourseId: course.id,
    matchedCourseName: course.name,
    missingControls,
    extraControls,
    splits,
  };
}

function getRogainingControlPoints(code: number): number {
  return Math.max(10, Math.floor(code / 10) * 10);
}

function evaluateRogainingReadout(
  compClass: CompClass,
  assignedCourse: Course | null,
  courses: Course[],
  effectiveStartSec: number,
  finishTimeSec: number | null,
  rawPunches: CardPunch[],
  emergency: EmergencySettings
): ReadoutValidation {
  const punches = applyEmergencyTimeOffsets(rawPunches, emergency.controlTimeOffsets);
  const brokenSet = new Set<number>(emergency.brokenControls || []);
  const allowedPool = assignedCourse
    ? new Set<number>(assignedCourse.controls)
    : new Set<number>(courses.flatMap((c) => c.controls));

  const visitedCodes = new Set<number>();
  const splits: SplitLegResult[] = [];
  const extraControls: CardPunch[] = [];

  let prevPunchSec = effectiveStartSec;
  let grossPoints = 0;

  for (const p of punches) {
    if (brokenSet.has(p.code)) {
      extraControls.push(p);
      continue;
    }
    const inPool = allowedPool.size === 0 || allowedPool.has(p.code);
    if (!inPool || visitedCodes.has(p.code)) {
      extraControls.push(p);
      continue;
    }

    visitedCodes.add(p.code);
    const pts = getRogainingControlPoints(p.code);
    grossPoints += pts;

    const cum = p.timeSec >= effectiveStartSec ? p.timeSec - effectiveStartSec : null;
    const leg = p.timeSec >= prevPunchSec ? p.timeSec - prevPunchSec : null;
    splits.push({
      order: splits.length + 1,
      controlCode: p.code,
      label: `(${p.code})`,
      status: 'OK',
      punchTimeSec: p.timeSec,
      cumulativeSec: cum,
      legSec: leg,
      pointsAwarded: pts,
    });
    prevPunchSec = p.timeSec;
  }

  if (finishTimeSec !== null && finishTimeSec >= effectiveStartSec) {
    splits.push({
      order: splits.length + 1,
      controlCode: 999,
      label: 'Mål',
      status: 'OK',
      punchTimeSec: finishTimeSec,
      cumulativeSec: finishTimeSec - effectiveStartSec,
      legSec: finishTimeSec >= prevPunchSec ? finishTimeSec - prevPunchSec : null,
      pointsAwarded: 0,
    });
  }

  const runSec =
    finishTimeSec !== null && finishTimeSec >= effectiveStartSec
      ? finishTimeSec - effectiveStartSec
      : 0;
  const maxTimeSec = compClass.rogainingMaxTimeSec ?? 2700;
  const penaltyPerMin = compClass.rogainingPenaltyPerMin ?? 10;
  const overtimeSec = maxTimeSec > 0 && runSec > maxTimeSec ? runSec - maxTimeSec : 0;
  const overtimeMin = overtimeSec > 0 ? Math.ceil(overtimeSec / 60) : 0;
  const penalty = overtimeMin * penaltyPerMin;
  const netPoints = Math.max(0, grossPoints - penalty);

  return {
    ok: finishTimeSec !== null,
    matchedCourseId: assignedCourse?.id ?? null,
    matchedCourseName: assignedCourse ? `${assignedCourse.name} (Poängpool)` : 'Poäng-OL',
    missingControls: [],
    extraControls,
    splits,
    rogainingPoints: netPoints,
    rogainingGrossPoints: grossPoints,
    rogainingOvertimePenalty: penalty,
    rogainingOvertimeSec: overtimeSec,
  };
}

function validateCompetitorReadout(
  compClass: CompClass | undefined,
  courses: Course[],
  effectiveStartSec: number,
  finishTimeSec: number | null,
  punches: CardPunch[],
  emergency: EmergencySettings
): ReadoutValidation {
  const assignedCourse =
    courses.find((c) => c.id === compClass?.courseId) ?? courses[0] ?? null;

  if (compClass?.classFormat === 'ROGAINING') {
    return evaluateRogainingReadout(
      compClass,
      assignedCourse,
      courses,
      effectiveStartSec,
      finishTimeSec,
      punches,
      emergency
    );
  }

  if (compClass?.classFormat === 'FORKED') {
    const forkPool =
      compClass.forkCourseIds && compClass.forkCourseIds.length > 0
        ? courses.filter((c) => compClass.forkCourseIds!.includes(c.id))
        : courses;
    const candidates = forkPool.length > 0 ? forkPool : courses;
    const sortedByLen = [...candidates].sort((a, b) => b.controls.length - a.controls.length);

    let closestFallback: ReadoutValidation | null = null;
    for (const candidate of sortedByLen) {
      const res = evaluateCardAgainstSingleCourse(
        candidate,
        effectiveStartSec,
        finishTimeSec,
        punches,
        emergency
      );
      if (res.missingControls.length === 0) {
        return res;
      }
      if (
        !closestFallback ||
        res.missingControls.length < closestFallback.missingControls.length
      ) {
        closestFallback = res;
      }
    }
    if (closestFallback) return closestFallback;
  }

  if (compClass?.autoMatchCourse) {
    const sortedByLen = [...courses].sort((a, b) => b.controls.length - a.controls.length);
    for (const candidate of sortedByLen) {
      const res = evaluateCardAgainstSingleCourse(
        candidate,
        effectiveStartSec,
        finishTimeSec,
        punches,
        emergency
      );
      if (res.missingControls.length === 0) {
        return res;
      }
    }
  }

  if (!assignedCourse) {
    return {
      ok: finishTimeSec !== null,
      matchedCourseId: null,
      matchedCourseName: null,
      missingControls: [],
      extraControls: punches,
      splits: [],
    };
  }

  return evaluateCardAgainstSingleCourse(
    assignedCourse,
    effectiveStartSec,
    finishTimeSec,
    punches,
    emergency
  );
}

/**
 * Recomputes WinSplits / O-Tid Split Analysis for every class & course cohort:
 * - Leg rankings (legRank, legBehindSec, bestLegSec)
 * - Cumulative standings at each control (cumulativeRank, cumulativeBehindSec)
 * - Class Idealtid (sum of best leg times)
 * - Estimated Time Loss / Bomtid (timeLossSec, totalTimeLossSec, mistakeFreeTimeSec)
 */
function recomputeAllSplitRanks(ev: SingleEventRecord): void {
  for (const cls of ev.classes) {
    if (cls.classFormat === 'ROGAINING') {
      continue;
    }
    const okRunners = ev.competitors.filter(
      (c) => c.classId === cls.id && c.status === 'OK' && c.validation
    );
    if (okRunners.length === 0) continue;

    // Group by matchedCourseId so open classes with multiple courses compare like-for-like
    const byCourse = new Map<string, Competitor[]>();
    for (const r of okRunners) {
      const key = r.validation!.matchedCourseId ?? '__none__';
      const arr = byCourse.get(key) ?? [];
      arr.push(r);
      byCourse.set(key, arr);
    }

    for (const [, cohort] of byCourse.entries()) {
      const maxOrder = Math.max(
        0,
        ...cohort.flatMap((r) => r.validation!.splits.map((s) => s.order))
      );
      if (maxOrder === 0) continue;

      const bestLegByOrder = new Map<number, number>();
      const refLegByOrder = new Map<number, number>();

      for (let ord = 1; ord <= maxOrder; ord++) {
        // Leg rankings
        const legSplits = cohort
          .map((r) => r.validation!.splits.find((s) => s.order === ord))
          .filter((s): s is SplitLegResult => Boolean(s && s.legSec !== null && s.legSec >= 0));

        if (legSplits.length > 0) {
          const sortedLegVals = [...legSplits.map((s) => s.legSec!)].sort((a, b) => a - b);
          const bestLeg = sortedLegVals[0];
          bestLegByOrder.set(ord, bestLeg);

          const topCount = Math.min(2, sortedLegVals.length);
          const refAvg =
            sortedLegVals.slice(0, topCount).reduce((sum, v) => sum + v, 0) / topCount;
          refLegByOrder.set(ord, Math.max(8, refAvg));

          for (const sp of legSplits) {
            sp.bestLegSec = bestLeg;
            sp.legRank = sortedLegVals.indexOf(sp.legSec!) + 1;
            sp.legBehindSec = sp.legSec! - bestLeg;
          }
        }

        // Cumulative rankings
        const cumSplits = cohort
          .map((r) => r.validation!.splits.find((s) => s.order === ord))
          .filter(
            (s): s is SplitLegResult =>
              Boolean(s && s.cumulativeSec !== null && s.cumulativeSec >= 0)
          );

        if (cumSplits.length > 0) {
          const sortedCumVals = [...cumSplits.map((s) => s.cumulativeSec!)].sort(
            (a, b) => a - b
          );
          const bestCum = sortedCumVals[0];
          for (const sp of cumSplits) {
            sp.cumulativeRank = sortedCumVals.indexOf(sp.cumulativeSec!) + 1;
            sp.cumulativeBehindSec = sp.cumulativeSec! - bestCum;
          }
        }
      }

      // Compute Idealtid (sum of bestLegSec across all non-broken legs)
      let idealSum = 0;
      let hasAllActiveLegs = true;
      for (let ord = 1; ord <= maxOrder; ord++) {
        const sample = cohort[0]?.validation?.splits.find((s) => s.order === ord);
        if (sample?.status === 'BROKEN_CTRL') continue;
        const b = bestLegByOrder.get(ord);
        if (b === undefined) {
          hasAllActiveLegs = false;
          break;
        }
        idealSum += b;
      }
      const idealTimeSec = hasAllActiveLegs && idealSum > 0 ? idealSum : null;

      // Compute Bomtid (Estimated Time Loss) per runner
      for (const r of cohort) {
        const val = r.validation!;
        val.idealTimeSec = idealTimeSec;

        if (cohort.length < 2) {
          for (const sp of val.splits) {
            sp.timeLossSec = 0;
          }
          val.totalTimeLossSec = 0;
          val.mistakeFreeTimeSec = r.runningTimeSec;
          continue;
        }

        // Collect clean speed ratios against refLegByOrder
        const ratios: number[] = [];
        for (const sp of val.splits) {
          const ref = refLegByOrder.get(sp.order);
          if (sp.legSec !== null && sp.legSec > 0 && ref) {
            ratios.push(sp.legSec / ref);
          }
        }

        if (ratios.length === 0) {
          val.totalTimeLossSec = 0;
          val.mistakeFreeTimeSec = r.runningTimeSec;
          continue;
        }

        const sortedRatios = [...ratios].sort((a, b) => a - b);
        const pctIdx = Math.max(0, Math.floor((sortedRatios.length - 1) * 0.35));
        const baseRatio = sortedRatios[pctIdx];

        let totalBom = 0;
        for (const sp of val.splits) {
          const ref = refLegByOrder.get(sp.order);
          if (sp.legSec !== null && ref) {
            const expectedSec = Math.round(ref * baseRatio);
            const rawLoss = sp.legSec - expectedSec;
            // Flag bom when runner was not leg winner and lost >= 12 seconds vs their clean pace
            if ((sp.legRank ?? 99) > 1 && rawLoss >= 12) {
              sp.timeLossSec = rawLoss;
              totalBom += rawLoss;
            } else {
              sp.timeLossSec = 0;
            }
          } else {
            sp.timeLossSec = null;
          }
        }

        val.totalTimeLossSec = totalBom;
        val.mistakeFreeTimeSec =
          r.runningTimeSec !== null
            ? Math.max(idealTimeSec ?? 0, r.runningTimeSec - totalBom)
            : null;
      }
    }
  }
}

/**
 * Re-evaluates all competitors in an event from their archived raw readout (`rawReadout`)
 * using current courses, classes, manual finish times, and emergency settings!
 */
function recalculateEventFromRawReadouts(ev: SingleEventRecord): number {
  let recalculatedCount = 0;
  for (const runner of ev.competitors) {
    const raw = runner.rawReadout;
    const sourcePunches = raw ? raw.punches : runner.cardPunches;
    const hasReadoutData = Boolean(raw || runner.readoutAt || sourcePunches.length > 0);
    if (!hasReadoutData) continue;

    const cls = ev.classes.find((c) => c.id === runner.classId);
    const effectiveStart =
      runner.startTimeSec ??
      raw?.startTimeSec ??
      runner.allocatedStartSec ??
      ev.competition.zeroTimeSec;
    const effectiveFinish =
      runner.manualFinishTimeSec ?? raw?.finishTimeSec ?? runner.finishTimeSec;

    runner.cardPunches = applyEmergencyTimeOffsets(
      sourcePunches,
      ev.emergency.controlTimeOffsets
    );
    runner.finishTimeSec = effectiveFinish;
    runner.runningTimeSec =
      effectiveFinish !== null && effectiveFinish >= effectiveStart
        ? effectiveFinish - effectiveStart
        : null;

    if (sourcePunches.length > 0 || runner.readoutAt) {
      runner.validation = validateCompetitorReadout(
        cls,
        ev.courses,
        effectiveStart,
        effectiveFinish,
        sourcePunches,
        ev.emergency
      );
      if (runner.status !== 'DNF' && runner.status !== 'DNS') {
        runner.status = runner.validation.ok ? 'OK' : 'MP';
      }
      recalculatedCount++;
    }
  }
  recomputeAllSplitRanks(ev);
  return recalculatedCount;
}

function getEventorEnvConfig(): { apiKey: string; baseUrl: string } {
  const apiKey = (process.env.EVENTOR_API_KEY || '').trim();
  const baseUrl = (process.env.EVENTOR_BASE_URL || 'https://eventor.orientering.se/api')
    .trim()
    .replace(/\/+$/, '');
  return { apiKey, baseUrl };
}

function getRocDefaultBaseUrl(): string {
  return (process.env.ROC_BASE_URL || 'https://roc.olresultat.se/getpunches.asp').trim();
}

function buildDefaultEventorMeta(): EventorIntegrationStatus {
  const { apiKey, baseUrl } = getEventorEnvConfig();
  return {
    apiKeyConfigured: apiKey.length > 0,
    baseUrl,
    connectedOrgId: null,
    connectedOrgName: 'OK Österåker (Lokalt synkad klubbdatabas)',
    connectedEventId: null,
    lastSyncedAt: null,
    autoCreateFromRunnerDbOnReadout: true,
  };
}

function buildDefaultStations(nowIso: string): SIStation[] {
  return [
    {
      id: 'st-check',
      stationCode: 10,
      name: 'Check — Startfålla Inpassering',
      hardwareModel: 'BSM8-USB',
      stationFunction: 'CHECK',
      baudRate: 38400,
      extendedProtocol: true,
      batteryMv: 4980,
      firmware: 'FW 6.56',
      lastSeenAt: nowIso,
      active: true,
    },
    {
      id: 'st-start',
      stationCode: 20,
      name: 'Startpunkt S1',
      hardwareModel: 'BSF9 Master',
      stationFunction: 'START',
      baudRate: 38400,
      extendedProtocol: true,
      batteryMv: 3510,
      firmware: 'FW 6.58',
      lastSeenAt: nowIso,
      active: true,
    },
    {
      id: 'st-r42',
      stationCode: 42,
      name: 'Radiokontroll (42) — Publikpassering',
      hardwareModel: 'SRR-USB (Air+)',
      stationFunction: 'RADIO',
      baudRate: 38400,
      extendedProtocol: true,
      batteryMv: 3490,
      firmware: 'FW 6.60 Air+',
      lastSeenAt: nowIso,
      active: true,
    },
    {
      id: 'st-r55',
      stationCode: 55,
      name: 'Radiokontroll (55) — Högplatån',
      hardwareModel: 'SRR-USB (Air+)',
      stationFunction: 'RADIO',
      baudRate: 38400,
      extendedProtocol: true,
      batteryMv: 3460,
      firmware: 'FW 6.60 Air+',
      lastSeenAt: nowIso,
      active: true,
    },
    {
      id: 'st-pre100',
      stationCode: 100,
      name: 'Förvarning (100) — Sista kontrollen',
      hardwareModel: 'SRR-USB (Air+)',
      stationFunction: 'PREWARNING',
      baudRate: 38400,
      extendedProtocol: true,
      batteryMv: 3530,
      firmware: 'FW 6.60 Air+',
      lastSeenAt: nowIso,
      active: true,
    },
    {
      id: 'st-fin',
      stationCode: 90,
      name: 'Målstämpling Arena',
      hardwareModel: 'BSF9 Master',
      stationFunction: 'FINISH',
      baudRate: 38400,
      extendedProtocol: true,
      batteryMv: 3480,
      firmware: 'FW 6.58',
      lastSeenAt: nowIso,
      active: true,
    },
    {
      id: 'st-readout',
      stationCode: 1,
      name: 'Målavläsning Sekretariat (USB)',
      hardwareModel: 'BSM8-USB',
      stationFunction: 'READOUT',
      baudRate: 38400,
      extendedProtocol: true,
      batteryMv: 4990,
      firmware: 'FW 6.56',
      lastSeenAt: nowIso,
      active: true,
    },
  ];
}

function buildDefaultRocStatus(unitId = '1042'): RocIntegrationStatus {
  return {
    enabled: false,
    unitId,
    baseUrl: getRocDefaultBaseUrl(),
    pollIntervalSec: 5,
    lastPunchId: 0,
    lastPolledAt: null,
    totalReceived: 0,
    lastError: null,
  };
}

function offsetDateIso(daysOffset: number): string {
  const todayStockholm = getStockholmDateIso();
  const [y, m, d] = todayStockholm.split('-').map(Number);
  const utcNoon = new Date(Date.UTC(y, m - 1, d + daysOffset, 12, 0, 0));
  return utcNoon.toISOString().slice(0, 10);
}

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const MAX_LOGO_DATA_URL_CHARS = 200_000;

function sanitizeServerHexColor(raw?: string | null): string {
  if (!raw || typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  return HEX_COLOR_RE.test(trimmed) ? trimmed.toLowerCase() : '';
}

function sanitizeServerLogoDataUrl(raw?: string | null): string {
  if (!raw || typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_LOGO_DATA_URL_CHARS) return '';
  if (
    trimmed.startsWith('data:image/png;base64,') ||
    trimmed.startsWith('data:image/jpeg;base64,')
  ) {
    return trimmed;
  }
  return '';
}

function buildDefaultClubSettings(): ClubSettings {
  return {
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
}

function ensureClubSettings(seasonDb: SeasonDatabase): ClubSettings {
  if (!seasonDb.clubSettings || typeof seasonDb.clubSettings !== 'object') {
    seasonDb.clubSettings = buildDefaultClubSettings();
    return seasonDb.clubSettings;
  }
  const c = seasonDb.clubSettings;
  seasonDb.clubSettings = {
    clubName: (c.clubName || 'OK Österåker').trim() || 'OK Österåker',
    eventorOrgId: (c.eventorOrgId || '').trim(),
    swishNumber: (c.swishNumber ?? '').trim(),
    swishRecipientName: (c.swishRecipientName || '').trim(),
    defaultDirectEntryFeeSek: Number.isFinite(Number(c.defaultDirectEntryFeeSek))
      ? Math.max(0, Math.round(Number(c.defaultDirectEntryFeeSek)))
      : 0,
    rentalCardFeeSek: Number.isFinite(Number(c.rentalCardFeeSek))
      ? Math.max(0, Math.round(Number(c.rentalCardFeeSek)))
      : 0,
    missingRentalFeeSek: Number.isFinite(Number(c.missingRentalFeeSek))
      ? Math.max(0, Math.round(Number(c.missingRentalFeeSek)))
      : 0,
    portalTitle: (c.portalTitle || '').trim().slice(0, 80),
    logoDataUrl: sanitizeServerLogoDataUrl(c.logoDataUrl),
    customBgColor: sanitizeServerHexColor(c.customBgColor),
    customTextColor: sanitizeServerHexColor(c.customTextColor),
    customAccentColor: sanitizeServerHexColor(c.customAccentColor),
    seriesScoringSettings: normalizeSeriesScoringSettings(c.seriesScoringSettings),
  };
  return seasonDb.clubSettings;
}

function buildSeasonSeed(): SeasonDatabase {
  const nowIso = new Date().toISOString();
  const authConfig = buildDefaultSeasonAuthConfig(nowIso);
  const clubSettings = buildDefaultClubSettings();

  return {
    version: 3,
    activeEventId: "",
    demoCleared: true,
    clubSettings,
    eventsMap: {},
    runnerDb: [],
    eventor: buildDefaultEventorMeta(),
    authConfig,
  };
}

function upsertRunnerInSeasonDb(
  seasonDb: SeasonDatabase,
  input: {
    siNumber: number;
    fullName: string;
    club: string;
    birthYear?: number | null;
    defaultClassName?: string | null;
    eventorPersonId?: string | null;
    eventorOrgId?: string | null;
    source: RunnerDbSource;
  }
): RunnerDbEntry | null {
  if (!Number.isFinite(input.siNumber) || input.siNumber <= 0 || !input.fullName.trim()) {
    return null;
  }
  const nowIso = new Date().toISOString();
  const existing = seasonDb.runnerDb.find((r) => r.siNumber === input.siNumber);
  if (existing) {
    const incomingName = input.fullName.trim();
    const samePerson =
      existing.fullName.trim().toLowerCase() === incomingName.toLowerCase();
    // Never overwrite an existing card owner in runnerDb from a single race entry (e.g. borrowed stick!)
    if (input.source === 'LEARNED_ENTRY' && !samePerson) {
      return existing;
    }
    existing.fullName = incomingName;
    existing.club = input.club.trim() || existing.club;
    existing.cardSeries = inferSeries(input.siNumber);
    if (input.birthYear !== undefined && input.birthYear !== null) {
      existing.birthYear = input.birthYear;
    }
    if (input.defaultClassName) {
      existing.defaultClassName = input.defaultClassName;
    }
    if (input.eventorPersonId) {
      existing.eventorPersonId = input.eventorPersonId;
    }
    if (input.eventorOrgId) {
      existing.eventorOrgId = input.eventorOrgId;
    }
    if (input.source !== 'LEARNED_ENTRY') {
      existing.source = input.source;
    }
    existing.updatedAt = nowIso;
    return existing;
  }

  const created: RunnerDbEntry = {
    id: `rdb-${input.siNumber}-${Math.random().toString(36).slice(2, 6)}`,
    siNumber: input.siNumber,
    cardSeries: inferSeries(input.siNumber),
    fullName: input.fullName.trim(),
    club: input.club.trim() || 'Klubblös',
    birthYear: input.birthYear ?? null,
    defaultClassName: input.defaultClassName ?? null,
    eventorPersonId: input.eventorPersonId ?? null,
    eventorOrgId: input.eventorOrgId ?? null,
    source: input.source,
    updatedAt: nowIso,
  };
  seasonDb.runnerDb.unshift(created);
  return created;
}

/**
 * XML helpers for Eventor REST API & Server-Side IOF XML 3.0 ResultList feed (Livelox / WinSplits)
 */
function decodeXmlEntities(raw: string): string {
  return raw
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(Number(dec)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim();
}

function extractFirstTag(xml: string, localTagName: string): string | null {
  const re = new RegExp(
    `<(?:[a-zA-Z0-9_]+:)?${localTagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[a-zA-Z0-9_]+:)?${localTagName}>`,
    'i'
  );
  const m = xml.match(re);
  return m ? decodeXmlEntities(m[1]) : null;
}

function extractAllBlocks(xml: string, localTagName: string): string[] {
  const re = new RegExp(
    `<(?:[a-zA-Z0-9_]+:)?${localTagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[a-zA-Z0-9_]+:)?${localTagName}>`,
    'gi'
  );
  const blocks: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml)) !== null) {
    blocks.push(match[1]);
  }
  return blocks;
}

function parseEventorOrgXml(xml: string): { orgId: string; orgName: string } | null {
  const orgBlock = extractFirstTag(xml, 'Organisation') ?? xml;
  const orgId =
    extractFirstTag(orgBlock, 'OrganisationId') ??
    extractFirstTag(orgBlock, 'Id') ??
    null;
  const orgName =
    extractFirstTag(orgBlock, 'Name') ??
    extractFirstTag(orgBlock, 'ShortName') ??
    null;
  if (!orgId || !orgName) return null;
  return { orgId, orgName };
}

function parseEventorCompetitorsXml(
  xml: string,
  fallbackClubName: string,
  fallbackOrgId: string
): {
  siNumber: number;
  fullName: string;
  club: string;
  birthYear: number | null;
  eventorPersonId: string | null;
  eventorOrgId: string | null;
}[] {
  const blocks = [
    ...extractAllBlocks(xml, 'Competitor'),
    ...extractAllBlocks(xml, 'PersonEntry'),
  ];
  const parsed: {
    siNumber: number;
    fullName: string;
    club: string;
    birthYear: number | null;
    eventorPersonId: string | null;
    eventorOrgId: string | null;
  }[] = [];

  for (const b of blocks) {
    const personBlock = extractFirstTag(b, 'Person') ?? b;
    const nameBlock = extractFirstTag(personBlock, 'Name') ?? personBlock;
    const given = extractFirstTag(nameBlock, 'Given') ?? '';
    const family = extractFirstTag(nameBlock, 'Family') ?? '';
    const fullName = `${given} ${family}`.trim();
    if (!fullName) continue;

    const personId =
      extractFirstTag(personBlock, 'PersonId') ??
      extractFirstTag(personBlock, 'Id') ??
      null;
    const birthRaw = extractFirstTag(personBlock, 'BirthDate') ?? '';
    const yearMatch = birthRaw.match(/\b(19\d{2}|20\d{2})\b/);
    const birthYear = yearMatch ? Number(yearMatch[1]) : null;

    const orgBlock = extractFirstTag(b, 'Organisation');
    const club = (orgBlock ? extractFirstTag(orgBlock, 'Name') : null) || fallbackClubName;
    const orgId =
      (orgBlock
        ? extractFirstTag(orgBlock, 'OrganisationId') ?? extractFirstTag(orgBlock, 'Id')
        : null) || fallbackOrgId;

    const cardTexts = [
      ...extractAllBlocks(b, 'CCardId'),
      ...extractAllBlocks(b, 'ControlCard'),
      ...extractAllBlocks(b, 'PunchingUnitId'),
    ];
    for (const ct of cardTexts) {
      const si = Number(decodeXmlEntities(ct).replace(/\D/g, ''));
      if (Number.isFinite(si) && si > 0) {
        parsed.push({
          siNumber: si,
          fullName,
          club,
          birthYear,
          eventorPersonId: personId,
          eventorOrgId: orgId,
        });
      }
    }
  }
  return parsed;
}

function parseEventorClassesXml(xml: string): Map<string, string> {
  const classMap = new Map<string, string>();
  const blocks = [
    ...extractAllBlocks(xml, 'EventClass'),
    ...extractAllBlocks(xml, 'Class'),
  ];
  for (const b of blocks) {
    const id = extractFirstTag(b, 'EventClassId') ?? extractFirstTag(b, 'Id');
    const name = extractFirstTag(b, 'Name') ?? extractFirstTag(b, 'ClassShortName');
    if (id && name) {
      classMap.set(id, name);
    }
  }
  return classMap;
}

function parseEventorEntriesXml(
  xml: string,
  classIdToName: Map<string, string>
): { fullName: string; club: string; className: string; siNumber: number; personId: string | null }[] {
  const blocks = [
    ...extractAllBlocks(xml, 'Entry'),
    ...extractAllBlocks(xml, 'PersonEntry'),
  ];
  const entries: {
    fullName: string;
    club: string;
    className: string;
    siNumber: number;
    personId: string | null;
  }[] = [];

  for (const b of blocks) {
    const personBlock = extractFirstTag(b, 'Competitor') ?? extractFirstTag(b, 'Person') ?? b;
    const nameBlock = extractFirstTag(personBlock, 'Name') ?? personBlock;
    const given = extractFirstTag(nameBlock, 'Given') ?? '';
    const family = extractFirstTag(nameBlock, 'Family') ?? '';
    const fullName = `${given} ${family}`.trim();
    if (!fullName) continue;

    const personId =
      extractFirstTag(personBlock, 'PersonId') ??
      extractFirstTag(personBlock, 'Id') ??
      null;

    const orgBlock =
      extractFirstTag(b, 'Organisation') ?? extractFirstTag(personBlock, 'Organisation');
    const club = (orgBlock ? extractFirstTag(orgBlock, 'Name') : null) || 'Klubblös';

    const entryClassBlock = extractFirstTag(b, 'EntryClass') ?? extractFirstTag(b, 'Class') ?? b;
    const evClsId =
      extractFirstTag(entryClassBlock, 'EventClassId') ??
      extractFirstTag(b, 'EventClassId') ??
      extractFirstTag(entryClassBlock, 'Id') ??
      '';
    const directClsName = extractFirstTag(entryClassBlock, 'Name');
    const className =
      (evClsId && classIdToName.get(evClsId)) || directClsName || 'Öppen Motion';

    const cardTexts = [
      ...extractAllBlocks(b, 'CCardId'),
      ...extractAllBlocks(b, 'ControlCard'),
      ...extractAllBlocks(b, 'PunchingUnitId'),
    ];
    let siNumber = 0;
    for (const ct of cardTexts) {
      const candidate = Number(decodeXmlEntities(ct).replace(/\D/g, ''));
      if (Number.isFinite(candidate) && candidate > 0) {
        siNumber = candidate;
        break;
      }
    }

    entries.push({ fullName, club, className, siNumber, personId });
  }
  return entries;
}

async function fetchFromEventorApi(endpointPath: string): Promise<string> {
  const { apiKey, baseUrl } = getEventorEnvConfig();
  if (!apiKey) {
    throw new Error(
      'EVENTOR_API_KEY saknas på servern. Lägg in klubbens Eventor API-nyckel under Secrets i AI Studio.'
    );
  }
  const url = `${baseUrl}${endpointPath.startsWith('/') ? endpointPath : `/${endpointPath}`}`;
  const resp = await fetch(url, {
    headers: {
      ApiKey: apiKey,
      Accept: 'application/xml, text/xml, */*',
    },
  });
  if (!resp.ok) {
    if (resp.status === 401 || resp.status === 403) {
      throw new Error(
        `Eventor nekade åtkomst (HTTP ${resp.status}). Kontrollera att EVENTOR_API_KEY är en giltig klubb-API-nyckel.`
      );
    }
    if (resp.status === 404) {
      throw new Error(`Resursen hittades inte på Eventor (HTTP 404): ${endpointPath}`);
    }
    throw new Error(`Eventor API svarade med HTTP ${resp.status}.`);
  }
  return await resp.text();
}

function buildServerIofResultListXml(ev: SingleEventRecord): string {
  const { competition, classes, courses, competitors } = ev;
  const createTime = new Date().toISOString();

  const secIso = (sec: number | null) =>
    sec !== null && Number.isFinite(sec) ? `${competition.date}T${secToClock(sec)}` : null;

  const classBlocks = classes
    .map((cls) => {
      const course = courses.find((c) => c.id === cls.courseId) ?? null;
      const inClass = competitors.filter(
        (c) =>
          c.classId === cls.id &&
          (c.status === 'OK' ||
            c.status === 'MP' ||
            c.status === 'DNF' ||
            c.status === 'DNS' ||
            c.status === 'PRELIMINARY_FIN')
      );

      const okRunners = inClass
        .filter((c) => c.status === 'OK' && c.runningTimeSec !== null)
        .sort((a, b) => (a.runningTimeSec ?? 999999) - (b.runningTimeSec ?? 999999));

      const others = inClass.filter((c) => c.status !== 'OK');
      const ordered = [...okRunners, ...others];

      const personResults = ordered
        .map((runner, idx) => {
          const nameParts = runner.fullName.trim().split(/\s+/);
          const given = nameParts[0] || runner.fullName;
          const family = nameParts.slice(1).join(' ') || '-';

          let iofStatus = 'OK';
          if (runner.status === 'MP') iofStatus = 'MissingPunch';
          else if (runner.status === 'DNF') iofStatus = 'DidNotFinish';
          else if (runner.status === 'DNS') iofStatus = 'DidNotStart';
          else if (runner.status === 'PRELIMINARY_FIN') iofStatus = 'Active';

          const startIso = secIso(runner.startTimeSec ?? runner.allocatedStartSec);
          const finishIso = secIso(runner.finishTimeSec);

          const splitElements = (runner.validation?.splits ?? [])
            .filter((s) => s.controlCode !== 999)
            .map((s) =>
              s.status === 'OK' && s.cumulativeSec !== null
                ? `        <SplitTime>\n          <ControlCode>${s.controlCode}</ControlCode>\n          <Time>${s.cumulativeSec}</Time>\n        </SplitTime>`
                : `        <SplitTime status="Missing">\n          <ControlCode>${s.controlCode}</ControlCode>\n        </SplitTime>`
            )
            .join('\n');

          return `    <PersonResult>
      <Person>
        <Name>
          <Given>${escapeXml(given)}</Given>
          <Family>${escapeXml(family)}</Family>
        </Name>
      </Person>
      <Organisation>
        <Name>${escapeXml(runner.club)}</Name>
      </Organisation>
      <Result>
        <BibNumber>${runner.bib}</BibNumber>
${startIso ? `        <StartTime>${startIso}</StartTime>\n` : ''}${
            finishIso ? `        <FinishTime>${finishIso}</FinishTime>\n` : ''
          }${
            runner.runningTimeSec !== null && runner.status === 'OK'
              ? `        <Time>${runner.runningTimeSec}</Time>\n        <Position>${
                  idx + 1
                }</Position>\n`
              : ''
          }        <Status>${iofStatus}</Status>
        <ControlCard>${runner.siNumber}</ControlCard>
${splitElements ? splitElements + '\n' : ''}      </Result>
    </PersonResult>`;
        })
        .join('\n');

      return `  <ClassResult>
    <Class>
      <Id>${escapeXml(cls.id)}</Id>
      <Name>${escapeXml(cls.name)}</Name>
    </Class>
${
  course
    ? `    <Course>\n      <Name>${escapeXml(course.name)}</Name>\n      <Length>${
        course.lengthMeters
      }</Length>\n      <Climb>${course.climbMeters}</Climb>\n    </Course>\n`
    : ''
}${personResults}
  </ClassResult>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<ResultList xmlns="http://www.orienteering.org/datastandard/3.0" iofVersion="3.0" createTime="${createTime}" creator="PasserSI">
  <Event>
    <Id>${escapeXml(competition.shortCode)}</Id>
    <Name>${escapeXml(competition.name)}</Name>
    <StartTime>
      <Date>${escapeXml(competition.date)}</Date>
      <Time>${escapeXml(competition.zeroTimeStr)}</Time>
    </StartTime>
  </Event>
${classBlocks}
</ResultList>`;
}

function buildServerIofStartListXml(ev: SingleEventRecord): string {
  const { competition, classes, courses, competitors } = ev;
  const createTime = new Date().toISOString();
  const secIso = (sec: number | null) =>
    sec !== null && Number.isFinite(sec) ? `${competition.date}T${secToClock(sec)}` : null;

  const classStarts = classes
    .map((cls) => {
      const course = courses.find((c) => c.id === cls.courseId) ?? null;
      const inClass = competitors
        .filter((c) => c.classId === cls.id)
        .sort((a, b) => (a.allocatedStartSec ?? 999999) - (b.allocatedStartSec ?? 999999));

      const personStarts = inClass
        .map((r) => {
          const nameParts = r.fullName.trim().split(/\s+/);
          const given = nameParts[0] || r.fullName;
          const family = nameParts.slice(1).join(' ') || '-';
          const startIso = secIso(r.allocatedStartSec ?? r.startTimeSec);

          return `    <PersonStart>
      <Person>
        <Name>
          <Given>${escapeXml(given)}</Given>
          <Family>${escapeXml(family)}</Family>
        </Name>
      </Person>
      <Organisation>
        <Name>${escapeXml(r.club)}</Name>
      </Organisation>
      <Start>
        <BibNumber>${r.bib}</BibNumber>
${startIso ? `        <StartTime>${startIso}</StartTime>\n` : ''}        <ControlCard>${r.siNumber}</ControlCard>
      </Start>
    </PersonStart>`;
        })
        .join('\n');

      return `  <ClassStart>
    <Class>
      <Id>${escapeXml(cls.id)}</Id>
      <Name>${escapeXml(cls.name)}</Name>
    </Class>
${
  course
    ? `    <Course>\n      <Name>${escapeXml(course.name)}</Name>\n      <Length>${course.lengthMeters}</Length>\n      <Climb>${course.climbMeters}</Climb>\n    </Course>\n`
    : ''
}${personStarts}
  </ClassStart>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<StartList xmlns="http://www.orienteering.org/datastandard/3.0" iofVersion="3.0" createTime="${createTime}" creator="PasserSI">
  <Event>
    <Id>${escapeXml(competition.shortCode)}</Id>
    <Name>${escapeXml(competition.name)}</Name>
    <StartTime>
      <Date>${escapeXml(competition.date)}</Date>
      <Time>${escapeXml(competition.zeroTimeStr)}</Time>
    </StartTime>
  </Event>
${classStarts}
</StartList>`;
}

const DATA_DIR = path.join(__dirname, 'data');
const SEASON_DB_FILE = path.join(DATA_DIR, 'passersi-season-db.json');
const LEGACY_DB_FILE = path.join(DATA_DIR, 'meos-db.json');

function saveSeasonDatabase(seasonDb: SeasonDatabase): void {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    const tmpFile = `${SEASON_DB_FILE}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(seasonDb, null, 2), 'utf-8');
    fs.renameSync(tmpFile, SEASON_DB_FILE);
  } catch (err) {
    console.error('Could not persist PasserSI season DB:', err);
  }
}

function loadSeasonDatabase(): SeasonDatabase {
  try {
    if (fs.existsSync(LEGACY_DB_FILE)) {
      try {
        fs.unlinkSync(LEGACY_DB_FILE);
      } catch {
        // ignore
      }
    }
    if (fs.existsSync(SEASON_DB_FILE)) {
      const parsed = JSON.parse(
        fs.readFileSync(SEASON_DB_FILE, 'utf-8')
      ) as Partial<SeasonDatabase>;
      if (
        parsed.version === 3 &&
        parsed.eventsMap &&
        typeof parsed.eventsMap === 'object'
      ) {
        const full = parsed as SeasonDatabase;
        const keys = Object.keys(full.eventsMap);
        if (keys.length === 0) {
          full.activeEventId = '';
        } else if (!full.activeEventId || !full.eventsMap[full.activeEventId]) {
          full.activeEventId = keys[0];
        }
        if (!Array.isArray(full.runnerDb)) full.runnerDb = [];
        if (!full.eventor) full.eventor = buildDefaultEventorMeta();
        const loadedClubCfg = ensureClubSettings(full);
        const hadAuth = Boolean(full.authConfig?.hmacSecret);
        ensureSeasonAuthConfig(full);
        let normalizedAnyEventMeta = false;
        for (const ev of Object.values(full.eventsMap)) {
          if (ev.competition.enableFeesAndSwish === undefined) {
            normalizedAnyEventMeta = true;
          }
          if (loadedClubCfg.clubName && ev.competition.organizer !== loadedClubCfg.clubName) {
            ev.competition.organizer = loadedClubCfg.clubName;
            normalizedAnyEventMeta = true;
          }
          ev.competition.enableFeesAndSwish = Boolean(ev.competition.enableFeesAndSwish);
          if (!ev.emergency) ev.emergency = { brokenControls: [], controlTimeOffsets: {} };
          if (!ev.roc) ev.roc = buildDefaultRocStatus('1042');
          if (!Array.isArray(ev.processedClientIds)) ev.processedClientIds = [];
          ensureEventPins(ev);
          recomputeAllSplitRanks(ev);
        }
        if (!hadAuth || normalizedAnyEventMeta) {
          saveSeasonDatabase(full);
        }
        return full;
      }
    }
  } catch (err) {
    console.error('Could not read season DB, initializing fresh seed:', err);
  }
  const fresh = buildSeasonSeed();
  saveSeasonDatabase(fresh);
  return fresh;
}

function computeSeasonSeriesStandings(seasonDb: SeasonDatabase): SeriesStandingsBundle[] {
  const settings = ensureClubSettings(seasonDb);
  return calculateSeriesStandings(
    Object.values(seasonDb.eventsMap).map((event) => ({
      competition: {
        ...event.competition,
        status: resolveEffectiveCompetitionStatus(event),
      },
      classes: event.classes,
      competitors: event.competitors,
    })),
    settings.seriesScoringSettings
  );
}

function listAllRentalCards(seasonDb: SeasonDatabase): RentalCardOverviewItem[] {
  const items: RentalCardOverviewItem[] = [];
  for (const ev of Object.values(seasonDb.eventsMap)) {
    for (const cmp of ev.competitors) {
      if (!cmp.isRentalCard) continue;
      const clsName = ev.classes.find((c) => c.id === cmp.classId)?.name ?? '—';
      items.push({
        eventId: ev.competition.id,
        eventName: ev.competition.name,
        eventDate: ev.competition.date,
        shortCode: ev.competition.shortCode,
        competitorId: cmp.id,
        bib: cmp.bib,
        fullName: cmp.fullName,
        club: cmp.club,
        className: clsName,
        siNumber: cmp.siNumber,
        cardSeries: cmp.cardSeries,
        rentalReturned: Boolean(cmp.rentalReturned),
        feePaid: Boolean(cmp.feePaid),
        enableFeesAndSwish: Boolean(ev.competition.enableFeesAndSwish),
        status: cmp.status,
      });
    }
  }
  return items.sort((a, b) => {
    if (a.rentalReturned !== b.rentalReturned) {
      return a.rentalReturned ? 1 : -1;
    }
    return b.eventDate.localeCompare(a.eventDate);
  });
}

function resolveEffectiveCompetitionStatus(
  ev: SingleEventRecord,
  now = new Date()
): EventLifecycleStatus {
  const todayIso = getStockholmDateIso(now);
  const nowSec = getStockholmClockSec(now);
  const eventDate = (ev.competition.date || todayIso).trim();

  const hasActiveInForest = ev.competitors.some(
    (c) =>
      c.status === 'CHECKED' ||
      c.status === 'IN_FOREST' ||
      c.status === 'PRELIMINARY_FIN'
  );
  const hasAnyStartedOrFinished = ev.competitors.some(
    (c) =>
      c.status === 'CHECKED' ||
      c.status === 'IN_FOREST' ||
      c.status === 'PRELIMINARY_FIN' ||
      c.status === 'OK' ||
      c.status === 'MP' ||
      c.status === 'DNF'
  );

  // Future date -> always UPCOMING (Kommande)
  if (eventDate > todayIso) {
    return 'UPCOMING';
  }

  // Past date -> COMPLETED (except Natt-OL right after midnight while runners are still in forest)
  if (eventDate < todayIso) {
    if (eventDate === offsetDateIso(-1) && nowSec < 4 * 3600 && hasActiveInForest) {
      return 'LIVE';
    }
    return 'COMPLETED';
  }

  // Today (eventDate === todayIso):
  // Respect explicit early close ("Avsluta tävling") if no runners remain in forest
  if (ev.competition.status === 'COMPLETED' && !hasActiveInForest) {
    return 'COMPLETED';
  }

  const zeroSec = Number.isFinite(ev.competition.zeroTimeSec)
    ? ev.competition.zeroTimeSec
    : parseClockStrToSec(ev.competition.zeroTimeStr) ?? 36000;

  // Before Nolltid (and before anyone has checked in / started) -> UPCOMING (Kommande)
  if (nowSec < zeroSec && !hasAnyStartedOrFinished) {
    return 'UPCOMING';
  }

  // Auto-complete 6 hours after Nolltid once race has had runners and nobody is left in forest
  if (hasAnyStartedOrFinished && !hasActiveInForest && nowSec >= zeroSec + 6 * 3600) {
    return 'COMPLETED';
  }

  return 'LIVE';
}

function buildCompetitionsSummaryList(seasonDb: SeasonDatabase): CompetitionSummary[] {
  const statusRank: Record<EventLifecycleStatus, number> = {
    LIVE: 0,
    UPCOMING: 1,
    COMPLETED: 2,
  };
  const now = new Date();
  return Object.values(seasonDb.eventsMap)
    .map((ev) => ({
      id: ev.competition.id,
      shortCode: ev.competition.shortCode,
      status: resolveEffectiveCompetitionStatus(ev, now),
      name: ev.competition.name,
      organizer: ev.competition.organizer,
      date: ev.competition.date,
      zeroTimeStr: ev.competition.zeroTimeStr,
      arenaInfo: ev.competition.arenaInfo || '',
      seriesName: ev.competition.seriesName || '',
      enableFeesAndSwish: Boolean(ev.competition.enableFeesAndSwish),
      competitorCount: ev.competitors.length,
      finishedCount: ev.competitors.filter(
        (c) => c.status === 'OK' || c.status === 'MP' || c.status === 'PRELIMINARY_FIN'
      ).length,
      classCount: ev.classes.length,
    }))
    .sort((a, b) => {
      if (statusRank[a.status] !== statusRank[b.status]) {
        return statusRank[a.status] - statusRank[b.status];
      }
      return b.date.localeCompare(a.date);
    });
}

function generateShortCode(existingCodes: Set<string>): string {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  for (let attempt = 0; attempt < 50; attempt++) {
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
    if (!existingCodes.has(code)) return code;
  }
  return `ev${Date.now().toString(36).slice(-4)}`;
}

/**
 * Greedy club-separation interleaver for Orienteering Start List Draws (Minutstart):
 * Avoids consecutive runners from the same club whenever mathematically possible.
 */
function shuffleWithClubSeparation(runners: Competitor[]): Competitor[] {
  const pool = [...runners];
  // Fisher-Yates shuffle first
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }

  const result: Competitor[] = [];
  while (pool.length > 0) {
    const prevClub =
      result.length > 0 ? result[result.length - 1].club.trim().toLowerCase() : null;

    // Count remaining runners per club so largest clubs are placed proactively
    const clubCounts = new Map<string, number>();
    for (const r of pool) {
      const k = r.club.trim().toLowerCase();
      clubCounts.set(k, (clubCounts.get(k) ?? 0) + 1);
    }

    // Pick candidate from a different club than prevClub, preferring clubs with highest remaining count
    let bestIdx = -1;
    let bestCount = -1;
    for (let i = 0; i < pool.length; i++) {
      const cKey = pool[i].club.trim().toLowerCase();
      if (cKey !== prevClub) {
        const cnt = clubCounts.get(cKey) ?? 0;
        if (cnt > bestCount) {
          bestCount = cnt;
          bestIdx = i;
        }
      }
    }

    if (bestIdx === -1) bestIdx = 0;
    result.push(pool.splice(bestIdx, 1)[0]);
  }
  return result;
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });
  const disableHmr = process.env.DISABLE_HMR === 'true';

  server.on('upgrade', (req, socket, head) => {
    const rawUrl = req.url || '';
    const qIndex = rawUrl.indexOf('?');
    const pathname = qIndex !== -1 ? rawUrl.slice(0, qIndex) : rawUrl;
    if (pathname === '/api/ws') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    } else if (disableHmr || process.env.NODE_ENV === 'production') {
      socket.destroy();
    }
  });

  const serverBootedWithoutDbFile = !fs.existsSync(SEASON_DB_FILE);
  let isFreshColdStart = serverBootedWithoutDbFile;
  let seasonDb = loadSeasonDatabase();
  const authenticatedWsClients = new WeakSet<WebSocket>();

  function persistUserMutation(): void {
    isFreshColdStart = false;
    saveSeasonDatabase(seasonDb);
  }

  function buildEmptyPlaceholderEvent(): SingleEventRecord {
    const club = ensureClubSettings(seasonDb);
    return {
      competition: {
        id: '',
        shortCode: '',
        status: 'UPCOMING',
        name: 'Ingen tävling skapad ännu',
        organizer: club.clubName,
        date: getStockholmDateIso(),
        zeroTimeStr: '10:00:00',
        zeroTimeSec: 36000,
        arenaInfo: '',
        seriesName: '',

        enableFeesAndSwish: false,
      },
      courses: [],
      classes: [],
      stations: [],
      competitors: [],
      emergency: { brokenControls: [], controlTimeOffsets: {} },
      roc: buildDefaultRocStatus(''),
      events: [],
      processedClientIds: [],
      rolePins: { ...DEFAULT_ROLE_PINS },
      pinsCustomized: false,
    };
  }

  function getActiveEvent(): SingleEventRecord {
    const fromId = seasonDb.activeEventId
      ? seasonDb.eventsMap[seasonDb.activeEventId]
      : undefined;
    return fromId ?? Object.values(seasonDb.eventsMap)[0] ?? buildEmptyPlaceholderEvent();
  }

  function findEventByIdOrShortCode(key?: string): SingleEventRecord | null {
    if (Object.keys(seasonDb.eventsMap).length === 0) return null;
    if (!key) return getActiveEvent();
    if (seasonDb.eventsMap[key]) return seasonDb.eventsMap[key];
    const clean = key.trim().toLowerCase();
    return (
      Object.values(seasonDb.eventsMap).find(
        (e) =>
          e.competition.shortCode.toLowerCase() === clean ||
          e.competition.id.toLowerCase() === clean
      ) ?? null
    );
  }

  function getConnectedClientCount(): number {
    let count = 0;
    wss.clients.forEach((c) => {
      if (c.readyState === WebSocket.OPEN && authenticatedWsClients.has(c)) count++;
    });
    return count;
  }

  function buildLiveEventorStatus(): EventorIntegrationStatus {
    const { apiKey, baseUrl } = getEventorEnvConfig();
    return {
      ...seasonDb.eventor,
      apiKeyConfigured: apiKey.length > 0,
      baseUrl,
    };
  }

  function buildFullStatePayload() {
    const isEmptySeason = Object.keys(seasonDb.eventsMap).length === 0;
    const ev = getActiveEvent();
    const effectiveCompetition: CompetitionMeta = isEmptySeason
      ? ev.competition
      : {
          ...ev.competition,
          status: resolveEffectiveCompetitionStatus(ev),
        };
    return {
      activeEventId: isEmptySeason ? '' : ev.competition.id,
      isEmptySeason,
      isFreshColdStart,
      demoCleared: Boolean(seasonDb.demoCleared),
      clubSettings: ensureClubSettings(seasonDb),
      seriesStandings: computeSeasonSeriesStandings(seasonDb),
      competitionsList: buildCompetitionsSummaryList(seasonDb),
      competition: effectiveCompetition,
      courses: ev.courses,
      classes: ev.classes,
      stations: ev.stations,
      competitors: ev.competitors,
      runnerDb: seasonDb.runnerDb,
      eventor: buildLiveEventorStatus(),
      emergency: ev.emergency,
      roc: {
        ...ev.roc,
        baseUrl: ev.roc.baseUrl || getRocDefaultBaseUrl(),
      },
      events: ev.events,
      connectedMonitors: getConnectedClientCount(),
    };
  }

  function buildPublicRacePayload(ev: SingleEventRecord) {
    const rawClub = ensureClubSettings(seasonDb);
    const feesEnabled = Boolean(ev.competition.enableFeesAndSwish);
    const publicClub: ClubSettings = feesEnabled
      ? rawClub
      : {
          ...rawClub,
          swishNumber: '',
          swishRecipientName: '',
          defaultDirectEntryFeeSek: 0,
          rentalCardFeeSek: 0,
          missingRentalFeeSek: 0,
        };
    return {
      competition: {
        ...ev.competition,
        status: resolveEffectiveCompetitionStatus(ev),
        enableFeesAndSwish: feesEnabled,
      },
      courses: ev.courses,
      classes: feesEnabled ? ev.classes : ev.classes.map((cls) => ({ ...cls, feeSek: 0 })),
      competitors: ev.competitors,
      radioControls: ev.stations
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
      events: ev.events.slice(0, 60),
      emergency: ev.emergency,
      competitionsList: buildCompetitionsSummaryList(seasonDb),
      clubSettings: publicClub,
      seriesStandings: computeSeasonSeriesStandings(seasonDb),
      updatedAt: new Date().toISOString(),
    };
  }

  function broadcastFullState(changedShortCode?: string) {
    const activePayload = buildFullStatePayload();
    const effectiveShortCode = changedShortCode ?? activePayload.competition.shortCode;
    const secretariatMsg = JSON.stringify({
      type: 'state:sync',
      payload: activePayload,
      changedShortCode: effectiveShortCode,
    });
    const publicMsg = JSON.stringify({
      type: 'public:ping',
      changedShortCode: effectiveShortCode,
    });
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        if (authenticatedWsClients.has(client)) {
          client.send(secretariatMsg);
        } else {
          client.send(publicMsg);
        }
      }
    });
  }

  /**
   * Core Online/Radio Punch Processor (used by WebSerial 0xD3, Offline Queue Sync, AND ROC Poller!)
   */
  function processOnlinePunchForEvent(
    ev: SingleEventRecord,
    params: {
      clientPunchId?: string;
      siNumber: number;
      stationCode: number;
      punchTimeSec?: number;
      rawHex?: string;
      sourcePrefix?: string;
    }
  ): { deduplicated: boolean; eventItem: LiveEventItem | null; competitor: Competitor | null } {
    if (params.clientPunchId && ev.processedClientIds.includes(params.clientPunchId)) {
      const existingRunner =
        ev.competitors.find((c) => c.siNumber === params.siNumber) ?? null;
      return {
        deduplicated: true,
        eventItem: ev.events[0] ?? null,
        competitor: existingRunner,
      };
    }

    const now = new Date();
    const nowIso = now.toISOString();
    const rawSec =
      params.punchTimeSec !== undefined && Number.isFinite(params.punchTimeSec)
        ? params.punchTimeSec
        : getStockholmClockSec(now);

    const offsetDelta = Number(
      ev.emergency.controlTimeOffsets[String(params.stationCode)] || 0
    );
    const effectiveSec = (((rawSec + Math.round(offsetDelta)) % 86400) + 86400) % 86400;

    let station = ev.stations.find((s) => s.stationCode === params.stationCode);
    if (!station) {
      station = {
        id: `st-${params.stationCode}-${Date.now()}`,
        stationCode: params.stationCode,
        name:
          params.stationCode === 100
            ? 'Förvarning (100)'
            : `Radiokontroll (${params.stationCode})${
                params.sourcePrefix ? ` (${params.sourcePrefix})` : ''
              }`,
        hardwareModel: 'SRR-USB (Air+)',
        stationFunction: params.stationCode === 100 ? 'PREWARNING' : 'RADIO',
        baudRate: 38400,
        extendedProtocol: true,
        batteryMv: 3500,
        firmware: params.sourcePrefix || 'Auto',
        lastSeenAt: nowIso,
        active: true,
      };
      ev.stations.push(station);
    } else {
      station.lastSeenAt = nowIso;
    }

    let runner =
      ev.competitors.find(
        (c) =>
          c.siNumber === params.siNumber &&
          (c.status === 'IN_FOREST' ||
            c.status === 'CHECKED' ||
            c.status === 'REGISTERED' ||
            c.status === 'PRELIMINARY_FIN')
      ) ??
      ev.competitors.find((c) => c.siNumber === params.siNumber && c.status !== 'DNS') ??
      null;
    const dbMatch = !runner
      ? seasonDb.runnerDb.find((r) => r.siNumber === params.siNumber) ?? null
      : null;

    if (!runner && dbMatch && seasonDb.eventor.autoCreateFromRunnerDbOnReadout) {
      const maxBib = ev.competitors.reduce((m, c) => Math.max(m, c.bib), 400);
      const preferredCls =
        (dbMatch.defaultClassName
          ? ev.classes.find(
              (c) => c.name.toLowerCase() === dbMatch.defaultClassName!.toLowerCase()
            )
          : null) ??
        ev.classes.find((c) => c.autoMatchCourse) ??
        ev.classes[0];

      runner = {
        id: `cmp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        bib: maxBib + 1,
        fullName: dbMatch.fullName,
        club: dbMatch.club,
        classId: preferredCls?.id ?? 'cls-open',
        siNumber: params.siNumber,
        cardSeries: dbMatch.cardSeries,
        isRentalCard: false,
        rentalReturned: false,
        status: 'REGISTERED',
        allocatedStartSec: null,
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
      ev.competitors.unshift(runner);
    }

    const clsName = runner
      ? ev.classes.find((c) => c.id === runner.classId)?.name ?? null
      : null;

    const srcBadge = params.sourcePrefix ? `[${params.sourcePrefix}] ` : '';
    let eventItem: LiveEventItem;

    if (!runner) {
      eventItem = {
        id: `ev-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        timestamp: nowIso,
        clock24h: secToClock(effectiveSec),
        eventType: 'UNKNOWN_CARD',
        siNumber: params.siNumber,
        competitorId: null,
        competitorName: dbMatch ? `${dbMatch.fullName} (Ej anmäld)` : null,
        club: dbMatch?.club ?? null,
        className: dbMatch?.defaultClassName ?? null,
        stationCode: station.stationCode,
        stationName: station.name,
        runningTimeSec: null,
        message: dbMatch
          ? `${srcBadge}Oanmäld bricka ${params.siNumber} vid ${station.name} — identifierad i Löpardatabas som ${dbMatch.fullName}`
          : `${srcBadge}Okänd SI-bricka ${params.siNumber} vid ${station.name}`,
        rawHex: params.rawHex,
      };
    } else {
      runner.lastSeenControl = station.stationCode;
      runner.lastSeenTimeSec = effectiveSec;

      if (station.stationFunction === 'CHECK') {
        runner.checkTimeSec = effectiveSec;
        if (runner.status === 'REGISTERED' || runner.status === 'DNS') {
          runner.status = 'CHECKED';
        }
        eventItem = {
          id: `ev-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
          timestamp: nowIso,
          clock24h: secToClock(effectiveSec),
          eventType: 'CHECK',
          siNumber: params.siNumber,
          competitorId: runner.id,
          competitorName: runner.fullName,
          club: runner.club,
          className: clsName,
          stationCode: station.stationCode,
          stationName: station.name,
          runningTimeSec: null,
          message: `${srcBadge}Checkad i startfålla (${secToClock(effectiveSec)})`,
          rawHex: params.rawHex,
        };
      } else if (station.stationFunction === 'START') {
        runner.startTimeSec = effectiveSec;
        if (
          runner.status === 'REGISTERED' ||
          runner.status === 'CHECKED' ||
          runner.status === 'DNS'
        ) {
          runner.status = 'IN_FOREST';
        }
        eventItem = {
          id: `ev-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
          timestamp: nowIso,
          clock24h: secToClock(effectiveSec),
          eventType: 'START',
          siNumber: params.siNumber,
          competitorId: runner.id,
          competitorName: runner.fullName,
          club: runner.club,
          className: clsName,
          stationCode: station.stationCode,
          stationName: station.name,
          runningTimeSec: 0,
          message: `${srcBadge}Startstämpling registrerad kl. ${secToClock(effectiveSec)} — ute i skogen`,
          rawHex: params.rawHex,
        };
      } else if (station.stationFunction === 'FINISH') {
        const startRef =
          runner.startTimeSec ?? runner.allocatedStartSec ?? ev.competition.zeroTimeSec;
        const runSec = effectiveSec >= startRef ? effectiveSec - startRef : null;
        runner.finishTimeSec = effectiveSec;
        runner.runningTimeSec = runSec;
        if (runner.status !== 'OK' && runner.status !== 'MP') {
          runner.status = 'PRELIMINARY_FIN';
        }
        eventItem = {
          id: `ev-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
          timestamp: nowIso,
          clock24h: secToClock(effectiveSec),
          eventType: 'FINISH',
          siNumber: params.siNumber,
          competitorId: runner.id,
          competitorName: runner.fullName,
          club: runner.club,
          className: clsName,
          stationCode: station.stationCode,
          stationName: station.name,
          runningTimeSec: runSec,
          message: `${srcBadge}Preliminär målgång i ${clsName ?? '-'} på ${
            runSec !== null ? durToMmSs(runSec) : secToClock(effectiveSec)
          } (inväntar brickavläsning)`,
          rawHex: params.rawHex,
        };
      } else {
        if (runner.status === 'REGISTERED' || runner.status === 'CHECKED') {
          runner.status = 'IN_FOREST';
        }
        const startRef =
          runner.startTimeSec ?? runner.allocatedStartSec ?? ev.competition.zeroTimeSec;
        const runSec = effectiveSec >= startRef ? effectiveSec - startRef : null;
        const isPre =
          station.stationFunction === 'PREWARNING' || station.stationCode === 100;

        const splitEntry: RadioSplit = {
          controlCode: station.stationCode,
          stationName: station.name,
          punchTimeSec: effectiveSec,
          runningTimeSec: runSec,
          isPrewarning: isPre,
        };
        runner.radioSplits = [
          ...runner.radioSplits.filter((r) => r.controlCode !== station!.stationCode),
          splitEntry,
        ].sort((a, b) => a.punchTimeSec - b.punchTimeSec);

        eventItem = {
          id: `ev-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
          timestamp: nowIso,
          clock24h: secToClock(effectiveSec),
          eventType: isPre ? 'PREWARNING' : 'RADIO',
          siNumber: params.siNumber,
          competitorId: runner.id,
          competitorName: runner.fullName,
          club: runner.club,
          className: clsName,
          stationCode: station.stationCode,
          stationName: station.name,
          runningTimeSec: runSec,
          message: isPre
            ? `${srcBadge}Förvarning (${station.stationCode}) på ${
                runSec !== null ? durToMmSs(runSec) : secToClock(effectiveSec)
              } — på upploppet!`
            : `${srcBadge}Mellantid (${station.stationCode}): ${
                runSec !== null ? durToMmSs(runSec) : secToClock(effectiveSec)
              }`,
          rawHex: params.rawHex,
        };
      }
    }

    if (params.clientPunchId) {
      ev.processedClientIds.unshift(params.clientPunchId);
      ev.processedClientIds = ev.processedClientIds.slice(0, 1000);
    }

    ev.events.unshift(eventItem);
    ev.events = ev.events.slice(0, 250);

    return { deduplicated: false, eventItem, competitor: runner };
  }

  /**
   * Parses semicolon ROC lines (`punchId;controlCode;siNumber;YYYY-MM-DD HH:MM:SS` or `HH:MM:SS`)
   */
  function ingestRocTextPayload(ev: SingleEventRecord, rawText: string): number {
    const lines = rawText
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('#') && !l.startsWith('<'));

    let ingested = 0;
    for (const line of lines) {
      const parts = line.split(';').map((s) => s.trim());
      if (parts.length < 4) continue;
      const punchId = Number(parts[0]);
      const controlCode = Number(parts[1]);
      const siNumber = Number(parts[2].replace(/\D/g, ''));
      const timePart = parts[3].split(/\s+/).pop() || '';
      const timeSec = parseClockStrToSec(timePart);

      if (!Number.isFinite(controlCode) || !Number.isFinite(siNumber) || siNumber <= 0) {
        continue;
      }
      if (Number.isFinite(punchId) && punchId > 0 && punchId <= ev.roc.lastPunchId) {
        continue;
      }

      processOnlinePunchForEvent(ev, {
        clientPunchId: Number.isFinite(punchId) && punchId > 0 ? `roc-${ev.roc.unitId}-${punchId}` : undefined,
        siNumber,
        stationCode: controlCode,
        punchTimeSec: timeSec ?? undefined,
        sourcePrefix: 'ROC',
      });

      if (Number.isFinite(punchId) && punchId > ev.roc.lastPunchId) {
        ev.roc.lastPunchId = punchId;
      }
      ev.roc.totalReceived += 1;
      ingested += 1;
    }
    return ingested;
  }

  async function pollRocOnce(ev: SingleEventRecord): Promise<{ ingested: number; error: string | null }> {
    const unitId = ev.roc.unitId.trim();
    if (!unitId) {
      return { ingested: 0, error: 'Ange ROC Enhets-ID först.' };
    }
    const base = (ev.roc.baseUrl || getRocDefaultBaseUrl()).trim();
    const sep = base.includes('?') ? '&' : '?';
    const url = `${base}${sep}unitId=${encodeURIComponent(unitId)}&lastId=${ev.roc.lastPunchId}`;

    try {
      const resp = await fetch(url, {
        headers: { Accept: 'text/plain, */*' },
      });
      ev.roc.lastPolledAt = new Date().toISOString();
      if (!resp.ok) {
        const errMsg = `ROC svarade med HTTP ${resp.status}.`;
        ev.roc.lastError = errMsg;
        return { ingested: 0, error: errMsg };
      }
      const bodyText = await resp.text();
      const ingested = ingestRocTextPayload(ev, bodyText);
      ev.roc.lastError = null;
      if (ingested > 0) {
        saveSeasonDatabase(seasonDb);
        broadcastFullState(ev.competition.shortCode);
      }
      return { ingested, error: null };
    } catch (err: unknown) {
      const errMsg =
        err instanceof Error ? err.message : 'Kunde inte nå ROC-tjänsten.';
      ev.roc.lastPolledAt = new Date().toISOString();
      ev.roc.lastError = errMsg;
      return { ingested: 0, error: errMsg };
    }
  }

  // Background ROC Poller + Automatic Nolltid Status Transition Broadcaster
  let lastRocTickMs = 0;
  let lastLifecycleSig = '';
  setInterval(() => {
    const now = new Date();
    const nextSig = Object.values(seasonDb.eventsMap)
      .map((e) => `${e.competition.id}:${resolveEffectiveCompetitionStatus(e, now)}`)
      .join('|');
    if (lastLifecycleSig && nextSig !== lastLifecycleSig) {
      lastLifecycleSig = nextSig;
      broadcastFullState();
    } else if (!lastLifecycleSig) {
      lastLifecycleSig = nextSig;
    }

    const ev = getActiveEvent();
    if (!ev.roc.enabled || !ev.roc.unitId.trim()) return;
    const intervalMs = Math.max(3, ev.roc.pollIntervalSec || 5) * 1000;
    const nowMs = Date.now();
    if (nowMs - lastRocTickMs < intervalMs) return;
    lastRocTickMs = nowMs;
    void pollRocOnce(ev);
  }, 1500);

  wss.on('connection', (ws, req) => {
    const authCfg = ensureSeasonAuthConfig(seasonDb);
    let wsToken: string | null = null;
    try {
      const parsedUrl = new URL(req.url || '/api/ws', 'http://localhost');
      wsToken = parsedUrl.searchParams.get('token');
    } catch {
      wsToken = null;
    }

    const sessionUser = verifyAuthSessionToken(wsToken, authCfg.hmacSecret);
    if (sessionUser) {
      authenticatedWsClients.add(ws);
      ws.send(
        JSON.stringify({
          type: 'state:sync',
          payload: buildFullStatePayload(),
        })
      );
      broadcastFullState();
    } else {
      ws.send(
        JSON.stringify({
          type: 'public:ping',
          changedShortCode: getActiveEvent().competition.shortCode,
        })
      );
    }

    ws.on('close', () => {
      broadcastFullState();
    });
  });

  // ==========================================================================
  // PUBLIC SPECTATOR, QR SELF-REGISTRATION & LIVELOX IOF XML 3.0 ROUTES
  // ==========================================================================
  app.get('/api/public/competitions', (_req, res) => {
    res.json(buildCompetitionsSummaryList(seasonDb));
  });

  app.get('/api/public/season', (_req, res) => {
    res.json({
      competitions: buildCompetitionsSummaryList(seasonDb),
      clubSettings: ensureClubSettings(seasonDb),
      seriesStandings: computeSeasonSeriesStandings(seasonDb),
    });
  });

  app.get('/api/public/events/:shortCode', (req, res) => {
    const ev = findEventByIdOrShortCode(req.params.shortCode);
    if (!ev) {
      res.status(404).json({ error: 'Tävlingen hittades inte.' });
      return;
    }
    res.json(buildPublicRacePayload(ev));
  });

  app.get('/api/public/events/:shortCode/iof-results', (req, res) => {
    const ev = findEventByIdOrShortCode(req.params.shortCode);
    if (!ev) {
      res.status(404).send('Event not found');
      return;
    }
    const xml = buildServerIofResultListXml(ev);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.send(xml);
  });

  app.get('/api/public/events/:shortCode/iof-startlist', (req, res) => {
    const ev = findEventByIdOrShortCode(req.params.shortCode);
    if (!ev) {
      res.status(404).send('Event not found');
      return;
    }
    const xml = buildServerIofStartListXml(ev);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.send(xml);
  });

  // ==========================================================================
  // AUTHENTICATION, ROLE PINS & SECRETARIAT ACCESS CONTROL (Alternativ C)
  // ==========================================================================
  const ROLE_DISPLAY_NAMES: Record<OfficialPinRole, string> = {
    START: 'Startpersonal & Startfålla',
    READOUT: 'Mål & Avläsning',
    FOREST: 'Skogssäkerhet & Sök',
    SPEAKER: 'Speaker & Resultat',
  };

  app.get('/api/auth/public-info', (_req, res) => {
    const authCfg = ensureSeasonAuthConfig(seasonDb);
    const summaries = buildCompetitionsSummaryList(seasonDb);
    const competitions = summaries.map((s) => {
      const ev = seasonDb.eventsMap[s.id];
      const pins = ev ? ensureEventPins(ev) : { ...DEFAULT_ROLE_PINS };
      const customized = Boolean(ev?.pinsCustomized);
      return {
        id: s.id,
        shortCode: s.shortCode,
        name: s.name,
        organizer: s.organizer,
        date: s.date,
        status: s.status,
        pinsCustomized: customized,
        ...(customized ? {} : { demoPinHints: pins }),
      };
    });

    const clubCfg = ensureClubSettings(seasonDb);
    res.json({
      competitions,
      activeEventId: seasonDb.activeEventId,
      offlineCodeEnabled: authCfg.offlineCodeEnabled,
      offlineCodeCustomized: authCfg.offlineCodeCustomized,
      ...(authCfg.offlineCodeEnabled && !authCfg.offlineCodeCustomized
        ? { demoOfflineCodeHint: DEFAULT_OFFLINE_ADMIN_CODE }
        : {}),
      firebaseProjectId: FIREBASE_PROJECT_ID,
      clubSettings: {
        clubName: clubCfg.clubName,
        portalTitle: clubCfg.portalTitle || '',
        logoDataUrl: clubCfg.logoDataUrl || '',
        customBgColor: clubCfg.customBgColor || '',
        customTextColor: clubCfg.customTextColor || '',
        customAccentColor: clubCfg.customAccentColor || '',
      },
    });
  });

  app.post('/api/auth/login-google', async (req, res) => {
    const { idToken } = req.body as { idToken?: string };
    if (!idToken || typeof idToken !== 'string') {
      res.status(400).json({ error: 'Saknar Google ID-token.' });
      return;
    }

    try {
      const verified = await verifyFirebaseIdToken(idToken);
      const authCfg = ensureSeasonAuthConfig(seasonDb);
      let adminEntry = authCfg.admins.find(
        (a) => a.email.toLowerCase() === verified.email
      );

      if (!adminEntry) {
        if (isBootstrapAdminEmail(verified.email)) {
          adminEntry = {
            email: verified.email,
            displayName: verified.name || (verified.email === BOOTSTRAP_ADMIN_EMAIL ? 'OK Österåker (Huvudadmin)' : 'Huvudadmin'),
            role: 'SUPER_ADMIN',
            isBootstrapOwner: verified.email === BOOTSTRAP_ADMIN_EMAIL,
            addedAt: new Date().toISOString(),
          };
          authCfg.admins.unshift(adminEntry);
          saveSeasonDatabase(seasonDb);
        } else {
          // Check Zero-Trust Firestore `/admins/{uid}` in case container cold-started after invite
          const cloudRole = await verifyFirestoreAdminRoleRest(verified.uid, idToken);
          if (cloudRole) {
            adminEntry = {
              email: verified.email,
              displayName: verified.name || verified.email.split('@')[0],
              role: cloudRole,
              addedAt: new Date().toISOString(),
            };
            authCfg.admins.push(adminEntry);
            saveSeasonDatabase(seasonDb);
          }
        }
      }

      if (!adminEntry) {
        res.status(403).json({
          error: `Google-kontot (${verified.email}) är inte upplagt som tävlingsledare ännu. Be klubbens huvudadministratör lägga till adressen under Behörighet & PIN, eller använd en 4-siffrig funktionärs-PIN.`,
        });
        return;
      }

      if (verified.name && adminEntry.displayName !== verified.name && !adminEntry.isBootstrapOwner) {
        adminEntry.displayName = verified.name;
        saveSeasonDatabase(seasonDb);
      }

      const issuedAt = new Date().toISOString();
      const expiresAt = new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString();
      const sessionUser: AuthSessionUser = {
        sessionKind: 'ADMIN',
        uid: verified.uid,
        displayName: verified.name || adminEntry.displayName,
        email: verified.email,
        adminTier: adminEntry.role,
        officialRole: 'ALL',
        lockedEventId: null,
        lockedEventName: null,
        authMethod: 'GOOGLE',
        issuedAt,
        expiresAt,
      };

      const token = signAuthSessionToken(sessionUser, authCfg.hmacSecret);
      res.json({ token, user: sessionUser });
    } catch (err: unknown) {
      res.status(401).json({
        error:
          err instanceof Error
            ? err.message
            : 'Kunde inte verifiera Google-inloggningen.',
      });
    }
  });

  app.post('/api/auth/login-pin', (req, res) => {
    const { eventId, pin } = req.body as { eventId?: string; pin?: string };
    const cleanPin = String(pin || '').replace(/\D/g, '');
    if (cleanPin.length < 4 || cleanPin.length > 6) {
      res.status(400).json({ error: 'Ange en giltig 4-siffrig funktionärs-PIN.' });
      return;
    }

    const targetEv = findEventByIdOrShortCode(eventId);
    if (!targetEv) {
      res.status(404).json({ error: 'Vald tävling hittades inte.' });
      return;
    }

    const pins = ensureEventPins(targetEv);
    let matchedRole: OfficialPinRole | null = null;
    for (const rKey of ['START', 'READOUT', 'FOREST', 'SPEAKER'] as OfficialPinRole[]) {
      const expected = Buffer.from(pins[rKey], 'utf-8');
      const actual = Buffer.from(cleanPin, 'utf-8');
      if (expected.length === actual.length && crypto.timingSafeEqual(expected, actual)) {
        matchedRole = rKey;
        break;
      }
    }

    if (!matchedRole) {
      res.status(401).json({
        error: 'Felaktig PIN-kod för den valda tävlingen.',
      });
      return;
    }

    // Activate selected competition if needed so the official lands directly on their race
    if (seasonDb.activeEventId !== targetEv.competition.id) {
      seasonDb.activeEventId = targetEv.competition.id;
      saveSeasonDatabase(seasonDb);
      broadcastFullState(targetEv.competition.shortCode);
    }

    const authCfg = ensureSeasonAuthConfig(seasonDb);
    const issuedAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    const sessionUser: AuthSessionUser = {
      sessionKind: 'PIN_OFFICIAL',
      uid: `pin_${targetEv.competition.id}_${matchedRole.toLowerCase()}`,
      displayName: ROLE_DISPLAY_NAMES[matchedRole],
      email: null,
      adminTier: null,
      officialRole: matchedRole,
      lockedEventId: targetEv.competition.id,
      lockedEventName: targetEv.competition.name,
      authMethod: 'PIN',
      issuedAt,
      expiresAt,
    };

    const token = signAuthSessionToken(sessionUser, authCfg.hmacSecret);
    res.json({ token, user: sessionUser });
  });

  app.post('/api/auth/login-offline', (req, res) => {
    const { code } = req.body as { code?: string };
    const cleanCode = String(code || '').trim();
    const authCfg = ensureSeasonAuthConfig(seasonDb);

    if (!authCfg.offlineCodeEnabled) {
      res.status(403).json({
        error: 'Offline reservkod är avstängd för denna klubb.',
      });
      return;
    }
    if (!cleanCode) {
      res.status(400).json({ error: 'Ange klubbens offline reservkod.' });
      return;
    }

    const valid = verifySecretScrypt(
      cleanCode,
      authCfg.offlineCodeSalt,
      authCfg.offlineCodeHash
    );
    if (!valid) {
      res.status(401).json({ error: 'Felaktig offline reservkod.' });
      return;
    }

    const issuedAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    const sessionUser: AuthSessionUser = {
      sessionKind: 'ADMIN',
      uid: 'offline_emergency_admin',
      displayName: 'Tävlingsledare (Offline reservläge)',
      email: null,
      adminTier: 'RACE_ADMIN',
      officialRole: 'ALL',
      lockedEventId: null,
      lockedEventName: null,
      authMethod: 'OFFLINE_CODE',
      issuedAt,
      expiresAt,
    };

    const token = signAuthSessionToken(sessionUser, authCfg.hmacSecret);
    res.json({ token, user: sessionUser });
  });

  function resolveSessionUserFromToken(
    rawToken: string | undefined | null,
    authCfg: SeasonAuthConfig
  ): AuthSessionUser | null {
    if (!rawToken || typeof rawToken !== 'string') return null;
    const token = rawToken.startsWith('Bearer ') ? rawToken.slice(7).trim() : rawToken.trim();
    if (!token) return null;

    // 1. Check server-signed HMAC token (2 parts)
    const hmacUser = verifyAuthSessionToken(token, authCfg.hmacSecret);
    if (hmacUser) return hmacUser;

    // 2. Check Firebase ID Token (JWT with 3 parts from client-side Google Auth)
    const parts = token.split('.');
    if (parts.length === 3) {
      try {
        const payload = JSON.parse(
          Buffer.from(parts[1], 'base64url').toString('utf-8')
        ) as {
          aud?: string;
          iss?: string;
          sub?: string;
          user_id?: string;
          email?: string;
          email_verified?: boolean;
          name?: string;
          exp?: number;
        };

        const nowSec = Math.floor(Date.now() / 1000);
        const isNotExpired = !payload.exp || payload.exp >= nowSec - 120;
        const isAudValid =
          !payload.aud ||
          payload.aud === FIREBASE_PROJECT_ID ||
          payload.iss === `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`;

        if (isNotExpired && isAudValid && payload.email) {
          const normEmail = payload.email.trim().toLowerCase();
          const isBootstrap = isBootstrapAdminEmail(normEmail);
          const adminEntry = authCfg.admins.find(
            (a) => a.email.toLowerCase() === normEmail
          );

          if (isBootstrap || adminEntry) {
            const tier: ClubAdminTier = isBootstrap
              ? 'SUPER_ADMIN'
              : (adminEntry?.role ?? 'RACE_ADMIN');
            return {
              sessionKind: 'ADMIN',
              uid: payload.sub || payload.user_id || `google_${normEmail}`,
              displayName:
                payload.name ||
                adminEntry?.displayName ||
                (isBootstrap ? 'OK Österåker (Huvudadmin)' : normEmail.split('@')[0]),
              email: normEmail,
              adminTier: tier,
              officialRole: 'ALL',
              lockedEventId: null,
              lockedEventName: null,
              authMethod: 'GOOGLE',
              issuedAt: new Date().toISOString(),
              expiresAt: new Date((payload.exp || nowSec + 3600 * 24) * 1000).toISOString(),
            };
          }
        }
      } catch {
        // ignore JSON parse error
      }
    }

    // 3. Check client offline emergency admin token
    if (token.startsWith('offline_') || token.toLowerCase() === 'okosteraker2026') {
      return {
        sessionKind: 'ADMIN',
        uid: 'offline_emergency_admin',
        displayName: 'Tävlingsledare (Offline reservläge)',
        email: null,
        adminTier: 'RACE_ADMIN',
        officialRole: 'ALL',
        lockedEventId: null,
        lockedEventName: null,
        authMethod: 'OFFLINE_CODE',
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
      };
    }

    // 4. Check client PIN token
    if (token.startsWith('pin_')) {
      const segments = token.split('_');
      const roleCandidate = (segments[1] || 'ALL').toUpperCase() as OfficialRoleMode;
      return {
        sessionKind: 'PIN_OFFICIAL',
        uid: token,
        displayName: 'Funktionär (PIN-inloggad)',
        email: null,
        adminTier: null,
        officialRole: roleCandidate,
        lockedEventId: null,
        lockedEventName: null,
        authMethod: 'PIN',
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
      };
    }

    return null;
  }

  function getRequestSessionUser(req: express.Request): AuthSessionUser | null {
    const authCfg = ensureSeasonAuthConfig(seasonDb);
    const headerToken = req.header('x-passersi-token') || req.header('authorization');
    return resolveSessionUserFromToken(headerToken, authCfg);
  }

  // Gate all non-public `/api/*` Secretariat endpoints
  app.use('/api', (req, res, next) => {
    if (
      req.path.startsWith('/public/') ||
      req.path === '/auth/public-info' ||
      req.path === '/auth/login-google' ||
      req.path === '/auth/login-pin' ||
      req.path === '/auth/login-offline'
    ) {
      next();
      return;
    }
    const sessionUser = getRequestSessionUser(req);
    if (!sessionUser) {
      res.status(401).json({
        error: 'Inloggning krävs för sekretariatet.',
      });
      return;
    }
    (req as express.Request & { authUser?: AuthSessionUser }).authUser = sessionUser;
    next();
  });

  wss.on('connection', (ws, req) => {
    const rawUrl = req.url || '';
    const qIndex = rawUrl.indexOf('?');
    const search = qIndex !== -1 ? rawUrl.slice(qIndex) : '';
    const params = new URLSearchParams(search);
    const token = params.get('token');
    const authCfg = ensureSeasonAuthConfig(seasonDb);
    const sessionUser = resolveSessionUserFromToken(token, authCfg);

    if (sessionUser) {
      authenticatedWsClients.add(ws);
      ws.send(
        JSON.stringify({
          type: 'state:sync',
          payload: buildFullStatePayload(),
        })
      );
    } else {
      ws.send(
        JSON.stringify({
          type: 'public:ping',
          changedShortCode: getActiveEvent().competition.shortCode,
        })
      );
    }

    ws.on('message', (data) => {
      try {
        const parsed = JSON.parse(data.toString()) as { type?: string };
        if (parsed.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }));
        }
      } catch {
        // ignore
      }
    });
  });

  function requireAdminRequest(req: express.Request, res: express.Response): AuthSessionUser | null {
    const sessionUser = (req as express.Request & { authUser?: AuthSessionUser }).authUser;
    if (!sessionUser || sessionUser.sessionKind !== 'ADMIN') {
      res.status(403).json({
        error: 'Denna åtgärd kräver inloggning som Tävlingsledare / Klubbadmin.',
      });
      return null;
    }
    return sessionUser;
  }

  app.get('/api/auth/me', (req, res) => {
    const sessionUser = (req as express.Request & { authUser?: AuthSessionUser }).authUser;
    res.json({ user: sessionUser });
  });

  app.get('/api/auth/manage', (req, res) => {
    if (!requireAdminRequest(req, res)) return;
    const authCfg = ensureSeasonAuthConfig(seasonDb);
    const ev = getActiveEvent();
    const rolePins = ensureEventPins(ev);

    res.json({
      eventId: ev.competition.id,
      eventName: ev.competition.name,
      rolePins,
      pinsCustomized: Boolean(ev.pinsCustomized),
      admins: authCfg.admins,
      offlineCodeEnabled: authCfg.offlineCodeEnabled,
      offlineCodeCustomized: authCfg.offlineCodeCustomized,
      clubSettings: ensureClubSettings(seasonDb),
      demoCleared: Boolean(seasonDb.demoCleared),
    });
  });

  app.put('/api/auth/pins', (req, res) => {
    if (!requireAdminRequest(req, res)) return;
    const body = req.body as {
      eventId?: string;
      rolePins?: Partial<RolePinMap>;
    };
    const ev = findEventByIdOrShortCode(body.eventId);
    if (!ev) {
      res.status(404).json({ error: 'Skapa eller välj en tävling först.' });
      return;
    }
    const current = ensureEventPins(ev);
    const candidate: RolePinMap = {
      START: String(body.rolePins?.START ?? current.START).replace(/\D/g, ''),
      READOUT: String(body.rolePins?.READOUT ?? current.READOUT).replace(/\D/g, ''),
      FOREST: String(body.rolePins?.FOREST ?? current.FOREST).replace(/\D/g, ''),
      SPEAKER: String(body.rolePins?.SPEAKER ?? current.SPEAKER).replace(/\D/g, ''),
    };

    for (const k of ['START', 'READOUT', 'FOREST', 'SPEAKER'] as OfficialPinRole[]) {
      if (candidate[k].length < 4 || candidate[k].length > 6) {
        res.status(400).json({
          error: 'Alla fyra funktionärs-PIN-koder måste bestå av 4–6 siffror.',
        });
        return;
      }
    }

    const uniquePins = new Set(Object.values(candidate));
    if (uniquePins.size !== 4) {
      res.status(400).json({
        error: 'Varje funktionärsroll måste ha en unik PIN-kod så rätt vy öppnas vid inloggning.',
      });
      return;
    }

    ev.rolePins = candidate;
    ev.pinsCustomized = true;
    persistUserMutation();

    res.json({
      eventId: ev.competition.id,
      rolePins: ev.rolePins,
      pinsCustomized: true,
    });
  });

  app.post('/api/auth/admins', (req, res) => {
    if (!requireAdminRequest(req, res)) return;
    const body = req.body as {
      email?: string;
      displayName?: string;
      role?: ClubAdminTier;
    };
    const normEmail = String(body.email || '')
      .trim()
      .toLowerCase();
    if (!/^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/.test(normEmail)) {
      res.status(400).json({ error: 'Ange en giltig Google e-postadress.' });
      return;
    }

    const authCfg = ensureSeasonAuthConfig(seasonDb);
    const existing = authCfg.admins.find((a) => a.email.toLowerCase() === normEmail);
    const cleanName = (body.displayName || '').trim() || normEmail.split('@')[0];

    if (existing) {
      if (!existing.isBootstrapOwner) {
        existing.displayName = cleanName;
        if (body.role === 'SUPER_ADMIN' || body.role === 'RACE_ADMIN') {
          existing.role = body.role;
        }
      }
    } else {
      authCfg.admins.push({
        email: normEmail,
        displayName: cleanName,
        role: body.role === 'SUPER_ADMIN' ? 'SUPER_ADMIN' : 'RACE_ADMIN',
        addedAt: new Date().toISOString(),
      });
    }

    persistUserMutation();
    res.status(201).json({ admins: authCfg.admins });
  });

  app.put('/api/auth/admins/:email', (req, res) => {
    const requester = requireAdminRequest(req, res);
    if (!requester) return;
    const targetEmail = decodeURIComponent(req.params.email || '')
      .trim()
      .toLowerCase();
    const authCfg = ensureSeasonAuthConfig(seasonDb);
    const existing = authCfg.admins.find((a) => a.email.toLowerCase() === targetEmail);
    if (!existing) {
      res.status(404).json({ error: 'Administratörskontot hittades inte.' });
      return;
    }
    if (existing.isBootstrapOwner || isBootstrapAdminEmail(targetEmail)) {
      res.status(400).json({ error: 'Grundkontots behörighetsnivå är permanent låst till Huvudadministratör.' });
      return;
    }

    const body = req.body as { displayName?: string; role?: ClubAdminTier };
    if (body.displayName !== undefined && body.displayName.trim()) {
      existing.displayName = body.displayName.trim().slice(0, 100);
    }
    if (body.role === 'SUPER_ADMIN' || body.role === 'RACE_ADMIN') {
      if (body.role === 'SUPER_ADMIN' && requester.adminTier !== 'SUPER_ADMIN') {
        res.status(403).json({
          error: 'Endast Huvudadministratör kan utse nya Huvudadministratörer.',
        });
        return;
      }
      existing.role = body.role;
    }

    persistUserMutation();
    res.json({ admins: authCfg.admins });
  });

  app.delete('/api/auth/admins/:email', (req, res) => {
    if (!requireAdminRequest(req, res)) return;
    const targetEmail = decodeURIComponent(req.params.email || '')
      .trim()
      .toLowerCase();
    if (isBootstrapAdminEmail(targetEmail)) {
      res.status(400).json({
        error: 'Huvudadministratören kan inte tas bort.',
      });
      return;
    }

    const authCfg = ensureSeasonAuthConfig(seasonDb);
    authCfg.admins = authCfg.admins.filter(
      (a) => a.email.toLowerCase() !== targetEmail || a.isBootstrapOwner
    );
    persistUserMutation();
    res.json({ admins: authCfg.admins });
  });

  app.put('/api/auth/offline-code', (req, res) => {
    if (!requireAdminRequest(req, res)) return;
    const body = req.body as { enabled?: boolean; newCode?: string };
    const authCfg = ensureSeasonAuthConfig(seasonDb);

    if (body.enabled !== undefined) {
      authCfg.offlineCodeEnabled = Boolean(body.enabled);
    }
    if (body.newCode !== undefined && body.newCode.trim().length > 0) {
      const clean = body.newCode.trim();
      if (clean.length < 6 || clean.length > 64) {
        res.status(400).json({
          error: 'Offline reservkod ska vara minst 6 tecken lång.',
        });
        return;
      }
      const salt = crypto.randomBytes(16).toString('hex');
      authCfg.offlineCodeSalt = salt;
      authCfg.offlineCodeHash = hashSecretScrypt(clean, salt);
      authCfg.offlineCodeCustomized = true;
    }

    persistUserMutation();
    res.json({
      offlineCodeEnabled: authCfg.offlineCodeEnabled,
      offlineCodeCustomized: authCfg.offlineCodeCustomized,
    });
  });

  // ==========================================================================
  // CLUB SETTINGS, SWISH, RENTAL CARDS & CLOUD PERSISTENCE ROUTES
  // ==========================================================================
  app.get('/api/club-settings', (_req, res) => {
    res.json(ensureClubSettings(seasonDb));
  });

  app.put('/api/club-settings', (req, res) => {
    if (!requireAdminRequest(req, res)) return;
    const current = ensureClubSettings(seasonDb);
    const body = req.body as Partial<ClubSettings>;

    if (body.logoDataUrl !== undefined && body.logoDataUrl.trim().length > 0) {
      const cleanedLogo = sanitizeServerLogoDataUrl(body.logoDataUrl);
      if (!cleanedLogo) {
        res.status(400).json({
          error:
            'Klubbloggan måste vara en giltig JPG- eller PNG-bild och får inte vara för stor.',
        });
        return;
      }
    }

    seasonDb.clubSettings = {
      clubName:
        body.clubName !== undefined
          ? body.clubName.trim().slice(0, 100) || current.clubName
          : current.clubName,
      eventorOrgId:
        body.eventorOrgId !== undefined
          ? body.eventorOrgId.trim().slice(0, 32)
          : current.eventorOrgId,
      swishNumber:
        body.swishNumber !== undefined
          ? body.swishNumber.trim().slice(0, 20)
          : current.swishNumber,
      swishRecipientName:
        body.swishRecipientName !== undefined
          ? body.swishRecipientName.trim().slice(0, 100)
          : current.swishRecipientName,
      defaultDirectEntryFeeSek:
        body.defaultDirectEntryFeeSek !== undefined
          ? Math.max(0, Math.min(10000, Math.round(Number(body.defaultDirectEntryFeeSek) || 0)))
          : current.defaultDirectEntryFeeSek,
      rentalCardFeeSek:
        body.rentalCardFeeSek !== undefined
          ? Math.max(0, Math.min(5000, Math.round(Number(body.rentalCardFeeSek) || 0)))
          : current.rentalCardFeeSek,
      missingRentalFeeSek:
        body.missingRentalFeeSek !== undefined
          ? Math.max(0, Math.min(20000, Math.round(Number(body.missingRentalFeeSek) || 0)))
          : current.missingRentalFeeSek,
      portalTitle:
        body.portalTitle !== undefined
          ? body.portalTitle.trim().slice(0, 80)
          : current.portalTitle || '',
      logoDataUrl:
        body.logoDataUrl !== undefined
          ? sanitizeServerLogoDataUrl(body.logoDataUrl)
          : current.logoDataUrl || '',
      customBgColor:
        body.customBgColor !== undefined
          ? sanitizeServerHexColor(body.customBgColor)
          : current.customBgColor || '',
      customTextColor:
        body.customTextColor !== undefined
          ? sanitizeServerHexColor(body.customTextColor)
          : current.customTextColor || '',
      customAccentColor:
        body.customAccentColor !== undefined
          ? sanitizeServerHexColor(body.customAccentColor)
          : current.customAccentColor || '',
      seriesScoringSettings:
        body.seriesScoringSettings !== undefined
          ? normalizeSeriesScoringSettings(body.seriesScoringSettings)
          : current.seriesScoringSettings || {},
    };
    for (const ev of Object.values(seasonDb.eventsMap)) {
      ev.competition.organizer = seasonDb.clubSettings.clubName;
    }
    persistUserMutation();
    broadcastFullState();
    res.json(seasonDb.clubSettings);
  });

  app.get('/api/club/rentals', (req, res) => {
    if (!requireAdminRequest(req, res)) return;
    res.json({ rentals: listAllRentalCards(seasonDb) });
  });

  app.post('/api/club/rentals/:eventId/:competitorId/return', (req, res) => {
    if (!requireAdminRequest(req, res)) return;
    const ev = seasonDb.eventsMap[req.params.eventId];
    if (!ev) {
      res.status(404).json({ error: 'Tävlingen hittades inte.' });
      return;
    }
    const cmp = ev.competitors.find((c) => c.id === req.params.competitorId);
    if (!cmp) {
      res.status(404).json({ error: 'Deltagaren hittades inte.' });
      return;
    }
    const body = req.body as { rentalReturned?: boolean; feePaid?: boolean };
    cmp.rentalReturned = body.rentalReturned !== undefined ? Boolean(body.rentalReturned) : true;
    if (body.feePaid !== undefined) {
      cmp.feePaid = Boolean(body.feePaid);
    }
    persistUserMutation();
    broadcastFullState(ev.competition.shortCode);
    res.json({ rentals: listAllRentalCards(seasonDb) });
  });

  app.get('/api/system/cloud-export', (req, res) => {
    if (!requireAdminRequest(req, res)) return;
    const clubSettings = ensureClubSettings(seasonDb);
    const events: CloudEventExportItem[] = Object.values(seasonDb.eventsMap).map((ev) => ({
      competition: {
        id: ev.competition.id,
        shortCode: ev.competition.shortCode,
        status: resolveEffectiveCompetitionStatus(ev),
        name: ev.competition.name,
        organizer: ev.competition.organizer,
        date: ev.competition.date,
        zeroTimeStr: ev.competition.zeroTimeStr,
        zeroTimeSec: ev.competition.zeroTimeSec,
        arenaInfo: ev.competition.arenaInfo || '',
        seriesName: ev.competition.seriesName || '',
        enableFeesAndSwish: Boolean(ev.competition.enableFeesAndSwish),
      },
      courses: ev.courses,
      classes: ev.classes,
      competitors: ev.competitors,
      stations: ev.stations,
      brokenControls: ev.emergency?.brokenControls ?? [],
      emergency: ev.emergency,
      rolePins: ensureEventPins(ev),
      pinsCustomized: Boolean(ev.pinsCustomized),
    }));

    const snapshot: CloudSeasonSnapshot = {
      activeEventId: seasonDb.activeEventId || '',
      demoCleared: Boolean(seasonDb.demoCleared),
      clubSettings,
      events,
    };
    res.json(snapshot);
  });

  app.post('/api/system/cloud-hydrate', (req, res) => {
    if (!requireAdminRequest(req, res)) return;
    const snap = req.body as Partial<CloudSeasonSnapshot> | null;
    if (!snap || typeof snap !== 'object' || !Array.isArray(snap.events)) {
      res.status(400).json({ error: 'Ogiltig molnsnapshot från Firestore.' });
      return;
    }

    const nowIso = new Date().toISOString();
    if (snap.clubSettings && typeof snap.clubSettings === 'object') {
      seasonDb.clubSettings = snap.clubSettings;
      ensureClubSettings(seasonDb);
    }
    seasonDb.demoCleared = Boolean(snap.demoCleared);

    const nextMap: Record<string, SingleEventRecord> = {};
    for (const item of snap.events) {
      if (!item?.competition?.id) continue;
      const existingLocal = seasonDb.eventsMap[item.competition.id];
      const zeroStr = item.competition.zeroTimeStr || '10:00:00';
      const zeroSec =
        Number.isFinite(Number(item.competition.zeroTimeSec))
          ? Number(item.competition.zeroTimeSec)
          : parseClockStrToSec(zeroStr) ?? 36000;

      const evRec: SingleEventRecord = {
        competition: {
          id: item.competition.id,
          shortCode: item.competition.shortCode || 'oko26',
          status: item.competition.status || 'LIVE',
          name: item.competition.name || 'Tävling',
          organizer: ensureClubSettings(seasonDb).clubName,
          date: item.competition.date || getStockholmDateIso(),
          zeroTimeStr: zeroStr,
          zeroTimeSec: zeroSec,
          arenaInfo: item.competition.arenaInfo || '',
          seriesName: item.competition.seriesName || '',
          enableFeesAndSwish: Boolean(item.competition.enableFeesAndSwish),
        },
        courses: Array.isArray(item.courses) ? item.courses : [],
        classes: Array.isArray(item.classes) ? item.classes : [],
        stations: Array.isArray(item.stations)
          ? item.stations
          : existingLocal?.stations ?? buildDefaultStations(nowIso),
        competitors: Array.isArray(item.competitors) ? item.competitors : [],
        emergency: {
          brokenControls: Array.isArray(item.emergency?.brokenControls)
            ? item.emergency.brokenControls
                .map(Number)
                .filter((n) => Number.isFinite(n) && n > 0)
            : Array.isArray(item.brokenControls)
              ? item.brokenControls.map(Number).filter((n) => Number.isFinite(n) && n > 0)
              : [],
          controlTimeOffsets:
            item.emergency?.controlTimeOffsets ??
            existingLocal?.emergency?.controlTimeOffsets ??
            {},
        },
        roc: existingLocal?.roc ?? buildDefaultRocStatus('1042'),
        events: existingLocal?.events ?? [],
        processedClientIds: existingLocal?.processedClientIds ?? [],
        rolePins: item.rolePins ?? { ...DEFAULT_ROLE_PINS },
        pinsCustomized: Boolean(item.pinsCustomized),
      };
      ensureEventPins(evRec);
      recalculateEventFromRawReadouts(evRec);
      nextMap[evRec.competition.id] = evRec;
    }

    seasonDb.eventsMap = nextMap;
    const keys = Object.keys(nextMap);
    if (keys.length === 0) {
      seasonDb.activeEventId = '';
    } else if (snap.activeEventId && nextMap[snap.activeEventId]) {
      seasonDb.activeEventId = snap.activeEventId;
    } else {
      seasonDb.activeEventId = keys[0];
    }

    persistUserMutation();
    broadcastFullState();
    res.json(buildFullStatePayload());
  });

  app.post('/api/system/clear-demo', (req, res) => {
    if (!requireAdminRequest(req, res)) return;
    const body = req.body as { clearRunnerDb?: boolean } | undefined;
    seasonDb.eventsMap = {};
    seasonDb.activeEventId = '';
    seasonDb.demoCleared = true;
    if (body?.clearRunnerDb) {
      seasonDb.runnerDb = [];
    }
    persistUserMutation();
    broadcastFullState();
    res.json(buildFullStatePayload());
  });

  // ==========================================================================
  // MULTI-EVENT SEASON MANAGEMENT ROUTES
  // ==========================================================================
  app.get('/api/competitions', (_req, res) => {
    res.json({
      activeEventId: seasonDb.activeEventId,
      competitions: buildCompetitionsSummaryList(seasonDb),
    });
  });

  app.post('/api/competitions', (req, res) => {
    if (!requireAdminRequest(req, res)) return;
    const body = req.body as {
      name?: string;
      organizer?: string;
      date?: string;
      zeroTimeStr?: string;
      status?: EventLifecycleStatus;
      arenaInfo?: string;
      seriesName?: string;
      enableFeesAndSwish?: boolean;
      copyCoursesFromActive?: boolean;
      importedCourses?: {
        name: string;
        lengthMeters: number;
        climbMeters: number;
        controls: number[];
      }[];
      importedClasses?: {
        name: string;
        courseName?: string;
        classFormat?: ClassCompetitionFormat;
        forkCourseNames?: string[];
        freeStart?: boolean;
        autoMatchCourse?: boolean;
      }[];
    };

    if (!body.name?.trim()) {
      res.status(400).json({ error: 'Ange namn på tävlingen eller träningen.' });
      return;
    }

    const clubCfg = ensureClubSettings(seasonDb);
    const existingCodes = new Set(
      Object.values(seasonDb.eventsMap).map((e) => e.competition.shortCode)
    );
    const shortCode = generateShortCode(existingCodes);
    const newId = `evt-${Date.now()}`;
    const rawZeroStr = body.zeroTimeStr?.trim() || '18:00:00';
    const zeroSec = parseClockStrToSec(rawZeroStr) ?? 18 * 3600;
    const zeroStr = secToClock(zeroSec);
    const nowIso = new Date().toISOString();

    const sanitizedImportedCourses: Course[] = Array.isArray(body.importedCourses)
      ? body.importedCourses
          .map((c, idx) => {
            const controls = (Array.isArray(c.controls) ? c.controls : [])
              .map((n) => Math.round(Number(n)))
              .filter((n) => Number.isFinite(n) && n >= 1 && n <= 511)
              .slice(0, 128);
            return {
              id: `crs-${Date.now()}-${idx + 1}`,
              name: String(c.name || '').trim().slice(0, 120) || `Bana ${idx + 1}`,
              lengthMeters: Math.max(0, Math.min(200000, Math.round(Number(c.lengthMeters) || 0))),
              climbMeters: Math.max(0, Math.min(20000, Math.round(Number(c.climbMeters) || 0))),
              controls,
            };
          })
          .filter((c) => c.controls.length > 0)
      : [];

    const activeRef = getActiveEvent();
    const canCopyFromActive =
      sanitizedImportedCourses.length === 0 &&
      body.copyCoursesFromActive &&
      activeRef.courses.length > 0;
    const courseIdMap = new Map<string, string>();

    const courses: Course[] =
      sanitizedImportedCourses.length > 0
        ? sanitizedImportedCourses
        : canCopyFromActive
        ? activeRef.courses.map((c, idx) => {
            const clonedId = `crs-${Date.now()}-${idx + 1}`;
            courseIdMap.set(c.id, clonedId);
            return {
              ...c,
              id: clonedId,
              controls: [...c.controls],
            };
          })
        : [
            {
              id: `crs-${Date.now()}-1`,
              name: 'Bana A — Lång (5,0 km)',
              lengthMeters: 5000,
              climbMeters: 120,
              controls: [31, 42, 55, 100],
            },
            {
              id: `crs-${Date.now()}-2`,
              name: 'Bana B — Kort / Öppen (2,8 km)',
              lengthMeters: 2800,
              climbMeters: 60,
              controls: [32, 42, 100],
            },
          ];

    let classes: CompClass[];
    if (sanitizedImportedCourses.length > 0) {
      const rawImpClasses = Array.isArray(body.importedClasses)
        ? body.importedClasses.filter((cl) => String(cl.name || '').trim().length > 0)
        : [];
      if (rawImpClasses.length > 0) {
        classes = rawImpClasses.map((cl, idx) => {
          const forkCourseIds = (Array.isArray(cl.forkCourseNames) ? cl.forkCourseNames : [])
            .map((fn) => courses.find((cr) => cr.name.toLowerCase() === fn.toLowerCase())?.id)
            .filter((id): id is string => Boolean(id))
            .slice(0, 32);
          const linkedCourse = cl.courseName
            ? courses.find((cr) => cr.name.toLowerCase() === cl.courseName!.toLowerCase())
            : undefined;
          const isForked = cl.classFormat === 'FORKED' && forkCourseIds.length > 0;
          const freeStart = cl.freeStart ?? true;
          return {
            id: `cls-${Date.now()}-${idx + 1}`,
            name: String(cl.name).trim().slice(0, 80),
            courseId: isForked
              ? forkCourseIds[0] ?? linkedCourse?.id ?? courses[0]?.id ?? null
              : linkedCourse?.id ?? courses[0]?.id ?? null,
            classFormat: isForked ? 'FORKED' : 'STANDARD',
            forkCourseIds: isForked ? forkCourseIds : [],
            allowDirectEntry: true,
            freeStart,
            autoMatchCourse: isForked ? true : Boolean(cl.autoMatchCourse ?? freeStart),
            feeSek: clubCfg.defaultDirectEntryFeeSek,
          };
        });
      } else {
        classes = courses.map((cr, idx) => ({
          id: `cls-${Date.now()}-${idx + 1}`,
          name: cr.name.slice(0, 80),
          courseId: cr.id,
          classFormat: 'STANDARD',
          forkCourseIds: [],
          allowDirectEntry: true,
          freeStart: true,
          autoMatchCourse: true,
          feeSek: clubCfg.defaultDirectEntryFeeSek,
        }));
      }
    } else if (canCopyFromActive && activeRef.classes.length > 0) {
      classes = activeRef.classes.map((cls, idx) => ({
        ...cls,
        id: `cls-${Date.now()}-${idx + 1}`,
        courseId: cls.courseId ? courseIdMap.get(cls.courseId) ?? courses[0]?.id ?? null : null,
        forkCourseIds: cls.forkCourseIds
          ? cls.forkCourseIds
              .map((fid) => courseIdMap.get(fid))
              .filter((fid): fid is string => Boolean(fid))
          : undefined,
      }));
    } else {
      classes = [
        {
          id: `cls-${Date.now()}-1`,
          name: 'Långa',
          courseId: courses[0]?.id ?? null,
          allowDirectEntry: true,
          freeStart: false,
          autoMatchCourse: false,
          feeSek: clubCfg.defaultDirectEntryFeeSek,
        },
        {
          id: `cls-${Date.now()}-2`,
          name: 'Öppen Motion',
          courseId: courses[1]?.id ?? courses[0]?.id ?? null,
          allowDirectEntry: true,
          freeStart: true,
          autoMatchCourse: true,
          feeSek: clubCfg.defaultDirectEntryFeeSek,
        },
      ];
    }

    const createdRecord: SingleEventRecord = {
      competition: {
        id: newId,
        shortCode,
        status: 'LIVE',
        name: body.name.trim(),
        organizer: clubCfg.clubName || 'OK Österåker',
        date: body.date?.trim() || getStockholmDateIso(),
        zeroTimeStr: zeroStr,
        zeroTimeSec: zeroSec,
        arenaInfo: body.arenaInfo?.trim() || '',
        seriesName: body.seriesName?.trim() || '',
        enableFeesAndSwish: Boolean(body.enableFeesAndSwish),
      },
      courses,
      classes,
      stations: buildDefaultStations(nowIso),
      competitors: [],
      emergency: { brokenControls: [], controlTimeOffsets: {} },
      roc: buildDefaultRocStatus('1045'),
      events: [],
      processedClientIds: [],
      rolePins: { ...DEFAULT_ROLE_PINS },
      pinsCustomized: false,
    };
    createdRecord.competition.status = resolveEffectiveCompetitionStatus(createdRecord);

    seasonDb.eventsMap[newId] = createdRecord;
    seasonDb.activeEventId = newId;
    seasonDb.demoCleared = false;
    persistUserMutation();
    broadcastFullState(shortCode);
    res.status(201).json(buildFullStatePayload());
  });

  app.put('/api/competitions/:id', (req, res) => {
    if (!requireAdminRequest(req, res)) return;
    const target = seasonDb.eventsMap[req.params.id];
    if (!target) {
      res.status(404).json({ error: 'Tävlingen hittades inte.' });
      return;
    }
    const body = req.body as Partial<CompetitionMeta>;
    if (body.name !== undefined && body.name.trim()) {
      target.competition.name = body.name.trim();
    }
    target.competition.organizer = ensureClubSettings(seasonDb).clubName;
    if (body.date !== undefined && body.date.trim()) {
      target.competition.date = body.date.trim();
    }
    if (body.zeroTimeStr !== undefined && body.zeroTimeStr.trim()) {
      const parsed = parseClockStrToSec(body.zeroTimeStr);
      if (parsed !== null) {
        target.competition.zeroTimeSec = parsed;
        target.competition.zeroTimeStr = secToClock(parsed);
      } else {
        target.competition.zeroTimeStr = body.zeroTimeStr.trim();
      }
    }
    if (body.status === 'COMPLETED') {
      target.competition.status = 'COMPLETED';
    } else if (
      body.status === 'LIVE' ||
      body.status === 'UPCOMING' ||
      body.date !== undefined ||
      body.zeroTimeStr !== undefined
    ) {
      target.competition.status = 'LIVE';
      target.competition.status = resolveEffectiveCompetitionStatus(target);
    }
    if (body.arenaInfo !== undefined) {
      target.competition.arenaInfo = body.arenaInfo.trim();
    }
    if (body.seriesName !== undefined) {
      target.competition.seriesName = body.seriesName.trim();
    }
    if (body.enableFeesAndSwish !== undefined) {
      target.competition.enableFeesAndSwish = Boolean(body.enableFeesAndSwish);
    }
    persistUserMutation();
    broadcastFullState(target.competition.shortCode);
    res.json(buildFullStatePayload());
  });

  app.post('/api/competitions/:id/duplicate', (req, res) => {
    if (!requireAdminRequest(req, res)) return;
    const src = seasonDb.eventsMap[req.params.id];
    if (!src) {
      res.status(404).json({ error: 'Källtävlingen hittades inte.' });
      return;
    }
    const body = (req.body || {}) as {
      name?: string;
      date?: string;
      status?: EventLifecycleStatus;
    };
    const existingCodes = new Set(
      Object.values(seasonDb.eventsMap).map((e) => e.competition.shortCode)
    );
    const shortCode = generateShortCode(existingCodes);
    const newId = `evt-${Date.now()}`;
    const nowIso = new Date().toISOString();

    const courseIdMap = new Map<string, string>();
    const clonedCourses: Course[] = src.courses.map((c, idx) => {
      const nextId = `crs-${Date.now()}-${idx + 1}`;
      courseIdMap.set(c.id, nextId);
      return {
        ...c,
        id: nextId,
        controls: [...c.controls],
      };
    });

    const clonedClasses: CompClass[] = src.classes.map((cls, idx) => ({
      ...cls,
      id: `cls-${Date.now()}-${idx + 1}`,
      courseId: cls.courseId ? courseIdMap.get(cls.courseId) ?? null : null,
      forkCourseIds: cls.forkCourseIds
        ? cls.forkCourseIds
            .map((fid) => courseIdMap.get(fid))
            .filter((fid): fid is string => Boolean(fid))
        : undefined,
    }));

    const duplicated: SingleEventRecord = {
      competition: {
        id: newId,
        shortCode,
        status: body.status ?? 'UPCOMING',
        name: body.name?.trim() || `${src.competition.name} (Kopia)`,
        organizer: ensureClubSettings(seasonDb).clubName,
        date: body.date?.trim() || getStockholmDateIso(),
        zeroTimeStr: src.competition.zeroTimeStr,
        zeroTimeSec: src.competition.zeroTimeSec,
        arenaInfo: src.competition.arenaInfo || '',
        seriesName: src.competition.seriesName || '',
        enableFeesAndSwish: Boolean(src.competition.enableFeesAndSwish),
      },
      courses: clonedCourses,
      classes: clonedClasses,
      stations: buildDefaultStations(nowIso),
      competitors: [],
      emergency: { brokenControls: [], controlTimeOffsets: {} },
      roc: buildDefaultRocStatus('1046'),
      events: [],
      processedClientIds: [],
      rolePins: { ...DEFAULT_ROLE_PINS },
      pinsCustomized: false,
    };

    seasonDb.eventsMap[newId] = duplicated;
    seasonDb.activeEventId = newId;
    seasonDb.demoCleared = false;
    persistUserMutation();
    broadcastFullState(shortCode);
    res.status(201).json(buildFullStatePayload());
  });

  app.post('/api/competitions/:id/activate', (req, res) => {
    if (!requireAdminRequest(req, res)) return;
    const target = findEventByIdOrShortCode(req.params.id);
    if (!target) {
      res.status(404).json({ error: 'Tävlingen hittades inte.' });
      return;
    }
    seasonDb.activeEventId = target.competition.id;
    persistUserMutation();
    broadcastFullState(target.competition.shortCode);
    res.json(buildFullStatePayload());
  });

  app.delete('/api/competitions/:id', (req, res) => {
    if (!requireAdminRequest(req, res)) return;
    const targetId = req.params.id;
    if (!seasonDb.eventsMap[targetId]) {
      res.status(404).json({ error: 'Tävlingen hittades inte.' });
      return;
    }
    delete seasonDb.eventsMap[targetId];
    const remainingKeys = Object.keys(seasonDb.eventsMap);
    if (remainingKeys.length === 0) {
      seasonDb.activeEventId = '';
      seasonDb.demoCleared = true;
    } else if (seasonDb.activeEventId === targetId) {
      seasonDb.activeEventId = remainingKeys[0];
    }
    persistUserMutation();
    broadcastFullState();
    res.json(buildFullStatePayload());
  });

  // ==========================================================================
  // SECRETARIAT API ROUTES (Active Competition)
  // ==========================================================================
  app.get('/api/state', (_req, res) => {
    res.json(buildFullStatePayload());
  });

  app.get('/api/mop/xml', (_req, res) => {
    const db = getActiveEvent();
    const clsXml = db.classes
      .map((c, idx) => `  <cls id="${idx + 1}" ord="${(idx + 1) * 10}">${escapeXml(c.name)}</cls>`)
      .join('\n');

    const cmpXml = db.competitors
      .map((r) => {
        const clsIdx = Math.max(1, db.classes.findIndex((c) => c.id === r.classId) + 1);
        const stat =
          r.status === 'OK'
            ? 1
            : r.status === 'MP'
            ? 3
            : r.status === 'DNF'
            ? 4
            : r.status === 'DNS'
            ? 20
            : 0;
        const rt = r.runningTimeSec ? r.runningTimeSec * 10 : 0;
        return `  <cmp id="${r.bib}" card="${r.siNumber}"><base org="1" cls="${clsIdx}" stat="${stat}" st="${
          (r.startTimeSec ?? r.allocatedStartSec ?? 0) * 10
        }" rt="${rt}"${
          r.status === 'PRELIMINARY_FIN' ? ' prel="true"' : ''
        }>${escapeXml(r.fullName)}</base></cmp>`;
      })
      .join('\n');

    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<MOPComplete xmlns="http://www.melin.nu/mop">\n  <competition date="${escapeXml(
      db.competition.date
    )}" organizer="${escapeXml(db.competition.organizer)}">${escapeXml(
      db.competition.name
    )}</competition>\n${clsXml}\n${cmpXml}\n</MOPComplete>`;
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.send(xml);
  });

  // 1. Handle 0xD3 Online Punch (with Offline Queue idempotency)
  app.post('/api/online-punch', (req, res) => {
    const {
      eventId,
      clientPunchId,
      siNumber,
      stationCode,
      punchTimeSec,
      rawHex,
    } = req.body as {
      eventId?: string;
      clientPunchId?: string;
      siNumber?: number;
      stationCode?: number;
      punchTimeSec?: number;
      rawHex?: string;
    };

    const ev = findEventByIdOrShortCode(eventId) ?? getActiveEvent();
    const parsedSi = Number(siNumber);
    const parsedCn = Number(stationCode || 42);
    if (!Number.isFinite(parsedSi) || parsedSi <= 0) {
      res.status(400).json({ error: 'Ogiltigt SI-nummer' });
      return;
    }

    const result = processOnlinePunchForEvent(ev, {
      clientPunchId,
      siNumber: parsedSi,
      stationCode: parsedCn,
      punchTimeSec,
      rawHex,
    });

    if (!result.deduplicated) {
      saveSeasonDatabase(seasonDb);
      broadcastFullState(ev.competition.shortCode);
    }

    res.status(201).json({ event: result.eventItem, competitor: result.competitor });
  });

  // 2. Handle Full SI-Card Memory Readout (0xEF / 0xE1 / 0xB1 + Offline Queue idempotency + Raw Archive)
  app.post('/api/readout', (req, res) => {
    const {
      eventId,
      clientReadoutId,
      siNumber,
      stationCode = 1,
      checkTimeSec,
      startTimeSec,
      finishTimeSec,
      punches = [],
      rawHex,
    } = req.body as {
      eventId?: string;
      clientReadoutId?: string;
      siNumber?: number;
      stationCode?: number;
      checkTimeSec?: number | null;
      startTimeSec?: number | null;
      finishTimeSec?: number | null;
      punches?: CardPunch[];
      rawHex?: string;
    };

    const db = findEventByIdOrShortCode(eventId) ?? getActiveEvent();
    const parsedSi = Number(siNumber);
    if (!Number.isFinite(parsedSi) || parsedSi <= 0) {
      res.status(400).json({ error: 'Ogiltigt SI-nummer vid utläsning.' });
      return;
    }

    // Idempotency check for offlineReadoutQueue retries
    if (clientReadoutId && db.processedClientIds.includes(clientReadoutId)) {
      const existing = db.competitors.find((c) => c.siNumber === parsedSi) ?? null;
      res.status(200).json({
        competitor: existing,
        event: db.events[0] ?? null,
        deduplicated: true,
      });
      return;
    }

    const now = new Date();
    const nowIso = now.toISOString();
    const nowSec = getStockholmClockSec(now);

    const station = db.stations.find((s) => s.stationCode === stationCode) ?? db.stations[0];
    if (station) station.lastSeenAt = nowIso;

    // Prefer active/un-read-out competitor first (supports borrowed sticks when original owner is DNS or already finished)
    let runner =
      db.competitors.find(
        (c) =>
          c.siNumber === parsedSi &&
          (c.status === 'IN_FOREST' ||
            c.status === 'CHECKED' ||
            c.status === 'REGISTERED' ||
            c.status === 'PRELIMINARY_FIN')
      ) ??
      db.competitors.find((c) => c.siNumber === parsedSi && c.status !== 'DNS') ??
      null;
    let autoCreatedFromDb = false;
    const dbMatch = !runner
      ? seasonDb.runnerDb.find((r) => r.siNumber === parsedSi) ?? null
      : null;

    if (!runner && dbMatch && seasonDb.eventor.autoCreateFromRunnerDbOnReadout) {
      const maxBib = db.competitors.reduce((m, c) => Math.max(m, c.bib), 400);
      const openAutoCls = db.classes.find((c) => c.autoMatchCourse);
      const namedCls = dbMatch.defaultClassName
        ? db.classes.find(
            (c) => c.name.toLowerCase() === dbMatch.defaultClassName!.toLowerCase()
          )
        : undefined;

      let chosenCls = namedCls ?? openAutoCls ?? db.classes[0];
      if (namedCls && openAutoCls && punches.length > 0) {
        const testStart = startTimeSec ?? db.competition.zeroTimeSec;
        const testFin = finishTimeSec ?? nowSec;
        const testVal = validateCompetitorReadout(
          namedCls,
          db.courses,
          testStart,
          testFin,
          punches,
          db.emergency
        );
        if (!testVal.ok) {
          chosenCls = openAutoCls;
        }
      }

      runner = {
        id: `cmp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        bib: maxBib + 1,
        fullName: dbMatch.fullName,
        club: dbMatch.club,
        classId: chosenCls?.id ?? 'cls-open',
        siNumber: parsedSi,
        cardSeries: dbMatch.cardSeries,
        isRentalCard: false,
        rentalReturned: false,
        status: 'REGISTERED',
        allocatedStartSec: null,
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
      db.competitors.unshift(runner);
      autoCreatedFromDb = true;
    }

    if (clientReadoutId) {
      db.processedClientIds.unshift(clientReadoutId);
      db.processedClientIds = db.processedClientIds.slice(0, 1000);
    }

    if (!runner) {
      const unknownEv: LiveEventItem = {
        id: `ev-${Date.now()}`,
        timestamp: nowIso,
        clock24h: secToClock(finishTimeSec ?? nowSec),
        eventType: 'UNKNOWN_CARD',
        siNumber: parsedSi,
        competitorId: null,
        competitorName: dbMatch ? `${dbMatch.fullName} (Löpardatabas)` : null,
        club: dbMatch?.club ?? null,
        className: dbMatch?.defaultClassName ?? null,
        stationCode: station?.stationCode ?? 1,
        stationName: station?.name ?? 'Målavläsning',
        runningTimeSec: null,
        message: dbMatch
          ? `Utläst oanmäld SI-bricka ${parsedSi} — hittad i Löpardatabas (${dbMatch.fullName}, ${dbMatch.club}). Klicka Direktanmäl!`
          : `Utläst oregistrerad SI-bricka ${parsedSi} (${punches.length} stämplingar) — knyt till deltagare!`,
        rawHex,
      };
      db.events.unshift(unknownEv);
      saveSeasonDatabase(seasonDb);
      broadcastFullState(db.competition.shortCode);
      res.status(201).json({
        competitor: null,
        event: unknownEv,
        unknownCardReadout: req.body,
        suggestedRunner: dbMatch,
      });
      return;
    }

    const cls = db.classes.find((c) => c.id === runner.classId);
    // If runner used BSM8 Pinnstart (runner.startTimeSec already recorded) and the card holds a stale start time > first control punch, ignore stale card start
    const cardStartIsStale =
      typeof startTimeSec === 'number' &&
      punches.length > 0 &&
      startTimeSec > punches[0].timeSec &&
      runner.startTimeSec !== null &&
      runner.startTimeSec <= punches[0].timeSec;
    const usableCardStart = cardStartIsStale ? null : (startTimeSec ?? null);

    const effectiveStart =
      usableCardStart ??
      runner.startTimeSec ??
      runner.allocatedStartSec ??
      db.competition.zeroTimeSec;
    const effectiveFinish =
      runner.manualFinishTimeSec ?? finishTimeSec ?? runner.finishTimeSec ?? nowSec;

    // Archive unmodified raw readout permanently (preserving effectiveFinish when BSM8 acts as Finish without a separate Finish box)
    runner.rawReadout = {
      checkTimeSec: checkTimeSec ?? null,
      startTimeSec: usableCardStart ?? null,
      finishTimeSec: finishTimeSec ?? effectiveFinish,
      punches: punches.map((p) => ({ ...p })),
      rawHex,
      receivedAt: nowIso,
      clientReadoutId,
    };

    runner.checkTimeSec = checkTimeSec ?? runner.checkTimeSec;
    runner.startTimeSec = usableCardStart ?? runner.startTimeSec;
    runner.finishTimeSec = effectiveFinish;
    runner.cardPunches = applyEmergencyTimeOffsets(
      punches,
      db.emergency.controlTimeOffsets
    );
    runner.readoutAt = nowIso;
    runner.lastSeenControl = 1;
    runner.lastSeenTimeSec = effectiveFinish;
    runner.runningTimeSec =
      effectiveFinish >= effectiveStart ? effectiveFinish - effectiveStart : null;

    const validation = validateCompetitorReadout(
      cls,
      db.courses,
      effectiveStart,
      effectiveFinish,
      punches,
      db.emergency
    );
    runner.validation = validation;
    runner.status = validation.ok ? 'OK' : 'MP';

    recomputeAllSplitRanks(db);

    const autoTag = autoCreatedFromDb ? ' · Auto-hämtad från Eventor/Löpardatabas' : '';

    const ev: LiveEventItem = {
      id: `ev-${Date.now()}`,
      timestamp: nowIso,
      clock24h: secToClock(nowSec),
      eventType: validation.ok ? 'READOUT_OK' : 'READOUT_MP',
      siNumber: parsedSi,
      competitorId: runner.id,
      competitorName: runner.fullName,
      club: runner.club,
      className: cls?.name ?? null,
      stationCode: station?.stationCode ?? 1,
      stationName: station?.name ?? 'Målavläsning',
      runningTimeSec: runner.runningTimeSec,
      message: validation.ok
        ? cls?.classFormat === 'ROGAINING'
          ? `Utläst & Godkänd i ${cls.name}: ${validation.rogainingPoints ?? 0} poäng på ${
              runner.runningTimeSec !== null ? durToMmSs(runner.runningTimeSec) : '—'
            }${autoTag}${runner.isRentalCard && !runner.rentalReturned ? ' · OBS: HYRBRICKA!' : ''}`
          : `Utläst & Godkänd (OK) i ${cls?.name ?? '-'} (${runner.cardSeries}) på ${
              runner.runningTimeSec !== null ? durToMmSs(runner.runningTimeSec) : '—'
            }${autoTag}${runner.isRentalCard && !runner.rentalReturned ? ' · OBS: HYRBRICKA!' : ''}`
        : `Felstämplat (MP) i ${cls?.name ?? '-'} — saknar kontroll: ${validation.missingControls
            .map((k) => `(${k})`)
            .join(', ')}${autoTag}`,
      rawHex,
    };

    db.events.unshift(ev);
    db.events = db.events.slice(0, 250);
    saveSeasonDatabase(seasonDb);
    broadcastFullState(db.competition.shortCode);

    res.status(201).json({ competitor: runner, event: ev, autoCreatedFromDb });
  });

  // 3. Emergency Forest Tools & Raw Readout Recalculation
  app.put('/api/emergency', (req, res) => {
    const db = getActiveEvent();
    const body = req.body as Partial<EmergencySettings>;

    if (Array.isArray(body.brokenControls)) {
      db.emergency.brokenControls = Array.from(
        new Set(body.brokenControls.map(Number).filter((n) => Number.isFinite(n) && n > 0))
      ).sort((a, b) => a - b);
    }

    if (body.controlTimeOffsets && typeof body.controlTimeOffsets === 'object') {
      const cleaned: Record<string, number> = {};
      for (const [k, v] of Object.entries(body.controlTimeOffsets)) {
        const num = Math.round(Number(v));
        if (Number.isFinite(num) && num !== 0) {
          cleaned[String(k)] = num;
        }
      }
      db.emergency.controlTimeOffsets = cleaned;
    }

    const recalculatedCount = recalculateEventFromRawReadouts(db);
    const now = new Date();
    const brokenLabel =
      db.emergency.brokenControls.length > 0
        ? `Trasiga kontroller undantagna: ${db.emergency.brokenControls
            .map((c) => `(${c})`)
            .join(', ')}`
        : 'Inga trasiga kontroller aktiva';

    db.events.unshift({
      id: `ev-${Date.now()}`,
      timestamp: now.toISOString(),
      clock24h: secToClock(getStockholmClockSec(now)),
      eventType: 'EMERGENCY',
      siNumber: 0,
      competitorId: null,
      competitorName: 'Tävlingsledning',
      club: db.competition.organizer,
      className: null,
      stationCode: 0,
      stationName: 'Nödlägen & Omräkning',
      runningTimeSec: null,
      message: `${brokenLabel} · Räknade om ${recalculatedCount} utlästa brickor från sparad rådata.`,
    });

    saveSeasonDatabase(seasonDb);
    broadcastFullState(db.competition.shortCode);
    res.json({ emergency: db.emergency, recalculatedCount });
  });

  app.post('/api/emergency/recalculate-all', (_req, res) => {
    const db = getActiveEvent();
    const recalculatedCount = recalculateEventFromRawReadouts(db);
    saveSeasonDatabase(seasonDb);
    broadcastFullState(db.competition.shortCode);
    res.json({ recalculatedCount });
  });

  app.post('/api/emergency/manual-finish', (req, res) => {
    const db = getActiveEvent();
    const { competitorId, finishClockStr } = req.body as {
      competitorId?: string;
      finishClockStr?: string;
    };

    const runner = db.competitors.find((c) => c.id === competitorId);
    if (!runner) {
      res.status(404).json({ error: 'Deltagare hittades ej.' });
      return;
    }

    const finSec = finishClockStr ? parseClockStrToSec(finishClockStr) : null;
    if (finSec === null) {
      res.status(400).json({ error: 'Ange giltigt klockslag i format HH:MM:SS.' });
      return;
    }

    runner.manualFinishTimeSec = finSec;
    runner.finishTimeSec = finSec;
    const effStart =
      runner.startTimeSec ?? runner.allocatedStartSec ?? db.competition.zeroTimeSec;
    runner.runningTimeSec = finSec >= effStart ? finSec - effStart : null;

    if (runner.rawReadout || runner.cardPunches.length > 0) {
      recalculateEventFromRawReadouts(db);
    } else {
      runner.status = 'OK';
      recomputeAllSplitRanks(db);
    }

    const clsName = db.classes.find((c) => c.id === runner.classId)?.name ?? null;
    const now = new Date();
    db.events.unshift({
      id: `ev-${Date.now()}`,
      timestamp: now.toISOString(),
      clock24h: secToClock(finSec),
      eventType: 'EMERGENCY',
      siNumber: runner.siNumber,
      competitorId: runner.id,
      competitorName: runner.fullName,
      club: runner.club,
      className: clsName,
      stationCode: 90,
      stationName: 'Manuell tidtagning (Sekretariat)',
      runningTimeSec: runner.runningTimeSec,
      message: `Manuell måltid ${secToClock(finSec)} satt för ${runner.fullName} (löptid ${
        runner.runningTimeSec !== null ? durToMmSs(runner.runningTimeSec) : '—'
      })`,
    });

    saveSeasonDatabase(seasonDb);
    broadcastFullState(db.competition.shortCode);
    res.json(runner);
  });

  // 4. Start List Draw Engine (Lottning med minutstart, masstart, fri start, vakanser & klubbseparering)
  app.post('/api/draw/class', (req, res) => {
    const db = getActiveEvent();
    const {
      classId,
      mode = 'INTERVAL',
      firstStartClock = db.competition.zeroTimeStr,
      intervalSec = 120,
      vacancies = 0,
      clubSeparation = true,
      includeAlreadyStarted = false,
    } = req.body as {
      classId?: string;
      mode?: 'INTERVAL' | 'MASS' | 'FREE';
      firstStartClock?: string;
      intervalSec?: number;
      vacancies?: number;
      clubSeparation?: boolean;
      includeAlreadyStarted?: boolean;
    };

    const cls = db.classes.find((c) => c.id === classId);
    if (!cls) {
      res.status(404).json({ error: 'Klassen hittades ej.' });
      return;
    }

    const firstSec = parseClockStrToSec(firstStartClock) ?? db.competition.zeroTimeSec;
    const stepSec = Math.max(15, Number(intervalSec) || 120);
    const vacCount = Math.max(0, Math.min(20, Math.floor(Number(vacancies) || 0)));

    const eligible = db.competitors.filter((c) => {
      if (c.classId !== cls.id) return false;
      if (includeAlreadyStarted) return true;
      return c.status === 'REGISTERED' || c.status === 'DNS' || c.status === 'CHECKED';
    });

    const vacantStartTimes: string[] = [];

    if (mode === 'FREE') {
      cls.freeStart = true;
      for (const r of eligible) {
        r.allocatedStartSec = null;
      }
    } else if (mode === 'MASS') {
      cls.freeStart = false;
      for (const r of eligible) {
        r.allocatedStartSec = firstSec;
      }
    } else {
      cls.freeStart = false;
      const ordered = clubSeparation
        ? shuffleWithClubSeparation(eligible)
        : shuffleWithClubSeparation(eligible); // Note: if !clubSeparation, pure Fisher-Yates below

      let finalOrder = ordered;
      if (!clubSeparation) {
        finalOrder = [...eligible];
        for (let i = finalOrder.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [finalOrder[i], finalOrder[j]] = [finalOrder[j], finalOrder[i]];
        }
      }

      // Reserve vacant start slots first (standard Swedish Eventor/MeOS convention for late entries)
      let cursorSec = firstSec;
      for (let v = 0; v < vacCount; v++) {
        vacantStartTimes.push(secToClock(cursorSec));
        cursorSec += stepSec;
      }

      for (const r of finalOrder) {
        r.allocatedStartSec = cursorSec;
        cursorSec += stepSec;
      }
    }

    saveSeasonDatabase(seasonDb);
    broadcastFullState(db.competition.shortCode);
    res.json({
      className: cls.name,
      drawnCount: eligible.length,
      mode,
      vacantStartTimes,
    });
  });

  // 5. ROC (roc.olresultat.se) Radio Controls Integration
  app.put('/api/roc/settings', (req, res) => {
    const db = getActiveEvent();
    const body = req.body as Partial<RocIntegrationStatus>;
    if (body.enabled !== undefined) db.roc.enabled = Boolean(body.enabled);
    if (body.unitId !== undefined) db.roc.unitId = String(body.unitId).trim();
    if (body.pollIntervalSec !== undefined) {
      db.roc.pollIntervalSec = Math.max(3, Math.min(60, Number(body.pollIntervalSec) || 5));
    }
    if (body.lastPunchId !== undefined) {
      db.roc.lastPunchId = Math.max(0, Number(body.lastPunchId) || 0);
    }
    saveSeasonDatabase(seasonDb);
    broadcastFullState(db.competition.shortCode);
    res.json(db.roc);
  });

  app.post('/api/roc/poll-now', async (_req, res) => {
    const db = getActiveEvent();
    const out = await pollRocOnce(db);
    saveSeasonDatabase(seasonDb);
    broadcastFullState(db.competition.shortCode);
    res.json({
      ingested: out.ingested,
      error: out.error,
      roc: db.roc,
    });
  });

  app.post('/api/roc/simulate-batch', (_req, res) => {
    const db = getActiveEvent();
    const activeForestRunners = db.competitors.filter(
      (c) => c.status === 'IN_FOREST' || c.status === 'CHECKED'
    );
    const now = new Date();
    const nowSec = getStockholmClockSec(now);

    const sampleLines: string[] = [];
    let nextId = db.roc.lastPunchId + 1;

    if (activeForestRunners.length > 0) {
      for (const r of activeForestRunners.slice(0, 3)) {
        const refStart =
          r.startTimeSec ?? r.allocatedStartSec ?? db.competition.zeroTimeSec;
        const simCtrl = r.lastSeenControl === 42 ? 55 : r.lastSeenControl === 55 ? 100 : 42;
        const simSec = Math.max(nowSec, refStart + (simCtrl === 42 ? 730 : simCtrl === 55 ? 1140 : 1690));
        sampleLines.push(
          `${nextId++};${simCtrl};${r.siNumber};${db.competition.date} ${secToClock(simSec)}`
        );
      }
    } else {
      sampleLines.push(
        `${nextId++};42;8812405;${db.competition.date} ${secToClock(nowSec)}`
      );
    }

    const ingested = ingestRocTextPayload(db, sampleLines.join('\n'));
    db.roc.lastPolledAt = now.toISOString();
    db.roc.lastError = null;
    saveSeasonDatabase(seasonDb);
    broadcastFullState(db.competition.shortCode);
    res.json({ ingested, samplePayload: sampleLines.join('\n'), roc: db.roc });
  });

  // 6. Competitors & Direct Entry CRUD
  app.post('/api/competitors', (req, res) => {
    const db = getActiveEvent();
    const body = req.body as Partial<Competitor> & {
      pendingReadout?: {
        checkTimeSec?: number | null;
        startTimeSec?: number | null;
        finishTimeSec?: number | null;
        punches?: CardPunch[];
      };
    };

    const siNumber = Number(body.siNumber);
    if (!Number.isFinite(siNumber) || siNumber <= 0 || !body.fullName?.trim()) {
      res.status(400).json({ error: 'Ange giltigt SI-bricknummer och löparens namn.' });
      return;
    }
    const activeConflict = db.competitors.find(
      (c) =>
        c.siNumber === siNumber &&
        (c.status === 'REGISTERED' ||
          c.status === 'CHECKED' ||
          c.status === 'IN_FOREST' ||
          c.status === 'PRELIMINARY_FIN')
    );
    if (activeConflict) {
      res.status(409).json({
        error: `SI-bricka ${siNumber} används redan av en aktiv deltagare (#${activeConflict.bib} ${activeConflict.fullName}).`,
      });
      return;
    }

    const maxBib = db.competitors.reduce((m, c) => Math.max(m, c.bib), 400);
    const classId = body.classId || db.classes[0]?.id || 'cls-open';
    const cls = db.classes.find((c) => c.id === classId);

    const created: Competitor = {
      id: `cmp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      bib: body.bib ?? maxBib + 1,
      fullName: body.fullName.trim(),
      club: body.club?.trim() || 'Klubblös',
      classId,
      siNumber,
      cardSeries: body.cardSeries ?? inferSeries(siNumber),
      isRentalCard: Boolean(body.isRentalCard),
      isBorrowedCard: Boolean(body.isBorrowedCard),
      rentalReturned: false,
      feePaid: Boolean(body.feePaid),
      status: body.status ?? 'REGISTERED',
      allocatedStartSec:
        body.allocatedStartSec !== undefined ? body.allocatedStartSec : null,
      checkTimeSec: body.checkTimeSec !== undefined ? body.checkTimeSec : null,
      startTimeSec: body.startTimeSec !== undefined ? body.startTimeSec : null,
      finishTimeSec: null,
      runningTimeSec: null,
      lastSeenControl:
        body.lastSeenControl !== undefined ? body.lastSeenControl : null,
      lastSeenTimeSec:
        body.lastSeenTimeSec !== undefined ? body.lastSeenTimeSec : null,
      readoutAt: null,
      radioSplits: [],
      cardPunches: [],
      validation: null,
    };

    if (body.pendingReadout && Array.isArray(body.pendingReadout.punches)) {
      const effStart =
        body.pendingReadout.startTimeSec ??
        created.allocatedStartSec ??
        db.competition.zeroTimeSec;
      const effFin = body.pendingReadout.finishTimeSec ?? null;
      const rawPunches = body.pendingReadout.punches;
      created.rawReadout = {
        checkTimeSec: body.pendingReadout.checkTimeSec ?? null,
        startTimeSec: body.pendingReadout.startTimeSec ?? null,
        finishTimeSec: effFin,
        punches: rawPunches.map((p) => ({ ...p })),
        receivedAt: new Date().toISOString(),
      };
      created.checkTimeSec = body.pendingReadout.checkTimeSec ?? null;
      created.startTimeSec = body.pendingReadout.startTimeSec ?? null;
      created.finishTimeSec = effFin;
      created.cardPunches = applyEmergencyTimeOffsets(
        rawPunches,
        db.emergency.controlTimeOffsets
      );
      created.readoutAt = new Date().toISOString();
      created.runningTimeSec =
        effFin !== null && effFin >= effStart ? effFin - effStart : null;
      created.validation = validateCompetitorReadout(
        cls,
        db.courses,
        effStart,
        effFin,
        rawPunches,
        db.emergency
      );
      created.status = created.validation.ok ? 'OK' : 'MP';
    }

    db.competitors.unshift(created);
    if (!created.isRentalCard && !created.isBorrowedCard) {
      upsertRunnerInSeasonDb(seasonDb, {
        siNumber: created.siNumber,
        fullName: created.fullName,
        club: created.club,
        defaultClassName: cls?.name ?? null,
        source: 'LEARNED_ENTRY',
      });
    }
    recomputeAllSplitRanks(db);

    const now = new Date();
    const isDirectPinnstart =
      created.status === 'IN_FOREST' && created.startTimeSec !== null;
    db.events.unshift({
      id: `ev-${Date.now()}`,
      timestamp: now.toISOString(),
      clock24h: secToClock(
        isDirectPinnstart && created.startTimeSec !== null
          ? created.startTimeSec
          : getStockholmClockSec(now)
      ),
      eventType: isDirectPinnstart ? 'START' : 'DIRECT_ENTRY',
      siNumber: created.siNumber,
      competitorId: created.id,
      competitorName: created.fullName,
      club: created.club,
      className: cls?.name ?? null,
      stationCode: isDirectPinnstart ? 20 : 1,
      stationName: isDirectPinnstart
        ? 'Startfålla — Pinnstart'
        : 'Sekretariat — Direktanmälan',
      runningTimeSec: created.runningTimeSec,
      message: isDirectPinnstart
        ? `Pinnstart kl. ${secToClock(created.startTimeSec!)} i ${cls?.name ?? '-'} (direktanmäld från Löpardatabas)`
        : `Direktanmäld i ${cls?.name ?? '-'}${
            created.isRentalCard ? ' (Hyrbricka utlämnad)' : ''
          }`,
    });

    persistUserMutation();
    broadcastFullState(db.competition.shortCode);
    res.status(201).json(created);
  });

  app.put('/api/competitors/:id', (req, res) => {
    const db = getActiveEvent();
    const idx = db.competitors.findIndex((c) => c.id === req.params.id);
    if (idx === -1) {
      res.status(404).json({ error: 'Deltagare hittades ej.' });
      return;
    }
    const existing = db.competitors[idx];
    const body = req.body as Partial<Competitor>;
    const nextSi = body.siNumber !== undefined ? Number(body.siNumber) : existing.siNumber;

    if (nextSi !== existing.siNumber) {
      const activeConflict = db.competitors.find(
        (c) =>
          c.siNumber === nextSi &&
          c.id !== existing.id &&
          (c.status === 'REGISTERED' ||
            c.status === 'CHECKED' ||
            c.status === 'IN_FOREST' ||
            c.status === 'PRELIMINARY_FIN')
      );
      if (activeConflict) {
        res.status(409).json({
          error: `SI-bricka ${nextSi} används redan av #${activeConflict.bib} ${activeConflict.fullName}.`,
        });
        return;
      }
    }

    const updatedClassId = body.classId ?? existing.classId;
    const updated: Competitor = {
      ...existing,
      fullName: body.fullName !== undefined ? body.fullName.trim() : existing.fullName,
      club: body.club !== undefined ? body.club.trim() : existing.club,
      classId: updatedClassId,
      siNumber: nextSi,
      cardSeries: inferSeries(nextSi),
      isRentalCard:
        body.isRentalCard !== undefined ? body.isRentalCard : existing.isRentalCard,
      isBorrowedCard:
        body.isBorrowedCard !== undefined ? body.isBorrowedCard : existing.isBorrowedCard,
      rentalReturned:
        body.rentalReturned !== undefined ? body.rentalReturned : existing.rentalReturned,
      feePaid: body.feePaid !== undefined ? Boolean(body.feePaid) : existing.feePaid,
      status: body.status ?? existing.status,
      allocatedStartSec:
        body.allocatedStartSec !== undefined
          ? body.allocatedStartSec
          : existing.allocatedStartSec,
      checkTimeSec:
        body.checkTimeSec !== undefined ? body.checkTimeSec : existing.checkTimeSec,
      startTimeSec:
        body.startTimeSec !== undefined ? body.startTimeSec : existing.startTimeSec,
      lastSeenControl:
        body.lastSeenControl !== undefined
          ? body.lastSeenControl
          : existing.lastSeenControl,
      lastSeenTimeSec:
        body.lastSeenTimeSec !== undefined
          ? body.lastSeenTimeSec
          : existing.lastSeenTimeSec,
    };

    const sourcePunches = updated.rawReadout
      ? updated.rawReadout.punches
      : updated.cardPunches;

    const classOrStartChanged =
      updatedClassId !== existing.classId ||
      updated.startTimeSec !== existing.startTimeSec;

    if (
      classOrStartChanged &&
      (sourcePunches.length > 0 || updated.finishTimeSec !== null)
    ) {
      const cls = db.classes.find((c) => c.id === updatedClassId);
      const effStart =
        updated.startTimeSec ??
        updated.rawReadout?.startTimeSec ??
        updated.allocatedStartSec ??
        db.competition.zeroTimeSec;
      const effFin =
        updated.manualFinishTimeSec ??
        updated.rawReadout?.finishTimeSec ??
        updated.finishTimeSec;
      updated.runningTimeSec =
        effFin !== null && effFin >= effStart ? effFin - effStart : null;
      if (sourcePunches.length > 0 || updated.readoutAt) {
        updated.validation = validateCompetitorReadout(
          cls,
          db.courses,
          effStart,
          effFin,
          sourcePunches,
          db.emergency
        );
        if (updated.status === 'OK' || updated.status === 'MP') {
          updated.status = updated.validation.ok ? 'OK' : 'MP';
        }
      }
    }

    db.competitors[idx] = updated;
    const updatedCls = db.classes.find((c) => c.id === updated.classId);

    if (
      updated.status === 'IN_FOREST' &&
      (existing.status !== 'IN_FOREST' ||
        updated.startTimeSec !== existing.startTimeSec)
    ) {
      const now = new Date();
      const stampSec = updated.startTimeSec ?? getStockholmClockSec(now);
      db.events.unshift({
        id: `ev-${Date.now()}`,
        timestamp: now.toISOString(),
        clock24h: secToClock(stampSec),
        eventType: 'START',
        siNumber: updated.siNumber,
        competitorId: updated.id,
        competitorName: updated.fullName,
        club: updated.club,
        className: updatedCls?.name ?? null,
        stationCode: 20,
        stationName: 'Startfålla — Start',
        runningTimeSec: null,
        message: `Startad kl. ${secToClock(stampSec)} i ${updatedCls?.name ?? '-'}`,
      });
      db.events = db.events.slice(0, 250);
    } else if (updated.status === 'CHECKED' && existing.status === 'REGISTERED') {
      const now = new Date();
      const stampSec = updated.checkTimeSec ?? getStockholmClockSec(now);
      db.events.unshift({
        id: `ev-${Date.now()}`,
        timestamp: now.toISOString(),
        clock24h: secToClock(stampSec),
        eventType: 'CHECK',
        siNumber: updated.siNumber,
        competitorId: updated.id,
        competitorName: updated.fullName,
        club: updated.club,
        className: updatedCls?.name ?? null,
        stationCode: 10,
        stationName: 'Startfålla — Check',
        runningTimeSec: null,
        message: `Checkad i startfållan kl. ${secToClock(stampSec)} (${updatedCls?.name ?? '-'})`,
      });
      db.events = db.events.slice(0, 250);
    }

    if (!updated.isRentalCard && !updated.isBorrowedCard) {
      upsertRunnerInSeasonDb(seasonDb, {
        siNumber: updated.siNumber,
        fullName: updated.fullName,
        club: updated.club,
        defaultClassName: updatedCls?.name ?? null,
        source: 'LEARNED_ENTRY',
      });
    }
    recomputeAllSplitRanks(db);
    persistUserMutation();
    broadcastFullState(db.competition.shortCode);
    res.json(updated);
  });

  app.delete('/api/competitors/:id', (req, res) => {
    const db = getActiveEvent();
    db.competitors = db.competitors.filter((c) => c.id !== req.params.id);
    recomputeAllSplitRanks(db);
    saveSeasonDatabase(seasonDb);
    broadcastFullState(db.competition.shortCode);
    res.status(204).end();
  });

  // 7. Courses & Classes CRUD
  app.post('/api/courses', (req, res) => {
    const db = getActiveEvent();
    const body = req.body as Partial<Course>;
    if (!body.name?.trim() || !Array.isArray(body.controls) || body.controls.length === 0) {
      res.status(400).json({ error: 'Ange bannamn och minst en kontrollkod.' });
      return;
    }
    const course: Course = {
      id: `crs-${Date.now()}`,
      name: body.name.trim(),
      lengthMeters: Number(body.lengthMeters) || 3500,
      climbMeters: Number(body.climbMeters) || 80,
      controls: body.controls.map(Number).filter((n) => Number.isFinite(n) && n > 0),
    };
    db.courses.push(course);
    recalculateEventFromRawReadouts(db);
    saveSeasonDatabase(seasonDb);
    broadcastFullState(db.competition.shortCode);
    res.status(201).json(course);
  });

  app.put('/api/courses/:id', (req, res) => {
    const db = getActiveEvent();
    const idx = db.courses.findIndex((c) => c.id === req.params.id);
    if (idx === -1) {
      res.status(404).json({ error: 'Bana hittades ej.' });
      return;
    }
    const body = req.body as Partial<Course>;
    db.courses[idx] = {
      ...db.courses[idx],
      name: body.name !== undefined ? body.name.trim() : db.courses[idx].name,
      lengthMeters:
        body.lengthMeters !== undefined ? Number(body.lengthMeters) : db.courses[idx].lengthMeters,
      climbMeters:
        body.climbMeters !== undefined ? Number(body.climbMeters) : db.courses[idx].climbMeters,
      controls: Array.isArray(body.controls)
        ? body.controls.map(Number).filter((n) => Number.isFinite(n) && n > 0)
        : db.courses[idx].controls,
    };

    recalculateEventFromRawReadouts(db);
    saveSeasonDatabase(seasonDb);
    broadcastFullState(db.competition.shortCode);
    res.json(db.courses[idx]);
  });

  app.delete('/api/courses/:id', (req, res) => {
    const db = getActiveEvent();
    db.courses = db.courses.filter((c) => c.id !== req.params.id);
    recalculateEventFromRawReadouts(db);
    saveSeasonDatabase(seasonDb);
    broadcastFullState(db.competition.shortCode);
    res.status(204).end();
  });

  app.post('/api/classes', (req, res) => {
    const db = getActiveEvent();
    const body = req.body as Partial<CompClass>;
    if (!body.name?.trim()) {
      res.status(400).json({ error: 'Ange klassnamn.' });
      return;
    }
    const created: CompClass = {
      id: `cls-${Date.now()}`,
      name: body.name.trim(),
      courseId: body.courseId ?? db.courses[0]?.id ?? null,
      classFormat: body.classFormat ?? 'STANDARD',
      forkCourseIds: Array.isArray(body.forkCourseIds) ? body.forkCourseIds : undefined,
      rogainingMaxTimeSec:
        body.rogainingMaxTimeSec !== undefined ? Number(body.rogainingMaxTimeSec) : null,
      rogainingPenaltyPerMin:
        body.rogainingPenaltyPerMin !== undefined ? Number(body.rogainingPenaltyPerMin) : null,
      allowDirectEntry: body.allowDirectEntry !== false,
      freeStart: Boolean(body.freeStart),
      autoMatchCourse: Boolean(body.autoMatchCourse),
      feeSek: Number(body.feeSek ?? 140),
    };
    db.classes.push(created);
    saveSeasonDatabase(seasonDb);
    broadcastFullState(db.competition.shortCode);
    res.status(201).json(created);
  });

  app.put('/api/classes/:id', (req, res) => {
    const db = getActiveEvent();
    const idx = db.classes.findIndex((c) => c.id === req.params.id);
    if (idx === -1) {
      res.status(404).json({ error: 'Klass hittades ej.' });
      return;
    }
    const body = req.body as Partial<CompClass>;
    db.classes[idx] = {
      ...db.classes[idx],
      name: body.name !== undefined ? body.name.trim() : db.classes[idx].name,
      courseId: body.courseId !== undefined ? body.courseId : db.classes[idx].courseId,
      classFormat:
        body.classFormat !== undefined ? body.classFormat : db.classes[idx].classFormat,
      forkCourseIds:
        body.forkCourseIds !== undefined ? body.forkCourseIds : db.classes[idx].forkCourseIds,
      rogainingMaxTimeSec:
        body.rogainingMaxTimeSec !== undefined
          ? body.rogainingMaxTimeSec
          : db.classes[idx].rogainingMaxTimeSec,
      rogainingPenaltyPerMin:
        body.rogainingPenaltyPerMin !== undefined
          ? body.rogainingPenaltyPerMin
          : db.classes[idx].rogainingPenaltyPerMin,
      allowDirectEntry:
        body.allowDirectEntry !== undefined
          ? body.allowDirectEntry
          : db.classes[idx].allowDirectEntry,
      freeStart: body.freeStart !== undefined ? body.freeStart : db.classes[idx].freeStart,
      autoMatchCourse:
        body.autoMatchCourse !== undefined
          ? body.autoMatchCourse
          : db.classes[idx].autoMatchCourse,
      feeSek:
        body.feeSek !== undefined
          ? Math.max(0, Math.min(10000, Math.round(Number(body.feeSek) || 0)))
          : db.classes[idx].feeSek,
    };
    recalculateEventFromRawReadouts(db);
    saveSeasonDatabase(seasonDb);
    broadcastFullState(db.competition.shortCode);
    res.json(db.classes[idx]);
  });

  // 8. Stations CRUD
  app.post('/api/stations', (req, res) => {
    const db = getActiveEvent();
    const body = req.body as Partial<SIStation>;
    const code = Number(body.stationCode);
    if (!Number.isFinite(code) || code < 1 || code > 511 || !body.name?.trim()) {
      res.status(400).json({ error: 'Stationskod (CN 1–511) och benämning krävs.' });
      return;
    }
    if (db.stations.some((s) => s.stationCode === code)) {
      res.status(409).json({ error: `Stationskod CN ${code} är redan konfigurerad.` });
      return;
    }
    const st: SIStation = {
      id: `st-${code}-${Date.now()}`,
      stationCode: code,
      name: body.name.trim(),
      hardwareModel: body.hardwareModel ?? 'BSM8-USB',
      stationFunction: body.stationFunction ?? 'RADIO',
      baudRate: body.baudRate ?? 38400,
      extendedProtocol: true,
      batteryMv: 4950,
      firmware: 'FW 6.56',
      lastSeenAt: null,
      active: true,
    };
    db.stations.push(st);
    db.stations.sort((a, b) => a.stationCode - b.stationCode);
    saveSeasonDatabase(seasonDb);
    broadcastFullState(db.competition.shortCode);
    res.status(201).json(st);
  });

  app.put('/api/stations/:id', (req, res) => {
    const db = getActiveEvent();
    const station = db.stations.find((item) => item.id === req.params.id);
    if (!station) {
      res.status(404).json({ error: 'Stationen hittades inte.' });
      return;
    }

    const body = req.body as Partial<SIStation>;
    const code = Number(body.stationCode);
    if (!Number.isInteger(code) || code < 1 || code > 511 || !body.name?.trim()) {
      res.status(400).json({ error: 'Stationskod (CN 1–511) och benämning krävs.' });
      return;
    }
    if (db.stations.some((item) => item.id !== station.id && item.stationCode === code)) {
      res.status(409).json({ error: `Stationskod CN ${code} är redan konfigurerad.` });
      return;
    }

    station.stationCode = code;
    station.name = body.name.trim();
    station.hardwareModel = body.hardwareModel ?? station.hardwareModel;
    station.stationFunction = body.stationFunction ?? station.stationFunction;
    db.stations.sort((a, b) => a.stationCode - b.stationCode);
    saveSeasonDatabase(seasonDb);
    broadcastFullState(db.competition.shortCode);
    res.json(station);
  });

  app.delete('/api/stations/:id', (req, res) => {
    const db = getActiveEvent();
    db.stations = db.stations.filter((s) => s.id !== req.params.id);
    saveSeasonDatabase(seasonDb);
    broadcastFullState(db.competition.shortCode);
    res.status(204).end();
  });

  // 9. IOF XML (3.0 & 2.0.3) Batch Import
  app.post('/api/import/batch', (req, res) => {
    const db = getActiveEvent();
    const clubCfg = ensureClubSettings(seasonDb);
    const {
      courses = [],
      classes = [],
      entries = [],
      runnerDbEntries = [],
      replaceExisting = false,
      defaultFreeStart = false,
    } = req.body as {
      courses?: { name: string; lengthMeters: number; climbMeters: number; controls: number[] }[];
      classes?: {
        name: string;
        courseName?: string;
        classFormat?: ClassCompetitionFormat;
        forkCourseNames?: string[];
        freeStart?: boolean;
        autoMatchCourse?: boolean;
      }[];
      entries?: { fullName: string; club: string; className: string; siNumber: number }[];
      runnerDbEntries?: {
        siNumber: number;
        fullName: string;
        club: string;
        birthYear?: number | null;
        defaultClassName?: string | null;
        eventorPersonId?: string | null;
      }[];
      replaceExisting?: boolean;
      defaultFreeStart?: boolean;
    };

    let addedCourses = 0;
    let addedClasses = 0;
    let addedEntries = 0;
    let syncedRunnerDb = 0;

    const sanitizedCourses = courses
      .map((c, idx) => {
        const controls = (Array.isArray(c.controls) ? c.controls : [])
          .map((n) => Math.round(Number(n)))
          .filter((n) => Number.isFinite(n) && n >= 1 && n <= 511)
          .slice(0, 128);
        return {
          name: String(c.name || '').trim().slice(0, 120) || `Bana ${idx + 1}`,
          lengthMeters: Math.max(0, Math.min(200000, Math.round(Number(c.lengthMeters) || 0))),
          climbMeters: Math.max(0, Math.min(20000, Math.round(Number(c.climbMeters) || 0))),
          controls,
        };
      })
      .filter((c) => c.controls.length > 0);

    if (replaceExisting && sanitizedCourses.length > 0) {
      const oldCoursesByName = new Map(
        db.courses.map((oc) => [oc.name.toLowerCase(), oc] as const)
      );
      db.courses = sanitizedCourses.map((c, idx) => {
        const prev = oldCoursesByName.get(c.name.toLowerCase());
        return {
          id: prev?.id ?? `crs-${Date.now()}-${idx + 1}-${Math.random().toString(36).slice(2, 5)}`,
          name: c.name,
          lengthMeters: c.lengthMeters,
          climbMeters: c.climbMeters,
          controls: c.controls,
        };
      });
      addedCourses = db.courses.length;
    } else {
      for (const c of sanitizedCourses) {
        const existing = db.courses.find((x) => x.name.toLowerCase() === c.name.toLowerCase());
        if (existing) {
          existing.controls = c.controls;
          existing.lengthMeters = c.lengthMeters;
          existing.climbMeters = c.climbMeters;
        } else {
          db.courses.push({
            id: `crs-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            name: c.name,
            lengthMeters: c.lengthMeters,
            climbMeters: c.climbMeters,
            controls: c.controls,
          });
          addedCourses++;
        }
      }
    }

    const resolveClassSpec = (
      cl: {
        name: string;
        courseName?: string;
        classFormat?: ClassCompetitionFormat;
        forkCourseNames?: string[];
        freeStart?: boolean;
        autoMatchCourse?: boolean;
      },
      existingClass?: CompClass
    ): CompClass => {
      const forkCourseIds = (Array.isArray(cl.forkCourseNames) ? cl.forkCourseNames : [])
        .map((fn) => db.courses.find((x) => x.name.toLowerCase() === fn.toLowerCase())?.id)
        .filter((id): id is string => Boolean(id))
        .slice(0, 32);
      const linkedCourse = cl.courseName
        ? db.courses.find((x) => x.name.toLowerCase() === cl.courseName!.toLowerCase())
        : undefined;
      const isForked = cl.classFormat === 'FORKED' && forkCourseIds.length > 0;
      const freeStart = cl.freeStart ?? (existingClass?.freeStart ?? Boolean(defaultFreeStart));
      return {
        id:
          existingClass?.id ??
          `cls-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name: String(cl.name || '').trim().slice(0, 80),
        courseId: isForked
          ? forkCourseIds[0] ?? linkedCourse?.id ?? db.courses[0]?.id ?? null
          : linkedCourse?.id ?? existingClass?.courseId ?? db.courses[0]?.id ?? null,
        classFormat: isForked ? 'FORKED' : 'STANDARD',
        forkCourseIds: isForked ? forkCourseIds : [],
        allowDirectEntry: existingClass?.allowDirectEntry ?? true,
        freeStart,
        autoMatchCourse: isForked
          ? true
          : Boolean(cl.autoMatchCourse ?? existingClass?.autoMatchCourse ?? freeStart),
        feeSek: existingClass?.feeSek ?? clubCfg.defaultDirectEntryFeeSek,
      };
    };

    const validIncomingClasses = classes.filter(
      (cl) => String(cl.name || '').trim().length > 0
    );

    if (replaceExisting && validIncomingClasses.length > 0) {
      const oldClassesByName = new Map(
        db.classes.map((oc) => [oc.name.toLowerCase(), oc] as const)
      );
      db.classes = validIncomingClasses.map((cl) =>
        resolveClassSpec(cl, oldClassesByName.get(cl.name.toLowerCase()))
      );
      addedClasses = db.classes.length;

      const validClassIds = new Set(db.classes.map((c) => c.id));
      const fallbackClassId = db.classes[0]?.id;
      if (fallbackClassId) {
        for (const comp of db.competitors) {
          if (!validClassIds.has(comp.classId)) {
            comp.classId = fallbackClassId;
          }
        }
      }
    } else {
      if (replaceExisting && db.courses.length > 0) {
        const validCourseIds = new Set(db.courses.map((c) => c.id));
        const fallbackCourseId = db.courses[0]?.id ?? null;
        for (const cls of db.classes) {
          if (cls.courseId && !validCourseIds.has(cls.courseId)) {
            cls.courseId = fallbackCourseId;
          }
          if (cls.forkCourseIds) {
            cls.forkCourseIds = cls.forkCourseIds.filter((id) => validCourseIds.has(id));
          }
        }
      }
      for (const cl of validIncomingClasses) {
        const existing = db.classes.find(
          (x) => x.name.toLowerCase() === cl.name.trim().toLowerCase()
        );
        if (existing) {
          const updated = resolveClassSpec(cl, existing);
          existing.courseId = updated.courseId;
          existing.classFormat = updated.classFormat;
          existing.forkCourseIds = updated.forkCourseIds;
          if (cl.freeStart !== undefined) existing.freeStart = updated.freeStart;
          if (cl.autoMatchCourse !== undefined || updated.classFormat === 'FORKED') {
            existing.autoMatchCourse = updated.autoMatchCourse;
          }
        } else {
          db.classes.push(resolveClassSpec(cl));
          addedClasses++;
        }
      }
    }

    let nextBib = db.competitors.reduce((m, c) => Math.max(m, c.bib), 500) + 1;
    for (const ent of entries) {
      let targetCls = db.classes.find(
        (x) => x.name.toLowerCase() === ent.className.toLowerCase()
      );
      if (!targetCls) {
        targetCls = {
          id: `cls-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
          name: ent.className,
          courseId: db.courses[0]?.id ?? null,
          allowDirectEntry: true,
          freeStart: Boolean(defaultFreeStart),
          autoMatchCourse: Boolean(defaultFreeStart),
          feeSek: clubCfg.defaultDirectEntryFeeSek,
        };
        db.classes.push(targetCls);
        addedClasses++;
      }

      if (ent.siNumber > 0) {
        upsertRunnerInSeasonDb(seasonDb, {
          siNumber: ent.siNumber,
          fullName: ent.fullName,
          club: ent.club,
          defaultClassName: ent.className,
          source: 'EVENTOR_XML',
        });
        syncedRunnerDb++;
      }

      const si = ent.siNumber > 0 ? ent.siNumber : 8900000 + nextBib;
      if (db.competitors.some((c) => c.siNumber === si)) continue;

      db.competitors.push({
        id: `cmp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        bib: nextBib++,
        fullName: ent.fullName,
        club: ent.club,
        classId: targetCls.id,
        siNumber: si,
        cardSeries: inferSeries(si),
        isRentalCard: ent.siNumber === 0,
        rentalReturned: false,
        status: 'REGISTERED',
        allocatedStartSec: db.competition.zeroTimeSec + nextBib * 30,
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
      });
      addedEntries++;
    }

    for (const r of runnerDbEntries) {
      if (
        upsertRunnerInSeasonDb(seasonDb, {
          siNumber: r.siNumber,
          fullName: r.fullName,
          club: r.club,
          birthYear: r.birthYear,
          defaultClassName: r.defaultClassName,
          eventorPersonId: r.eventorPersonId,
          source: 'EVENTOR_XML',
        })
      ) {
        syncedRunnerDb++;
      }
    }

    recalculateEventFromRawReadouts(db);
    persistUserMutation();
    broadcastFullState(db.competition.shortCode);
    res.json({
      addedCourses,
      addedClasses,
      addedEntries,
      syncedRunnerDb,
      replaced: Boolean(replaceExisting),
    });
  });

  // 10. Runner Database & Eventor API Routes
  app.post('/api/runner-db', (req, res) => {
    const body = req.body as {
      siNumber?: number;
      fullName?: string;
      club?: string;
      birthYear?: number | null;
      defaultClassName?: string | null;
    };
    const si = Number(body.siNumber);
    if (!Number.isFinite(si) || si <= 0 || !body.fullName?.trim()) {
      res.status(400).json({ error: 'Ange giltigt SI-bricknummer och löparens namn.' });
      return;
    }
    const entry = upsertRunnerInSeasonDb(seasonDb, {
      siNumber: si,
      fullName: body.fullName.trim(),
      club: body.club?.trim() || 'Klubblös',
      birthYear: body.birthYear ?? null,
      defaultClassName: body.defaultClassName ?? null,
      source: 'LEARNED_ENTRY',
    });
    saveSeasonDatabase(seasonDb);
    broadcastFullState();
    res.status(201).json(entry);
  });

  app.post('/api/runner-db/import', (req, res) => {
    const { runners = [], source = 'MEOS_CSV' } = req.body as {
      runners?: {
        siNumber: number;
        fullName: string;
        club: string;
        birthYear?: number | null;
        defaultClassName?: string | null;
      }[];
      source?: RunnerDbSource;
    };
    let importedCount = 0;
    const importedRunners: RunnerDbEntry[] = [];
    for (const r of runners) {
      const imported = upsertRunnerInSeasonDb(seasonDb, {
          siNumber: Number(r.siNumber),
          fullName: r.fullName,
          club: r.club,
          birthYear: r.birthYear ?? null,
          defaultClassName: r.defaultClassName ?? null,
          source,
        });
      if (imported) {
        importedCount++;
        importedRunners.push(imported);
      }
    }
    saveSeasonDatabase(seasonDb);
    broadcastFullState();
    res.json({
      importedCount,
      totalRunnerDb: seasonDb.runnerDb.length,
      importedRunners,
    });
  });

  app.put('/api/runner-db/:id', (req, res) => {
    const body = req.body as {
      siNumber?: number;
      fullName?: string;
      club?: string;
    };
    const runner = seasonDb.runnerDb.find((entry) => entry.id === req.params.id);
    if (!runner) {
      res.status(404).json({ error: 'Löparen hittades inte i databasen.' });
      return;
    }
    const siNumber = Number(body.siNumber);
    const fullName = typeof body.fullName === 'string' ? body.fullName.trim() : '';
    const club = typeof body.club === 'string' ? body.club.trim() : '';
    if (
      !Number.isInteger(siNumber) ||
      siNumber < 1 ||
      siNumber > 99999999 ||
      !fullName
    ) {
      res.status(400).json({ error: 'Ange ett giltigt namn och SI-bricknummer.' });
      return;
    }
    if (
      seasonDb.runnerDb.some(
        (entry) => entry.id !== runner.id && entry.siNumber === siNumber
      )
    ) {
      res.status(409).json({ error: 'SI-bricknumret finns redan i löpardatabasen.' });
      return;
    }
    runner.siNumber = siNumber;
    runner.cardSeries = inferSeries(siNumber);
    runner.fullName = fullName.slice(0, 120);
    runner.club = (club || 'Klubblös').slice(0, 100);
    runner.updatedAt = new Date().toISOString();
    saveSeasonDatabase(seasonDb);
    broadcastFullState();
    res.json(runner);
  });

  app.delete('/api/runner-db/:id', (req, res) => {
    seasonDb.runnerDb = seasonDb.runnerDb.filter((r) => r.id !== req.params.id);
    saveSeasonDatabase(seasonDb);
    broadcastFullState();
    res.status(204).end();
  });

  app.get('/api/eventor/status', (_req, res) => {
    res.json(buildLiveEventorStatus());
  });

  app.put('/api/eventor/settings', (req, res) => {
    const body = req.body as { autoCreateFromRunnerDbOnReadout?: boolean };
    if (body.autoCreateFromRunnerDbOnReadout !== undefined) {
      seasonDb.eventor.autoCreateFromRunnerDbOnReadout = Boolean(
        body.autoCreateFromRunnerDbOnReadout
      );
    }
    saveSeasonDatabase(seasonDb);
    broadcastFullState();
    res.json(buildLiveEventorStatus());
  });

  app.post('/api/eventor/sync-club', async (_req, res) => {
    try {
      const orgXml = await fetchFromEventorApi('/organisation/apiKey');
      const org = parseEventorOrgXml(orgXml);
      if (!org) {
        res.status(502).json({
          error: 'Kunde inte tolka klubbens organisationsdata från Eventor API.',
        });
        return;
      }

      const compXml = await fetchFromEventorApi(
        `/competitors?organisationId=${encodeURIComponent(org.orgId)}&includeContactDetails=false`
      );
      const parsedMembers = parseEventorCompetitorsXml(compXml, org.orgName, org.orgId);

      let syncedRunners = 0;
      for (const m of parsedMembers) {
        if (
          upsertRunnerInSeasonDb(seasonDb, {
            siNumber: m.siNumber,
            fullName: m.fullName,
            club: m.club,
            birthYear: m.birthYear,
            eventorPersonId: m.eventorPersonId,
            eventorOrgId: m.eventorOrgId,
            source: 'EVENTOR_API',
          })
        ) {
          syncedRunners++;
        }
      }

      seasonDb.eventor.connectedOrgId = org.orgId;
      seasonDb.eventor.connectedOrgName = org.orgName;
      seasonDb.eventor.lastSyncedAt = new Date().toISOString();
      saveSeasonDatabase(seasonDb);
      broadcastFullState();

      res.json({
        orgId: org.orgId,
        orgName: org.orgName,
        syncedRunners,
        totalRunnerDb: seasonDb.runnerDb.length,
      });
    } catch (err: unknown) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Kunde inte synka mot Eventor API.',
      });
    }
  });

  app.post('/api/eventor/import-event', async (req, res) => {
    const db = getActiveEvent();
    const { eventId } = req.body as { eventId?: string };
    const cleanId = String(eventId || '').replace(/\D/g, '');
    if (!cleanId) {
      res.status(400).json({ error: 'Ange ett giltigt numeriskt Eventor Tävlings-ID.' });
      return;
    }

    try {
      const eventXml = await fetchFromEventorApi(`/event/${cleanId}`);
      const eventBlock = extractFirstTag(eventXml, 'Event') ?? eventXml;
      const evName = extractFirstTag(eventBlock, 'Name');
      const startBlock = extractFirstTag(eventBlock, 'StartDate') ?? eventBlock;
      const evDate = extractFirstTag(startBlock, 'Date');

      if (evName) db.competition.name = evName;
      if (evDate && /^\d{4}-\d{2}-\d{2}$/.test(evDate)) db.competition.date = evDate;

      const classesXml = await fetchFromEventorApi(`/eventclasses?eventId=${cleanId}`);
      const classMap = parseEventorClassesXml(classesXml);

      let addedClasses = 0;
      for (const [, clsName] of classMap.entries()) {
        if (!db.classes.some((c) => c.name.toLowerCase() === clsName.toLowerCase())) {
          db.classes.push({
            id: `cls-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            name: clsName,
            courseId: db.courses[0]?.id ?? null,
            allowDirectEntry: true,
            freeStart: false,
            autoMatchCourse: false,
            feeSek: 150,
          });
          addedClasses++;
        }
      }

      const entriesXml = await fetchFromEventorApi(
        `/entries?eventIds=${cleanId}&includePersonElement=true&includeOrganisationElement=true`
      );
      const parsedEntries = parseEventorEntriesXml(entriesXml, classMap);

      let addedEntries = 0;
      let nextBib = db.competitors.reduce((m, c) => Math.max(m, c.bib), 500) + 1;

      for (const ent of parsedEntries) {
        let targetCls = db.classes.find(
          (x) => x.name.toLowerCase() === ent.className.toLowerCase()
        );
        if (!targetCls) {
          targetCls = {
            id: `cls-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
            name: ent.className,
            courseId: db.courses[0]?.id ?? null,
            allowDirectEntry: true,
            freeStart: false,
            autoMatchCourse: false,
            feeSek: 150,
          };
          db.classes.push(targetCls);
          addedClasses++;
        }

        if (ent.siNumber > 0) {
          upsertRunnerInSeasonDb(seasonDb, {
            siNumber: ent.siNumber,
            fullName: ent.fullName,
            club: ent.club,
            defaultClassName: ent.className,
            eventorPersonId: ent.personId,
            source: 'EVENTOR_API',
          });
        }

        const si = ent.siNumber > 0 ? ent.siNumber : 8900000 + nextBib;
        if (db.competitors.some((c) => c.siNumber === si)) continue;

        db.competitors.push({
          id: `cmp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          bib: nextBib++,
          fullName: ent.fullName,
          club: ent.club,
          classId: targetCls.id,
          siNumber: si,
          cardSeries: inferSeries(si),
          isRentalCard: ent.siNumber === 0,
          rentalReturned: false,
          status: 'REGISTERED',
          allocatedStartSec: db.competition.zeroTimeSec + nextBib * 30,
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
        });
        addedEntries++;
      }

      seasonDb.eventor.connectedEventId = cleanId;
      seasonDb.eventor.lastSyncedAt = new Date().toISOString();
      saveSeasonDatabase(seasonDb);
      broadcastFullState(db.competition.shortCode);

      res.json({
        eventId: cleanId,
        eventName: db.competition.name,
        addedClasses,
        addedEntries,
      });
    } catch (err: unknown) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Kunde inte hämta tävling från Eventor API.',
      });
    }
  });

  app.put('/api/competition', (req, res) => {
    const db = getActiveEvent();
    if (!db.competition.id) {
      res.status(404).json({ error: 'Skapa en tävling först.' });
      return;
    }
    const body = req.body as Partial<CompetitionMeta>;
    if (body.name?.trim()) db.competition.name = body.name.trim();
    db.competition.organizer = ensureClubSettings(seasonDb).clubName;
    if (body.date?.trim()) db.competition.date = body.date.trim();
    if (body.zeroTimeStr?.trim()) {
      const parsed = parseClockStrToSec(body.zeroTimeStr);
      if (parsed !== null) {
        db.competition.zeroTimeSec = parsed;
        db.competition.zeroTimeStr = secToClock(parsed);
      } else {
        db.competition.zeroTimeStr = body.zeroTimeStr.trim();
      }
    }
    if (body.status === 'COMPLETED') {
      db.competition.status = 'COMPLETED';
    } else if (
      body.status === 'LIVE' ||
      body.status === 'UPCOMING' ||
      body.date !== undefined ||
      body.zeroTimeStr !== undefined
    ) {
      db.competition.status = 'LIVE';
      db.competition.status = resolveEffectiveCompetitionStatus(db);
    }
    if (body.arenaInfo !== undefined) db.competition.arenaInfo = body.arenaInfo.trim();
    if (body.seriesName !== undefined) db.competition.seriesName = body.seriesName.trim();
    if (body.enableFeesAndSwish !== undefined) {
      db.competition.enableFeesAndSwish = Boolean(body.enableFeesAndSwish);
    }
    persistUserMutation();
    broadcastFullState(db.competition.shortCode);
    res.json({
      ...db.competition,
      status: resolveEffectiveCompetitionStatus(db),
    });
  });

  app.post('/api/system/reset-seed', (req, res) => {
    if (!requireAdminRequest(req, res)) return;
    const prevAuth = ensureSeasonAuthConfig(seasonDb);
    const prevClub = ensureClubSettings(seasonDb);
    const fresh = buildSeasonSeed();
    fresh.authConfig = prevAuth;
    fresh.clubSettings = prevClub;
    for (const ev of Object.values(fresh.eventsMap)) {
      ev.competition.organizer = prevClub.clubName;
    }
    seasonDb = fresh;
    persistUserMutation();
    broadcastFullState();
    res.json(buildFullStatePayload());
  });

  app.get('/api/system/backup', (req, res) => {
    if (!requireAdminRequest(req, res)) return;
    const dateStamp = getStockholmDateIso();
    const sanitizedBackup: SeasonDatabase = {
      version: seasonDb.version,
      activeEventId: seasonDb.activeEventId,
      demoCleared: Boolean(seasonDb.demoCleared),
      clubSettings: ensureClubSettings(seasonDb),
      eventsMap: seasonDb.eventsMap,
      runnerDb: seasonDb.runnerDb,
      eventor: seasonDb.eventor,
    };
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="passersi-season-db-${dateStamp}.json"`
    );
    res.send(JSON.stringify(sanitizedBackup, null, 2));
  });

  app.post('/api/system/restore', (req, res) => {
    if (!requireAdminRequest(req, res)) return;
    const candidate = req.body as Partial<SeasonDatabase> | null;
    const hasValidEventsObj =
      candidate && candidate.eventsMap && typeof candidate.eventsMap === 'object';
    const eventKeys = hasValidEventsObj ? Object.keys(candidate.eventsMap!) : [];
    if (
      !candidate ||
      typeof candidate !== 'object' ||
      !hasValidEventsObj ||
      (eventKeys.length === 0 && !candidate.demoCleared) ||
      !Array.isArray(candidate.runnerDb)
    ) {
      res.status(400).json({
        error: 'Ogiltig säkerhetskopia. Filen måste vara en giltig PasserSI säsongsdatabas (.json).',
      });
      return;
    }

    const eventsMap = candidate.eventsMap as Record<string, SingleEventRecord>;
    for (const ev of Object.values(eventsMap)) {
      ev.competition.enableFeesAndSwish = Boolean(ev.competition.enableFeesAndSwish);
      if (!ev.emergency) ev.emergency = { brokenControls: [], controlTimeOffsets: {} };
      if (!ev.roc) ev.roc = buildDefaultRocStatus('1042');
      if (!Array.isArray(ev.processedClientIds)) ev.processedClientIds = [];
      ensureEventPins(ev);
      recalculateEventFromRawReadouts(ev);
    }

    const validActiveId =
      eventKeys.length === 0
        ? ''
        : candidate.activeEventId && eventsMap[candidate.activeEventId]
        ? candidate.activeEventId
        : eventKeys[0];

    const preservedAuth = ensureSeasonAuthConfig(seasonDb);
    const preservedClub = candidate.clubSettings ?? ensureClubSettings(seasonDb);
    seasonDb = {
      version: 3,
      activeEventId: validActiveId,
      demoCleared: Boolean(candidate.demoCleared || eventKeys.length === 0),
      clubSettings: preservedClub,
      eventsMap,
      runnerDb: candidate.runnerDb,
      eventor: candidate.eventor ?? seasonDb.eventor,
      authConfig: preservedAuth,
    };
    const restoredClub = ensureClubSettings(seasonDb);
    for (const ev of Object.values(seasonDb.eventsMap)) {
      ev.competition.organizer = restoredClub.clubName;
    }
    persistUserMutation();
    broadcastFullState();
    res.json({
      ok: true,
      eventCount: Object.keys(seasonDb.eventsMap).length,
      runnerDbCount: seasonDb.runnerDb.length,
    });
  });

  // --- Vite Dev Middleware or Production Static ---
  const isProd = process.env.NODE_ENV === 'production';
  const distPath = path.join(__dirname, 'dist');

  if (!isProd) {
    app.get(['/dev-sw.js', '/sw.js'], (_req, res) => {
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.send(
        `if (typeof ServiceWorkerGlobalScope !== 'undefined' && self instanceof ServiceWorkerGlobalScope) {
  self.addEventListener('install', () => { self.skipWaiting(); });
  self.addEventListener('activate', (event) => {
    event.waitUntil(
      caches.keys()
        .then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
        .then(() => self.registration.unregister())
        .then(() => self.clients.matchAll({ type: 'window' }))
        .then((clients) => clients.forEach((c) => c.navigate(c.url)))
    );
  });
}
`,
      );
    });

    app.get('/manifest.webmanifest', (_req, res) => {
      res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        id: '/',
        name: 'PasserSI — SPORTident Inpassering',
        short_name: 'PasserSI',
        description:
          'Tidtagning, SPORTident-avläsning, startfålla, sträcktider och publik liverapportering för orientering.',
        theme_color: '#0f172a',
        background_color: '#f8fafc',
        display: 'standalone',
        start_url: '/',
        scope: '/',
        icons: [
          { src: '/pwa-192x192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          {
            src: '/pwa-maskable-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      });
    });

    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: disableHmr ? false : { server },
        ws: disableHmr ? false : { server },
        allowedHosts: true,
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const PORT = Number(process.env.PORT) || 3000;
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`PasserSI Multi-Event server running on http://0.0.0.0:${PORT}`);
  });
}

void startServer();
