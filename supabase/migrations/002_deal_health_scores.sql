-- Migration: Add health score persistence columns to deals + scoring config to uploads
-- Purpose: Store computed health scores alongside deal data for historical tracking

-- =====================================================
-- deals table: health score output columns
-- =====================================================

-- Overall composite score (0-100)
ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS health_score SMALLINT;

-- Component scores (each 0-100, individual columns for queryability)
ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS hs_stage_probability SMALLINT,
  ADD COLUMN IF NOT EXISTS hs_velocity          SMALLINT,
  ADD COLUMN IF NOT EXISTS hs_activity_recency  SMALLINT,
  ADD COLUMN IF NOT EXISTS hs_close_date        SMALLINT,
  ADD COLUMN IF NOT EXISTS hs_acv              SMALLINT,
  ADD COLUMN IF NOT EXISTS hs_notes_signal     SMALLINT;

-- Debug metadata (variable structure, stored as JSONB)
ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS health_debug JSONB;

-- =====================================================
-- uploads table: scoring config snapshot
-- =====================================================

-- The full scoring config (weights, stageScoreMap, keywords) used for this upload
ALTER TABLE uploads
  ADD COLUMN IF NOT EXISTS scoring_config JSONB;

-- =====================================================
-- Indexes
-- =====================================================

-- Filter/sort by health score
CREATE INDEX IF NOT EXISTS idx_deals_health_score ON deals (health_score);

-- Health history queries: score progression for a deal across uploads
CREATE INDEX IF NOT EXISTS idx_deals_health_history ON deals (deal_key, health_score);
