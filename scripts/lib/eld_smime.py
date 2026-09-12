"""Offline, test-only S/MIME packaging. No mail transport or production route."""

import re
import zipfile
from datetime import datetime, timezone
from email import policy
from email.message import EmailMessage
from email.utils import format_datetime, make_msgid

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.ciphers import algorithms
from cryptography.hazmat.primitives.serialization import pkcs7
from cryptography.x509.oid import ExtendedKeyUsageOID


RECIPIENT = "fmcsaeldsub@dot.gov"
# Reviewed provider-portal download, not a certificate obtained from an email link.
RECIPIENT_SHA256 = "95fe7a131ea9a421422c7a13538e38b851b042105150a1092468cbbedd51953a"
RECIPIENT_MEMBER = "FMCSA_ELD_Expires_July2027_Certificate.cer"


def validate_certificate(cert, *, recipient=False, now=None):
    now = now or datetime.now(timezone.utc)
    if not cert.not_valid_before_utc <= now < cert.not_valid_after_utc:
        raise ValueError("Certificate is not currently valid")
    public_key = cert.public_key()
    if not isinstance(public_key, rsa.RSAPublicKey) or public_key.key_size < 2048:
        raise ValueError("RSA certificate of at least 2048 bits is required")
    usage = cert.extensions.get_extension_for_class(x509.KeyUsage).value
    if recipient:
        eku = cert.extensions.get_extension_for_class(x509.ExtendedKeyUsage).value
        addresses = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
        if not usage.key_encipherment or ExtendedKeyUsageOID.EMAIL_PROTECTION not in eku:
            raise ValueError("Certificate cannot encrypt email")
        if RECIPIENT not in addresses.get_values_for_type(x509.RFC822Name):
            raise ValueError("Recipient certificate mailbox mismatch")
    elif not usage.digital_signature:
        raise ValueError("Certificate cannot sign")


def load_recipient_package(path):
    with zipfile.ZipFile(path) as archive:
        if archive.getinfo(RECIPIENT_MEMBER).file_size > 64000:
            raise ValueError("Unexpected certificate size")
        cert = x509.load_der_x509_certificate(archive.read(RECIPIENT_MEMBER))
    if cert.fingerprint(hashes.SHA256()).hex() != RECIPIENT_SHA256:
        raise ValueError("Recipient certificate differs from reviewed portal certificate")
    validate_certificate(cert, recipient=True)
    return cert


def build_test_email(submission, identity, sender, signer_cert, signer_key, recipient_cert):
    if submission.get("test") is not True or identity.get("test") is not True:
        raise ValueError("Only explicit test submissions are supported")
    # Narrow mailbox syntax intentionally excludes display names and header injection.
    if not isinstance(sender, str) or len(sender) > 254 or not re.fullmatch(
        r"[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+", sender
    ):
        raise ValueError("A single ASCII return mailbox is required")
    for name, length in (("eldIdentifier", 6), ("eldRegistrationId", 4)):
        if not re.fullmatch(r"[A-Z0-9]{%d}" % length, identity.get(name, "")):
            raise ValueError("Invalid test identity")
    filename = submission.get("filename", "")
    if not re.fullmatch(r"[A-Za-z0-9_-]{25}", filename):
        raise ValueError("Invalid ELD output filename")
    comment = submission.get("comment", "")
    if not isinstance(comment, str) or len(comment) > 60 or not re.fullmatch(r"[ -~]*", comment):
        raise ValueError("Invalid output comment")
    content = submission.get("content", "")
    if not isinstance(content, str) or not content or len(content) > 5 * 1024 * 1024:
        raise ValueError("Invalid output size")
    if "\n" in content or not content.endswith("\r") or not re.fullmatch(r"[\r -~]+", content):
        raise ValueError("Output must retain ASCII CR-only record delimiters")
    validate_certificate(signer_cert)
    validate_certificate(recipient_cert, recipient=True)
    if not isinstance(signer_key, rsa.RSAPrivateKey) or (
        signer_key.public_key().public_numbers() != signer_cert.public_key().public_numbers()
    ):
        raise ValueError("Signing key does not match certificate")

    inner = EmailMessage(policy=policy.SMTP)
    inner.set_content(comment, charset="us-ascii")
    # Base64 protects the ELD file's CR-only bytes from email newline normalization.
    inner.add_attachment(content.encode("ascii"), maintype="application", subtype="octet-stream",
                         filename=filename, cte="base64")
    encrypted = (pkcs7.PKCS7EnvelopeBuilder().set_data(inner.as_bytes())
                 .set_content_encryption_algorithm(algorithms.AES256)
                 .add_recipient(recipient_cert)
                 .encrypt(serialization.Encoding.SMIME, [pkcs7.PKCS7Options.Binary]))
    # FMCSA ICD 3.2.3.1: encrypt first, then sign the encrypted MIME entity.
    signed = (pkcs7.PKCS7SignatureBuilder().set_data(encrypted)
              .add_signer(signer_cert, signer_key, hashes.SHA256())
              .sign(serialization.Encoding.DER, [pkcs7.PKCS7Options.Binary]))
    # Opaque CMS preserves the signed bytes even when an SMTP client folds headers
    # or normalizes MIME line endings. Do not parse/reserialize a signed MIME body.
    outer = EmailMessage(policy=policy.SMTP)
    outer.set_content(signed, maintype="application", subtype="pkcs7-mime", cte="base64",
                      params={"smime-type": "signed-data", "name": "smime.p7m"})
    outer["From"] = sender
    outer["To"] = RECIPIENT
    outer["Subject"] = (f"TEST: ELD records from {identity['eldRegistrationId']}:"
                        f"{identity['eldIdentifier']}")
    outer["Date"] = format_datetime(datetime.now(timezone.utc))
    outer["Message-ID"] = make_msgid(domain=sender.split("@", 1)[1])
    return outer.as_bytes(policy=policy.SMTP)
