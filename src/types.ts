export interface FogMask {
  width: number;
  height: number;
  /**
   * Length = width * height, values 0-255.
   * Pinned to `ArrayBuffer` rather than `ArrayBufferLike`: masks are handed straight to
   * `Bun.deflateSync`, which does not accept a `SharedArrayBuffer` view.
   */
  data: Uint8Array<ArrayBuffer>;
}

export interface FogStroke {
  x: number;       // center x in image coordinates
  y: number;       // center y in image coordinates
  radius: number;  // brush radius in pixels
  mode: 'reveal' | 'fog';
}

export interface Adventure {
  id: string;
  name: string;
  gm_password: string;
  player_link: string;
  active_image_id: string | null;
  token_size: number;
  created_at: string;
}

export interface ImageRecord {
  id: string;
  adventure_id: string;
  filename: string;
  original_name: string;
  width: number;
  height: number;
  fog_mask: Buffer | null;
  sort_order: number;
  start_x: number | null;
  start_y: number | null;
  /** 1 once the GM has locked the start point in place, so a stray drag cannot move it. */
  start_locked: number;
  /** Where the page sits on the adventure's board. Null only until the migration backfills it. */
  board_x: number | null;
  board_y: number | null;
  created_at: string;
}

/**
 * The coarsest account of a fight: standing, down, or gone. Text rather than a boolean pair
 * because additive migrations may not retype a column later, and three values are not two.
 */
export type TokenState = 'alive' | 'unconscious' | 'dead';

export interface Token {
  id: string;
  adventure_id: string;
  name: string;
  color: string;
  x: number;
  y: number;
  player_link: string | null;
  token_type: 'player' | 'monster' | 'npc';
  state: TokenState;
  image_id: string | null;
  created_at: string;
}

export interface WsData {
  adventureId: string;
  role: "gm" | "player";
  playerName?: string;
  playerColor?: string;
  tokenId?: string;
  playerLink?: string;
  tokenIsNew?: boolean;
}
