# OpenBao demo companion: file storage on a host-backed path, no TLS (loopback / docker network
# only - Caddy terminates the public TLS in front of the app, Bao is never public). Demo-grade:
# mlock disabled, unseal key material lives in root-owned 0600 files on the same host. A real
# deployment would use TLS, mlock and an external auto-unseal - out of demo scope.
storage "file" {
  path = "/bao/file"
}

listener "tcp" {
  address     = "0.0.0.0:8200"
  tls_disable = 1
}

disable_mlock = true
ui            = false
api_addr      = "http://127.0.0.1:8200"
