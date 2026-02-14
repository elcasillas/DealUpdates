-- Migration: Add canonical identity, notes hash columns, and summary cache table
-- Purpose: Persist deal_key and notes hashes so AI summary caching works across sessions

-- Add canonical identity and notes hash columns to deals
ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS deal_key       TEXT,
  ADD COLUMN IF NOT EXISTS notes_canonical TEXT,
  ADD COLUMN IF NOT EXISTS notes_hash     TEXT,
  ADD COLUMN IF NOT EXISTS notes_count    INTEGER DEFAULT 0;

-- Index deal_key for fast lookups
CREATE INDEX IF NOT EXISTS idx_deals_deal_key ON deals (deal_key);

-- Index notes_hash for cache joins
CREATE INDEX IF NOT EXISTS idx_deals_notes_hash ON deals (notes_hash);

-- Persistent AI summary cache
CREATE TABLE IF NOT EXISTS deal_summary_cache (
  deal_key   TEXT        NOT NULL,
  notes_hash TEXT        NOT NULL,
  model      TEXT        NOT NULL DEFAULT 'haiku',
  summary    TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (deal_key, notes_hash, model)
);

-- Index for cache lookups by hash
CREATE INDEX IF NOT EXISTS idx_summary_cache_hash ON deal_summary_cache (notes_hash);
