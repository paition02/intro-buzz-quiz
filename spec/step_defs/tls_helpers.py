from __future__ import annotations

import base64
import hashlib
import ssl
import subprocess
from pathlib import Path
from urllib.parse import urlparse

REPO_ROOT = Path(__file__).resolve().parents[2]
LOCAL_CA_CERT = REPO_ROOT / ".certs" / "intro-buzz-ca.crt"
LOCAL_SERVER_CERT = REPO_ROOT / ".certs" / "localhost.crt"


def tls_ca_cert(server_url: str) -> Path | None:
    if urlparse(server_url).scheme == "https" and LOCAL_CA_CERT.exists():
        return LOCAL_CA_CERT
    return None


def tls_verify(server_url: str) -> bool | ssl.SSLContext:
    ca_cert = tls_ca_cert(server_url)
    if ca_cert:
        return ssl.create_default_context(cafile=str(ca_cert))
    return True


def websocket_ssl_options(server_url: str) -> dict[str, dict[str, str]]:
    ca_cert = tls_ca_cert(server_url)
    if ca_cert:
        return {"sslopt": {"ca_certs": str(ca_cert)}}
    return {}


def chromium_certificate_args(server_url: str) -> list[str]:
    if urlparse(server_url).scheme != "https" or not LOCAL_SERVER_CERT.exists():
        return []

    openssl_bin = "/usr/bin/openssl" if Path("/usr/bin/openssl").exists() else "openssl"
    pubkey_pem = subprocess.check_output(
        [openssl_bin, "x509", "-in", str(LOCAL_SERVER_CERT), "-pubkey", "-noout"],
    )
    spki_der = subprocess.check_output(
        [openssl_bin, "pkey", "-pubin", "-outform", "DER"],
        input=pubkey_pem,
    )
    spki_pin = base64.b64encode(hashlib.sha256(spki_der).digest()).decode("ascii")
    return [f"--ignore-certificate-errors-spki-list={spki_pin}"]
