-- DataStack One — synthetic lending reference database (V5.4, PRD FR5b acceptance §5).
--
-- Paste this into a fresh Neon (or any Postgres) database, then register that database in the
-- app's Settings → Connections panel by name. Once attached read-only, the agent can join the
-- session's `loans_sample.csv` upload to these live tables by name — the "connect a Postgres and
-- join a CSV to a PG table" acceptance criterion.
--
-- NOTHING here is real customer data. The schema is intentionally the reference side of the CSV:
--   * `branches` — one row per branch the CSV references by name (north/south/east/west), carrying
--     the region/manager the CSV does not have, so a CSV↔PG join is genuinely additive.
--   * `loans` — a small live loan book (a server-of-record snapshot), so the attached DB has more
--     than one introspectable table.
--
-- Written in the SQL subset both Postgres and DuckDB accept (no SERIAL / IDENTITY / vendor
-- functions), so the same file also seeds an in-memory DuckDB in the offline fixture test — the
-- committed contract stays honest without a live database. See DEMO.md for the Neon walk-through.

BEGIN;

-- Drop loans first: it has a foreign key onto branches.
DROP TABLE IF EXISTS loans;
DROP TABLE IF EXISTS branches;

-- Branch reference table. `branch` is the natural key the CSV joins on; region/manager are the
-- attributes the CSV lacks, which is what makes joining to this table worthwhile.
CREATE TABLE branches (
    branch     TEXT PRIMARY KEY,
    region     TEXT NOT NULL,
    manager    TEXT NOT NULL,
    opened_on  DATE NOT NULL
);

-- Exactly the four branches the CSV uses — so an INNER JOIN drops no CSV row. Regions are
-- distinct and alphabetically ordered (Eastern < Northern < Southern < Western) so a
-- `GROUP BY region ORDER BY region` result is deterministic.
INSERT INTO branches (branch, region, manager, opened_on) VALUES
    ('east',  'Eastern',  'Carla Mendez',  DATE '2018-11-20'),
    ('north', 'Northern', 'Alice Chen',    DATE '2019-03-01'),
    ('south', 'Southern', 'Bimal Rao',     DATE '2020-07-15'),
    ('west',  'Western',  'Dan Whitfield', DATE '2021-01-05');

-- Live loan book snapshot. loan_amount is a proper NUMERIC here (unlike the CSV's thousands-
-- separated text) — the live source is already clean; the messy CSV is what the pipeline cleans.
CREATE TABLE loans (
    loan_id      BIGINT PRIMARY KEY,
    customer_id  TEXT NOT NULL,
    branch       TEXT NOT NULL REFERENCES branches (branch),
    loan_amount  NUMERIC(12, 2) NOT NULL,
    dpd_days     INTEGER NOT NULL,
    balance      NUMERIC(12, 2) NOT NULL,
    created_at   DATE NOT NULL
);

INSERT INTO loans (loan_id, customer_id, branch, loan_amount, dpd_days, balance, created_at) VALUES
    (1,  'C2001', 'north', 12500.00,  0,  9800.50, DATE '2026-07-14'),
    (2,  'C2002', 'south',  8200.00, 14,  8200.00, DATE '2026-07-14'),
    (3,  'C2003', 'east',  25000.00,  0,     0.00, DATE '2026-07-14'),
    (4,  'C2004', 'west',   5750.00,  3,  5100.25, DATE '2026-07-14'),
    (5,  'C2005', 'north', 15000.00,  0, 12300.00, DATE '2026-07-15'),
    (6,  'C2006', 'east',  42000.00, 45, 39500.75, DATE '2026-07-15'),
    (7,  'C2007', 'south',  3400.00,  0,     0.00, DATE '2026-07-15'),
    (8,  'C2008', 'west',  18600.00,  7, 17900.00, DATE '2026-07-16'),
    (9,  'C2009', 'north',  9900.00,  0,  7250.00, DATE '2026-07-16'),
    (10, 'C2010', 'east',  31250.00,  0, 24800.50, DATE '2026-07-16');

COMMIT;
