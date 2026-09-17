#!/usr/bin/env bash
set -e

mkdir -p backups

STAMP=$(date +"%Y%m%d-%H%M%S")

if [ -f aurelius.db ]; then
  cp aurelius.db "backups/aurelius-${STAMP}.db"
fi

if [ -d public/uploads/documents ]; then
  tar -czf "backups/documents-${STAMP}.tar.gz" public/uploads/documents
fi

echo "Backup created:"
echo "backups/aurelius-${STAMP}.db"
echo "backups/documents-${STAMP}.tar.gz"
