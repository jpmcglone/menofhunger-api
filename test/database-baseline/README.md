# Local migration fixture baseline

This is the committed schema immediately before the App Review changes, with SHA-256 hashes of its migration files. It contains no user data. Historical migrations cannot replay onto an empty database: `20260127221829_post_user_createdat_index` references Post before it is created.

`npm run check:database` creates its own disposable PostgreSQL container, installs this baseline, records the historical migrations only in that synthetic database, seeds one synthetic user, applies every later migration using Prisma Migrate, checks schema parity, and tests relational account erasure. It never reads a developer database URL or repairs production migration history. Docker must be running; unavailable Docker is a failed check, not a pass.

Do not refresh this baseline simply to make a failed migration pass. New migrations must upgrade this recorded state. Rebuilding production from migration history remains a separate baseline/backup operational task.
