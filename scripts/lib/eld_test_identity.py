"""Read the official development identity without extracting its private key."""

import re
import zipfile
from datetime import datetime, timezone

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.serialization import pkcs12


TEST_RSA_THUMBPRINT = "ae35f47072152461f548ba7fa52aad92fc7956e2"


def load_test_package(path):
    with zipfile.ZipFile(path) as archive:
        for name in ("README.txt", "ELD_RSA.pfx"):
            if archive.getinfo(name).file_size > 64000:
                raise ValueError("Unexpected test package size")
        readme = archive.read("README.txt").decode("cp1252")
        identifier = re.search(r"(?im)^-ELD Identifier:\s*([A-Za-z0-9]{6})\s*$", readme)
        registration = re.search(r"(?im)^-ELD Registration ID:\s*([A-Za-z0-9]{4})\s*$", readme)
        if not identifier or not registration:
            raise ValueError("Unexpected test identity format")
        key, cert, _ = pkcs12.load_key_and_certificates(archive.read("ELD_RSA.pfx"), None)
    now = datetime.now(timezone.utc)
    if key is None or cert is None or not cert.not_valid_before_utc <= now < cert.not_valid_after_utc:
        raise ValueError("Test certificate is unavailable or expired")
    # SHA-1 is only the published certificate identifier here, not a signature algorithm.
    if cert.fingerprint(hashes.SHA1()).hex() != TEST_RSA_THUMBPRINT:
        raise ValueError("Not the reviewed FMCSA test identity")
    return {
        "test": True,
        "eldIdentifier": identifier.group(1).upper(),
        "eldRegistrationId": registration.group(1).upper(),
        "cert": cert.public_bytes(serialization.Encoding.PEM).decode("ascii"),
        "key": key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                 serialization.NoEncryption()).decode("ascii"),
    }
