#!/bin/sh
set -eu
case "$(basename "$0")" in
  ai-inference-upgrade) product=inference ;;
  ai-training-upgrade) product=training ;;
  *) product=${1:?product is required} ;;
esac
compose="/usr/lib/treeseed-ai/$product/compose.yml"
environment="/etc/treeseed-ai/$product/environment"
project="treeseed-ai-$product"
/usr/lib/treeseed-ai/$product/check-host "$product"
docker compose -p "$project" --env-file "$environment" -f "$compose" pull
docker compose -p "$project" --env-file "$environment" -f "$compose" run --rm migrations
docker compose -p "$project" --env-file "$environment" -f "$compose" up -d --remove-orphans --wait
