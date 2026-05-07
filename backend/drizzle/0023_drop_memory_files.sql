-- new_mem_prompt.md order 4: dispose the memory_files table. Tencent (not
-- Postgres) is the memory authority, so the pool-scoped memory.md snapshot store
-- (added in 0021) is removed. Idempotent so a DB that never applied 0021 is fine.
DROP INDEX IF EXISTS "idx_memory_files_pool";--> statement-breakpoint
DROP TABLE IF EXISTS "memory_files";
