export type Sport = "mlb" | "wnba" | "cfb" | "nfl" | "nhl" | "fc";

export const SUPPORTED_SPORTS: {
  id: Sport;
  label: string;
  implemented: boolean;
}[] = [
  { id: "mlb", label: "MLB", implemented: true },
  { id: "wnba", label: "WNBA", implemented: true },
  { id: "cfb", label: "CFB", implemented: true },
  { id: "nfl", label: "NFL", implemented: false },
  { id: "nhl", label: "NHL", implemented: false },
  { id: "fc", label: "FC", implemented: false },
];

export interface RealUser {
  id: string; // e.g. "R37MWQgJ" — the userId every passes endpoint needs
  userName: string;
  avatarKey: string | null;
  isRealPro?: boolean;
  realProTier?: number | null;
}

export interface PassEntity {
  id: number; // player passes: player id; team passes: team id
  sport?: string;
  teamId?: number; // player passes only
  name?: string; // team passes only
  displayName?: string;
  avatar?: string;
  firstName?: string;
  lastName?: string;
  injuryStatus?: string;
  jersey?: number;
  backgroundColor?: string;
}

export interface BoosterInfo {
  level: number;
  baseRarity: number;
  rarityLabel: string;
  rarityColor: string;
  multiplier: string;
  isCardBoosted: boolean;
  progress: number;
  required: number;
  progressDisplay: string;
  progressQualifier: string;
  percentage: string;
}

export interface UserPass {
  id: number; // pass id — anchors userpassboostercards/...
  userId: string;
  sport: Sport | string;
  entityType: "player" | "team" | string;
  entityId: number;
  label: string;
  detail?: string;
  infoDetail?: string;
  cost?: number;
  seasonDisplay?: string;
  season?: number;
  serialNumber?: number;
  tier?: number;
  earned?: number;
  earnedDisplay?: string;
  boostValue?: string;
  boostValueDisplay?: string;
  boosterCardId?: number | null;
  boosterCardInfo?: { rarity?: string; statBoostKey?: string } | null;
  isCardBoosted?: boolean;
  primaryDisplay?: string | null;
  dayLabel?: string;
  createdAt?: string;
  isPrivate?: boolean;
  isActive?: boolean;
  canOffer?: boolean;
  entity: PassEntity;
  boostInfo: BoosterInfo;
}

export interface Team {
  id: number;
  sport?: string;
  key?: string | null;
  name: string;
  displayName?: string | null;
  avatar?: string | null;
  primaryColorReal?: string | null;
  secondaryColorReal?: string | null;
}

export interface Game {
  id: number;
  sport?: string;
  status?: string;
  day?: string;
  dateTime?: string;
  homeTeamId: number;
  awayTeamId: number;
  homeTeam: Team;
  awayTeam: Team;
  homeTeamScore?: number;
  awayTeamScore?: number;
  homeTeamRank?: number | null;
  awayTeamRank?: number | null;
  pointSpread?: number | null;
  overUnder?: number | null;
  boosterCount?: number;
  isClosed?: boolean;
  periodName?: string | null;
}

export interface BoosterStatInfo {
  statBoostKey: string;
  info: { label: string; boostValue: string }[];
  count: number;
}

export interface BoosterRarityGroup {
  label: string;
  multiplierDisplay: string;
  key: number;
  rarity: number;
  bgSource?: string | null;
  count: number;
  statBoostInfo: Record<string, { count: number; statBoostKey: string }>;
  statBoostKeyInfo: BoosterStatInfo[];
}

export interface BoosterInventory {
  rarityGroups: BoosterRarityGroup[];
  message?: string;
}

export interface SuggestedBooster {
  rarity: number;
  rarityLabel: string;
  multiplierDisplay: string;
  statLabel: string;
  boostValue: string;
  remainingCount: number;
}

export type PlayerRole = "pitcher" | "hitter" | "team";

export interface DashboardCard {
  pass: UserPass;
  game: Game | null;
  opponent: Team | null;
  role: PlayerRole;
  /** 0-100 projection of today's game quality (null for team passes). */
  score: number | null;
  /** True when roster-based (lineup not posted yet) rather than boxscore. */
  lineupTbd: boolean;
  suggestedBooster: SuggestedBooster | null;
}

export interface DashboardResponse {
  user: RealUser;
  sport: Sport;
  day: string;
  cards: DashboardCard[];
  totalOwned: number;
  projectedCount: number;
  suggestionsForSelf: boolean;
}
