# Scoped policy of the token the Lyam API receives (IAM_BAO_TOKEN). Exactly the paths the
# built-in demo store grants (demo/secret-store.mjs): workflow-connection and plugin secrets
# read/write, the PostgreSQL journal URL read-only. Nothing else.
path "secret/data/iam/workflow-connections/*" {
  capabilities = ["create", "update", "read"]
}
path "secret/data/iam/plugins/*" {
  capabilities = ["create", "update", "read"]
}
path "secret/data/iam/pg" {
  capabilities = ["read"]
}
