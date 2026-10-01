-- Migration 0001: the users table.
--
-- ONE TABLE HOLDS EVERY ACCOUNT. There is no separate table for roles or
-- statuses: both are plain text constrained by a CHECK, so adding a new role or
-- status later is an ordinary migration rather than an ALTER TYPE on an enum.
--
-- EMAIL IS CASE-INSENSITIVE. The citext type makes "Sam@Shop.com" and
-- "sam@shop.com" the same value, so the UNIQUE constraint enforces one account
-- per address without any lower-casing in application code.

-- gen_random_uuid() lives in pgcrypto on older servers, and citext provides the
-- case-insensitive text type. Both are standard extensions available on Render.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE IF NOT EXISTS users (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  email                citext      NOT NULL UNIQUE,
  password_hash        text        NOT NULL,
  role                 text        NOT NULL CHECK (role IN ('MANAGEMENT', 'SALES')),
  status               text        NOT NULL CHECK (status IN ('PENDING', 'ACTIVE', 'REJECTED', 'INACTIVE')),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  -- Who approved this account, and when. Null until a manager acts on it. The
  -- self-reference is to the manager's own row in this same table.
  approved_by          uuid        REFERENCES users(id),
  approved_at          timestamptz,
  last_login_at        timestamptz,
  -- Set true when a manager sets a temporary password, so the application can
  -- later require the user to change it. Defaults false for a self-registration.
  must_change_password boolean     NOT NULL DEFAULT false
);

-- The management queue lists PENDING accounts and the console filters by status,
-- so an index on status keeps those lookups cheap as the table grows.
CREATE INDEX IF NOT EXISTS users_status_idx ON users (status);
