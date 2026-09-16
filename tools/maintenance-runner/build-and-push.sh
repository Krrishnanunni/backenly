#!/usr/bin/env bash
# Build and push the maintenance runner.
#
#   MAINTENANCE_AWS_ACCOUNT_ID=<account> BASE_IMAGE=<production runtime image> \
#     bash tools/maintenance-runner/build-and-push.sh
#
# Run from the repository root. The bundle is built here rather than in the
# image so the build context is one file: nothing else from this repository
# can end up in an image that runs against production.
set -euo pipefail

REGION="${AWS_REGION:-ap-south-1}"
REPO="${MAINTENANCE_ECR_REPO:-backenly-runtime}"
ACCOUNT="${MAINTENANCE_AWS_ACCOUNT_ID:-}"
BASE="${BASE_IMAGE:-}"
[ -n "$ACCOUNT" ] || { echo "MAINTENANCE_AWS_ACCOUNT_ID is not set"; exit 2; }
[ -n "$BASE" ] || { echo "BASE_IMAGE is not set; pass the production runtime image, pinned by digest"; exit 2; }

ROOT="$(pwd)"
[ -f "$ROOT/scripts/run-maintenance-plan.ts" ] || { echo "run from the repository root"; exit 2; }

SHA="$(git rev-parse --short HEAD)"
if [ -n "$(git status --porcelain -- scripts/run-maintenance-plan.ts lib/autonomy/maintenance tools/maintenance-runner)" ]; then
  echo "refusing: the runner inputs have uncommitted changes; commit them so the tag identifies the image"
  exit 2
fi

TAG="maintenance-${SHA}"
IMAGE="${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/${REPO}:${TAG}"

CTX="$(mktemp -d /tmp/maintenance-ctx.XXXXXX)"
trap 'rm -rf "$CTX"' EXIT

# `@prisma/client` and `.prisma` come from the base image. Everything else,
# including `pg`, is bundled: the runtime image does not ship `pg` as a package
# because its own server bundle already contains it.
echo "bundling…"
node -e '
  require("esbuild").build({
    entryPoints: ["scripts/run-maintenance-plan.ts"],
    bundle: true, platform: "node", target: "node20", format: "cjs",
    outfile: process.argv[1], minify: true,
    external: ["@prisma/client", ".prisma/client", "pg-native", "pg-cloudflare", "cloudflare:sockets"],
    alias: { "server-only": "./tools/maintenance-runner/server-only-stub.js" },
    logLevel: "warning",
  }).catch(e => { console.error(e); process.exit(1) })
' "$CTX/maintenance.cjs"

cp "$ROOT/tools/maintenance-runner/Dockerfile.maintenance" "$CTX/"
echo "context:"
find "$CTX" -maxdepth 1 -printf '  %P\n' | sort | sed '/^  $/d'

docker build --platform linux/amd64 --build-arg "BASE_IMAGE=$BASE" \
  -f "$CTX/Dockerfile.maintenance" -t "$IMAGE" "$CTX"

aws ecr get-login-password --region "$REGION" \
  | docker login --username AWS --password-stdin "${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com"
docker push "$IMAGE"

DIGEST="$(aws ecr describe-images --repository-name "$REPO" --image-ids imageTag="$TAG" \
  --region "$REGION" --output text --query 'imageDetails[0].imageDigest')"

echo
echo "pushed ${REPO}:${TAG}"
echo "digest ${DIGEST}"
echo "image  ${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/${REPO}@${DIGEST}"
