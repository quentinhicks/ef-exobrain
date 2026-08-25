"""NTAG 424 DNA SUN verification: the HARD proof a gate can demand.

WHAT THIS IS FOR. A gate's soft proof is a link plus a geofence: the phone says
where it was, and the browser is trusted to be honest about it. Neither half
proves you were AT the thing - a link can be opened anywhere and a geofence is
a claim made by software you control. An NTAG 424 DNA tap is different: the tag
holds AES keys that never leave it, and every tap serves a URL the tag itself
authenticated - a message this file can verify and nothing else can forge.

HOW A TAP PROVES ITSELF (NXP's SUN / Secure Dynamic Messaging):
  * The tag mirrors two values into its NDEF URL, fresh on every tap:
      picc_data - 16 bytes, AES-CBC encrypted under the META key, holding a
                  tag byte, the 7-byte UID and a 3-byte READ COUNTER
      cmac      - 8 bytes, a CMAC under a session key derived from the FILE
                  READ key and that same UID + counter
  * So verification is: decrypt, derive, re-MAC, compare - and then check the
    counter has never been seen before. The counter is what makes a captured
    URL worthless: it only ever goes up, inside the tag.

WHY THE CRYPTO IS WRITTEN OUT HERE. The project takes no new dependencies and
Python ships no AES, so AES-128 (encrypt for CMAC, decrypt for the CBC half)
and CMAC (RFC 4493) are implemented below. That is a deliberate trade: ~150
lines of primitive, pinned by known-answer tests in ntag_test.py (FIPS-197 for
AES, RFC 4493 for CMAC) rather than a library. The KATs are not decoration -
they are the only thing standing between a typo and a gate that either cannot
be cleared or can be cleared by anyone.

WHAT IT DELIBERATELY DOES NOT DO. It does not talk to a tag, program one, or
hold a key: keys live in config.json (never the db, which is backed up) and are
passed in. It answers one question - is this tap real, and which tag and read
counter is it - and leaves who-may-clear-what to qr_judge.

Run `python ntag.py <picc_hex> <cmac_hex> <meta_key_hex> <mac_key_hex>` to check
a real tap by hand: it prints each stage, so a first tap that fails says WHICH
half is wrong (usually a key pasted into the wrong field) instead of just no.
"""

SBOX = bytes.fromhex(
    '637c777bf26b6fc53001672bfed7ab76'
    'ca82c97dfa5947f0add4a2af9ca472c0'
    'b7fd9326363ff7cc34a5e5f171d83115'
    '04c723c31896059a071280e2eb27b275'
    '09832c1a1b6e5aa0523bd6b329e32f84'
    '53d100ed20fcb15b6acbbe394a4c58cf'
    'd0efaafb434d338545f9027f503c9fa8'
    '51a3408f929d38f5bcb6da2110fff3d2'
    'cd0c13ec5f974417c4a77e3d645d1973'
    '60814fdc222a908846eeb814de5e0bdb'
    'e0323a0a4906245cc2d3ac629195e479'
    'e7c8376d8dd54ea96c56f4ea657aae08'
    'ba78252e1ca6b4c6e8dd741f4bbd8b8a'
    '703eb5664803f60e613557b986c11d9e'
    'e1f8981169d98e949b1e87e9ce5528df'
    '8ca1890dbfe6426841992d0fb054bb16')
INV_SBOX = bytearray(256)
for _i, _v in enumerate(SBOX):
    INV_SBOX[_v] = _i
RCON = (0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1B, 0x36)


def _xtime(a):
    a <<= 1
    return (a ^ 0x1B) & 0xFF if a & 0x100 else a


def _mul(a, b):
    out = 0
    while b:
        if b & 1:
            out ^= a
        a = _xtime(a)
        b >>= 1
    return out


def _expand(key):
    assert len(key) == 16, 'AES-128 only — a 424 DNA SDM key is 16 bytes'
    w = [list(key[i:i + 4]) for i in range(0, 16, 4)]
    for i in range(4, 44):
        t = list(w[i - 1])
        if i % 4 == 0:
            t = t[1:] + t[:1]
            t = [SBOX[b] for b in t]
            t[0] ^= RCON[i // 4 - 1]
        w.append([w[i - 4][j] ^ t[j] for j in range(4)])
    return [sum(w[r * 4:r * 4 + 4], []) for r in range(11)]


def _add_key(s, k):
    return [s[i] ^ k[i] for i in range(16)]


def _mix(s, inv=False):
    m = ((14, 11, 13, 9), (9, 14, 11, 13), (13, 9, 14, 11), (11, 13, 9, 14)) if inv else \
        ((2, 3, 1, 1), (1, 2, 3, 1), (1, 1, 2, 3), (3, 1, 1, 2))
    out = [0] * 16
    for c in range(4):
        col = s[c * 4:c * 4 + 4]
        for r in range(4):
            out[c * 4 + r] = (_mul(col[0], m[r][0]) ^ _mul(col[1], m[r][1])
                              ^ _mul(col[2], m[r][2]) ^ _mul(col[3], m[r][3]))
    return out


# State is column-major, as in FIPS-197: byte i sits at row i%4, column i//4.
_SHIFT = [(c * 4 + r, ((c + r) % 4) * 4 + r) for c in range(4) for r in range(4)]


def _shift_rows(s, inv=False):
    out = [0] * 16
    for dst, src in _SHIFT:
        if inv:
            out[src] = s[dst]
        else:
            out[dst] = s[src]
    return out


def encrypt_block(key, block):
    rk = _expand(key)
    s = _add_key(list(block), rk[0])
    for r in range(1, 10):
        s = [SBOX[b] for b in s]
        s = _shift_rows(s)
        s = _mix(s)
        s = _add_key(s, rk[r])
    s = [SBOX[b] for b in s]
    s = _shift_rows(s)
    return bytes(_add_key(s, rk[10]))


def decrypt_block(key, block):
    rk = _expand(key)
    s = _add_key(list(block), rk[10])
    for r in range(9, 0, -1):
        s = _shift_rows(s, inv=True)
        s = [INV_SBOX[b] for b in s]
        s = _add_key(s, rk[r])
        s = _mix(s, inv=True)
    s = _shift_rows(s, inv=True)
    s = [INV_SBOX[b] for b in s]
    return bytes(_add_key(s, rk[0]))


def cbc_decrypt(key, data, iv=b'\x00' * 16):
    assert len(data) % 16 == 0, 'CBC works in whole blocks'
    out, prev = bytearray(), iv
    for i in range(0, len(data), 16):
        blk = data[i:i + 16]
        out += bytes(a ^ b for a, b in zip(decrypt_block(key, blk), prev))
        prev = blk
    return bytes(out)


def cbc_encrypt(key, data, iv=b'\x00' * 16):
    assert len(data) % 16 == 0, 'CBC works in whole blocks'
    out, prev = bytearray(), iv
    for i in range(0, len(data), 16):
        blk = bytes(a ^ b for a, b in zip(data[i:i + 16], prev))
        prev = encrypt_block(key, blk)
        out += prev
    return bytes(out)


def _dbl(b):
    # Left shift by one in GF(2^128), the CMAC subkey step.
    n = int.from_bytes(b, 'big') << 1
    if b[0] & 0x80:
        n ^= 0x87
    return (n & ((1 << 128) - 1)).to_bytes(16, 'big')


def cmac(key, msg=b''):
    """AES-CMAC (RFC 4493). Pinned by that RFC's four test vectors."""
    k1 = _dbl(encrypt_block(key, b'\x00' * 16))
    k2 = _dbl(k1)
    blocks = [msg[i:i + 16] for i in range(0, len(msg), 16)] or [b'']
    last = blocks[-1]
    if len(last) == 16:
        last = bytes(a ^ b for a, b in zip(last, k1))
    else:
        last = last + b'\x80' + b'\x00' * (15 - len(last))
        last = bytes(a ^ b for a, b in zip(last, k2))
    x = b'\x00' * 16
    for blk in blocks[:-1]:
        x = encrypt_block(key, bytes(a ^ b for a, b in zip(x, blk)))
    return encrypt_block(key, bytes(a ^ b for a, b in zip(x, last)))


def _mact(full):
    # NXP truncates a CMAC to its ODD-indexed bytes. 8 bytes, not the first 8 -
    # getting this wrong rejects every genuine tap, which is why it is named.
    return bytes(full[i] for i in range(1, 16, 2))


def session_mac_key(key_file, uid, counter):
    """K_SesSDMFileReadMAC, per AN12196: a CMAC over SV2 with the file key.

    SV2 pins the session key to this tag AND this read counter, which is what
    makes a captured cmac useless on the next tap.
    """
    sv2 = (bytes((0x3C, 0xC3, 0x00, 0x01, 0x00, 0x80)) + uid
           + counter.to_bytes(3, 'little'))
    sv2 += b'\x00' * (16 - len(sv2))
    return cmac(key_file, sv2)


def _eq(a, b):
    # Constant time-ish: no early exit on the first differing byte. This is a
    # MAC comparison on a money path, so it does not get to be a ==.
    if len(a) != len(b):
        return False
    diff = 0
    for x, y in zip(a, b):
        diff |= x ^ y
    return diff == 0


class TapError(Exception):
    """Why a tap was not accepted - safe to log, never shown to a scanner."""


def decode_picc(key_meta, picc_hex):
    """Decrypt the mirrored PICCData: which tag, and its read counter.

    Returns (uid_hex_upper, counter). Raises TapError on anything malformed -
    including the wrong meta key, which shows up as a PICCDataTag that is not
    a UID+counter mirror rather than as a decryption failure (there is no
    padding to check, so the tag byte IS the check).
    """
    try:
        blob = bytes.fromhex((picc_hex or '').strip())
    except ValueError:
        raise TapError('picc_data is not hex')
    if len(blob) != 16:
        raise TapError('picc_data must be 16 bytes (32 hex chars), got %d' % len(blob))
    plain = cbc_decrypt(key_meta, blob)
    tag_byte = plain[0]
    # The tag byte says what the tag mirrored: bit 7 UID, bit 6 the read
    # counter, low nibble the UID length. All three are checked because all
    # three are load-bearing — a tag configured WITHOUT counter mirroring would
    # otherwise have its padding read as a counter, and the replay guard is the
    # counter. It doubles as the key check: there is no padding to verify, so a
    # wrong meta key shows up as a tag byte that means nothing.
    if not tag_byte & 0x80 or (tag_byte & 0x0F) != 7:
        raise TapError('picc_data did not decrypt to a 7-byte UID mirror — wrong meta key?')
    if not tag_byte & 0x40:
        raise TapError('this tag does not mirror its read counter — turn SDMReadCtr on, '
                       'or a captured URL could be replayed forever')
    uid = plain[1:8]
    counter = int.from_bytes(plain[8:11], 'little')
    return uid.hex().upper(), counter


def verify(key_meta, key_mac, picc_hex, cmac_hex, message=b''):
    """The whole check. Returns (uid_hex, counter) or raises TapError.

    `message` is the SDM message the MAC covers - empty for the plain
    UID+counter mirror this app configures. It is a parameter rather than a
    constant so a tag that also mirrors encrypted file data can be verified
    without a second implementation of any of this.
    """
    uid_hex, counter = decode_picc(key_meta, picc_hex)
    try:
        got = bytes.fromhex((cmac_hex or '').strip())
    except ValueError:
        raise TapError('cmac is not hex')
    if len(got) != 8:
        raise TapError('cmac must be 8 bytes (16 hex chars), got %d' % len(got))
    ses = session_mac_key(key_mac, bytes.fromhex(uid_hex), counter)
    if not _eq(_mact(cmac(ses, message)), got):
        raise TapError('cmac does not match — wrong file-read key, or not a real tap')
    return uid_hex, counter


def make_tap(key_meta, key_mac, uid_hex, counter, message=b''):
    """The tag's side of the same arithmetic, for tests and for a dry run.

    This is what a genuine tap looks like, which makes it the only honest way
    to test the verifier without a tag in hand. It is NOT a way to clear a
    gate: nothing calls it outside tests, and it needs the keys, which is the
    same thing as having the tag.
    """
    uid = bytes.fromhex(uid_hex)
    picc = bytes((0xC7,)) + uid + counter.to_bytes(3, 'little') + b'\x00' * 5
    ses = session_mac_key(key_mac, uid, counter)
    return (cbc_encrypt(key_meta, picc).hex().upper(),
            _mact(cmac(ses, message)).hex().upper())


def load_keys(path='config.json'):
    """The tag keys, read fresh from config.json every time.

    THEY ARE NOT IN THE DATABASE, deliberately: the db is dumped into
    backups/tracker.sql and pushed, so a key in it would be a key in git. This
    is the same reason the Beeminder token lives in config.json — and it is
    read on every call rather than into a module global, because a key pasted
    in Settings must be in force without a restart.

    Shape:  "ntag_keys": {"04AABBCCDDEE80": {"meta": "<32 hex>", "mac": "<32 hex>"}}
    Anything malformed is skipped rather than raised: a half-typed key must not
    take the scan endpoint down, it must make ONE tag fail to verify.
    """
    import json
    try:
        with open(path) as f:
            raw = (json.load(f) or {}).get('ntag_keys') or {}
    except Exception:
        return {}
    out = {}
    for uid, pair in raw.items():
        try:
            meta = bytes.fromhex((pair.get('meta') or '').strip())
            mac = bytes.fromhex((pair.get('mac') or '').strip())
        except (AttributeError, ValueError):
            continue
        if len(meta) == 16 and len(mac) == 16:
            out[str(uid).upper()] = (meta, mac)
    return out


def identify(picc_hex, cmac_hex, keys):
    """Which of the configured tags tapped, if any.

    A tap says nothing in the clear — the UID is inside the encrypted half — so
    the only way to know whose tag it is, is to try the configured meta keys
    until one decrypts to a UID we know. Then the MAC is checked with THAT
    tag's file key, so a tag cannot borrow another's authority.
    """
    # WHY each key was ruled out, kept rather than dropped. The refusal is the
    # only thing a misprogrammed tag ever produces, and "no configured tag
    # matches this tap" cannot tell a wrong meta key from a counter mirror that
    # was never turned on — which is the whole question during setup. The
    # per-key reason is the answer, so it travels with the exception instead of
    # being thrown away here and hunted for at a terminal afterwards.
    reasons = []
    for uid, (meta, mac) in keys.items():
        try:
            got_uid, counter = decode_picc(meta, picc_hex)
        except TapError as e:
            if str(e) not in reasons:
                reasons.append(str(e))
            continue
        if got_uid != uid:
            # Decrypted, but not to this tag: keep looking. Another key may own
            # it, and only if none does is this worth reporting.
            reasons.append('decrypted to %s, which is not a configured tag' % got_uid)
            continue
        verify(meta, mac, picc_hex, cmac_hex)   # raises TapError on a bad MAC
        return uid, counter
    raise TapError('no configured tag matches this tap'
                   + (' — ' + '; '.join(reasons) if reasons else ''))


if __name__ == '__main__':
    import sys
    if len(sys.argv) != 5:
        print(__doc__.strip().splitlines()[-3])
        print('usage: python ntag.py <picc_hex> <cmac_hex> <meta_key_hex> <mac_key_hex>')
        sys.exit(2)
    picc_hex, cmac_hex, meta_hex, mac_hex = sys.argv[1:5]
    try:
        meta, mac = bytes.fromhex(meta_hex), bytes.fromhex(mac_hex)
    except ValueError:
        print('the keys must be 32 hex characters each')
        sys.exit(1)
    try:
        uid, ctr = decode_picc(meta, picc_hex)
        print('picc_data decrypts   OK   uid=%s read counter=%d' % (uid, ctr))
    except TapError as e:
        print('picc_data            FAIL %s' % e)
        sys.exit(1)
    try:
        verify(meta, mac, picc_hex, cmac_hex)
        print('cmac                 OK   this is a genuine tap of %s' % uid)
    except TapError as e:
        print('cmac                 FAIL %s' % e)
        sys.exit(1)
