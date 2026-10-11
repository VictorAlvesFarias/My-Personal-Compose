#!/bin/sh
# Runs once, when the PostgreSQL volume is created: one user and one database per application,
# all on the same server. The values reach SQL as psql variables, never pasted into the statements.
# To add an application later on an existing volume, run the same statements with
# "docker compose exec postgres psql -U postgres".
set -eu

create_database() {
    psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
        -v name="$1" -v password="$2" <<'SQL'
CREATE ROLE :"name" LOGIN PASSWORD :'password';
CREATE DATABASE :"name" OWNER :"name";
REVOKE ALL ON DATABASE :"name" FROM PUBLIC;
SQL
    echo "Database $1 created"
}

create_database safeguard "$SAFEGUARD_DB_PASSWORD"
create_database gameout "$GAMEOUT_DB_PASSWORD"
