#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_DIR="$ROOT_DIR/tools/pgsql"
DEB_DIR="$ROOT_DIR/tools/debs"
PG_BIN="$INSTALL_DIR/usr/lib/postgresql/18/bin"
PG_LIB="$INSTALL_DIR/usr/lib/x86_64-linux-gnu"
PGDATA="${PGDATA:-$ROOT_DIR/data/postgres}"
PG_RUN_DIR="${PG_RUN_DIR:-$ROOT_DIR/data/postgres-run}"
PG_LOG="${PG_LOG:-$ROOT_DIR/data/postgres.log}"
PGPORT="${PGPORT:-15432}"
PGUSER="${PGUSER:-ftr}"
PGDATABASE="${PGDATABASE:-ftr_fix_bot}"

export LD_LIBRARY_PATH="$PG_LIB:${LD_LIBRARY_PATH:-}"

packages=(
  postgresql-18
  postgresql-client-18
  libpq5
  postgresql-common
  postgresql-client-common
)

install_postgres() {
  if [[ -x "$PG_BIN/postgres" && -x "$PG_BIN/psql" ]]; then
    return
  fi

  mkdir -p "$DEB_DIR" "$INSTALL_DIR"
  (
    cd "$DEB_DIR"
    apt-get download "${packages[@]}"
  )

  for pkg in "$DEB_DIR"/*.deb; do
    dpkg-deb -x "$pkg" "$INSTALL_DIR"
  done
}

init_postgres() {
  install_postgres
  mkdir -p "$ROOT_DIR/data" "$PG_RUN_DIR"

  if [[ ! -f "$PGDATA/PG_VERSION" ]]; then
    "$PG_BIN/initdb" -D "$PGDATA" -U "$PGUSER" -A trust --no-locale --encoding=UTF8
  fi
}

start_postgres() {
  init_postgres

  if "$PG_BIN/pg_isready" -h 127.0.0.1 -p "$PGPORT" -U "$PGUSER" >/dev/null 2>&1; then
    echo "Postgres already running on 127.0.0.1:$PGPORT"
  else
    "$PG_BIN/pg_ctl" \
      -D "$PGDATA" \
      -l "$PG_LOG" \
      -o "-p $PGPORT -k $PG_RUN_DIR -c listen_addresses=127.0.0.1" \
      -w start
  fi

  if ! "$PG_BIN/psql" -h 127.0.0.1 -p "$PGPORT" -U "$PGUSER" -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '$PGDATABASE'" | grep -q 1; then
    "$PG_BIN/createdb" -h 127.0.0.1 -p "$PGPORT" -U "$PGUSER" "$PGDATABASE"
  fi

  "$PG_BIN/pg_isready" -h 127.0.0.1 -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE"
}

case "${1:-status}" in
  install)
    install_postgres
    "$PG_BIN/postgres" --version
    "$PG_BIN/psql" --version
    ;;
  init)
    init_postgres
    ;;
  start)
    start_postgres
    ;;
  stop)
    if [[ -f "$PGDATA/postmaster.pid" ]]; then
      "$PG_BIN/pg_ctl" -D "$PGDATA" -m fast -w stop
    else
      echo "Postgres is not running"
    fi
    ;;
  status)
    install_postgres
    "$PG_BIN/pg_isready" -h 127.0.0.1 -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE"
    ;;
  psql)
    start_postgres >/dev/null
    exec "$PG_BIN/psql" -h 127.0.0.1 -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" "${@:2}"
    ;;
  *)
    echo "Usage: $0 {install|init|start|stop|status|psql}" >&2
    exit 2
    ;;
esac
