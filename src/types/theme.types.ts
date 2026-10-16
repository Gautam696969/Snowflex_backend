export interface UserTheme {
  id?: number
  userId: number
  mode?: 'light' | 'dark' | null
  bgColor?: string | null
  primaryColor?: string | null
  accentColor?: string | null
  sidebarColor?: string | null
  cardColor?: string | null
  textColor?: string | null
  updatedBy?: number | null
  createdAt?: string
  updatedAt?: string
}

export interface SetThemeInput {
  mode?: 'light' | 'dark' | null
  bgColor?: string | null
  primaryColor?: string | null
  accentColor?: string | null
  sidebarColor?: string | null
  cardColor?: string | null
  textColor?: string | null
}

export interface BulkSetThemeInput extends SetThemeInput {
  role: string
}
