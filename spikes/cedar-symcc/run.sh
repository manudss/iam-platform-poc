#!/bin/sh
# Spike SymCC: build the comparator and check every fixture pair gives the expected verdict.
# Needs CVC5=/path/to/cvc5 (cvc5 1.3.1, e.g. the cvc5-Linux-x86_64-static release asset).
set -e
cd "$(dirname "$0")"
: "${CVC5:?set CVC5=/path/to/cvc5}"
cargo build --release
B=target/release/spike-cedar-symcc
S=fixtures/schema.cedarschema
check() { # name expected-relation fileA fileB
  out=$("$B" "$S" "$3" "$4")
  rel=$(echo "$out" | sed -n 's/^RELATION: //p')
  echo "== $1 -> $rel"
  echo "$out" | grep -E '^(env|total|validate)' || true
  case "$rel" in "$2"*) ;; *) echo "UNEXPECTED VERDICT: wanted $2"; exit 1;; esac
}
check 'main vs main (identity)'        EQUIVALENT   fixtures/demo-main.cedar fixtures/demo-main.cedar
check 'main vs gateway (adds mcp:proxy)' A_NARROWER fixtures/demo-main.cedar fixtures/demo-gateway.cedar
check 'main vs narrower (bob removed)' A_WIDER      fixtures/demo-main.cedar fixtures/demo-main-narrower.cedar
check 'main vs incomparable'           INCOMPARABLE fixtures/demo-main.cedar fixtures/demo-main-incomparable.cedar
check 'gateway vs gateway sans grant'  A_NARROWER   fixtures/demo-gateway.cedar fixtures/demo-gateway-wider.cedar
check 'stress 200 regles'              A_NARROWER   fixtures/stress200-a.cedar fixtures/stress200-b.cedar
echo 'ALL VERDICTS OK'
