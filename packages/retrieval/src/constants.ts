/** Word-similarity floor for fuzzy search. "lovve" still matches "love"; a unrelated string does not. */
export const TRIGRAM_WORD_SIMILARITY = 0.5;

/** pg_trgm needs three characters. Shorter text is not a fuzzy word. */
export const MIN_TRIGRAM_LENGTH = 3;

export const MAX_QUERY_CHARS = 300;
export const MAX_VARIANTS = 8;

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;
export const DEFAULT_RUNNERS_UP = 5;
export const MAX_RUNNERS_UP = 20;

/** Neighbours on either side of getContextAround. */
export const MAX_CONTEXT = 50;

export const MAX_PERIODS = 100;
export const MAX_STAT_DAYS = 10000;

export const STATEMENT_TIMEOUT_MS = 8000;

/** Reciprocal rank fusion constant. Rank 1 scores weight / (k + 1). */
export const RRF_K = 60;
export const DEFAULT_KEYWORD_WEIGHT = 1;
export const DEFAULT_VECTOR_WEIGHT = 1;

export const CACHE_TTL_SECONDS = 300;
