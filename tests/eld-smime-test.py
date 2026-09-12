"""Offline S/MIME checks with disposable keys and independent OpenSSL verification."""

import io
import os
import shutil
import subprocess
import sys
import unittest
import zipfile
from datetime import datetime, timedelta, timezone
from email import policy
from email.parser import BytesParser
from pathlib import Path
from unittest.mock import patch

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.serialization import pkcs7
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from lib.eld_smime import RECIPIENT, RECIPIENT_MEMBER, build_test_email, load_recipient_package, validate_certificate


def certificate(key, *, recipient=False, expired=False, mailbox=RECIPIENT, signing=True):
    now = datetime.now(timezone.utc)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Disposable offline test")])
    builder = (x509.CertificateBuilder().subject_name(name).issuer_name(name)
               .public_key(key.public_key()).serial_number(x509.random_serial_number())
               .not_valid_before(now - timedelta(days=2))
               .not_valid_after(now + timedelta(days=-1 if expired else 1))
               .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
               .add_extension(x509.KeyUsage(digital_signature=signing, content_commitment=False,
                                           key_encipherment=recipient, data_encipherment=False,
                                           key_agreement=False, key_cert_sign=False, crl_sign=False,
                                           encipher_only=False, decipher_only=False), critical=True))
    if recipient:
        builder = (builder.add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.EMAIL_PROTECTION]),
                                         critical=False)
                   .add_extension(x509.SubjectAlternativeName([x509.RFC822Name(mailbox)]), critical=False))
    return builder.sign(key, hashes.SHA256())


class SmimeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.openssl = os.environ.get("OPENSSL_BIN") or shutil.which("openssl")
        if not cls.openssl:
            git_openssl = Path("C:/Program Files/Git/usr/bin/openssl.exe")
            cls.openssl = str(git_openssl) if git_openssl.is_file() else None
        if not cls.openssl:
            raise RuntimeError("OpenSSL is required; crypto verification must not be silently skipped")
        cls.signer = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        cls.receiver = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        cls.signer_cert = certificate(cls.signer)
        cls.recipient_cert = certificate(cls.receiver, recipient=True)

    def setUp(self):
        self.identity = {"test": True, "eldIdentifier": "ABC123", "eldRegistrationId": "AB12"}
        self.submission = {"test": True, "filename": "Drive8901091126-000000000",
                           "comment": "Offline synthetic crypto test",
                           "content": "ELD File Header Segment:\rFICTIONAL,123\r"}

    def message(self, **overrides):
        args = dict(submission=self.submission, identity=self.identity,
                    sender="test@example.com", signer_cert=self.signer_cert,
                    signer_key=self.signer, recipient_cert=self.recipient_cert)
        return build_test_email(**(args | overrides))

    def verify(self, raw, form="SMIME"):
        # -noverify disables chain trust for our disposable self-signed fixture only.
        # OpenSSL still verifies the cryptographic signature and message digest.
        return subprocess.run([self.openssl, "cms", "-verify", "-binary", "-inform", form,
                               "-noverify"], input=raw, capture_output=True, timeout=15, check=False)

    def test_signature_then_decryption_preserves_exact_attachment(self):
        raw = self.message()
        outer = BytesParser(policy=policy.SMTP).parsebytes(raw)
        self.assertEqual(outer["To"], RECIPIENT)
        self.assertEqual(outer["Subject"], "TEST: ELD records from AB12:ABC123")
        self.assertEqual(outer.get_content_type(), "application/pkcs7-mime")
        self.assertEqual(outer.get_param("smime-type"), "signed-data")
        self.assertNotIn(b"FICTIONAL", raw)
        result = self.verify(raw)
        self.assertEqual(result.returncode, 0, "Independent signature verification failed")
        encrypted = BytesParser(policy=policy.SMTP).parsebytes(result.stdout)
        self.assertEqual(encrypted.get_param("smime-type"), "enveloped-data")
        description = subprocess.run([self.openssl, "cms", "-cmsout", "-print", "-inform", "SMIME"],
                                     input=result.stdout, capture_output=True, timeout=15, check=True)
        self.assertIn(b"aes-256-cbc", description.stdout)
        clear = pkcs7.pkcs7_decrypt_smime(result.stdout, self.recipient_cert, self.receiver, [])
        inner = BytesParser(policy=policy.SMTP).parsebytes(clear)
        attachments = list(inner.iter_attachments())
        self.assertEqual(len(attachments), 1)
        self.assertEqual(attachments[0].get_filename(), self.submission["filename"])
        self.assertEqual(attachments[0].get_payload(decode=True), self.submission["content"].encode("ascii"))
        self.assertEqual(inner.get_body().get_content().strip(), self.submission["comment"])

    def test_tampered_signature_is_rejected(self):
        der = bytearray(BytesParser(policy=policy.SMTP).parsebytes(self.message()).get_payload(decode=True))
        der[-1] ^= 1
        self.assertNotEqual(self.verify(bytes(der), "DER").returncode, 0)

    def test_mail_newline_normalization_does_not_break_signature(self):
        raw = self.message()
        original = self.verify(raw)
        self.assertEqual(original.returncode, 0)
        normalized = self.verify(raw.replace(b"\r\n", b"\n"))
        self.assertEqual(normalized.returncode, 0)
        self.assertEqual(normalized.stdout, original.stdout)

    def recipient_zip(self, payload):
        archive = io.BytesIO()
        with zipfile.ZipFile(archive, "w") as output:
            output.writestr(RECIPIENT_MEMBER, payload)
        archive.seek(0)
        return archive

    def test_unreviewed_recipient_certificate_is_rejected(self):
        payload = self.recipient_cert.public_bytes(serialization.Encoding.DER)
        with self.assertRaisesRegex(ValueError, "differs from reviewed"):
            load_recipient_package(self.recipient_zip(payload))

    def test_pinned_recipient_is_loaded_and_expiry_still_checked(self):
        # Only this test substitutes the pin for its generated certificate.
        for cert, valid in [(self.recipient_cert, True),
                            (certificate(self.receiver, recipient=True, expired=True), False)]:
            with patch("lib.eld_smime.RECIPIENT_SHA256", cert.fingerprint(hashes.SHA256()).hex()):
                archive = self.recipient_zip(cert.public_bytes(serialization.Encoding.DER))
                if valid:
                    loaded = load_recipient_package(archive)
                    self.assertEqual(loaded.serial_number, cert.serial_number)
                else:
                    with self.assertRaisesRegex(ValueError, "not currently valid"):
                        load_recipient_package(archive)

    def test_oversized_recipient_package_member_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "Unexpected certificate size"):
            load_recipient_package(self.recipient_zip(b"x" * 64001))

    def test_other_key_cannot_decrypt(self):
        encrypted = self.verify(self.message()).stdout
        with self.assertRaises(ValueError):
            pkcs7.pkcs7_decrypt_smime(encrypted, self.signer_cert, self.signer, [])

    def test_production_or_implicit_mode_rejected(self):
        for flag in (False, None, "true", 1):
            with self.subTest(flag=flag), self.assertRaises(ValueError):
                self.message(submission=self.submission | {"test": flag})
            with self.subTest(identity=flag), self.assertRaises(ValueError):
                self.message(identity=self.identity | {"test": flag})

    def test_header_and_filename_injection_rejected(self):
        for sender in ("test@example.com\r\nBcc: bad@example.com", "A <test@example.com>", "a@b,c@d"):
            with self.subTest(sender=sender), self.assertRaises(ValueError):
                self.message(sender=sender)
        for field, value in (("filename", "../../secret"), ("comment", "bad\ncomment"),
                             ("content", "bad\r\n"), ("content", ""), ("content", "bad\x00\r")):
            with self.subTest(field=field), self.assertRaises(ValueError):
                self.message(submission=self.submission | {field: value})

    def test_bad_identity_and_key_mismatch_rejected(self):
        with self.assertRaises(ValueError):
            self.message(identity=self.identity | {"eldIdentifier": "abcdef"})
        with self.assertRaises(ValueError):
            self.message(signer_key=self.receiver)

    def test_expired_certificates_rejected(self):
        with self.assertRaises(ValueError):
            self.message(signer_cert=certificate(self.signer, expired=True))
        with self.assertRaises(ValueError):
            self.message(recipient_cert=certificate(self.receiver, recipient=True, expired=True))

    def test_certificate_mailbox_and_usage_rejected(self):
        with self.assertRaises(ValueError):
            self.message(recipient_cert=certificate(self.receiver, recipient=True, mailbox="wrong@example.com"))
        with self.assertRaises(ValueError):
            self.message(signer_cert=certificate(self.signer, signing=False))

    def test_expiry_boundary_rejected(self):
        with self.assertRaises(ValueError):
            validate_certificate(self.signer_cert, now=self.signer_cert.not_valid_after_utc)


if __name__ == "__main__":
    unittest.main()
