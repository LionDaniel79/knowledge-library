# Dashboard and shelf navigation

The home dashboard adds paginated `책 대기열` and `최근 읽은 책` sections. Both reuse existing book cards and detail navigation. The recent list includes today and the previous29 calendar days, deduplicates rereads before pagination and uses each book's latest completion. Empty/loading/error states are explicit.

The main menu adds `서재별 보기`, sharing existing shelf data, filters, catalog cards and pagination. The entire owned-book statistic is a native button navigating to the unfiltered owned-books menu, usable with keyboard and touch.

Starting reading removes only `책 대기열` membership in the same transaction as cycle creation and the idempotent operation receipt. Other memberships and the book itself remain. Book version/revision and curation evidence are carried forward. Offline optimistic changes, reopening pending reading state, acknowledgement and replay use the same versioned shelf patch; stale acknowledgements cannot remove a later re-added membership.

Server and device queries support bounded `/api/reading?recentThrough=YYYY-MM-DD&limit=30&offset=0` pages with hydrated books, avoiding full catalog downloads. Existing month/day reading queries retain their behavior. No schema migration or existing-data rewrite is required.

Verification: targeted transaction/query/regression tests passed; browser4 passed (390px and1280px, pagination/detail, empty shelf, keyboard navigation, recent date/dedup rules and bounded remote requests); typecheck, production build, formatting and diff checks passed. Independent review found no important issues. Browser verification uses isolated fixtures; real iPhone/iPad hardware acceptance is not claimed. Remote GitHub CI remains subject to the account's existing allowance.

Changed production files: library-app.tsx, dashboard-books.tsx, lib/recent-reading.ts, lib/domain.ts, server/library-store.ts, server/record-catalog.ts and replica optimistic.ts, queries.ts, runtime.ts, save-projection.ts. Tests: start-reading-queue.test.ts, recent-reading-query.test.ts, dashboard-shelves.spec.ts.
