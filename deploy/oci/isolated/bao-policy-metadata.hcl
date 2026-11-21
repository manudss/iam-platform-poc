# Fictive ISOLATED qualification token policy: exactly what the qualification capture
# reads (deploy/oci/qualification-container.mjs walks each baoMetadataRoots entry:
# LIST the root, GET each key's metadata for current_version). Never granted to the
# application token; the app keeps its own scoped policy (bao-policy.hcl).
path "secret/metadata/iam" {
  capabilities = ["list"]
}
path "secret/metadata/iam/*" {
  capabilities = ["read", "list"]
}
