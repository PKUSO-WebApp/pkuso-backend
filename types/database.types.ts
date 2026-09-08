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
      announcements: {
        Row: {
          content: string | null
          created_at: string | null
          end_time: string
          id: string
          title: string
        }
        Insert: {
          content?: string | null
          created_at?: string | null
          end_time: string
          id?: string
          title: string
        }
        Update: {
          content?: string | null
          created_at?: string | null
          end_time?: string
          id?: string
          title?: string
        }
        Relationships: []
      }
      app_settings: {
        Row: {
          key: string
          updated_at: string
          value: string
        }
        Insert: {
          key: string
          updated_at?: string
          value: string
        }
        Update: {
          key?: string
          updated_at?: string
          value?: string
        }
        Relationships: []
      }
      attendances: {
        Row: {
          id: number
          rehearsal_id: number
          sign_in_time: string | null
          status: Database["public"]["Enums"]["attendanceStatus"] | null
          user_id: string
        }
        Insert: {
          id?: never
          rehearsal_id: number
          sign_in_time?: string | null
          status?: Database["public"]["Enums"]["attendanceStatus"] | null
          user_id: string
        }
        Update: {
          id?: never
          rehearsal_id?: number
          sign_in_time?: string | null
          status?: Database["public"]["Enums"]["attendanceStatus"] | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "attendances_rehearsal_id_fkey"
            columns: ["rehearsal_id"]
            isOneToOne: false
            referencedRelation: "rehearsals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "attendances_user_id_profiles_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "attendances_user_id_profiles_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles_roster"
            referencedColumns: ["id"]
          },
        ]
      }
      feedback: {
        Row: {
          content: string
          created_at: string
          id: string
        }
        Insert: {
          content: string
          created_at?: string
          id?: string
        }
        Update: {
          content?: string
          created_at?: string
          id?: string
        }
        Relationships: []
      }
      import_config: {
        Row: {
          field_mapping: Json
          id: number
          instrument_map: Json
          updated_at: string | null
          year: number
        }
        Insert: {
          field_mapping?: Json
          id?: number
          instrument_map?: Json
          updated_at?: string | null
          year?: number
        }
        Update: {
          field_mapping?: Json
          id?: number
          instrument_map?: Json
          updated_at?: string | null
          year?: number
        }
        Relationships: []
      }
      invitation_codes: {
        Row: {
          code: string
          created_at: string | null
          created_by: string | null
          expires_at: string | null
          id: string
          max_uses: number | null
          used_by: string[] | null
          used_count: number | null
        }
        Insert: {
          code: string
          created_at?: string | null
          created_by?: string | null
          expires_at?: string | null
          id?: string
          max_uses?: number | null
          used_by?: string[] | null
          used_count?: number | null
        }
        Update: {
          code?: string
          created_at?: string | null
          created_by?: string | null
          expires_at?: string | null
          id?: string
          max_uses?: number | null
          used_by?: string[] | null
          used_count?: number | null
        }
        Relationships: []
      }
      leave_requests: {
        Row: {
          attachment_url: string | null
          created_at: string
          id: string
          reason: string
          rehearsal_id: number
          reject_reason: string | null
          status: Database["public"]["Enums"]["leaveStatus"]
          target_status: Database["public"]["Enums"]["attendanceStatus"]
          updated_at: string
          user_id: string
        }
        Insert: {
          attachment_url?: string | null
          created_at?: string
          id?: string
          reason: string
          rehearsal_id: number
          reject_reason?: string | null
          status?: Database["public"]["Enums"]["leaveStatus"]
          target_status?: Database["public"]["Enums"]["attendanceStatus"]
          updated_at?: string
          user_id: string
        }
        Update: {
          attachment_url?: string | null
          created_at?: string
          id?: string
          reason?: string
          rehearsal_id?: number
          reject_reason?: string | null
          status?: Database["public"]["Enums"]["leaveStatus"]
          target_status?: Database["public"]["Enums"]["attendanceStatus"]
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "leave_requests_rehearsal_id_fkey"
            columns: ["rehearsal_id"]
            isOneToOne: false
            referencedRelation: "rehearsals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leave_requests_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leave_requests_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles_roster"
            referencedColumns: ["id"]
          },
        ]
      }
      member_info: {
        Row: {
          college: string | null
          created_at: string | null
          email: string | null
          full_name: string
          grade: string | null
          id: string
          instrument_code: number | null
          instrument_name: string | null
        }
        Insert: {
          college?: string | null
          created_at?: string | null
          email?: string | null
          full_name: string
          grade?: string | null
          id?: string
          instrument_code?: number | null
          instrument_name?: string | null
        }
        Update: {
          college?: string | null
          created_at?: string | null
          email?: string | null
          full_name?: string
          grade?: string | null
          id?: string
          instrument_code?: number | null
          instrument_name?: string | null
        }
        Relationships: []
      }
      notifications: {
        Row: {
          category: Database["public"]["Enums"]["notificationCategory"]
          content: string
          created_at: string
          id: string
          read_at: string | null
          title: string
          user_id: string
        }
        Insert: {
          category: Database["public"]["Enums"]["notificationCategory"]
          content: string
          created_at?: string
          id?: string
          read_at?: string | null
          title: string
          user_id: string
        }
        Update: {
          category?: Database["public"]["Enums"]["notificationCategory"]
          content?: string
          created_at?: string
          id?: string
          read_at?: string | null
          title?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "notifications_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notifications_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles_roster"
            referencedColumns: ["id"]
          },
        ]
      }
      posts: {
        Row: {
          author_id: string
          contact_info: string | null
          content: string | null
          created_at: string | null
          current_sections: string | null
          id: string
          image_url: string | null
          is_locked: boolean
          locked_by: string | null
          missing_sections: string | null
          title: string
          type: Database["public"]["Enums"]["postType"]
        }
        Insert: {
          author_id: string
          contact_info?: string | null
          content?: string | null
          created_at?: string | null
          current_sections?: string | null
          id?: string
          image_url?: string | null
          is_locked?: boolean
          locked_by?: string | null
          missing_sections?: string | null
          title: string
          type?: Database["public"]["Enums"]["postType"]
        }
        Update: {
          author_id?: string
          contact_info?: string | null
          content?: string | null
          created_at?: string | null
          current_sections?: string | null
          id?: string
          image_url?: string | null
          is_locked?: boolean
          locked_by?: string | null
          missing_sections?: string | null
          title?: string
          type?: Database["public"]["Enums"]["postType"]
        }
        Relationships: [
          {
            foreignKeyName: "posts_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "posts_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "profiles_roster"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          avatar_url: string | null
          college: string | null
          created_at: string | null
          email: string | null
          full_name: string | null
          hide_college: boolean
          hide_email: boolean
          hide_join_date: boolean
          hide_phone: boolean
          id: string
          instrument: string | null
          is_in_orchestra: boolean | null
          is_section_leader: boolean
          join_date: string | null
          phone_number: string | null
          role: Database["public"]["Enums"]["profileRole"] | null
          session_started_at: string | null
          session_token: string | null
          status: Database["public"]["Enums"]["profileStatus"] | null
          wechat_openid: string | null
        }
        Insert: {
          avatar_url?: string | null
          college?: string | null
          created_at?: string | null
          email?: string | null
          full_name?: string | null
          hide_college?: boolean
          hide_email?: boolean
          hide_join_date?: boolean
          hide_phone?: boolean
          id: string
          instrument?: string | null
          is_in_orchestra?: boolean | null
          is_section_leader?: boolean
          join_date?: string | null
          phone_number?: string | null
          role?: Database["public"]["Enums"]["profileRole"] | null
          session_started_at?: string | null
          session_token?: string | null
          status?: Database["public"]["Enums"]["profileStatus"] | null
          wechat_openid?: string | null
        }
        Update: {
          avatar_url?: string | null
          college?: string | null
          created_at?: string | null
          email?: string | null
          full_name?: string | null
          hide_college?: boolean
          hide_email?: boolean
          hide_join_date?: boolean
          hide_phone?: boolean
          id?: string
          instrument?: string | null
          is_in_orchestra?: boolean | null
          is_section_leader?: boolean
          join_date?: string | null
          phone_number?: string | null
          role?: Database["public"]["Enums"]["profileRole"] | null
          session_started_at?: string | null
          session_token?: string | null
          status?: Database["public"]["Enums"]["profileStatus"] | null
          wechat_openid?: string | null
        }
        Relationships: []
      }
      rehearsals: {
        Row: {
          checkin_lat: number | null
          checkin_lng: number | null
          checkin_radius_m: number | null
          created_at: string | null
          date: string | null
          end_time: string | null
          id: number
          location: string | null
          repertoire: string | null
          sign_in_code: string | null
          start_time: string | null
          target_section: string | null
          time: string | null
          title: string | null
          type: string | null
          updated_at: string
          updated_fields: string | null
        }
        Insert: {
          checkin_lat?: number | null
          checkin_lng?: number | null
          checkin_radius_m?: number | null
          created_at?: string | null
          date?: string | null
          end_time?: string | null
          id?: never
          location?: string | null
          repertoire?: string | null
          sign_in_code?: string | null
          start_time?: string | null
          target_section?: string | null
          time?: string | null
          title?: string | null
          type?: string | null
          updated_at?: string
          updated_fields?: string | null
        }
        Update: {
          checkin_lat?: number | null
          checkin_lng?: number | null
          checkin_radius_m?: number | null
          created_at?: string | null
          date?: string | null
          end_time?: string | null
          id?: never
          location?: string | null
          repertoire?: string | null
          sign_in_code?: string | null
          start_time?: string | null
          target_section?: string | null
          time?: string | null
          title?: string | null
          type?: string | null
          updated_at?: string
          updated_fields?: string | null
        }
        Relationships: []
      }
      schedule_groups: {
        Row: {
          author_id: string | null
          created_at: string | null
          id: string
          monthly_day: number | null
          monthly_end_month: number | null
          monthly_end_year: number | null
          monthly_start_month: number | null
          monthly_start_year: number | null
          repeat_mode: string
          title: string
          updated_at: string | null
          weekly_day: number | null
          weekly_end_date: string | null
          weekly_end_month: number | null
          weekly_end_week: number | null
          weekly_end_year: number | null
          weekly_start_date: string | null
          weekly_start_month: number | null
          weekly_start_week: number | null
          weekly_start_year: number | null
        }
        Insert: {
          author_id?: string | null
          created_at?: string | null
          id?: string
          monthly_day?: number | null
          monthly_end_month?: number | null
          monthly_end_year?: number | null
          monthly_start_month?: number | null
          monthly_start_year?: number | null
          repeat_mode: string
          title: string
          updated_at?: string | null
          weekly_day?: number | null
          weekly_end_date?: string | null
          weekly_end_month?: number | null
          weekly_end_week?: number | null
          weekly_end_year?: number | null
          weekly_start_date?: string | null
          weekly_start_month?: number | null
          weekly_start_week?: number | null
          weekly_start_year?: number | null
        }
        Update: {
          author_id?: string | null
          created_at?: string | null
          id?: string
          monthly_day?: number | null
          monthly_end_month?: number | null
          monthly_end_year?: number | null
          monthly_start_month?: number | null
          monthly_start_year?: number | null
          repeat_mode?: string
          title?: string
          updated_at?: string | null
          weekly_day?: number | null
          weekly_end_date?: string | null
          weekly_end_month?: number | null
          weekly_end_week?: number | null
          weekly_end_year?: number | null
          weekly_start_date?: string | null
          weekly_start_month?: number | null
          weekly_start_week?: number | null
          weekly_start_year?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "schedule_groups_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "schedule_groups_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "profiles_roster"
            referencedColumns: ["id"]
          },
        ]
      }
      schedules: {
        Row: {
          author_id: string | null
          created_at: string | null
          end_time: string | null
          group_id: string | null
          id: number
          rehearsal_id: number | null
          start_time: string
          title: string | null
        }
        Insert: {
          author_id?: string | null
          created_at?: string | null
          end_time?: string | null
          group_id?: string | null
          id?: never
          rehearsal_id?: number | null
          start_time: string
          title?: string | null
        }
        Update: {
          author_id?: string | null
          created_at?: string | null
          end_time?: string | null
          group_id?: string | null
          id?: never
          rehearsal_id?: number | null
          start_time?: string
          title?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "schedules_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "schedules_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "profiles_roster"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "schedules_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "schedule_groups"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "schedules_rehearsal_id_fkey"
            columns: ["rehearsal_id"]
            isOneToOne: false
            referencedRelation: "rehearsals"
            referencedColumns: ["id"]
          },
        ]
      }
      system_notifications: {
        Row: {
          content: string
          created_at: string
          id: string
          publisher_id: string | null
          title: string
        }
        Insert: {
          content: string
          created_at?: string
          id?: string
          publisher_id?: string | null
          title: string
        }
        Update: {
          content?: string
          created_at?: string
          id?: string
          publisher_id?: string | null
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "system_notifications_publisher_id_fkey"
            columns: ["publisher_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "system_notifications_publisher_id_fkey"
            columns: ["publisher_id"]
            isOneToOne: false
            referencedRelation: "profiles_roster"
            referencedColumns: ["id"]
          },
        ]
      }
      verification_codes: {
        Row: {
          code: string
          created_at: string | null
          expires_at: string
          id: number
          purpose: string
          target_email: string
          used: boolean | null
          user_id: string
        }
        Insert: {
          code: string
          created_at?: string | null
          expires_at: string
          id?: never
          purpose: string
          target_email: string
          used?: boolean | null
          user_id: string
        }
        Update: {
          code?: string
          created_at?: string | null
          expires_at?: string
          id?: never
          purpose?: string
          target_email?: string
          used?: boolean | null
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      profiles_roster: {
        Row: {
          avatar_url: string | null
          college: string | null
          created_at: string | null
          email: string | null
          full_name: string | null
          hide_college: boolean | null
          hide_email: boolean | null
          hide_join_date: boolean | null
          hide_phone: boolean | null
          id: string | null
          instrument: string | null
          is_in_orchestra: boolean | null
          is_section_leader: boolean | null
          join_date: string | null
          phone_number: string | null
          role: Database["public"]["Enums"]["profileRole"] | null
          status: Database["public"]["Enums"]["profileStatus"] | null
        }
        Insert: {
          avatar_url?: string | null
          college?: never
          created_at?: string | null
          email?: never
          full_name?: string | null
          hide_college?: boolean | null
          hide_email?: boolean | null
          hide_join_date?: boolean | null
          hide_phone?: boolean | null
          id?: string | null
          instrument?: string | null
          is_in_orchestra?: boolean | null
          is_section_leader?: boolean | null
          join_date?: string | null
          phone_number?: never
          role?: Database["public"]["Enums"]["profileRole"] | null
          status?: Database["public"]["Enums"]["profileStatus"] | null
        }
        Update: {
          avatar_url?: string | null
          college?: never
          created_at?: string | null
          email?: never
          full_name?: string | null
          hide_college?: boolean | null
          hide_email?: boolean | null
          hide_join_date?: boolean | null
          hide_phone?: boolean | null
          id?: string | null
          instrument?: string | null
          is_in_orchestra?: boolean | null
          is_section_leader?: boolean | null
          join_date?: string | null
          phone_number?: never
          role?: Database["public"]["Enums"]["profileRole"] | null
          status?: Database["public"]["Enums"]["profileStatus"] | null
        }
        Relationships: []
      }
    }
    Functions: {
      cancel_leave_on_sign_in: {
        Args: { p_rehearsal_id: number }
        Returns: {
          attachment_path: string
          previous_status: Database["public"]["Enums"]["leaveStatus"]
          request_id: string
          status: Database["public"]["Enums"]["leaveStatus"]
        }[]
      }
      check_data_versions: { Args: never; Returns: Json }
      check_email_taken: {
        Args: { p_email: string; p_exclude_user_id: string }
        Returns: boolean
      }
      check_invitation_code: {
        Args: { p_code: string }
        Returns: {
          code: string
          expires_at: string
          id: string
          max_uses: number
          used_count: number
        }[]
      }
      get_my_profile_entry: {
        Args: never
        Returns: {
          email: string
          full_name: string
          status: Database["public"]["Enums"]["profileStatus"]
        }[]
      }
      get_my_session: {
        Args: never
        Returns: {
          session_started_at: string
          session_token: string
        }[]
      }
      is_admin: { Args: never; Returns: boolean }
      sign_in_attendance_location: {
        Args: {
          p_accuracy?: number
          p_lat: number
          p_lng: number
          p_rehearsal_id: number
        }
        Returns: {
          id: number
          rehearsal_id: number
          sign_in_time: string
          status: Database["public"]["Enums"]["attendanceStatus"]
          user_id: string
        }[]
      }
      touch_session: {
        Args: never
        Returns: {
          session_started_at: string
          session_token: string
        }[]
      }
      verify_and_use_invitation_code: {
        Args: { p_code: string; p_user_id: string }
        Returns: {
          code: string
          expires_at: string
          id: string
          used_by: string[]
          used_count: number
        }[]
      }
    }
    Enums: {
      attendanceStatus: "present" | "late" | "absent" | "excused"
      leaveStatus:
        | "pending"
        | "approved"
        | "rejected"
        | "withdrawn"
        | "canceled"
      notificationCategory: "attendance" | "activity" | "system"
      postType: "ensemble" | "gathering"
      profileRole: "member" | "admin"
      profileStatus: "pending" | "approved" | "rejected"
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
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
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      attendanceStatus: ["present", "late", "absent", "excused"],
      leaveStatus: ["pending", "approved", "rejected", "withdrawn", "canceled"],
      notificationCategory: ["attendance", "activity", "system"],
      postType: ["ensemble", "gathering"],
      profileRole: ["member", "admin"],
      profileStatus: ["pending", "approved", "rejected"],
    },
  },
} as const
