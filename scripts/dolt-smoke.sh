#!/usr/bin/env bash
# Real Dolt smoke test (needs the `dolt` binary on PATH or DOLT_BIN). No Docker, no network.
# Proves: demo schema loads, a branch can change roles, merge into main, and history is queryable.
set -euo pipefail
DOLT="${DOLT_BIN:-dolt}"
SQL="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../data/demo/01-schema.sql"
D="$(mktemp -d)"; trap 'rm -rf "$D"' EXIT
mkdir "$D/home" "$D/repo"; export HOME="$D/home"; cd "$D/repo"
$DOLT config --global --add user.name "poc" >/dev/null; $DOLT config --global --add user.email "poc@example.invalid" >/dev/null
$DOLT init >/dev/null
# The seed script commits itself with DOLT_COMMIT; run it as-is.
sed -e '/CREATE DATABASE/d' -e '/^USE iam;/d' "$SQL" | $DOLT sql >/dev/null
main_commits=$($DOLT sql -r csv -q "select count(*) from dolt_log" | tail -1)
$DOLT checkout -b change-role >/dev/null
$DOLT sql -q "INSERT INTO assignments VALUES ('demo-bob','payment-approver')" >/dev/null
# SoD check on the branch (simulation): any identity holding both roles of a rule?
viol=$($DOLT sql -r csv -q "select count(*) from assignments a join assignments b on a.identity_id=b.identity_id join sod_rules r on r.role_a=a.role_id and r.role_b=b.role_id" | tail -1)
[ "$viol" = "1" ] || { echo "FAIL: expected 1 SoD violation on branch, got $viol"; exit 1; }
$DOLT add -A >/dev/null; $DOLT commit -m "bob gets approver (simulated)" >/dev/null
# main is untouched until merge
$DOLT checkout main >/dev/null
on_main=$($DOLT sql -r csv -q "select count(*) from assignments where identity_id='demo-bob' and role_id='payment-approver'" | tail -1)
[ "$on_main" = "0" ] || { echo "FAIL: branch change leaked into main"; exit 1; }
$DOLT merge change-role >/dev/null
after=$($DOLT sql -r csv -q "select count(*) from assignments where identity_id='demo-bob' and role_id='payment-approver'" | tail -1)
[ "$after" = "1" ] || { echo "FAIL: merge did not apply"; exit 1; }
echo "OK dolt smoke: seed commits=$main_commits, SoD violation seen on branch, main untouched before merge, merged"
