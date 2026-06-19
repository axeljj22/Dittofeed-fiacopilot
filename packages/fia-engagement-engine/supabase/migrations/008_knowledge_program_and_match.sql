-- Knowledge retrieval upgrade: program scoping + semantic match RPC.
-- Sofía answers questions by retrieving the most RELEVANT knowledge (semantic, pgvector)
-- instead of dumping the top-priority rows. Embeddings already exist on knowledge_base
-- (1536-dim, OpenAI text-embedding-3-small); this wires the query side.

-- 1. Optional program association (NULL = global knowledge, applies to everyone).
--    FC populates this when loading program-specific curriculum.
ALTER TABLE knowledge_base ADD COLUMN IF NOT EXISTS program_slug TEXT;
CREATE INDEX IF NOT EXISTS idx_knowledge_base_program_slug ON knowledge_base(program_slug);

-- 2. Semantic match: cosine similarity over the question embedding, scoped to global +
--    the user's program(s). Returns full content so Sofía can ground a real answer.
CREATE OR REPLACE FUNCTION match_knowledge(
  query_embedding vector(1536),
  match_count int DEFAULT 6,
  filter_programs text[] DEFAULT NULL
) RETURNS TABLE (
  slug text, category text, title text, summary text, content text,
  voice_notes text, tags text[], priority int, program_slug text, similarity float
) LANGUAGE sql STABLE AS $$
  SELECT slug, category, title, summary, content, voice_notes, tags, priority, program_slug,
         1 - (embedding <=> query_embedding) AS similarity
  FROM knowledge_base
  WHERE status IN ('active', 'published', 'live')
    AND embedding IS NOT NULL
    AND (filter_programs IS NULL OR program_slug IS NULL OR program_slug = ANY(filter_programs))
  ORDER BY embedding <=> query_embedding
  LIMIT match_count;
$$;

-- 3. ANN index for scale (cosine). Safe no-op cost at current row counts.
CREATE INDEX IF NOT EXISTS idx_knowledge_base_embedding_hnsw
  ON knowledge_base USING hnsw (embedding vector_cosine_ops);
