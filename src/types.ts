export interface Adventure {
  id: string;
  name: string;
  gm_password: string;
  player_link: string;
  active_image_id: string | null;
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
  player_session_id: string | null;
  created_at: string;
}
