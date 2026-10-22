#!/bin/bash
# Runs once, on first init of an empty volume.
set -e

# Second database so tests never touch real data
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
	CREATE DATABASE app_test;
EOSQL

# Enable pgvector in both databases
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -c 'CREATE EXTENSION IF NOT EXISTS vector;'
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "app_test" -c 'CREATE EXTENSION IF NOT EXISTS vector;'
