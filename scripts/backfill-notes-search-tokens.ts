/**
 * Populate transactions.notes_search_tokens / admin_notes_search_tokens for
 * rows created before migration 20261119_add_notes_search_tokens.
 *
 * Notes are encrypted application-side, so the tokens cannot be computed in
 * SQL. Safe to re-run: each row's tokens are recomputed from its notes.
 *
 * Usage: npx ts-node scripts/backfill-notes-search-tokens.ts [batchSize]
 */
import { pool } from "../src/config/database";
import { TransactionModel } from "../src/models/transaction";

async function main(): Promise<void> {
  const batchSize = parseInt(process.argv[2] ?? "500", 10);
  const model = new TransactionModel();

  let afterId: string | null = null;
  let total = 0;

  for (;;) {
    const { processed, lastId } = await model.backfillNotesSearchTokens(
      batchSize,
      afterId,
    );
    if (processed === 0) break;
    total += processed;
    afterId = lastId;
    console.log(`[notes-search-backfill] processed ${total} rows`);
  }

  console.log(`[notes-search-backfill] done, ${total} rows updated`);
}

main()
  .catch((err) => {
    console.error("[notes-search-backfill] failed:", err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
