"""The crypto under the HARD gate proof, pinned to published vectors.

Two of these checks are the whole reason this is a test file and not a comment:
the FIPS-197 AES-128 vector and the RFC 4493 CMAC vectors. Everything else in
ntag.py is layering on top of those two, and a wrong layer is visible - it
rejects taps - while a wrong PRIMITIVE is not: a subtly broken AES would still
be self-consistent, so make_tap and verify would agree with each other all the
way to a gate that a stranger's tag could clear.

Run: python ntag_test.py
"""
import sys

import ntag

ok, bad = [], []
def check(label, cond, extra=''):
    (ok if cond else bad).append(('PASS' if cond else 'FAIL') + '  ' + label
                                 + (' - ' + str(extra) if extra else ''))


# ── AES-128, FIPS-197 appendix B/C.1 ──
KEY = bytes.fromhex('000102030405060708090a0b0c0d0e0f')
PT = bytes.fromhex('00112233445566778899aabbccddeeff')
CT = bytes.fromhex('69c4e0d86a7b0430d8cdb78070b4c55a')
check('AES-128 encrypt matches FIPS-197', ntag.encrypt_block(KEY, PT) == CT,
      ntag.encrypt_block(KEY, PT).hex())
check('AES-128 decrypt is its inverse', ntag.decrypt_block(KEY, CT) == PT,
      ntag.decrypt_block(KEY, CT).hex())

K2 = bytes.fromhex('2b7e151628aed2a6abf7158809cf4f3c')
check('...and the FIPS-197 appendix B key too',
      ntag.encrypt_block(K2, bytes.fromhex('3243f6a8885a308d313198a2e0370734'))
      == bytes.fromhex('3925841d02dc09fbdc118597196a0b32'))

# ── CMAC, RFC 4493 section 4 ──
M = bytes.fromhex('6bc1bee22e409f96e93d7e117393172a'
                  'ae2d8a571e03ac9c9eb76fac45af8e51'
                  '30c81c46a35ce411e5fbc1191a0a52ef'
                  'f69f2445df4f9b17ad2b417be66c3710')
check('CMAC of the empty message (RFC 4493 example 1)',
      ntag.cmac(K2) == bytes.fromhex('bb1d6929e95937287fa37d129b756746'),
      ntag.cmac(K2).hex())
check('CMAC of 16 bytes (example 2)',
      ntag.cmac(K2, M[:16]) == bytes.fromhex('070a16b46b4d4144f79bdd9dd04a287c'),
      ntag.cmac(K2, M[:16]).hex())
check('CMAC of 40 bytes — a partial final block (example 3)',
      ntag.cmac(K2, M[:40]) == bytes.fromhex('dfa66747de9ae63030ca32611497c827'),
      ntag.cmac(K2, M[:40]).hex())
check('CMAC of 64 bytes — a full final block (example 4)',
      ntag.cmac(K2, M) == bytes.fromhex('51f0bebf7e3b9d92fc49741779363cfe'),
      ntag.cmac(K2, M).hex())

# ── CBC ──
check('CBC round-trips two blocks with a zero IV',
      ntag.cbc_decrypt(KEY, ntag.cbc_encrypt(KEY, PT + PT)) == PT + PT)

# ── the SUN layer ──
META = bytes.fromhex('00000000000000000000000000000000')
MAC = bytes.fromhex('11111111111111111111111111111111')
UID = '04AABBCCDDEE80'

picc, mac = ntag.make_tap(META, MAC, UID, 7)
check('a tap is 32 + 16 hex chars, the two mirrors',
      len(picc) == 32 and len(mac) == 16, (picc, mac))
check('a genuine tap verifies, and says which tag and which read',
      ntag.verify(META, MAC, picc, mac) == (UID, 7), ntag.verify(META, MAC, picc, mac))
check('the read counter comes back exactly, not off by a byte order',
      ntag.verify(META, MAC, *ntag.make_tap(META, MAC, UID, 66051))[1] == 66051)

def refused(label, *args, **kw):
    try:
        ntag.verify(*args, **kw)
        check(label, False, 'it was ACCEPTED')
    except ntag.TapError as e:
        check(label, True)
        return str(e)

refused('a tap with a flipped cmac byte is refused', META, MAC, picc,
        ('0' if mac[0] != '0' else '1') + mac[1:])
refused('a tap with a flipped picc byte is refused', META, MAC,
        ('0' if picc[0] != '0' else '1') + picc[1:], mac)
refused('the wrong META key is refused', bytes(16), MAC,
        ntag.make_tap(bytes.fromhex('22' * 16), MAC, UID, 7)[0], mac)
refused('the wrong FILE key is refused — and named apart from the meta key',
        META, bytes.fromhex('33' * 16), picc, mac)
refused('a short cmac is refused', META, MAC, picc, 'aabb')
refused('a non-hex cmac is refused', META, MAC, picc, 'zzzz' * 4)
refused('a truncated picc_data is refused', META, MAC, picc[:30], mac)

# The MAC covers the counter, so another tag's MAC cannot be pasted onto this
# tag's picc_data - the two mirrors are not independent secrets.
other_picc, other_mac = ntag.make_tap(META, MAC, UID, 8)
refused('one tap\'s cmac on another tap\'s picc_data is refused',
        META, MAC, picc, other_mac)
check('...while each tap verifies as itself',
      ntag.verify(META, MAC, other_picc, other_mac) == (UID, 8))

# A second tag, same keys (which is how a gate with two doors is set up): the
# UID that comes back is what tells them apart.
p2, m2 = ntag.make_tap(META, MAC, '04998877665544', 3)
check('a second tag with the same keys is identified by its UID',
      ntag.verify(META, MAC, p2, m2)[0] == '04998877665544',
      ntag.verify(META, MAC, p2, m2))

check('the truncation is the ODD bytes, not the first eight',
      ntag._mact(bytes(range(16))) == bytes((1, 3, 5, 7, 9, 11, 13, 15)),
      ntag._mact(bytes(range(16))).hex())

print('\n'.join(ok + bad))
print('\n%d passed, %d failed' % (len(ok), len(bad)))
sys.exit(1 if bad else 0)
