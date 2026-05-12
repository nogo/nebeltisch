export interface FogMask {
  width: number;
  height: number;
  data: Uint8Array; // length = width * height, values 0-255
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
  created_at: string;
}

export interface Token {
  id: string;
  adventure_id: string;
  name: string;
  color: string;
  x: number;
  y: number;
  player_link: string | null;
  token_type: 'player' | 'monster' | 'npc';
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
