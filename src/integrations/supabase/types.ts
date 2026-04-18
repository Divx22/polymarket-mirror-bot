export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      config: {
        Row: {
          auto_execute: boolean
          created_at: string
          daily_usdc_limit: number
          enabled: boolean
          id: string
          last_polled_at: string | null
          last_seen_ts: number
          max_usdc_per_trade: number
          mirror_mode: string
          mirror_ratio: number
          reconcile_interval_min: number
          signal_threshold_usdc: number
          spent_day: string
          target_wallet: string | null
          updated_at: string
          usdc_spent_today: number
          user_id: string
        }
        Insert: {
          auto_execute?: boolean
          created_at?: string
          daily_usdc_limit?: number
          enabled?: boolean
          id?: string
          last_polled_at?: string | null
          last_seen_ts?: number
          max_usdc_per_trade?: number
          mirror_mode?: string
          mirror_ratio?: number
          reconcile_interval_min?: number
          signal_threshold_usdc?: number
          spent_day?: string
          target_wallet?: string | null
          updated_at?: string
          usdc_spent_today?: number
          user_id: string
        }
        Update: {
          auto_execute?: boolean
          created_at?: string
          daily_usdc_limit?: number
          enabled?: boolean
          id?: string
          last_polled_at?: string | null
          last_seen_ts?: number
          max_usdc_per_trade?: number
          mirror_mode?: string
          mirror_ratio?: number
          reconcile_interval_min?: number
          signal_threshold_usdc?: number
          spent_day?: string
          target_wallet?: string | null
          updated_at?: string
          usdc_spent_today?: number
          user_id?: string
        }
        Relationships: []
      }
      detected_trades: {
        Row: {
          asset_id: string
          created_at: string
          id: string
          is_partial_fill: boolean | null
          market_id: string | null
          market_question: string | null
          order_id: string | null
          order_original_size: number | null
          order_original_usdc: number | null
          outcome: string | null
          price: number | null
          raw: Json | null
          side: string
          size: number | null
          trade_ts: number
          tx_hash: string
          usdc_size: number | null
          user_id: string
        }
        Insert: {
          asset_id: string
          created_at?: string
          id?: string
          is_partial_fill?: boolean | null
          market_id?: string | null
          market_question?: string | null
          order_id?: string | null
          order_original_size?: number | null
          order_original_usdc?: number | null
          outcome?: string | null
          price?: number | null
          raw?: Json | null
          side: string
          size?: number | null
          trade_ts: number
          tx_hash: string
          usdc_size?: number | null
          user_id: string
        }
        Update: {
          asset_id?: string
          created_at?: string
          id?: string
          is_partial_fill?: boolean | null
          market_id?: string | null
          market_question?: string | null
          order_id?: string | null
          order_original_size?: number | null
          order_original_usdc?: number | null
          outcome?: string | null
          price?: number | null
          raw?: Json | null
          side?: string
          size?: number | null
          trade_ts?: number
          tx_hash?: string
          usdc_size?: number | null
          user_id?: string
        }
        Relationships: []
      }
      markets_cache: {
        Row: {
          asset_id: string
          cached_at: string
          data: Json | null
          market_id: string | null
          outcome: string | null
          question: string | null
        }
        Insert: {
          asset_id: string
          cached_at?: string
          data?: Json | null
          market_id?: string | null
          outcome?: string | null
          question?: string | null
        }
        Update: {
          asset_id?: string
          cached_at?: string
          data?: Json | null
          market_id?: string | null
          outcome?: string | null
          question?: string | null
        }
        Relationships: []
      }
      mm_config: {
        Row: {
          created_at: string
          default_max_inventory_usdc: number
          default_min_existing_spread_ticks: number
          default_size_usdc: number
          default_spread_offset_ticks: number
          enabled: boolean
          id: string
          min_days_to_expiry: number
          quote_mode: string
          total_capital_cap_usdc: number
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          default_max_inventory_usdc?: number
          default_min_existing_spread_ticks?: number
          default_size_usdc?: number
          default_spread_offset_ticks?: number
          enabled?: boolean
          id?: string
          min_days_to_expiry?: number
          quote_mode?: string
          total_capital_cap_usdc?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          default_max_inventory_usdc?: number
          default_min_existing_spread_ticks?: number
          default_size_usdc?: number
          default_spread_offset_ticks?: number
          enabled?: boolean
          id?: string
          min_days_to_expiry?: number
          quote_mode?: string
          total_capital_cap_usdc?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      mm_cycles: {
        Row: {
          fills_detected: number
          id: string
          markets_processed: number
          notes: Json | null
          orders_cancelled: number
          orders_placed: number
          ran_at: string
          total_capital_at_risk_usdc: number
          user_id: string
        }
        Insert: {
          fills_detected?: number
          id?: string
          markets_processed?: number
          notes?: Json | null
          orders_cancelled?: number
          orders_placed?: number
          ran_at?: string
          total_capital_at_risk_usdc?: number
          user_id: string
        }
        Update: {
          fills_detected?: number
          id?: string
          markets_processed?: number
          notes?: Json | null
          orders_cancelled?: number
          orders_placed?: number
          ran_at?: string
          total_capital_at_risk_usdc?: number
          user_id?: string
        }
        Relationships: []
      }
      mm_fills: {
        Row: {
          asset_id: string
          filled_at: string
          id: string
          market_question: string | null
          outcome: string | null
          poly_order_id: string | null
          price: number
          shares: number
          side: string
          usdc_value: number
          user_id: string
        }
        Insert: {
          asset_id: string
          filled_at?: string
          id?: string
          market_question?: string | null
          outcome?: string | null
          poly_order_id?: string | null
          price: number
          shares: number
          side: string
          usdc_value: number
          user_id: string
        }
        Update: {
          asset_id?: string
          filled_at?: string
          id?: string
          market_question?: string | null
          outcome?: string | null
          poly_order_id?: string | null
          price?: number
          shares?: number
          side?: string
          usdc_value?: number
          user_id?: string
        }
        Relationships: []
      }
      mm_markets: {
        Row: {
          active: boolean
          asset_id: string
          condition_id: string | null
          created_at: string
          end_date: string | null
          id: string
          inventory_avg_price: number
          inventory_shares: number
          last_ask_price: number | null
          last_bid_price: number | null
          last_book_best_ask: number | null
          last_book_best_bid: number | null
          last_cycle_at: string | null
          last_error: string | null
          market_question: string | null
          max_inventory_usdc_override: number | null
          outcome: string | null
          size_usdc_override: number | null
          spread_captured_usdc: number
          spread_offset_ticks_override: number | null
          updated_at: string
          user_id: string
        }
        Insert: {
          active?: boolean
          asset_id: string
          condition_id?: string | null
          created_at?: string
          end_date?: string | null
          id?: string
          inventory_avg_price?: number
          inventory_shares?: number
          last_ask_price?: number | null
          last_bid_price?: number | null
          last_book_best_ask?: number | null
          last_book_best_bid?: number | null
          last_cycle_at?: string | null
          last_error?: string | null
          market_question?: string | null
          max_inventory_usdc_override?: number | null
          outcome?: string | null
          size_usdc_override?: number | null
          spread_captured_usdc?: number
          spread_offset_ticks_override?: number | null
          updated_at?: string
          user_id: string
        }
        Update: {
          active?: boolean
          asset_id?: string
          condition_id?: string | null
          created_at?: string
          end_date?: string | null
          id?: string
          inventory_avg_price?: number
          inventory_shares?: number
          last_ask_price?: number | null
          last_bid_price?: number | null
          last_book_best_ask?: number | null
          last_book_best_bid?: number | null
          last_cycle_at?: string | null
          last_error?: string | null
          market_question?: string | null
          max_inventory_usdc_override?: number | null
          outcome?: string | null
          size_usdc_override?: number | null
          spread_captured_usdc?: number
          spread_offset_ticks_override?: number | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      mm_open_orders: {
        Row: {
          asset_id: string
          created_at: string
          id: string
          poly_order_id: string
          price: number
          side: string
          size: number
          user_id: string
        }
        Insert: {
          asset_id: string
          created_at?: string
          id?: string
          poly_order_id: string
          price: number
          side: string
          size: number
          user_id: string
        }
        Update: {
          asset_id?: string
          created_at?: string
          id?: string
          poly_order_id?: string
          price?: number
          side?: string
          size?: number
          user_id?: string
        }
        Relationships: []
      }
      paper_orders: {
        Row: {
          asset_id: string
          created_at: string
          detected_trade_id: string | null
          error: string | null
          executed_at: string | null
          executed_tx_hash: string | null
          id: string
          intended_price: number | null
          intended_size: number | null
          intended_usdc: number | null
          market_id: string | null
          market_question: string | null
          note: string | null
          outcome: string | null
          side: string
          status: string
          user_id: string
        }
        Insert: {
          asset_id: string
          created_at?: string
          detected_trade_id?: string | null
          error?: string | null
          executed_at?: string | null
          executed_tx_hash?: string | null
          id?: string
          intended_price?: number | null
          intended_size?: number | null
          intended_usdc?: number | null
          market_id?: string | null
          market_question?: string | null
          note?: string | null
          outcome?: string | null
          side: string
          status?: string
          user_id: string
        }
        Update: {
          asset_id?: string
          created_at?: string
          detected_trade_id?: string | null
          error?: string | null
          executed_at?: string | null
          executed_tx_hash?: string | null
          id?: string
          intended_price?: number | null
          intended_size?: number | null
          intended_usdc?: number | null
          market_id?: string | null
          market_question?: string | null
          note?: string | null
          outcome?: string | null
          side?: string
          status?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "paper_orders_detected_trade_id_fkey"
            columns: ["detected_trade_id"]
            isOneToOne: false
            referencedRelation: "detected_trades"
            referencedColumns: ["id"]
          },
        ]
      }
      poly_credentials: {
        Row: {
          api_key: string
          api_passphrase: string
          api_secret: string
          created_at: string
          id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          api_key: string
          api_passphrase: string
          api_secret: string
          created_at?: string
          id?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          api_key?: string
          api_passphrase?: string
          api_secret?: string
          created_at?: string
          id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      positions: {
        Row: {
          asset_id: string
          created_at: string
          id: string
          last_reconciled_at: string | null
          last_target_price: number | null
          market_id: string | null
          market_question: string | null
          mirror_shares: number
          outcome: string | null
          target_shares: number
          updated_at: string
          user_id: string
        }
        Insert: {
          asset_id: string
          created_at?: string
          id?: string
          last_reconciled_at?: string | null
          last_target_price?: number | null
          market_id?: string | null
          market_question?: string | null
          mirror_shares?: number
          outcome?: string | null
          target_shares?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          asset_id?: string
          created_at?: string
          id?: string
          last_reconciled_at?: string | null
          last_target_price?: number | null
          market_id?: string | null
          market_question?: string | null
          mirror_shares?: number
          outcome?: string | null
          target_shares?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          created_at: string
          display_name: string | null
          id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          display_name?: string | null
          id?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          display_name?: string | null
          id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
