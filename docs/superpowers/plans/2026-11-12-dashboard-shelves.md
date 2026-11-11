# Dashboard and shelf navigation

Preserve current card/layout conventions and bounded repository queries. No database migration or record rewrite is needed.

1. Treat `책 대기열` membership as part of the existing startReading command transaction. Update server, optimistic replica and acknowledged projections together, preserving other memberships. Test replay, offline outbox and failure behavior.
2. Extend the existing reading page query with `recentThrough` (calendar date), selecting completed cycles in [today minus29 days, today], newest completion per book before pagination. Share a local helper and verify server/local parity, exclusions and boundary dates.
3. Add home queue and recent-completed sections with paged queries and existing covers/detail actions. Reuse the existing catalog view for the new shelf navigation menu. Make the ownership statistic a semantic button.
4. Verify related unit/transaction/query tests, browser navigation/mobile flows, typecheck and production build. Keep original records and settings unchanged.
