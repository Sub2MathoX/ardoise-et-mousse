import os
import sqlite3
from contextlib import contextmanager
from flask import current_app


SCHEMA = '''
CREATE TABLE IF NOT EXISTS profiles (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL,
 active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
 position INTEGER NOT NULL DEFAULT 0, created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS kegs (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, volume_ml INTEGER NOT NULL CHECK(volume_ml > 0),
 cost_cents INTEGER NOT NULL CHECK(cost_cents >= 0),
 status TEXT NOT NULL CHECK(status IN ('stock','active','closed')),
 purchased_on TEXT NOT NULL, created_at BIGINT NOT NULL,
 opened_at BIGINT, closed_at BIGINT, manual_assignee TEXT REFERENCES profiles(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_keg ON kegs(status) WHERE status = 'active';
CREATE TABLE IF NOT EXISTS consumptions (
 id TEXT PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES profiles(id),
 keg_id TEXT NOT NULL REFERENCES kegs(id), volume_ml INTEGER NOT NULL CHECK(volume_ml > 0),
 created_at BIGINT NOT NULL, cancelled_at BIGINT, undo_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS consumption_keg ON consumptions(keg_id);
CREATE TABLE IF NOT EXISTS ledger (
 id TEXT PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES profiles(id),
 keg_id TEXT REFERENCES kegs(id), amount_cents INTEGER NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('allocation','payment','adjustment')),
 note TEXT NOT NULL, created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS ledger_profile ON ledger(profile_id);
CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), small_ml INTEGER NOT NULL, large_ml INTEGER NOT NULL);
INSERT INTO settings(id,small_ml,large_ml) VALUES(1,250,500) ON CONFLICT(id) DO NOTHING;
CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, signature TEXT NOT NULL, response TEXT NOT NULL, created_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS audit (id TEXT PRIMARY KEY, action TEXT NOT NULL, detail TEXT NOT NULL, created_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS login_attempts (address TEXT PRIMARY KEY, count INTEGER NOT NULL, started_at BIGINT NOT NULL);
'''


class Database:
    def __init__(self):
        url = current_app.config['DATABASE_URL']
        self.postgres = url.startswith(('postgres://', 'postgresql://'))
        if self.postgres:
            import psycopg
            from psycopg.rows import dict_row
            self.conn = psycopg.connect(url, row_factory=dict_row)
        else:
            path = url.removeprefix('sqlite:///')
            parent = os.path.dirname(path)
            if parent:
                os.makedirs(parent, exist_ok=True)
            self.conn = sqlite3.connect(path, timeout=15)
            self.conn.row_factory = sqlite3.Row
            self.conn.execute('PRAGMA foreign_keys=ON')

    def execute(self, sql, params=()):
        return self.conn.execute(sql.replace('?', '%s') if self.postgres else sql, params)

    def all(self, sql, params=()):
        return [dict(row) for row in self.execute(sql, params).fetchall()]

    def one(self, sql, params=()):
        row = self.execute(sql, params).fetchone()
        return dict(row) if row is not None else None


@contextmanager
def transaction(write=False):
    db = Database()
    try:
        if write:
            if db.postgres:
                # Toutes les écritures métier partagent le même verrou inter-processus.
                db.execute('SELECT pg_advisory_xact_lock(41825319)')
            else:
                db.execute('BEGIN IMMEDIATE')
        elif db.postgres:
            db.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
        else:
            db.execute('BEGIN')
        yield db
        db.conn.commit()
    except Exception:
        db.conn.rollback()
        raise
    finally:
        db.conn.close()


def initialize():
    with transaction(write=True) as db:
        for statement in SCHEMA.split(';'):
            if statement.strip():
                db.execute(statement)
