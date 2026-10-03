#!/usr/bin/env bash
#
# BLINK smoke test.
#
# Exercises the API end to end against a running instance, without needing a
# funded Zcash wallet: it creates a payment request, reads it back, initiates it,
# and confirms that a claimed transaction id does not become a confirmation.
#
# Usage:
#   API_BASE_URL=http://localhost:4000 ./scripts/smoke.sh
#
# Requires: curl, node.

set -u

API_BASE_URL="${API_BASE_URL:-http://localhost:4000}"
SAPLING="ztestsapling10yy2ex5dcqkclhc7z7yrnjq2z6feyjad56ptwlfgmy77dmaqqrl9gyhprdx59qgmsnyfska2kez"

jq_get() {
  # Extract a top-level string field without requiring jq.
  sed -n "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p"
}

echo "BLINK smoke test against ${API_BASE_URL}"

echo "- health"
curl -fsS "${API_BASE_URL}/health" | head -c 400
echo

echo "- create payment request"
CREATE=$(curl -fsS -X POST "${API_BASE_URL}/v1/payment-requests" \
  -H 'content-type: application/json' \
  -d "{\"recipientName\":\"Joseph\",\"recipientAddress\":\"${SAPLING}\",\"amount\":\"25\",\"memo\":\"Dinner\",\"expiryMinutes\":30}")
echo "${CREATE}" | head -c 400
echo

SHORT_CODE=$(printf '%s' "${CREATE}" | jq_get shortCode)
echo "- short code: ${SHORT_CODE}"
if [ -z "${SHORT_CODE}" ]; then
  echo "FAIL: no short code returned" >&2
  exit 1
fi

echo "- public view (must not contain the raw address)"
VIEW=$(curl -fsS "${API_BASE_URL}/v1/payment-requests/${SHORT_CODE}")
if printf '%s' "${VIEW}" | grep -q "ztestsapling"; then
  echo "FAIL: raw address leaked into the public view" >&2
  exit 1
fi
echo "  ok"

echo "- report a claimed txid (must NOT confirm)"
TXID=$(node -e "console.log('a'.repeat(64))")
curl -fsS -X POST "${API_BASE_URL}/v1/payment-requests/${SHORT_CODE}/transactions" \
  -H 'content-type: application/json' \
  -d "{\"txid\":\"${TXID}\"}" | head -c 300
echo

echo "- verify (provider observes nothing, so still not confirmed)"
VERIFY=$(curl -fsS -X POST "${API_BASE_URL}/v1/payment-requests/${SHORT_CODE}/verify" \
  -H 'content-type: application/json' -d '{}')
echo "${VERIFY}" | head -c 300
echo
if printf '%s' "${VERIFY}" | grep -q '"status":"CONFIRMED"'; then
  echo "FAIL: BLINK reported CONFIRMED without an observation" >&2
  exit 1
fi

echo "Smoke test passed."
