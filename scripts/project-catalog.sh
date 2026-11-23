#!/usr/bin/env bash
# Writes test/fixtures/catalogs/project.json: the catalog snapshot
# `listen-fire catalog --json` gives for a project that connects Stripe, Attio,
# Gmail and Slack, for the fixtures the handbook's captured catalog cannot
# check (payment_failed connects Stripe).
#
# No live credential is used. Stripe, Gmail and Slack describe their records
# from their own manifests, so their credentials hold placeholders. Attio
# describes them from the account, so its credential points at the fake Attio
# in listen-fire's packages/fake-channels, seeded with the two People fields
# payment_failed reads.
#
# usage: scripts/project-catalog.sh <listen-fire checkout>   (node 22 on PATH)
set -euo pipefail

checkout="$(cd "$1" && pwd)"
lf="$checkout/target/debug/listen-fire"
here="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
port=47811
trap 'kill "$fake" 2>/dev/null; wait "$fake" 2>/dev/null; rm -rf "$work"' EXIT

(mkdir "$work/fake" && cd "$work/fake" && FAKE_CHANNELS_PORT=$port exec node "$checkout/packages/fake-channels/bin/fake-channels.cjs" >/dev/null 2>&1) &
fake=$!
until curl -sf "http://127.0.0.1:$port/attio/v2/objects" >/dev/null; do sleep 0.2; done

text_attribute() {
  printf '{"entity_type":"attribute:people","id":"%s","data":{"id":{"workspace_id":"test","object_id":"people","attribute_id":"%s"},"api_slug":"%s","title":"%s","description":null,"type":"text","is_multiselect":false,"is_unique":false,"is_required":false,"is_writable":true,"is_system_attribute":false,"relationship":null,"config":{}}}' "$1" "$1" "$1" "$2"
}
curl -sf -X POST -H 'content-type: application/json' "http://127.0.0.1:$port/admin/attio/seed" \
  -d "{\"entities\":[$(text_attribute plan Plan),$(text_attribute account_manager 'Account manager')]}" >/dev/null

project="$work/project"
mkdir "$project" && cd "$project"
"$lf" init . >/dev/null
rm movements/*.mvt
cp "$here/test/fixtures/payment_failed.mvt" movements/
for module in stripe attio slack; do "$lf" connect "@lf/$module" --yes >/dev/null; done
"$lf" connect @lf/gmail --yes --client-id placeholder --client-secret placeholder >/dev/null
printf 'sk_test_placeholder\n\n' | "$lf" credential add --module @lf/stripe stripe_account >/dev/null
printf 'xoxb-placeholder\n\n\n\n' | "$lf" credential add --module @lf/slack team_slack >/dev/null
printf 'placeholder\nhttp://127.0.0.1:%s/attio\n' "$port" | "$lf" credential add --module @lf/attio crm --credential attio_token >/dev/null
# Gmail signs in with OAuth; its catalog is the manifest's, so a mailbox is all the check reads.
printf 'billing_mail:\n  module: gmail\n  credential: gmail\n  mailbox: billing@example.com\n' >> .lf/secrets.yaml

"$lf" check 2>/dev/null | tail -1
"$lf" catalog --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.stringify(JSON.parse(s),null,2)+"\n"))' > "$here/test/fixtures/catalogs/project.json"
