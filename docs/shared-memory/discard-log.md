tier: workbench

# Discard log

Append-only. Every numbered memory entry removed from a topic file is recorded here in full (date, source file, number, reason, superseding citation) before it is replaced by a tombstone. Written only by `removeKnowledgeEntries` in `src/server/discard-log.ts`; never edit by hand.
